import { db } from "../db/db.js";
import { generateEmbedding, generateEmbeddingBatch } from "./embedder.js";
import { storeEmbedding, storeEmbeddingBatch, getPendingEmbeddings, hasEmbedding } from "./vectorStore.js";
import { embedLogger as logger } from "../utils/logger.js";

/**
 * Chunk and node embedding management
 */

/**
 * Generate and store embedding for a single node
 * @param {string} nodeId - Node ID
 * @returns {Promise<boolean>} Success
 */
export async function embedNode(nodeId) {
  const node = db.prepare(`
    SELECT node_id, name, node_summary FROM nodes WHERE node_id = ?
  `).get(nodeId);

  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  const text = `${node.name} ${node.node_summary || ""}`.trim();

  if (!text) {
    logger.warn(`Node ${nodeId} has no text to embed`);
    return false;
  }

  const embedding = await generateEmbedding(text);
  storeEmbedding("node", nodeId, embedding);

  return true;
}

/**
 * Generate and store embedding for a single chunk
 * @param {number} chunkId - Chunk ID
 * @returns {Promise<boolean>} Success
 */
export async function embedChunk(chunkId) {
  const chunk = db.prepare(`
    SELECT id, content_clean FROM chunks WHERE id = ? AND status = 'active'
  `).get(chunkId);

  if (!chunk) {
    throw new Error(`Chunk not found or inactive: ${chunkId}`);
  }

  if (!chunk.content_clean || chunk.content_clean.trim().length === 0) {
    logger.warn(`Chunk ${chunkId} has no content to embed`);
    return false;
  }

  const embedding = await generateEmbedding(chunk.content_clean);
  storeEmbedding("chunk", String(chunkId), embedding);

  return true;
}

/**
 * Embed all nodes that don't have embeddings
 * @param {object} options - Options
 * @returns {Promise<object>} Results
 */
export async function embedAllNodes(options = {}) {
  const { batchSize = 50, onProgress = null } = options;

  const results = {
    total: 0,
    success: 0,
    failed: 0,
    errors: []
  };

  let pending = getPendingEmbeddings("node", batchSize);

  while (pending.length > 0) {
    results.total += pending.length;

    const texts = pending.map(p => p.text);
    const embeddings = await generateEmbeddingBatch(texts);

    const toStore = [];
    for (let i = 0; i < pending.length; i++) {
      if (embeddings[i]) {
        toStore.push({
          refType: "node",
          refId: pending[i].ref_id,
          embedding: embeddings[i]
        });
        results.success++;
      } else {
        results.failed++;
        results.errors.push(`Failed to embed node: ${pending[i].ref_id}`);
      }
    }

    if (toStore.length > 0) {
      storeEmbeddingBatch(toStore);
    }

    if (onProgress) {
      onProgress(results.success, results.total);
    }

    pending = getPendingEmbeddings("node", batchSize);
  }

  return results;
}

/**
 * Embed all chunks that don't have embeddings
 * @param {object} options - Options
 * @returns {Promise<object>} Results
 */
export async function embedAllChunks(options = {}) {
  const { batchSize = 50, onProgress = null } = options;

  const results = {
    total: 0,
    success: 0,
    failed: 0,
    errors: []
  };

  let pending = getPendingEmbeddings("chunk", batchSize);

  while (pending.length > 0) {
    results.total += pending.length;

    const texts = pending.map(p => p.text);
    const embeddings = await generateEmbeddingBatch(texts);

    const toStore = [];
    for (let i = 0; i < pending.length; i++) {
      if (embeddings[i]) {
        toStore.push({
          refType: "chunk",
          refId: pending[i].refId,
          embedding: embeddings[i]
        });
        results.success++;
      } else {
        results.failed++;
        results.errors.push(`Failed to embed chunk: ${pending[i].refId}`);
      }
    }

    if (toStore.length > 0) {
      storeEmbeddingBatch(toStore);
    }

    if (onProgress) {
      onProgress(results.success, results.total);
    }

    pending = getPendingEmbeddings("chunk", batchSize);
  }

  return results;
}

/**
 * Embed a newly created chunk (called after chunk insertion)
 * @param {number} chunkId - Chunk ID
 * @returns {Promise<boolean>} Success
 */
export async function embedNewChunk(chunkId) {
  try {
    await embedChunk(chunkId);
    return true;
  } catch (err) {
    logger.error(`Failed to embed new chunk ${chunkId}:`, err.message);
    return false;
  }
}

/**
 * Re-embed a node when its content changes
 * @param {string} nodeId - Node ID
 * @returns {Promise<boolean>} Success
 */
export async function reembedNode(nodeId) {
  try {
    await embedNode(nodeId);
    return true;
  } catch (err) {
    logger.error(`Failed to re-embed node ${nodeId}:`, err.message);
    return false;
  }
}

/**
 * Check embedding coverage
 * @returns {object} Coverage statistics
 */
export function getEmbeddingCoverage() {
  const nodeStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM nodes) as total_nodes,
      (SELECT COUNT(*) FROM embeddings WHERE ref_type = 'node') as embedded_nodes
  `).get();

  const chunkStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM chunks WHERE status = 'active') as total_chunks,
      (SELECT COUNT(*) FROM embeddings WHERE ref_type = 'chunk') as embedded_chunks
  `).get();

  return {
    nodes: {
      total: nodeStats.total_nodes,
      embedded: nodeStats.embedded_nodes,
      coverage: nodeStats.total_nodes > 0
        ? (nodeStats.embedded_nodes / nodeStats.total_nodes * 100).toFixed(1) + "%"
        : "N/A"
    },
    chunks: {
      total: chunkStats.total_chunks,
      embedded: chunkStats.embedded_chunks,
      coverage: chunkStats.total_chunks > 0
        ? (chunkStats.embedded_chunks / chunkStats.total_chunks * 100).toFixed(1) + "%"
        : "N/A"
    }
  };
}

/**
 * Sync embeddings - embed any missing nodes/chunks
 * @returns {Promise<object>} Sync results
 */
export async function syncEmbeddings() {
  logger.info("Starting embedding sync...");

  const nodeResults = await embedAllNodes({
    onProgress: (done, total) => logger.debug(`Nodes: ${done}/${total}`)
  });

  const chunkResults = await embedAllChunks({
    onProgress: (done, total) => logger.debug(`Chunks: ${done}/${total}`)
  });

  logger.info(`Embedding sync complete: ${nodeResults.success} nodes, ${chunkResults.success} chunks`);

  return {
    nodes: nodeResults,
    chunks: chunkResults,
    coverage: getEmbeddingCoverage()
  };
}
