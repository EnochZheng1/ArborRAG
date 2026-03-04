/**
 * Centralised LLM JSON parsing with automatic repair fallback.
 *
 * All LLM call sites that expect a JSON response should use parseLLMJson()
 * instead of calling JSON.parse() directly.  On the first parse failure the
 * broken text is sent back to the LLM for a single repair attempt; if that
 * also fails the caller-supplied fallback value is returned.
 *
 * Usage:
 *   import { parseLLMJson } from '../utils/parseJSON.js';
 *
 *   const result = await parseLLMJson(llmText, 'object', {
 *     fallback: null,
 *     context:  'kp_normalize',   // appears in log lines for tracing
 *   });
 */

import { callLLM } from './llm.js';
import { logger } from './logger.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Remove markdown code fences and surrounding whitespace. */
function stripFences(text) {
  if (!text) return '';
  return text
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
}

/**
 * Extract the most-likely JSON substring from LLM output based on the
 * expected shape.  Falls back to the full text if no match is found.
 *
 * @param {string} text  - fence-stripped LLM output
 * @param {'object'|'array'|'any'} hint
 */
function extractCandidate(text, hint) {
  if (hint === 'array') {
    const m = text.match(/\[[\s\S]*\]/);
    return m ? m[0] : text;
  }
  if (hint === 'object') {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? m[0] : text;
  }
  return text; // 'any' — use the full stripped text
}

/**
 * Ask the LLM to fix a broken JSON string.
 * Returns the repaired candidate string (fences stripped), or null on failure.
 */
async function repairWithLLM(brokenText, hint, context) {
  const shapeLabel = hint === 'array'  ? 'a JSON array'
                   : hint === 'object' ? 'a JSON object'
                   : 'a JSON value';

  const prompt =
    `The following text was supposed to be ${shapeLabel} but failed to parse as JSON.\n` +
    `Fix it and return ONLY the corrected JSON — no explanation, no markdown fences.\n\n` +
    `Broken input:\n${brokenText.slice(0, 3000)}`;

  try {
    const repaired = await callLLM({ prompt, temperature: 0.0, taskName: 'json_repair' });
    return repaired ? stripFences(repaired.trim()) : null;
  } catch (err) {
    logger.warn(`[parseJSON] LLM repair call failed (${context}): ${err.message}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse an LLM response that is expected to contain JSON.
 *
 * Steps:
 *  1. Strip markdown fences
 *  2. Extract a JSON candidate by shape hint
 *  3. JSON.parse → return on success
 *  4. On failure: send to LLM for one repair attempt → JSON.parse → return on success
 *  5. On final failure: return fallback
 *
 * @param {string}  text                    Raw LLM response text
 * @param {'object'|'array'|'any'} hint     Expected JSON shape
 * @param {object}  [options]
 * @param {*}       [options.fallback=null] Returned when all parsing fails
 * @param {string}  [options.context='']   Label shown in warning log lines
 * @returns {Promise<*>}
 */
export async function parseLLMJson(text, hint = 'any', { fallback = null, context = '' } = {}) {
  if (!text) return fallback;

  // Step 1 & 2 — strip fences and extract shape candidate
  const stripped  = stripFences(text);
  const candidate = extractCandidate(stripped, hint);

  // Step 3 — direct parse
  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    logger.warn(
      `[parseJSON] Initial parse failed (${context || hint}): ${firstErr.message.slice(0, 120)}`
    );
  }

  // Step 4 — LLM repair pass
  const repaired = await repairWithLLM(candidate, hint, context);
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch (secondErr) {
      logger.warn(
        `[parseJSON] Post-repair parse failed (${context || hint}): ${secondErr.message.slice(0, 120)}`
      );
    }
  }

  // Step 5 — all failed
  return fallback;
}
