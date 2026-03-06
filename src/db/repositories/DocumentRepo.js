/**
 * Document repository — documents table reads, writes, and aggregates.
 */

import { db } from "../db.js";

export const DocumentRepo = {
  // ── Reads ─────────────────────────────────────────────────────────────────────

  /** Single document row, or null. */
  getById(docId) {
    return db.prepare("SELECT * FROM documents WHERE id = ?").get(docId) ?? null;
  },

  /**
   * Find an existing document by file hash (non-deleted).
   * Returns the most recent match, including its status, so the caller can
   * decide whether this is a true duplicate ('processed') or a retriable
   * previous attempt ('failed', 'pending').
   * Excludes 'processing' rows to avoid reusing docs mid-flight or from crashes
   * (those are handled by requeueRecoverable at startup).
   */
  findByHash(hash) {
    return db.prepare(
      "SELECT id, status FROM documents WHERE file_hash = ? AND status IN ('processed','failed','pending') ORDER BY id DESC LIMIT 1"
    ).get(hash) ?? null;
  },

  /** metadata_json field for a document, or null if not found. */
  getMetadataJson(docId) {
    return db.prepare("SELECT metadata_json FROM documents WHERE id = ?").get(docId)?.metadata_json ?? null;
  },

  /** List documents with optional status filter, paginated. */
  list({ status, limit = 50, offset = 0 } = {}) {
    if (status) {
      return db.prepare(
        "SELECT * FROM documents WHERE status = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?"
      ).all(status, limit, offset);
    }
    return db.prepare(
      "SELECT * FROM documents WHERE status != 'deleted' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset);
  },

  // ── Writes ────────────────────────────────────────────────────────────────────

  /** Insert a new document record. Returns the run() result (has lastInsertRowid). */
  insert({ filename, originalName, fileType, fileSize, fileHash, metadataJson }) {
    return db.prepare(`
      INSERT INTO documents (filename, original_name, file_type, file_size, file_hash, metadata_json, status, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run(filename, originalName, fileType, fileSize, fileHash, metadataJson);
  },

  /**
   * Update document status. Optionally sets processed_at (when status='processed')
   * and chunk_count.
   */
  updateStatus(docId, status, chunkCount = null) {
    const updates = ["status = ?"];
    const params = [status];
    if (status === "processed") updates.push("processed_at = datetime('now')");
    if (chunkCount !== null) { updates.push("chunk_count = ?"); params.push(chunkCount); }
    params.push(docId);
    return db.prepare(`UPDATE documents SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  },

  /** Update status and metadata_json together (for step progress tracking). */
  updateStatusAndMetadata(docId, status, metadataJson) {
    return db.prepare("UPDATE documents SET status = ?, metadata_json = ? WHERE id = ?")
      .run(status, metadataJson, docId);
  },

  /** Soft-delete a single document. */
  softDelete(docId) {
    return db.prepare("UPDATE documents SET status = 'deleted' WHERE id = ?").run(docId);
  },

  /** Soft-delete all non-deleted documents (for emptyTree). */
  softDeleteAll() {
    return db.prepare("UPDATE documents SET status = 'deleted' WHERE status != 'deleted'").run();
  },

  // ── Aggregates ────────────────────────────────────────────────────────────────

  /** Aggregate document counts by status. */
  getStats() {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'processed'  THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'pending'    THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) as failed
      FROM documents
    `).get();
  }
};
