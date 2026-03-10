/**
 * LLM-based Tree Router
 *
 * Bridges the semantic gap between user queries and tree node names
 * by using an LLM to score node relevance. For example, a query about
 * "customer complaints" can route to "Escalation Procedure" even with
 * zero keyword overlap.
 */

import { callLLM } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { queryLogger as logger } from "../utils/logger.js";

// ── In-memory LRU cache ────────────────────────────────────────────────────

const CACHE_MAX = 200;
const _cache = new Map(); // Map<key, {score, reason}>

function cacheKey(query, nodeIds) {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  const sorted = [...nodeIds].sort().join(",");
  return `${normalized}|${sorted}`;
}

function cacheGet(key) {
  if (!_cache.has(key)) return null;
  const val = _cache.get(key);
  // Move to end (most recently used)
  _cache.delete(key);
  _cache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, val);
  // Evict oldest if over limit
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

// ── Core routing function ──────────────────────────────────────────────────

/**
 * Ask the LLM to score how relevant each candidate node is to the query.
 *
 * @param {string} query - User query
 * @param {Array<{node_id, name, node_summary?, node_description?, keywords?, aliases?}>} candidateNodes
 * @returns {Promise<Map<string, {score: number, reason: string}>>}
 *   score is 0–2.0 (matching scoreNodeRelevance output range)
 */
/**
 * Score a single batch of nodes (up to ~40 per call for prompt size).
 * Returns Map<node_id, {score, reason}>.
 */
async function _scoreBatch(query, batch) {
  const nodeList = batch.map(n => {
    const parts = [`- ${n.node_id}: "${n.name}"`];
    const desc = n.node_summary || n.node_description;
    if (desc) parts.push(`(${desc.slice(0, 100)})`);
    const kws = Array.isArray(n.keywords) ? n.keywords : [];
    if (kws.length) parts.push(`[${kws.slice(0, 6).join(",")}]`);
    const aliases = Array.isArray(n.aliases) ? n.aliases : [];
    if (aliases.length) parts.push(`aka: ${aliases.slice(0, 3).join(",")}`);
    return parts.join(" ");
  }).join("\n");

  const prompt = `Rate each node's relevance (0-10) to the query. Consider semantic meaning, not just keywords.

Query: "${query}"

Nodes:
${nodeList}

Return JSON array: [{"node_id":"...","relevance":0-10}]
Only include nodes with relevance > 0. No explanation needed.`;

  const raw = await callLLM({
    prompt,
    temperature: 0.0,
    seed: 42,
    maxOutputTokens: 2048,
    taskName: "tree_routing"
  });

  const parsed = await parseLLMJson(raw, "array", {
    fallback: [],
    context: "tree_routing"
  });

  const result = new Map();
  if (!Array.isArray(parsed)) return result;

  for (const item of parsed) {
    if (!item?.node_id) continue;
    const relevance = Math.max(0, Math.min(10, Number(item.relevance) || 0));
    if (relevance === 0) continue;
    result.set(item.node_id, {
      score: (relevance / 10) * 2.0,
      reason: String(item.reason || "")
    });
  }
  return result;
}

export async function llmScoreNodes(query, candidateNodes) {
  if (!query || !candidateNodes?.length) return new Map();

  // Not worth an LLM call for 1-2 candidates — keyword scoring is sufficient
  if (candidateNodes.length <= 2) return new Map();

  const nodeIds = candidateNodes.map(n => n.node_id);
  const key = cacheKey(query, nodeIds);
  const cached = cacheGet(key);
  if (cached) {
    logger.debug(`[tree_routing] Cache hit (${candidateNodes.length} nodes, ${cached.size} scored)`);
    return cached;
  }

  try {
    const BATCH_SIZE = 40; // ~40 nodes per LLM call keeps prompt under token limits
    const result = new Map();

    if (candidateNodes.length <= BATCH_SIZE) {
      // Single batch — common case
      const batchResult = await _scoreBatch(query, candidateNodes);
      for (const [id, v] of batchResult) result.set(id, v);
    } else {
      // Multiple batches for large trees (e.g. 106 L1 nodes)
      const batches = [];
      for (let i = 0; i < candidateNodes.length; i += BATCH_SIZE) {
        batches.push(candidateNodes.slice(i, i + BATCH_SIZE));
      }
      logger.info(`[tree_routing] Splitting ${candidateNodes.length} nodes into ${batches.length} batches`);

      // Run batches sequentially to respect rate limits
      for (const batch of batches) {
        const batchResult = await _scoreBatch(query, batch);
        for (const [id, v] of batchResult) result.set(id, v);
      }
    }

    if (result.size === 0) {
      logger.debug("[tree_routing] LLM returned no relevant nodes");
      return new Map();
    }

    logger.info(`[tree_routing] LLM scored ${result.size}/${candidateNodes.length} nodes`);
    for (const [id, v] of result) {
      logger.debug(`[tree_routing]   ${id}: score=${v.score.toFixed(2)}`);
    }
    cacheSet(key, result);
    return result;
  } catch (err) {
    logger.warn(`[tree_routing] LLM call failed, falling back to keyword scoring: ${err.message}`);
    return new Map();
  }
}
