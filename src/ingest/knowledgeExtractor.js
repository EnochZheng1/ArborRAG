/**
 * Knowledge Point Extractor
 *
 * Converts raw document text into structured, atomic Knowledge Points (KPs)
 * using an LLM. Each KP is a self-contained statement tagged with a topic
 * hint so it can be placed into a topical hierarchy.
 *
 * Falls back to paragraph splitting when no LLM key is available.
 */

import { callLLM, isLlmConfigured } from "../utils/llm.js";
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
          /^[a-z0-9._-]+\.[a-z]{2,5}\//i.test(trimmed)) { charOffset += line.length + 1; continue; }

      // ALL-CAPS heading (allow digits, spaces, punctuation — but no lowercase)
      if (/^[^a-z]*$/.test(trimmed) && /[A-Z]{2,}/.test(trimmed)) {
        headings.push({ heading: trimmed, startIndex: charOffset, level: 1 });
      }
      // Markdown heading — level from # count
      else if (/^#{1,4}\s+\S/.test(trimmed)) {
        const hLevel = trimmed.match(/^(#+)/)[1].length; // 1-4
        headings.push({ heading: trimmed.replace(/^#+\s+/, ''), startIndex: charOffset, level: Math.min(hLevel, 5) });
      }
      // Numbered section heading (e.g. "1. Probationary Period") — level 1
      else if (/^\d+\.\s+[A-Z]/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed.replace(/^\d+\.\s+/, ''), startIndex: charOffset, level: 1 });
      }
      // Multi-level numbered section (e.g. "3.1 Chapter Title" = level 2, "1.2.3 Sub-section" = level 3)
      else if (/^\d+\.\d+(\.\d+)*\s+[A-Z]/.test(trimmed) && trimmed.length <= 80) {
        const dotCount = (trimmed.match(/\./g) || []).length; // 1 dot = level 2, 2+ dots = level 3+
        headings.push({ heading: trimmed.replace(/^\d+[\d.]*\s+/, ''), startIndex: charOffset, level: Math.min(dotCount + 1, 5) });
      }
      // Numbered section with colon (e.g. "1.2: Overview")
      else if (/^\d+(\.\d+)*[:.]\s*[A-Z]/.test(trimmed) && trimmed.length <= 80) {
        const dotCount = (trimmed.match(/\./g) || []).length;
        headings.push({ heading: trimmed.replace(/^\d+[\d.]*[:.]\s*/, ''), startIndex: charOffset, level: Math.min(dotCount + 1, 5) });
      }
      // CJK chapter markers (第X章) — level 1
      else if (/^第[一二三四五六七八九十百千万\d]+章\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed, startIndex: charOffset, level: 1 });
      }
      // CJK section markers (第X节/篇/部) — level 2
      else if (/^第[一二三四五六七八九十百千万\d]+[节篇部]\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed, startIndex: charOffset, level: 2 });
      }
      // CJK article markers (第X条) — level 3
      else if (/^第[一二三四五六七八九十百千万\d]+条\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed, startIndex: charOffset, level: 3 });
      }
      // CJK enumeration headings (一、总则) — level 1
      else if (/^[一二三四五六七八九十]+[、。]\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed.replace(/^[一二三四五六七八九十]+[、。]\s*/, ''), startIndex: charOffset, level: 1 });
      }
      // CJK sub-enumeration headings (（一）/（二）) — level 2
      else if (/^[（(][一二三四五六七八九十]+[）)]\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed.replace(/^[（(][一二三四五六七八九十]+[）)]\s*/, ''), startIndex: charOffset, level: 2 });
      }
      // CJK bracket enumeration (【一】/【二】) — level 2
      else if (/^【[一二三四五六七八九十\d]+】\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed.replace(/^【[一二三四五六七八九十\d]+】\s*/, ''), startIndex: charOffset, level: 2 });
      }
      // Parenthesis enumeration at line start: 1）, (1), (2) — level 3
      else if (/^[（(]?\d+[）)]\s*\S/.test(trimmed) && trimmed.length <= 60) {
        headings.push({ heading: trimmed.replace(/^[（(]?\d+[）)]\s*/, ''), startIndex: charOffset, level: 3 });
      }
    }
    charOffset += line.length + 1; // +1 for the \n
  }

  return headings;
}

/**
 * Given a character position in the text, find the current section path
 * (breadcrumb) based on heading levels.
 *
 * @param {Array} headings - Sorted headings from detectSectionHeadings (with level)
 * @param {number} position - Character position in text
 * @returns {{ heading: string, path: string[] }} - Deepest heading and full path
 */
function getSectionAtPosition(headings, position) {
  // Track the current heading at each level
  const levelStack = [null, null, null, null, null]; // levels 1-5

  for (const h of headings) {
    if (h.startIndex > position) break;

    const lvl = (h.level || 1) - 1; // 0-indexed
    levelStack[lvl] = h.heading;
    // When a higher-level heading appears, clear deeper levels
    for (let i = lvl + 1; i < levelStack.length; i++) levelStack[i] = null;
  }

  const path = levelStack.filter(Boolean);
  return path.length > 0
    ? { heading: path[path.length - 1], path }
    : { heading: null, path: [] };
}

// ── Table detection and structured extraction ────────────────────────────────

/**
 * Detect table structures in text: tab-separated rows with consistent column
 * counts, or markdown-style `| col | col |` tables.
 *
 * Returns an array of { startIndex, endIndex, headers: string[], rows: string[][] }.
 * Each row is an array of cell values.
 */
function detectTables(text) {
  const tables = [];
  const lines = text.split('\n');
  let charOffset = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Markdown table: | header | header |
    if (/^\s*\|.+\|/.test(line)) {
      const tableStart = charOffset;
      const tableLines = [];
      let j = i;
      while (j < lines.length && /^\s*\|.+\|/.test(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      if (tableLines.length >= 2) {
        // Skip separator row (|---|---|)
        const dataLines = tableLines.filter(l => !/^\s*\|[\s-:|]+\|\s*$/.test(l));
        if (dataLines.length >= 2) {
          const parsedRows = dataLines.map(l =>
            l.split('|').slice(1, -1).map(cell => cell.trim())
          );
          const headers = parsedRows[0];
          const rows = parsedRows.slice(1);
          const endOffset = charOffset + tableLines.reduce((s, l) => s + l.length + 1, 0);
          tables.push({ startIndex: tableStart, endIndex: endOffset, headers, rows });
        }
      }
      charOffset += tableLines.reduce((s, l) => s + l.length + 1, 0);
      i = j;
      continue;
    }

    // Tab-separated table: detect runs of 3+ lines with same number of tabs (>=1)
    const tabCount = (line.match(/\t/g) || []).length;
    if (tabCount >= 1) {
      const tableStart = charOffset;
      const tableLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        const nextTabs = (lines[j].match(/\t/g) || []).length;
        if (nextTabs === tabCount && lines[j].trim()) {
          tableLines.push(lines[j]);
          j++;
        } else break;
      }
      if (tableLines.length >= 3) {
        const parsedRows = tableLines.map(l => l.split('\t').map(cell => cell.trim()));
        const headers = parsedRows[0];
        const rows = parsedRows.slice(1);
        const endOffset = charOffset + tableLines.reduce((s, l) => s + l.length + 1, 0);
        tables.push({ startIndex: tableStart, endIndex: endOffset, headers, rows });
      }
      charOffset += tableLines.reduce((s, l) => s + l.length + 1, 0);
      i = j;
      continue;
    }

    charOffset += line.length + 1;
    i++;
  }

  return tables;
}

/**
 * Convert detected tables into structured KP objects.
 * Each row becomes a KP with column headers as context.
 */
function tableRowsToKPs(tables, docTitle, { authorityLevel = "sop", documentId = 0, headings = [] } = {}) {
  const kps = [];
  for (const table of tables) {
    if (!table.headers || table.headers.length === 0) continue;

    // Derive topic_hint from the section heading the table appears under,
    // falling back to docTitle. Column headers make poor node names.
    let topicHint = docTitle || "General";
    if (headings.length > 0 && table.startIndex != null) {
      const sectionInfo = getSectionAtPosition(headings, table.startIndex);
      if (sectionInfo.heading) topicHint = sectionInfo.heading;
    }

    for (const row of table.rows) {
      // Build a structured statement from header-value pairs
      const pairs = table.headers
        .map((h, idx) => row[idx] ? `${h}: ${row[idx]}` : null)
        .filter(Boolean);

      if (pairs.length === 0) continue;
      const content = pairs.join(' | ');
      if (content.length < 10) continue;

      kps.push({
        content,
        index: kps.length,
        doc_title: docTitle,
        chunk_type: "fact",
        keywords: extractKeywords(content),
        fields: {},
        scope: {},
        authority_level: authorityLevel,
        kp_type: "fact",
        source_excerpt: content.slice(0, 200),
        source_documents_json: JSON.stringify([{ doc_id: documentId, doc_title: docTitle, excerpt: content.slice(0, 200) }]),
        topic_hint: topicHint,
        subtopic_hint: "",
        confidence: 0.85,  // structured data = high confidence
        _fromTable: true
      });
    }
  }
  return kps;
}

// ── Paragraph-boundary segment splitter ───────────────────────────────────────

/**
 * Split text into overlapping segments and tag each with its section heading.
 * @returns {Array<{text: string, sectionHeading: string|null}>}
 */
function splitIntoSegments(text, segmentSize, overlap, headings = []) {
  // Expects pre-normalised text (\r\n → \n done in extractKnowledgePoints)
  if (text.length <= segmentSize) {
    const sectionInfo = headings.length > 0
      ? getSectionAtPosition(headings, 0)
      : { heading: null, path: [] };
    return [{ text, sectionHeading: sectionInfo.heading, sectionPath: sectionInfo.path }];
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

    const sectionInfo = getSectionAtPosition(headings, start);
    segments.push({ text: text.slice(start, end), sectionHeading: sectionInfo.heading, sectionPath: sectionInfo.path });

    const newStart = end - overlap;
    // Guard: ensure at least half-segment forward progress to prevent runaway 1-char segments
    start = Math.max(start + Math.floor(segmentSize / 2), newStart);

    // Snap forward to paragraph boundary in the overlap zone
    if (start < text.length) {
      const nextPara = text.indexOf("\n\n", start);
      if (nextPara !== -1 && nextPara < start + overlap) start = nextPara + 2;
    }
  }

  return segments;
}

// ── LLM call for one segment ──────────────────────────────────────────────────

async function extractKPsFromSegment(segment, docTitle, lang, sectionHeading = null, sectionPath = []) {
  let prompt = getPrompt("kpExtraction", lang, docTitle, segment);

  // When a section path was detected from document structure, provide it as
  // context so the LLM generates hierarchical topic_hint/subtopic_hint values
  // anchored to the document's own section structure.
  if (sectionPath && sectionPath.length >= 2) {
    prompt += `\n\nContext: This text falls under the document section path: ${sectionPath.map(s => `"${s}"`).join(' > ')}. Use "${sectionPath[0]}" as topic_hint and "${sectionPath.slice(1).join(' > ')}" as subtopic_hint for KPs.`;
  } else if (sectionHeading) {
    prompt += `\n\nContext: This text falls under the document section: "${sectionHeading}". Use this section name as the topic_hint for KPs, or a more specific sub-topic derived from it.`;
  } else if (docTitle && docTitle.trim().length > 0) {
    prompt += `\n\nContext: This document is titled "${docTitle}". Use specific sub-topics of this domain as topic_hint values. Each topic_hint should name a specific aspect of "${docTitle}", not a generic label.`;
  }

  // Temperature 0 + seed for determinism: same document must produce the same KPs
  // across runs. This stabilises tree topology and makes retrieval deterministic.
  // maxOutputTokens: 8192 allows ~50 KPs per segment (each ~150 tokens in JSON).
  // thinkingBudget: 0 — KP extraction is pure structured output; thinking wastes
  // tokens and causes truncation (thinking budget is soft, model can exceed it).
  const text = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 8192, thinkingBudget: 0, taskName: 'kp_extraction' });

  if (!text) throw new Error("LLM returned empty response");
  logger.debug(`KP extraction raw LLM response (${text.length} chars total, first 300): ${text.slice(0, 300).replace(/\n/g, '\\n')}...LAST100: ${text.slice(-100).replace(/\n/g, '\\n')}`);

  const raw = await parseLLMJson(text, 'array', { context: 'kp_extraction', fallback: null });
  if (!Array.isArray(raw)) {
    logger.warn(`KP extraction: could not parse JSON array — "${text.slice(0, 300)}"`);
    throw new Error("LLM response contains no valid JSON array");
  }
  if (raw.length === 0) {
    logger.warn(`KP extraction: LLM returned empty array [] — response was: "${text.slice(0, 300)}"`);
    throw new Error("LLM returned empty KP array");
  }
  logger.info(`KP extraction segment: ${raw.length} KPs, topic_hints: ${[...new Set(raw.map(r => r.topic_hint))].join(', ')}`);
  // Debug: log first item structure to catch array-vs-object issues
  if (raw.length > 0) {
    const first = raw[0];
    logger.debug(`KP first item type: ${Array.isArray(first) ? 'array' : typeof first}, keys: ${Object.keys(first).slice(0, 5).join(',')}, statement: "${String(first.statement || '').slice(0, 60)}"`);
  }
  return raw;
}

// ── KP quality scoring ──────────────────────────────────────────────────────

/**
 * Score a KP on specificity. High-quality KPs contain concrete values:
 * numbers, dates, names, percentages, currencies. Generic statements score lower.
 *
 * @param {string} content - The KP statement text
 * @returns {number} quality adjustment to confidence (-0.15 to +0.10)
 */
function scoreKPQuality(content) {
  let score = 0;
  // Numbers with units (e.g., "15 days", "4 hours", "90%")
  if (/\b\d+(?:[.,]\d+)?\s*(%|percent|days?|hours?|months?|years?|minutes?|weeks?)\b/i.test(content)) score += 0.05;
  // Currency amounts (e.g., "$5,000", "¥300")
  if (/[$¥€£]\s?[\d,]+(?:\.\d+)?/.test(content)) score += 0.05;
  // Dates (ISO or natural: "2024-01-15", "January 15")
  if (/\b\d{4}-\d{2}(-\d{2})?\b/.test(content) || /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i.test(content)) score += 0.03;
  // Proper nouns (capitalized multi-word names)
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(content)) score += 0.02;
  // Standalone numbers (at least one concrete figure)
  if (/\b\d{1,6}\b/.test(content)) score += 0.02;
  // CJK numbers with units
  if (/\d+\s*[天小时个月年周次人元]/.test(content)) score += 0.03;

  // Penalize generic/vague statements
  const generic = /^(the company|this policy|employees?|management|it is important|according to)/i;
  if (generic.test(content.trim()) && score === 0) score -= 0.10;
  // Very short statements with no specifics
  if (content.length < 40 && score === 0) score -= 0.05;

  return Math.max(-0.15, Math.min(0.10, score));
}

// ── Parse and normalise raw KP objects from LLM ───────────────────────────────

function normaliseKP(raw, index, docTitle, documentId, authorityLevel) {
  const statement = String(raw.statement || "").trim();
  if (statement.length < 10) {
    logger.debug(`normaliseKP: filtered short KP (${statement.length} chars): "${statement}" | raw keys: ${Object.keys(raw).join(',')}`);
    return null;
  }

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
    confidence:    Math.min(1, Math.max(0.1,
      (typeof raw.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : 0.8)
      + scoreKPQuality(fullContent)
    ))
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
export async function extractKnowledgePoints(rawText, docTitle, options = {}) {
  const {
    useLLM        = true,
    authorityLevel = "sop",
    documentId    = 0,
    jobId         = null,
    onProgress    = null   // onProgress(doneSegments, totalSegments)
  } = options;

  // Normalise Windows \r\n to \n once — used consistently by segmentation,
  // heading detection, table detection, and paragraph extraction.
  const text = rawText.replace(/\r\n/g, "\n");

  if (!useLLM || !isLlmConfigured()) {
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
    // Save checkpoint BEFORE processing batch — crash recovery won't lose completed work
    if (jobId) {
      try { JobRepo.saveCheckpoint(jobId, { extraction: { next_segment: b, raw_kps: allRaw } }); }
      catch (e) { logger.warn(`Checkpoint save failed: ${e.message}`); }
    }

    const batch = segments.slice(b, b + SEGMENT_BATCH);
    const settled = await Promise.allSettled(
      batch.map(seg => extractKPsFromSegment(seg.text, docTitle, lang, seg.sectionHeading, seg.sectionPath))
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

    // Save checkpoint after batch completes — ensures resume point is ahead of last success
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
  logger.info(`KP extraction raw: ${allRaw.length} raw KPs from LLM for "${docTitle}"`);
  const normalised = allRaw
    .map((raw, i) => normaliseKP(raw, i, docTitle, documentId, authorityLevel))
    .filter(Boolean);
  logger.info(`KP extraction normalised: ${normalised.length} after normalisation (${allRaw.length - normalised.length} filtered)`);

  const deduped = deduplicateAcrossSegments(normalised);
  logger.info(`KP extraction deduped: ${deduped.length} after deduplication (${normalised.length - deduped.length} duplicates)`);

  // Table-aware extraction: detect tables in the original text and convert
  // each row into a structured KP. Deduplicate against LLM-extracted KPs.
  const detectedTables = detectTables(text);
  let tableKPs = [];
  if (detectedTables.length > 0) {
    logger.info(`Detected ${detectedTables.length} table(s) with ${detectedTables.reduce((s, t) => s + t.rows.length, 0)} total rows`);
    const rawTableKPs = tableRowsToKPs(detectedTables, docTitle, { authorityLevel, documentId, headings });
    // Only keep table KPs that aren't already covered by LLM extraction
    tableKPs = rawTableKPs.filter(tKP =>
      !deduped.some(kp => wordDiceSimilarity(tKP.content, kp.content) >= 0.75)
    );
    if (tableKPs.length > 0) {
      logger.info(`Adding ${tableKPs.length} table-extracted KPs (${rawTableKPs.length - tableKPs.length} duplicates removed)`);
    }
  }

  // Append paragraph fallbacks as a retrieval safety net.
  // These ensure every substantial paragraph is BM25-searchable even when the
  // LLM misses content, merges facts, or omits specific numbers during KP extraction.
  const paragraphFallbacks = extractParagraphFallbacks(text, docTitle, { authorityLevel, documentId, headings, kpCount: deduped.length });

  // Cross-dedup table KPs against paragraph fallbacks (prevents table rows from
  // duplicating paragraph content that covers the same data in prose form)
  if (tableKPs.length > 0 && paragraphFallbacks.length > 0) {
    tableKPs = tableKPs.filter(tKP =>
      !paragraphFallbacks.some(pKP => wordDiceSimilarity(tKP.content, pKP.content) >= 0.75)
    );
  }

  // Deduplicate paragraphs against existing KPs — only skip a paragraph if it's
  // nearly identical to a KP (≥0.85 Dice). Paragraphs typically contain 2-3 facts
  // while KPs are atomic, so overlap is partial even when topics match. A lower
  // threshold (0.7) would filter out almost all paragraphs, defeating the safety net.
  const filteredParagraphs = paragraphFallbacks.filter(para => {
    return !deduped.some(kp => wordDiceSimilarity(para.content, kp.content) >= 0.85);
  });

  const result = [...deduped, ...tableKPs, ...filteredParagraphs].map((kp, i) => ({ ...kp, index: i }));
  logger.info(`KP extraction complete: ${deduped.length} KPs + ${tableKPs.length} table KPs + ${filteredParagraphs.length} paragraph fallbacks from "${docTitle}"`);
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
      topic_hint:      docTitle || "General",
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
function extractParagraphFallbacks(text, docTitle, { authorityLevel = "sop", documentId = 0, headings = [], kpCount = 0 } = {}) {
  // Split on double newlines, tracking char offsets for section mapping
  const rawParagraphs = [];
  let offset = 0;
  for (const part of text.split(/\n{2,}/)) {
    const trimmed = part.trim();
    if (trimmed) rawParagraphs.push({ text: trimmed, offset });
    offset = text.indexOf(part, offset) + part.length;
  }

  // Merge consecutive short paragraphs (< 100 chars)
  const merged = [];
  let buffer = null;
  for (const para of rawParagraphs) {
    if (buffer && (buffer.text.length >= 100 || para.text.length >= 100)) {
      if (buffer.text.length >= 80) merged.push(buffer);
      buffer = para;
    } else {
      buffer = buffer
        ? { text: buffer.text + '\n' + para.text, offset: buffer.offset }
        : para;
    }
  }
  if (buffer && buffer.text.length >= 80) merged.push(buffer);

  // Filter — keep substantial, non-boilerplate paragraphs as retrieval safety net.
  // Cap scales with document size (kpCount / 3) to prevent excessive paragraph
  // fallbacks while still covering multi-section documents.
  let paragraphs = merged
    .filter(p => p.text.length >= 80 && !BOILERPLATE_RE.test(p.text));

  // Cap paragraph fallbacks relative to KP count to prevent excessive storage.
  // At least 10 to cover small docs, at most 40 for large multi-section docs.
  if (kpCount > 0) {
    const maxFallbacks = Math.min(40, Math.max(10, Math.floor(kpCount / 3)));
    paragraphs = paragraphs.slice(0, maxFallbacks);
  }

  return paragraphs.map((p, i) => {
    // Derive topic_hint from section heading if available, otherwise doc title.
    // This routes paragraph fallbacks to the correct topic nodes instead of
    // dumping them all under a single doc-title node.
    let topicHint = docTitle || "General";
    if (headings.length > 0) {
      const sectionInfo = getSectionAtPosition(headings, p.offset);
      if (sectionInfo.heading) topicHint = sectionInfo.heading;
    }

    return {
      content:         p.text,
      index:           i,  // will be re-indexed by caller
      doc_title:       docTitle,
      chunk_type:      "context",
      keywords:        extractKeywords(p.text),
      fields:          {},
      scope:           {},
      authority_level: authorityLevel,
      kp_type:         "paragraph_context",
      source_excerpt:  p.text.slice(0, 200),
      source_documents_json: JSON.stringify([{ doc_id: documentId, doc_title: docTitle, excerpt: p.text.slice(0, 200) }]),
      topic_hint:      topicHint,
      subtopic_hint:   "",
      confidence:      0.6
    };
  });
}
