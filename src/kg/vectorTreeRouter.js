/**
 * Vector-based Tree Router
 *
 * Uses cosine similarity of node embeddings to score relevance,
 * bridging the vocabulary gap (especially for CJK queries) at
 * near-keyword speed (~0.3s vs ~14s for LLM routing).
 *
 * Cache is keyed by dataset ID so multi-dataset switching is safe.
 */

import { cosineSimilarity } from "../embedding/embedder.js";
import { getAllEmbeddings } from "../embedding/vectorStore.js";
import { getActiveDatasetId } from "../db/activeDb.js";
import { queryLogger as logger } from "../utils/logger.js";

// ── In-memory embedding cache (per dataset) ─────────────────────────────────

// Map<datasetId, Map<nodeId, Float64Array>>
const _cacheByDataset = new Map();

/**
 * Load all node embeddings for the current dataset into memory.
 * Called lazily on first vectorScoreNodes() call per dataset.
 */
function _loadForDataset(datasetId) {
  const rows = getAllEmbeddings("node");
  const embMap = new Map();
  for (const row of rows) {
    if (row.embedding && row.embedding.length > 0) {
      embMap.set(row.refId, Float64Array.from(row.embedding));
    }
  }
  _cacheByDataset.set(datasetId, embMap);
  logger.info(`[vector_routing] Loaded ${embMap.size} node embeddings for dataset ${datasetId || 'default'}`);
  return embMap;
}

/**
 * Get (or lazily load) the embedding map for the current dataset.
 */
function _getEmbeddings() {
  const dsId = getActiveDatasetId() || '__default__';
  if (_cacheByDataset.has(dsId)) return _cacheByDataset.get(dsId);
  return _loadForDataset(dsId);
}

/**
 * Invalidate the cache. If datasetId is given, only that dataset;
 * otherwise invalidate all datasets (e.g. after bulk operations).
 */
export function invalidateVectorCache(datasetId = null) {
  if (datasetId) {
    _cacheByDataset.delete(datasetId);
    logger.debug(`[vector_routing] Cache invalidated for dataset ${datasetId}`);
  } else {
    _cacheByDataset.clear();
    logger.debug("[vector_routing] Cache invalidated (all datasets)");
  }
}

/**
 * Score candidate nodes by cosine similarity to the query embedding.
 *
 * @param {number[]} queryEmbedding - Pre-computed query embedding vector
 * @param {Array<{node_id: string}>} candidateNodes - Nodes to score
 * @returns {Map<string, {score: number}>}
 *   score is 0-2.0 (matching LLM/keyword score range)
 */
export function vectorScoreNodes(queryEmbedding, candidateNodes) {
  if (!queryEmbedding || !candidateNodes?.length) return new Map();

  const nodeEmbeddings = _getEmbeddings();

  const result = new Map();
  let hits = 0;

  for (const node of candidateNodes) {
    const nodeEmb = nodeEmbeddings.get(node.node_id);
    if (!nodeEmb) continue; // No embedding — skip (falls back to keyword)

    if (nodeEmb.length !== queryEmbedding.length) {
      if (hits === 0) {
        logger.warn(`[vector_routing] Dimension mismatch: query=${queryEmbedding.length} vs node=${nodeEmb.length} — embeddings may need regeneration`);
      }
      continue;
    }

    const similarity = cosineSimilarity(queryEmbedding, nodeEmb);
    if (similarity > 0) {
      // Normalize cosine similarity (0-1) to 0-2.0 range to match LLM score range
      result.set(node.node_id, { score: similarity * 2.0 });
      hits++;
    }
  }

  if (hits > 0) {
    logger.info(`[vector_routing] Scored ${hits}/${candidateNodes.length} nodes`);
  } else {
    logger.debug("[vector_routing] No embeddings matched any candidates");
  }

  return result;
}
