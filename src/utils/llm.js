/**
 * Central LLM provider abstraction.
 *
 * Supports OpenAI and Gemini. Provider, model names, and API keys are read
 * from environment variables at startup and can be changed at runtime via
 * updateLlmConfig() (Settings API).
 *
 * All LLM call sites import callLLM() from this module instead of using
 * provider-specific SDKs directly.
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { logger } from "./logger.js";
import { recordTokenUsage } from "./tokenTracker.js";

// Per-call LLM timeout: 8 minutes. Long enough for big-document KP extraction,
// short enough to detect a truly hung network call and release the retry budget.
const LLM_TIMEOUT_MS = Math.max(
  30_000,
  Number.parseInt(process.env.LLM_TIMEOUT_MS || "480000", 10) || 480_000
);

// ── Runtime-mutable config ────────────────────────────────────────────────────

export const llmConfig = {
  provider: process.env.LLM_PROVIDER || 'openai',
  openai: {
    model:          process.env.OPENAI_MODEL           || 'gpt-5-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large',
    apiKey:         process.env.OPENAI_API_KEY         || '',
  },
  gemini: {
    model:          process.env.GEMINI_MODEL           || 'gemini-2.0-flash',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
    apiKey:         process.env.GEMINI_API_KEY         || '',
  },
};

/**
 * Update runtime config (changes propagate immediately to all subsequent calls).
 * Passing openai or gemini sub-objects resets the corresponding lazy client.
 */
export function updateLlmConfig(patch) {
  if (patch.provider !== undefined) llmConfig.provider = patch.provider;
  if (patch.openai) {
    Object.assign(llmConfig.openai, patch.openai);
    _openai = null; // force client re-init
  }
  if (patch.gemini) {
    Object.assign(llmConfig.gemini, patch.gemini);
    _gemini = null;
  }
}

// ── Lazy client instances ─────────────────────────────────────────────────────

let _openai = null;
let _gemini = null;

function openaiClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: llmConfig.openai.apiKey });
  return _openai;
}

function geminiClient() {
  if (!_gemini) _gemini = new GoogleGenAI({ apiKey: llmConfig.gemini.apiKey });
  return _gemini;
}

// Track which models don't support temperature (auto-detected on first failure)
const _noTemperatureModels = new Set();

// ── Primary call function ─────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1000, 5000, 15000]; // delays before attempts 2, 3, 4

function isTransientError(err) {
  const status = err.status ?? err.statusCode;
  if (status === 429 || status === 503 || status === 502 || status === 504) return true;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') return true;
  // OpenAI SDK wraps some network errors in a generic Error
  if (/timeout|ETIMEDOUT|ECONNRESET|503|502|529/i.test(err.message)) return true;
  return false;
}

/**
 * Call the configured LLM and return the response text.
 * Automatically retries up to 3 times on transient errors (429, 503, timeouts)
 * with exponential back-off (1 s → 5 s → 15 s).
 *
 * @param {{ prompt: string, temperature?: number, maxOutputTokens?: number, seed?: number, taskName?: string }} opts
 * @returns {Promise<string>}
 */
export async function callLLM(opts = {}) {
  const taskName = opts.taskName || 'llm_call';
  let lastErr;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      logger.warn(`[${taskName}] Transient error — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}): ${lastErr?.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      return await _callLLMOnce(opts);
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === RETRY_DELAYS_MS.length) throw err;
    }
  }

  throw lastErr; // unreachable — satisfies linter
}

async function _callLLMOnce({
  prompt,
  temperature     = 0.2,
  maxOutputTokens = null,
  seed            = null,
  taskName        = 'llm_call',
} = {}) {
  if (llmConfig.provider === 'openai') {
    if (!llmConfig.openai.apiKey) throw new Error('OPENAI_API_KEY is not configured');

    const model = llmConfig.openai.model;
    const baseParams = {
      model,
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: 'minimal',
      verbosity: 'low',
      // Only set max_completion_tokens when explicitly requested
      ...(maxOutputTokens != null && { max_completion_tokens: maxOutputTokens }),
      // Seed for reproducible outputs — ensures same prompt → same response
      ...(seed != null && { seed }),
    };

    // Some models (o-series reasoning models) reject custom temperature values.
    // Auto-detect on first failure and remember for subsequent calls.
    const withTemp = !_noTemperatureModels.has(model);
    let resp;
    try {
      const signal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      resp = await openaiClient().chat.completions.create(
        withTemp ? { ...baseParams, temperature } : baseParams,
        { signal }
      );
    } catch (err) {
      if (withTemp && err.status === 400 && err.message?.toLowerCase().includes('temperature')) {
        _noTemperatureModels.add(model);
        logger.info(`Model '${model}' does not support custom temperature — disabling for future calls`);
        const signal = AbortSignal.timeout(LLM_TIMEOUT_MS);
        resp = await openaiClient().chat.completions.create(baseParams, { signal });
      } else {
        throw err;
      }
    }

    recordTokenUsage(
      { usageMetadata: { totalTokenCount: resp.usage?.total_tokens ?? 0 } },
      taskName,
      { provider: 'openai', model: llmConfig.openai.model }
    );

    const choice   = resp.choices[0];
    const content  = choice?.message?.content?.trim() ?? '';
    const reason   = choice?.finish_reason;
    const usage    = resp.usage;

    if (!content) {
      // Diagnose why content is empty
      const refusal = choice?.message?.refusal;
      if (refusal) {
        logger.warn(`[${taskName}] OpenAI refused: ${refusal}`);
      } else if (reason === 'length') {
        logger.warn(
          `[${taskName}] OpenAI hit token limit. ` +
          `Usage: prompt=${usage?.prompt_tokens}, completion=${usage?.completion_tokens}, ` +
          `reasoning=${usage?.completion_tokens_details?.reasoning_tokens ?? 'n/a'}.`
        );
      } else {
        logger.warn(`[${taskName}] OpenAI returned empty content (finish_reason=${reason})`);
      }
    }

    return content;

  } else {
    if (!llmConfig.gemini.apiKey) throw new Error('GEMINI_API_KEY is not configured');

    let _geminiTimeoutId;
    const resp = await Promise.race([
      geminiClient().models.generateContent({
        model:    llmConfig.gemini.model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config:   { temperature, maxOutputTokens },
      }),
      new Promise((_, reject) => {
        _geminiTimeoutId = setTimeout(
          () => reject(new Error(`Gemini LLM call timed out after ${LLM_TIMEOUT_MS / 1000}s`)),
          LLM_TIMEOUT_MS
        );
      })
    ]).finally(() => clearTimeout(_geminiTimeoutId));

    recordTokenUsage(resp, taskName, { provider: 'gemini', model: llmConfig.gemini.model });

    return (
      resp.text ??
      resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ??
      ''
    ).trim();
  }
}

// ── Config helpers ────────────────────────────────────────────────────────────

export const getCurrentProvider      = () => llmConfig.provider;
export const getCurrentLlmModel      = () =>
  llmConfig.provider === 'openai' ? llmConfig.openai.model      : llmConfig.gemini.model;
export const getCurrentEmbedModel    = () =>
  llmConfig.provider === 'openai' ? llmConfig.openai.embeddingModel : llmConfig.gemini.embeddingModel;
