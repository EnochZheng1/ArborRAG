/**
 * Centralised LLM JSON parsing with automatic repair fallback.
 *
 * All LLM call sites that expect a JSON response should use parseLLMJson()
 * instead of calling JSON.parse() directly.
 *
 * Repair pipeline (each step only runs if the previous failed):
 *  1. Strip markdown fences + extract best JSON candidate
 *  2. JSON.parse — success → return
 *  3. Rule-based repair (trailing commas, unquoted/single-quoted keys, comments)
 *     → JSON.parse — success → return (DEBUG log)
 *  4. LLM repair pass → JSON.parse — success → return (DEBUG log)
 *  5. All failed → return fallback (WARN log)
 *
 * Log levels:
 *  - DEBUG: initial parse failure + successful auto-repair (normal, expected noise)
 *  - WARN:  all repair attempts failed and fallback is returned
 */

import { callLLM } from './llm.js';
import { logger } from './logger.js';

// ── Candidate extraction ──────────────────────────────────────────────────────

/** Remove markdown code fences and surrounding whitespace. */
function stripFences(text) {
  if (!text) return '';
  return text
    .replace(/^```(?:json|js|javascript)?\s*/im, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
}

/**
 * Yield every top-level balanced {…} or […] structure found in text.
 * Handles double-quoted strings (skips content between matching quotes).
 * Does NOT handle single-quoted strings — those are repaired separately.
 */
function* allBalanced(text, openChar, closeChar) {
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(openChar, pos);
    if (start === -1) return;

    let depth = 0;
    let inStr = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape)          { escape = false; continue; }
      if (inStr) {
        if (ch === '\\')   { escape = true; continue; }
        if (ch === '"')    { inStr = false; }
        continue;
      }
      if (ch === '"')      { inStr = true; continue; }
      if (ch === openChar) { depth++; }
      else if (ch === closeChar) {
        if (--depth === 0) { end = i; break; }
      }
    }

    if (end !== -1) {
      yield text.slice(start, end + 1);
      pos = end + 1;
    } else {
      pos = start + 1; // unbalanced from this start — skip ahead
    }
  }
}

/**
 * Return candidate JSON substrings to try, ordered by likelihood:
 *  - All balanced structures of the expected shape, sorted by length desc
 *    (longer = more likely to be the real JSON)
 *  - Full stripped text as last resort
 */
function getCandidates(stripped, hint) {
  const found = [];

  if (hint === 'object' || hint === 'any') {
    for (const c of allBalanced(stripped, '{', '}')) found.push(c);
  }
  if (hint === 'array' || hint === 'any') {
    for (const c of allBalanced(stripped, '[', ']')) found.push(c);
  }

  // Sort by descending length — the real JSON is typically the largest structure
  found.sort((a, b) => b.length - a.length);

  // Deduplicate
  const seen = new Set();
  const result = [];
  for (const c of found) {
    if (!seen.has(c)) { seen.add(c); result.push(c); }
  }

  // Always include full text as final fallback
  if (!seen.has(stripped)) result.push(stripped);

  return result;
}

// ── Rule-based repair ─────────────────────────────────────────────────────────

/**
 * Fix the most common LLM JSON formatting mistakes without an LLM call.
 *
 * Handles:
 *  1. JS-style line comments: // ...
 *  2. JS-style block comments: /* ... *\/
 *  3. Trailing commas before } or ]
 *  4. Unquoted object keys:      { key: value } → { "key": value }
 *  5. Single-quoted object keys: {'key': value} → {"key": value}
 */
function repairRuleBased(text) {
  let s = text;

  // 1. Strip line comments (careful not to strip // inside strings — best-effort)
  s = s.replace(/\/\/[^\n\r"]*/g, '');

  // 2. Strip block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');

  // 3. Remove trailing commas before } or ] (repeat until stable for nested structures)
  let prev;
  do {
    prev = s;
    s = s.replace(/,(\s*[}\]])/g, '$1');
  } while (s !== prev);

  // 4. Quote unquoted identifier keys: { key: → { "key":
  s = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

  // 5. Single-quoted property keys only: {'key': → {"key":
  //    (only keys, not values, to avoid apostrophe issues in string content)
  s = s.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, (_, pre, key) =>
    `${pre}"${key.replace(/"/g, '\\"')}":` // escape any " inside the key
  );

  return s.trim();
}

// ── LLM repair (last resort) ──────────────────────────────────────────────────

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
 * @param {string}  text                    Raw LLM response text
 * @param {'object'|'array'|'any'} hint     Expected JSON shape
 * @param {object}  [options]
 * @param {*}       [options.fallback=null] Returned when all parsing fails
 * @param {string}  [options.context='']   Label shown in log lines
 * @returns {Promise<*>}
 */
export async function parseLLMJson(text, hint = 'any', { fallback = null, context = '' } = {}) {
  if (!text) return fallback;

  const label = context || hint;
  const stripped = stripFences(text);
  const candidates = getCandidates(stripped, hint);

  // Step 1 — direct parse of each candidate
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (_) {}
  }

  // Step 2 — rule-based repair on each candidate
  for (const c of candidates) {
    const fixed = repairRuleBased(c);
    if (fixed === c) continue; // no change — skip
    try {
      const result = JSON.parse(fixed);
      logger.debug(`[parseJSON] Auto-repaired (rules) (${label})`);
      return result;
    } catch (_) {}
  }

  // All rule-based attempts failed — log once at debug before trying LLM
  logger.debug(`[parseJSON] Rule-based repair insufficient (${label}) — trying LLM repair`);

  // Step 3 — LLM repair pass (use the best/largest candidate)
  const bestCandidate = candidates[0] ?? stripped;
  const repaired = await repairWithLLM(bestCandidate, hint, context);
  if (repaired) {
    // Try direct parse first, then rule-based repair of the LLM output
    for (const r of [repaired, repairRuleBased(repaired)]) {
      try {
        const result = JSON.parse(r);
        logger.debug(`[parseJSON] Auto-repaired (LLM) (${label})`);
        return result;
      } catch (_) {}
    }
    logger.warn(`[parseJSON] Post-LLM-repair parse failed (${label})`);
  }

  // Step 4 — all failed
  logger.warn(`[parseJSON] All repair attempts failed (${label}), returning fallback`);
  return fallback;
}
