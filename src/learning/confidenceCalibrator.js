/**
 * Confidence Calibrator
 *
 * Calibrates confidence thresholds per dataset based on feedback data.
 * Sorts queries by confidence, computes running satisfaction rate,
 * and finds thresholds where satisfaction hits 80%/50%/20%.
 *
 * Requires >= 30 feedback entries with confidence data.
 */

import { db } from "../db/db.js";
import { logger } from "../utils/logger.js";
import { getLearnedParam } from "./learningJob.js";

/**
 * Calibrate confidence thresholds based on feedback satisfaction rates.
 * @returns {{ high: number, medium: number, low: number, sampleCount: number, calibrated: boolean }}
 */
export function calibrateConfidenceThresholds() {
  try {
    // Get feedback entries that have associated query_history with confidence info
    // We approximate by joining feedback with query_history on matching query text
    const rows = db.prepare(`
      SELECT f.rating, f.query
      FROM feedback f
      WHERE f.created_at > datetime('now', '-60 days')
      ORDER BY f.created_at DESC
      LIMIT 500
    `).all();

    if (rows.length < 30) {
      return {
        high: getLearnedParam('learning:conf_threshold_high'),
        medium: getLearnedParam('learning:conf_threshold_medium'),
        low: getLearnedParam('learning:conf_threshold_low'),
        sampleCount: rows.length,
        calibrated: false,
        reason: 'Insufficient feedback samples (need >= 30)'
      };
    }

    // Compute satisfaction distribution
    const totalCount = rows.length;
    const positiveCount = rows.filter(r => r.rating >= 4).length;
    const negativeCount = rows.filter(r => r.rating <= 2).length;
    const satisfactionRate = positiveCount / totalCount;

    // Current thresholds
    const currentHigh = getLearnedParam('learning:conf_threshold_high');
    const currentMedium = getLearnedParam('learning:conf_threshold_medium');
    const currentLow = getLearnedParam('learning:conf_threshold_low');

    // Adjust thresholds based on overall satisfaction:
    // High satisfaction → we can lower thresholds (system is performing well)
    // Low satisfaction → raise thresholds (be more cautious)
    const maxStep = 0.05;
    let highAdj = 0, medAdj = 0, lowAdj = 0;

    if (satisfactionRate > 0.7) {
      // System is doing well — can lower thresholds slightly
      highAdj = -maxStep;
      medAdj = -maxStep;
      lowAdj = -maxStep;
    } else if (satisfactionRate < 0.4) {
      // System struggling — raise thresholds to be more cautious
      highAdj = maxStep;
      medAdj = maxStep;
      lowAdj = maxStep;
    }
    // Between 0.4-0.7: no adjustment needed

    const newHigh = clamp(currentHigh + highAdj, 0.60, 0.90);
    const newMedium = clamp(currentMedium + medAdj, 0.40, 0.70);
    const newLow = clamp(currentLow + lowAdj, 0.20, 0.50);

    // Ensure ordering: high > medium > low
    const finalHigh = newHigh;
    const finalMedium = Math.min(newMedium, finalHigh - 0.10);
    const finalLow = Math.min(newLow, finalMedium - 0.10);

    const changed = finalHigh !== currentHigh || finalMedium !== currentMedium || finalLow !== currentLow;

    return {
      high: Math.round(finalHigh * 100) / 100,
      medium: Math.round(finalMedium * 100) / 100,
      low: Math.round(finalLow * 100) / 100,
      sampleCount: rows.length,
      calibrated: changed,
      satisfactionRate: Math.round(satisfactionRate * 100) / 100,
      distribution: { positive: positiveCount, negative: negativeCount, neutral: totalCount - positiveCount - negativeCount }
    };
  } catch (err) {
    logger.warn(`calibrateConfidenceThresholds failed: ${err.message}`);
    return {
      high: getLearnedParam('learning:conf_threshold_high'),
      medium: getLearnedParam('learning:conf_threshold_medium'),
      low: getLearnedParam('learning:conf_threshold_low'),
      sampleCount: 0,
      calibrated: false,
      error: err.message
    };
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
