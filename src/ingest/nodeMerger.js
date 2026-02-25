/**
 * Node Merger
 *
 * Detects topically-duplicate sibling nodes (e.g. "Sales Process" and
 * "Sales Procedures") and either merges them automatically or queues a
 * merge suggestion for human review.
 *
 * Called from:
 *  - buildTopicalHierarchy (nodeMapper.js) after domain nodes are created
 *  - runCleanupJob (cleanupJob.js) for retroactive cleanup
 */

import { db } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { DecisionRepo } from "../db/repositories/DecisionRepo.js";
import { wordDiceSimilarity } from "./knowledgeExtractor.js";
import { runTransaction } from "../db/db.js";
import { ingestLogger as logger } from "../utils/logger.js";

const NAME_MERGE_THRESHOLD    = 0.60;  // node name Dice similarity
const CONTENT_MERGE_THRESHOLD = 0.50;  // avg KP content overlap

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Average pairwise Dice similarity between KP content of two nodes.
 * Samples up to 5 KPs from each node to keep it fast.
 */
function avgKPContentOverlap(nodeAId, nodeBId) {
  const kpsA = ChunkRepo.getForNodeLimited(nodeAId, 5);
  const kpsB = ChunkRepo.getForNodeLimited(nodeBId, 5);
  if (!kpsA.length || !kpsB.length) return 0;

  let total = 0;
  let pairs = 0;
  for (const a of kpsA) {
    for (const b of kpsB) {
      total += wordDiceSimilarity(a.content_clean || "", b.content_clean || "");
      pairs++;
    }
  }
  return pairs > 0 ? total / pairs : 0;
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Find sibling nodes that likely cover the same topic as the given node.
 *
 * @param {string} nodeId - The node to check
 * @param {object} options
 * @param {boolean} options.useLLM       - (reserved for future LLM name check)
 * @param {boolean} options.autoApprove  - If true, candidates are returned but NOT queued
 * @returns {Array<{ nodeId, name, nameSim, contentSim, reason }>}
 */
export async function findMergeCandidates(nodeId, options = {}) {
  const node = NodeRepo.findById(nodeId);
  if (!node) return [];

  // Gather siblings (same parent)
  const siblings = node.parent_id
    ? NodeRepo.findSiblings(node.parent_id, nodeId)
    : NodeRepo.findRootSiblings(nodeId);

  const candidates = [];

  for (const sibling of siblings) {
    const nameSim = wordDiceSimilarity(node.name, sibling.name);

    if (nameSim >= NAME_MERGE_THRESHOLD) {
      candidates.push({ nodeId: sibling.node_id, name: sibling.name, nameSim, contentSim: null,
                        reason: `name similarity ${nameSim.toFixed(2)} ≥ ${NAME_MERGE_THRESHOLD}` });
      continue;
    }

    // Lighter check: average KP content overlap (only if name is somewhat related)
    if (nameSim >= 0.25) {
      const contentSim = avgKPContentOverlap(nodeId, sibling.node_id);
      if (contentSim >= CONTENT_MERGE_THRESHOLD) {
        candidates.push({ nodeId: sibling.node_id, name: sibling.name, nameSim, contentSim,
                          reason: `content overlap ${contentSim.toFixed(2)} ≥ ${CONTENT_MERGE_THRESHOLD}` });
      }
    }
  }

  return candidates;
}

/**
 * Queue a node_merge_suggestion for human review.
 *
 * @param {string} sourceNodeId - Node to be merged away (source, usually lower-chunk-count)
 * @param {string} targetNodeId - Node to keep
 * @param {object} options      - { nameSim, contentSim }
 * @returns {number} pending_decision id
 */
export function queueNodeMergeSuggestion(sourceNodeId, targetNodeId, options = {}) {
  const sourceNode = NodeRepo.findById(sourceNodeId);
  const targetNode = NodeRepo.findById(targetNodeId);
  if (!sourceNode || !targetNode) return null;

  const result = DecisionRepo.insert({
    action:           "node_merge_suggestion",
    incoming_chunk_id: null,
    target_chunk_id:   null,
    node_id:           targetNodeId,
    confidence:        options.nameSim ?? options.contentSim ?? null,
    reason:            `Node "${sourceNode.name}" may duplicate "${targetNode.name}": ${options.reason || ""}`,
    similarity_score:  options.nameSim ?? null,
    incoming_preview:  `node:${sourceNodeId} "${sourceNode.name}"`,
    target_preview:    `node:${targetNodeId} "${targetNode.name}"`
  });

  logger.info(`Queued node_merge_suggestion: "${sourceNode.name}" → "${targetNode.name}"`);
  return Number(result.lastInsertRowid);
}

/**
 * Execute a node merge: move all chunks and children from sourceNodeId
 * into targetNodeId, then delete sourceNode.
 *
 * This is destructive — call only after human approval or with autoApprove=true
 * for high-confidence automated cases.
 *
 * @param {string} sourceNodeId
 * @param {string} targetNodeId
 * @returns {{ chunksMovedCount: number, childrenMovedCount: number }}
 */
export function executeMerge(sourceNodeId, targetNodeId) {
  return runTransaction(() => {
    // Move chunks
    const chunkResult = db.prepare(
      "UPDATE chunks SET node_id = ? WHERE node_id = ?"
    ).run(targetNodeId, sourceNodeId);

    // Re-parent children
    const childResult = db.prepare(
      "UPDATE nodes SET parent_id = ? WHERE parent_id = ?"
    ).run(targetNodeId, sourceNodeId);

    // Delete source node FTS entry
    NodeRepo.deleteFtsForNode(sourceNodeId);

    // Delete source node
    db.prepare("DELETE FROM nodes WHERE node_id = ?").run(sourceNodeId);

    // Touch target
    NodeRepo.touch(targetNodeId);

    logger.info(`Merged node ${sourceNodeId} into ${targetNodeId}: ${chunkResult.changes} chunks moved, ${childResult.changes} children re-parented`);

    return {
      chunksMovedCount:   chunkResult.changes,
      childrenMovedCount: childResult.changes
    };
  });
}
