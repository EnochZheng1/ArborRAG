/**
 * Suggestion / query-history repository.
 *
 * Owns: query_history table.
 * Also provides lightweight node/document reads used by the suggestion cache
 * and the related-questions generator (until a full NodeRepo is introduced).
 */

import { db } from "../db.js";

export const SuggestionRepo = {
  // ── query_history ────────────────────────────────────────────────────────────

  insertQuery({ query, queryType, resultCount }) {
    db.prepare(`
      INSERT INTO query_history (query, query_type, result_count, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(query, queryType ?? "unknown", resultCount ?? 0);
  },

  getPopularQueries(limit = 10) {
    return db.prepare(`
      SELECT query, COUNT(*) as count FROM query_history
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY query ORDER BY count DESC LIMIT ?
    `).all(limit);
  },

  getPopularQueriesMatching(prefix) {
    return db.prepare(`
      SELECT query, COUNT(*) as count FROM query_history
      WHERE query LIKE ? || '%' OR query LIKE '%' || ? || '%'
      GROUP BY query ORDER BY count DESC LIMIT 5
    `).all(prefix, prefix);
  },

  getTrending(limit = 5) {
    return db.prepare(`
      WITH recent AS (
        SELECT query, COUNT(*) as recent_count FROM query_history
        WHERE created_at > datetime('now', '-1 day') GROUP BY query
      ),
      older AS (
        SELECT query, COUNT(*) as older_count FROM query_history
        WHERE created_at BETWEEN datetime('now', '-7 days') AND datetime('now', '-1 day')
        GROUP BY query
      )
      SELECT r.query, r.recent_count,
             COALESCE(o.older_count, 0) as older_count,
             (r.recent_count * 1.0 / COALESCE(o.older_count, 1)) as trend_score
      FROM recent r LEFT JOIN older o ON r.query = o.query
      ORDER BY trend_score DESC, r.recent_count DESC LIMIT ?
    `).all(limit);
  },

  // ── Node / document reads for suggestion cache ────────────────────────────────

  getAllNodes() {
    return db.prepare(
      "SELECT node_id, name, aliases_json FROM nodes ORDER BY name"
    ).all();
  },

  getRecentDocumentTitles(limit = 100) {
    return db.prepare(`
      SELECT id as doc_id, original_name as title
      FROM documents
      WHERE status != 'deleted' AND original_name IS NOT NULL
      ORDER BY uploaded_at DESC LIMIT ?
    `).all(limit);
  },

  // ── Node traversal for related-questions generator ────────────────────────────

  getSiblings(nodeId) {
    return db.prepare(`
      SELECT node_id, name, node_summary FROM nodes
      WHERE parent_id = (SELECT parent_id FROM nodes WHERE node_id = ?)
        AND node_id != ?
      LIMIT 3
    `).all(nodeId, nodeId);
  },

  getChildren(nodeId) {
    return db.prepare(`
      SELECT node_id, name, node_summary FROM nodes
      WHERE parent_id = ? LIMIT 3
    `).all(nodeId);
  },

  getParent(nodeId) {
    return db.prepare(`
      SELECT p.node_id, p.name, p.node_summary
      FROM nodes n JOIN nodes p ON n.parent_id = p.node_id
      WHERE n.node_id = ?
    `).get(nodeId);
  }
};
