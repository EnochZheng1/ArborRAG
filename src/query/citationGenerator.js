/**
 * Inline Citation Generator Module
 *
 * Adds source citations to LLM-generated answers
 */

import { callLLM, isLlmConfigured, getAnswerModel } from "../utils/llm.js";
import { detectLanguage, isChineseLang } from "../utils/langDetect.js";
import { logger } from "../utils/logger.js";
import { getCustomPrompt } from "../prompts/promptManager.js";

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate answer with inline citations
 * @param {string} query - Original query
 * @param {string} context - Retrieved context
 * @param {Array} sources - Source chunks with metadata
 * @param {object} options - Options
 * @returns {Promise<object>} Answer with citations
 */
/** Extract specific values (numbers with units, currency, dates) from text. */
function extractValuesFromText(text) {
  const vals = [];
  for (const m of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(%|percent|days?|hours?|months?|years?|minutes?|weeks?)\b/gi)) {
    vals.push(m[0].toLowerCase().replace(/\s+/g, ' ').trim());
  }
  for (const m of text.matchAll(/[$¥€£]\s?[\d,]+(?:\.\d+)?/g)) {
    vals.push(m[0].replace(/\s/g, ''));
  }
  for (const m of text.matchAll(/\b\d{4}-\d{2}(?:-\d{2})?\b/g)) {
    vals.push(m[0]);
  }
  return vals;
}

/** Check if sources contain specific quantitative values. */
function sourcesHaveValues(text) {
  return /\b\d+(?:[.,]\d+)?\s*(%|percent|days?|hours?|months?|years?|minutes?|weeks?)\b/i.test(text)
    || /[$¥€£]\s?[\d,]+/.test(text);
}

/** Check if answer covers at least some numeric values from sources. */
function answerCoversSourceValues(answer, sourceText) {
  const sourceNums = [...new Set([...sourceText.matchAll(/\b(\d+)\b/g)].map(m => m[1]))].filter(n => n.length >= 2 || parseInt(n) > 1);
  if (sourceNums.length === 0) return true;
  const answerText = answer.toLowerCase();
  return sourceNums.some(n => answerText.includes(n));
}

/**
 * Pre-summarize source chunks into 1-line query-relevant fact summaries.
 * Reduces noise so the answer-generation LLM focuses on the right facts.
 * Only invoked when there are 5+ sources (otherwise raw content is manageable).
 *
 * @param {string} query
 * @param {Array} numberedSources - [{ number, content, title, node_name }]
 * @param {string} detectedLang
 * @returns {Promise<string|null>} Summarized source list string, or null on failure / insufficient coverage.
 */
async function preSummarizeSources(query, numberedSources, detectedLang) {
  // Only summarize when source count is high (> 8). With 8 or fewer sources × 800 chars,
  // raw source text is ~6.4K — well within modern LLM context. Pre-summarization loses
  // multi-fact details (e.g., 5-step vascular injury protocol reduced to 1 sentence).
  if (numberedSources.length <= 8) return null;

  const sourceTexts = numberedSources.map(s =>
    `[${s.number}] ${s.content}`
  ).join('\n\n');

  const prompt = isChineseLang(detectedLang)
    ? `对于以下每个来源，提取与问题最相关的一个关键事实。保留具体的数字、日期和名称。如果来源与问题无关，写"无关"。

问题: ${query}

来源:
${sourceTexts}

每个来源的关键事实（格式: [n] 事实）:`
    : `For each source below, extract the ONE key fact most relevant to the question. Preserve exact numbers, dates, percentages, and names. If a source is irrelevant, write "N/A".

Question: ${query}

Sources:
${sourceTexts}

Key fact per source (format: [n] fact):`;

  try {
    const result = await callLLM({
      prompt,
      temperature: 0.0,
      maxOutputTokens: 600,
      taskName: 'source_pre_summarization',
      model: getAnswerModel()
    });

    if (!result) return null;

    // Parse the summarized lines back into a Map<sourceNumber, summary>
    const summaryMap = new Map();
    for (const line of result.split('\n')) {
      const match = line.match(/^\[(\d+)\]\s*(.+)/);
      if (match) {
        const text = match[2].trim();
        // Skip "N/A" / "无关" entries — keep original content for those
        if (!/^(n\/?a|无关|不相关|irrelevant)$/i.test(text)) {
          summaryMap.set(parseInt(match[1], 10), text);
        }
      }
    }

    // Only use summaries if we got reasonable coverage (>= 40%)
    if (summaryMap.size < numberedSources.length * 0.4) return null;

    // Build summarized source list — use summary where available, fall back to truncated original
    return numberedSources.map(s => {
      const summary = summaryMap.get(s.number);
      const content = summary || s.content.slice(0, 200);
      return `[${s.number}] ${s.title}${s.node_name ? ` (${s.node_name})` : ''}: ${content}`;
    }).join('\n\n');
  } catch (err) {
    logger.debug(`source_pre_summarization failed: ${err.message}`);
    return null;
  }
}

/** Detect false "not in sources" answers that should trigger a retry. */
function looksLikeNotFound(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    /not (in|found in|available in|present in|mentioned in|provided in) (the |my |these )?sources?/i.test(t) ||
    /information (is |)(not|isn't) (available|provided|present|found)/i.test(t) ||
    /cannot (find|locate|answer|provide)/i.test(t) ||
    /no (relevant |specific )?(information|data|detail)/i.test(t) ||
    /不在(来源|资料)中/.test(text) ||
    /缺少信息/.test(text) ||
    /找不到(相关)?信息/.test(text) ||
    /没有(提供|包含|找到)/.test(text) ||
    /信息不(足|够|在)/.test(text)
  );
}

export async function generateAnswerWithCitations(query, context, sources, options = {}) {
  const { lang = 'auto', maxSources = 10, temperature = 0.1 } = options;

  if (!isLlmConfigured()) {
    return {
      answer: context.slice(0, 500),
      citations: [],
      sources: sources.slice(0, maxSources)
    };
  }

  // Build numbered source list
  const numberedSources = sources.slice(0, maxSources).map((s, i) => ({
    number: i + 1,
    id: s.id || s.chunk?.id,
    title: s.doc_title || s.chunk?.doc_title || 'Unknown',
    content: (s.content || s.content_clean || s.chunk?.content || '').slice(0, 800),
    node_name: s.node_name || s.node?.name
  }));

  const sourceList = numberedSources.map(s =>
    `[${s.number}] ${s.title}${s.node_name ? ` (${s.node_name})` : ''}: ${s.content}`
  ).join('\n\n');

  logger.debug(`[citation_gen] Sources for "${query.slice(0, 60)}": ${numberedSources.map(s => `[${s.number}]=${s.id}`).join(', ')}`);

  try {
    // Detect language from context for better understanding
    const contextText = numberedSources.map(s => s.content).join(' ');
    const detectedLang = lang === 'auto' ? detectLanguage(contextText || query) : lang;

    // Pre-summarize sources to reduce noise when there are many (5+).
    // The answer prompt uses focused summaries; retry/fallback paths keep
    // the full sourceList so they can still find values the summary omitted.
    let effectiveSourceList = sourceList;
    const summarized = await preSummarizeSources(query, numberedSources, detectedLang);
    if (summarized) {
      effectiveSourceList = summarized;
      logger.debug(`citation_generation: using pre-summarized sources (${numberedSources.length} sources)`);
    }

    // Use bilingual prompts based on detected language — check for custom override first
    const answerKey = isChineseLang(detectedLang) ? 'answerGeneration_zh' : 'answerGeneration_en';
    const prompt = getCustomPrompt(answerKey, { query, sourceList: effectiveSourceList })
      ?? (isChineseLang(detectedLang)
      ? `根据以下来源回答问题。在每个事实性陈述后添加[n]引用。

问题: ${query}

来源:
${effectiveSourceList}

规则:
- 回答前请阅读所有来源——相关信息可能在任何一个来源中。
- 准确引用数字、日期和名称。
- 在每个陈述后添加[1]、[2]等引用编号。
- 简洁直接地回答。

回答:`
      : `Answer the question using ONLY the provided sources. Add [n] citations after each factual claim.

Question: ${query}

Sources:
${effectiveSourceList}

Rules:
- Read ALL sources before answering — the relevant information may be in any source.
- Extract and quote specific numbers, dates, percentages, dollar amounts, and ranges exactly as written in the sources.
- Add [1], [2] etc. after each claim to indicate the source.
- Be COMPLETE: if the sources contain a table, list, or multi-level structure (e.g. alert levels, approval tiers, salary bands), include ALL rows/levels — do not skip or summarize any.
- When the sources contain tiered/bracketed ranges (dollar ranges, thresholds, levels), reproduce the applicable tier with its EXACT boundary values. Example: write "$2,000 - $10,000: skip-level manager approval" rather than just "skip-level manager approval".
- Answer directly and thoroughly.

Answer:`);

    const answerModelOverride = getAnswerModel();
    let answerText = await callLLM({ prompt, temperature, maxOutputTokens: 2000, thinkingBudget: 0, taskName: 'citation_generation', model: answerModelOverride }) || '';

    // Unified retry: combine "not found" detection, missing-value detection, and
    // low alignment into a SINGLE retry call instead of 2-3 sequential LLM calls.
    // This reduces worst-case from 4 LLM calls to 2 (main + retry).
    const notFoundInAnswer = looksLikeNotFound(answerText);
    const firstPassCitations = extractCitationsFromAnswer(answerText);
    const answerValues = extractValuesFromText(answerText);
    let alignmentScore = 1.0;
    if (answerValues.length >= 2) {
      let alignedCount = 0;
      for (const val of answerValues) {
        if (sourceList.toLowerCase().includes(val.toLowerCase())) alignedCount++;
      }
      alignmentScore = alignedCount / answerValues.length;
    }
    const missingSourceValues = firstPassCitations.length === 0
      && sourcesHaveValues(sourceList)
      && !answerCoversSourceValues(answerText, sourceList);

    const needsRetry = notFoundInAnswer || alignmentScore < 0.30 || missingSourceValues;
    if (needsRetry) {
      const reasons = [];
      if (notFoundInAnswer) reasons.push('"not found" detected');
      if (alignmentScore < 0.30) reasons.push(`low alignment (${(alignmentScore * 100).toFixed(0)}%)`);
      if (missingSourceValues) reasons.push('missing source values');
      logger.debug(`citation_generation: unified retry — ${reasons.join(', ')}`);

      // Build a unified retry prompt that addresses all failure modes:
      // - Forces re-reading of sources (handles "not found")
      // - Demands exact values from sources (handles alignment)
      // - Requests structured fact extraction with citations (handles missing citations)
      const retryKey = isChineseLang(detectedLang) ? 'answerRetry_zh' : 'answerRetry_en';
      const unifiedRetryPrompt = getCustomPrompt(retryKey, { query, sourceList })
        ?? (isChineseLang(detectedLang)
        ? `请仔细重新阅读以下所有来源，然后回答问题。不要说信息不存在。

问题: ${query}

来源:
${sourceList}

规则：
- 从来源中提取所有相关事实、数字、日期和百分比。
- 直接引用来源中的具体数据，不要修改数字。
- 在每个事实后用[n]标注来源编号。
- 如果来源包含分级/分类信息，列出所有级别。

回答：`
        : `Re-read ALL sources carefully and answer the question. Do NOT say information is missing.

Question: ${query}

Sources:
${sourceList}

Rules:
- Extract ALL relevant facts, numbers, dates, percentages, and durations from the sources.
- Quote specific values exactly as written in the sources — do not alter numbers.
- Add [n] citation after each factual claim to indicate the source.
- If sources contain tiered/categorized information, include ALL tiers with exact boundary values.

Answer:`);
      try {
        const retryText = await callLLM({ prompt: unifiedRetryPrompt, temperature: 0.0, maxOutputTokens: 2000, thinkingBudget: 0, taskName: 'citation_generation_unified_retry', model: answerModelOverride });
        if (retryText && !looksLikeNotFound(retryText)) {
          // Check if the retry improved alignment (if alignment was the issue)
          if (alignmentScore < 0.30 && answerValues.length >= 2) {
            const regenValues = extractValuesFromText(retryText);
            let regenAligned = 0;
            for (const val of regenValues) {
              if (sourceList.toLowerCase().includes(val.toLowerCase())) regenAligned++;
            }
            const regenRatio = regenValues.length > 0 ? regenAligned / regenValues.length : 0;
            // Only use retry if it improved alignment or original was "not found"
            if (regenRatio > alignmentScore || notFoundInAnswer || missingSourceValues) {
              answerText = retryText;
            }
          } else {
            // For "not found" or missing values, always prefer the retry
            answerText = retryText;
          }
        }
      } catch (retryErr) {
        logger.debug(`citation_generation_unified_retry failed: ${retryErr.message}`);
      }
    }

    // Source→answer value enrichment: check if top cited sources contain tiered
    // dollar/numeric ranges whose boundary values the answer omits. If so, append
    // the relevant tier to the answer. This compensates for LLMs that summarize
    // tiers as just the action (e.g., "skip-level approval") without quoting the
    // bracket boundaries ("$2,000-$10,000").
    const citedNums = [...answerText.matchAll(/\[(\d+)\]/g)].map(m => parseInt(m[1], 10));
    const topCited = citedNums.slice(0, 3);
    let enriched = false;
    for (const num of topCited) {
      if (enriched) break;
      const src = numberedSources.find(s => s.number === num);
      if (!src) continue;
      const srcContent = src.content || '';
      // Split source into lines and find tiered lines with dollar ranges
      const tierLines = srcContent.split('\n').filter(l => /\$[\d,]+/.test(l));
      if (tierLines.length < 2) continue; // need at least 2 tiers to be a tiered structure
      const ansLower = answerText.toLowerCase();
      // Stop words to exclude from tier matching (prevent "the", "with" etc. from inflating scores)
      const tierStopWords = new Set([
        'the','and','for','with','from','that','this','into','over','under',
        'all','any','are','was','has','had','not','but','can','may','will',
        'must','also','than','each','per','via','plus','least','before',
        'after','within','through','about','between','during','requires',
        'required','form','submitted','business','days','upon','its'
      ]);
      // Build word frequency across all tiers to identify distinctive words
      const allTierWords = new Map();
      const tierDescriptions = tierLines.map(line => {
        const desc = line.replace(/\$[\d,]+(?:\.\d+)?/g, '').replace(/[-–—:;()\[\]]/g, ' ').trim().toLowerCase();
        const words = desc.split(/\s+/).filter(w => w.length >= 3 && !tierStopWords.has(w));
        for (const w of words) allTierWords.set(w, (allTierWords.get(w) || 0) + 1);
        return { line, words };
      });
      // Score: distinctive words (appear in only 1 tier) matching the answer count 3x
      let bestTier = null;
      let bestScore = 0;
      for (const { line, words } of tierDescriptions) {
        let score = 0;
        for (const w of words) {
          if (!ansLower.includes(w)) continue;
          score += (allTierWords.get(w) === 1) ? 3 : 1; // distinctive words score 3x
        }
        if (score <= 0) continue;
        const ranges = [...line.matchAll(/\$[\d,]+(?:\.\d+)?/g)].map(m => m[0]);
        const bounds = ranges.map(r => r.replace(/[$]/g, ''));
        const missing = bounds.filter(b => !ansLower.includes(b));
        if (missing.length > 0 && bounds.length >= 1 && score > bestScore) {
          bestScore = score;
          bestTier = line;
        }
      }
      if (bestTier) {
        const cleanLine = bestTier.replace(/^[\s\-*]+/, '').trim();
        answerText += `\n\nThe applicable approval tier is: ${cleanLine} [${num}].`;
        enriched = true;
      }
    }

    // Extract citations used
    const citationsUsed = extractCitationsFromAnswer(answerText);

    // Build citation list
    const citations = citationsUsed.map(num => {
      const source = numberedSources.find(s => s.number === num);
      return source ? {
        number: num,
        title: source.title,
        chunk_id: source.id,
        node_name: source.node_name
      } : null;
    }).filter(Boolean);

    return {
      answer: answerText,
      answer_html: formatAnswerWithCitationLinks(answerText, citations),
      citations,
      sources: numberedSources.map(s => ({
        number: s.number,
        title: s.title,
        chunk_id: s.id,
        node_name: s.node_name,
        preview: s.content.slice(0, 150)
      }))
    };
  } catch (error) {
    logger.warn(`Citation generation error: ${error.message}`);
    return {
      answer: 'Error generating answer',
      citations: [],
      sources: numberedSources
    };
  }
}

/**
 * Extract citation numbers from answer text
 */
function extractCitationsFromAnswer(text) {
  const citations = new Set();
  const matches = text.matchAll(/\[(\d+)\]/g);

  for (const match of matches) {
    citations.add(parseInt(match[1], 10));
  }

  return Array.from(citations).sort((a, b) => a - b);
}

/**
 * Format answer with clickable citation links
 */
function formatAnswerWithCitationLinks(text, citations) {
  // Escape LLM-generated text first to prevent XSS via injected HTML
  let html = escapeHtml(text);

  // Replace [n] with clickable cite elements (safe after escaping — brackets are not HTML-special)
  html = html.replace(/\[(\d+)\]/g, (match, num) => {
    const citation = citations.find(c => c.number === parseInt(num, 10));
    if (citation) {
      const safeChunkId = escapeHtml(citation.chunk_id);
      const safeTitle = escapeHtml(citation.title);
      return `<cite data-citation="${num}" data-chunk-id="${safeChunkId}" title="${safeTitle}">[${num}]</cite>`;
    }
    return match;
  });

  // Convert newlines to paragraphs
  html = html.split('\n\n').map(p => p.trim()).filter(p => p).map(p => `<p>${p}</p>`).join('');

  return html;
}

/**
 * Add citations to an existing answer (post-hoc)
 * @param {string} answer - Existing answer
 * @param {Array} sources - Available sources
 * @returns {Promise<object>} Answer with citations added
 */
export async function addCitationsToAnswer(answer, sources, options = {}) {
  if (!isLlmConfigured() || !answer || !sources || sources.length === 0) {
    return { answer, citations: [], sources };
  }

  const numberedSources = sources.slice(0, 10).map((s, i) => ({
    number: i + 1,
    id: s.id || s.chunk?.id,
    title: s.doc_title || s.chunk?.doc_title || 'Unknown',
    content: (s.content || s.content_clean || s.chunk?.content || '').slice(0, 300)
  }));

  try {
    const sourceList = numberedSources.map(s =>
      `[${s.number}] ${s.content}`
    ).join('\n\n');

    const prompt = getCustomPrompt('addCitations', { answer, sourceList }) ?? `Add citation numbers to this answer based on which sources support each statement.

Answer to annotate:
${answer}

Sources:
${sourceList}

Add [n] citations after statements that are supported by source n. Only cite sources that actually support the statement.
Return the annotated answer only:`;

    const annotatedAnswer = await callLLM({ prompt, temperature: 0.1, maxOutputTokens: 1500, taskName: 'add_citations' }) || answer;
    const citationsUsed = extractCitationsFromAnswer(annotatedAnswer);

    const citations = citationsUsed.map(num => {
      const source = numberedSources.find(s => s.number === num);
      return source ? {
        number: num,
        title: source.title,
        chunk_id: source.id
      } : null;
    }).filter(Boolean);

    return {
      answer: annotatedAnswer,
      answer_html: formatAnswerWithCitationLinks(annotatedAnswer, citations),
      citations,
      sources: numberedSources
    };
  } catch (error) {
    logger.warn(`Error adding citations: ${error.message}`);
    return { answer, citations: [], sources: numberedSources };
  }
}

/**
 * Verify citations in an answer
 * @param {string} answer - Answer with citations
 * @param {Array} sources - Source chunks
 * @returns {object} Verification result
 */
export function verifyCitations(answer, sources) {
  const citationsUsed = extractCitationsFromAnswer(answer);
  const verification = {
    total_citations: citationsUsed.length,
    valid_citations: 0,
    invalid_citations: [],
    uncited_claims: []
  };

  // Check each citation exists
  for (const num of citationsUsed) {
    if (num <= sources.length && num > 0) {
      verification.valid_citations++;
    } else {
      verification.invalid_citations.push(num);
    }
  }

  // Simple heuristic: sentences without citations might be uncited claims
  const sentences = answer.split(/[.。!！?？]/).filter(s => s.trim().length > 20);
  for (const sentence of sentences) {
    if (!sentence.match(/\[\d+\]/) && !isBoilerplate(sentence)) {
      verification.uncited_claims.push(sentence.trim().slice(0, 100));
    }
  }

  verification.citation_coverage = sentences.length > 0
    ? Math.round((sentences.length - verification.uncited_claims.length) / sentences.length * 100)
    : 100;

  return verification;
}

/**
 * Check if sentence is boilerplate (doesn't need citation)
 */
function isBoilerplate(sentence) {
  const boilerplatePatterns = [
    /^(in summary|to summarize|overall|in conclusion|therefore|thus|hence)/i,
    /^(根据|总之|综上|因此|所以)/,
    /^(here are|the following|below|above)/i,
    /\?$/  // Questions don't need citations
  ];

  return boilerplatePatterns.some(p => p.test(sentence.trim()));
}

/**
 * Format citations as footnotes
 * @param {Array} citations - Citation objects
 * @returns {string} HTML footnotes
 */
export function formatCitationsAsFootnotes(citations) {
  if (!citations || citations.length === 0) return '';

  const footnotes = citations.map(c => {
    const safeTitle = escapeHtml(c.title);
    const safeNodeName = c.node_name ? escapeHtml(c.node_name) : null;
    return `<div class="footnote" id="cite-${c.number}">
      <span class="footnote-number">[${c.number}]</span>
      <span class="footnote-title">${safeTitle}</span>
      ${safeNodeName ? `<span class="footnote-node">(${safeNodeName})</span>` : ''}
    </div>`;
  }).join('');

  return `<div class="footnotes"><h4>Sources</h4>${footnotes}</div>`;
}
