/**
 * Learning Job — Orchestrates the periodic learning cycle.
 *
 * Runs all analyzers, validates parameter bounds, persists changes
 * to dataset_config, and logs changes to audit_log.
 *
 * Called by setInterval in server.js (every 6h by default).
 * Can also be triggered manually via POST /learning/run.
 */

import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { logAudit } from "../db/db.js";
import { logger } from "../utils/logger.js";
import {
  analyzeFeedbackPatterns,
  computeNodePenalties,
  computeFeedbackBoostMultiplier,
  identifyKnowledgeGaps
} from "./feedbackAnalyzer.js";
import { FeedbackRepo } from "../db/repositories/FeedbackRepo.js";
import {
  analyzeDecisionPatterns,
  computeOptimalThresholds,
  getDecisionInsights
} from "./decisionAnalyzer.js";
import { tuneRerankerWeights } from "./rerankerTuner.js";
import { calibrateConfidenceThresholds } from "./confidenceCalibrator.js";
import { detectIngestionDrift } from "./ingestionTracker.js";

// ── Parameter definitions with bounds ────────────────────────────────────────

const PARAMETER_DEFS = {
  'learning:feedback_boost_multiplier': {
    default: 1.0, floor: 0.5, ceiling: 3.0, maxStep: 0.2, minSamples: 10,
    label: 'Feedback boost multiplier',
    category: 'retrieval'
  },
  'learning:merge_auto_threshold': {
    default: 0.80, floor: 0.70, ceiling: 0.95, maxStep: 0.05, minSamples: 15,
    label: 'Merge auto-resolve threshold',
    category: 'ingestion'
  },
  'learning:replace_auto_conf': {
    default: 0.85, floor: 0.75, ceiling: 0.95, maxStep: 0.05, minSamples: 10,
    label: 'Replace auto-resolve confidence',
    category: 'ingestion'
  },
  'learning:ignore_conf_threshold': {
    default: 0.35, floor: 0.20, ceiling: 0.50, maxStep: 0.05, minSamples: 10,
    label: 'Ignore confidence threshold',
    category: 'ingestion'
  },
  'learning:topic_match_threshold': {
    default: 0.35, floor: 0.25, ceiling: 0.60, maxStep: 0.05, minSamples: 15,
    label: 'Topic match threshold',
    category: 'ingestion'
  },
  // Phase 2 parameters
  'learning:reranker_w_keyword': {
    default: 0.30, floor: 0.10, ceiling: 0.70, maxStep: 0.05, minSamples: 20,
    label: 'Reranker keyword weight',
    category: 'retrieval'
  },
  'learning:reranker_w_bm25': {
    default: 0.20, floor: 0.10, ceiling: 0.70, maxStep: 0.05, minSamples: 20,
    label: 'Reranker BM25 weight',
    category: 'retrieval'
  },
  'learning:reranker_w_embedding': {
    default: 0.50, floor: 0.10, ceiling: 0.70, maxStep: 0.05, minSamples: 20,
    label: 'Reranker embedding weight',
    category: 'retrieval'
  },
  'learning:conf_threshold_high': {
    default: 0.75, floor: 0.60, ceiling: 0.90, maxStep: 0.05, minSamples: 30,
    label: 'Confidence high threshold',
    category: 'retrieval'
  },
  'learning:conf_threshold_medium': {
    default: 0.55, floor: 0.40, ceiling: 0.70, maxStep: 0.05, minSamples: 30,
    label: 'Confidence medium threshold',
    category: 'retrieval'
  },
  'learning:conf_threshold_low': {
    default: 0.35, floor: 0.20, ceiling: 0.50, maxStep: 0.05, minSamples: 30,
    label: 'Confidence low threshold',
    category: 'retrieval'
  }
};

/**
 * Read a learned parameter value, falling back to its defined default.
 * @param {string} key - Full config key (e.g. 'learning:merge_auto_threshold')
 * @returns {number}
 */
export function getLearnedParam(key) {
  const def = PARAMETER_DEFS[key];
  if (!def) return undefined;
  const stored = DatasetConfigRepo.get(key);
  if (stored == null) return def.default;
  const parsed = parseFloat(stored);
  return Number.isFinite(parsed) ? parsed : def.default;
}

/**
 * Run the full learning cycle.
 * @param {{ dryRun?: boolean }} options
 * @returns {{ changes: Array, analysis: Object, timestamp: string }}
 */
export function runLearningCycle(options = {}) {
  const { dryRun = false } = options;
  const timestamp = new Date().toISOString();
  const changes = [];
  const analysis = {};

  try {
    // ── 0. Recompute feedback_score cache from events with decay ────────────
    // The feedback_score column on chunks is a performance cache. We recompute
    // it from raw feedback events with exponential time-decay (half-life 60d,
    // window 90d) so stale feedback decays out and scores stay bounded [-1, 1].
    try {
      if (!dryRun) {
        const recomputed = FeedbackRepo.recomputeFeedbackScores({ halfLifeDays: 60, windowDays: 90 });
        analysis.feedbackScoreRecompute = recomputed;
        logger.info(`Feedback scores recomputed: ${recomputed.updated} chunks updated`);
      }
    } catch (err) {
      logger.warn(`Feedback score recomputation failed: ${err.message}`);
      analysis.feedbackScoreRecompute = { error: err.message };
    }

    // ── 1. Feedback analysis ──────────────────────────────────────────────────
    const feedbackPatterns = analyzeFeedbackPatterns(30);
    analysis.feedback = feedbackPatterns;

    // Feedback boost multiplier
    if (feedbackPatterns.totalFeedback >= PARAMETER_DEFS['learning:feedback_boost_multiplier'].minSamples) {
      const { multiplier, sampleCount } = computeFeedbackBoostMultiplier();
      const change = applyParameter(
        'learning:feedback_boost_multiplier', multiplier, sampleCount,
        'Computed from feedback-score/rating correlation', dryRun
      );
      if (change) changes.push(change);
    }

    // Node penalties — must also clear stale penalties when all nodes recover
    const nodePenalties = computeNodePenalties();
    analysis.nodePenalties = { count: nodePenalties.size };
    {
      const penaltiesObj = Object.fromEntries(nodePenalties);
      const currentJson = DatasetConfigRepo.get('learning:node_penalties_json');
      const newJson = JSON.stringify(penaltiesObj);
      if (currentJson !== newJson) {
        if (!dryRun) {
          if (nodePenalties.size > 0) {
            DatasetConfigRepo.set('learning:node_penalties_json', newJson);
          } else {
            // All nodes recovered — remove stale penalties
            DatasetConfigRepo.delete('learning:node_penalties_json');
          }
          logAudit('learning_update', 'dataset_config', 'learning:node_penalties_json',
            currentJson, nodePenalties.size > 0 ? newJson : null);
        }
        changes.push({
          key: 'learning:node_penalties_json',
          oldValue: currentJson,
          newValue: nodePenalties.size > 0 ? newJson : '{}',
          reason: nodePenalties.size > 0
            ? `${nodePenalties.size} nodes with >60% negative feedback`
            : 'All node penalties cleared (nodes recovered)'
        });
      }
    }

    // Knowledge gaps
    const gaps = identifyKnowledgeGaps(30);
    analysis.knowledgeGaps = gaps.length;
    if (gaps.length > 0) {
      const gapsJson = JSON.stringify(gaps.slice(0, 20));
      if (!dryRun) {
        DatasetConfigRepo.set('learning:knowledge_gaps_json', gapsJson);
      }
    }

    // ── 2. Decision analysis ──────────────────────────────────────────────────
    const decisionPatterns = analyzeDecisionPatterns();
    analysis.decisions = {
      totalResolved: decisionPatterns.totalResolved,
      actionTypes: Object.keys(decisionPatterns.byAction)
    };

    if (decisionPatterns.totalResolved > 0) {
      const currentThresholds = {
        merge_auto_threshold: getLearnedParam('learning:merge_auto_threshold'),
        replace_auto_conf: getLearnedParam('learning:replace_auto_conf'),
        ignore_conf_threshold: getLearnedParam('learning:ignore_conf_threshold')
      };

      const proposals = computeOptimalThresholds(currentThresholds);

      // Map threshold keys to the action types they govern
      const THRESHOLD_ACTION_MAP = {
        merge_auto_threshold: ['value_conflict', 'node_merge_suggestion'],
        replace_auto_conf: ['replace_suggestion'],
        ignore_conf_threshold: ['value_conflict', 'replace_suggestion']
      };

      for (const [key, proposal] of Object.entries(proposals)) {
        const fullKey = `learning:${key}`;
        if (proposal.changed) {
          // Sum sample counts from the relevant action types
          const actions = THRESHOLD_ACTION_MAP[key] || [];
          let sampleCount = 0;
          for (const act of actions) {
            sampleCount += decisionPatterns.byAction[act]?.entries?.length ?? 0;
          }
          if (sampleCount === 0) sampleCount = decisionPatterns.totalResolved;
          const change = applyParameter(fullKey, proposal.value, sampleCount,
            proposal.reason, dryRun);
          if (change) changes.push(change);
        }
      }
    }

    // Decision insights
    analysis.decisionInsights = getDecisionInsights();

    // ── 3. Reranker weight tuning (Phase 2) ─────────────────────────────────
    if (feedbackPatterns.totalFeedback >= PARAMETER_DEFS['learning:reranker_w_keyword'].minSamples) {
      const rerankerResult = tuneRerankerWeights();
      analysis.reranker = rerankerResult;
      if (rerankerResult.improved && rerankerResult.sampleCount >= 20) {
        for (const [name, key] of [['keyword', 'learning:reranker_w_keyword'], ['bm25', 'learning:reranker_w_bm25'], ['embedding', 'learning:reranker_w_embedding']]) {
          const change = applyParameter(key, rerankerResult.weights[name], rerankerResult.sampleCount,
            'Coordinate descent on feedback correlation', dryRun);
          if (change) changes.push(change);
        }
      }
    }

    // ── 4. Confidence threshold calibration (Phase 2) ───────────────────────
    if (feedbackPatterns.totalFeedback >= PARAMETER_DEFS['learning:conf_threshold_high'].minSamples) {
      const confResult = calibrateConfidenceThresholds();
      analysis.confidenceCalibration = confResult;
      if (confResult.calibrated) {
        for (const [level, key] of [['high', 'learning:conf_threshold_high'], ['medium', 'learning:conf_threshold_medium'], ['low', 'learning:conf_threshold_low']]) {
          const change = applyParameter(key, confResult[level], confResult.sampleCount,
            `Calibrated from ${(confResult.satisfactionRate * 100).toFixed(0)}% satisfaction rate`, dryRun);
          if (change) changes.push(change);
        }
      }
    }

    // ── 5. Ingestion drift detection (Phase 2) ──────────────────────────────
    analysis.ingestionDrift = detectIngestionDrift();

    // ── 6. Record cycle metadata ────────────────────────────────────────────
    if (!dryRun) {
      DatasetConfigRepo.set('learning:last_run', timestamp);
      DatasetConfigRepo.set('learning:last_changes_count', String(changes.length));
      logAudit('learning_cycle', 'dataset_config', 'learning',
        null, JSON.stringify({ changes: changes.length, timestamp }));
    }

    logger.info(`Learning cycle ${dryRun ? '(dry run) ' : ''}completed: ${changes.length} change(s)`);
  } catch (err) {
    logger.error(`Learning cycle failed: ${err.message}`);
    analysis.error = err.message;
  }

  return { changes, analysis, timestamp, dryRun };
}

/**
 * Get current learning status.
 * @returns {{ lastRun: string|null, lastChanges: number, parameters: Object }}
 */
export function getLearningStatus() {
  const lastRun = DatasetConfigRepo.get('learning:last_run');
  const lastChanges = parseInt(DatasetConfigRepo.get('learning:last_changes_count') || '0', 10);

  const parameters = {};
  for (const [key, def] of Object.entries(PARAMETER_DEFS)) {
    const stored = DatasetConfigRepo.get(key);
    parameters[key] = {
      label: def.label,
      category: def.category,
      current: stored != null ? parseFloat(stored) : def.default,
      default: def.default,
      isCustomized: stored != null,
      bounds: { floor: def.floor, ceiling: def.ceiling, maxStep: def.maxStep, minSamples: def.minSamples }
    };
  }

  // Add node penalties (not in PARAMETER_DEFS as it's a JSON blob)
  const nodePenaltiesJson = DatasetConfigRepo.get('learning:node_penalties_json');
  parameters['learning:node_penalties_json'] = {
    label: 'Node penalties',
    category: 'retrieval',
    current: nodePenaltiesJson ? JSON.parse(nodePenaltiesJson) : {},
    default: {},
    isCustomized: nodePenaltiesJson != null
  };

  return { lastRun, lastChanges, parameters };
}

/**
 * Get all learned parameters with their full metadata.
 */
export function getAllParameters() {
  const result = {};
  for (const [key, def] of Object.entries(PARAMETER_DEFS)) {
    const stored = DatasetConfigRepo.get(key);
    result[key] = {
      ...def,
      current: stored != null ? parseFloat(stored) : def.default,
      isCustomized: stored != null,
      storedValue: stored
    };
  }
  return result;
}

/**
 * Manually set a parameter (with bounds enforcement).
 * @param {string} key
 * @param {number} value
 * @returns {{ success: boolean, value?: number, error?: string }}
 */
export function setParameter(key, value) {
  const def = PARAMETER_DEFS[key];
  if (!def) return { success: false, error: `Unknown parameter: ${key}` };

  const num = parseFloat(value);
  if (!Number.isFinite(num)) return { success: false, error: 'Value must be a number' };

  const clamped = Math.max(def.floor, Math.min(def.ceiling, num));
  const oldValue = DatasetConfigRepo.get(key);
  DatasetConfigRepo.set(key, String(clamped));
  logAudit('learning_manual_set', 'dataset_config', key, oldValue, String(clamped));

  return { success: true, value: clamped };
}

/**
 * Reset a parameter to its default.
 * @param {string} key
 * @returns {{ success: boolean }}
 */
export function resetParameter(key) {
  // Allow resetting both PARAMETER_DEFS keys and special keys like node_penalties_json
  if (!PARAMETER_DEFS[key] && key !== 'learning:node_penalties_json' && key !== 'learning:knowledge_gaps_json') {
    return { success: false, error: `Unknown parameter: ${key}` };
  }
  const oldValue = DatasetConfigRepo.get(key);
  DatasetConfigRepo.delete(key);
  logAudit('learning_reset', 'dataset_config', key, oldValue, null);
  return { success: true };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Apply a parameter change with bounds enforcement and audit logging.
 */
function applyParameter(key, proposedValue, sampleCount, reason, dryRun) {
  const def = PARAMETER_DEFS[key];
  if (!def) return null;

  if (sampleCount < def.minSamples) return null;

  const currentStored = DatasetConfigRepo.get(key);
  const current = currentStored != null ? parseFloat(currentStored) : def.default;

  // Enforce max step
  let delta = proposedValue - current;
  if (Math.abs(delta) > def.maxStep) {
    delta = Math.sign(delta) * def.maxStep;
  }

  let newValue = Math.round((current + delta) * 1000) / 1000;
  newValue = Math.max(def.floor, Math.min(def.ceiling, newValue));

  if (newValue === current) return null;

  if (!dryRun) {
    DatasetConfigRepo.set(key, String(newValue));
    logAudit('learning_update', 'dataset_config', key,
      String(current), String(newValue));
  }

  return {
    key,
    label: def.label,
    oldValue: current,
    newValue,
    sampleCount,
    reason,
    dryRun
  };
}

export { PARAMETER_DEFS };
