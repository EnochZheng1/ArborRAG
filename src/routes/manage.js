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
import { ApiError } from "../utils/apiError.js";
import { requireBody } from "../utils/validate.js";

const router = express.Router();

/**
 * POST /manage/chat
 * Body: { message: string, sessionId?: string }
 */
router.post("/chat", async (req, res) => {
  try {
    requireBody(req.body, 'message');
    const { message, sessionId } = req.body;
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "message must be a non-empty string" } });
    }

    const result = await handleManageMessage(message.trim(), sessionId || null);
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error(`[manage:chat] ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
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
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error(`[manage:history] ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

/**
 * POST /manage/revert/:id
 */
router.post("/revert/:id", async (req, res) => {
  try {
    const auditId = parseInt(req.params.id, 10);
    if (isNaN(auditId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "Invalid audit ID" } });
    }

    const result = await revertChange(auditId);
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error(`[manage:revert] ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
