/**
 * Alias-based node search strategy.
 * Maintains an in-memory cache of node aliases for fast lookup.
 */

import { db, safeJson } from "../../db/db.js";
import { queryLogger as logger } from "../../utils/logger.js";
import { extractSearchTerms } from "./utils.js";

const aliasCache = {
  loadedAt: 0,
  nodeCount: null,
  maxUpdatedAt: null,
  entries: [],
  exactMap: new Map(),
  tokenIndex: new Map()
};
const ALIAS_CACHE_TTL_MS = 60 * 1000;

function refreshAliasCache(force = false) {
  const now = Date.now();
  if (!force && aliasCache.loadedAt && now - aliasCache.loadedAt < ALIAS_CACHE_TTL_MS) return;

  const meta = db.prepare(
    "SELECT COUNT(*) as count, MAX(updated_at) as max_updated_at FROM nodes"
  ).get();

  if (!force &&
      aliasCache.nodeCount === meta.count &&
      aliasCache.maxUpdatedAt === meta.max_updated_at &&
      aliasCache.loadedAt) {
    aliasCache.loadedAt = now;
    return;
  }

  const rows = db.prepare(`
    SELECT node_id, name, parent_id, level, node_summary, aliases_json, scope_json
    FROM nodes
    WHERE aliases_json IS NOT NULL AND aliases_json != '[]' AND aliases_json != 'null'
  `).all();

  const entries = [];
  const exactMap = new Map();
  const tokenIndex = new Map();

  for (const row of rows) {
    const aliases = safeJson(row.aliases_json, []);
    if (!Array.isArray(aliases) || aliases.length === 0) continue;

    const node = {
      node_id: row.node_id,
      name: row.name,
      parent_id: row.parent_id,
      level: row.level,
      node_summary: row.node_summary,
      scope: safeJson(row.scope_json, {})
    };

    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      const aliasLower = alias.toLowerCase();
      const entry = { node, alias, aliasLower };
      entries.push(entry);

      if (!exactMap.has(aliasLower)) exactMap.set(aliasLower, []);
      exactMap.get(aliasLower).push(entry);

      const tokens = extractSearchTerms(aliasLower, { maxTerms: 20 });
      for (const token of tokens) {
        if (!tokenIndex.has(token)) tokenIndex.set(token, []);
        tokenIndex.get(token).push(entry);
      }
    }
  }

  aliasCache.entries = entries;
  aliasCache.exactMap = exactMap;
  aliasCache.tokenIndex = tokenIndex;
  aliasCache.loadedAt = now;
  aliasCache.nodeCount = meta.count;
  aliasCache.maxUpdatedAt = meta.max_updated_at;
  logger.debug(`Alias cache refreshed: ${entries.length} aliases`);
}

export function searchByAliases(query, limit = 10) {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return [];
  const queryTokens = extractSearchTerms(queryLower, { maxTerms: 20 });

  refreshAliasCache();

  const matches = [];

  // Exact match fast path
  for (const entry of aliasCache.exactMap.get(queryLower) || []) {
    matches.push({ node: entry.node, matchedAlias: entry.alias, score: 0.9 });
  }

  // Partial match via token index
  const candidateSet = new Set();
  const maxCandidates = Math.max(limit * 20, 100);
  for (const token of queryTokens) {
    for (const entry of aliasCache.tokenIndex.get(token) || []) {
      candidateSet.add(entry);
      if (candidateSet.size >= maxCandidates) break;
    }
    if (candidateSet.size >= maxCandidates) break;
  }

  const scanEntries = candidateSet.size > 0 ? [...candidateSet] : aliasCache.entries;
  const maxScan = Math.max(limit * 8, 40);
  for (const entry of scanEntries) {
    if (matches.length >= maxScan) break;
    if (entry.aliasLower === queryLower) continue;

    if (entry.aliasLower.includes(queryLower) || queryLower.includes(entry.aliasLower)) {
      matches.push({ node: entry.node, matchedAlias: entry.alias, score: 0.6 });
      continue;
    }

    if (queryTokens.length > 0) {
      let overlap = 0;
      for (const token of queryTokens) {
        if (token.length < 2) continue;
        if (entry.aliasLower.includes(token) || token.includes(entry.aliasLower)) overlap++;
      }
      if (overlap > 0) {
        matches.push({ node: entry.node, matchedAlias: entry.alias, score: Math.min(0.75, 0.45 + overlap * 0.1) });
      }
    }
  }

  // Sort, deduplicate, and limit
  matches.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const unique = [];
  for (const m of matches) {
    if (!seen.has(m.node.node_id)) {
      seen.add(m.node.node_id);
      unique.push(m);
    }
  }

  logger.debug(`Alias search found ${unique.length} matches for "${query}"`);
  return unique.slice(0, limit);
}
