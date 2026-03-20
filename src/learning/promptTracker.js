/**
 * Prompt Tracker
 *
 * Tracks prompt override effectiveness by comparing feedback metrics
 * before vs after a prompt override was applied.
 */

import { db } from "../db/db.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { logger } from "../utils/logger.js";

/**
 * Track effectiveness of prompt overrides.
 * Compares feedback quality before vs after each prompt override was applied.
 * @returns {Array<{ promptKey: string, before: Object, after: Object, delta: Object }>}
 */
export function trackPromptEffectiveness() {
  try {
    // Find all prompt overrides from dataset_config
    const overrides = db.prepare(`
      SELECT key, value FROM dataset_config
      WHERE key LIKE 'prompt:%'
    `).all();

    if (overrides.length === 0) return [];

    // Get the time each override was set from audit_log
    const results = [];

    for (const override of overrides) {
      const promptKey = override.key;

      // Find when this override was first set
      const auditEntry = db.prepare(`
        SELECT created_at FROM audit_log
        WHERE table_name = 'dataset_config' AND record_id = ?
        ORDER BY created_at ASC LIMIT 1
      `).get(promptKey);

      if (!auditEntry) continue;

      const overrideDate = auditEntry.created_at;

      // Get feedback metrics before the override
      const before = db.prepare(`
        SELECT COUNT(*) as total, AVG(rating) as avg_rating,
               SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive
        FROM feedback
        WHERE created_at < ? AND created_at > datetime(?, '-30 days')
      `).get(overrideDate, overrideDate);

      // Get feedback metrics after the override
      const after = db.prepare(`
        SELECT COUNT(*) as total, AVG(rating) as avg_rating,
               SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive
        FROM feedback
        WHERE created_at >= ?
      `).get(overrideDate);

      if (!before?.total && !after?.total) continue;

      const beforeRate = before.total > 0 ? (before.positive / before.total) : null;
      const afterRate = after.total > 0 ? (after.positive / after.total) : null;

      results.push({
        promptKey: promptKey.replace('prompt:', ''),
        overrideDate,
        before: {
          total: before.total || 0,
          avg_rating: before.avg_rating ? Math.round(before.avg_rating * 100) / 100 : null,
          positive_rate: beforeRate != null ? Math.round(beforeRate * 100) : null
        },
        after: {
          total: after.total || 0,
          avg_rating: after.avg_rating ? Math.round(after.avg_rating * 100) / 100 : null,
          positive_rate: afterRate != null ? Math.round(afterRate * 100) : null
        },
        delta: {
          rating_change: (before.avg_rating != null && after.avg_rating != null)
            ? Math.round((after.avg_rating - before.avg_rating) * 100) / 100
            : null,
          rate_change: (beforeRate != null && afterRate != null)
            ? Math.round((afterRate - beforeRate) * 100)
            : null,
          sufficient_data: (before.total || 0) >= 5 && (after.total || 0) >= 5
        }
      });
    }

    return results;
  } catch (err) {
    logger.warn(`trackPromptEffectiveness failed: ${err.message}`);
    return [];
  }
}

/**
 * Get impact report for all prompt overrides.
 * @returns {{ overrides: Array, summary: Object }}
 */
export function getPromptImpactReport() {
  const overrides = trackPromptEffectiveness();
  const withData = overrides.filter(o => o.delta.sufficient_data);

  return {
    overrides,
    summary: {
      total_overrides: overrides.length,
      with_sufficient_data: withData.length,
      avg_rating_change: withData.length > 0
        ? Math.round(withData.reduce((sum, o) => sum + (o.delta.rating_change || 0), 0) / withData.length * 100) / 100
        : null,
      improved: withData.filter(o => (o.delta.rating_change || 0) > 0).length,
      degraded: withData.filter(o => (o.delta.rating_change || 0) < 0).length,
      neutral: withData.filter(o => (o.delta.rating_change || 0) === 0).length
    }
  };
}
