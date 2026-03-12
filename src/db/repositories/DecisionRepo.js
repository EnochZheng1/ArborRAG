/**
 * DecisionRepo — CRUD for the pending_decisions table.
 *
 * Decisions are created by the KP Decision Engine when human review is needed:
 * value_conflict (LLM-detected contradictions), replace_suggestion (temporal updates),
 * and node_merge_suggestion (similar sibling nodes).
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
   * Paginated list, optionally filtered by status and/or action type.
   * @param {{ status?, action?, limit?, offset? }} opts
   */
  getAll({ status = null, action = null, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    if (status) { conditions.push("status = ?"); params.push(status); }
    if (action) { conditions.push("action = ?"); params.push(action); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.max(1, Number(limit)), Math.max(0, Number(offset)));
    return db.prepare(`
      SELECT * FROM pending_decisions
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);
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

  /**
   * Delete all decisions that reference any of the given chunk IDs
   * (either as incoming or target). Called during document deletion.
   * @param {number[]} chunkIds
   */
  deleteByChunkIds(chunkIds) {
    if (!chunkIds?.length) return 0;
    const ph = chunkIds.map(() => "?").join(",");
    return db.prepare(`
      DELETE FROM pending_decisions
      WHERE incoming_chunk_id IN (${ph}) OR target_chunk_id IN (${ph})
    `).run(...chunkIds, ...chunkIds).changes;
  },

  /** Back-fill incoming_chunk_id on the most recent pending decision for a node (legacy fallback). */
  updateIncomingChunkId(nodeId, chunkId) {
    return db.prepare(`
      UPDATE pending_decisions
      SET incoming_chunk_id = ?
      WHERE id = (
        SELECT id FROM pending_decisions
        WHERE node_id = ? AND incoming_chunk_id IS NULL AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1
      )
    `).run(chunkId, nodeId);
  },

  /** Back-fill incoming_chunk_id by exact decision ID (preferred over node-based match). */
  updateIncomingChunkIdById(decisionId, chunkId) {
    return db.prepare(`
      UPDATE pending_decisions
      SET incoming_chunk_id = ?
      WHERE id = ? AND incoming_chunk_id IS NULL
    `).run(chunkId, decisionId);
  },

  /** Bulk-reject all pending decisions of a given action type. Returns count of affected rows. */
  bulkRejectByAction(action) {
    return db.prepare(`
      UPDATE pending_decisions
      SET status = 'rejected', resolved_at = datetime('now'), resolved_by = 'system'
      WHERE status = 'pending' AND action = ?
    `).run(action).changes;
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
  },

  /** Counts of pending decisions grouped by action type. Returns array of { action, count }. */
  countPendingByAction() {
    return db.prepare(`
      SELECT action, COUNT(*) as count
      FROM pending_decisions
      WHERE status = 'pending'
      GROUP BY action
      ORDER BY count DESC
    `).all();
  }
};
