import { runTransaction, logAudit } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { searchNodesByName } from "../kg/recallNodes.js";
import { callLLM, isLlmConfigured } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { getPrompt, isChineseLang } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { wordDiceSimilarity } from "./knowledgeExtractor.js";
import { generateNodeId, ensureRootNode } from "./nodeHierarchy.js";
import { getCustomPrompt } from "../prompts/promptManager.js";

// Config-driven, learned by self-learning system. Falls back to 0.35.
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";

function getTopicMatchThreshold() {
  try {
    const v = DatasetConfigRepo.get('learning:topic_match_threshold');
    if (v != null) { const n = parseFloat(v); if (Number.isFinite(n)) return n; }
  } catch (_) { /* dataset context may not be active */ }
  return 0.35;
}
export const TOPIC_MATCH_THRESHOLD = 0.35; // kept for external imports; internal code uses getter
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
  if (!isLlmConfigured()) return false;

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

  // Scan direct siblings in the DB — guaranteed to see every existing node
  // under this parent, unlike BM25 which only returns a capped top-N result set.
  // Limit scan to 50 siblings to prevent O(n^2) Dice comparisons on large trees.
  try {
    const siblings = NodeRepo.findByParent(parentId);
    const topSiblings = siblings.slice(0, 50);

    let bestMatch = null;
    let bestScore = 0;

    for (const sibling of topSiblings) {
      const score = wordDiceSimilarity(topicName.toLowerCase(), (sibling.name || "").toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestMatch = sibling;
      }
    }

    if (bestScore >= getTopicMatchThreshold()) {
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
  try {
    const node = _createTopicNode({
      node_id:   generateNodeId(topicName),
      name:      topicName,
      parent_id: parentId,
      level:     Number(parentLevel) + 1,
      summary:   ""
    });
    logger.info(`Created topical node: ${node.node_id} (${node.name}) under ${parentId || "root"}`);
    return { ...node, _created: true };
  } catch (err) {
    // Race condition: a parallel job created the same sibling between our scan and insert.
    // Fetch the existing node and reuse it rather than failing the ingestion.
    // Use fuzzy match (Dice > 0.85) to catch near-identical names from LLM paraphrasing.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message?.includes('UNIQUE constraint failed: nodes'))) {
      const siblings = NodeRepo.findByParent(parentId);
      const existing = siblings.find(n => n.name === topicName || wordDiceSimilarity(n.name.toLowerCase(), topicName.toLowerCase()) > 0.85);
      if (existing) {
        logger.debug(`Topic node race resolved: reusing "${existing.name}" under ${parentId || "root"}`);
        return { ...existing, _created: false };
      }
    }
    throw err;
  }
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
  if (!useLLM || !isLlmConfigured()) return mapping;

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

      const candidateList = candidateNames.map((n, i) => `${i + 1}. ${n}`).join('\n');
      const prompt = getCustomPrompt('topicCanonicalization', {
        topic, candidateList
      }) ?? `You are organizing a knowledge graph. A new document has a topic category.

New topic: "${topic}"

Candidate existing nodes in the graph:
${candidateList}

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
    // ── General node cap: sub-group when a single document sends >15 KPs to General ──
    if (topicName === 'General' && topicKPs.length > 15) {
      // Sub-group by subtopic_hint where available
      const bySubHint = new Map();
      const unsorted = [];
      for (const kp of topicKPs) {
        const sub = (kp.subtopic_hint || '').trim();
        if (sub) {
          if (!bySubHint.has(sub)) bySubHint.set(sub, []);
          bySubHint.get(sub).push(kp);
        } else {
          unsorted.push(kp);
        }
      }
      // For remaining unsorted KPs, use docTitle as secondary grouping key
      if (unsorted.length > 15 && docTitle) {
        const subName = `General — ${docTitle}`.slice(0, 60);
        if (!bySubHint.has(subName)) bySubHint.set(subName, []);
        bySubHint.get(subName).push(...unsorted);
      } else if (unsorted.length > 0) {
        if (!bySubHint.has('General')) bySubHint.set('General', []);
        bySubHint.get('General').push(...unsorted);
      }
      // Create sub-nodes under the General domain node
      const generalNode = await findOrCreateTopicNode('General', "root", { useLLM });
      if (generalNode._created) newNodes.push(generalNode);
      for (const [subName, subKPs] of bySubHint) {
        if (subName === 'General') {
          for (const kp of subKPs) nodeMap.set(kp.index, generalNode.node_id);
        } else {
          const subNode = await findOrCreateTopicNode(subName, generalNode.node_id, { useLLM });
          if (subNode._created) newNodes.push(subNode);
          for (const kp of subKPs) nodeMap.set(kp.index, subNode.node_id);
        }
      }
      continue;
    }

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
          // Multi-level depth: subtopic_hint may contain " > " separator
          // from section headings (e.g., "Benefits > Health Insurance > Enrollment")
          const subParts = subKey.split(/\s*>\s*/).filter(p => p.trim());
          let parentNode = domainNode;
          for (const part of subParts) {
            const node = await findOrCreateTopicNode(part, parentNode.node_id, { useLLM });
            if (node._created) newNodes.push(node);
            parentNode = node;
          }
          targetNode = parentNode;
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

// ── General node health monitoring ────────────────────────────────────────────

/**
 * Get stats about "General" nodes — chunk count, sub-node count.
 * Used by the /schema/health endpoint.
 */
export function getGeneralNodeStats() {
  const allNodes = NodeRepo.getAllSortedByLevel();
  const generalNodes = allNodes.filter(n => n.name === 'General' || n.name.startsWith('General —'));
  let totalChunks = 0;
  const nodes = [];
  for (const node of generalNodes) {
    const chunks = ChunkRepo.getForNodeLimited(node.node_id, 200);
    totalChunks += chunks.length;
    nodes.push({ node_id: node.node_id, name: node.name, chunk_count: chunks.length });
  }
  return { total_chunks: totalChunks, nodes, warning: totalChunks > 30 };
}

/**
 * Reclassify KPs from "General" nodes to better-matching non-General nodes.
 * Uses Dice similarity — zero LLM calls.
 *
 * @returns {{ moved: number, suggested: number, unchanged: number }}
 */
export function reclassifyGeneralKPs() {
  const allNodes = NodeRepo.getAllSortedByLevel();
  const generalNodes = allNodes.filter(n => n.name === 'General');
  const nonGeneralNodes = allNodes.filter(n => n.name !== 'General' && !n.name.startsWith('General —'));

  let moved = 0, suggested = 0, unchanged = 0;
  const suggestions = [];

  for (const gNode of generalNodes) {
    const chunks = ChunkRepo.getForNode(gNode.node_id);

    for (const chunk of chunks) {
      const content = (chunk.content_clean || chunk.content || '').toLowerCase();
      let bestNode = null;
      let bestScore = 0;

      for (const candidate of nonGeneralNodes) {
        // Score against node name + keywords + summary + sample chunks
        const nodeText = [
          candidate.name,
          candidate.node_summary || '',
          candidate.node_description || ''
        ].join(' ').toLowerCase();

        const score = wordDiceSimilarity(content, nodeText);
        if (score > bestScore) {
          bestScore = score;
          bestNode = candidate;
        }
      }

      if (bestScore >= 0.6 && bestNode) {
        // High confidence — auto-move
        try {
          ChunkRepo.moveToNode(chunk.id, bestNode.node_id);
          NodeRepo.touch(bestNode.node_id);
          moved++;
        } catch (err) {
          logger.warn(`Reclassify move failed for chunk ${chunk.id}: ${err.message}`);
        }
      } else if (bestScore >= 0.4 && bestNode) {
        // Medium confidence — log suggestion only
        suggestions.push({
          chunk_id: chunk.id,
          from_node: gNode.node_id,
          to_node: bestNode.node_id,
          to_name: bestNode.name,
          score: bestScore
        });
        suggested++;
      } else {
        unchanged++;
      }
    }
  }

  return { moved, suggested, unchanged, suggestions };
}
