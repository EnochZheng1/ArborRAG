import fs from "fs";
import { ingestLogger as logger } from "../utils/logger.js";
import { processDocument } from "./index.js";
import { getAllConnections } from "../db/datasetManager.js";
import { runWithDb } from "../db/activeDb.js";
import { RateLimitError } from "../utils/rateLimitError.js";
import { JobRepo } from "../db/repositories/JobRepo.js";
import { emitQueueUpdate, emitJobProgress } from "../utils/progressEmitter.js";

// Job queue concurrency: default 1 (sequential) to respect low OpenAI rate limits.
// Set env INGEST_QUEUE_CONCURRENCY=2 to process multiple jobs in parallel.
const DEFAULT_CONCURRENCY = Math.max(1, Number.parseInt(process.env.INGEST_QUEUE_CONCURRENCY || "1", 10) || 1);
const DEFAULT_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.INGEST_QUEUE_MAX_ATTEMPTS || "3", 10) || 3);
const DEFAULT_RETRY_DELAY_MS = Math.max(0, Number.parseInt(process.env.INGEST_QUEUE_RETRY_DELAY_MS || "5000", 10) || 5000);
const CLEANUP_ON_SUCCESS = process.env.INGEST_CLEANUP_ON_SUCCESS !== "false";
// Stuck-job timeout: default 30 minutes. Set INGEST_STUCK_TIMEOUT_MINUTES=0 to
// disable explicitly (e.g. for very large PDFs that take hours). Server-restart
// recovery (requeueRecoverable) handles the crash/reboot case independently.
const STUCK_JOB_TIMEOUT_MINUTES = Math.max(0, Number.parseInt(process.env.INGEST_STUCK_TIMEOUT_MINUTES ?? "30", 10) || 0);
// How often to run the stuck-job sweep (ms).
const STUCK_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// How often to emit a heartbeat from a running job (ms) — used for diagnostics.
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;  // 2 minutes

const JOB_STATUS = {
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  RATE_LIMITED: "rate_limited"  // paused due to API 429; resume manually
};

let queueStarted = false;
let runningWorkers = 0;
let pumpScheduled = false;
let configuredConcurrency = DEFAULT_CONCURRENCY;

function schedulePump(delayMs = 0) {
  if (!queueStarted || pumpScheduled) return;
  pumpScheduled = true;

  setTimeout(() => {
    pumpScheduled = false;
    runPump().catch(err => {
      logger.error(`Ingestion queue pump failed: ${err.message}`);
    });
  }, Math.max(0, delayMs));
}

// Internal pump functions use `conn` directly instead of the db Proxy,
// because the job pump runs outside HTTP request context and the long
// await inside processDocument can cause AsyncLocalStorage context loss.

function claimNextQueuedJob(conn) {
  return JobRepo.claimNext(conn);
}

function completeJob(conn, jobId, result, documentId = null) {
  _transientCounts.delete(jobId);
  JobRepo.complete(conn, jobId, result, documentId);
}

function failJob(conn, job, errorMessage, result = null) {
  const retrySeconds = Math.max(1, Math.ceil(DEFAULT_RETRY_DELAY_MS / 1000));
  const retried = JobRepo.fail(conn, job, errorMessage, result, retrySeconds);
  if (retried) {
    logger.warn(`[ingest-job:${job.id}] failed attempt ${job.attempt_count}/${job.max_attempts}; queued for retry: ${errorMessage}`);
    schedulePump(DEFAULT_RETRY_DELAY_MS);
  } else {
    logger.error(`[ingest-job:${job.id}] exhausted retries: ${errorMessage}`);
  }
  return retried;
}

function pauseRateLimitedJob(conn, job, errorMessage) {
  JobRepo.pauseRateLimited(conn, job.id, errorMessage);
  logger.warn(`[ingest-job:${job.id}] paused (rate limited). Resume when quota resets: ${errorMessage}`);
}

// Transient errors: network failures, timeouts, temporary 5xx — should NOT
// burn the retry budget. We requeue with decremented attempt_count.
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED', 'EPIPE', 'ERR_CANCELED']);
function isTransientError(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  // AbortSignal.timeout() throws DOMException with name "TimeoutError"
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up') ||
      msg.includes('timed out after') || msg.includes('aborted')) return true;
  // 5xx server errors (but not 429 — that's rate limiting — and not 529 Anthropic overload)
  const status = err.status ?? err.statusCode;
  if (Number.isFinite(status) && status >= 500 && status !== 529) return true;
  return false;
}

// Track transient retry counts in-memory so persistent failures eventually exhaust.
// Cleared when a job finally succeeds or permanently fails.
const _transientCounts = new Map();
const MAX_TRANSIENT_RETRIES = 10;

function failTransientJob(conn, job, errorMessage) {
  const count = (_transientCounts.get(job.id) || 0) + 1;

  if (count > MAX_TRANSIENT_RETRIES) {
    // Persistent transient failure — fall through to real failure path
    _transientCounts.delete(job.id);
    logger.error(`[ingest-job:${job.id}] exceeded ${MAX_TRANSIENT_RETRIES} transient retries; treating as real failure: ${errorMessage}`);
    const willRetry = failJob(conn, job, `[transient exhausted] ${errorMessage}`, null);
    if (!willRetry) maybeCleanupUploadedFile(job.file_path, "failed");
    return;
  }

  _transientCounts.set(job.id, count);
  // Exponential backoff: 30s, 60s, 120s, 240s … capped at 5 minutes
  const delayMs = Math.min(30_000 * Math.pow(2, count - 1), 300_000);
  const retrySeconds = Math.ceil(delayMs / 1000);
  JobRepo.failTransient(conn, job, `[transient:${count}/${MAX_TRANSIENT_RETRIES}] ${errorMessage}`, retrySeconds);
  logger.warn(`[ingest-job:${job.id}] transient error (${count}/${MAX_TRANSIENT_RETRIES}); retry in ${retrySeconds}s: ${errorMessage}`);
  schedulePump(delayMs);
}

function isDuplicateResult(result) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  return errors.some(msg => String(msg).toLowerCase().includes("duplicate hash"));
}

function maybeCleanupUploadedFile(filePath, reason = "completed") {
  if (!CLEANUP_ON_SUCCESS || !filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.debug(`Cleaned up upload file (${reason}): ${filePath}`);
    }
  } catch (err) {
    logger.warn(`Failed to clean up upload file ${filePath}: ${err.message}`);
  }
}

async function processClaimedJob(job, conn, datasetId) {
  logger.info(`[ingest-job:${job.id}] start processing file: ${job.original_name || job.file_path}`);

  // Emit a heartbeat every HEARTBEAT_INTERVAL_MS so the stuck-job detector
  // knows this job is still alive even during long LLM calls.
  const heartbeatTimer = setInterval(() => {
    try { JobRepo.heartbeat(conn, job.id); } catch (_) {}
  }, HEARTBEAT_INTERVAL_MS);

  let result = null;
  try {
    // runWithDb ensures all db calls inside processDocument route to this dataset.
    // Pass original_name so the document record shows the human-readable filename.
    result = await runWithDb(conn, () => processDocument(job.file_path, {
      ...job.options,
      originalName: job.original_name || null,
      jobId: job.id,
      datasetId
    }));
    const duplicate = isDuplicateResult(result);

    if (!result?.success && !duplicate) {
      const reason = Array.isArray(result?.errors) && result.errors.length > 0
        ? result.errors.join("; ")
        : "Document processing failed";
      // If the pipeline created a document before failing, link it to the job
      // so the unified Documents view can associate them without duplicating.
      if (result?.documentId) JobRepo.setDocumentId(conn, job.id, result.documentId);
      emitJobProgress(job.id, 'error', 0, reason, 'failed', datasetId);
      const willRetry = failJob(conn, job, reason, result);
      if (!willRetry) maybeCleanupUploadedFile(job.file_path, "failed");
      return;
    }

    completeJob(conn, job.id, result, result?.documentId || null);
    maybeCleanupUploadedFile(job.file_path, duplicate ? "duplicate" : "completed");
    logger.info(`[ingest-job:${job.id}] completed`);
  } catch (err) {
    if (err instanceof RateLimitError) {
      // processDocument already rolled back the partial document state.
      // Pause the job so the user can resume it after their quota resets.
      if (result?.documentId) JobRepo.setDocumentId(conn, job.id, result.documentId);
      emitJobProgress(job.id, 'rate_limited', 0, err.message, 'rate_limited', datasetId);
      pauseRateLimitedJob(conn, job, `Rate limit hit (429) — resume when quota resets: ${err.message}`);
      // Keep file on disk — job may be retried when quota resets.
    } else if (isTransientError(err)) {
      // Network/timeout failures: requeue without burning the retry budget.
      if (result?.documentId) JobRepo.setDocumentId(conn, job.id, result.documentId);
      emitJobProgress(job.id, 'error', 0, err.message, 'failed', datasetId);
      failTransientJob(conn, job, err.message);
      // Keep file on disk for retry.
    } else {
      if (result?.documentId) JobRepo.setDocumentId(conn, job.id, result.documentId);
      emitJobProgress(job.id, 'error', 0, err.message, 'failed', datasetId);
      const willRetry = failJob(conn, job, err.message, result);
      if (!willRetry) maybeCleanupUploadedFile(job.file_path, "failed");
    }
  } finally {
    clearInterval(heartbeatTimer);
    // Notify all connected clients that queue state changed (job finished/failed/paused).
    // This lets the frontend refresh the Documents view immediately instead of polling.
    emitQueueUpdate();
  }
}

async function runPump() {
  if (!queueStarted) return;

  // Optional stuck-job sweep (only runs when INGEST_STUCK_TIMEOUT_MINUTES > 0).
  if (STUCK_JOB_TIMEOUT_MINUTES > 0) {
    for (const { connection } of getAllConnections()) {
      const stuck = JobRepo.requeueStuck(connection, STUCK_JOB_TIMEOUT_MINUTES);
      if (stuck > 0) {
        logger.warn(`Requeued ${stuck} stuck processing job(s) (no heartbeat for >${STUCK_JOB_TIMEOUT_MINUTES}min)`);
      }
    }
  }

  // Process jobs from all dataset connections
  for (const { datasetId, connection } of getAllConnections()) {
    while (runningWorkers < configuredConcurrency) {
      const job = claimNextQueuedJob(connection);
      if (!job) break;

      runningWorkers += 1;
      processClaimedJob(job, connection, datasetId)
        .catch(err => {
          logger.error(`[ingest-job:${job.id}] unexpected worker error: ${err.message}`);
        })
        .finally(() => {
          runningWorkers = Math.max(0, runningWorkers - 1);
          schedulePump();
        });
    }
  }
}

function requeueRecoverableJobsForConn(conn) {
  const recovered = JobRepo.requeueRecoverable(conn);
  if (recovered > 0) {
    logger.warn(`Recovered ${recovered} in-flight ingestion jobs after restart`);
  }
}

export function startIngestionQueue(options = {}) {
  if (queueStarted) return;
  configuredConcurrency = Math.max(1, Number.parseInt(options.concurrency, 10) || DEFAULT_CONCURRENCY);
  queueStarted = true;

  for (const { connection } of getAllConnections()) {
    requeueRecoverableJobsForConn(connection);
  }
  logger.info(`Ingestion queue started (concurrency=${configuredConcurrency}, retries=${DEFAULT_MAX_ATTEMPTS}, stuck_timeout=${STUCK_JOB_TIMEOUT_MINUTES}min)`);

  // Periodic stuck-job sweep: catches jobs that hang without throwing an error.
  setInterval(() => schedulePump(), STUCK_CHECK_INTERVAL_MS);

  schedulePump();
}

export function enqueueIngestionJob(filePath, options = {}) {
  const maxAttempts = Number.isFinite(options.maxAttempts) && options.maxAttempts > 0
    ? Math.floor(options.maxAttempts)
    : DEFAULT_MAX_ATTEMPTS;

  const jobId = JobRepo.insert({
    filePath,
    originalName: options.originalName || null,
    fileSize: Number.isFinite(options.fileSize) ? options.fileSize : null,
    optionsJson: JSON.stringify(options.processOptions || {}),
    maxAttempts
  });

  const job = JobRepo.findById(jobId);
  emitQueueUpdate(); // notify clients a new job entered the queue
  schedulePump();
  return job;
}

export function enqueueIngestionJobs(files = [], options = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const jobs = [];
  for (const file of files) {
    jobs.push(enqueueIngestionJob(file.path || file.filePath, {
      originalName: file.originalname || file.originalName,
      fileSize: file.size || file.fileSize,
      processOptions: options.processOptions || {},
      maxAttempts: options.maxAttempts
    }));
  }
  return jobs;
}

export function getIngestionJob(jobId) {
  return JobRepo.findById(jobId);
}

export function listIngestionJobs(filters = {}) {
  const { status = null, limit = 50, offset = 0 } = filters;
  return JobRepo.list({ status, limit, offset });
}

export function retryIngestionJob(jobId) {
  const job = JobRepo.findById(jobId);
  if (!job) {
    throw new Error("Ingestion job not found");
  }
  if (![JOB_STATUS.FAILED, JOB_STATUS.CANCELLED, JOB_STATUS.RATE_LIMITED].includes(job.status)) {
    throw new Error(`Cannot retry job in status: ${job.status}`);
  }
  if (!fs.existsSync(job.file_path)) {
    throw new Error("Original upload file no longer exists; re-upload the file");
  }

  JobRepo.setQueued(jobId);
  schedulePump();
  return JobRepo.findById(jobId);
}

export function cancelIngestionJob(jobId) {
  const job = JobRepo.findById(jobId);
  if (!job) {
    throw new Error("Ingestion job not found");
  }
  const cancellable = [JOB_STATUS.QUEUED, JOB_STATUS.PROCESSING, JOB_STATUS.RATE_LIMITED];
  if (!cancellable.includes(job.status)) {
    throw new Error(`Cannot cancel job in status: ${job.status}`);
  }

  JobRepo.setCancelled(jobId);
  return JobRepo.findById(jobId);
}

export function listActiveIngestionJobs() {
  return JobRepo.listActive();
}

export function cancelAllIngestionJobs() {
  return JobRepo.cancelAllActive();
}

export function retryAllIngestionJobs() {
  const count = JobRepo.retryAllPaused();
  if (count > 0) schedulePump();
  return count;
}

export function getIngestionQueueStats() {
  const counts = JobRepo.getStatusCounts();

  const byStatus = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    rate_limited: 0
  };
  for (const row of counts) {
    byStatus[row.status] = row.count;
  }

  return {
    concurrency: configuredConcurrency,
    running_workers: runningWorkers,
    started: queueStarted,
    ...byStatus
  };
}

export { JOB_STATUS };
