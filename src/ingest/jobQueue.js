import fs from "fs";
import { ingestLogger as logger } from "../utils/logger.js";
import { processDocument } from "./index.js";
import { getAllConnections } from "../db/datasetManager.js";
import { runWithDb } from "../db/activeDb.js";
import { RateLimitError } from "../utils/rateLimitError.js";
import { JobRepo } from "../db/repositories/JobRepo.js";

const DEFAULT_CONCURRENCY = Math.max(1, Number.parseInt(process.env.INGEST_QUEUE_CONCURRENCY || "2", 10) || 2);
const DEFAULT_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.INGEST_QUEUE_MAX_ATTEMPTS || "3", 10) || 3);
const DEFAULT_RETRY_DELAY_MS = Math.max(0, Number.parseInt(process.env.INGEST_QUEUE_RETRY_DELAY_MS || "5000", 10) || 5000);
const CLEANUP_ON_SUCCESS = process.env.INGEST_CLEANUP_ON_SUCCESS !== "false";

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
      pauseRateLimitedJob(conn, job, `Rate limit hit (429) — resume when quota resets: ${err.message}`);
      // Keep file on disk — job may be retried when quota resets.
    } else {
      const willRetry = failJob(conn, job, err.message, result);
      if (!willRetry) maybeCleanupUploadedFile(job.file_path, "failed");
    }
  }
}

async function runPump() {
  if (!queueStarted) return;

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
  logger.info(`Ingestion queue started (concurrency=${configuredConcurrency}, retries=${DEFAULT_MAX_ATTEMPTS})`);
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
  if (job.status !== JOB_STATUS.QUEUED) {
    throw new Error(`Only queued jobs can be cancelled (current: ${job.status})`);
  }

  JobRepo.setCancelled(jobId);
  return JobRepo.findById(jobId);
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
