import express from "express";
import { db } from "../db/db.js";
import { getTreeStats } from "../kg/graphTraversal.js";
import { getEmbeddingCoverage } from "../embedding/chunkEmbeddings.js";
import { getConflictStats } from "../ingest/conflictDetector.js";
import { getIngestionQueueStats } from "../ingest/jobQueue.js";
import { emptyTree, getSupportedExtensions } from "../ingest/index.js";
import { getTokenStats, cleanupTokenHistory } from "../utils/tokenTracker.js";
import { apiLogger } from "../utils/logger.js";

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
    const conflictStats = getConflictStats();
    const queueStats = getIngestionQueueStats();

    const docStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM documents
    `).get();

    const chunkStats = db.prepare(`
      SELECT COUNT(*) as total FROM chunks WHERE status = 'active'
    `).get();

    let extractionStats = { entities: 0, facts: 0, documents_extracted: 0 };
    try {
      const entityCount = db.prepare(`SELECT COUNT(*) as count FROM entities`).get();
      const factCount = db.prepare(`SELECT COUNT(*) as count FROM facts`).get();
      const docsExtracted = db.prepare(`
        SELECT COUNT(DISTINCT document_id) as count
        FROM chunks c
        JOIN fact_evidence fe ON c.id = fe.chunk_id
      `).get();
      extractionStats = {
        entities: entityCount?.count || 0,
        facts: factCount?.count || 0,
        documents_extracted: docsExtracted?.count || 0
      };
    } catch {
      // Tables may not exist yet
    }

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
    apiLogger.error("Get stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Token usage statistics
router.get("/stats/tokens", (req, res) => {
  try {
    const { since, operation, model } = req.query;
    const stats = getTokenStats({ since, operation, model });
    res.json(stats);
  } catch (err) {
    apiLogger.error("Get token stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clean up old token history
router.delete("/stats/tokens", (req, res) => {
  try {
    const { daysToKeep = 30 } = req.query;
    const deleted = cleanupTokenHistory(parseInt(daysToKeep));
    res.json({ success: true, deleted_records: deleted });
  } catch (err) {
    apiLogger.error("Cleanup token history error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Empty the entire tree (dangerous — requires ?confirm=yes)
router.delete("/tree", (req, res) => {
  try {
    if (req.query.confirm !== "yes") {
      return res.status(400).json({
        error: "Confirmation required",
        message: "Add ?confirm=yes to confirm tree deletion. This action cannot be undone!"
      });
    }
    apiLogger.warn("Emptying entire tree - user confirmed");
    const result = emptyTree();
    res.json({ success: true, ...result });
  } catch (err) {
    apiLogger.error("Empty tree error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
