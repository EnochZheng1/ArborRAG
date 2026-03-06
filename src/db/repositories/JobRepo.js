/**
 * Ingestion job repository — ingestion_jobs table.
 *
 * Public-API methods use the `db` Proxy (request-scoped, any dataset).
 * Pump methods accept an explicit `conn` for transaction safety outside HTTP context.
 */

import { db, safeJson } from "../db.js";

function normalize(row) {
  if (!row) return null;
  return {
    ...row,
    options: safeJson(row.options_json, {}),
    result:  safeJson(row.result_json, null)
  };
}

export const JobRepo = {
  // ── Public API (uses db Proxy) ──────────────────────────────────────────────

  findById(id) {
    return normalize(
      db.prepare("SELECT * FROM ingestion_jobs WHERE id = ?").get(id)
    );
  },

  list({ status, limit = 50, offset = 0 } = {}) {
    const safeLimit  = Math.max(1, Math.min(200, Number.parseInt(limit,  10) || 50));
    const safeOffset = Math.max(0,              Number.parseInt(offset, 10) || 0);
    const where  = status ? "WHERE status = ?" : "";
    const params = status
      ? [status, safeLimit, safeOffset]
      : [safeLimit, safeOffset];

    return db.prepare(`
      SELECT * FROM ingestion_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params).map(normalize);
  },

  insert({ filePath, originalName, fileSize, optionsJson, maxAttempts }) {
    const r = db.prepare(`
      INSERT INTO ingestion_jobs (
        file_path, original_name, file_size, status, options_json,
        attempt_count, max_attempts, created_at, queued_at, available_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, 0, ?,
        datetime('now'), datetime('now'), datetime('now'), datetime('now'))
    `).run(filePath, originalName ?? null, fileSize ?? null, optionsJson, maxAttempts);
    return Number(r.lastInsertRowid);
  },

  setQueued(id) {
    db.prepare(`
      UPDATE ingestion_jobs
      SET status = 'queued', attempt_count = 0, error_message = NULL,
          started_at = NULL, finished_at = NULL,
          available_at = datetime('now'), queued_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  setCancelled(id) {
    db.prepare(`
      UPDATE ingestion_jobs
      SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
  },

  /**
   * Cancel all queued jobs on a specific connection (used before closing a dataset).
   * Takes a raw better-sqlite3 connection, not the Proxy, so it works outside request context.
   * @returns {number} Number of jobs cancelled
   */
  cancelAllQueued(conn) {
    return conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now')
      WHERE status = 'queued'
    `).run().changes;
  },

  getStatusCounts() {
    return db.prepare(
      "SELECT status, COUNT(*) as count FROM ingestion_jobs GROUP BY status"
    ).all();
  },

  /** All jobs that have not reached a terminal state, ordered oldest-first. */
  listActive() {
    return db.prepare(`
      SELECT * FROM ingestion_jobs
      WHERE status IN ('queued', 'processing', 'rate_limited', 'failed')
      ORDER BY id ASC
    `).all().map(normalize);
  },

  /** Most-recent job linked to a specific document (by document_id). */
  findByDocumentId(docId) {
    return normalize(
      db.prepare(
        "SELECT * FROM ingestion_jobs WHERE document_id = ? ORDER BY id DESC LIMIT 1"
      ).get(docId)
    );
  },

  /** Cancel queued/processing/rate_limited jobs that are linked to the given document. */
  cancelForDocument(docId) {
    return db.prepare(`
      UPDATE ingestion_jobs
      SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now')
      WHERE document_id = ? AND status IN ('queued', 'processing', 'rate_limited')
    `).run(docId).changes;
  },

  /** Cancel all queued, processing, and rate_limited jobs (bulk operation). */
  cancelAllActive() {
    return db.prepare(`
      UPDATE ingestion_jobs
      SET status = 'cancelled', finished_at = datetime('now'), updated_at = datetime('now')
      WHERE status IN ('queued', 'processing', 'rate_limited')
    `).run().changes;
  },

  /** Re-queue all rate_limited and failed jobs so they run again. */
  retryAllPaused() {
    return db.prepare(`
      UPDATE ingestion_jobs
      SET status = 'queued', attempt_count = 0, error_message = NULL,
          started_at = NULL, finished_at = NULL,
          available_at = datetime('now'), queued_at = datetime('now'),
          updated_at = datetime('now')
      WHERE status IN ('rate_limited', 'failed')
    `).run().changes;
  },

  saveCheckpoint(jobId, data) {
    db.prepare(
      "UPDATE ingestion_jobs SET checkpoint_json = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(data === null ? null : JSON.stringify(data), jobId);
  },

  loadCheckpoint(jobId) {
    const row = db.prepare("SELECT checkpoint_json FROM ingestion_jobs WHERE id = ?").get(jobId);
    return row?.checkpoint_json ? safeJson(row.checkpoint_json, null) : null;
  },

  /** Link a document_id to a job row (used after failure to preserve the association). */
  setDocumentId(conn, jobId, documentId) {
    conn.prepare(
      "UPDATE ingestion_jobs SET document_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(documentId, jobId);
  },

  // ── Pump functions (explicit conn for transaction safety) ───────────────────

  claimNext(conn) {
    conn.exec("BEGIN IMMEDIATE");
    try {
      const row = conn.prepare(`
        SELECT * FROM ingestion_jobs
        WHERE status = 'queued' AND datetime(available_at) <= datetime('now')
        ORDER BY queued_at ASC, id ASC LIMIT 1
      `).get();

      if (!row) { conn.exec("COMMIT"); return null; }

      conn.prepare(`
        UPDATE ingestion_jobs
        SET status = 'processing', started_at = datetime('now'),
            updated_at = datetime('now'), attempt_count = attempt_count + 1,
            error_message = NULL
        WHERE id = ?
      `).run(row.id);

      const claimed = conn.prepare("SELECT * FROM ingestion_jobs WHERE id = ?").get(row.id);
      conn.exec("COMMIT");
      return normalize(claimed);
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  },

  complete(conn, jobId, result, documentId = null) {
    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'completed', document_id = ?, result_json = ?,
          checkpoint_json = NULL,
          finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status != 'cancelled'
    `).run(documentId, JSON.stringify(result ?? null), jobId);
  },

  /**
   * @returns {boolean} true if the job was re-queued for retry, false if exhausted
   */
  fail(conn, job, errorMessage, result = null, retryDelaySeconds = 5) {
    // If the job was cancelled while processing, don't overwrite the status
    const current = conn.prepare("SELECT status FROM ingestion_jobs WHERE id = ?").get(job.id);
    if (current?.status === 'cancelled') return false;

    const retryable = job.attempt_count < job.max_attempts;
    if (retryable) {
      conn.prepare(`
        UPDATE ingestion_jobs
        SET status = 'queued', error_message = ?, result_json = ?,
            available_at = datetime('now', ?), started_at = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND status != 'cancelled'
      `).run(errorMessage, JSON.stringify(result ?? null), `+${retryDelaySeconds} seconds`, job.id);
      return true;
    }
    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'failed', error_message = ?, result_json = ?,
          finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status != 'cancelled'
    `).run(errorMessage, JSON.stringify(result ?? null), job.id);
    return false;
  },

  /**
   * Requeue a job after a transient error (network, timeout, 5xx) without
   * burning the retry budget — attempt_count is decremented back.
   */
  failTransient(conn, job, errorMessage, retryDelaySeconds = 30) {
    const current = conn.prepare("SELECT status FROM ingestion_jobs WHERE id = ?").get(job.id);
    if (current?.status === 'cancelled') return;

    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'queued', error_message = ?,
          attempt_count = MAX(0, attempt_count - 1),
          available_at = datetime('now', ?), started_at = NULL,
          updated_at = datetime('now')
      WHERE id = ? AND status != 'cancelled'
    `).run(errorMessage, `+${retryDelaySeconds} seconds`, job.id);
  },

  pauseRateLimited(conn, jobId, errorMessage) {
    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'rate_limited', error_message = ?,
          started_at = NULL, finished_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status != 'cancelled'
    `).run(errorMessage, jobId);
  },

  requeueRecoverable(conn) {
    return conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'queued', started_at = NULL, updated_at = datetime('now'),
          error_message = CASE
            WHEN error_message IS NULL OR error_message = ''
              THEN 'Recovered after process restart'
            ELSE error_message
          END
      WHERE status = 'processing' AND attempt_count < max_attempts
    `).run().changes;
  },

  /**
   * Requeue processing jobs whose heartbeat (updated_at) is older than maxAgeMinutes.
   * This catches jobs that got stuck mid-run without throwing an exception
   * (e.g. the event loop stalled, a network call hung indefinitely).
   */
  requeueStuck(conn, maxAgeMinutes = 20) {
    const safeMinutes = Math.max(1, Math.floor(Number(maxAgeMinutes)));
    return conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'queued', started_at = NULL, updated_at = datetime('now'),
          error_message = ?
      WHERE status = 'processing'
        AND attempt_count < max_attempts
        AND datetime(updated_at) <= datetime('now', ?)
    `).run(
      `Job timed out (no progress for ${safeMinutes} minutes) — retrying`,
      `-${safeMinutes} minutes`
    ).changes;
  },

  /**
   * Return a Map of { jobId → 1-based queue position } for all currently queued jobs.
   * Single query using a row-number emulation (SQLite <3.25 compatible).
   */
  getAllQueuePositions() {
    const rows = db.prepare(`
      SELECT id,
             (SELECT COUNT(*) FROM ingestion_jobs q2
              WHERE q2.status = 'queued'
                AND (q2.queued_at < q1.queued_at
                     OR (q2.queued_at = q1.queued_at AND q2.id < q1.id))
             ) + 1 AS pos
      FROM ingestion_jobs q1
      WHERE q1.status = 'queued'
    `).all();
    const map = new Map();
    for (const r of rows) map.set(r.id, r.pos);
    return map;
  },

  /** Touch updated_at to signal the job is still alive (heartbeat). */
  heartbeat(conn, jobId) {
    conn.prepare(
      "UPDATE ingestion_jobs SET updated_at = datetime('now') WHERE id = ?"
    ).run(jobId);
  }
};
