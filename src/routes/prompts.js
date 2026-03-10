/**
 * Prompt Routes
 *
 * CRUD for per-dataset LLM prompt overrides.
 * Mounted at /prompts in server.js (inside dataset middleware scope).
 */
import express from "express";
import {
  getAllPromptsWithStatus,
  getPromptOverride,
  setPromptOverride,
  deletePromptOverride,
  deleteAllPromptOverrides
} from "../prompts/promptManager.js";
import { PROMPT_CATALOG } from "../prompts/promptDefaults.js";
import { apiLogger as logger } from "../utils/logger.js";

const router = express.Router();

// ── GET /prompts — list all prompts with defaults and overrides ──────────────

router.get("/", (req, res) => {
  try {
    const prompts = getAllPromptsWithStatus();
    res.json({ prompts });
  } catch (err) {
    logger.error("GET /prompts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /prompts/:key — get a single prompt ─────────────────────────────────

router.get("/:key", (req, res) => {
  try {
    const { key } = req.params;
    const entry = PROMPT_CATALOG[key];
    if (!entry) return res.status(404).json({ error: `Unknown prompt key: ${key}` });

    const override = getPromptOverride(key);
    res.json({
      key,
      label: entry.label,
      category: entry.category,
      description: entry.description,
      variables: entry.variables,
      default_text: entry.default,
      current_text: override ?? entry.default,
      is_custom: override !== null
    });
  } catch (err) {
    logger.error(`GET /prompts/${req.params.key} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /prompts/:key — save a prompt override ──────────────────────────────

router.put("/:key", (req, res) => {
  try {
    const { key } = req.params;
    const { text } = req.body;

    if (!PROMPT_CATALOG[key]) {
      return res.status(404).json({ error: `Unknown prompt key: ${key}` });
    }
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "`text` is required and must be a non-empty string" });
    }

    setPromptOverride(key, text.trim());
    logger.info(`Prompt override saved: ${key}`);
    res.json({ ok: true, key, is_custom: true });
  } catch (err) {
    logger.error(`PUT /prompts/${req.params.key} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /prompts/:key — reset a single prompt to default ─────────────────

router.delete("/:key", (req, res) => {
  try {
    const { key } = req.params;
    if (!PROMPT_CATALOG[key]) {
      return res.status(404).json({ error: `Unknown prompt key: ${key}` });
    }

    deletePromptOverride(key);
    logger.info(`Prompt override reset: ${key}`);
    res.json({ ok: true, key, is_custom: false });
  } catch (err) {
    logger.error(`DELETE /prompts/${req.params.key} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /prompts/reset — reset ALL prompts to defaults ─────────────────────

router.post("/reset", (req, res) => {
  try {
    deleteAllPromptOverrides();
    logger.info("All prompt overrides reset to defaults");
    res.json({ ok: true });
  } catch (err) {
    logger.error("POST /prompts/reset error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
