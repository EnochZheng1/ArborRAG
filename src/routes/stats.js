import express from "express";
import { DocumentRepo } from "../db/repositories/DocumentRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { EntityRepo } from "../db/repositories/EntityRepo.js";
import { getTreeStats } from "../kg/graphTraversal.js";
import { getEmbeddingCoverage } from "../embedding/chunkEmbeddings.js";
import { getIngestionQueueStats } from "../ingest/jobQueue.js";
import { emptyTree, getSupportedExtensions } from "../ingest/index.js";
import { getTokenStats, cleanupTokenHistory } from "../utils/tokenTracker.js";
import { apiLogger } from "../utils/logger.js";
import { ApiError } from "../utils/apiError.js";

const router = express.Router();

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    supported_file_types: getSupportedExtensions()
  });
});

// System stats
router.get("/stats", (req, res) => {
  try {
    const treeStats = getTreeStats();
    const embeddingCoverage = getEmbeddingCoverage();
    const conflictStats = { total: 0, unresolved: 0, resolved: 0 };
    const queueStats = getIngestionQueueStats();

    const docStats = DocumentRepo.getStats();
    const chunkStats = { total: ChunkRepo.countActive() };

    const extractionStats = {
      entities: EntityRepo.countAll(),
      facts: EntityRepo.countFacts(),
      documents_extracted: EntityRepo.countDocumentsExtracted()
    };

    res.json({
      nodes: treeStats,
      documents: docStats,
      chunks: { active: chunkStats.total },
      embeddings: embeddingCoverage,
      conflicts: conflictStats,
      extraction: extractionStats,
      queue: queueStats
    });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get stats error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Token usage statistics
router.get("/stats/tokens", (req, res) => {
  try {
    const { since, operation, model } = req.query;
    const stats = getTokenStats({ since, operation, model });
    res.json(stats);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get token stats error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Clean up old token history
router.delete("/stats/tokens", (req, res) => {
  try {
    const { daysToKeep = 30 } = req.query;
    const deleted = cleanupTokenHistory(parseInt(daysToKeep));
    res.json({ success: true, deleted_records: deleted });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Cleanup token history error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Empty the entire tree (dangerous — requires ?confirm=yes)
router.delete("/tree", (req, res) => {
  try {
    if (req.query.confirm !== "yes") {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: "Confirmation required. Add ?confirm=yes to confirm tree deletion. This action cannot be undone!" }
      });
    }
    apiLogger.warn("Emptying entire tree - user confirmed");
    const result = emptyTree();
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Empty tree error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
