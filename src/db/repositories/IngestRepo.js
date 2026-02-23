/**
 * Ingest repository — multi-table cleanup operations used by rollback,
 * deleteDocument, and emptyTree.  All of these touch tables across multiple
 * domains, so they live here rather than in a single-table repo.
 */

import { db } from "../db.js";

export const IngestRepo = {
  // ── Chunk reads ───────────────────────────────────────────────────────────────

  /** id, node_id, and source_documents_json for every chunk belonging to a document. */
  getChunksForDoc(docId) {
    return db.prepare("SELECT id, node_id, source_documents_json FROM chunks WHERE document_id = ?").all(docId);
  },

  // ── Conflict cleanup ──────────────────────────────────────────────────────────

  /** DISTINCT node_ids referenced in conflicts that involve the given chunk ids. */
  getConflictNodeIds(chunkIds) {
    if (!chunkIds.length) return [];
    const ph = chunkIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT DISTINCT node_id FROM conflicts WHERE chunk_a_id IN (${ph}) OR chunk_b_id IN (${ph})`
    ).all(...chunkIds, ...chunkIds);
  },

  /** Delete conflicts for a set of chunk ids. */
  deleteConflictsForChunks(chunkIds) {
    if (!chunkIds.length) return;
    const ph = chunkIds.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM conflicts WHERE chunk_a_id IN (${ph}) OR chunk_b_id IN (${ph})`
    ).run(...chunkIds, ...chunkIds);
  },

  // ── Embedding cleanup ─────────────────────────────────────────────────────────

  /** Delete chunk embeddings for a set of string ref_ids. */
  deleteEmbeddingsForChunks(strIds) {
    if (!strIds.length) return;
    const ph = strIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM embeddings WHERE ref_type = 'chunk' AND ref_id IN (${ph})`).run(...strIds);
  },

  /** Delete the embedding for a single chunk (by numeric id). */
  deleteEmbeddingForChunk(chunkId) {
    db.prepare("DELETE FROM embeddings WHERE ref_type = 'chunk' AND ref_id = ?").run(String(chunkId));
  },

  /** Delete the embedding for a node. */
  deleteNodeEmbedding(nodeId) {
    db.prepare("DELETE FROM embeddings WHERE ref_type = 'node' AND ref_id = ?").run(nodeId);
  },

  /** Delete all embeddings (emptyTree). */
  deleteAllEmbeddings() {
    db.prepare("DELETE FROM embeddings").run();
  },

  // ── chunks_fts cleanup ────────────────────────────────────────────────────────

  /** Delete chunks_fts rows for a set of string chunk ids. */
  deleteChunkFtsForIds(strIds) {
    if (!strIds.length) return;
    const ph = strIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${ph})`).run(...strIds);
  },

  /** Delete the chunks_fts row for a single chunk (by numeric id). */
  deleteChunkFts(chunkId) {
    db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(String(chunkId));
  },

  /** Delete all chunks_fts rows (emptyTree). */
  deleteAllChunkFts() {
    db.prepare("DELETE FROM chunks_fts").run();
  },

  // ── nodes_fts cleanup ─────────────────────────────────────────────────────────

  /** Delete the nodes_fts row for a node. */
  deleteNodeFts(nodeId) {
    db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);
  },

  /** Delete all nodes_fts rows (emptyTree). */
  deleteAllNodeFts() {
    db.prepare("DELETE FROM nodes_fts").run();
  },

  // ── Chunk table cleanup ───────────────────────────────────────────────────────

  /** Clear superseded_by for chunks that reference any of the given chunk ids. */
  clearSupersededByForChunks(chunkIds) {
    if (!chunkIds.length) return;
    const ph = chunkIds.map(() => "?").join(",");
    db.prepare(`UPDATE chunks SET superseded_by = NULL WHERE superseded_by IN (${ph})`).run(...chunkIds);
  },

  /** Clear superseded_by for all chunks belonging to a document. */
  clearSupersededByForDoc(docId) {
    db.prepare("UPDATE chunks SET superseded_by = NULL WHERE document_id = ?").run(docId);
  },

  /** Delete all chunks for a document. */
  deleteChunksForDoc(docId) {
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
  },

  /** Delete specific chunk rows by ID array (for KP-aware rollback). */
  deleteChunksByIds(ids) {
    if (!ids.length) return;
    const ph = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM chunks WHERE id IN (${ph})`).run(...ids);
  },

  /** Update source_documents_json on a chunk (for KP shared-source shrink during rollback). */
  updateChunkSourceDocuments(chunkId, sourceDocsJson) {
    db.prepare("UPDATE chunks SET source_documents_json = ? WHERE id = ?").run(sourceDocsJson, chunkId);
  },

  /** Delete all chunks (emptyTree). */
  deleteAllChunks() {
    db.prepare("DELETE FROM chunks").run();
  },

  // ── Node cleanup ──────────────────────────────────────────────────────────────

  /** Fetch node_id, level, parent_id for a set of node ids. */
  getNodesByIds(nodeIds) {
    if (!nodeIds.length) return [];
    const ph = nodeIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT node_id, level, parent_id FROM nodes WHERE node_id IN (${ph})`
    ).all(...nodeIds);
  },

  /** Count of chunks (any status) assigned to a node. */
  getChunkCountForNode(nodeId) {
    return db.prepare("SELECT COUNT(*) as count FROM chunks WHERE node_id = ?").get(nodeId).count;
  },

  /** Count of direct child nodes. */
  getChildCountForNode(nodeId) {
    return db.prepare("SELECT COUNT(*) as count FROM nodes WHERE parent_id = ?").get(nodeId).count;
  },

  /** All direct child node_ids for a parent. */
  getChildrenOfNode(nodeId) {
    return db.prepare("SELECT node_id FROM nodes WHERE parent_id = ?").all(nodeId);
  },

  /** Delete a single node row. */
  deleteNode(nodeId) {
    db.prepare("DELETE FROM nodes WHERE node_id = ?").run(nodeId);
  },

  /** parent_id of a node, or null if not found or root. */
  getNodeParentId(nodeId) {
    return db.prepare("SELECT parent_id FROM nodes WHERE node_id = ?").get(nodeId)?.parent_id ?? null;
  },

  /** Delete all nodes (emptyTree). */
  deleteAllNodes() {
    db.prepare("DELETE FROM nodes").run();
  },

  // ── Conflict-score recalculation ──────────────────────────────────────────────

  /** Count of open (human_review) conflicts for a node. */
  getOpenConflictCount(nodeId) {
    return db.prepare(
      "SELECT COUNT(*) as count FROM conflicts WHERE node_id = ? AND resolution = 'human_review'"
    ).get(nodeId).count;
  },

  /** Set a node's conflict_score. */
  updateNodeConflictScore(nodeId, count) {
    db.prepare(
      "UPDATE nodes SET conflict_score = ?, updated_at = datetime('now') WHERE node_id = ?"
    ).run(count, nodeId);
  },

  /** Delete all conflicts (emptyTree). */
  deleteAllConflicts() {
    db.prepare("DELETE FROM conflicts").run();
  },

  // ── Document status ───────────────────────────────────────────────────────────

  /** Mark a document as failed with chunk_count = 0. */
  markDocumentFailed(docId) {
    db.prepare("UPDATE documents SET status = 'failed', chunk_count = 0 WHERE id = ?").run(docId);
  },

  // ── Entity / fact orphan cleanup ──────────────────────────────────────────────

  /** Delete facts with no remaining evidence. Returns deleted count. */
  deleteOrphanedFacts() {
    return db.prepare(
      "DELETE FROM facts WHERE id NOT IN (SELECT DISTINCT fact_id FROM fact_evidence)"
    ).run().changes;
  },

  /** Delete entities with no remaining mentions. Returns deleted count. */
  deleteOrphanedEntities() {
    return db.prepare(
      "DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)"
    ).run().changes;
  },

  /** Delete all facts (emptyTree). */
  deleteAllFacts() {
    db.prepare("DELETE FROM facts").run();
  },

  /** Delete all entities (emptyTree). */
  deleteAllEntities() {
    db.prepare("DELETE FROM entities").run();
  },

  // ── emptyTree count helpers ───────────────────────────────────────────────────

  countNodes() {
    return db.prepare("SELECT COUNT(*) as count FROM nodes").get().count;
  },
  countChunks() {
    return db.prepare("SELECT COUNT(*) as count FROM chunks").get().count;
  },
  countEmbeddings() {
    return db.prepare("SELECT COUNT(*) as count FROM embeddings").get().count;
  },
  countActiveDocs() {
    return db.prepare("SELECT COUNT(*) as count FROM documents WHERE status != 'deleted'").get().count;
  }
};
