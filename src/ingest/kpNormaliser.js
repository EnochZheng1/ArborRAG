import { runTransaction, logAudit } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { searchNodesByName } from "../kg/recallNodes.js";
import { callLLM, llmConfig } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { getPrompt, isChineseLang } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { wordDiceSimilarity } from "./knowledgeExtractor.js";
import { generateNodeId, ensureRootNode } from "./nodeHierarchy.js";

// Lowered from 0.40 → 0.35: slightly more aggressive reuse.
// Node lookup now uses a direct DB sibling scan (not BM25) so every sibling
// is considered; a lower threshold is safe because we're comparing against the
// full sibling set rather than a potentially incomplete BM25 top-10.
export const TOPIC_MATCH_THRESHOLD = 0.35;
// wordDiceSimilarity imported from knowledgeExtractor.js

// Generic/placeholder topic hints that the LLM returns when it can't classify.
// These all collapse to "General" so they don't pollute the tree with noise nodes.
export const GENERIC_TOPIC_HINTS = new Set([
  // English
  'general', 'unknown', 'other', 'content', 'information', 'document',
  'n/a', 'na', 'misc', 'miscellaneous', 'undefined', 'unclassified', 'none',
  // Chinese Simplified
  '无信息', '文档内容', '内容', '一般', '未知', '其他', '通用', '无', '一般信息', '文档', '信息',
  // Chinese Traditional
  '文件內容', '內容', '一般', '未知', '其他', '通用', '文件',
]);

export function normalizeTopicHint(hint) {
  const trimmed = (hint || '').trim();
  if (!trimmed) return 'General';
  // Match on both original casing and lowercased
  if (GENERIC_TOPIC_HINTS.has(trimmed) || GENERIC_TOPIC_HINTS.has(trimmed.toLowerCase())) {
    return 'General';
  }
  return trimmed;
}

/**
 * Internal helper: create a node record (mirrors createNode in nodeMapper.js
 * but avoids a circular import since kpNormaliser is imported by nodeMapper).
 */
function _createTopicNode(nodeData) {
  const { node_id, name, parent_id = null, level = 1, summary = "", scope = {} } = nodeData;

  if (parent_id && !NodeRepo.existsById(parent_id)) {
    throw new Error(`Parent node not found: ${parent_id}`);
  }

  let calculatedLevel = level;
  if (parent_id) {
    const parentLevel = NodeRepo.getLevel(parent_id);
    calculatedLevel = (Number(parentLevel) || 0) + 1;
  }

  return runTransaction(() => {
    NodeRepo.insert({
      node_id,
      name,
      parent_id,
      level: calculatedLevel,
      node_summary: summary,
      scope_json: JSON.stringify(scope)
    });

    NodeRepo.insertFtsText(node_id, `${name} ${summary}`);
    logAudit("create", "nodes", node_id, null, { node_id, name, parent_id, level: calculatedLevel });

    return {
      node_id,
      name,
      parent_id,
      level: calculatedLevel,
      node_summary: summary,
      scope_json: scope
    };
  });
}

/**
 * Internal helper: use LLM to confirm a borderline topic node match.
 * Mirrors the core of suggestNodeWithLLM in nodeMapper.js but kept local
 * to avoid a circular import.
 */
async function _confirmTopicMatchWithLLM(topicName, candidate) {
  if (!llmConfig[llmConfig.provider]?.apiKey) return false;

  const lang = getEffectiveLang(topicName);
  const nodeList = `1. ${candidate.node_id} - ${candidate.name}: ${candidate.node_summary || (isChineseLang(lang) ? "(无摘要)" : "(no summary)")}`;
  const prompt = getPrompt('nodeSuggestion', lang, topicName, topicName, nodeList, false);

  try {
    const text = await callLLM({ prompt, temperature: 0.0, seed: 42, taskName: 'node_suggestion' }) ?? "{}";
    const suggestion = await parseLLMJson(text, 'object', { context: 'node_suggestion', fallback: null });
    return suggestion && suggestion.confidence >= 0.65 && suggestion.selected_index === 1;
  } catch (err) {
    rethrowIfRateLimit(err);
    return false;
  }
}

/**
 * Find or create a topical node under a given parent.
 * Scans ALL direct siblings via DB (not BM25) so no sibling is silently missed,
 * then uses Dice similarity to reuse an existing node when possible.
 * Returns { ...nodeObject, _created: boolean }.
 */
export async function findOrCreateTopicNode(topicName, parentId, options = {}) {
  const { useLLM = true } = options;

  if (!topicName || topicName.trim().length === 0) {
    return { ...ensureRootNode(), _created: false };
  }

  // Scan all direct siblings in the DB — guaranteed to see every existing node
  // under this parent, unlike BM25 which only returns a capped top-N result set.
  try {
    const siblings = NodeRepo.findByParent(parentId);

    let bestMatch = null;
    let bestScore = 0;

    for (const sibling of siblings) {
      const score = wordDiceSimilarity(topicName.toLowerCase(), (sibling.name || "").toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestMatch = sibling;
      }
    }

    if (bestScore >= TOPIC_MATCH_THRESHOLD) {
      logger.debug(`Topic node reused: "${bestMatch.name}" (score=${bestScore.toFixed(2)}) for "${topicName}"`);
      return { ...bestMatch, _created: false };
    }

    // Borderline match — ask LLM to confirm
    if (useLLM && bestScore >= 0.25 && bestMatch) {
      try {
        const confirmed = await _confirmTopicMatchWithLLM(topicName, bestMatch);
        if (confirmed) {
          logger.debug(`LLM confirmed topic node reuse: "${bestMatch.name}" for "${topicName}"`);
          return { ...bestMatch, _created: false };
        }
      } catch (_) { /* non-fatal */ }
    }
  } catch (err) {
    logger.warn(`Topic node sibling scan failed for "${topicName}": ${err.message}`);
  }

  // Create new topical node
  const parentLevel = parentId ? (NodeRepo.getLevel(parentId) ?? 0) : 0;
  const node = _createTopicNode({
    node_id:   generateNodeId(topicName),
    name:      topicName,
    parent_id: parentId,
    level:     Number(parentLevel) + 1,
    summary:   ""
  });
  logger.info(`Created topical node: ${node.node_id} (${node.name}) under ${parentId || "root"}`);
  return { ...node, _created: true };
}

/**
 * Canonicalize topic hints before building the hierarchy.
 *
 * For each unique (non-General) topic in the incoming KP batch, recall the
 * top candidate nodes via BM25 and ask the LLM whether the topic is
 * semantically equivalent to any of them.  If yes, remap the topic to the
 * existing node's name so `findOrCreateTopicNode` will reuse it.
 *
 * Makes one LLM call per unique topic — typically 3–10 calls per ingestion.
 * Fails silently so ingestion always completes even when the LLM is down.
 *
 * @param {string[]} uniqueTopics   - already-normalised unique topic names
 * @param {boolean}  useLLM
 * @returns {Map<string, string>}   original topic → canonical name (only remapped entries)
 */
export async function canonicalizeTopicHints(uniqueTopics, useLLM) {
  const mapping = new Map();
  if (!useLLM || !llmConfig[llmConfig.provider]?.apiKey) return mapping;

  for (const topic of uniqueTopics) {
    if (topic === 'General') continue;

    try {
      // Recall top candidates using BM25 (pre-filter, not all nodes)
      const candidates = searchNodesByName(topic, 12);
      if (!candidates.length) continue;

      const candidateNames = candidates
        .map(c => (c.node || c).name)
        .filter(Boolean)
        .filter((n, i, arr) => arr.indexOf(n) === i) // deduplicate
        .slice(0, 12);

      const prompt = `You are organizing a knowledge graph. A new document has a topic category.

New topic: "${topic}"

Candidate existing nodes in the graph:
${candidateNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Is the new topic semantically equivalent to any candidate (same concept, possibly different phrasing)?
- If YES: respond with EXACTLY the matching candidate name from the list (copy it verbatim)
- If NO: respond with EXACTLY "${topic}"

Respond with ONLY the chosen name, nothing else.`;

      const result = await callLLM({ prompt, temperature: 0.0, seed: 42, taskName: 'topic_canonicalization' });
      if (!result) continue;

      const canonical = result.trim().replace(/^["']|["']$/g, '');

      // Only accept the LLM's answer if it exactly matches a candidate name
      if (candidateNames.includes(canonical) && canonical !== topic) {
        mapping.set(topic, canonical);
        logger.info(`Topic canonicalized: "${topic}" → "${canonical}"`);
      }
    } catch (err) {
      logger.warn(`Topic canonicalization failed for "${topic}": ${err.message}`);
    }
  }

  return mapping;
}

/**
 * Group KPs into a 2–3 level topical hierarchy and return a map of
 * kp.index → nodeId for every KP, plus a list of newly created nodes.
 */
export async function buildTopicalHierarchy(kps, docTitle, documentId, options = {}) {
  const { useLLM = true } = options;

  ensureRootNode();

  // ── Step 0: Canonicalize topic hints via LLM (pre-filters duplicates) ─────
  // Collect unique (non-General) topics from this batch and ask the LLM
  // whether any map to an existing node under a different phrasing.
  const uniqueTopics = [...new Set(kps.map(kp => normalizeTopicHint(kp.topic_hint)))];
  const topicMapping = await canonicalizeTopicHints(uniqueTopics, useLLM);
  if (topicMapping.size > 0) {
    for (const kp of kps) {
      const normalized = normalizeTopicHint(kp.topic_hint);
      if (topicMapping.has(normalized)) {
        kp.topic_hint = topicMapping.get(normalized);
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const nodeMap  = new Map();    // kp.index → nodeId
  const newNodes = [];

  // Group by topic_hint (generic LLM placeholders are normalized to "General")
  const byTopic = new Map();
  for (const kp of kps) {
    const topic = normalizeTopicHint(kp.topic_hint);
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(kp);
  }

  for (const [topicName, topicKPs] of byTopic) {
    const domainNode = await findOrCreateTopicNode(topicName, "root", { useLLM });
    if (domainNode._created) newNodes.push(domainNode);

    // Decide whether to add a subtopic level
    const bySubtopic = new Map();
    for (const kp of topicKPs) {
      const sub = (kp.subtopic_hint || "").trim();
      const key = sub || "__none__";
      if (!bySubtopic.has(key)) bySubtopic.set(key, []);
      bySubtopic.get(key).push(kp);
    }

    const uniqueSubs = [...bySubtopic.keys()].filter(k => k !== "__none__");

    // Use a subtopic level only when subtopics are dissimilar enough on average.
    // Previously used minimum pairwise similarity, which is unstable: a single
    // outlier pair (e.g. "Onboarding" vs "Payroll" in a set of otherwise similar
    // subtopics) would flip the decision for the entire node. Mean similarity is
    // robust to outliers and reflects the overall structure of the subtopic set.
    let useSubtopic = false;
    if (uniqueSubs.length >= 2) {
      const sims = [];
      for (let i = 0; i < uniqueSubs.length; i++) {
        for (let j = i + 1; j < uniqueSubs.length; j++) {
          sims.push(wordDiceSimilarity(uniqueSubs[i], uniqueSubs[j]));
        }
      }
      const meanSim = sims.reduce((a, b) => a + b, 0) / sims.length;
      useSubtopic = meanSim < 0.6;
    }

    if (useSubtopic) {
      for (const [subKey, subKPs] of bySubtopic) {
        let targetNode = domainNode;
        if (subKey !== "__none__") {
          targetNode = await findOrCreateTopicNode(subKey, domainNode.node_id, { useLLM });
          if (targetNode._created) newNodes.push(targetNode);
        }
        for (const kp of subKPs) nodeMap.set(kp.index, targetNode.node_id);
      }
    } else {
      for (const kp of topicKPs) nodeMap.set(kp.index, domainNode.node_id);
    }
  }

  // Strip internal _created flag before returning
  const cleanNodes = newNodes.map(({ _created: _, ...rest }) => rest);
  return { nodeMap, newNodes: cleanNodes };
}

/**
 * Insert a KP into the DB and update the FTS index.
 * @returns {number} new chunk ID
 */
export function assignKPToNode(kp, nodeId, documentId) {
  return runTransaction(() => {
    const result = ChunkRepo.insertKP({
      doc_title:            kp.doc_title,
      content:              kp.content,
      chunk_type:           kp.chunk_type || kp.kp_type || "fact",
      kp_type:              kp.kp_type || "fact",
      keywords:             kp.keywords || [],
      fields:               kp.fields || {},
      scope:                kp.scope || {},
      authority_level:      kp.authority_level || "sop",
      source_excerpt:       kp.source_excerpt || "",
      source_documents_json: kp.source_documents_json || "[]",
      nodeId,
      documentId,
      index: kp.index
    });

    const chunkId = result.lastInsertRowid;
    ChunkRepo.insertFts(chunkId, kp.content);
    NodeRepo.touch(nodeId);
    logAudit("create", "chunks", chunkId, null, { node_id: nodeId, doc_title: kp.doc_title, kp_type: kp.kp_type });

    return Number(chunkId);
  });
}
