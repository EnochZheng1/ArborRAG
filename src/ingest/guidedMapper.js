/**
 * Guided Mapper
 *
 * When mapping_mode === 'guided', uses a pre-defined schema tree to map KPs
 * to existing nodes instead of inventing new topic names from scratch.
 *
 * Exported: buildGuidedTopicalHierarchy(kps, docTitle, documentId, schemaNodes, options)
 * Returns:  { nodeMap: Map<kpIndex, nodeId>, newNodes: [] }  — same shape as buildTopicalHierarchy
 */

import { wordDiceSimilarity } from "./knowledgeExtractor.js";
import { normalizeTopicHint, findOrCreateTopicNode } from "./kpNormaliser.js";
import { callLLM, isLlmConfigured } from "../utils/llm.js";
import { safeJson } from "../db/db.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { ensureRootNode } from "./nodeHierarchy.js";
import { getCustomPrompt } from "../prompts/promptManager.js";

// Minimum heuristic score to accept a match without LLM confirmation
const GUIDED_MATCH_THRESHOLD = 0.30;

/**
 * Score a topic string against a schema node using name, aliases, description, and keywords.
 */
function scoreTopicAgainstNode(topic, node) {
  const topicLower = topic.toLowerCase();

  const nameSim  = wordDiceSimilarity(topicLower, (node.name || "").toLowerCase());

  // Aliases boost: treat the best alias match the same as the name
  const aliases = safeJson(node.aliases_json, []);
  const aliasSim = aliases.length > 0
    ? Math.max(...aliases.map(a => wordDiceSimilarity(topicLower, String(a).toLowerCase())))
    : 0;
  const namePlusSim = Math.max(nameSim, aliasSim);

  const descSim  = wordDiceSimilarity(topicLower, (node.node_description || "").toLowerCase());

  const keywords = safeJson(node.keywords_json, []);
  const topicWords = new Set(topicLower.match(/[a-z\u4e00-\u9fa5]{2,}/g) || []);
  const kwOverlap = keywords.length === 0 ? 0
    : keywords.filter(k => topicWords.has(String(k).toLowerCase())).length / keywords.length;

  return 0.5 * namePlusSim + 0.3 * descSim + 0.2 * kwOverlap;
}

/**
 * LLM batch disambiguation for topics below the heuristic threshold.
 * One call for all ambiguous topics.
 *
 * @param {string[]} topics          - topic names needing disambiguation
 * @param {object[]} schemaNodes     - full schema node list
 * @returns {Map<string, string|null>} topic → node_id or null
 */
async function llmDisambiguate(topics, schemaNodes) {
  const result = new Map();
  if (!topics.length || !isLlmConfigured()) return result;

  const schemaLines = schemaNodes
    .map(n => {
      const aliases = safeJson(n.aliases_json, []);
      const aliasStr = aliases.length > 0 ? ` (also: ${aliases.join(', ')})` : '';
      return `- "${n.name}"${aliasStr}${n.node_description ? ': ' + n.node_description : ''}`;
    })
    .join('\n');

  const topicLines = topics.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const topicIndices = topics.map((_, i) => `${i + 1}.`).join('\n');
  const prompt = getCustomPrompt('guidedMapping', {
    schemaLines, topicLines, topicIndices
  }) ?? `You are organizing a knowledge graph with a fixed schema. Map each topic to the most appropriate schema node, or NONE if no node fits.

SCHEMA NODES:
${schemaLines}

TOPICS TO MAP:
${topicLines}

Reply with ONLY a numbered list using the exact schema node name from above or NONE:
${topicIndices}`;

  try {
    // maxOutputTokens: one line per topic (≈10 tokens each), cap at 512 to prevent runaway
    const text = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 512, taskName: 'guided_schema_mapping' });
    if (!text) return result;

    // Build name → node_id lookup (case-insensitive)
    const nameToId = new Map(schemaNodes.map(n => [n.name.toLowerCase(), n.node_id]));

    const lines = text.split('\n');
    for (let i = 0; i < topics.length; i++) {
      const line = (lines[i] || '').replace(/^\d+\.\s*/, '').trim();
      if (!line || line.toUpperCase() === 'NONE') {
        result.set(topics[i], null);
      } else {
        const nodeId = nameToId.get(line.toLowerCase()) ?? null;
        result.set(topics[i], nodeId);
        if (nodeId) {
          logger.debug(`Guided LLM mapped topic "${topics[i]}" → "${line}" (${nodeId})`);
        }
      }
    }
  } catch (err) {
    logger.warn(`Guided LLM disambiguation failed: ${err.message}`);
  }

  return result;
}

/**
 * Build node map using the pre-defined schema.
 *
 * @param {object[]} kps           - KP objects with topic_hint, index
 * @param {string}   docTitle      - document title (for logging)
 * @param {number}   documentId    - document ID
 * @param {object[]} schemaNodes   - rows from NodeRepo.findSchemaNodes()
 * @param {object}   options
 * @param {boolean}  options.useLLM
 * @param {string}   options.mappingStrictness  "soft" | "hard"
 * @returns {Promise<{ nodeMap: Map, newNodes: [] }>}
 */
/**
 * Filter schema nodes to the subtree rooted at rootNodeId (inclusive).
 */
function filterToSubtree(schemaNodes, rootNodeId) {
  const subtree = new Set([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of schemaNodes) {
      if (!subtree.has(node.node_id) && node.parent_id && subtree.has(node.parent_id)) {
        subtree.add(node.node_id);
        changed = true;
      }
    }
  }
  return schemaNodes.filter(n => subtree.has(n.node_id));
}

export async function buildGuidedTopicalHierarchy(kps, docTitle, documentId, schemaNodes, options = {}) {
  const { useLLM = true, mappingStrictness = 'soft', targetSchemaNodeId = null } = options;

  ensureRootNode();

  // Narrow schema nodes to a subtree if the user selected a schema branch at upload time
  if (targetSchemaNodeId) {
    const filtered = filterToSubtree(schemaNodes, targetSchemaNodeId);
    if (filtered.length > 0) {
      schemaNodes = filtered;
      logger.info(`Guided mapping: scoped to subtree of "${targetSchemaNodeId}" (${filtered.length} nodes)`);
    } else {
      logger.warn(`Guided mapping: targetSchemaNodeId "${targetSchemaNodeId}" not found in schema nodes, using full schema`);
    }
  }

  logger.info(`Guided mapping: ${kps.length} KPs, ${schemaNodes.length} schema nodes, strictness=${mappingStrictness}`);

  // Step 1 — Collect unique non-General topic hints
  const uniqueTopics = [
    ...new Set(kps.map(kp => normalizeTopicHint(kp.topic_hint)).filter(t => t !== 'General'))
  ];

  // Step 2 — Score each unique topic against every schema node (heuristic)
  const topicHintToNodeId = new Map(); // topic → nodeId
  const ambiguousTopics = [];          // topics below threshold needing LLM

  for (const topic of uniqueTopics) {
    let bestNodeId = null;
    let bestScore  = 0;
    let bestNode   = null;

    for (const node of schemaNodes) {
      const score = scoreTopicAgainstNode(topic, node);
      if (score > bestScore) {
        bestScore  = score;
        bestNodeId = node.node_id;
        bestNode   = node;
      }
    }

    if (bestScore >= GUIDED_MATCH_THRESHOLD) {
      topicHintToNodeId.set(topic, bestNodeId);
      logger.debug(`Guided heuristic: "${topic}" → "${bestNode.name}" (score=${bestScore.toFixed(2)})`);
    } else {
      ambiguousTopics.push({ topic, bestScore, bestNode });
    }
  }

  // Step 3 — LLM disambiguation for ambiguous topics
  if (useLLM && ambiguousTopics.length > 0) {
    const topicsToAsk = ambiguousTopics.map(a => a.topic);
    const llmResult   = await llmDisambiguate(topicsToAsk, schemaNodes);

    for (const { topic, bestNode } of ambiguousTopics) {
      const llmNodeId = llmResult.get(topic);
      if (llmNodeId) {
        topicHintToNodeId.set(topic, llmNodeId);
      } else {
        // LLM said NONE — apply strictness rule below
        topicHintToNodeId.set(topic, bestNode?.node_id ?? null);
      }
    }
  } else {
    // No LLM — use closest schema ancestor for ambiguous topics
    for (const { topic, bestNode } of ambiguousTopics) {
      topicHintToNodeId.set(topic, bestNode?.node_id ?? null);
    }
  }

  // Step 4 — Handle unmatched topics by strictness mode, create newNodes if soft
  const newNodes = [];

  for (const topic of uniqueTopics) {
    if (!topicHintToNodeId.get(topic)) {
      // Find closest schema ancestor by best heuristic score (even if below threshold)
      let closestAncestorId = 'root';
      let closestScore = 0;
      for (const node of schemaNodes) {
        const score = scoreTopicAgainstNode(topic, node);
        if (score > closestScore) {
          closestScore = score;
          closestAncestorId = node.node_id;
        }
      }

      if (mappingStrictness === 'hard') {
        // Hard mode: force assign to closest schema ancestor, no new nodes
        topicHintToNodeId.set(topic, closestAncestorId);
        logger.info(`Guided hard: unmatched topic "${topic}" clamped to ${closestAncestorId}`);
      } else {
        // Soft mode: create new child node under closest schema ancestor
        try {
          const newNode = await findOrCreateTopicNode(topic, closestAncestorId, { useLLM });
          topicHintToNodeId.set(topic, newNode.node_id);
          if (newNode._created) newNodes.push(newNode);
          logger.info(`Guided soft: new child node "${topic}" under ${closestAncestorId}`);
        } catch (err) {
          logger.warn(`Guided soft: failed to create child for "${topic}": ${err.message}`);
          topicHintToNodeId.set(topic, closestAncestorId);
        }
      }
    }
  }

  // Step 5 — Handle "General" KPs → root
  const rootNode = ensureRootNode();

  // Step 6 — Build kp.index → nodeId map
  const nodeMap = new Map();
  for (const kp of kps) {
    const topic  = normalizeTopicHint(kp.topic_hint);
    const nodeId = topic === 'General'
      ? rootNode.node_id
      : (topicHintToNodeId.get(topic) ?? rootNode.node_id);
    nodeMap.set(kp.index, nodeId);
  }

  const cleanNodes = newNodes.map(({ _created: _, ...rest }) => rest);
  return { nodeMap, newNodes: cleanNodes };
}
