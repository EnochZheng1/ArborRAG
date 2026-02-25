/**
 * Knowledge Point Extractor
 *
 * Converts raw document text into structured, atomic Knowledge Points (KPs)
 * using an LLM. Each KP is a self-contained statement tagged with a topic
 * hint so it can be placed into a topical hierarchy.
 *
 * Falls back to paragraph splitting when no LLM key is available.
 */

import { callLLM, llmConfig } from "../utils/llm.js";
import { getPrompt } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { extractKeywords, detectAuthorityLevel } from "./metadataExtractor.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { ingestLogger as logger } from "../utils/logger.js";

const VALID_KP_TYPES = new Set(["fact", "rule", "definition", "procedure", "example", "context"]);
const SEGMENT_SIZE   = 5000;   // chars per LLM call
const SEGMENT_OVERLAP = 500;   // overlap between segments (paragraph boundary)
const MAX_KPS_PER_DOC = 150;

// ── Word-level Dice similarity (used for cross-segment dedup) ─────────────────

function tokenize(str) {
  // CJK characters are single tokens; split Latin on word boundaries
  const tokens = [];
  const re = /[\u4e00-\u9fa5]|[a-zA-Z0-9]+/g;
  let m;
  while ((m = re.exec(str)) !== null) tokens.push(m[0].toLowerCase());
  return tokens;
}

function bigrams(tokens) {
  if (tokens.length < 2) return new Set(tokens);
  const s = new Set();
  for (let i = 0; i < tokens.length - 1; i++) s.add(`${tokens[i]}|${tokens[i + 1]}`);
  return s;
}

export function wordDiceSimilarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;

  // Unigram Dice (works for all lengths)
  const ua = new Set(ta);
  const ub = new Set(tb);
  let uIntersect = 0;
  for (const tok of ua) if (ub.has(tok)) uIntersect++;
  const unigramDice = (2 * uIntersect) / (ua.size + ub.size);

  // Bigram Dice (better precision for longer texts)
  const ga = bigrams(ta);
  const gb = bigrams(tb);
  let bIntersect = 0;
  for (const gram of ga) if (gb.has(gram)) bIntersect++;
  const bigramDice = ga.size + gb.size > 0 ? (2 * bIntersect) / (ga.size + gb.size) : 0;

  // For short phrases (< 4 tokens), weight unigrams more heavily
  const shortText = ta.length < 4 || tb.length < 4;
  return shortText ? unigramDice : (unigramDice * 0.3 + bigramDice * 0.7);
}

// ── Paragraph-boundary segment splitter ───────────────────────────────────────

function splitIntoSegments(text, segmentSize, overlap) {
  if (text.length <= segmentSize) return [text];

  const segments = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + segmentSize, text.length);

    // Try to break at a paragraph boundary
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n\n", end);
      if (boundary > start + segmentSize * 0.6) end = boundary + 2;
    }

    segments.push(text.slice(start, end));
    start = Math.max(start + 1, end - overlap);

    // Snap back to paragraph boundary in the overlap zone
    if (start < text.length) {
      const nextPara = text.indexOf("\n\n", start);
      if (nextPara !== -1 && nextPara < start + overlap) start = nextPara + 2;
    }
  }

  return segments;
}

// ── LLM call for one segment ──────────────────────────────────────────────────

async function extractKPsFromSegment(segment, docTitle, lang) {
  const prompt = getPrompt("kpExtraction", lang, docTitle, segment);

  const text = await callLLM({ prompt, temperature: 0.2, taskName: 'kp_extraction' });

  if (!text) throw new Error("LLM returned empty response");

  // Find the JSON array anywhere in the response (handles preamble text and code fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn(`KP extraction: no JSON array found in response — "${text.slice(0, 300)}"`);
    throw new Error("LLM response contains no JSON array");
  }

  const raw = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(raw)) throw new Error("LLM returned non-array");
  if (raw.length === 0) {
    logger.warn(`KP extraction: LLM returned empty array [] — response was: "${text.slice(0, 300)}"`);
    throw new Error("LLM returned empty KP array");
  }
  return raw;
}

// ── Parse and normalise raw KP objects from LLM ───────────────────────────────

function normaliseKP(raw, index, docTitle, documentId, authorityLevel) {
  const statement = String(raw.statement || "").trim();
  if (statement.length < 10) return null;

  const kpType = VALID_KP_TYPES.has(raw.kp_type) ? raw.kp_type : "fact";

  return {
    // Fields expected by stageMapChunks / assignChunkToNode (backward compat)
    content:         statement,
    index,
    doc_title:       docTitle,
    chunk_type:      kpType,       // maps to chunk_type column
    keywords:        Array.isArray(raw.tags) ? raw.tags.slice(0, 20) : [],
    fields:          {},
    scope:           {},
    authority_level: authorityLevel,

    // KP-specific fields
    kp_type:              kpType,
    source_excerpt:       String(raw.source_excerpt || "").slice(0, 200),
    source_documents_json: JSON.stringify([{
      doc_id:    documentId,
      doc_title: docTitle,
      excerpt:   String(raw.source_excerpt || "").slice(0, 200)
    }]),
    topic_hint:    String(raw.topic_hint    || "General").slice(0, 80),
    subtopic_hint: String(raw.subtopic_hint || "").slice(0, 80),
    confidence:    typeof raw.confidence === "number"
      ? Math.min(1, Math.max(0, raw.confidence)) : 0.8
  };
}

// ── Cross-segment deduplication ───────────────────────────────────────────────

function deduplicateAcrossSegments(kps, threshold = 0.9) {
  const kept = [];
  for (const kp of kps) {
    const isDuplicate = kept.some(
      k => wordDiceSimilarity(kp.content, k.content) >= threshold
    );
    if (!isDuplicate) kept.push(kp);
  }
  return kept;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract atomic Knowledge Points from document text using LLM.
 *
 * @param {string} text       - Full document text
 * @param {string} docTitle   - Document title (shown to LLM for context)
 * @param {object} options
 * @param {boolean} options.useLLM       - If false, use paragraph fallback
 * @param {string}  options.authorityLevel
 * @param {number}  options.documentId
 * @param {number}  options.maxKPs
 * @returns {Promise<Array>} Array of EnrichedKP objects
 */
export async function extractKnowledgePoints(text, docTitle, options = {}) {
  const {
    useLLM        = true,
    authorityLevel = "sop",
    documentId    = 0,
    maxKPs        = MAX_KPS_PER_DOC
  } = options;

  if (!useLLM || !llmConfig[llmConfig.provider]?.apiKey) {
    return extractKPsFromParagraphs(text, docTitle, { authorityLevel, documentId, maxKPs });
  }

  const lang = getEffectiveLang(text);

  const segments = splitIntoSegments(text, SEGMENT_SIZE, SEGMENT_OVERLAP);
  logger.info(`KP extraction: ${segments.length} segment(s) for "${docTitle}"`);

  const allRaw = [];

  for (let s = 0; s < segments.length; s++) {
    try {
      const raw = await extractKPsFromSegment(segments[s], docTitle, lang);
      allRaw.push(...raw);
      logger.debug(`Segment ${s + 1}/${segments.length}: ${raw.length} KPs`);
    } catch (err) {
      rethrowIfRateLimit(err);
      logger.warn(`KP extraction failed for segment ${s + 1}: ${err.message} — falling back to paragraphs`);
      const fallback = paragraphsToKPs(segments[s], docTitle, { authorityLevel, documentId });
      allRaw.push(...fallback.map(kp => ({
        statement:      kp.content,
        kp_type:        "context",
        topic_hint:     "General",
        subtopic_hint:  "",
        tags:           kp.keywords,
        confidence:     0.5,
        source_excerpt: kp.content.slice(0, 200)
      })));
    }

    // Polite delay between segment calls
    if (s < segments.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Normalise and deduplicate
  const normalised = allRaw
    .map((raw, i) => normaliseKP(raw, i, docTitle, documentId, authorityLevel))
    .filter(Boolean);

  const deduped = deduplicateAcrossSegments(normalised);

  const result = deduped.slice(0, maxKPs).map((kp, i) => ({ ...kp, index: i }));
  logger.info(`KP extraction complete: ${result.length} KPs from "${docTitle}"`);
  return result;
}

// ── Fallback: paragraph splitting ─────────────────────────────────────────────

function paragraphsToKPs(text, docTitle, { authorityLevel = "sop", documentId = 0 } = {}) {
  return text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length >= 50)
    .map((p, i) => ({
      content:         p,
      index:           i,
      doc_title:       docTitle,
      chunk_type:      "legacy_chunk",
      keywords:        extractKeywords(p),
      fields:          {},
      scope:           {},
      authority_level: authorityLevel,
      kp_type:         "legacy_chunk",
      source_excerpt:  p.slice(0, 200),
      source_documents_json: JSON.stringify([{ doc_id: documentId, doc_title: docTitle, excerpt: p.slice(0, 200) }]),
      topic_hint:      "General",
      subtopic_hint:   "",
      confidence:      0.5
    }));
}

/**
 * Fallback extractor (no LLM) — split on blank lines.
 * Always produces KPs with kp_type='legacy_chunk'.
 */
export function extractKPsFromParagraphs(text, docTitle, options = {}) {
  const { authorityLevel = detectAuthorityLevel(text, docTitle), documentId = 0, maxKPs = MAX_KPS_PER_DOC } = options;
  const kps = paragraphsToKPs(text, docTitle, { authorityLevel, documentId });
  return kps.slice(0, maxKPs);
}
