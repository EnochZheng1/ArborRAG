/**
 * Embedding repository — embeddings table reads and writes.
 */

import { db } from "../db.js";

export const EmbeddingRepo = {
  // ── Writes ────────────────────────────────────────────────────────────────────

  /**
   * Find an existing embedding record by (refType, refId).
   * Returns { id } or null.
   */
  findByRef(refType, refId) {
    return db.prepare(
      "SELECT id FROM embeddings WHERE ref_type = ? AND ref_id = ?"
    ).get(refType, String(refId)) ?? null;
  },

  /** Update the vector data and model for an existing embedding row. */
  update(id, embeddingJson, model) {
    return db.prepare(`
      UPDATE embeddings SET embedding_json = ?, model = ?, created_at = datetime('now')
      WHERE id = ?
    `).run(embeddingJson, model, id);
  },

  /** Insert a new embedding row. Returns { lastInsertRowid }. */
  insert({ refType, refId, embeddingJson, model }) {
    return db.prepare(`
      INSERT INTO embeddings (ref_type, ref_id, embedding_json, model, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(refType, String(refId), embeddingJson, model);
  },

  // ── Reads ─────────────────────────────────────────────────────────────────────

  /** Get the raw embedding_json string for a (refType, refId) pair. */
  getJson(refType, refId) {
    return db.prepare(
      "SELECT embedding_json FROM embeddings WHERE ref_type = ? AND ref_id = ?"
    ).get(refType, String(refId)) ?? null;
  },

  /** All (ref_id, embedding_json) pairs for a given ref_type. */
  getAllJson(refType) {
    return db.prepare(
      "SELECT ref_id, embedding_json FROM embeddings WHERE ref_type = ?"
    ).all(refType);
  },

  /** Delete an embedding by (refType, refId). Returns { changes }. */
  deleteByRef(refType, refId) {
    return db.prepare(
      "DELETE FROM embeddings WHERE ref_type = ? AND ref_id = ?"
    ).run(refType, String(refId));
  },

  /** Per-type counts. Returns array of { ref_type, count }. */
  getStatsByType() {
    return db.prepare(
      "SELECT ref_type, COUNT(*) as count FROM embeddings GROUP BY ref_type"
    ).all();
  },

  /** Total embedding count. */
  getTotal() {
    return db.prepare("SELECT COUNT(*) as total FROM embeddings").get().total ?? 0;
  },

  /** Check whether an embedding exists for (refType, refId). */
  existsByRef(refType, refId) {
    return !!db.prepare(
      "SELECT 1 FROM embeddings WHERE ref_type = ? AND ref_id = ? LIMIT 1"
    ).get(refType, String(refId));
  },

  // ── Pending-embedding queries ─────────────────────────────────────────────────

  /**
   * Nodes that do not yet have a 'node' embedding.
   * Returns [{ refId, text }].
   */
  getPendingNodes(limit = 100) {
    return db.prepare(`
      SELECT n.node_id as ref_id, n.name || ' ' || COALESCE(n.node_summary, '') as text
      FROM nodes n
      LEFT JOIN embeddings e ON e.ref_type = 'node' AND e.ref_id = n.node_id
      WHERE e.id IS NULL
      LIMIT ?
    `).all(limit).map(r => ({ refId: r.ref_id, text: r.text }));
  },

  /**
   * Active chunks that do not yet have a 'chunk' embedding.
   * Returns [{ refId, text }].
   */
  getPendingChunks(limit = 100) {
    return db.prepare(`
      SELECT c.id as ref_id, c.content_clean as text
      FROM chunks c
      LEFT JOIN embeddings e ON e.ref_type = 'chunk' AND e.ref_id = CAST(c.id AS TEXT)
      WHERE e.id IS NULL AND c.status = 'active'
      LIMIT ?
    `).all(limit).map(r => ({ refId: String(r.ref_id), text: r.text }));
  },

  // ── Cross-table lookups used by vector search ────────────────────────────────

  /** Nodes by an array of node_ids (for enriching vector search results). */
  getNodesByIds(nodeIds) {
    if (!nodeIds.length) return [];
    const ph = nodeIds.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM nodes WHERE node_id IN (${ph})`).all(...nodeIds);
  },

  /** Active chunks by an array of integer IDs (for enriching vector search results). */
  getChunksByIds(chunkIds) {
    if (!chunkIds.length) return [];
    const ph = chunkIds.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM chunks WHERE id IN (${ph}) AND status = 'active'`).all(...chunkIds);
  },

  // ── Coverage stats ────────────────────────────────────────────────────────────

  /** { total_nodes, embedded_nodes } for coverage reporting. */
  getNodeCoverage() {
    return db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) as total_nodes,
        (SELECT COUNT(*) FROM embeddings WHERE ref_type = 'node') as embedded_nodes
    `).get();
  },

  /** { total_chunks, embedded_chunks } for coverage reporting. */
  getChunkCoverage() {
    return db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM chunks WHERE status = 'active') as total_chunks,
        (SELECT COUNT(*) FROM embeddings WHERE ref_type = 'chunk') as embedded_chunks
    `).get();
  }
};
