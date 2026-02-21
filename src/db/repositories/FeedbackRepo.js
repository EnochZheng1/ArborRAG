/**
 * Feedback repository — feedback and node_query_relevance tables.
 * Also handles feedback-driven chunk score updates.
 */

import { db } from "../db.js";

export const FeedbackRepo = {
  insert({ query, queryType, answerPreview, rating, comment, nodeIdsJson, chunkIdsJson, sessionId }) {
    return db.prepare(`
      INSERT INTO feedback (
        query, query_type, answer_preview, rating, comment,
        node_ids_json, chunk_ids_json, session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      query, queryType ?? "unknown", answerPreview ?? null, rating,
      comment ?? null, nodeIdsJson, chunkIdsJson, sessionId ?? null
    );
  },

  updateChunkScore(chunkId, adjustment) {
    db.prepare(`
      UPDATE chunks
      SET feedback_score = COALESCE(feedback_score, 0) + ?,
          feedback_count = COALESCE(feedback_count, 0) + 1
      WHERE id = ?
    `).run(adjustment, chunkId);
  },

  upsertNodeRelevance({ nodeId, queryPattern, isPositive }) {
    const pos = isPositive ? 1 : 0;
    const neg = isPositive ? 0 : 1;
    db.prepare(`
      INSERT INTO node_query_relevance (node_id, query_pattern, positive_count, negative_count, last_feedback)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id, query_pattern) DO UPDATE SET
        positive_count = positive_count + ?,
        negative_count = negative_count + ?,
        last_feedback  = datetime('now')
    `).run(nodeId, queryPattern, pos, neg, pos, neg);
  },

  getStats({ days = 30, queryType } = {}) {
    const safeDays = Math.max(1, Math.floor(Number(days)));
    const params = [safeDays];
    const typeClause = queryType ? " AND query_type = ?" : "";
    if (queryType) params.push(String(queryType));

    const overview = db.prepare(`
      SELECT COUNT(*) as total_feedback, AVG(rating) as avg_rating,
             SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive_count,
             SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative_count,
             SUM(CASE WHEN rating  = 3 THEN 1 ELSE 0 END) as neutral_count
      FROM feedback WHERE created_at > datetime('now', '-' || ? || ' days')${typeClause}
    `).get(...params);

    const byType = db.prepare(`
      SELECT query_type, COUNT(*) as count, AVG(rating) as avg_rating
      FROM feedback WHERE created_at > datetime('now', '-' || ? || ' days')${typeClause}
      GROUP BY query_type ORDER BY count DESC
    `).all(...params);

    const recentNegative = db.prepare(`
      SELECT query, rating, comment, created_at
      FROM feedback WHERE created_at > datetime('now', '-' || ? || ' days')${typeClause} AND rating <= 2
      ORDER BY created_at DESC LIMIT 10
    `).all(...params);

    return { overview, byType, recentNegative };
  },

  getPoorlyPerforming(limit = 20) {
    return db.prepare(`
      SELECT query, COUNT(*) as feedback_count, AVG(rating) as avg_rating,
             GROUP_CONCAT(DISTINCT query_type) as query_types
      FROM feedback
      WHERE created_at > datetime('now', '-30 days')
      GROUP BY query
      HAVING AVG(rating) < 3 AND COUNT(*) >= 2
      ORDER BY AVG(rating) ASC, COUNT(*) DESC LIMIT ?
    `).all(limit);
  },

  getChunksNeedingReview(limit = 20) {
    return db.prepare(`
      SELECT c.id, c.doc_title, c.content_clean, c.feedback_score,
             c.feedback_count, c.node_id, n.name as node_name
      FROM chunks c
      LEFT JOIN nodes n ON c.node_id = n.node_id
      WHERE c.feedback_score < -0.3 AND c.feedback_count >= 2
      ORDER BY c.feedback_score ASC LIMIT ?
    `).all(limit);
  },

  getNodeRelevance(nodeId, queryPattern) {
    return db.prepare(`
      SELECT positive_count, negative_count FROM node_query_relevance
      WHERE node_id = ? AND query_pattern = ?
    `).get(nodeId, queryPattern);
  }
};
