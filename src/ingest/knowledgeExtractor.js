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
import { parseLLMJson } from "../utils/parseJSON.js";
import { getPrompt } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { extractKeywords, detectAuthorityLevel } from "./metadataExtractor.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { JobRepo } from "../db/repositories/JobRepo.js";

const VALID_KP_TYPES = new Set(["fact", "rule", "definition", "procedure", "example", "context"]);
const SEGMENT_SIZE   = 8000;  // chars per LLM call — was 5000; ~35% fewer segments
const SEGMENT_OVERLAP = 300;  // overlap between segments — was 500
// Parallel segment batch size. Default 1 (sequential) to respect low rate limits.
// Set env INGEST_SEGMENT_BATCH=4 to restore parallel processing.
const SEGMENT_BATCH  = Math.max(1, Number.parseInt(process.env.INGEST_SEGMENT_BATCH || "1", 10) || 1);

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

// ── Section heading detection ─────────────────────────────────────────────────

/**
 * Detect section headings in document text using structural cues.
 * Returns an ordered list of {heading, startIndex} objects.
 *
 * Detects:
 * - ALL-CAPS lines (≥ 3 chars, ≤ 80 chars, no lowercase letters)
 * - Markdown headings (# / ## / ###)
 * - Numbered sections at paragraph start (1. Section Name)
 */
function detectSectionHeadings(text) {
  const headings = [];
  const lines = text.split('\n');
  let charOffset = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length >= 3 && trimmed.length <= 80) {
      // Skip URL-like strings and percent-encoded paths (e.g. from PDF metadata)
      if (/^https?:\/\//i.test(trimmed) || /%[0-9A-Fa-f]{2}/.test(trimmed) ||
          /^[a-z0-9._-]+\.[a-z]{2,5}\//i.test(trimmed)) continue;

      // ALL-CAPS heading (allow digits, spaces, punctuation — but no lowercase)
      if (/^[^a-z]*$/.test(trimmed) && /[A-Z]{2,}/.test(trimmed)) {
        headings.push({ heading: trimmed, startIndex: charOffset });
      }
      // Markdown heading
      else if (/^#{1,3}\s+\S/.test(trimmed)) {
        headings.push({ heading: trimmed.replace(/^#+\s+/, ''), startIndex: charOffset });
      }
      // Numbered section heading (e.g. "1. Probationary Period") — only at paragraph start
      else if (/^\d+\.\s+[A-Z]/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed.replace(/^\d+\.\s+/, ''), startIndex: charOffset });
      }
      // Multi-level numbered section (e.g. "3.1 Chapter Title", "1.2.3 Sub-section")
      else if (/^\d+\.\d+(\.\d+)*\s+[A-Z]/.test(trimmed) && trimmed.length <= 80) {
        headings.push({ heading: trimmed.replace(/^\d+[\d.]*\s+/, ''), startIndex: charOffset });
      }
      // Numbered section with colon (e.g. "1.2: Overview", "3: Introduction")
      else if (/^\d+(\.\d+)*[:.]\s*[A-Z]/.test(trimmed) && trimmed.length <= 80) {
        headings.push({ heading: trimmed.replace(/^\d+[\d.]*[:.]\s*/, ''), startIndex: charOffset });
      }
      // CJK chapter/section markers (e.g. "第一章 总则", "第二节 定义", "第3章 工作流程")
      else if (/^第[一二三四五六七八九十百千万\d]+[章节篇部条]\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed, startIndex: charOffset });
      }
      // CJK enumeration headings (e.g. "一、总则", "（二）定义与范围")
      else if (/^[（(]?[一二三四五六七八九十]+[）)、。]\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed.replace(/^[（(]?[一二三四五六七八九十]+[）)、。]\s*/, ''), startIndex: charOffset });
      }
    }
    charOffset += line.length + 1; // +1 for the \n
  }

  return headings;
}

/**
 * Given a character position in the text, find the most recent section heading.
 * @param {Array} headings - Sorted headings from detectSectionHeadings
 * @param {number} position - Character position in text
 * @returns {string|null} - Nearest preceding heading, or null
 */
function getSectionAtPosition(headings, position) {
  let result = null;
  for (const h of headings) {
    if (h.startIndex <= position) result = h.heading;
    else break;
  }
  return result;
}

// ── Paragraph-boundary segment splitter ───────────────────────────────────────

/**
 * Split text into overlapping segments and tag each with its section heading.
 * @returns {Array<{text: string, sectionHeading: string|null}>}
 */
function splitIntoSegments(text, segmentSize, overlap, headings = []) {
  if (text.length <= segmentSize) {
    const section = headings.length > 0 ? headings[0].heading : null;
    return [{ text, sectionHeading: section }];
  }

  const segments = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + segmentSize, text.length);

    // Try to break at a paragraph boundary
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n\n", end);
      if (boundary > start + segmentSize * 0.6) end = boundary + 2;
    }

    const section = getSectionAtPosition(headings, start);
    segments.push({ text: text.slice(start, end), sectionHeading: section });
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

async function extractKPsFromSegment(segment, docTitle, lang, sectionHeading = null) {
  let prompt = getPrompt("kpExtraction", lang, docTitle, segment);

  // When a section heading was detected from document structure, provide it as
  // context so the LLM generates more consistent topic_hint values anchored to
  // the document's own structure, without forcing an exact match.
  if (sectionHeading) {
    prompt += `\n\nContext: This text falls under the document section: "${sectionHeading}". Use this section name as the topic_hint for KPs, or a more specific sub-topic derived from it.`;
  }

  // Temperature 0 + seed for determinism: same document must produce the same KPs
  // across runs. This stabilises tree topology and makes retrieval deterministic.
  // maxOutputTokens: cap at 3000 tokens (~20 KPs × 150 tokens each) to avoid runaway completions.
  const text = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 3000, taskName: 'kp_extraction' });

  if (!text) throw new Error("LLM returned empty response");

  const raw = await parseLLMJson(text, 'array', { context: 'kp_extraction', fallback: null });
  if (!Array.isArray(raw)) {
    logger.warn(`KP extraction: could not parse JSON array — "${text.slice(0, 300)}"`);
    throw new Error("LLM response contains no valid JSON array");
  }
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

  const sourceExcerpt = String(raw.source_excerpt || "").slice(0, 200).trim();
  // Always include the verbatim excerpt in content so exact numbers/phrases
  // ("90-day", "twice per year") survive LLM paraphrasing and remain searchable.
  // Skip appending if the excerpt is already contained within the statement
  // (avoids "statement\nexcerpt" where excerpt is a prefix/suffix of statement).
  const shouldAppendExcerpt = sourceExcerpt
    && sourceExcerpt !== statement
    && !statement.includes(sourceExcerpt);
  const fullContent = shouldAppendExcerpt
    ? `${statement}\n${sourceExcerpt}`
    : statement;

  return {
    // Fields expected by stageMapChunks / assignChunkToNode (backward compat)
    content:         fullContent,
    index,
    doc_title:       docTitle,
    chunk_type:      kpType,       // maps to chunk_type column
    keywords:        Array.isArray(raw.tags) ? raw.tags.slice(0, 20) : [],
    fields:          {},
    scope:           {},
    authority_level: authorityLevel,

    // KP-specific fields
    kp_type:              kpType,
    source_excerpt:       sourceExcerpt,
    source_documents_json: JSON.stringify([{
      doc_id:    documentId,
      doc_title: docTitle,
      excerpt:   sourceExcerpt
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
 * @returns {Promise<Array>} Array of EnrichedKP objects
 */
export async function extractKnowledgePoints(text, docTitle, options = {}) {
  const {
    useLLM        = true,
    authorityLevel = "sop",
    documentId    = 0,
    jobId         = null,
    onProgress    = null   // onProgress(doneSegments, totalSegments)
  } = options;

  if (!useLLM || !llmConfig[llmConfig.provider]?.apiKey) {
    return extractKPsFromParagraphs(text, docTitle, { authorityLevel, documentId });
  }

  const lang = getEffectiveLang(text);

  // Detect section headings from document structure (ALL-CAPS, markdown, numbered)
  // before splitting so each segment knows which section it belongs to.
  const headings = detectSectionHeadings(text);
  if (headings.length > 0) {
    logger.info(`Detected ${headings.length} section heading(s): ${headings.map(h => h.heading).join(', ')}`);
  }

  const segments = splitIntoSegments(text, SEGMENT_SIZE, SEGMENT_OVERLAP, headings);
  logger.info(`KP extraction: ${segments.length} segment(s) for "${docTitle}"`);

  // Load checkpoint — allows resuming after a rate-limit pause without re-extracting
  let startSegment = 0;
  const allRaw = [];
  if (jobId) {
    const saved = JobRepo.loadCheckpoint(jobId);
    if (saved?.extraction?.next_segment > 0) {
      startSegment = saved.extraction.next_segment;
      allRaw.push(...(saved.extraction.raw_kps ?? []));
      logger.info(`KP extraction resuming from segment ${startSegment} (${allRaw.length} cached KPs)`);
    }
  }

  for (let b = startSegment; b < segments.length; b += SEGMENT_BATCH) {
    const batch = segments.slice(b, b + SEGMENT_BATCH);
    const settled = await Promise.allSettled(
      batch.map(seg => extractKPsFromSegment(seg.text, docTitle, lang, seg.sectionHeading))
    );

    let firstRateLimitErr = null;
    for (let i = 0; i < settled.length; i++) {
      const seg = batch[i];
      const si  = b + i;
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        allRaw.push(...outcome.value);
        logger.debug(`Segment ${si + 1}/${segments.length}: ${outcome.value.length} KPs (section: ${seg.sectionHeading || 'none'})`);
      } else {
        // Capture first rate-limit error — do NOT re-throw yet; save checkpoint first
        try { rethrowIfRateLimit(outcome.reason); }
        catch (rl) { if (!firstRateLimitErr) firstRateLimitErr = rl; continue; }
        // Non-rate-limit error → paragraph fallback (existing behaviour)
        logger.warn(`KP extraction failed for segment ${si + 1}: ${outcome.reason.message} — falling back to paragraphs`);
        const fallback = paragraphsToKPs(seg.text, docTitle, { authorityLevel, documentId });
        allRaw.push(...fallback.map(kp => ({
          statement: kp.content, kp_type: "context",
          topic_hint: seg.sectionHeading || "General", subtopic_hint: "",
          tags: kp.keywords, confidence: 0.5, source_excerpt: kp.content.slice(0, 200)
        })));
      }
    }

    // Save checkpoint after each batch — ensures resume point is always ahead of last failure
    if (jobId) {
      try { JobRepo.saveCheckpoint(jobId, { extraction: { next_segment: b + SEGMENT_BATCH, raw_kps: allRaw } }); }
      catch (e) { logger.warn(`Checkpoint save failed: ${e.message}`); }
    }

    if (firstRateLimitErr) throw firstRateLimitErr; // propagates up to pauseRateLimitedJob

    // Emit segment-level progress so stageExtractKPs can update the UI incrementally
    if (onProgress) onProgress(Math.min(b + SEGMENT_BATCH, segments.length), segments.length);

    if (b + SEGMENT_BATCH < segments.length) await new Promise(r => setTimeout(r, 200));
  }

  // Clear checkpoint — extraction finished successfully
  if (jobId) {
    try { JobRepo.saveCheckpoint(jobId, null); } catch (_) {}
  }

  // Normalise and deduplicate
  const normalised = allRaw
    .map((raw, i) => normaliseKP(raw, i, docTitle, documentId, authorityLevel))
    .filter(Boolean);

  const deduped = deduplicateAcrossSegments(normalised);

  // Append paragraph fallbacks as a retrieval safety net.
  // These ensure every substantial paragraph is BM25-searchable even when the
  // LLM misses content, merges facts, or omits specific numbers during KP extraction.
  const paragraphFallbacks = extractParagraphFallbacks(text, docTitle, { authorityLevel, documentId });

  // Deduplicate paragraphs against existing KPs — only skip a paragraph if it's
  // nearly identical to a KP (≥0.85 Dice). Paragraphs typically contain 2-3 facts
  // while KPs are atomic, so overlap is partial even when topics match. A lower
  // threshold (0.7) would filter out almost all paragraphs, defeating the safety net.
  const filteredParagraphs = paragraphFallbacks.filter(para => {
    return !deduped.some(kp => wordDiceSimilarity(para.content, kp.content) >= 0.85);
  });

  const result = [...deduped, ...filteredParagraphs].map((kp, i) => ({ ...kp, index: i }));
  logger.info(`KP extraction complete: ${deduped.length} KPs + ${filteredParagraphs.length} paragraph fallbacks from "${docTitle}"`);
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
  const { authorityLevel = detectAuthorityLevel(text, docTitle), documentId = 0 } = options;
  return paragraphsToKPs(text, docTitle, { authorityLevel, documentId });
}

// ── Paragraph fallback safety net ─────────────────────────────────────────────

const BOILERPLATE_RE = /^(page\s+\d|chapter\s+\d|\d+\s*\/\s*\d+$|table of contents|confidential|internal use|draft\b|do not (distribute|copy|reproduce|share)|all rights reserved|copyright\s*©?\s*\d{4}|\[\s*\])/i;

/**
 * Generate paragraph-level chunks as a BM25 retrieval safety net.
 * These are stored alongside LLM-extracted KPs and ensure that every substantial
 * paragraph is searchable, even when the LLM misses or merges content.
 *
 * @param {string} text         - Full document text
 * @param {string} docTitle     - Document title
 * @param {object} options
 * @returns {Array} paragraph KP objects with kp_type='paragraph_context'
 */
function extractParagraphFallbacks(text, docTitle, { authorityLevel = "sop", documentId = 0 } = {}) {
  // Split on double newlines
  const rawParagraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  // Merge consecutive short paragraphs (< 100 chars)
  const merged = [];
  let buffer = '';
  for (const para of rawParagraphs) {
    if (buffer && (buffer.length >= 100 || para.length >= 100)) {
      if (buffer.length >= 80) merged.push(buffer);
      buffer = para;
    } else {
      buffer = buffer ? buffer + '\n' + para : para;
    }
  }
  if (buffer.length >= 80) merged.push(buffer);

  // Filter and cap — scale cap with document length (longer docs need more fallbacks)
  const dynamicCap = Math.min(50, Math.max(15, Math.ceil(merged.length / 5)));
  const paragraphs = merged
    .filter(p => p.length >= 80 && !BOILERPLATE_RE.test(p))
    .slice(0, dynamicCap);

  return paragraphs.map((p, i) => ({
    content:         p,
    index:           i,  // will be re-indexed by caller
    doc_title:       docTitle,
    chunk_type:      "context",
    keywords:        extractKeywords(p),
    fields:          {},
    scope:           {},
    authority_level: authorityLevel,
    kp_type:         "paragraph_context",
    source_excerpt:  p.slice(0, 200),
    source_documents_json: JSON.stringify([{ doc_id: documentId, doc_title: docTitle, excerpt: p.slice(0, 200) }]),
    // Always map to root — paragraph fallbacks are a BM25 safety net only.
    // Mapping them to topical nodes would dilute the tree's precision by mixing
    // multi-fact paragraphs with focused atomic KPs.
    topic_hint:      "General",
    subtopic_hint:   "",
    confidence:      0.6
  }));
}
