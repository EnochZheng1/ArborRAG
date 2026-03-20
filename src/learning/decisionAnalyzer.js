/**
 * Decision Analyzer
 *
 * Learns from human decision resolutions to optimize auto-resolution thresholds.
 * Analyzes acceptance rates at various confidence/similarity thresholds per action type
 * and proposes threshold adjustments.
 */

import { db } from "../db/db.js";
import { logger } from "../utils/logger.js";

// Action types that have tunable thresholds
const TUNABLE_ACTIONS = ['value_conflict', 'replace_suggestion', 'node_merge_suggestion'];

/**
 * Analyze decision resolution patterns.
 * Groups resolved decisions by action type and computes acceptance rates
 * at various similarity/confidence levels.
 * @returns {{ byAction: Object, totalResolved: number }}
 */
export function analyzeDecisionPatterns() {
  try {
    const rows = db.prepare(`
      SELECT action, status, confidence, similarity_score
      FROM pending_decisions
      WHERE status IN ('accepted', 'rejected', 'auto_resolved')
      ORDER BY resolved_at DESC
    `).all();

    const byAction = {};
    for (const row of rows) {
      if (!byAction[row.action]) {
        byAction[row.action] = { accepted: 0, rejected: 0, auto_resolved: 0, entries: [] };
      }
      const group = byAction[row.action];
      group[row.status] = (group[row.status] || 0) + 1;
      group.entries.push({
        status: row.status,
        confidence: row.confidence,
        similarity: row.similarity_score
      });
    }

    // Compute acceptance rates
    for (const [action, data] of Object.entries(byAction)) {
      const humanTotal = data.accepted + data.rejected;
      data.acceptance_rate = humanTotal > 0 ? data.accepted / humanTotal : null;
      data.total = data.accepted + data.rejected + data.auto_resolved;
    }

    return { byAction, totalResolved: rows.length };
  } catch (err) {
    logger.warn(`analyzeDecisionPatterns failed: ${err.message}`);
    return { byAction: {}, totalResolved: 0 };
  }
}

/**
 * Compute optimal thresholds for each action type.
 * Uses binary search on similarity_score to find where acceptance rate
 * first drops below 80%. Proposes new threshold within ±0.05 of current.
 *
 * @param {Object} currentThresholds - Current threshold values
 *   { merge_auto_threshold, replace_auto_conf, ignore_conf_threshold }
 * @returns {Object} Proposed thresholds with reasoning
 */
export function computeOptimalThresholds(currentThresholds = {}) {
  const proposals = {};

  try {
    // Merge auto threshold — based on similarity_score where merges are accepted
    const mergeDecisions = db.prepare(`
      SELECT status, similarity_score
      FROM pending_decisions
      WHERE action IN ('value_conflict', 'node_merge_suggestion')
        AND status IN ('accepted', 'rejected')
        AND similarity_score IS NOT NULL
      ORDER BY similarity_score ASC
    `).all();

    if (mergeDecisions.length >= 15) {
      const optimal = findThresholdAtAcceptanceRate(mergeDecisions, 0.80);
      const current = currentThresholds.merge_auto_threshold ?? 0.80;
      proposals.merge_auto_threshold = proposeAdjustment(current, optimal, 0.05, 0.70, 0.95);
    }

    // Replace auto confidence — based on confidence where replacements are accepted
    const replaceDecisions = db.prepare(`
      SELECT status, confidence
      FROM pending_decisions
      WHERE action = 'replace_suggestion'
        AND status IN ('accepted', 'rejected')
        AND confidence IS NOT NULL
      ORDER BY confidence ASC
    `).all();

    if (replaceDecisions.length >= 10) {
      const optimal = findThresholdAtAcceptanceRate(
        replaceDecisions.map(d => ({ ...d, similarity_score: d.confidence })),
        0.80
      );
      const current = currentThresholds.replace_auto_conf ?? 0.85;
      proposals.replace_auto_conf = proposeAdjustment(current, optimal, 0.05, 0.75, 0.95);
    }

    // Ignore confidence — based on confidence of items that should have been ignored
    const ignoreDecisions = db.prepare(`
      SELECT status, confidence
      FROM pending_decisions
      WHERE status IN ('accepted', 'rejected')
        AND confidence IS NOT NULL
        AND confidence < 0.5
      ORDER BY confidence ASC
    `).all();

    if (ignoreDecisions.length >= 10) {
      // For ignore threshold: find where rejection rate is high (items below this were rightly ignored)
      const optimal = findThresholdAtAcceptanceRate(
        ignoreDecisions.map(d => ({ ...d, similarity_score: d.confidence })),
        0.50  // Lower bar — we want to ignore things users would reject
      );
      const current = currentThresholds.ignore_conf_threshold ?? 0.35;
      proposals.ignore_conf_threshold = proposeAdjustment(current, optimal, 0.05, 0.20, 0.50);
    }
  } catch (err) {
    logger.warn(`computeOptimalThresholds failed: ${err.message}`);
  }

  return proposals;
}

/**
 * Get summary insights about decision resolution patterns.
 * @returns {{ autoResolveAccuracy: number|null, workloadReduction: number|null, byAction: Object }}
 */
export function getDecisionInsights() {
  try {
    // How many auto-resolved decisions were later overridden?
    const autoStats = db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'auto_resolved' THEN 1 ELSE 0 END) as auto_count
      FROM pending_decisions
      WHERE status IN ('accepted', 'rejected', 'auto_resolved')
    `).get();

    const byAction = {};
    const actionRows = db.prepare(`
      SELECT action,
             COUNT(*) as total,
             SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted,
             SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
             SUM(CASE WHEN status = 'auto_resolved' THEN 1 ELSE 0 END) as auto_resolved,
             AVG(similarity_score) as avg_similarity,
             AVG(confidence) as avg_confidence
      FROM pending_decisions
      WHERE status IN ('accepted', 'rejected', 'auto_resolved')
      GROUP BY action
    `).all();

    for (const row of actionRows) {
      byAction[row.action] = {
        total: row.total,
        accepted: row.accepted,
        rejected: row.rejected,
        auto_resolved: row.auto_resolved,
        acceptance_rate: (row.accepted + row.rejected) > 0
          ? Math.round((row.accepted / (row.accepted + row.rejected)) * 100) : null,
        avg_similarity: row.avg_similarity ? Math.round(row.avg_similarity * 100) / 100 : null,
        avg_confidence: row.avg_confidence ? Math.round(row.avg_confidence * 100) / 100 : null
      };
    }

    return {
      autoResolveRate: autoStats.total > 0
        ? Math.round((autoStats.auto_count / autoStats.total) * 100) : null,
      totalResolved: autoStats.total,
      byAction
    };
  } catch (err) {
    logger.warn(`getDecisionInsights failed: ${err.message}`);
    return { autoResolveRate: null, totalResolved: 0, byAction: {} };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the similarity_score threshold where acceptance rate first drops below target.
 * Uses a sliding window approach on sorted data.
 */
function findThresholdAtAcceptanceRate(decisions, targetRate) {
  if (decisions.length === 0) return null;

  // Sort by similarity_score ascending
  const sorted = [...decisions].sort((a, b) =>
    (a.similarity_score ?? 0) - (b.similarity_score ?? 0)
  );

  // Scan from high to low similarity: find where acceptance rate drops below target
  let accepted = 0;
  let total = 0;

  for (let i = sorted.length - 1; i >= 0; i--) {
    total++;
    if (sorted[i].status === 'accepted' || sorted[i].status === 'auto_resolved') {
      accepted++;
    }
    const rate = accepted / total;
    if (rate < targetRate && total >= 5) {
      // The threshold is at this similarity level
      return sorted[i].similarity_score;
    }
  }

  // All above target — acceptance is high across the board.
  // Return null to indicate no threshold drop was found (current threshold is fine).
  return null;
}

/**
 * Propose a threshold adjustment capped at maxStep per cycle.
 */
function proposeAdjustment(current, optimal, maxStep, floor, ceiling) {
  if (optimal == null) return { value: current, reason: 'insufficient data', changed: false };

  let delta = optimal - current;
  // Cap step size
  if (Math.abs(delta) > maxStep) {
    delta = Math.sign(delta) * maxStep;
  }

  const proposed = Math.round((current + delta) * 100) / 100;
  const clamped = Math.max(floor, Math.min(ceiling, proposed));
  const changed = clamped !== current;

  return {
    value: clamped,
    previous: current,
    optimal,
    reason: changed
      ? `Adjusted ${delta > 0 ? 'up' : 'down'} by ${Math.abs(Math.round(delta * 100))/100} based on resolution patterns`
      : 'No change needed',
    changed
  };
}
