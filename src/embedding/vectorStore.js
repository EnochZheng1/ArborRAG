import { db, safeJson, runTransaction } from "../db/db.js";
import { cosineSimilarity, getEmbeddingModel } from "./embedder.js";

/**
 * Vector storage and retrieval using SQLite
 */

/**
 * Store an embedding in the database
 * @param {string} refType - Reference type (e.g., "node", "chunk")
 * @param {string} refId - Reference ID
 * @param {number[]} embedding - Embedding vector
 * @returns {number} Embedding record ID
 */
export function storeEmbedding(refType, refId, embedding) {
  const model = getEmbeddingModel();

  // Upsert embedding
  const existing = db.prepare(`
    SELECT id FROM embeddings WHERE ref_type = ? AND ref_id = ?
  `).get(refType, String(refId));

  if (existing) {
    db.prepare(`
      UPDATE embeddings SET embedding_json = ?, model = ?, created_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(embedding), model, existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO embeddings (ref_type, ref_id, embedding_json, model, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(refType, String(refId), JSON.stringify(embedding), model);

  return Number(result.lastInsertRowid);
}

/**
 * Store multiple embeddings in batch
 * @param {Array<{refType: string, refId: string, embedding: number[]}>} items
 * @returns {number} Number of stored embeddings
 */
export function storeEmbeddingBatch(items) {
  return runTransaction(() => {
    let count = 0;
    for (const item of items) {
      storeEmbedding(item.refType, item.refId, item.embedding);
      count++;
    }
    return count;
  });
}

/**
 * Get embedding by reference
 * @param {string} refType - Reference type
 * @param {string} refId - Reference ID
 * @returns {number[]|null} Embedding vector or null
 */
export function getEmbedding(refType, refId) {
  const row = db.prepare(`
    SELECT embedding_json FROM embeddings WHERE ref_type = ? AND ref_id = ?
  `).get(refType, String(refId));

  return row ? safeJson(row.embedding_json, null) : null;
}

/**
 * Get all embeddings of a specific type
 * @param {string} refType - Reference type
 * @returns {Array<{refId: string, embedding: number[]}>}
 */
export function getAllEmbeddings(refType) {
  const rows = db.prepare(`
    SELECT ref_id, embedding_json FROM embeddings WHERE ref_type = ?
  `).all(refType);

  return rows.map(r => ({
    refId: r.ref_id,
    embedding: safeJson(r.embedding_json, [])
  }));
}

/**
 * Delete embedding by reference
 * @param {string} refType - Reference type
 * @param {string} refId - Reference ID
 * @returns {boolean} Whether deletion occurred
 */
export function deleteEmbedding(refType, refId) {
  const result = db.prepare(`
    DELETE FROM embeddings WHERE ref_type = ? AND ref_id = ?
  `).run(refType, String(refId));

  return result.changes > 0;
}

/**
 * Search embeddings by vector similarity
 * @param {string} refType - Reference type to search
 * @param {number[]} queryVector - Query embedding
 * @param {number} topK - Number of results
 * @param {number} threshold - Minimum similarity threshold
 * @returns {Array<{refId: string, similarity: number}>}
 */
export function searchBySimilarity(refType, queryVector, topK = 10, threshold = 0.5) {
  const embeddings = getAllEmbeddings(refType);

  const results = [];
  for (const item of embeddings) {
    const similarity = cosineSimilarity(queryVector, item.embedding);
    if (similarity >= threshold) {
      results.push({
        refId: item.refId,
        similarity
      });
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, topK);
}

/**
 * Search nodes by vector similarity
 * @param {number[]} queryVector - Query embedding
 * @param {number} topK - Number of results
 * @param {number} threshold - Minimum similarity threshold
 * @returns {Array<{nodeId: string, similarity: number, node: object}>}
 */
export function searchNodesBySimilarity(queryVector, topK = 10, threshold = 0.5) {
  const results = searchBySimilarity("node", queryVector, topK, threshold);

  // Enrich with node data
  if (results.length === 0) return [];

  const nodeIds = results.map(r => r.refId);
  const placeholders = nodeIds.map(() => "?").join(",");

  const nodes = db.prepare(`
    SELECT * FROM nodes WHERE node_id IN (${placeholders})
  `).all(...nodeIds);

  const nodeMap = new Map(nodes.map(n => [n.node_id, n]));

  return results.map(r => ({
    nodeId: r.refId,
    similarity: r.similarity,
    node: nodeMap.get(r.refId) ? {
      node_id: nodeMap.get(r.refId).node_id,
      name: nodeMap.get(r.refId).name,
      parent_id: nodeMap.get(r.refId).parent_id,
      level: nodeMap.get(r.refId).level,
      node_summary: nodeMap.get(r.refId).node_summary,
      scope_json: safeJson(nodeMap.get(r.refId).scope_json, {})
    } : null
  })).filter(r => r.node);
}

/**
 * Search chunks by vector similarity
 * @param {number[]} queryVector - Query embedding
 * @param {number} topK - Number of results
 * @param {number} threshold - Minimum similarity threshold
 * @returns {Array<{chunkId: number, similarity: number, chunk: object}>}
 */
export function searchChunksBySimilarity(queryVector, topK = 10, threshold = 0.5) {
  const results = searchBySimilarity("chunk", queryVector, topK, threshold);

  if (results.length === 0) return [];

  const chunkIds = results.map(r => parseInt(r.refId));
  const placeholders = chunkIds.map(() => "?").join(",");

  const chunks = db.prepare(`
    SELECT * FROM chunks WHERE id IN (${placeholders}) AND status = 'active'
  `).all(...chunkIds);

  const chunkMap = new Map(chunks.map(c => [c.id, c]));

  return results.map(r => ({
    chunkId: parseInt(r.refId),
    similarity: r.similarity,
    chunk: chunkMap.get(parseInt(r.refId)) ? {
      id: chunkMap.get(parseInt(r.refId)).id,
      doc_title: chunkMap.get(parseInt(r.refId)).doc_title,
      content: chunkMap.get(parseInt(r.refId)).content_clean,
      node_id: chunkMap.get(parseInt(r.refId)).node_id,
      authority_level: chunkMap.get(parseInt(r.refId)).authority_level
    } : null
  })).filter(r => r.chunk);
}

/**
 * Get embedding statistics
 * @returns {object} Statistics
 */
export function getEmbeddingStats() {
  const stats = db.prepare(`
    SELECT ref_type, COUNT(*) as count
    FROM embeddings
    GROUP BY ref_type
  `).all();

  const total = db.prepare(`SELECT COUNT(*) as total FROM embeddings`).get();

  return {
    total: total.total,
    by_type: stats.reduce((acc, s) => ({ ...acc, [s.ref_type]: s.count }), {})
  };
}

/**
 * Check if embedding exists
 * @param {string} refType - Reference type
 * @param {string} refId - Reference ID
 * @returns {boolean}
 */
export function hasEmbedding(refType, refId) {
  const row = db.prepare(`
    SELECT 1 FROM embeddings WHERE ref_type = ? AND ref_id = ? LIMIT 1
  `).get(refType, String(refId));

  return !!row;
}

/**
 * Get embeddings that need to be generated (nodes/chunks without embeddings)
 * @param {string} refType - "node" or "chunk"
 * @param {number} limit - Maximum number to return
 * @returns {Array<{refId: string, text: string}>}
 */
export function getPendingEmbeddings(refType, limit = 100) {
  if (refType === "node") {
    const rows = db.prepare(`
      SELECT n.node_id as ref_id, n.name || ' ' || COALESCE(n.node_summary, '') as text
      FROM nodes n
      LEFT JOIN embeddings e ON e.ref_type = 'node' AND e.ref_id = n.node_id
      WHERE e.id IS NULL
      LIMIT ?
    `).all(limit);

    return rows;
  }

  if (refType === "chunk") {
    const rows = db.prepare(`
      SELECT c.id as ref_id, c.content_clean as text
      FROM chunks c
      LEFT JOIN embeddings e ON e.ref_type = 'chunk' AND e.ref_id = CAST(c.id AS TEXT)
      WHERE e.id IS NULL AND c.status = 'active'
      LIMIT ?
    `).all(limit);

    return rows.map(r => ({ refId: String(r.ref_id), text: r.text }));
  }

  return [];
}
