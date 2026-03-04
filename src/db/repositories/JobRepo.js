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

  saveCheckpoint(jobId, data) {
    db.prepare(
      "UPDATE ingestion_jobs SET checkpoint_json = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(data === null ? null : JSON.stringify(data), jobId);
  },

  loadCheckpoint(jobId) {
    const row = db.prepare("SELECT checkpoint_json FROM ingestion_jobs WHERE id = ?").get(jobId);
    return row?.checkpoint_json ? safeJson(row.checkpoint_json, null) : null;
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
      WHERE id = ?
    `).run(documentId, JSON.stringify(result ?? null), jobId);
  },

  /**
   * @returns {boolean} true if the job was re-queued for retry, false if exhausted
   */
  fail(conn, job, errorMessage, result = null, retryDelaySeconds = 5) {
    const retryable = job.attempt_count < job.max_attempts;
    if (retryable) {
      conn.prepare(`
        UPDATE ingestion_jobs
        SET status = 'queued', error_message = ?, result_json = ?,
            available_at = datetime('now', ?), started_at = NULL,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(errorMessage, JSON.stringify(result ?? null), `+${retryDelaySeconds} seconds`, job.id);
      return true;
    }
    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'failed', error_message = ?, result_json = ?,
          finished_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(errorMessage, JSON.stringify(result ?? null), job.id);
    return false;
  },

  pauseRateLimited(conn, jobId, errorMessage) {
    conn.prepare(`
      UPDATE ingestion_jobs
      SET status = 'rate_limited', error_message = ?,
          started_at = NULL, finished_at = NULL, updated_at = datetime('now')
      WHERE id = ?
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
  }
};
