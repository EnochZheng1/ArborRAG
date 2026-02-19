/**
 * Node/chunk retrieval orchestrators.
 *
 * Individual strategies live in ./strategies/.
 * This file owns the multi-stage hybrid orchestrators and re-exports
 * all public strategy functions so existing callers need no changes.
 */

import { queryLogger as logger } from "../utils/logger.js";
import { detectLanguage } from "../utils/langDetect.js";
import { normalizeByMax, normalizeVariantText, reciprocalRankFusion } from "./strategies/utils.js";
import { searchByAliases } from "./strategies/aliases.js";
import { expandQuery, buildRetrievalQueryVariants } from "./strategies/expansion.js";
import {
  bm25RecallNodes, bm25RecallChunks, simpleContentSearch,
  searchChunksByDocTitle, getChunksByDocumentName, getNodesByIds, searchNodesByName
} from "./strategies/bm25.js";
import { vectorRecallNodes, vectorRecallChunks } from "./strategies/vector.js";
import { enrichWithHierarchy, getHierarchicalChunks } from "./strategies/hierarchy.js";

// Re-export individual strategies so existing callers keep working
export {
  searchByAliases,
  expandQuery, buildRetrievalQueryVariants,
  bm25RecallNodes, bm25RecallChunks, simpleContentSearch,
  searchChunksByDocTitle, getChunksByDocumentName, getNodesByIds, searchNodesByName,
  vectorRecallNodes, vectorRecallChunks,
  enrichWithHierarchy, getHierarchicalChunks
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildNodeMap() {
  const nodeMap = new Map();
  const addToNodeMap = (node, source, score, matchedQuery = null) => {
    if (!node?.node_id || !Number.isFinite(score) || score <= 0) return;
    if (!nodeMap.has(node.node_id)) {
      nodeMap.set(node.node_id, { node, sources: [], scores: {}, variantMatches: new Set() });
    }
    const entry = nodeMap.get(node.node_id);
    if (!entry.sources.includes(source)) entry.sources.push(source);
    entry.scores[source] = Math.max(entry.scores[source] || 0, score);
    if (matchedQuery) entry.variantMatches.add(matchedQuery);
  };
  return { nodeMap, addToNodeMap };
}

function fuseNodeMap(nodeMap, options) {
  const { useRRF, bm25Weight, vectorWeight, limit } = options;

  if (useRRF) {
    const rankings = {};
    for (const [nodeId, data] of nodeMap) {
      for (const source of data.sources) {
        if (!rankings[source]) rankings[source] = [];
        rankings[source].push({ id: nodeId, score: data.scores[source] });
      }
    }
    for (const source of Object.keys(rankings)) {
      rankings[source].sort((a, b) => b.score - a.score);
    }
    const fusedScores = reciprocalRankFusion(Object.values(rankings));
    const results = [];
    for (const [nodeId, data] of nodeMap) {
      results.push({
        node: data.node,
        score: fusedScores.get(nodeId) || 0,
        sources: data.sources,
        bm25Score: data.scores.bm25_node,
        vectorScore: data.scores.vector_node,
        matched_queries: [...data.variantMatches]
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  } else {
    const results = [];
    for (const [, data] of nodeMap) {
      const { scores } = data;
      let finalScore = 0;
      if (scores.bm25_node)   finalScore += bm25Weight   * scores.bm25_node;
      if (scores.vector_node) finalScore += vectorWeight  * scores.vector_node;
      if (scores.bm25_chunk)  finalScore += 0.3 * scores.bm25_chunk;
      if (scores.vector_chunk) finalScore += 0.4 * scores.vector_chunk;
      if (scores.name_match)  finalScore += 0.5 * scores.name_match;
      if (scores.alias_match) finalScore += 0.45 * scores.alias_match;
      if (scores.doc_title)   finalScore += 0.35 * scores.doc_title;
      results.push({ node: data.node, score: finalScore, sources: data.sources, matched_queries: [...data.variantMatches] });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

// ── Orchestrators ─────────────────────────────────────────────────────────────

export async function hybridRecallNodes(query, limit = 30, options = {}) {
  const {
    bm25Weight             = 0.4,
    vectorWeight           = 0.6,
    vectorThreshold        = 0.25,
    useRRF                 = true,
    includeChunkSearch     = true,
    useMultilingualVariants = true,
    queryVariants          = null,
    maxQueryVariants       = 4,
    maxVectorVariants      = 2,
    useExpansion           = true
  } = options;

  const preparedVariants = Array.isArray(queryVariants) && queryVariants.length > 0
    ? queryVariants
    : useMultilingualVariants
      ? await buildRetrievalQueryVariants(query, { maxVariants: maxQueryVariants, useExpansion, useAliasPivot: true })
      : [{ text: query, weight: 1, lang: detectLanguage(query), sources: ["original"] }];

  const normalizedVariants = preparedVariants
    .map(v => typeof v === "string"
      ? { text: normalizeVariantText(v), weight: 1, lang: detectLanguage(v), sources: ["external"] }
      : { text: normalizeVariantText(v?.text), weight: Number.isFinite(v?.weight) ? v.weight : 1, lang: v?.lang || detectLanguage(v?.text || ""), sources: Array.isArray(v?.sources) ? v.sources : ["external"] })
    .filter(v => v.text);

  if (normalizedVariants.length === 0) {
    normalizedVariants.push({ text: query, weight: 1, lang: detectLanguage(query), sources: ["original"] });
  }

  normalizedVariants.sort((a, b) => b.weight - a.weight);
  const lexicalVariants = normalizedVariants.slice(0, Math.max(1, maxQueryVariants));
  const vectorVariants  = lexicalVariants.slice(0, Math.max(1, Math.min(maxVectorVariants, lexicalVariants.length)));

  const { nodeMap, addToNodeMap } = buildNodeMap();

  // Stage 1: BM25 on nodes
  let bm25Count = 0;
  for (const v of lexicalVariants) {
    const results = bm25RecallNodes(v.text, limit * 2);
    bm25Count += results.length;
    for (const r of results) addToNodeMap(r.node, "bm25_node", (r.bm25 || 0) * v.weight, v.text);
  }
  logger.debug(`BM25 node recall (${lexicalVariants.length} variants): ${bm25Count} results`);

  // Stage 2: Vector on nodes
  let vectorCount = 0;
  for (const v of vectorVariants) {
    try {
      const results = await vectorRecallNodes(v.text, limit * 2, vectorThreshold);
      vectorCount += results.length;
      for (const r of results) addToNodeMap(r.node, "vector_node", (r.similarity || 0) * v.weight, v.text);
    } catch (err) {
      logger.warn(`Vector node search failed for variant "${v.text}":`, err.message);
    }
  }
  logger.debug(`Vector node recall (${vectorVariants.length} variants): ${vectorCount} results`);

  if (includeChunkSearch) {
    // Stage 3a: BM25 chunks → nodes
    try {
      const chunkBm25 = lexicalVariants.flatMap(v =>
        bm25RecallChunks(v.text, limit).map(r => ({ ...r, _vw: v.weight }))
      );
      const maxBm25 = chunkBm25.reduce((m, r) => Math.max(m, r.bm25 || 0), 0);
      const nodeScoreMap = new Map();
      const chunkNodeIds = new Set();
      for (const r of chunkBm25) {
        if (!r.chunk.node_id) continue;
        chunkNodeIds.add(r.chunk.node_id);
        const score = normalizeByMax(r.bm25 || 0, maxBm25) * (r._vw || 1);
        nodeScoreMap.set(r.chunk.node_id, Math.max(nodeScoreMap.get(r.chunk.node_id) || 0, score));
      }
      if (chunkNodeIds.size > 0) {
        for (const node of getNodesByIds([...chunkNodeIds])) {
          const score = nodeScoreMap.get(node.node_id) || 0;
          if (score > 0) addToNodeMap(node, "bm25_chunk", score);
        }
        logger.debug(`BM25 chunk recall found ${chunkNodeIds.size} additional nodes`);
      }
    } catch (err) { logger.warn("Chunk BM25 search failed:", err.message); }

    // Stage 3b: Doc title search → nodes
    try {
      const docResults = lexicalVariants.flatMap(v =>
        searchChunksByDocTitle(v.text, limit).map(r => ({ ...r, _vw: v.weight }))
      );
      const docNodeIds = new Set();
      const nodeScoreMap = new Map();
      for (const r of docResults) {
        if (!r.chunk.node_id) continue;
        docNodeIds.add(r.chunk.node_id);
        const score = Math.max(0, Math.min(1, r.score || 0)) * (r._vw || 1);
        nodeScoreMap.set(r.chunk.node_id, Math.max(nodeScoreMap.get(r.chunk.node_id) || 0, score));
      }
      if (docNodeIds.size > 0) {
        for (const node of getNodesByIds([...docNodeIds])) {
          const score = nodeScoreMap.get(node.node_id) || 0;
          if (score > 0) addToNodeMap(node, "doc_title", score);
        }
        logger.debug(`Document title search found ${docNodeIds.size} nodes`);
      }
    } catch (err) { logger.warn("Document title search failed:", err.message); }

    // Stage 4: Vector chunks → nodes
    try {
      const chunkVector = [];
      for (const v of vectorVariants) {
        const results = await vectorRecallChunks(v.text, limit, vectorThreshold);
        chunkVector.push(...results.map(r => ({ ...r, _vw: v.weight })));
      }
      const maxSim = chunkVector.reduce((m, r) => Math.max(m, r.similarity || 0), 0);
      const nodeScoreMap = new Map();
      const chunkNodeIds = new Set();
      for (const r of chunkVector) {
        if (!r.chunk.node_id) continue;
        chunkNodeIds.add(r.chunk.node_id);
        const score = normalizeByMax(r.similarity || 0, maxSim) * (r._vw || 1);
        nodeScoreMap.set(r.chunk.node_id, Math.max(nodeScoreMap.get(r.chunk.node_id) || 0, score));
      }
      if (chunkNodeIds.size > 0) {
        for (const node of getNodesByIds([...chunkNodeIds])) {
          const score = nodeScoreMap.get(node.node_id) || 0;
          if (score > 0) addToNodeMap(node, "vector_chunk", score);
        }
        logger.debug(`Vector chunk recall found ${chunkNodeIds.size} additional nodes`);
      }
    } catch (err) { logger.warn("Chunk vector search failed:", err.message); }
  }

  // Stage 5: Name and alias matching
  try {
    const { extractSearchTerms } = await import("./strategies/utils.js");
    for (const v of lexicalVariants) {
      const queryTerms = extractSearchTerms(v.text, { maxTerms: 16 });
      for (const term of queryTerms) {
        for (const node of searchNodesByName(term, 5)) {
          addToNodeMap(node, "name_match", 0.9 * v.weight, v.text);
        }
      }
      for (const match of searchByAliases(v.text, 8)) {
        addToNodeMap(match.node, "alias_match", (match.score || 0.6) * v.weight, v.text);
      }
    }
  } catch (err) { logger.warn("Name matching failed:", err.message); }

  if (nodeMap.size === 0) {
    logger.debug("No results from any retrieval method");
    return [];
  }

  return fuseNodeMap(nodeMap, { useRRF, bm25Weight, vectorWeight, limit });
}

export async function hybridRecallChunks(query, limit = 50, options = {}) {
  const { vectorThreshold = 0.4 } = options;

  const bm25Results = bm25RecallChunks(query, limit * 2);
  let vectorResults = [];
  try {
    vectorResults = await vectorRecallChunks(query, limit * 2, vectorThreshold);
    logger.debug(`Vector chunk recall found ${vectorResults.length} candidates`);
  } catch (err) {
    logger.warn("Vector chunk search failed, using BM25 only:", err.message);
  }

  const bm25Ranking   = bm25Results.map(r => ({ id: String(r.chunk.id), score: r.bm25 }));
  const vectorRanking = vectorResults.map(r => ({ id: String(r.chunk.id), score: r.similarity }));
  const fusedScores   = reciprocalRankFusion([bm25Ranking, vectorRanking]);

  const chunkMap = new Map();
  for (const r of bm25Results)   chunkMap.set(String(r.chunk.id), { chunk: r.chunk, sources: ["bm25"] });
  for (const r of vectorResults) {
    const id = String(r.chunk.id);
    if (chunkMap.has(id)) chunkMap.get(id).sources.push("vector");
    else chunkMap.set(id, { chunk: r.chunk, sources: ["vector"] });
  }

  const results = [];
  for (const [chunkId, data] of chunkMap) {
    results.push({ chunk: data.chunk, score: fusedScores.get(chunkId) || 0, sources: data.sources });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export async function smartRecallNodes(query, limit = 30, options = {}) {
  const { useExpansion = true } = options;

  let queries = [query];
  if (useExpansion) {
    try { queries = await expandQuery(query); }
    catch { logger.warn("Query expansion failed, using original query"); }
  }

  const nodeMap = new Map();
  for (const q of queries) {
    const results = await hybridRecallNodes(q, Math.ceil(limit / queries.length) + 5, { ...options, includeChunkSearch: true });
    for (const r of results) {
      if (!nodeMap.has(r.node.node_id)) {
        nodeMap.set(r.node.node_id, { node: r.node, score: r.score, sources: r.sources, matchedQueries: [q] });
      } else {
        const existing = nodeMap.get(r.node.node_id);
        existing.score = Math.max(existing.score, r.score) * 1.1;
        existing.sources = [...new Set([...existing.sources, ...r.sources])];
        if (!existing.matchedQueries.includes(q)) existing.matchedQueries.push(q);
      }
    }
  }

  const results = [...nodeMap.values()];
  results.sort((a, b) => b.score - a.score);
  logger.debug(`Smart recall found ${results.length} nodes from ${queries.length} query variants`);
  return results.slice(0, limit);
}

export async function hierarchicalRecallNodes(query, limit = 30, options = {}) {
  const {
    useHierarchy           = true,
    useAliases             = true,
    useMultilingualVariants = true,
    maxQueryVariants       = 4,
    useExpansion           = true,
    ...hybridOptions
  } = options;

  const variantQueries = useMultilingualVariants
    ? await buildRetrievalQueryVariants(query, { maxVariants: maxQueryVariants, useExpansion, useAliasPivot: useAliases })
    : [{ text: query, weight: 1, lang: detectLanguage(query), sources: ["original"] }];

  const baseResults = await hybridRecallNodes(query, limit, {
    ...hybridOptions, useMultilingualVariants, queryVariants: variantQueries, maxQueryVariants, useExpansion
  });

  if (useAliases) {
    const aliasVariants = variantQueries.length > 0 ? variantQueries : [{ text: query, weight: 1 }];
    for (const variant of aliasVariants.slice(0, maxQueryVariants)) {
      for (const match of searchByAliases(variant.text, 10)) {
        const weightedScore = (match.score || 0.6) * (variant.weight || 1);
        const existing = baseResults.find(r => r.node.node_id === match.node.node_id);
        if (existing) {
          existing.score = Math.max(existing.score, existing.score * (1 + weightedScore * 0.25));
          existing.sources = [...new Set([...(existing.sources || []), "alias"])];
        } else {
          baseResults.push({ node: match.node, score: weightedScore * 0.75, sources: ["alias"], matched_queries: [variant.text] });
        }
      }
    }
  }

  if (useHierarchy) {
    const enriched = enrichWithHierarchy(baseResults, {
      includeAncestors: true, includeChildren: true, includeSiblings: true,
      ancestorBoost: 0.25, childBoost: 0.4, siblingBoost: 0.2
    });
    enriched.sort((a, b) => b.score - a.score);
    return enriched.slice(0, limit);
  }

  return baseResults.slice(0, limit);
}
