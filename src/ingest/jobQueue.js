import fs from "fs";
import { db, safeJson } from "../db/db.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { processDocument } from "./index.js";
import { getAllConnections } from "../db/datasetManager.js";
import { runWithDb } from "../db/activeDb.js";

const DEFAULT_CONCURRENCY = Math.max(1, Number.parseInt(process.env.INGEST_QUEUE_CONCURRENCY || "2", 10) || 2);
const DEFAULT_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.INGEST_QUEUE_MAX_ATTEMPTS || "3", 10) || 3);
const DEFAULT_RETRY_DELAY_MS = Math.max(0, Number.parseInt(process.env.INGEST_QUEUE_RETRY_DELAY_MS || "5000", 10) || 5000);
const CLEANUP_ON_SUCCESS = process.env.INGEST_CLEANUP_ON_SUCCESS !== "false";

const JOB_STATUS = {
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
};

let queueStarted = false;
let runningWorkers = 0;
let pumpScheduled = false;
let configuredConcurrency = DEFAULT_CONCURRENCY;

function normalizeJobRow(row) {
  if (!row) return null;
  return {
    ...row,
    options: safeJson(row.options_json, {}),
    result: safeJson(row.result_json, null)
  };
}

function toDbJobPayload(job) {
  return {
    file_path: job.filePath,
    original_name: job.originalName || null,
    file_size: Number.isFinite(job.fileSize) ? job.fileSize : null,
    options_json: JSON.stringify(job.options || {}),
    max_attempts: Number.isFinite(job.maxAttempts) && job.maxAttempts > 0
      ? Math.floor(job.maxAttempts)
      : DEFAULT_MAX_ATTEMPTS
  };
}

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
  conn.exec("BEGIN IMMEDIATE");
  try {
    const row = conn.prepare(`
      SELECT *
      FROM ingestion_jobs
      WHERE status = ?
        AND datetime(available_at) <= datetime('now')
      ORDER BY queued_at ASC, id ASC
      LIMIT 1
    `).get(JOB_STATUS.QUEUED);

    if (!row) {
      conn.exec("COMMIT");
      return null;
    }

    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = ?,
          started_at = datetime('now'),
          updated_at = datetime('now'),
          attempt_count = attempt_count + 1,
          error_message = NULL
      WHERE id = ?
    `).run(JOB_STATUS.PROCESSING, row.id);

    const claimed = conn.prepare(`
      SELECT *
      FROM ingestion_jobs
      WHERE id = ?
    `).get(row.id);

    conn.exec("COMMIT");
    return normalizeJobRow(claimed);
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

function completeJob(conn, jobId, result, documentId = null) {
  conn.prepare(`
    UPDATE ingestion_jobs
    SET status = ?,
        document_id = ?,
        result_json = ?,
        finished_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(JOB_STATUS.COMPLETED, documentId, JSON.stringify(result || null), jobId);
}

function failJob(conn, job, errorMessage, result = null) {
  const retryable = job.attempt_count < job.max_attempts;
  const retrySeconds = Math.max(1, Math.ceil(DEFAULT_RETRY_DELAY_MS / 1000));

  if (retryable) {
    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = ?,
          error_message = ?,
          result_json = ?,
          available_at = datetime('now', ?),
          started_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(JOB_STATUS.QUEUED, errorMessage, JSON.stringify(result || null), `+${retrySeconds} seconds`, job.id);
    logger.warn(`[ingest-job:${job.id}] failed attempt ${job.attempt_count}/${job.max_attempts}; queued for retry: ${errorMessage}`);
    schedulePump(DEFAULT_RETRY_DELAY_MS);
    return;
  }

  conn.prepare(`
    UPDATE ingestion_jobs
    SET status = ?,
        error_message = ?,
        result_json = ?,
        finished_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(JOB_STATUS.FAILED, errorMessage, JSON.stringify(result || null), job.id);
  logger.error(`[ingest-job:${job.id}] exhausted retries: ${errorMessage}`);
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

async function processClaimedJob(job, conn) {
  logger.info(`[ingest-job:${job.id}] start processing file: ${job.original_name || job.file_path}`);

  let result = null;
  try {
    // runWithDb ensures all db calls inside processDocument route to this dataset.
    // Pass original_name so the document record shows the human-readable filename.
    result = await runWithDb(conn, () => processDocument(job.file_path, {
      ...job.options,
      originalName: job.original_name || null
    }));
    const duplicate = isDuplicateResult(result);

    if (!result?.success && !duplicate) {
      const reason = Array.isArray(result?.errors) && result.errors.length > 0
        ? result.errors.join("; ")
        : "Document processing failed";
      failJob(conn, job, reason, result);
      return;
    }

    completeJob(conn, job.id, result, result?.documentId || null);
    maybeCleanupUploadedFile(job.file_path, duplicate ? "duplicate" : "completed");
    logger.info(`[ingest-job:${job.id}] completed`);
  } catch (err) {
    failJob(conn, job, err.message, result);
  }
}

async function runPump() {
  if (!queueStarted) return;

  // Process jobs from all dataset connections
  for (const { connection } of getAllConnections()) {
    while (runningWorkers < configuredConcurrency) {
      const job = claimNextQueuedJob(connection);
      if (!job) break;

      runningWorkers += 1;
      processClaimedJob(job, connection)
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
  const recovered = conn.prepare(`
      UPDATE ingestion_jobs
      SET status = ?,
          started_at = NULL,
          updated_at = datetime('now'),
          error_message = CASE
            WHEN error_message IS NULL OR error_message = '' THEN 'Recovered after process restart'
            ELSE error_message
          END
      WHERE status = ?
        AND attempt_count < max_attempts
    `).run(JOB_STATUS.QUEUED, JOB_STATUS.PROCESSING);
  if (recovered.changes > 0) {
    logger.warn(`Recovered ${recovered.changes} in-flight ingestion jobs after restart`);
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
  const payload = toDbJobPayload({
    filePath,
    originalName: options.originalName,
    fileSize: options.fileSize,
    options: options.processOptions || {},
    maxAttempts: options.maxAttempts
  });

  const result = db.prepare(`
    INSERT INTO ingestion_jobs (
      file_path, original_name, file_size, status, options_json,
      attempt_count, max_attempts, created_at, queued_at, available_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'), datetime('now'), datetime('now'))
  `).run(
    payload.file_path,
    payload.original_name,
    payload.file_size,
    JOB_STATUS.QUEUED,
    payload.options_json,
    payload.max_attempts
  );

  const job = getIngestionJob(Number(result.lastInsertRowid));
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
  const row = db.prepare(`
    SELECT *
    FROM ingestion_jobs
    WHERE id = ?
  `).get(jobId);
  return normalizeJobRow(row);
}

export function listIngestionJobs(filters = {}) {
  const {
    status = null,
    limit = 50,
    offset = 0
  } = filters;

  const safeLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  const where = [];
  const params = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT *
    FROM ingestion_jobs
    ${whereClause}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, safeOffset);

  return rows.map(normalizeJobRow);
}

export function retryIngestionJob(jobId) {
  const job = getIngestionJob(jobId);
  if (!job) {
    throw new Error("Ingestion job not found");
  }
  if (![JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status)) {
    throw new Error(`Cannot retry job in status: ${job.status}`);
  }
  if (!fs.existsSync(job.file_path)) {
    throw new Error("Original upload file no longer exists; re-upload the file");
  }

  db.prepare(`
    UPDATE ingestion_jobs
    SET status = ?,
        attempt_count = 0,
        error_message = NULL,
        started_at = NULL,
        finished_at = NULL,
        available_at = datetime('now'),
        queued_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(JOB_STATUS.QUEUED, jobId);

  schedulePump();
  return getIngestionJob(jobId);
}

export function cancelIngestionJob(jobId) {
  const job = getIngestionJob(jobId);
  if (!job) {
    throw new Error("Ingestion job not found");
  }
  if (job.status !== JOB_STATUS.QUEUED) {
    throw new Error(`Only queued jobs can be cancelled (current: ${job.status})`);
  }

  db.prepare(`
    UPDATE ingestion_jobs
    SET status = ?, finished_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(JOB_STATUS.CANCELLED, jobId);

  return getIngestionJob(jobId);
}

export function getIngestionQueueStats() {
  const counts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM ingestion_jobs
    GROUP BY status
  `).all();

  const byStatus = {
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
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
