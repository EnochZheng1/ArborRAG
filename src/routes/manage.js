/**
 * Manage API — conversational knowledge management chatbot.
 *
 * POST /manage/chat          — main chatbot endpoint
 * GET  /manage/history       — recent chatbot changes
 * POST /manage/revert/:id    — revert a specific change
 */

import express from "express";
import { handleManageMessage } from "../manage/index.js";
import { getRecentChanges, revertChange } from "../manage/actions/undoAction.js";
import { apiLogger as logger } from "../utils/logger.js";

const router = express.Router();

/**
 * POST /manage/chat
 * Body: { message: string, sessionId?: string }
 */
router.post("/chat", async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    const result = await handleManageMessage(message.trim(), sessionId || null);
    res.json(result);
  } catch (err) {
    logger.error(`[manage:chat] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /manage/history?limit=20
 */
router.get("/history", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const changes = getRecentChanges(limit);
    res.json({ changes });
  } catch (err) {
    logger.error(`[manage:history] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /manage/revert/:id
 */
router.post("/revert/:id", async (req, res) => {
  try {
    const auditId = parseInt(req.params.id, 10);
    if (isNaN(auditId)) {
      return res.status(400).json({ error: "Invalid audit ID" });
    }

    const result = await revertChange(auditId);
    res.json(result);
  } catch (err) {
    logger.error(`[manage:revert] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
