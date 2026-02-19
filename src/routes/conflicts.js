import express from "express";
import { getUnresolvedConflicts, resolveConflict, getConflictStats } from "../ingest/conflictDetector.js";
import { apiLogger } from "../utils/logger.js";

const router = express.Router();

// Get unresolved conflicts
router.get("/conflicts", (req, res) => {
  try {
    const { nodeId } = req.query;
    const conflicts = getUnresolvedConflicts(nodeId);
    const stats = getConflictStats();
    res.json({ conflicts, stats });
  } catch (err) {
    apiLogger.error("Get conflicts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolve a conflict
router.post("/conflicts/:id/resolve", (req, res) => {
  try {
    const conflictId = parseInt(req.params.id);
    const { resolution, keepChunkId, archiveChunkId, notes } = req.body;
    if (!resolution) return res.status(400).json({ error: "resolution required" });
    const success = resolveConflict(conflictId, resolution, { keepChunkId, archiveChunkId, notes });
    res.json({ success });
  } catch (err) {
    apiLogger.error("Resolve conflict error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
