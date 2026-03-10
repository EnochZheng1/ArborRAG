/**
 * KP Decision Engine
 *
 * For each incoming Knowledge Point destined for a target node, resolves
 * what action to take: IGNORE, MERGE, REPLACE, NORMALIZE_THEN_STORE, or STORE.
 *
 * High-confidence decisions execute automatically.
 * Borderline cases are recorded in pending_decisions for human review.
 */

import { callLLM, isLlmConfigured } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { safeJson } from "../db/db.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { DecisionRepo } from "../db/repositories/DecisionRepo.js";
import { wordDiceSimilarity } from "./knowledgeExtractor.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { getCustomPrompt } from "../prompts/promptManager.js";

// ── Thresholds ────────────────────────────────────────────────────────────────

const IGNORE_CONF_THRESHOLD   = 0.35;
const IGNORE_MIN_LENGTH       = 15;
const MERGE_AUTO_THRESHOLD    = 0.90;
const MERGE_QUEUE_THRESHOLD   = 0.70;
const REPLACE_AUTO_CONF       = 0.85;

// ── Authority ranks ───────────────────────────────────────────────────────────

function authorityRank(level) {
  const map = { policy: 3, sop: 2, training: 1, personal: 0 };
  return map[String(level).toLowerCase()] ?? 1;
}

// ── Boilerplate detection ─────────────────────────────────────────────────────

const BOILERPLATE_PATTERNS = [
  /^page\s+\d+(\s+of\s+\d+)?$/i,
  /^chapter\s+\d+/i,
  /^\d+\s*\/\s*\d+$/,               // "3 / 12" style page marker
  /^(table of contents|toc)$/i,
  /^last\s+(modified|updated|revised)/i,
  /^(confidential|internal use only|proprietary)$/i,
  /^(header|footer):/i,
  /^\s*[\d]+\s*$/,                   // lone number
  /^draft(\s*[-–—]\s*.+)?$/i,        // "DRAFT" or "DRAFT - Do Not Distribute"
  /^do\s+not\s+(distribute|copy|reproduce|share)/i,
  /^all\s+rights\s+reserved/i,
  /^copyright\s*©?\s*\d{4}/i,
  /^\[\s*\]$/,                       // empty brackets placeholder
  /^(version|rev\.?|revision)\s*\d[\d.]*$/i,  // "Version 1.2", "Rev 3"
];

function isBoilerplate(content) {
  const trimmed = content.trim();
  return BOILERPLATE_PATTERNS.some(re => re.test(trimmed));
}

// ── Temporal signal detection ─────────────────────────────────────────────────

const TEMPORAL_PATTERNS = [
  /\bas\s+of\b/i,
  /\bupdated\b/i,
  /\beffective\b/i,
  /\brevised\b/i,
  /\bnew\b/i,
  /\b(since|from)\s+\d{4}\b/i,
  // Require the year to appear in an unambiguous date context (ISO date, quarter, or
  // spelled-out month) so product codes like "Model 2024X" or form IDs like "ISO 20243"
  // do not falsely trigger a REPLACE action.
  /\b20\d{2}-\d{2}(?:-\d{2})?\b/,                // 2024-01 or 2024-01-15
  /\bQ[1-4]\s*20\d{2}\b/i,                        // Q1 2024
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,.\s]+20\d{2}\b/i,
];

function detectTemporalSignal(content) {
  return TEMPORAL_PATTERNS.some(re => re.test(content));
}

// ── LLM helpers ───────────────────────────────────────────────────────────────

async function normalizeWithLLM(kpContent, existingContent) {
  if (!isLlmConfigured()) return null;

  const prompt = getCustomPrompt('kpNormalization', {
    statementA: kpContent.slice(0, 400),
    statementB: existingContent.slice(0, 400)
  }) ?? `Two knowledge statements are about the same topic. Merge them into one canonical statement.

Rules:
1. Preserve ALL specific numbers, percentages, durations, and dates from BOTH statements (e.g., "90 days", "85%", "7 hours").
2. When one statement is more specific than the other, keep the more specific phrasing.
3. The result must be factually precise and complete.

Statement A: "${kpContent.slice(0, 400)}"
Statement B: "${existingContent.slice(0, 400)}"

Return JSON only: {"canonical": "...", "confidence": 0.0-1.0}`;

  try {
    const text = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 300, taskName: 'kp_normalize' });
    const parsed = await parseLLMJson(text, 'object', { context: 'kp_normalize', fallback: null });
    if (parsed && typeof parsed.canonical === "string" && parsed.canonical.length >= 10) {
      return { canonical: parsed.canonical, confidence: parsed.confidence ?? 0.8 };
    }
    return null;
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.warn(`normalizeWithLLM failed: ${err.message}`);
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Decide what to do with an incoming KP relative to its target node.
 *
 * @param {object} kp           - Incoming KP (from knowledgeExtractor / nodeMapper)
 * @param {string} nodeId       - Target node ID
 * @param {number} documentId   - Source document ID
 * @param {object} options
 * @param {boolean} options.useLLM
 * @param {number}  [options.excludeChunkId]  - Skip this chunk when scanning (cleanup mode)
 *
 * @returns {Promise<{
 *   action: 'IGNORE'|'MERGE'|'REPLACE'|'NORMALIZE_THEN_STORE'|'STORE',
 *   chunkId?: number,   // For MERGE/REPLACE: existing chunk id. For STORE: not set here.
 *   reason: string,
 *   queued?: boolean    // true when a pending_decision was recorded
 * }>}
 */
export async function resolveKPAction(kp, nodeId, documentId, options = {}) {
  const { useLLM = true, excludeChunkId = null } = options;
  const content = String(kp.content || "").trim();

  // ── [1] IGNORE checks ─────────────────────────────────────────────────────

  if (content.length < IGNORE_MIN_LENGTH) {
    return { action: "IGNORE", reason: "content too short" };
  }
  if ((kp.confidence ?? 1) < IGNORE_CONF_THRESHOLD) {
    return { action: "IGNORE", reason: `low confidence (${kp.confidence})` };
  }
  if (isBoilerplate(content)) {
    return { action: "IGNORE", reason: "boilerplate content" };
  }

  // ── [2] Similarity scan ───────────────────────────────────────────────────

  const candidates = ChunkRepo.findSimilarInNode(nodeId, content, 15, excludeChunkId);

  let bestSim = 0;
  let bestCandidate = null;

  for (const cand of candidates) {
    const sim = wordDiceSimilarity(content, cand.content_clean || "");
    if (sim > bestSim) {
      bestSim = sim;
      bestCandidate = cand;
    }
  }

  // True duplicate with many existing KPs → IGNORE
  if (bestSim >= 0.98 && candidates.length >= 3) {
    return { action: "IGNORE", reason: `exact duplicate (Dice ${bestSim.toFixed(2)})` };
  }

  if (bestCandidate && bestSim >= MERGE_AUTO_THRESHOLD) {
    // Auto-merge: add this doc to source_documents_json
    const existingDocs = safeJson(bestCandidate.source_documents_json, []);
    const alreadyTracked = existingDocs.some(d => d.doc_id === documentId);
    if (!alreadyTracked) {
      const merged = [...existingDocs, {
        doc_id:    documentId,
        doc_title: kp.doc_title || "",
        excerpt:   kp.source_excerpt || content.slice(0, 200)
      }];
      ChunkRepo.updateSourceDocuments(bestCandidate.id, JSON.stringify(merged));
    }
    logger.debug(`KP auto-merged into chunk ${bestCandidate.id} (Dice ${bestSim.toFixed(2)})`);
    return { action: "MERGE", chunkId: bestCandidate.id, reason: `auto-merge (Dice ${bestSim.toFixed(2)})` };
  }

  if (bestCandidate && bestSim >= MERGE_QUEUE_THRESHOLD) {
    // Borderline → queue for human review
    DecisionRepo.insert({
      action:           "merge_suggestion",
      incoming_chunk_id: null,         // incoming KP not yet stored
      target_chunk_id:   bestCandidate.id,
      node_id:           nodeId,
      confidence:        kp.confidence ?? null,
      reason:            `Dice similarity ${bestSim.toFixed(2)} in [0.70, 0.90)`,
      similarity_score:  bestSim,
      incoming_preview:  content,
      target_preview:    bestCandidate.content_clean
    });
    logger.debug(`KP queued as merge_suggestion (Dice ${bestSim.toFixed(2)})`);
    // Fall through: store the incoming KP normally so it's not lost
    return { action: "STORE", reason: "queued merge_suggestion — storing incoming KP", queued: true };
  }

  // ── [3] Temporal / authority check (REPLACE) ──────────────────────────────

  if (bestCandidate && detectTemporalSignal(content)) {
    const incomingRank = authorityRank(kp.authority_level);
    const existingRank = authorityRank(bestCandidate.authority_level);

    if (incomingRank >= existingRank && (kp.confidence ?? 1) >= REPLACE_AUTO_CONF) {
      // Auto-replace: mark existing as superseded, return flag to insert new one
      // The actual insert is done by the caller (assignKPToNode) after this returns.
      // We store the old id so caller can supersede it after insertion.
      logger.debug(`KP will REPLACE chunk ${bestCandidate.id} (authority OK, temporal signal)`);
      return {
        action: "REPLACE",
        chunkId: bestCandidate.id,
        reason: `temporal update supersedes chunk ${bestCandidate.id}`
      };
    } else {
      // Queue for human review
      DecisionRepo.insert({
        action:           "replace_suggestion",
        incoming_chunk_id: null,
        target_chunk_id:   bestCandidate.id,
        node_id:           nodeId,
        confidence:        kp.confidence ?? null,
        reason:            `Temporal signal detected; authority ${kp.authority_level} vs ${bestCandidate.authority_level}`,
        similarity_score:  bestSim,
        incoming_preview:  content,
        target_preview:    bestCandidate.content_clean
      });
      return { action: "STORE", reason: "queued replace_suggestion — storing incoming KP", queued: true };
    }
  }

  // ── [4] Normalize (soft similarity + LLM rewrite) ─────────────────────────

  // Threshold raised from 0.40 → 0.55: a dice similarity of 0.40 can match KPs that
  // are related in topic but differ significantly in specificity (e.g., "probationary period"
  // sim=0.44 with "90-day probationary period"). Below 0.55, store both KPs separately so
  // the specific numeric detail (90, 85%, 7 days) is preserved in the KB.
  if (useLLM && bestCandidate && bestSim >= 0.55) {
    try {
      const normalized = await normalizeWithLLM(content, bestCandidate.content_clean || "");
      if (normalized && normalized.confidence >= 0.70) {
        kp.content = normalized.canonical;    // mutate in-place so caller stores canonical
        logger.debug(`KP normalized with LLM (canonical rewrite, sim=${bestSim.toFixed(2)})`);
        return { action: "NORMALIZE_THEN_STORE", reason: `LLM canonical rewrite (Dice ${bestSim.toFixed(2)})` };
      }
    } catch (err) {
      rethrowIfRateLimit(err);
      logger.warn(`LLM normalization failed: ${err.message}`);
    }
  }

  // ── [5] Default: STORE ────────────────────────────────────────────────────

  return { action: "STORE", reason: "no match found — store as new KP" };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

