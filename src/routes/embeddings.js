import express from "express";
import { syncEmbeddings, getEmbeddingCoverage } from "../embedding/chunkEmbeddings.js";
import { EmbeddingRepo } from "../db/repositories/EmbeddingRepo.js";
import { invalidateVectorCache } from "../kg/vectorTreeRouter.js";
import { apiLogger } from "../utils/logger.js";
import { ApiError } from "../utils/apiError.js";

const router = express.Router();

// Sync embeddings (generate for chunks missing them)
// ?force=true deletes all node embeddings first so they re-generate with enriched text
router.post("/embeddings/sync", async (req, res) => {
  try {
    const force = req.query.force === 'true';
    if (force) {
      const deleted = EmbeddingRepo.deleteAllByType('node');
      apiLogger.info(`Force re-embed: deleted ${deleted.changes} node embeddings`);
    }

    const result = await syncEmbeddings();

    // Refresh vector routing cache after embedding changes
    invalidateVectorCache();

    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Sync embeddings error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get embedding coverage stats
router.get("/embeddings/coverage", (req, res) => {
  try {
    const coverage = getEmbeddingCoverage();
    res.json(coverage);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get coverage error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
