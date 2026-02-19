import express from "express";
import { syncEmbeddings, getEmbeddingCoverage } from "../embedding/chunkEmbeddings.js";
import { apiLogger } from "../utils/logger.js";

const router = express.Router();

// Sync embeddings (generate for chunks missing them)
router.post("/embeddings/sync", async (req, res) => {
  try {
    const result = await syncEmbeddings();
    res.json(result);
  } catch (err) {
    apiLogger.error("Sync embeddings error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get embedding coverage stats
router.get("/embeddings/coverage", (req, res) => {
  try {
    const coverage = getEmbeddingCoverage();
    res.json(coverage);
  } catch (err) {
    apiLogger.error("Get coverage error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
