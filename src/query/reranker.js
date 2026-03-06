import { logger } from "../utils/logger.js";
import { callLLM, llmConfig } from "../utils/llm.js";

/**
 * Heuristic + optional LLM Re-ranking Module
 *
 * Scores chunks using three heuristic signals:
 *   - Keyword overlap with query (weight 0.4)
 *   - Original BM25 recall rank position (weight 0.4)
 *   - Embedding cosine similarity if available (weight 0.2)
 *
 * When RERANKER_LLM_ENABLED=true, also calls LLM for a relevance score (0-10)
 * per chunk in a single batched prompt, then blends: 0.5 × llm + 0.5 × heuristic.
 */

const LLM_ENABLED = process.env.RERANKER_LLM_ENABLED === 'true';
const LLM_TOP_N   = Math.min(12, Math.max(3, parseInt(process.env.RERANKER_LLM_TOP_N, 10) || 8));

/**
 * Score top-N chunks with a single LLM call.
 * Returns Map<originalIndex, llmScore 0-1>
 */
async function llmScoreChunks(query, chunks) {
  const scores = new Map();
  if (!llmConfig[llmConfig.provider]?.apiKey) return scores;

  const snippets = chunks.map((c, i) => {
    const text = (c.content || c.content_clean || '').slice(0, 300).replace(/\n+/g, ' ');
    return `[${i + 1}] ${text}`;
  }).join('\n\n');

  const prompt = `Rate each snippet's relevance to the question on a scale of 0–10. Reply with ONLY a numbered list like:
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
export async function rerankerChunks(query, chunks, maxChunks = 10) {
  if (!chunks || chunks.length === 0) return [];

  const queryTerms = (query || "").toLowerCase().match(/[a-z]{2,}|\d+/g) ?? [];
  const n = chunks.length;

  const scored = chunks.map((chunk, i) => {
    // Signal 1 — keyword overlap (0–1)
    let overlapScore = 0;
    if (queryTerms.length > 0) {
      const content = (chunk.content || chunk.chunk?.content || chunk.content_clean || "").toLowerCase();
      const matches = queryTerms.filter(t => content.includes(t)).length;
      overlapScore = matches / queryTerms.length;
    }

    // Signal 2 — BM25 rank position (0–1, pos 0 → 1.0)
    const rankScore = n > 1 ? 1 - i / (n - 1) : 1;

    // Signal 3 — embedding cosine similarity (default 0.5 if missing)
    const embScore = chunk.similarity != null ? chunk.similarity : 0.5;

    const score = 0.4 * overlapScore + 0.4 * rankScore + 0.2 * embScore;

    return { ...chunk, rerank_score: score, rerank_score_raw: score, original_rank: i };
  });

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

  // Score-gap cutoff: if top score is strong and there's a large drop, cut there
  let results = scored;
  if (results.length > 3 && results[0].rerank_score >= 0.6) {
    const GAP_THRESHOLD = 0.3;
    for (let i = 1; i < results.length; i++) {
      const drop = results[i - 1].rerank_score - results[i].rerank_score;
      if (drop >= GAP_THRESHOLD && i >= 2) {
        results = results.slice(0, i);
        break;
      }
    }
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
