/**
 * ADD Action — insert new knowledge into the tree.
 *
 * Reuses ingestion pipeline functions for tree placement and duplicate detection.
 * No confirmation required (non-destructive; user can undo).
 */

import { findOrCreateTopicNode, assignKPToNode } from "../../ingest/kpNormaliser.js";
import { ensureRootNode, generateNodeId } from "../../ingest/nodeHierarchy.js";
import { resolveKPAction } from "../../ingest/kpDecisionEngine.js";
import { getPathToNode, getRootNodes } from "../../kg/graphTraversal.js";
import { wordDiceSimilarity } from "../../ingest/knowledgeExtractor.js";
import { createNode } from "../../ingest/nodeMapper.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { logAudit } from "../../db/db.js";
import { logger } from "../../utils/logger.js";
import { embedNewChunk, reembedNode } from "../../embedding/chunkEmbeddings.js";
import { invalidateVectorCache } from "../../kg/vectorTreeRouter.js";

/**
 * Execute an ADD operation.
 * @param {string} content - The knowledge statement to add
 * @param {string} topicHint - Suggested topic for tree placement
 * @param {string} subtopicHint - Optional subtopic
 * @param {object} session - Current chat session
 * @returns {Promise<object>} Result with chunkId, nodeId, nodePath, etc.
 */
export async function executeAdd(content, topicHint, subtopicHint, session) {
  if (!content || content.trim().length < 10) {
    return { success: false, message: "Content is too short. Please provide a more complete statement." };
  }

  // 1. Ensure tree has at least a root
  const roots = getRootNodes();
  if (!roots.length) {
    ensureRootNode();
  }

  // 2. Find or create the topic node
  const effectiveTopic = topicHint || "General";
  let targetNodeId;
  let isNewNode = false;

  try {
    const result = await findOrCreateTopicNode(effectiveTopic, "root", {});
    targetNodeId = result.node_id;
    isNewNode = result._created || false;

    // Guard: if findOrCreateTopicNode reused an existing node by fuzzy match,
    // verify the match is actually close enough. A vague topic like "Helport"
    // can falsely match "Helport office location" (Dice 0.50) when the content
    // is about products. If the name is different and similarity is below 0.6,
    // create a separate node with the exact topic name.
    if (!isNewNode && targetNodeId !== "root") {
      const matchedName = (result.name || "").toLowerCase().trim();
      const requestedTopic = effectiveTopic.toLowerCase().trim();
      if (matchedName !== requestedTopic) {
        const nameSim = wordDiceSimilarity(requestedTopic, matchedName);
        if (nameSim < 0.6) {
          logger.info(`[manage:add] Fuzzy match "${result.name}" (score=${nameSim.toFixed(2)}) too loose for "${effectiveTopic}", creating new node`);
          try {
            const newNode = createNode({
              node_id: generateNodeId(effectiveTopic),
              name: effectiveTopic,
              parent_id: "root"
            });
            targetNodeId = newNode.node_id;
            isNewNode = true;
          } catch (createErr) {
            // If node already exists (race / collision), keep the fuzzy match
            logger.debug(`[manage:add] Force-create failed: ${createErr.message}, keeping fuzzy match`);
          }
        }
      }
    }
  } catch (err) {
    logger.warn(`[manage:add] findOrCreateTopicNode failed: ${err.message}`);
    // Fallback: use root node
    const rootNode = NodeRepo.findRoots()[0];
    targetNodeId = rootNode?.node_id || "root";
  }

  // 3. If subtopic provided, create/find subtopic node under topic
  if (subtopicHint && subtopicHint.trim()) {
    try {
      const subResult = await findOrCreateTopicNode(subtopicHint, targetNodeId, {});
      targetNodeId = subResult.node_id;
      isNewNode = isNewNode || subResult._created || false;
    } catch (err) {
      logger.debug(`[manage:add] Subtopic creation skipped: ${err.message}`);
    }
  }

  // 4. Check for duplicates via decision engine
  const kp = {
    content,
    doc_title: "Manual Entry",
    kp_type: "fact",
    chunk_type: "fact",
    authority_level: "sop",
    keywords: [],
    source_excerpt: "",
    source_documents_json: "[]",
    index: 0,
    confidence: 0.95
  };

  try {
    const decision = await resolveKPAction(kp, targetNodeId, null, { useLLM: false });

    if (decision.action === "IGNORE") {
      return {
        success: false,
        message: "This information appears to be a duplicate of existing content.",
        existingChunkId: decision.chunkId || null
      };
    }

    if (decision.action === "MERGE") {
      return {
        success: false,
        message: "Very similar information already exists in the knowledge base.",
        existingChunkId: decision.chunkId || null
      };
    }
  } catch (err) {
    logger.debug(`[manage:add] Decision engine skipped: ${err.message}`);
    // Proceed with STORE if decision engine fails
  }

  // 5. Insert the chunk (assignKPToNode handles chunk + FTS + audit internally)
  const chunkId = assignKPToNode(kp, targetNodeId, null);

  // 6. Log chatbot-specific audit entry for tracking/revert
  logAudit("chatbot_add", "chunks", chunkId, null, {
    content,
    node_id: targetNodeId,
    topic_hint: topicHint,
    user_message: session?.lastMessage || ""
  });

  // 7. Auto-embed new chunk (+ node if newly created)
  try {
    await embedNewChunk(chunkId);
    if (isNewNode) await reembedNode(targetNodeId);
    invalidateVectorCache();
  } catch (e) {
    logger.warn(`[manage:add] Auto-embed failed (non-fatal): ${e.message}`);
  }

  // 8. Build path for display
  const nodePath = getPathToNode(targetNodeId).map(n => n.name);
  const targetNode = NodeRepo.findById(targetNodeId);

  logger.info(`[manage:add] Added chunk ${chunkId} to node ${targetNodeId} (${targetNode?.name})`);

  return {
    success: true,
    chunkId,
    nodeId: targetNodeId,
    nodeName: targetNode?.name || effectiveTopic,
    nodePath,
    isNewNode,
    content
  };
}
