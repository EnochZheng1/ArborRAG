/**
 * EDIT Action — find and update existing knowledge.
 *
 * Two-phase: findEditTargets() returns candidates,
 * executeEdit() applies the change after confirmation.
 */

import { ChunkRepo } from "../../db/repositories/ChunkRepo.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { getPathToNode } from "../../kg/graphTraversal.js";
import { logAudit, runTransaction } from "../../db/db.js";
import { logger } from "../../utils/logger.js";
import { embedNewChunk } from "../../embedding/chunkEmbeddings.js";
import { invalidateVectorCache } from "../../kg/vectorTreeRouter.js";

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
 * Find chunks that match the edit target description.
 * @param {string} targetDescription - What the user wants to edit
 * @param {string} oldValue - Specific old value to match (optional)
 * @returns {{ matches: Array<{ chunk: object, node: object, nodePath: string[], score: number }> }}
 */
export function findEditTargets(targetDescription, oldValue) {
  const matches = [];

  // Strategy 1: BM25 search
  const safeQuery = sanitizeFts(targetDescription + (oldValue ? " " + oldValue : ""));
  if (safeQuery) {
    try {
      const bm25Results = ChunkRepo.bm25Search(safeQuery, 10);
      for (const r of bm25Results) {
        matches.push({
          chunk: r,
          score: r.bm25_score || 1.0,
          source: "bm25"
        });
      }
    } catch (err) {
      logger.debug(`[manage:edit] BM25 search failed: ${err.message}`);
    }
  }

  // Strategy 2: LIKE search for exact old_value match
  if (oldValue && oldValue.trim()) {
    try {
      const terms = oldValue.split(/\s+/).filter(t => t.length >= 2).slice(0, 5);
      if (terms.length) {
        const likeResults = ChunkRepo.simpleContentSearch(terms, 10);
        for (const r of likeResults) {
          // Only add if not already in matches
          if (!matches.some(m => m.chunk.id === r.id)) {
            matches.push({ chunk: r, score: 0.5, source: "like" });
          }
        }
      }
    } catch (err) {
      logger.debug(`[manage:edit] LIKE search failed: ${err.message}`);
    }
  }

  // If oldValue provided, boost chunks that actually contain it
  if (oldValue && oldValue.trim()) {
    const oldLower = oldValue.toLowerCase();
    for (const m of matches) {
      const content = (m.chunk.content_clean || "").toLowerCase();
      if (content.includes(oldLower)) {
        m.score += 2.0; // Strong boost for exact substring match
      }
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  // Enrich with node info
  const enriched = matches.slice(0, 5).map(m => {
    const node = m.chunk.node_id ? NodeRepo.findById(m.chunk.node_id) : null;
    const nodePath = m.chunk.node_id ? getPathToNode(m.chunk.node_id).map(n => n.name) : [];
    return {
      chunk: m.chunk,
      node,
      nodePath,
      score: m.score
    };
  });

  return { matches: enriched };
}

/**
 * Execute an edit on a confirmed chunk.
 * @param {number} chunkId - Chunk to edit
 * @param {string} newContent - New content text
 * @returns {{ success: boolean, before: string, after: string, nodeId: string }}
 */
export async function executeEdit(chunkId, newContent) {
  const chunk = ChunkRepo.getById(chunkId);
  if (!chunk) {
    return { success: false, message: "Chunk not found. It may have been deleted." };
  }

  const before = chunk.content_clean;

  runTransaction(() => {
    ChunkRepo.updateContent(chunkId, newContent);
    if (chunk.node_id) NodeRepo.touch(chunk.node_id);
    logAudit("chatbot_edit", "chunks", chunkId,
      { content_clean: before, node_id: chunk.node_id },
      { content_clean: newContent, node_id: chunk.node_id }
    );
  });

  // Auto-embed updated chunk
  try {
    await embedNewChunk(chunkId);
    invalidateVectorCache();
  } catch (e) {
    logger.warn(`[manage:edit] Auto-embed failed (non-fatal): ${e.message}`);
  }

  const nodePath = chunk.node_id ? getPathToNode(chunk.node_id).map(n => n.name) : [];
  logger.info(`[manage:edit] Edited chunk ${chunkId} in node ${chunk.node_id}`);

  return {
    success: true,
    chunkId,
    before,
    after: newContent,
    nodeId: chunk.node_id,
    nodePath
  };
}
