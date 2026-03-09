/**
 * Settings API — runtime LLM configuration.
 *
 * GET  /settings/llm  → { provider, model, embeddingModel, openaiConfigured, geminiConfigured }
 * POST /settings/llm  → { provider?, model?, embeddingModel? } → updates config, returns new state
 */

import express from "express";
import { llmConfig, updateLlmConfig } from "../utils/llm.js";
import { apiLogger as logger } from "../utils/logger.js";

const router = express.Router();

function currentState() {
  const p = llmConfig.provider;
  return {
    provider:        p,
    model:           llmConfig[p].model,
    embeddingModel:  llmConfig[p].embeddingModel,
    openaiConfigured: !!llmConfig.openai.apiKey,
    geminiConfigured: !!llmConfig.gemini.apiKey,
  };
}

// ── GET /settings/llm ─────────────────────────────────────────────────────────

router.get("/settings/llm", (req, res) => {
  try {
    res.json(currentState());
  } catch (err) {
    logger.error("GET /settings/llm error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /settings/llm ────────────────────────────────────────────────────────

router.post("/settings/llm", (req, res) => {
  try {
    const { provider, model, embeddingModel } = req.body || {};

    if (provider !== undefined && provider !== 'openai' && provider !== 'gemini') {
      return res.status(400).json({ error: "provider must be 'openai' or 'gemini'" });
    }

    const patch = {};
    if (provider) patch.provider = provider;

    const targetProvider = provider || llmConfig.provider;
    if (model || embeddingModel) {
      patch[targetProvider] = {};
      if (model)          patch[targetProvider].model          = model;
      if (embeddingModel) patch[targetProvider].embeddingModel = embeddingModel;
    }

    updateLlmConfig(patch);
    const state = currentState();
    logger.info(`LLM config updated: provider=${state.provider} model=${state.model}`);
    res.json(state);
  } catch (err) {
    logger.error("POST /settings/llm error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
