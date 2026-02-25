/**
 * DecisionRepo — CRUD for the pending_decisions table.
 *
 * Decisions are created by the KP Decision Engine when borderline cases
 * (Dice in [0.70, 0.90)) need human review before a merge or replace is executed.
 */

import { db } from "../db.js";

export const DecisionRepo = {
  /** Insert a new pending decision. Returns the run() result (has lastInsertRowid). */
  insert({
    action,
    status = "pending",
    incoming_chunk_id = null,
    target_chunk_id = null,
    node_id = null,
    confidence = null,
    reason = null,
    similarity_score = null,
    incoming_preview = null,
    target_preview = null
  }) {
    return db.prepare(`
      INSERT INTO pending_decisions
        (action, status, incoming_chunk_id, target_chunk_id, node_id,
         confidence, reason, similarity_score, incoming_preview, target_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action, status, incoming_chunk_id, target_chunk_id, node_id,
      confidence, reason, similarity_score,
      incoming_preview ? String(incoming_preview).slice(0, 200) : null,
      target_preview   ? String(target_preview).slice(0, 200)   : null
    );
  },

  /** All pending decisions, newest first. */
  getPending(limit = 50) {
    return db.prepare(`
      SELECT * FROM pending_decisions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Math.max(1, Number(limit)));
  },

  /**
   * Paginated list, optionally filtered by status.
   * @param {{ status?, limit?, offset? }} opts
   */
  getAll({ status = null, limit = 50, offset = 0 } = {}) {
    if (status) {
      return db.prepare(`
        SELECT * FROM pending_decisions
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(status, Math.max(1, Number(limit)), Math.max(0, Number(offset)));
    }
    return db.prepare(`
      SELECT * FROM pending_decisions
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(Math.max(1, Number(limit)), Math.max(0, Number(offset)));
  },

  /** Single decision by id. */
  getById(id) {
    return db.prepare("SELECT * FROM pending_decisions WHERE id = ?").get(id) ?? null;
  },

  /**
   * Update status (and resolved_at / resolved_by).
   * @param {number} id
   * @param {'accepted'|'rejected'|'auto_resolved'} status
   * @param {'user'|'cleanup_job'} resolved_by
   */
  updateStatus(id, status, resolved_by = "user") {
    return db.prepare(`
      UPDATE pending_decisions
      SET status = ?, resolved_at = datetime('now'), resolved_by = ?
      WHERE id = ?
    `).run(status, resolved_by, id);
  },

  /** Counts per status. Returns { pending, accepted, rejected, auto_resolved, total }. */
  countByStatus() {
    const rows = db.prepare(`
      SELECT status, COUNT(*) as n FROM pending_decisions GROUP BY status
    `).all();
    const counts = { pending: 0, accepted: 0, rejected: 0, auto_resolved: 0, total: 0 };
    for (const r of rows) {
      counts[r.status] = r.n;
      counts.total += r.n;
    }
    return counts;
  }
};
