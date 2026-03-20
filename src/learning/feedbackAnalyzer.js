/**
 * Feedback Analyzer
 *
 * Analyzes accumulated feedback to produce actionable signals:
 * - Per-query-type satisfaction rates
 * - Node penalties from consistently negative feedback
 * - Chunk penalties from low feedback scores
 * - Knowledge gap patterns from poorly-answered queries
 */

import { db } from "../db/db.js";
import { logger } from "../utils/logger.js";

/**
 * Analyze feedback patterns over a time window.
 * @param {number} days - Look-back window (default 30)
 * @returns {{ byQueryType: Array, overallSatisfaction: number, totalFeedback: number }}
 */
export function analyzeFeedbackPatterns(days = 30) {
  const safeDays = Math.max(1, Math.floor(Number(days)));
  try {
    const byQueryType = db.prepare(`
      SELECT query_type,
             COUNT(*) as total,
             AVG(rating) as avg_rating,
             SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive,
             SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative
      FROM feedback
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY query_type
      ORDER BY total DESC
    `).all(safeDays);

    const overall = db.prepare(`
      SELECT COUNT(*) as total, AVG(rating) as avg_rating
      FROM feedback
      WHERE created_at > datetime('now', '-' || ? || ' days')
    `).get(safeDays);

    return {
      byQueryType,
      overallSatisfaction: overall?.avg_rating ?? 0,
      totalFeedback: overall?.total ?? 0
    };
  } catch (err) {
    logger.warn(`analyzeFeedbackPatterns failed: ${err.message}`);
    return { byQueryType: [], overallSatisfaction: 0, totalFeedback: 0 };
  }
}

/**
 * Compute per-node penalties from node_query_relevance.
 * Nodes with >60% negative feedback on 3+ samples get penalty up to -0.3.
 * @returns {Map<string, number>} nodeId → penalty (negative number)
 */
export function computeNodePenalties() {
  const penalties = new Map();
  try {
    const rows = db.prepare(`
      SELECT node_id,
             SUM(positive_count) as total_pos,
             SUM(negative_count) as total_neg
      FROM node_query_relevance
      GROUP BY node_id
      HAVING (SUM(positive_count) + SUM(negative_count)) >= 3
    `).all();

    for (const row of rows) {
      const total = row.total_pos + row.total_neg;
      const negRate = row.total_neg / total;
      if (negRate > 0.6) {
        // Scale penalty: 60% neg → -0.1, 80% → -0.2, 100% → -0.3
        const penalty = -Math.min(0.3, (negRate - 0.6) * 0.75);
        penalties.set(row.node_id, Math.round(penalty * 1000) / 1000);
      }
    }
  } catch (err) {
    logger.warn(`computeNodePenalties failed: ${err.message}`);
  }
  return penalties;
}

/**
 * Compute per-chunk penalties from chunks.feedback_score.
 * Chunks with feedback_count >= 3 and feedback_score < -0.2 get penalties.
 * @returns {Map<number, number>} chunkId → penalty (negative number)
 */
export function computeChunkPenalties() {
  const penalties = new Map();
  try {
    const rows = db.prepare(`
      SELECT id, feedback_score
      FROM chunks
      WHERE feedback_count >= 3 AND feedback_score < -0.2
    `).all();

    for (const row of rows) {
      // Use feedback_score directly as penalty, capped at -0.3
      penalties.set(row.id, Math.max(-0.3, row.feedback_score));
    }
  } catch (err) {
    logger.warn(`computeChunkPenalties failed: ${err.message}`);
  }
  return penalties;
}

/**
 * Identify knowledge gaps — frequently asked but poorly answered patterns.
 * Criteria: rating <= 2, frequency >= 2 within the look-back window.
 * @param {number} days - Look-back window (default 30)
 * @returns {Array<{ query: string, frequency: number, avg_rating: number, query_types: string }>}
 */
export function identifyKnowledgeGaps(days = 30) {
  const safeDays = Math.max(1, Math.floor(Number(days)));
  try {
    return db.prepare(`
      SELECT query,
             COUNT(*) as frequency,
             AVG(rating) as avg_rating,
             GROUP_CONCAT(DISTINCT query_type) as query_types
      FROM feedback
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY query
      HAVING AVG(rating) <= 2 AND COUNT(*) >= 2
      ORDER BY COUNT(*) DESC, AVG(rating) ASC
      LIMIT 50
    `).all(safeDays);
  } catch (err) {
    logger.warn(`identifyKnowledgeGaps failed: ${err.message}`);
    return [];
  }
}

/**
 * Compute optimal feedback boost multiplier from feedback data.
 * If chunks with higher feedback_score correlate with positive ratings,
 * increase the multiplier; if not, decrease.
 * @returns {{ multiplier: number, sampleCount: number }}
 */
export function computeFeedbackBoostMultiplier() {
  try {
    // Get feedback entries that have chunk IDs
    const rows = db.prepare(`
      SELECT f.rating, f.chunk_ids_json
      FROM feedback f
      WHERE f.chunk_ids_json IS NOT NULL
        AND f.chunk_ids_json != '[]'
        AND f.created_at > datetime('now', '-30 days')
      ORDER BY f.created_at DESC
      LIMIT 200
    `).all();

    if (rows.length < 10) {
      return { multiplier: 1.0, sampleCount: rows.length };
    }

    // Check correlation between feedback_score and user rating
    let posWithHighScore = 0;
    let posTotal = 0;
    let negWithHighScore = 0;
    let negTotal = 0;

    for (const row of rows) {
      let chunkIds;
      try { chunkIds = JSON.parse(row.chunk_ids_json); } catch { continue; }
      if (!Array.isArray(chunkIds) || chunkIds.length === 0) continue;

      // Sample first chunk's feedback_score
      const chunk = db.prepare(`SELECT feedback_score FROM chunks WHERE id = ?`).get(chunkIds[0]);
      if (!chunk) continue;

      const hasHighScore = (chunk.feedback_score || 0) > 0;
      if (row.rating >= 4) {
        posTotal++;
        if (hasHighScore) posWithHighScore++;
      } else if (row.rating <= 2) {
        negTotal++;
        if (hasHighScore) negWithHighScore++;
      }
    }

    // If positive feedback correlates with high feedback_score, boost the multiplier
    const posRate = posTotal > 0 ? posWithHighScore / posTotal : 0.5;
    const negRate = negTotal > 0 ? negWithHighScore / negTotal : 0.5;
    const correlation = posRate - negRate; // range: -1 to 1

    // Map correlation to multiplier adjustment: strong correlation → higher multiplier
    // correlation > 0 means feedback scores are useful → increase multiplier
    // correlation < 0 means feedback scores are misleading → decrease multiplier
    const adjustment = correlation * 0.5; // max ±0.5 from baseline
    const multiplier = Math.round((1.0 + adjustment) * 100) / 100;

    return {
      multiplier: Math.max(0.5, Math.min(3.0, multiplier)),
      sampleCount: rows.length
    };
  } catch (err) {
    logger.warn(`computeFeedbackBoostMultiplier failed: ${err.message}`);
    return { multiplier: 1.0, sampleCount: 0 };
  }
}
