/**
 * Conflict repository — conflicts table reads and writes.
 * Chunk/node writes (archive, score) are also here since they belong to
 * conflict resolution logic.
 */

import { db } from "../db.js";

export const ConflictRepo = {
  // ── Chunk reads used by conflict detection ────────────────────────────────────

  /** Fetch a chunk for comparison: id, doc_title, content, authority_level, uploaded_at. */
  getChunkForConflict(chunkId) {
    return db.prepare(`
      SELECT id, doc_title, content_clean as content, authority_level, uploaded_at
      FROM chunks WHERE id = ?
    `).get(chunkId) ?? null;
  },

  /**
   * Existing active chunks in a node (for conflict checking against a new chunk).
   * Excludes the new chunk itself.
   */
  getExistingChunks(nodeId, excludeChunkId, limit = 20) {
    return db.prepare(`
      SELECT id, doc_title, content_clean as content, authority_level, uploaded_at
      FROM chunks
      WHERE node_id = ? AND id != ? AND status = 'active'
      ORDER BY uploaded_at DESC
      LIMIT ?
    `).all(nodeId, excludeChunkId, limit);
  },

  // ── Conflict reads ────────────────────────────────────────────────────────────

  /** Find an existing unresolved conflict record for the same pair. */
  findExisting(nodeId, chunkAId, chunkBId) {
    return db.prepare(`
      SELECT id FROM conflicts
      WHERE node_id = ? AND chunk_a_id = ? AND chunk_b_id = ? AND resolution = 'human_review'
    `).get(nodeId, chunkAId, chunkBId) ?? null;
  },

  /** Single conflict by primary key. */
  findById(conflictId) {
    return db.prepare("SELECT * FROM conflicts WHERE id = ?").get(conflictId) ?? null;
  },

  /**
   * All unresolved conflicts, optionally filtered by node.
   * Returns full rows joined with chunk content and node name.
   * @param {string|null} nodeId - null = all nodes
   */
  getUnresolved(nodeId = null) {
    let query = `
      SELECT c.*,
             ca.content_clean as chunk_a_content, ca.doc_title as chunk_a_title,
             cb.content_clean as chunk_b_content, cb.doc_title as chunk_b_title,
             n.name as node_name
      FROM conflicts c
      JOIN chunks ca ON c.chunk_a_id = ca.id
      JOIN chunks cb ON c.chunk_b_id = cb.id
      JOIN nodes n ON c.node_id = n.node_id
      WHERE c.resolution = 'human_review'
    `;
    const params = [];
    if (nodeId) {
      query += " AND c.node_id = ?";
      params.push(nodeId);
    }
    query += " ORDER BY c.created_at DESC";
    return db.prepare(query).all(...params);
  },

  /** Aggregate stats: total, unresolved, resolved counts. */
  getStats() {
    return db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN resolution = 'human_review' THEN 1 ELSE 0 END) as unresolved,
        SUM(CASE WHEN resolution != 'human_review' THEN 1 ELSE 0 END) as resolved
      FROM conflicts
    `).get();
  },

  /** Counts per conflict_type for unresolved conflicts. */
  getByType() {
    return db.prepare(`
      SELECT conflict_type, COUNT(*) as count
      FROM conflicts
      WHERE resolution = 'human_review'
      GROUP BY conflict_type
    `).all();
  },

  /** Top nodes by unresolved conflict count (joined with node name). */
  getByNode(limit = 10) {
    return db.prepare(`
      SELECT n.node_id, n.name, COUNT(c.id) as conflict_count
      FROM conflicts c
      JOIN nodes n ON c.node_id = n.node_id
      WHERE c.resolution = 'human_review'
      GROUP BY n.node_id
      ORDER BY conflict_count DESC
      LIMIT ?
    `).all(limit);
  },

  // ── Conflict writes ───────────────────────────────────────────────────────────

  /** Insert a new conflict record. Returns { lastInsertRowid }. */
  insert({ nodeId, chunkAId, chunkBId, conflictType, reasonJson, resolution }) {
    return db.prepare(`
      INSERT INTO conflicts (node_id, chunk_a_id, chunk_b_id, conflict_type, reason_json, resolution, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(nodeId, chunkAId, chunkBId, conflictType, reasonJson, resolution);
  },

  /** Update a conflict's resolution field and set resolved_at timestamp. */
  resolve(conflictId, resolution) {
    return db.prepare(`
      UPDATE conflicts SET resolution = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(resolution, conflictId);
  },

  // ── Side-effect writes on related tables ──────────────────────────────────────

  /** Increment the conflict_score for a node. */
  incrementNodeScore(nodeId) {
    return db.prepare(
      "UPDATE nodes SET conflict_score = conflict_score + 1 WHERE node_id = ?"
    ).run(nodeId);
  },

  /** Decrement the conflict_score (floor 0) for a node. */
  decrementNodeScore(nodeId) {
    return db.prepare(
      "UPDATE nodes SET conflict_score = MAX(0, conflict_score - 1) WHERE node_id = ?"
    ).run(nodeId);
  },

  /** Archive a chunk (mark it as 'archived') during conflict resolution. */
  archiveChunk(chunkId) {
    return db.prepare("UPDATE chunks SET status = 'archived' WHERE id = ?").run(chunkId);
  }
};
