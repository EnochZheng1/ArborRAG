/**
 * Vector similarity-based retrieval strategies.
 */

import { generateQueryEmbedding } from "../../embedding/embedder.js";
import { searchNodesBySimilarity, searchChunksBySimilarity } from "../../embedding/vectorStore.js";
import { queryLogger as logger } from "../../utils/logger.js";

export async function vectorRecallNodes(query, limit = 30, threshold = 0.5) {
  try {
    const queryEmbedding = await generateQueryEmbedding(query);
    return searchNodesBySimilarity(queryEmbedding, limit, threshold)
      .map(r => ({ node: r.node, similarity: r.similarity }));
  } catch (err) {
    logger.error("Vector recall error:", err.message);
    return [];
  }
}

export async function vectorRecallChunks(query, limit = 50, threshold = 0.5) {
  try {
    const queryEmbedding = await generateQueryEmbedding(query);
    return searchChunksBySimilarity(queryEmbedding, limit, threshold)
      .map(r => ({ chunk: r.chunk, similarity: r.similarity }));
  } catch (err) {
    logger.error("Vector chunk recall error:", err.message);
    return [];
  }
}
