import express from "express";
import { ask, simpleAsk } from "../kg/qa.js";
import { classifyQuery } from "../query/classifier.js";
import { getSuggestions, getTrendingQueries, getExampleQueries } from "../query/suggestions.js";
import { recordFeedback, getFeedbackStats, getPoorlyPerformingQueries } from "../query/feedback.js";
import { apiLogger } from "../utils/logger.js";

const router = express.Router();

// ==================== Q&A ====================

// Main ask endpoint with intelligent routing
router.post("/ask", async (req, res) => {
  try {
    const { query, queryScope, options } = req.body || {};
    if (!query) return res.status(400).json({ error: "query required" });
    const result = await ask({ query, queryScope, options });
    res.json(result);
  } catch (err) {
    apiLogger.error("Ask error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simple ask (no classification, BM25 only)
router.post("/ask/simple", async (req, res) => {
  try {
    const { query, queryScope } = req.body || {};
    if (!query) return res.status(400).json({ error: "query required" });
    const result = await simpleAsk({ query, queryScope });
    res.json(result);
  } catch (err) {
    apiLogger.error("Simple ask error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Classify a query without answering
router.post("/classify", async (req, res) => {
  try {
    const { query, useLLM = true } = req.body || {};
    if (!query) return res.status(400).json({ error: "query required" });
    const classification = await classifyQuery(query, { useLLM });
    res.json(classification);
  } catch (err) {
    apiLogger.error("Classification error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SUGGESTIONS ====================

// Get autocomplete suggestions
router.get("/suggestions", (req, res) => {
  try {
    const { q, limit = 10, lang = "auto" } = req.query;
    const suggestions = getSuggestions(q, { limit: parseInt(limit), lang });
    res.json({ suggestions });
  } catch (err) {
    apiLogger.error("Get suggestions error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get trending queries
router.get("/suggestions/trending", (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const trending = getTrendingQueries(parseInt(limit));
    res.json({ trending });
  } catch (err) {
    apiLogger.error("Get trending error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get example queries for empty state
router.get("/suggestions/examples", (req, res) => {
  try {
    const { lang = "en" } = req.query;
    const examples = getExampleQueries(lang);
    res.json({ examples });
  } catch (err) {
    apiLogger.error("Get examples error:", err.message);
    res.status(500).json({ error: err.message });
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
    apiLogger.error("Record feedback error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get feedback statistics
router.get("/feedback/stats", (req, res) => {
  try {
    const { days = 30, queryType } = req.query;
    const stats = getFeedbackStats({ days: parseInt(days), queryType });
    res.json(stats);
  } catch (err) {
    apiLogger.error("Get feedback stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get poorly performing queries
router.get("/feedback/needs-improvement", (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const queries = getPoorlyPerformingQueries(parseInt(limit));
    res.json({ queries });
  } catch (err) {
    apiLogger.error("Get poorly performing queries error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
