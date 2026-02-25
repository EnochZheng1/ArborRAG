import { FeedbackRepo } from "../db/repositories/FeedbackRepo.js";
import { logger } from "../utils/logger.js";

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

    const result = FeedbackRepo.insert({
      query,
      queryType: queryType || 'unknown',
      answerPreview: answer ? answer.slice(0, 500) : null,
      rating: normalizedRating,
      comment: comment || null,
      nodeIdsJson: JSON.stringify(nodeIds),
      chunkIdsJson: JSON.stringify(chunkIds),
      sessionId: sessionId || null
    });

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
    logger.warn(`Error recording feedback: ${error.message}`);
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
      FeedbackRepo.updateChunkScore(chunkId, adjustment);
    }
  } catch (error) {
    // Non-critical, log and continue
    logger.warn(`Error updating chunk scores: ${error.message}`);
  }
}

/**
 * Update node relevance tracking
 */
function updateNodeRelevanceTracking(nodeIds, query, rating) {
  if (rating === 3) return; // neutral — no meaningful update
  const isPositive = rating >= 4;
  const queryPattern = extractQueryPattern(query);
  for (const nodeId of nodeIds) {
    try {
      FeedbackRepo.upsertNodeRelevance({ nodeId, queryPattern, isPositive });
    } catch (_) { }
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
    const { overview, byType, recentNegative } = FeedbackRepo.getStats({ days, queryType });

    return {
      overview: {
        total: overview.total_feedback || 0,
        average_rating: Math.round((overview.avg_rating || 0) * 100) / 100,
        positive_rate: overview.total_feedback > 0
          ? Math.round((overview.positive_count / overview.total_feedback) * 100)
          : 0,
        positive: overview.positive_count || 0,
        negative: overview.negative_count || 0,
        neutral: overview.neutral_count || 0
      },
      by_type: byType,
      recent_negative: recentNegative
    };
  } catch (error) {
    logger.warn(`Error getting feedback stats: ${error.message}`);
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
    return FeedbackRepo.getPoorlyPerforming(limit);
  } catch (_) {
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
    return FeedbackRepo.getChunksNeedingReview(limit);
  } catch (_) {
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
    const relevance = FeedbackRepo.getNodeRelevance(nodeId, pattern);

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
  } catch (_) {
    return null;
  }
}

/**
 * Initialize feedback tables
 */
export function initFeedbackTables() {
  // Tables are initialized by initDatasetDb() for each dataset connection.
}

// Note: initFeedbackTables() is called by initDatasetDb() for each dataset connection.
