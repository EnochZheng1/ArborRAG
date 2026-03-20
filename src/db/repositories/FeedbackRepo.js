/**
 * Feedback repository — feedback and node_query_relevance tables.
 * chunks.feedback_score and chunks.feedback_count are written exclusively
 * by recomputeFeedbackScores() (called by the learning cycle every 6h).
 */

import { db } from "../db.js";

export const FeedbackRepo = {
  insert({ query, queryType, answerPreview, rating, comment, nodeIdsJson, chunkIdsJson, sessionId, confidenceAtAnswer }) {
    return db.prepare(`
      INSERT INTO feedback (
        query, query_type, answer_preview, rating, comment,
        node_ids_json, chunk_ids_json, session_id, confidence_at_answer, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      query, queryType ?? "unknown", answerPreview ?? null, rating,
      comment ?? null, nodeIdsJson, chunkIdsJson, sessionId ?? null,
      confidenceAtAnswer ?? null
    );
  },

  /**
   * Sole writer of chunks.feedback_score and chunks.feedback_count.
   * Called by the learning cycle (every 6h). recordFeedback() does NOT
   * touch these columns — it only inserts into the feedback event table.
   *
   * Uses exponential decay: weight = 0.5^(days_since / halfLifeDays).
   * Events older than windowDays are ignored. Result clamped to [-1, 1].
   * feedback_count = number of feedback events within the active decay window.
   */
  recomputeFeedbackScores({ halfLifeDays = 60, windowDays = 90 } = {}) {
    // Get all feedback events within the window, grouped by chunk
    const events = db.prepare(`
      SELECT f.chunk_ids_json, f.rating, f.created_at
      FROM feedback
      WHERE created_at > datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC
    `).all(windowDays);

    // Accumulate decayed scores and event counts per chunk
    const chunkScores = new Map();
    const chunkEventCounts = new Map();
    const now = Date.now();

    for (const event of events) {
      let chunkIds;
      try { chunkIds = JSON.parse(event.chunk_ids_json || '[]'); } catch { continue; }
      if (!Array.isArray(chunkIds) || chunkIds.length === 0) continue;

      const adjustment = (event.rating - 3) * 0.1; // -0.2 to +0.2
      const eventTime = new Date(event.created_at).getTime();
      const daysSince = (now - eventTime) / 86400000;
      const weight = Math.pow(0.5, daysSince / halfLifeDays);

      for (const cid of chunkIds) {
        chunkScores.set(cid, (chunkScores.get(cid) || 0) + adjustment * weight);
        chunkEventCounts.set(cid, (chunkEventCounts.get(cid) || 0) + 1);
      }
    }

    // Write clamped scores and event counts back
    const updateStmt = db.prepare(
      'UPDATE chunks SET feedback_score = ?, feedback_count = ? WHERE id = ?'
    );

    let updated = 0;
    for (const [chunkId, raw] of chunkScores) {
      const clamped = Math.max(-1.0, Math.min(1.0, raw));
      const count = chunkEventCounts.get(chunkId) || 0;
      updateStmt.run(Math.round(clamped * 1000) / 1000, count, chunkId);
      updated++;
    }

    // Zero out scores and counts for chunks with no recent feedback events
    if (chunkScores.size === 0) {
      // No recent events — reset ALL non-zero scores
      db.prepare(`
        UPDATE chunks SET feedback_score = 0, feedback_count = 0
        WHERE feedback_score != 0 OR feedback_count != 0
      `).run();
    } else {
      db.prepare(`
        UPDATE chunks SET feedback_score = 0, feedback_count = 0
        WHERE (feedback_score != 0 OR feedback_count != 0)
          AND id NOT IN (${[...chunkScores.keys()].map(() => '?').join(',')})
      `).run(...chunkScores.keys());
    }

    return { updated, total: chunkScores.size };
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
  },

  /** All feedback within the given look-back window. */
  getRecentFeedback(days = 30) {
    const safeDays = Math.max(1, Math.floor(Number(days)));
    return db.prepare(`
      SELECT id, query, query_type, rating, comment,
             node_ids_json, chunk_ids_json, session_id, created_at
      FROM feedback
      WHERE created_at > datetime('now', '-' || ? || ' days')
      ORDER BY created_at DESC
    `).all(safeDays);
  },

  /** Node-query relevance patterns with >= minSamples total feedback. */
  getNodeRelevanceSummary(minSamples = 3) {
    return db.prepare(`
      SELECT node_id, query_pattern, positive_count, negative_count,
             (positive_count + negative_count) as total,
             last_feedback
      FROM node_query_relevance
      WHERE (positive_count + negative_count) >= ?
      ORDER BY negative_count DESC
    `).all(Math.max(1, Number(minSamples)));
  },

  /** Chunks with feedback_score below maxScore and at least minCount feedback. */
  getChunksWithNegativeFeedback(minCount = 3, maxScore = -0.2) {
    return db.prepare(`
      SELECT id, node_id, feedback_score, feedback_count, doc_title
      FROM chunks
      WHERE feedback_count >= ? AND feedback_score < ?
      ORDER BY feedback_score ASC
      LIMIT 100
    `).all(Math.max(1, Number(minCount)), Number(maxScore));
  }
};
