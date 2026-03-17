import express from "express";
import { ask, simpleAsk } from "../kg/qa.js";
import { classifyQuery } from "../query/classifier.js";
import { getSuggestions, getTrendingQueries, getExampleQueries } from "../query/suggestions.js";
import { recordFeedback, getFeedbackStats, getPoorlyPerformingQueries } from "../query/feedback.js";
import { apiLogger } from "../utils/logger.js";
import { ApiError } from "../utils/apiError.js";
import { requireBody } from "../utils/validate.js";

const router = express.Router();

// ==================== Q&A ====================

// Main ask endpoint with intelligent routing
router.post("/ask", async (req, res) => {
  try {
    requireBody(req.body, 'query');
    const { query, queryScope, options } = req.body;
    const result = await ask({ query, queryScope, options });
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Ask error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Simple ask (no classification, BM25 only)
router.post("/ask/simple", async (req, res) => {
  try {
    requireBody(req.body, 'query');
    const { query, queryScope } = req.body;
    const result = await simpleAsk({ query, queryScope });
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Simple ask error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Classify a query without answering
router.post("/classify", async (req, res) => {
  try {
    requireBody(req.body, 'query');
    const { query, useLLM = true } = req.body;
    const classification = await classifyQuery(query, { useLLM });
    res.json(classification);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Classification error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ==================== SUGGESTIONS ====================

// Get autocomplete suggestions
router.get("/suggestions", (req, res) => {
  try {
    const { q, lang = "auto" } = req.query;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const suggestions = getSuggestions(q, { limit, lang });
    res.json({ suggestions });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get suggestions error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get trending queries
router.get("/suggestions/trending", (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
    const trending = getTrendingQueries(limit);
    res.json({ trending });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get trending error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get example queries for empty state
router.get("/suggestions/examples", (req, res) => {
  try {
    const { lang = "en" } = req.query;
    const examples = getExampleQueries(lang);
    res.json({ examples });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get examples error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ==================== FEEDBACK ====================

// Record feedback on an answer
router.post("/feedback", (req, res) => {
  try {
    const result = recordFeedback(req.body);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Record feedback error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get feedback statistics
router.get("/feedback/stats", (req, res) => {
  try {
    const { days = 30, queryType } = req.query;
    const stats = getFeedbackStats({ days: parseInt(days), queryType });
    res.json(stats);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get feedback stats error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get poorly performing queries
router.get("/feedback/needs-improvement", (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const queries = getPoorlyPerformingQueries(limit);
    res.json({ queries });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get poorly performing queries error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
