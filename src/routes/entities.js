import express from "express";
import {
  getEntitiesWithFacts,
  getEntityFacts,
  searchFacts,
  getExtractionStats,
  getDocumentsNeedingExtraction,
  bulkExtractEntities
} from "../extraction/entityFactExtractor.js";
import {
  getEntityGraph,
  compareEntities,
  getFactsForQuestion,
  verifyClaim
} from "../extraction/entityFactRetriever.js";
import { apiLogger } from "../utils/logger.js";
import { ApiError } from "../utils/apiError.js";
import { requireBody } from "../utils/validate.js";

const router = express.Router();

// ==================== ENTITIES ====================

// Get all entities (with optional type / nodeId filter)
router.get("/entities", (req, res) => {
  try {
    const { type, nodeId, limit = 50 } = req.query;
    const entities = getEntitiesWithFacts({ type, nodeId, limit: parseInt(limit) });
    res.json({ entities, count: entities.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get entities error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Compare entities side-by-side (must come before /:name to avoid route collision)
router.post("/entities/compare", (req, res) => {
  try {
    const { entities } = req.body;
    if (!entities || entities.length < 2) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "At least 2 entity names required" } });
    }
    const comparison = compareEntities(entities);
    res.json(comparison);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Compare entities error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get entity by name with its facts
router.get("/entities/:name", (req, res) => {
  try {
    const entity = getEntityFacts(decodeURIComponent(req.params.name));
    if (!entity) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Entity not found" } });
    res.json(entity);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get entity error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get entity relationship graph
router.get("/entities/:name/graph", (req, res) => {
  try {
    const { depth = 2 } = req.query;
    const graph = getEntityGraph(decodeURIComponent(req.params.name), parseInt(depth));
    res.json(graph);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get entity graph error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ==================== FACTS ====================

// Search facts by keyword
router.get("/facts/search", (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "Query parameter 'q' is required" } });
    const facts = searchFacts(q, parseInt(limit));
    res.json({ facts, count: facts.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Search facts error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Retrieve facts relevant to a question
router.post("/facts/retrieve", (req, res) => {
  try {
    requireBody(req.body, 'question');
    const { question, maxFacts = 15, maxEvidence = 10 } = req.body;
    const result = getFactsForQuestion(question, { maxFacts, maxEvidence });
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Retrieve facts error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Verify a claim against stored facts
router.post("/facts/verify", (req, res) => {
  try {
    requireBody(req.body, 'claim');
    const { claim } = req.body;
    const result = verifyClaim(claim);
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Verify claim error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ==================== EXTRACTION ====================

// Get extraction statistics
router.get("/extraction/stats", (req, res) => {
  try {
    res.json(getExtractionStats());
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get extraction stats error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get documents awaiting entity extraction
router.get("/extraction/pending", (req, res) => {
  try {
    const docs = getDocumentsNeedingExtraction();
    res.json({ documents: docs, count: docs.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get pending extraction error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Bulk-extract entities for all pending documents
router.post("/extraction/bulk", async (req, res) => {
  try {
    const { maxDocuments = 10, useLLM = true } = req.body;
    apiLogger.info(`Starting bulk entity extraction (max ${maxDocuments} documents)`);
    const result = await bulkExtractEntities({ maxDocuments, useLLM });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Bulk extraction error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
