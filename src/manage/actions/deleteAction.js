/**
 * DELETE Action — find and remove knowledge after confirmation.
 */

import { ChunkRepo } from "../../db/repositories/ChunkRepo.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { getPathToNode } from "../../kg/graphTraversal.js";
import { logAudit, runTransaction } from "../../db/db.js";
import { logger } from "../../utils/logger.js";

/**
 * Sanitize text for FTS5 MATCH query.
 */
function sanitizeFts(text) {
  return text
    .slice(0, 500)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find chunks matching the delete target.
 * @param {string} targetDescription - What the user wants to delete
 * @returns {{ matches: Array }}
 */
export function findDeleteTargets(targetDescription) {
  const matches = [];

  const safeQuery = sanitizeFts(targetDescription);
  if (safeQuery) {
    try {
      const results = ChunkRepo.bm25Search(safeQuery, 10);
      for (const r of results) {
        matches.push({ chunk: r, score: r.bm25_score || 1.0 });
      }
    } catch (err) {
      logger.debug(`[manage:delete] BM25 search failed: ${err.message}`);
    }
  }

  // Fallback: LIKE search
  if (!matches.length) {
    try {
      const terms = targetDescription.split(/\s+/).filter(t => t.length >= 2).slice(0, 5);
      if (terms.length) {
        const likeResults = ChunkRepo.simpleContentSearch(terms, 10);
        for (const r of likeResults) {
          matches.push({ chunk: r, score: 0.5 });
        }
      }
    } catch (err) {
      logger.debug(`[manage:delete] LIKE search failed: ${err.message}`);
    }
  }

  matches.sort((a, b) => b.score - a.score);

  const enriched = matches.slice(0, 5).map(m => {
    const node = m.chunk.node_id ? NodeRepo.findById(m.chunk.node_id) : null;
    const nodePath = m.chunk.node_id ? getPathToNode(m.chunk.node_id).map(n => n.name) : [];
    return { chunk: m.chunk, node, nodePath, score: m.score };
  });

  return { matches: enriched };
}

/**
 * Execute deletion of a confirmed chunk.
 * @param {number} chunkId - Chunk to delete
 * @returns {{ success: boolean, deletedChunk: object, nodeId: string }}
 */
export function executeDelete(chunkId) {
  const chunk = ChunkRepo.getById(chunkId);
  if (!chunk) {
    return { success: false, message: "Chunk not found. It may have already been deleted." };
  }

  // Snapshot the full chunk for undo capability
  const snapshot = { ...chunk };
  const nodePath = chunk.node_id ? getPathToNode(chunk.node_id).map(n => n.name) : [];

  runTransaction(() => {
    logAudit("chatbot_delete", "chunks", chunkId, snapshot, null);
    ChunkRepo.deleteById(chunkId);
    if (chunk.node_id) NodeRepo.touch(chunk.node_id);
  });

  logger.info(`[manage:delete] Deleted chunk ${chunkId} from node ${chunk.node_id}`);

  return {
    success: true,
    chunkId,
    deletedContent: chunk.content_clean,
    nodeId: chunk.node_id,
    nodePath
  };
}
