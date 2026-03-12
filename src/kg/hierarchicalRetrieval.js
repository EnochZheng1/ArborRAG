/**
 * Hierarchical Retrieval System
 *
 * Smart retrieval that leverages tree structure and graph traversal:
 * 1. Top-down navigation: Use node summaries to guide search down relevant branches
 * 2. Bottom-up enrichment: Add ancestor context to found chunks
 * 3. Sibling expansion: Find related content in sibling nodes
 * 4. Hierarchical scoring: Score based on tree position and path relevance
 * 5. Adaptive depth: Go deeper in relevant branches, prune irrelevant ones
 */

import { safeJson } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { queryLogger as logger } from "../utils/logger.js";
import {
  getNode, getChildren, getChildrenBatch, getAncestors, getSiblings, getDescendants,
  getPathToNode, getRelatedNodes, findCommonAncestor
} from "./graphTraversal.js";
import { llmScoreNodes } from "./llmTreeRouter.js";
import { vectorScoreNodes } from "./vectorTreeRouter.js";
import { generateQueryEmbedding } from "../embedding/embedder.js";

/**
 * Calculate text similarity score (simple term overlap)
 */
function calculateSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  const terms1 = new Set(extractQueryTerms(text1));
  const terms2 = new Set(extractQueryTerms(text2));

  if (terms1.size === 0 || terms2.size === 0) return 0;

  let overlap = 0;
  for (const term of terms1) {
    if (terms2.has(term)) overlap++;
  }

  return overlap / Math.max(terms1.size, terms2.size);
}

// Common English stop words — filtered out during CHUNK-level scoring (getNodeChunks)
// to prevent "is"/"the"/"of" inflating relevance of unrelated content chunks.
// Node navigation (scoreNodeRelevance) uses the full query term set so that node
// names like "Company Overview" can still match partial query phrases.
const EN_STOP_WORDS = new Set([
  "the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall",
  "can","must","of","in","on","at","to","for","by","with","from","as",
  "or","an","and","but","not","it","its","this","that","what","who","how",
  "when","where","which","why","all","any","each","few","more","most",
  "no","nor","so","than","too","very","just","up","out","if","then","than",
  "them","their","they","we","our","us","you","your","he","she","his","her",
  "my","me","its","into","about","over","after"
]);

function extractQueryTerms(query) {
  const normalized = String(query || "").toLowerCase().trim();
  if (!normalized) return [];

  const terms = [];
  const seen = new Set();
  const add = (value) => {
    const token = String(value || "").trim();
    if (!token || seen.has(token)) return;
    seen.add(token);
    terms.push(token);
  };

  // Match letter sequences (2+ chars) OR any digit sequences (incl. single digits like "3", "7").
  const latin = normalized.match(/[a-z]{2,}|\d+/g) || [];
  for (const token of latin) {
    add(token);
  }

  const cjkSequences = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || [];
  for (const sequence of cjkSequences) {
    const chars = [...sequence];
    if (chars.length >= 2) {
      add(sequence);
    }

    const maxN = Math.min(3, chars.length);
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i <= chars.length - n; i++) {
        add(chars.slice(i, i + n).join(""));
      }
    }
  }

  const otherTokens = normalized.split(/\s+/).filter(t => t.length >= 2);
  for (const token of otherTokens) {
    add(token);
  }

  return terms.slice(0, 36);
}

function normalizeQueryVariants(query, queryVariants = null, maxVariants = 6) {
  const variantList = [];
  const seen = new Set();

  const addVariant = (rawText, rawWeight = 1) => {
    const text = String(rawText || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    variantList.push({
      text,
      weight: Math.max(0.3, Math.min(1, Number.isFinite(rawWeight) ? rawWeight : 1))
    });
  };

  if (Array.isArray(queryVariants) && queryVariants.length > 0) {
    for (const variant of queryVariants) {
      if (typeof variant === "string") {
        addVariant(variant, 1);
      } else {
        addVariant(variant?.text, variant?.weight);
      }
    }
  }

  addVariant(query, 1);
  variantList.sort((a, b) => b.weight - a.weight);
  return variantList.slice(0, Math.max(1, maxVariants));
}

function buildWeightedQuery(variants) {
  const terms = [];
  for (const variant of variants) {
    terms.push(variant.text);
    if ((variant.weight || 0) >= 0.95) {
      // Reinforce the primary query while still allowing cross-lingual terms.
      terms.push(variant.text);
    }
  }
  return terms.join(" ").trim();
}

function computeTreeDistance(pathA, pathB) {
  if (!Array.isArray(pathA) || !Array.isArray(pathB) || pathA.length === 0 || pathB.length === 0) {
    return null;
  }

  const maxPrefix = Math.min(pathA.length, pathB.length);
  let commonPrefix = 0;
  while (commonPrefix < maxPrefix && pathA[commonPrefix] === pathB[commonPrefix]) {
    commonPrefix++;
  }

  return (pathA.length - commonPrefix) + (pathB.length - commonPrefix);
}

/**
 * Score a node's relevance to a query based on name, summary, and aliases
 */
function scoreNodeRelevance(node, query, queryTerms) {
  let score = 0;
  const queryLower = query.toLowerCase();
  const nameLower = (node.name || '').toLowerCase();
  const summaryLower = (node.node_summary || '').toLowerCase();

  // Exact name match
  if (nameLower === queryLower) {
    score += 1.0;
  } else if (queryLower.includes(nameLower) || nameLower.includes(queryLower)) {
    score += 0.7;
  }

  // Query terms in name
  for (const term of queryTerms) {
    if (nameLower.includes(term)) {
      score += 0.3;
    }
  }

  // Query terms in summary
  for (const term of queryTerms) {
    if (summaryLower.includes(term)) {
      score += 0.2;
    }
  }

  // Check aliases
  const aliases = node.aliases || [];
  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase();
    if (aliasLower === queryLower || queryLower.includes(aliasLower)) {
      score += 0.5;
    }
    for (const term of queryTerms) {
      if (aliasLower.includes(term)) {
        score += 0.15;
      }
    }
  }

  // Check node description (capped at 0.6)
  const descLower = (node.node_description || '').toLowerCase();
  let descScore = 0;
  for (const term of queryTerms) {
    if (descLower.includes(term)) descScore += 0.2;
  }
  score += Math.min(descScore, 0.6);

  // Check keywords (capped at 0.6)
  const keywords = node.keywords || [];
  let kwScore = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    const kwLower = kw.toLowerCase();
    if (queryLower.includes(kwLower)) kwScore += 0.25;
    for (const term of queryTerms) {
      if (kwLower.includes(term)) kwScore += 0.05;
    }
  }
  score += Math.min(kwScore, 0.6);

  // Text similarity with summary
  score += calculateSimilarity(query, node.node_summary) * 0.4;

  return Math.min(score, 2.0); // Cap at 2.0
}

/**
 * Get all root nodes
 */
function getRootNodes() {
  const rows = NodeRepo.findRoots();

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    node_description: r.node_description || '',
    aliases: safeJson(r.aliases_json, []),
    keywords: safeJson(r.keywords_json, []),
    scope: safeJson(r.scope_json, {})
  }));
}

/**
 * Get chunks for a node with relevance scoring
 */
function getNodeChunks(nodeId, query, limit = 10) {
  const queryTerms = extractQueryTerms(query);
  // Filter stop words for chunk-level scoring so common words ("is","the","of")
  // don't inflate relevance of unrelated content chunks above on-topic ones.
  const contentTerms = queryTerms.filter(t => !EN_STOP_WORDS.has(t));
  const scoringTerms = contentTerms.length > 0 ? contentTerms : queryTerms;

  const rows = ChunkRepo.getForNodeFull(nodeId, limit * 2); // Get more, then filter by relevance

  const chunks = rows.map(r => {
    const content = r.content_clean || '';
    const contentLower = content.toLowerCase();

    // Calculate content relevance using only non-stop-word query terms
    let relevance = 0;
    for (const term of scoringTerms) {
      if (contentLower.includes(term)) {
        relevance += 0.3;
        // Bonus for multiple occurrences
        const matches = (contentLower.match(new RegExp(term, 'g')) || []).length;
        relevance += Math.min(matches * 0.05, 0.2);
      }
    }

    // Keyword-tag match bonus — LLM-extracted tags are semantically precise;
    // matching them is more reliable than raw content text overlap.
    const chunkKeywords = safeJson(r.keywords_json, []).map(k => String(k).toLowerCase());
    for (const term of scoringTerms) {
      if (chunkKeywords.some(kw => kw.includes(term) || term.includes(kw))) {
        relevance += 0.4;
      }
    }

    // Numeric boost — query-aware scoring instead of a flat +0.35 for any number.
    // BM25 IDF down-weights short numbers ("3","8","20") because they appear in
    // many chunks. Differentiated boost ensures the chunk containing the exact
    // figure the user asked for surfaces above prose-heavy chunks.
    const queryNumbers = query.match(/\b\d+(?:\.\d+)?\b/g) || [];
    const isNumericQuery = /\bhow many\b|\bhow long\b|\bhow often\b|what percentage|how much|多少|几天|几个|多长/i.test(query);

    let numericBoost = 0;
    for (const num of queryNumbers) {
      if (new RegExp(`\\b${num}\\b`).test(contentLower)) {
        numericBoost = Math.max(numericBoost, 0.5);
      }
    }
    // Numeric-seeking query ("how many...") with no exact number match:
    // mildly boost any chunk that contains numbers — it's more likely to hold
    // the answer than a pure-prose chunk.
    if (isNumericQuery && numericBoost === 0 && /\d/.test(contentLower)) {
      numericBoost = 0.25;
    }
    relevance += numericBoost;

    return {
      id: r.id,
      content: content,
      content_clean: content,
      doc_title: r.doc_title,
      node_id: r.node_id,
      node_name: r.node_name,
      node_level: r.node_level,
      chunk_type: r.chunk_type,
      authority_level: r.authority_level,
      keywords: safeJson(r.keywords_json, []),
      relevance_score: relevance
    };
  });

  const authorityRank = { sop: 0, policy: 1, guide: 2, faq: 3 };
  const relevant = chunks.filter(c => c.relevance_score > 0);

  if (relevant.length > 0) {
    relevant.sort((a, b) => {
      const scoreDiff = b.relevance_score - a.relevance_score;
      if (scoreDiff !== 0) return scoreDiff;
      const rankA = authorityRank[a.authority_level] ?? 99;
      const rankB = authorityRank[b.authority_level] ?? 99;
      if (rankA !== rankB) return rankA - rankB;
      return 0;
    });
    return relevant.slice(0, limit);
  }

  // Fallback to the original ordering if no relevance is found
  return chunks.slice(0, limit);
}

/**
 * Top-down tree navigation - find relevant branches
 * Uses beam search to explore most promising paths
 */
export async function navigateTreeTopDown(query, options = {}) {
  const {
    beamWidth = 3,      // How many branches to explore at each level
    maxDepth = 5,       // Maximum tree depth to explore
    minNodeScore = 0.1,  // Minimum relevance score to continue exploring
    depthDecay = 0.96,
    useLlmRouting = false,
    useVectorRouting = false,
    queryEmbedding = null   // Pre-computed by caller to avoid duplicate API calls
  } = options;

  const queryTerms = extractQueryTerms(query);
  const relevantNodes = [];
  const exploredNodes = [];   // all nodes explored at each depth (including pruned)
  const idToName = new Map();  // node_id -> name for path resolution
  const visitedNodes = new Set();

  // Start with root nodes
  const roots = getRootNodes();
  let currentLevel = roots.map(node => ({
    node,
    score: scoreNodeRelevance(node, query, queryTerms),
    path: [node.node_id]
  }));

  // Vector hybrid scoring at root level
  if (useVectorRouting && queryEmbedding && roots.length > 0) {
    currentLevel = _blendVectorScores(queryEmbedding, roots, currentLevel);
  }
  // LLM hybrid scoring at root level
  else if (useLlmRouting && roots.length > 0) {
    const llmScores = await _blendLlmScores(query, roots, currentLevel);
    currentLevel = llmScores;
  }

  // When LLM/vector routing is on, ensure all root nodes score at least minNodeScore
  // so their children are always explored (depth-1 is where semantic routing adds value).
  if (useLlmRouting || (useVectorRouting && queryEmbedding)) {
    for (const item of currentLevel) {
      if (item.score < minNodeScore) item.score = minNodeScore;
    }
  }

  // Sort by score. At the root level we keep ALL nodes regardless of beamWidth.
  currentLevel.sort((a, b) => b.score - a.score);

  // Add initial nodes if they score well
  for (const item of currentLevel) {
    const selected = item.score >= minNodeScore && !visitedNodes.has(item.node.node_id);
    idToName.set(item.node.node_id, item.node.name);
    exploredNodes.push({
      name: item.node.name,
      node_id: item.node.node_id,
      score: item.score,
      depth: 0,
      path: [item.node.name],
      selected,
      parent_id: null
    });
    if (selected) {
      visitedNodes.add(item.node.node_id);
      relevantNodes.push({
        ...item.node,
        relevance_score: item.score,
        path: item.path,
        depth: 0
      });
    }
  }

  // Navigate down the tree
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextLevel = [];

    // Batch-fetch children for all active parents in one DB call
    const activeParents = currentLevel.filter(c => c.score >= minNodeScore);
    const parentIds = activeParents.map(c => c.node.node_id);
    const childrenByParent = parentIds.length > 0
      ? getChildrenBatch(parentIds)
      : new Map();

    for (const current of activeParents) {
      const children = childrenByParent.get(current.node.node_id) || [];

      for (const child of children) {
        if (visitedNodes.has(child.node_id)) continue;

        const childScore = scoreNodeRelevance(child, query, queryTerms);
        const combinedScore = (childScore * 0.72 + current.score * 0.28) * depthDecay;

        if (useLlmRouting || (useVectorRouting && queryEmbedding)) {
          nextLevel.push({
            node: child,
            score: Math.max(combinedScore, minNodeScore),
            path: [...current.path, child.node_id]
          });
        } else if (combinedScore >= minNodeScore) {
          nextLevel.push({
            node: child,
            score: combinedScore,
            path: [...current.path, child.node_id]
          });
        }
      }
    }

    if (nextLevel.length === 0) break;

    // Vector scoring at this depth level
    if (useVectorRouting && queryEmbedding && nextLevel.length > 0) {
      const nodesAtLevel = nextLevel.map(item => item.node);
      const blended = _blendVectorScores(queryEmbedding, nodesAtLevel, nextLevel);
      nextLevel.length = 0;
      for (const item of blended) {
        if (item.score >= minNodeScore) nextLevel.push(item);
      }
    }
    // LLM scoring at this depth level — scores replace keyword scores
    else if (useLlmRouting && nextLevel.length > 0) {
      const nodesAtLevel = nextLevel.map(item => item.node);
      const blended = await _blendLlmScores(query, nodesAtLevel, nextLevel);
      nextLevel.length = 0;
      // After LLM scoring, apply the real minNodeScore filter
      for (const item of blended) {
        if (item.score >= minNodeScore) nextLevel.push(item);
      }
    }

    if (nextLevel.length === 0) break;

    // Sort and keep top beamWidth
    nextLevel.sort((a, b) => b.score - a.score);
    currentLevel = nextLevel.slice(0, beamWidth * 2); // Allow more exploration at deeper levels
    const keptIds = new Set(currentLevel.map(i => i.node.node_id));

    // Record all explored nodes at this depth (selected + pruned)
    for (const item of nextLevel) {
      idToName.set(item.node.node_id, item.node.name);
      exploredNodes.push({
        name: item.node.name,
        node_id: item.node.node_id,
        score: item.score,
        depth,
        path: item.path.map(id => idToName.get(id) || id),
        selected: keptIds.has(item.node.node_id),
        parent_id: item.path.length >= 2 ? item.path[item.path.length - 2] : null
      });
    }

    // Add relevant nodes
    for (const item of currentLevel) {
      if (!visitedNodes.has(item.node.node_id)) {
        visitedNodes.add(item.node.node_id);
        relevantNodes.push({
          ...item.node,
          relevance_score: item.score,
          path: item.path,
          depth
        });
      }
    }
  }

  // Sort by relevance
  relevantNodes.sort((a, b) => b.relevance_score - a.relevance_score);

  logger.debug(`Top-down navigation found ${relevantNodes.length} relevant nodes, ${exploredNodes.length} explored (llm=${useLlmRouting}, vector=${useVectorRouting})`);
  relevantNodes._explored = exploredNodes;
  return relevantNodes;
}

/**
 * Blend LLM scores with existing keyword scores for a set of candidates.
 * Uses max(llm, keyword) so LLM can rescue nodes that keywords miss entirely
 * (the primary value prop) without penalizing nodes that keywords already found.
 * All candidates are sent to the LLM (batched in groups of 40 by llmScoreNodes).
 */
async function _blendLlmScores(query, nodes, levelItems) {
  // Send ALL candidates to LLM — llmScoreNodes handles batching internally.
  // Pre-filtering by keyword score would defeat LLM routing's purpose: bridging
  // vocabulary gaps where keyword score is zero.
  const llmScores = await llmScoreNodes(query, nodes);

  if (llmScores.size === 0) {
    return levelItems;
  }

  return levelItems.map(item => {
    const llmResult = llmScores.get(item.node.node_id);
    if (llmResult) {
      // Use the higher of LLM vs keyword score.
      // This lets LLM rescue zero-keyword nodes without suppressing keyword hits.
      return { ...item, score: Math.max(llmResult.score, item.score) };
    }
    return item;
  });
}

/**
 * Blend vector similarity scores with keyword scores for a set of candidates.
 * Uses max(vector, keyword) — same strategy as LLM blend.
 */
function _blendVectorScores(queryEmbedding, nodes, levelItems) {
  const vecScores = vectorScoreNodes(queryEmbedding, nodes);

  if (vecScores.size === 0) {
    return levelItems;
  }

  return levelItems.map(item => {
    const vecResult = vecScores.get(item.node.node_id);
    if (vecResult) {
      return { ...item, score: Math.max(vecResult.score, item.score) };
    }
    return item;
  });
}

/**
 * Bottom-up context enrichment - add ancestor context to chunks
 */
export function enrichWithAncestorContext(chunks, options = {}) {
  const {
    maxAncestors = 2,
    ancestorChunksPerLevel = 2,
    ancestorDecay = 0.82
  } = options;

  const enrichedChunks = [...chunks];
  const seenChunkIds = new Set(chunks.map(c => c.id));
  const processedNodes = new Set();

  for (const chunk of chunks) {
    if (!chunk.node_id || processedNodes.has(chunk.node_id)) continue;
    processedNodes.add(chunk.node_id);

    const ancestors = getAncestors(chunk.node_id);

    for (let i = 0; i < Math.min(ancestors.length, maxAncestors); i++) {
      const ancestor = ancestors[i];

      // Get ancestor's chunks
      const ancestorChunks = ChunkRepo.getForNodeFull(ancestor.node_id, ancestorChunksPerLevel);

      for (const ac of ancestorChunks) {
        if (!seenChunkIds.has(ac.id)) {
          seenChunkIds.add(ac.id);
          enrichedChunks.push({
            id: ac.id,
            content: ac.content_clean,
            content_clean: ac.content_clean,
            doc_title: ac.doc_title,
            node_id: ac.node_id,
            node_name: ac.node_name,
            authority_level: ac.authority_level,
            source: 'ancestor_context',
            hierarchy_relation: 'ancestor',
            hierarchy_hops: i + 1,
            relation_decay: Math.pow(ancestorDecay, i + 1),
            ancestor_level: i + 1,
            original_chunk_id: chunk.id
          });
        }
      }
    }
  }

  return enrichedChunks;
}

/**
 * Sibling expansion - find related content in sibling nodes
 */
export async function expandWithSiblings(seedNodes, query, options = {}) {
  const {
    maxSiblings = 3,
    chunksPerSibling = 3,
    minSiblingScore = 0.15,
    siblingDecay = 0.78,
    useLlmRouting = false,
    useVectorRouting = false,
    queryEmbedding = null
  } = options;

  const queryTerms = extractQueryTerms(query);
  const siblingChunks = [];
  const initialNodeIds = (seedNodes || []).map(seed => (
    typeof seed === "string" ? seed : seed?.node_id
  )).filter(Boolean);
  const processedSiblings = new Set(initialNodeIds);

  for (const seed of seedNodes || []) {
    const nodeId = typeof seed === "string" ? seed : seed?.node_id;
    if (!nodeId) continue;
    const seedScore = typeof seed === "string" ? 0 : (seed.relevance_score || seed.score || 0);

    const siblings = getSiblings(nodeId, false);
    const unprocessed = siblings.filter(s => !processedSiblings.has(s.node_id));
    if (unprocessed.length === 0) continue;

    // Score siblings — keyword first, then LLM override
    let scoredSiblings = unprocessed.map(s => ({
      ...s,
      score: scoreNodeRelevance(s, query, queryTerms)
    }));

    // Vector scoring for siblings when enabled
    if (useVectorRouting && queryEmbedding && unprocessed.length > 0) {
      const vecScores = vectorScoreNodes(queryEmbedding, unprocessed);
      if (vecScores.size > 0) {
        scoredSiblings = scoredSiblings.map(s => {
          const vec = vecScores.get(s.node_id);
          return vec ? { ...s, score: Math.max(vec.score, s.score) } : s;
        });
      }
    }
    // LLM scoring for siblings when enabled
    else if (useLlmRouting && unprocessed.length > 0) {
      const llmScores = await llmScoreNodes(query, unprocessed);
      if (llmScores.size > 0) {
        scoredSiblings = scoredSiblings.map(s => {
          const llm = llmScores.get(s.node_id);
          return llm ? { ...s, score: Math.max(llm.score, s.score) } : s;
        });
      }
    }

    scoredSiblings = scoredSiblings
      .filter(s => s.score >= minSiblingScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSiblings);

    for (const sibling of scoredSiblings) {
      processedSiblings.add(sibling.node_id);
      const combinedSiblingScore = sibling.score * 0.75 + seedScore * 0.25;

      const chunks = getNodeChunks(sibling.node_id, query, chunksPerSibling);
      for (const chunk of chunks) {
        siblingChunks.push({
          ...chunk,
          source: 'sibling_expansion',
          hierarchy_relation: 'sibling',
          hierarchy_hops: 2,
          relation_decay: Math.pow(siblingDecay, 2),
          sibling_of: nodeId,
          sibling_score: combinedSiblingScore,
          relevance_score: Math.max(chunk.relevance_score || 0, combinedSiblingScore * 0.35)
        });
      }
    }
  }

  return siblingChunks;
}

/**
 * Hierarchical scoring - score chunks based on tree position
 */
export function applyHierarchicalScoring(chunks, relevantNodes, query, options = {}) {
  const {
    structuralDecayBase = 0.88,
    proximityBoost = 0.22
  } = options;

  const nodeScores = new Map();
  for (const node of relevantNodes) {
    nodeScores.set(node.node_id, node.relevance_score || 0);
  }

  const queryTerms = extractQueryTerms(query);
  const pathCache = new Map();
  const getPathIds = (nodeId) => {
    if (!nodeId) return [];
    if (!pathCache.has(nodeId)) {
      const path = getPathToNode(nodeId).map(n => n.node_id);
      pathCache.set(nodeId, path);
    }
    return pathCache.get(nodeId);
  };

  const referenceNodes = relevantNodes
    .slice(0, 5)
    .map(node => ({
      node_id: node.node_id,
      score: node.relevance_score || 0,
      path: getPathIds(node.node_id)
    }))
    .filter(node => node.path.length > 0);

  return chunks.map(chunk => {
    let score = chunk.relevance_score || 0;

    // Add node-level score
    if (chunk.node_id && nodeScores.has(chunk.node_id)) {
      score += nodeScores.get(chunk.node_id) * 0.45;
    }

    // Boost based on source type
    const sourceBoosts = {
      'direct': 1.0,
      'ancestor_context': 0.72,
      'sibling_expansion': 0.66,
      'child_context': 0.82,
      'doc_title': 0.9,
      'bm25_content': 0.85,
      'simple_content': 0.75
    };
    score *= sourceBoosts[chunk.source] || 0.82;

    const relation = chunk.hierarchy_relation || (chunk.source === 'direct' ? 'direct' : 'related');
    const inferredHops = relation === 'direct'
      ? 0
      : relation === 'child'
        ? 1
        : relation === 'ancestor'
          ? 1
          : relation === 'sibling'
            ? 2
            : 1;
    const hops = Number.isFinite(chunk.hierarchy_hops) ? chunk.hierarchy_hops : inferredHops;
    const relationBoosts = {
      direct: 1.16,
      child: 1.0,
      ancestor: 0.93,
      sibling: 0.88,
      related: 0.9
    };
    score *= relationBoosts[relation] || 0.9;
    score *= Math.pow(structuralDecayBase, Math.max(0, hops));

    if (Number.isFinite(chunk.relation_decay)) {
      score *= chunk.relation_decay;
    }

    // Depth penalty (deeper = slightly less authoritative for general queries)
    const depth = chunk.node_level || chunk.depth || 0;
    score *= Math.pow(0.95, depth);

    // Authority boost
    const authorityBoosts = { 'sop': 1.0, 'policy': 0.95, 'guide': 0.9, 'faq': 0.85 };
    score *= authorityBoosts[chunk.authority_level] || 0.8;

    // Content relevance boost
    const contentLower = (chunk.content || '').toLowerCase();
    let lexicalHits = 0;
    for (const term of queryTerms) {
      if (contentLower.includes(term)) {
        lexicalHits++;
      }
    }
    score += Math.min(0.28, lexicalHits * 0.08);

    let treeDistance = null;
    if (chunk.node_id && referenceNodes.length > 0) {
      const chunkPath = getPathIds(chunk.node_id);
      if (chunkPath.length > 0) {
        let bestDistance = Infinity;
        let bestRefScore = 0;

        for (const ref of referenceNodes) {
          const distance = computeTreeDistance(chunkPath, ref.path);
          if (distance === null) continue;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestRefScore = ref.score || 0;
          } else if (distance === bestDistance) {
            bestRefScore = Math.max(bestRefScore, ref.score || 0);
          }
        }

        if (bestDistance !== Infinity) {
          treeDistance = bestDistance;
          const proximity = Math.pow(0.9, bestDistance);
          score *= 1 + (proximity * proximityBoost) + Math.min(0.08, bestRefScore * 0.05);
        }
      }
    }

    return {
      ...chunk,
      hierarchical_score: score,
      tree_distance: treeDistance,
      structural_hops: hops
    };
  });
}

/**
 * Main hierarchical retrieval function
 */
export async function hierarchicalRetrieve(query, options = {}) {
  const {
    maxChunks = 30,
    beamWidth = 3,
    maxDepth = 5,
    includeAncestors = true,
    includeSiblings = true,
    includeDescendants = true,
    queryVariants = null,
    ancestorLevels = 2,
    siblingNodesPerSeed = 3,
    descendantDepth = 2,
    descendantNodesPerSeed = 5,
    descendantScoreDecay = 0.82,
    onStep = null
  } = options;

  const traceState = {
    steps: [],
    onStep: typeof onStep === "function" ? onStep : null
  };

  const nodeNameCache = new Map();
  function formatPath(pathIds) {
    if (!Array.isArray(pathIds) || pathIds.length === 0) return [];
    return pathIds.map(id => {
      if (nodeNameCache.has(id)) return nodeNameCache.get(id);
      const node = getNode(id);
      const name = node?.name || id;
      nodeNameCache.set(id, name);
      return name;
    });
  }

  function emitStep(name, description, result = null, status = "success") {
    const step = { name, description, result, status };
    traceState.steps.push(step);
    if (traceState.onStep) {
      traceState.onStep(step);
    }
  }

  const normalizedVariants = normalizeQueryVariants(query, queryVariants, 6);
  const retrievalQuery = buildWeightedQuery(normalizedVariants);

  logger.info(`Hierarchical retrieval for: "${query.slice(0, 50)}..." (${normalizedVariants.length} query variants)`);

  const results = {
    chunks: [],
    nodes: [],
    paths: [],
    sources: new Set()
  };

  emitStep(
    "Hierarchy: Start",
    `Beam search over tree (maxDepth=${maxDepth})`,
    {
      beam_width: beamWidth,
      max_chunks: maxChunks,
      include_ancestors: includeAncestors,
      include_siblings: includeSiblings,
      include_descendants: includeDescendants,
      query_variants: normalizedVariants.map(v => ({
        text: v.text,
        weight: Number((v.weight || 1).toFixed(2))
      }))
    }
  );

  // Step 1: Top-down navigation to find relevant branches
  let useLlmRouting = false;
  let useVectorRouting = false;
  try {
    const routingMode = DatasetConfigRepo.get('tree_routing_mode');
    useLlmRouting = routingMode === 'llm';
    useVectorRouting = routingMode === 'vector';
    if (useLlmRouting) logger.debug(`Tree routing: LLM mode enabled`);
    if (useVectorRouting) logger.debug(`Tree routing: Vector mode enabled`);
  } catch (_) { /* default to keyword */ }

  // Pre-compute query embedding ONCE for all vector routing (tree nav + sibling expansion)
  let queryEmbedding = null;
  if (useVectorRouting) {
    try {
      queryEmbedding = await generateQueryEmbedding(retrievalQuery);
    } catch (err) {
      logger.warn(`[vector_routing] Failed to generate query embedding, falling back to keyword: ${err.message}`);
    }
  }

  // Track which routing mode was used for the query result indicator
  results.routing_mode = useLlmRouting ? 'llm' : useVectorRouting ? 'vector' : 'keyword';

  const relevantNodes = await navigateTreeTopDown(retrievalQuery, { beamWidth, maxDepth, depthDecay: 0.96, useLlmRouting, useVectorRouting, queryEmbedding });
  results.nodes = relevantNodes;
  results.sources.add('tree_navigation');

  if (relevantNodes.length > 0) {
    // Record paths
    results.paths = relevantNodes.slice(0, 5).map(n => n.path);
  }

  const topNodes = relevantNodes.slice(0, 5).map(n => ({
    id: n.node_id,
    name: n.name,
    score: Number((n.relevance_score || 0).toFixed(3)),
    depth: n.depth
  }));
  const topPaths = relevantNodes.slice(0, 3).map(n => formatPath(n.path));
  const maxDepthReached = relevantNodes.reduce((max, n) => Math.max(max, n.depth || 0), 0);
  // Build explored_nodes for traversal animation (includes pruned nodes)
  const exploredForTrace = (relevantNodes._explored || []).map(e => ({
    name: e.name,
    node_id: e.node_id,
    score: Number((e.score || 0).toFixed(3)),
    depth: e.depth,
    path: e.path,
    selected: e.selected,
    parent_id: e.parent_id
  }));

  emitStep(
    "Hierarchy: Top-Down Navigation",
    `Found ${relevantNodes.length} relevant nodes`,
    {
      top_nodes: topNodes,
      paths: topPaths,
      max_depth_reached: maxDepthReached,
      all_nodes: relevantNodes.map(n => ({
        name: n.name,
        score: Number((n.relevance_score || 0).toFixed(3)),
        depth: n.depth,
        path: formatPath(n.path)
      })),
      explored_nodes: exploredForTrace
    }
  );

  // Step 2: Get chunks from relevant nodes
  const seenChunkIds = new Set();
  const nodeChunkStats = [];

  for (const node of relevantNodes.slice(0, 15)) {
    const nodeChunks = getNodeChunks(node.node_id, retrievalQuery, 8);
    let added = 0;

    for (const chunk of nodeChunks) {
      if (!seenChunkIds.has(chunk.id)) {
        seenChunkIds.add(chunk.id);
        results.chunks.push({
          ...chunk,
          source: 'direct',
          node_relevance: node.relevance_score,
          hierarchy_relation: 'direct',
          hierarchy_hops: 0
        });
        added++;
      }
    }
    if (added > 0) {
      nodeChunkStats.push({
        id: node.node_id,
        name: node.name,
        chunks_added: added,
        node_score: Number((node.relevance_score || 0).toFixed(3))
      });
    }
  }

  logger.debug(`Found ${results.chunks.length} chunks from ${relevantNodes.length} nodes`);
  emitStep(
    "Hierarchy: Node Chunk Retrieval",
    `Added ${results.chunks.length} chunks from ${nodeChunkStats.length} nodes`,
    {
      nodes: nodeChunkStats.slice(0, 5)
    }
  );

  // Step 3: Bottom-up enrichment (add ancestor context)
  if (includeAncestors && results.chunks.length > 0) {
    const enriched = enrichWithAncestorContext(results.chunks, {
      maxAncestors: ancestorLevels,
      ancestorChunksPerLevel: 2,
      ancestorDecay: 0.82
    });
    const newChunks = enriched.filter(c => !seenChunkIds.has(c.id));

    for (const chunk of newChunks) {
      seenChunkIds.add(chunk.id);
      results.chunks.push(chunk);
    }

    if (newChunks.length > 0) {
      results.sources.add('ancestor_enrichment');
      logger.debug(`Added ${newChunks.length} ancestor context chunks`);
    }
    emitStep(
      "Hierarchy: Ancestor Enrichment",
      `Added ${newChunks.length} ancestor chunks`,
      { added: newChunks.length, total: results.chunks.length }
    );
  } else if (!includeAncestors) {
    emitStep("Hierarchy: Ancestor Enrichment", "Skipped (disabled)", null, "skipped");
  } else {
    emitStep("Hierarchy: Ancestor Enrichment", "Skipped (no chunks to enrich)", null, "skipped");
  }

  // Step 4: Sibling expansion
  if (includeSiblings && relevantNodes.length > 0) {
    const seedNodes = relevantNodes.slice(0, 5);
    const siblingChunks = await expandWithSiblings(seedNodes, retrievalQuery, {
      maxSiblings: siblingNodesPerSeed,
      chunksPerSibling: 3,
      minSiblingScore: 0.15,
      siblingDecay: 0.78,
      useLlmRouting,
      useVectorRouting,
      queryEmbedding
    });

    for (const chunk of siblingChunks) {
      if (!seenChunkIds.has(chunk.id)) {
        seenChunkIds.add(chunk.id);
        results.chunks.push(chunk);
      }
    }

    if (siblingChunks.length > 0) {
      results.sources.add('sibling_expansion');
      logger.debug(`Added ${siblingChunks.length} sibling chunks`);
    }
    emitStep(
      "Hierarchy: Sibling Expansion",
      `Added ${siblingChunks.length} sibling chunks`,
      { considered_nodes: seedNodes.map(n => n.node_id) }
    );
  } else if (!includeSiblings) {
    emitStep("Hierarchy: Sibling Expansion", "Skipped (disabled)", null, "skipped");
  } else {
    emitStep("Hierarchy: Sibling Expansion", "Skipped (no relevant nodes)", null, "skipped");
  }

  // Step 5: Descendant exploration (go deeper in most relevant branches)
  if (includeDescendants && relevantNodes.length > 0) {
    const topNodes = relevantNodes.slice(0, 3);
    let descendantNodes = 0;
    let descendantChunksAdded = 0;

    for (const node of topNodes) {
      const descendants = getDescendants(node.node_id, descendantDepth);
      descendantNodes += descendants.length;

      for (const desc of descendants.slice(0, descendantNodesPerSeed)) {
        const descChunks = getNodeChunks(desc.node_id, retrievalQuery, 2);

        for (const chunk of descChunks) {
          const descDepth = Math.max(1, desc.depth || 1);
          const depthAdjustedScore = (chunk.relevance_score || 0) * Math.pow(descendantScoreDecay, descDepth);

          if (!seenChunkIds.has(chunk.id) && depthAdjustedScore > 0.08) {
            seenChunkIds.add(chunk.id);
            results.chunks.push({
              ...chunk,
              relevance_score: depthAdjustedScore,
              source: 'child_context',
              parent_node: node.node_id,
              hierarchy_relation: 'child',
              hierarchy_hops: descDepth
            });
            descendantChunksAdded++;
          }
        }
      }
    }

    results.sources.add('descendant_exploration');
    emitStep(
      "Hierarchy: Descendant Exploration",
      `Added ${descendantChunksAdded} chunks from ${descendantNodes} descendant nodes`,
      { top_nodes: topNodes.map(n => ({ id: n.node_id, name: n.name })) }
    );
  } else if (!includeDescendants) {
    emitStep("Hierarchy: Descendant Exploration", "Skipped (disabled)", null, "skipped");
  } else {
    emitStep("Hierarchy: Descendant Exploration", "Skipped (no relevant nodes)", null, "skipped");
  }

  // Step 6: Apply hierarchical scoring
  results.chunks = applyHierarchicalScoring(results.chunks, relevantNodes, retrievalQuery, {
    structuralDecayBase: 0.88,
    proximityBoost: 0.22
  });

  // Sort by hierarchical score and limit
  results.chunks.sort((a, b) => b.hierarchical_score - a.hierarchical_score);
  results.chunks = results.chunks.slice(0, maxChunks);

  results.sources = [...results.sources];
  emitStep(
    "Hierarchy: Scoring",
    `Applied hierarchical scoring; kept ${results.chunks.length} chunks`,
    {
      top_chunks: results.chunks.slice(0, 5).map(c => ({
        id: c.id,
        node: c.node_name,
        score: Number((c.hierarchical_score || 0).toFixed(3)),
        source: c.source
      }))
    }
  );
  results.trace_steps = traceState.steps;

  logger.info(`Hierarchical retrieval complete: ${results.chunks.length} chunks from ${results.sources.join(', ')}`);

  return results;
}

/**
 * Get tree context summary for a set of chunks
 */
export function getTreeContextSummary(chunks) {
  const nodeIds = [...new Set(chunks.map(c => c.node_id).filter(Boolean))];

  if (nodeIds.length === 0) {
    return { paths: [], commonAncestor: null, breadth: 0, depth: 0 };
  }

  // Find common ancestor
  const commonAncestor = findCommonAncestor(nodeIds);

  // Get paths
  const paths = nodeIds.slice(0, 5).map(id => {
    const path = getPathToNode(id);
    return path.map(n => n.name).join(' > ');
  });

  // Calculate tree metrics
  const depths = chunks.map(c => c.node_level || 0);
  const maxDepth = Math.max(...depths, 0);
  const breadth = nodeIds.length;

  return {
    paths,
    commonAncestor: commonAncestor ? commonAncestor.name : null,
    breadth,
    depth: maxDepth,
    nodeCount: nodeIds.length
  };
}

export default {
  hierarchicalRetrieve,
  navigateTreeTopDown,
  enrichWithAncestorContext,
  expandWithSiblings,
  applyHierarchicalScoring,
  getTreeContextSummary
};
