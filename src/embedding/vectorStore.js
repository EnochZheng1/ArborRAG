import { safeJson, runTransaction } from "../db/db.js";
import { EmbeddingRepo } from "../db/repositories/EmbeddingRepo.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { cosineSimilarity, getEmbeddingModel, getEmbeddingDimension } from "./embedder.js";

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
  const expectedDim = getEmbeddingDimension();
  if (Array.isArray(embedding) && embedding.length !== expectedDim) {
    throw new Error(`Embedding dimension mismatch: got ${embedding.length}, expected ${expectedDim} for ${refType}:${refId}`);
  }
  const model = getEmbeddingModel();
  const embeddingJson = JSON.stringify(embedding);

  const existing = EmbeddingRepo.findByRef(refType, refId);
  if (existing) {
    EmbeddingRepo.update(existing.id, embeddingJson, model);
    return existing.id;
  }

  const result = EmbeddingRepo.insert({ refType, refId, embeddingJson, model });
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
  const row = EmbeddingRepo.getJson(refType, refId);
  return row ? safeJson(row.embedding_json, null) : null;
}

/**
 * Get all embeddings of a specific type
 * @param {string} refType - Reference type
 * @returns {Array<{refId: string, embedding: number[]}>}
 */
export function getAllEmbeddings(refType) {
  return EmbeddingRepo.getAllJson(refType).map(r => ({
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
  return EmbeddingRepo.deleteByRef(refType, refId).changes > 0;
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
  const nodes = EmbeddingRepo.getNodesByIds(nodeIds);

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
  const chunks = ChunkRepo.getByIds(chunkIds);

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
  return {
    total: EmbeddingRepo.getTotal(),
    by_type: EmbeddingRepo.getStatsByType().reduce((acc, s) => ({ ...acc, [s.ref_type]: s.count }), {})
  };
}

/**
 * Check if embedding exists
 * @param {string} refType - Reference type
 * @param {string} refId - Reference ID
 * @returns {boolean}
 */
export function hasEmbedding(refType, refId) {
  return EmbeddingRepo.existsByRef(refType, refId);
}

/**
 * Get embeddings that need to be generated (nodes/chunks without embeddings)
 * @param {string} refType - "node" or "chunk"
 * @param {number} limit - Maximum number to return
 * @returns {Array<{refId: string, text: string}>}
 */
export function getPendingEmbeddings(refType, limit = 100) {
  if (refType === "node") return EmbeddingRepo.getPendingNodes(limit);
  if (refType === "chunk") return EmbeddingRepo.getPendingChunks(limit);
  return [];
}
