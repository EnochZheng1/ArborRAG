import { SuggestionRepo } from "../db/repositories/SuggestionRepo.js";
import { isChineseLang } from "../utils/langDetect.js";
import { getActiveDb } from "../db/activeDb.js";
import { logger } from "../utils/logger.js";

/**
 * Query Suggestions Module
 *
 * Provides autocomplete and query suggestions based on:
 * - Node names and aliases
 * - Popular past queries
 * - Document titles
 */

const CACHE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Per-connection cache so switching datasets returns the correct node/alias data.
const cachesByConn = new Map(); // Map<conn, { nodes, aliases, titles, lastRefresh }>

function getCache() {
  const conn = getActiveDb();
  if (!conn) return { nodes: [], aliases: [], titles: [], lastRefresh: 0 };
  if (!cachesByConn.has(conn)) {
    cachesByConn.set(conn, { nodes: [], aliases: [], titles: [], lastRefresh: 0 });
  }
  return cachesByConn.get(conn);
}

/**
 * Get query suggestions for autocomplete
 * @param {string} prefix - Input prefix
 * @param {object} options - Options
 * @returns {Array} Suggestions
 */
export function getSuggestions(prefix, options = {}) {
  const { limit = 10, includePopular = true, lang = 'auto' } = options;

  if (!prefix || prefix.length < 1) {
    // Return popular queries if no prefix
    if (includePopular) {
      return getPopularQueries(limit);
    }
    return [];
  }

  // Refresh cache if needed
  refreshCacheIfNeeded();

  const cache = getCache();
  const normalizedPrefix = prefix.toLowerCase().trim();
  const suggestions = [];

  // Match against node names
  for (const node of cache.nodes) {
    if (matchesPrefix(node.name, normalizedPrefix)) {
      suggestions.push({
        text: node.name,
        type: 'node',
        node_id: node.node_id,
        score: 1.0
      });
    }
  }

  // Match against aliases
  for (const alias of cache.aliases) {
    if (matchesPrefix(alias.alias, normalizedPrefix)) {
      suggestions.push({
        text: alias.alias,
        type: 'alias',
        node_id: alias.node_id,
        node_name: alias.node_name,
        score: 0.9
      });
    }
  }

  // Match against document titles
  for (const title of cache.titles) {
    if (matchesPrefix(title.title, normalizedPrefix)) {
      suggestions.push({
        text: title.title,
        type: 'document',
        doc_id: title.doc_id,
        score: 0.7
      });
    }
  }

  // Match against popular queries
  if (includePopular) {
    const popularMatches = getPopularQueriesMatching(normalizedPrefix);
    suggestions.push(...popularMatches);
  }

  // Deduplicate and sort
  const unique = deduplicateSuggestions(suggestions);
  unique.sort((a, b) => b.score - a.score);

  return unique.slice(0, limit);
}

/**
 * Check if text matches prefix (supports fuzzy Chinese matching)
 */
function matchesPrefix(text, prefix) {
  if (!text) return false;

  const normalizedText = text.toLowerCase();

  // Exact prefix match
  if (normalizedText.startsWith(prefix)) return true;

  // Contains match for short prefixes
  if (prefix.length <= 2 && normalizedText.includes(prefix)) return true;

  // Chinese character matching
  if (/[\u4e00-\u9fa5]/.test(prefix)) {
    // Match any position for Chinese
    return normalizedText.includes(prefix);
  }

  // Word boundary match for English
  const words = normalizedText.split(/\s+/);
  return words.some(word => word.startsWith(prefix));
}

/**
 * Refresh suggestion cache if needed
 */
function refreshCacheIfNeeded() {
  const cache = getCache();
  const now = Date.now();
  if (now - cache.lastRefresh < CACHE_REFRESH_INTERVAL) {
    return;
  }

  try {
    const allNodes = SuggestionRepo.getAllNodes();
    cache.nodes = allNodes;

    // Build aliases from aliases_json
    cache.aliases = [];
    for (const node of allNodes) {
      if (!node.aliases_json || node.aliases_json === '[]' || node.aliases_json === '') continue;
      try {
        const aliases = JSON.parse(node.aliases_json);
        if (Array.isArray(aliases)) {
          for (const alias of aliases) {
            if (alias && typeof alias === 'string') {
              cache.aliases.push({
                alias: alias.trim(),
                node_id: node.node_id,
                node_name: node.name
              });
            }
          }
        }
      } catch (_) {
        // Skip invalid JSON
      }
    }

    cache.titles = SuggestionRepo.getRecentDocumentTitles(100);
    cache.lastRefresh = now;
  } catch (error) {
    logger.warn(`Error refreshing suggestion cache: ${error.message}`);
  }
}

/**
 * Get popular queries
 */
function getPopularQueries(limit = 10) {
  try {
    return SuggestionRepo.getPopularQueries(limit).map(r => ({
      text: r.query,
      type: 'popular',
      count: r.count,
      score: 0.5 + Math.min(0.4, r.count * 0.05)
    }));
  } catch (_) {
    // Table might not exist yet
    return [];
  }
}

/**
 * Get popular queries matching prefix
 */
function getPopularQueriesMatching(prefix) {
  try {
    return SuggestionRepo.getPopularQueriesMatching(prefix).map(r => ({
      text: r.query,
      type: 'history',
      count: r.count,
      score: 0.6 + Math.min(0.3, r.count * 0.03)
    }));
  } catch (_) {
    return [];
  }
}

/**
 * Deduplicate suggestions
 */
function deduplicateSuggestions(suggestions) {
  const seen = new Map();

  for (const s of suggestions) {
    const key = s.text.toLowerCase();
    if (!seen.has(key) || s.score > seen.get(key).score) {
      seen.set(key, s);
    }
  }

  return Array.from(seen.values());
}

/**
 * Record a query for history/popularity tracking
 * @param {string} query - Query text
 * @param {object} metadata - Additional metadata
 */
export function recordQuery(query, metadata = {}) {
  if (!query || query.length < 2) return;

  try {
    SuggestionRepo.insertQuery({
      query: query.trim(),
      queryType: metadata.queryType || 'unknown',
      resultCount: metadata.resultCount || 0
    });
  } catch (_) {
    // Silently fail - history is not critical
  }
}

/**
 * Get trending queries
 * @param {number} limit - Max results
 * @returns {Array} Trending queries
 */
export function getTrendingQueries(limit = 5) {
  try {
    return SuggestionRepo.getTrending(limit).map(r => ({
      query: r.query,
      recent_count: r.recent_count,
      trend: r.trend_score > 1 ? 'rising' : 'steady'
    }));
  } catch (_) {
    return [];
  }
}

/**
 * Get example queries for empty state
 * @param {string} lang - Language
 * @returns {Array} Example queries
 */
export function getExampleQueries(lang = 'en') {
  const examples = {
    en: [
      "What is the sales process?",
      "Compare Product A and B",
      "How do I handle customer complaints?",
      "Recommend a solution for...",
      "What are the key features of...?"
    ],
    zh: [
      "销售流程是什么？",
      "比较产品A和产品B",
      "如何处理客户投诉？",
      "推荐一个解决方案...",
      "主要功能有哪些？"
    ]
  };

  // Mix with actual node names for relevance
  refreshCacheIfNeeded();
  const nodeExamples = getCache().nodes
    .slice(0, 3)
    .map(n => isChineseLang(lang) ? `介绍一下${n.name}` : `Tell me about ${n.name}`);

  return [...(examples[lang] || examples.en).slice(0, 3), ...nodeExamples].slice(0, 5);
}

/**
 * Initialize query history table if not exists
 */
export function initQueryHistoryTable() {
  // Table is initialized by initDatasetDb() for each dataset connection.
}

// Note: initQueryHistoryTable() is called by initDatasetDb() for each dataset connection.
