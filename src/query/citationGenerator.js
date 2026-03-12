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
  if (numberedSources.length < 5) return null;

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
    content: (s.content || s.content_clean || s.chunk?.content || '').slice(0, 400),
    node_name: s.node_name || s.node?.name
  }));

  const sourceList = numberedSources.map(s =>
    `[${s.number}] ${s.title}${s.node_name ? ` (${s.node_name})` : ''}: ${s.content}`
  ).join('\n\n');

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
      : `Answer the question using the provided sources. Add [n] citations after each factual claim.

Question: ${query}

Sources:
${effectiveSourceList}

Rules:
- Read ALL sources before answering — the relevant information may be in any source.
- Extract and quote specific numbers, dates, and names exactly as written.
- Add [1], [2] etc. after each claim to indicate the source.
- Answer directly and concisely.

Answer:`);

    const answerModelOverride = getAnswerModel();
    let answerText = await callLLM({ prompt, temperature, maxOutputTokens: 1000, taskName: 'citation_generation', model: answerModelOverride }) || '';

    // Retry once if the first answer looks like a false "not in sources" response
    if (looksLikeNotFound(answerText)) {
      logger.debug(`citation_generation: "not found" detected, retrying with directive prompt`);
      const retryKey = isChineseLang(detectedLang) ? 'answerRetry_zh' : 'answerRetry_en';
      const retryPrompt = getCustomPrompt(retryKey, { query, sourceList })
        ?? (isChineseLang(detectedLang)
        ? `请仔细重新阅读以下所有来源，然后回答问题。\n\n问题: ${query}\n\n来源:\n${sourceList}\n\n重要：请不要说信息不存在，而是从来源中提取任何相关的事实、数字或描述。直接回答：`
        : `Re-read ALL sources carefully and answer the question. Do NOT say information is missing — extract any relevant facts, numbers, or descriptions present in the sources.\n\nQuestion: ${query}\n\nSources:\n${sourceList}\n\nAnswer directly:`);
      const retryText = await callLLM({ prompt: retryPrompt, temperature: 0.1, maxOutputTokens: 1000, taskName: 'citation_generation_retry', model: answerModelOverride });
      if (retryText) answerText = retryText;
    }

    // Structured extraction fallback: if answer still has no citations and sources contain
    // specific values the answer ignores, switch to a fact-extraction approach
    const firstPassCitations = extractCitationsFromAnswer(answerText);
    if (firstPassCitations.length === 0 && sourcesHaveValues(sourceList) && !answerCoversSourceValues(answerText, sourceList)) {
      logger.debug(`citation_generation: answer missing source values, trying structured extraction`);
      const extractPrompt = isChineseLang(detectedLang)
        ? `从以下来源中提取与问题相关的所有具体事实。列出每个事实并标注来源编号[n]。\n\n问题: ${query}\n\n来源:\n${sourceList}\n\n提取的事实：`
        : `Extract ALL specific facts from the sources that answer the question. List each fact with its source number [n]. Include exact numbers, dates, percentages, and durations.\n\nQuestion: ${query}\n\nSources:\n${sourceList}\n\nExtracted facts:`;
      try {
        const extractedText = await callLLM({ prompt: extractPrompt, temperature: 0.0, maxOutputTokens: 1000, taskName: 'citation_extraction_fallback', model: answerModelOverride });
        if (extractedText && !looksLikeNotFound(extractedText) && answerCoversSourceValues(extractedText, sourceList)) {
          answerText = extractedText;
        }
      } catch (extractErr) {
        logger.debug(`citation_extraction_fallback failed: ${extractErr.message}`);
      }
    }

    // Answer-source alignment check: extract key claims (values) from the answer
    // and verify they appear in at least one source. If alignment is very low,
    // regenerate with a structured prompt that forces source-grounded extraction.
    const answerValues = extractValuesFromText(answerText);
    if (answerValues.length >= 2) {
      let alignedCount = 0;
      for (const val of answerValues) {
        if (sourceList.toLowerCase().includes(val.toLowerCase())) alignedCount++;
      }
      const alignmentRatio = alignedCount / answerValues.length;
      if (alignmentRatio < 0.30) {
        logger.debug(`citation_generation: low answer-source alignment (${(alignmentRatio * 100).toFixed(0)}%), regenerating with structured prompt`);
        const alignPrompt = isChineseLang(detectedLang)
          ? `仔细阅读来源，然后仅使用来源中实际存在的信息来回答问题。引用来源中的具体数字、日期和名称。\n\n问题: ${query}\n\n来源:\n${sourceList}\n\n回答（引用具体数据）：`
          : `Read the sources carefully, then answer ONLY using information actually present in the sources. Quote specific numbers, dates, and names from the sources.\n\nQuestion: ${query}\n\nSources:\n${sourceList}\n\nAnswer (cite specific data):`;
        try {
          const alignedText = await callLLM({ prompt: alignPrompt, temperature: 0.0, maxOutputTokens: 1000, taskName: 'citation_alignment_regen', model: answerModelOverride });
          if (alignedText && !looksLikeNotFound(alignedText)) {
            // Check if the regenerated answer has better alignment
            const regenValues = extractValuesFromText(alignedText);
            let regenAligned = 0;
            for (const val of regenValues) {
              if (sourceList.toLowerCase().includes(val.toLowerCase())) regenAligned++;
            }
            const regenRatio = regenValues.length > 0 ? regenAligned / regenValues.length : 0;
            if (regenRatio > alignmentRatio) {
              answerText = alignedText;
            }
          }
        } catch (alignErr) {
          logger.debug(`citation_alignment_regen failed: ${alignErr.message}`);
        }
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
