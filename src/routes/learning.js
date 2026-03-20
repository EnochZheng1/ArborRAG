/**
 * Learning Routes — REST API for the self-learning system.
 *
 * GET  /learning/status              — Last cycle results, current learned parameters
 * POST /learning/run                 — Trigger immediate cycle (?dryRun=true option)
 * GET  /learning/insights            — Knowledge gaps, poorly performing queries, decision patterns
 * GET  /learning/parameters          — All learned params with bounds and data source
 * PUT  /learning/parameters/:key     — Manual override
 * DELETE /learning/parameters/:key   — Reset to default
 * GET  /learning/gaps                — Prioritized knowledge gaps
 * GET  /learning/gaps/suggestions    — Document ingestion suggestions
 * GET  /learning/prompt-effectiveness — Prompt override impact
 */

import { Router } from "express";
import {
  runLearningCycle,
  getLearningStatus,
  getAllParameters,
  setParameter,
  resetParameter
} from "../learning/learningJob.js";
import {
  analyzeFeedbackPatterns,
  identifyKnowledgeGaps
} from "../learning/feedbackAnalyzer.js";
import { getDecisionInsights } from "../learning/decisionAnalyzer.js";
import { tuneRerankerWeights } from "../learning/rerankerTuner.js";
import { calibrateConfidenceThresholds } from "../learning/confidenceCalibrator.js";
import { getIngestionTrend, detectIngestionDrift } from "../learning/ingestionTracker.js";
import { detectKnowledgeGaps, suggestDocumentsToIngest } from "../learning/gapDetector.js";
import { getPromptImpactReport } from "../learning/promptTracker.js";
import { logger } from "../utils/logger.js";

const router = Router();

// GET /learning/status
router.get("/status", (req, res) => {
  try {
    const status = getLearningStatus();
    res.json(status);
  } catch (err) {
    logger.warn(`GET /learning/status failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// POST /learning/run
router.post("/run", (req, res) => {
  try {
    const dryRun = req.query.dryRun === "true" || req.body?.dryRun === true;
    const result = runLearningCycle({ dryRun });
    res.json(result);
  } catch (err) {
    logger.warn(`POST /learning/run failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// GET /learning/insights
router.get("/insights", (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const feedbackPatterns = analyzeFeedbackPatterns(days);
    const knowledgeGaps = identifyKnowledgeGaps(days);
    const decisionInsights = getDecisionInsights();
    const rerankerAnalysis = tuneRerankerWeights();
    const confidenceAnalysis = calibrateConfidenceThresholds();
    const ingestionTrend = getIngestionTrend(days);
    const ingestionDrift = detectIngestionDrift();

    res.json({
      feedback: feedbackPatterns,
      knowledgeGaps,
      decisions: decisionInsights,
      reranker: rerankerAnalysis,
      confidence: confidenceAnalysis,
      ingestion: { trend: ingestionTrend, drift: ingestionDrift }
    });
  } catch (err) {
    logger.warn(`GET /learning/insights failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// GET /learning/parameters
router.get("/parameters", (req, res) => {
  try {
    const params = getAllParameters();
    res.json(params);
  } catch (err) {
    logger.warn(`GET /learning/parameters failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// PUT /learning/parameters/:key
router.put("/parameters/:key", (req, res) => {
  try {
    const key = `learning:${req.params.key}`;
    const { value } = req.body;
    if (value == null) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "value is required" } });
    }
    const result = setParameter(key, value);
    if (!result.success) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: result.error } });
    }
    res.json(result);
  } catch (err) {
    logger.warn(`PUT /learning/parameters failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// DELETE /learning/parameters/:key
router.delete("/parameters/:key", (req, res) => {
  try {
    const key = `learning:${req.params.key}`;
    const result = resetParameter(key);
    if (!result.success) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: result.error } });
    }
    res.json(result);
  } catch (err) {
    logger.warn(`DELETE /learning/parameters failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// GET /learning/gaps
router.get("/gaps", (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const gaps = detectKnowledgeGaps(days);
    res.json({ gaps, total: gaps.length });
  } catch (err) {
    logger.warn(`GET /learning/gaps failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// GET /learning/gaps/suggestions
router.get("/gaps/suggestions", (req, res) => {
  try {
    const suggestions = suggestDocumentsToIngest();
    res.json({ suggestions, total: suggestions.length });
  } catch (err) {
    logger.warn(`GET /learning/gaps/suggestions failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

// GET /learning/prompt-effectiveness
router.get("/prompt-effectiveness", (req, res) => {
  try {
    const report = getPromptImpactReport();
    res.json(report);
  } catch (err) {
    logger.warn(`GET /learning/prompt-effectiveness failed: ${err.message}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  }
});

export default router;
