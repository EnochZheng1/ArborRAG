/**
 * Inline Citation Generator Module
 *
 * Adds source citations to LLM-generated answers
 */

import { GoogleGenAI } from "@google/genai";
import { detectLanguage } from "../utils/langDetect.js";

/**
 * Generate answer with inline citations
 * @param {string} query - Original query
 * @param {string} context - Retrieved context
 * @param {Array} sources - Source chunks with metadata
 * @param {object} options - Options
 * @returns {Promise<object>} Answer with citations
 */
export async function generateAnswerWithCitations(query, context, sources, options = {}) {
  const { lang = 'auto', maxSources = 10, temperature = 0.3 } = options;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    // Detect language from context for better understanding
    const contextText = numberedSources.map(s => s.content).join(' ');
    const detectedLang = lang === 'auto' ? detectLanguage(contextText || query) : lang;

    // Use bilingual prompts based on detected language
    const prompt = detectedLang === 'zh'
      ? `使用提供的来源回答问题。使用[n]格式添加内联引用。

问题: ${query}

来源:
${sourceList}

说明:
1. 基于来源回答问题
2. 在引用来源的陈述后添加引用编号[1]、[2]等
3. 如果多个来源支持一个观点，全部引用: [1][3]
4. 如果信息不在来源中，请说明
5. 简洁但全面
6. 使用中文回答

带引用的回答:`
      : `Answer the question using ONLY the provided sources. Include inline citations using [n] format.

Question: ${query}

Sources:
${sourceList}

Instructions:
1. Answer the question based on the sources
2. Add citation numbers [1], [2], etc. after statements from those sources
3. If multiple sources support a point, cite all: [1][3]
4. If information isn't in sources, say so
5. Be concise but thorough
6. Answer in English

Answer with citations:`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature,
        maxOutputTokens: 1000
      }
    });

    const answerText = response.text?.trim() || '';

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
    console.error('Citation generation error:', error.message);
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
  let html = text;

  // Replace [n] with clickable spans
  html = html.replace(/\[(\d+)\]/g, (match, num) => {
    const citation = citations.find(c => c.number === parseInt(num, 10));
    if (citation) {
      return `<cite data-citation="${num}" data-chunk-id="${citation.chunk_id}" title="${citation.title}">[${num}]</cite>`;
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !answer || !sources || sources.length === 0) {
    return { answer, citations: [], sources };
  }

  const numberedSources = sources.slice(0, 10).map((s, i) => ({
    number: i + 1,
    id: s.id || s.chunk?.id,
    title: s.doc_title || s.chunk?.doc_title || 'Unknown',
    content: (s.content || s.content_clean || s.chunk?.content || '').slice(0, 300)
  }));

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    const sourceList = numberedSources.map(s =>
      `[${s.number}] ${s.content}`
    ).join('\n\n');

    const prompt = `Add citation numbers to this answer based on which sources support each statement.

Answer to annotate:
${answer}

Sources:
${sourceList}

Add [n] citations after statements that are supported by source n. Only cite sources that actually support the statement.
Return the annotated answer only:`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.1, maxOutputTokens: 1500 }
    });

    const annotatedAnswer = response.text?.trim() || answer;
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
    console.error('Error adding citations:', error.message);
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

  const footnotes = citations.map(c =>
    `<div class="footnote" id="cite-${c.number}">
      <span class="footnote-number">[${c.number}]</span>
      <span class="footnote-title">${c.title}</span>
      ${c.node_name ? `<span class="footnote-node">(${c.node_name})</span>` : ''}
    </div>`
  ).join('');

  return `<div class="footnotes"><h4>Sources</h4>${footnotes}</div>`;
}
