import { db, safeJson } from "../db/db.js";

/**
 * Query Suggestions Module
 *
 * Provides autocomplete and query suggestions based on:
 * - Node names and aliases
 * - Popular past queries
 * - Document titles
 */

// In-memory cache for fast suggestions
let suggestionCache = {
  nodes: [],
  aliases: [],
  titles: [],
  lastRefresh: 0
};

const CACHE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

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

  const normalizedPrefix = prefix.toLowerCase().trim();
  const suggestions = [];

  // Match against node names
  for (const node of suggestionCache.nodes) {
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
  for (const alias of suggestionCache.aliases) {
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
  for (const title of suggestionCache.titles) {
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
  const now = Date.now();
  if (now - suggestionCache.lastRefresh < CACHE_REFRESH_INTERVAL) {
    return;
  }

  try {
    // Load nodes
    suggestionCache.nodes = db.prepare(`
      SELECT node_id, name
      FROM nodes
      ORDER BY name
    `).all();

    // Load aliases (stored as JSON array in aliases_json column)
    const nodesWithAliases = db.prepare(`
      SELECT node_id, name, aliases_json
      FROM nodes
      WHERE aliases_json IS NOT NULL AND aliases_json != '[]' AND aliases_json != ''
    `).all();

    suggestionCache.aliases = [];
    for (const node of nodesWithAliases) {
      try {
        const aliases = JSON.parse(node.aliases_json || '[]');
        if (Array.isArray(aliases)) {
          for (const alias of aliases) {
            if (alias && typeof alias === 'string') {
              suggestionCache.aliases.push({
                alias: alias.trim(),
                node_id: node.node_id,
                node_name: node.name
              });
            }
          }
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }

    // Load document titles
    suggestionCache.titles = db.prepare(`
      SELECT id as doc_id, original_name as title
      FROM documents
      WHERE status != 'deleted' AND original_name IS NOT NULL
      ORDER BY uploaded_at DESC
      LIMIT 100
    `).all();

    suggestionCache.lastRefresh = now;
  } catch (error) {
    console.error('Error refreshing suggestion cache:', error.message);
  }
}

/**
 * Get popular queries
 */
function getPopularQueries(limit = 10) {
  try {
    const rows = db.prepare(`
      SELECT query, COUNT(*) as count
      FROM query_history
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY query
      ORDER BY count DESC
      LIMIT ?
    `).all(limit);

    return rows.map(r => ({
      text: r.query,
      type: 'popular',
      count: r.count,
      score: 0.5 + Math.min(0.4, r.count * 0.05)
    }));
  } catch (error) {
    // Table might not exist yet
    return [];
  }
}

/**
 * Get popular queries matching prefix
 */
function getPopularQueriesMatching(prefix) {
  try {
    const rows = db.prepare(`
      SELECT query, COUNT(*) as count
      FROM query_history
      WHERE query LIKE ? || '%' OR query LIKE '%' || ? || '%'
      GROUP BY query
      ORDER BY count DESC
      LIMIT 5
    `).all(prefix, prefix);

    return rows.map(r => ({
      text: r.query,
      type: 'history',
      count: r.count,
      score: 0.6 + Math.min(0.3, r.count * 0.03)
    }));
  } catch (error) {
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
    db.prepare(`
      INSERT INTO query_history (query, query_type, result_count, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(
      query.trim(),
      metadata.queryType || 'unknown',
      metadata.resultCount || 0
    );
  } catch (error) {
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
    // Queries that are increasing in frequency
    const rows = db.prepare(`
      WITH recent AS (
        SELECT query, COUNT(*) as recent_count
        FROM query_history
        WHERE created_at > datetime('now', '-1 day')
        GROUP BY query
      ),
      older AS (
        SELECT query, COUNT(*) as older_count
        FROM query_history
        WHERE created_at BETWEEN datetime('now', '-7 days') AND datetime('now', '-1 day')
        GROUP BY query
      )
      SELECT r.query, r.recent_count,
             COALESCE(o.older_count, 0) as older_count,
             (r.recent_count * 1.0 / COALESCE(o.older_count, 1)) as trend_score
      FROM recent r
      LEFT JOIN older o ON r.query = o.query
      ORDER BY trend_score DESC, r.recent_count DESC
      LIMIT ?
    `).all(limit);

    return rows.map(r => ({
      query: r.query,
      recent_count: r.recent_count,
      trend: r.trend_score > 1 ? 'rising' : 'steady'
    }));
  } catch (error) {
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
  const nodeExamples = suggestionCache.nodes
    .slice(0, 3)
    .map(n => lang === 'zh' ? `介绍一下${n.name}` : `Tell me about ${n.name}`);

  return [...(examples[lang] || examples.en).slice(0, 3), ...nodeExamples].slice(0, 5);
}

/**
 * Initialize query history table if not exists
 */
export function initQueryHistoryTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS query_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        query_type TEXT,
        result_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_query_history_query ON query_history(query);
      CREATE INDEX IF NOT EXISTS idx_query_history_created ON query_history(created_at);
    `);
  } catch (error) {
    console.error('Error initializing query history table:', error.message);
  }
}

// Initialize table on module load
initQueryHistoryTable();
