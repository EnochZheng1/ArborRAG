import { db, safeJson } from "../db/db.js";

/**
 * Feedback Loop Module
 *
 * Collects and processes user feedback on answers
 * to improve retrieval and answer quality over time
 */

/**
 * Record user feedback on an answer
 * @param {object} feedbackData - Feedback data
 * @returns {object} Result
 */
export function recordFeedback(feedbackData) {
  const {
    query,
    queryType,
    answer,
    rating,  // 'up' | 'down' | 1-5 scale
    comment,
    nodeIds = [],
    chunkIds = [],
    sessionId
  } = feedbackData;

  if (!query || !rating) {
    return { success: false, error: 'Query and rating are required' };
  }

  try {
    const normalizedRating = normalizeRating(rating);

    const result = db.prepare(`
      INSERT INTO feedback (
        query, query_type, answer_preview, rating, comment,
        node_ids_json, chunk_ids_json, session_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      query,
      queryType || 'unknown',
      answer ? answer.slice(0, 500) : null,
      normalizedRating,
      comment || null,
      JSON.stringify(nodeIds),
      JSON.stringify(chunkIds),
      sessionId || null
    );

    // Update chunk quality scores based on feedback
    if (chunkIds.length > 0) {
      updateChunkQualityScores(chunkIds, normalizedRating);
    }

    // Update node relevance tracking
    if (nodeIds.length > 0) {
      updateNodeRelevanceTracking(nodeIds, query, normalizedRating);
    }

    return { success: true, feedbackId: result.lastInsertRowid };
  } catch (error) {
    console.error('Error recording feedback:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Normalize rating to 1-5 scale
 */
function normalizeRating(rating) {
  if (rating === 'up' || rating === 'positive' || rating === true) return 5;
  if (rating === 'down' || rating === 'negative' || rating === false) return 1;
  if (typeof rating === 'number') {
    return Math.max(1, Math.min(5, Math.round(rating)));
  }
  return 3; // Neutral
}

/**
 * Update chunk quality scores based on feedback
 */
function updateChunkQualityScores(chunkIds, rating) {
  try {
    // Adjust quality_score in chunks table
    // Positive feedback increases score, negative decreases
    const adjustment = (rating - 3) * 0.1; // -0.2 to +0.2

    for (const chunkId of chunkIds) {
      db.prepare(`
        UPDATE chunks
        SET feedback_score = COALESCE(feedback_score, 0) + ?,
            feedback_count = COALESCE(feedback_count, 0) + 1
        WHERE id = ?
      `).run(adjustment, chunkId);
    }
  } catch (error) {
    // Non-critical, log and continue
    console.error('Error updating chunk scores:', error.message);
  }
}

/**
 * Update node relevance tracking
 */
function updateNodeRelevanceTracking(nodeIds, query, rating) {
  try {
    for (const nodeId of nodeIds) {
      db.prepare(`
        INSERT INTO node_query_relevance (node_id, query_pattern, positive_count, negative_count, last_feedback)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(node_id, query_pattern) DO UPDATE SET
          positive_count = positive_count + ?,
          negative_count = negative_count + ?,
          last_feedback = datetime('now')
      `).run(
        nodeId,
        extractQueryPattern(query),
        rating >= 4 ? 1 : 0,
        rating <= 2 ? 1 : 0,
        rating >= 4 ? 1 : 0,
        rating <= 2 ? 1 : 0
      );
    }
  } catch (error) {
    // Non-critical
  }
}

/**
 * Extract a pattern from query for relevance tracking
 */
function extractQueryPattern(query) {
  // Extract key terms, remove stop words
  const terms = query.toLowerCase()
    .replace(/[?？。.!！,，]/g, '')
    .split(/\s+/)
    .filter(t => t.length > 2)
    .slice(0, 5);

  return terms.sort().join(' ');
}

/**
 * Get feedback statistics
 * @param {object} filters - Filters
 * @returns {object} Statistics
 */
export function getFeedbackStats(filters = {}) {
  const { days = 30, queryType } = filters;

  try {
    let whereClause = `created_at > datetime('now', '-${days} days')`;
    if (queryType) {
      whereClause += ` AND query_type = '${queryType}'`;
    }

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_feedback,
        AVG(rating) as avg_rating,
        SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive_count,
        SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative_count,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as neutral_count
      FROM feedback
      WHERE ${whereClause}
    `).get();

    const byType = db.prepare(`
      SELECT query_type, COUNT(*) as count, AVG(rating) as avg_rating
      FROM feedback
      WHERE ${whereClause}
      GROUP BY query_type
      ORDER BY count DESC
    `).all();

    const recentNegative = db.prepare(`
      SELECT query, rating, comment, created_at
      FROM feedback
      WHERE ${whereClause} AND rating <= 2
      ORDER BY created_at DESC
      LIMIT 10
    `).all();

    return {
      overview: {
        total: stats.total_feedback || 0,
        average_rating: Math.round((stats.avg_rating || 0) * 100) / 100,
        positive_rate: stats.total_feedback > 0
          ? Math.round((stats.positive_count / stats.total_feedback) * 100)
          : 0,
        positive: stats.positive_count || 0,
        negative: stats.negative_count || 0,
        neutral: stats.neutral_count || 0
      },
      by_type: byType,
      recent_negative: recentNegative
    };
  } catch (error) {
    console.error('Error getting feedback stats:', error.message);
    return { overview: {}, by_type: [], recent_negative: [] };
  }
}

/**
 * Get poorly performing queries (for improvement)
 * @param {number} limit - Max results
 * @returns {Array} Queries needing improvement
 */
export function getPoorlyPerformingQueries(limit = 20) {
  try {
    return db.prepare(`
      SELECT
        query,
        COUNT(*) as feedback_count,
        AVG(rating) as avg_rating,
        GROUP_CONCAT(DISTINCT query_type) as query_types
      FROM feedback
      WHERE created_at > datetime('now', '-30 days')
      GROUP BY query
      HAVING AVG(rating) < 3 AND COUNT(*) >= 2
      ORDER BY AVG(rating) ASC, COUNT(*) DESC
      LIMIT ?
    `).all(limit);
  } catch (error) {
    return [];
  }
}

/**
 * Get chunks with poor feedback for review
 * @param {number} limit - Max results
 * @returns {Array} Chunks needing review
 */
export function getChunksNeedingReview(limit = 20) {
  try {
    return db.prepare(`
      SELECT
        c.id,
        c.doc_title,
        c.content_clean,
        c.feedback_score,
        c.feedback_count,
        c.node_id,
        n.name as node_name
      FROM chunks c
      LEFT JOIN nodes n ON c.node_id = n.node_id
      WHERE c.feedback_score < -0.3 AND c.feedback_count >= 2
      ORDER BY c.feedback_score ASC
      LIMIT ?
    `).all(limit);
  } catch (error) {
    return [];
  }
}

/**
 * Apply feedback-based boosting to retrieval scores
 * @param {Array} chunks - Retrieved chunks
 * @returns {Array} Chunks with adjusted scores
 */
export function applyFeedbackBoost(chunks) {
  return chunks.map(chunk => {
    const feedbackScore = chunk.feedback_score || 0;
    const baseScore = chunk.score || 0.5;

    // Apply small adjustment based on historical feedback
    // Range: -0.1 to +0.1
    const adjustment = Math.max(-0.1, Math.min(0.1, feedbackScore));

    return {
      ...chunk,
      score: baseScore + adjustment,
      feedback_adjusted: adjustment !== 0
    };
  });
}

/**
 * Check if a query-node pair has known issues
 * @param {string} query - Query
 * @param {string} nodeId - Node ID
 * @returns {object|null} Known issue info
 */
export function checkKnownIssues(query, nodeId) {
  try {
    const pattern = extractQueryPattern(query);

    const relevance = db.prepare(`
      SELECT positive_count, negative_count
      FROM node_query_relevance
      WHERE node_id = ? AND query_pattern = ?
    `).get(nodeId, pattern);

    if (!relevance) return null;

    const total = relevance.positive_count + relevance.negative_count;
    if (total < 3) return null;

    const negativeRate = relevance.negative_count / total;

    if (negativeRate > 0.6) {
      return {
        has_issues: true,
        negative_rate: Math.round(negativeRate * 100),
        message: 'This node has received negative feedback for similar queries'
      };
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Initialize feedback tables
 */
export function initFeedbackTables() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        query_type TEXT,
        answer_preview TEXT,
        rating INTEGER NOT NULL,
        comment TEXT,
        node_ids_json TEXT,
        chunk_ids_json TEXT,
        session_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_query ON feedback(query);
      CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
      CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

      CREATE TABLE IF NOT EXISTS node_query_relevance (
        node_id TEXT NOT NULL,
        query_pattern TEXT NOT NULL,
        positive_count INTEGER DEFAULT 0,
        negative_count INTEGER DEFAULT 0,
        last_feedback TEXT,
        PRIMARY KEY (node_id, query_pattern)
      );

      -- Add feedback columns to chunks if not exist
      -- SQLite doesn't support IF NOT EXISTS for columns, so we handle errors
    `);

    // Try to add feedback columns to chunks
    try {
      db.exec(`ALTER TABLE chunks ADD COLUMN feedback_score REAL DEFAULT 0`);
    } catch (e) { /* Column might already exist */ }

    try {
      db.exec(`ALTER TABLE chunks ADD COLUMN feedback_count INTEGER DEFAULT 0`);
    } catch (e) { /* Column might already exist */ }

  } catch (error) {
    console.error('Error initializing feedback tables:', error.message);
  }
}

// Initialize tables on module load
initFeedbackTables();
