import { logger } from "../utils/logger.js";
import { callLLM, isLlmConfigured } from "../utils/llm.js";
import { getCustomPrompt } from "../prompts/promptManager.js";
import { isNumericQuery, extractNegatedTerms, hasNumericContent } from "../utils/queryHelpers.js";

/**
 * Heuristic + optional LLM Re-ranking Module
 *
 * Scores chunks using three heuristic signals:
 *   - Keyword overlap with query (weight 0.30)
 *   - Original BM25 recall rank position (weight 0.20)
 *   - Embedding cosine similarity if available (weight 0.50)
 *
 * Query-type aware boosting:
 *   - Numeric queries: boost chunks containing numbers/percentages
 *   - Entity queries: boost chunks with proper nouns matching query entities
 *
 * Adaptive score-gap cutoff: keeps chunks within 40% of top score.
 *
 * When RERANKER_LLM_ENABLED=true, also calls LLM for a relevance score (0-10)
 * per chunk in a single batched prompt, then blends: 0.5 × llm + 0.5 × heuristic.
 */

const LLM_ENABLED = process.env.RERANKER_LLM_ENABLED === 'true';
const LLM_TOP_N   = Math.min(12, Math.max(3, parseInt(process.env.RERANKER_LLM_TOP_N, 10) || 8));

// Stop words filtered from query terms — prevents "what", "are", "the" from
// diluting keyword overlap scores. Without this, a 7-term query like "What are the
// SafeGuard neuromonitoring alert thresholds" has 4 content terms and 3 stop words,
// reducing overlap from 4/4=1.0 to 4/7=0.57 and causing minScore cutoff to drop
// relevant chunks.
const RERANKER_STOP_WORDS = new Set([
  "the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall",
  "can","must","of","in","on","at","to","for","by","with","from","as",
  "or","an","and","but","not","it","its","this","that","what","who","how",
  "when","where","which","why","all","any","each","few","more","most",
  "no","nor","so","than","too","very","just","up","out","if","then",
  "them","their","they","we","our","us","you","your","he","she","his","her",
  "my","me","into","about","over","after"
]);

/**
 * Score top-N chunks with a single LLM call.
 * Returns Map<originalIndex, llmScore 0-1>
 */
async function llmScoreChunks(query, chunks) {
  const scores = new Map();
  if (!isLlmConfigured()) return scores;

  const snippets = chunks.map((c, i) => {
    const text = (c.content || c.content_clean || '').slice(0, 300).replace(/\n+/g, ' ');
    return `[${i + 1}] ${text}`;
  }).join('\n\n');

  const prompt = getCustomPrompt('llmReranking', { query, snippets }) ?? `Rate each snippet's relevance to the question on a scale of 0–10. Reply with ONLY a numbered list like:
1. 7
2. 3
...

Question: ${query}

Snippets:
${snippets}

Ratings (0-10):`;

  try {
    const text = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 200, taskName: 'reranker_llm' });
    if (!text) return scores;

    const lines = text.split('\n');
    for (let i = 0; i < chunks.length; i++) {
      const line = (lines[i] || '').replace(/^\d+\.\s*/, '').trim();
      const val  = parseFloat(line);
      if (!Number.isNaN(val)) scores.set(i, Math.min(10, Math.max(0, val)) / 10);
    }
  } catch (err) {
    logger.warn(`Reranker LLM scoring failed: ${err.message}`);
  }
  return scores;
}

/**
 * Re-rank chunks using a heuristic score (+ optional LLM blend).
 * @param {string} query
 * @param {Array}  chunks  - Already sorted by BM25 recall rank (position 0 = best BM25)
 * @param {number} maxChunks
 * @returns {Promise<Array>}
 */
export async function rerankerChunks(query, chunks, optionsOrMaxChunks = 10) {
  // Accept either a number (legacy) or an options object
  const maxChunks = typeof optionsOrMaxChunks === 'number' ? optionsOrMaxChunks : (optionsOrMaxChunks?.topK ?? 10);
  const minScore  = typeof optionsOrMaxChunks === 'object' ? (optionsOrMaxChunks?.minScore ?? 0) : 0;
  if (!chunks || chunks.length === 0) return [];

  const rawTerms = (query || "").toLowerCase().match(/[a-z]{2,}|\d+/g) ?? [];
  const queryTerms = rawTerms.filter(t => !RERANKER_STOP_WORDS.has(t));
  // Fallback: if ALL terms were stop words, keep the raw set
  if (queryTerms.length === 0 && rawTerms.length > 0) queryTerms.push(...rawTerms);
  const queryLower = (query || "").toLowerCase();
  const n = chunks.length;

  // Detect query type for context-aware boosting
  const numericQuery = isNumericQuery(query) || /\b\d+\b/i.test(query);
  const isEntityQuery  = /\bwho\b|\bwhich\b|\bwhat.*(?:name|company|person|CEO|manager|director)\b|谁|哪个/i.test(query);
  // Extract named entities (capitalized multi-word phrases) from query
  const queryEntities = (query.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || []).map(e => e.toLowerCase());

  const scored = chunks.map((chunk, i) => {
    const content = (chunk.content || chunk.chunk?.content || chunk.content_clean || "").toLowerCase();

    // Signal 1 — keyword overlap (0–1)
    let overlapScore = 0;
    if (queryTerms.length > 0) {
      const matches = queryTerms.filter(t => content.includes(t)).length;
      overlapScore = matches / queryTerms.length;
    }

    // Signal 2 — BM25 rank position (0–1, pos 0 → 1.0)
    const rankScore = n > 1 ? 1 - i / (n - 1) : 1;

    // Signal 3 — embedding cosine similarity (default 0.0 if missing)
    const embScore = chunk.similarity != null && Number.isFinite(chunk.similarity) ? chunk.similarity : 0.0;

    let score = 0.30 * overlapScore + 0.20 * rankScore + 0.50 * embScore;

    // Query-type aware boosting
    if (numericQuery && /\d/.test(content)) {
      // Boost chunks containing numbers for numeric queries
      score += 0.05;
      // Extra boost if chunk contains percentages or unit-bearing numbers
      if (hasNumericContent(content)) {
        score += 0.05;
      }
    }
    if (isEntityQuery && queryEntities.length > 0) {
      // Boost chunks containing named entities from the query
      for (const entity of queryEntities) {
        if (content.includes(entity)) { score += 0.08; break; }
      }
    }

    return { ...chunk, rerank_score: score, rerank_score_raw: score, original_rank: i };
  });

  // Negation handling: penalize chunks heavily featuring negated terms
  const negatedTerms = extractNegatedTerms(query);
  if (negatedTerms.length > 0) {
    for (const item of scored) {
      const chunkContent = (item.content || item.content_clean || '').toLowerCase();
      for (const term of negatedTerms) {
        if (chunkContent.includes(term)) {
          item.rerank_score *= 0.4; // heavy penalty
          break;
        }
      }
    }
  }

  // Optional LLM scoring pass: score top LLM_TOP_N candidates
  if (LLM_ENABLED && scored.length > 0) {
    const topN     = scored.slice(0, LLM_TOP_N);
    const llmScores = await llmScoreChunks(query, topN);
    if (llmScores.size > 0) {
      for (let i = 0; i < topN.length; i++) {
        const llm = llmScores.get(i) ?? topN[i].rerank_score;
        topN[i].rerank_score = 0.5 * llm + 0.5 * topN[i].rerank_score;
      }
    }
  }

  scored.sort((a, b) => b.rerank_score - a.rerank_score);

  // Adaptive cutoff disabled: the maxChunks cap (from caller) is sufficient.
  // The previous score-gap cutoff (keep within 40-55% of top) dropped relevant
  // chunks from multi-part queries (e.g. 4-level alert table: Orange level dropped
  // because all levels scored similarly but varied by BM25 rank position).
  // Without embedding similarity (signal 3 is usually 0.0), scores cluster tightly
  // around keyword overlap — making any percentage cutoff arbitrary.
  let results = scored;

  // Apply minScore filter if provided
  if (minScore > 0) {
    results = results.filter(r => r.rerank_score >= minScore);
  }

  return results.slice(0, maxChunks);
}

/**
 * Re-rank nodes using keyword overlap with query terms.
 * @param {string} query
 * @param {Array}  nodes
 * @param {object} options
 * @returns {Promise<Array>}
 */
export async function rerankerNodes(query, nodes, options = {}) {
  const { topK = 5 } = options;

  if (!nodes || nodes.length === 0) return [];
  if (nodes.length <= 2) return nodes;

  const queryTerms = (query || "").toLowerCase().match(/[a-z]{2,}|\d+/g) ?? [];
  const n = nodes.length;

  const scored = nodes.map((nodeItem, i) => {
    const node = nodeItem.node || nodeItem;
    const text = ((node.name || "") + " " + (node.node_summary || "") + " " + (node.aliases || "")).toLowerCase();

    let overlapScore = 0;
    if (queryTerms.length > 0) {
      const matches = queryTerms.filter(t => text.includes(t)).length;
      overlapScore = matches / queryTerms.length;
    }

    const rankScore = n > 1 ? 1 - i / (n - 1) : 1;
    const score = 0.5 * overlapScore + 0.5 * rankScore;

    return { ...nodeItem, rerank_score: score };
  });

  scored.sort((a, b) => b.rerank_score - a.rerank_score);
  return scored.slice(0, topK);
}
