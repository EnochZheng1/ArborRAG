import { callLLM, llmConfig } from "../utils/llm.js";
import { getPrompt, isChineseLang } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { logger } from "../utils/logger.js";

/**
 * LLM Re-ranking Module
 *
 * Re-ranks retrieval results using LLM for more accurate relevance scoring
 */

const rerankerCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Re-rank chunks using LLM
 * @param {string} query - Original query
 * @param {Array} chunks - Chunks to re-rank
 * @param {object} options - Options
 * @returns {Promise<Array>} Re-ranked chunks with LLM scores
 */
export async function rerankerChunks(query, chunks, options = {}) {
  const { topK = 10, minScore = 0.3 } = options;

  if (!chunks || chunks.length === 0) return [];
  if (chunks.length <= 3) return chunks; // Not worth re-ranking few items

  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return chunks.slice(0, topK);
  }

  // Take top candidates for re-ranking (limit to avoid token limits)
  const candidates = chunks.slice(0, Math.min(20, chunks.length));

  // Check cache
  const cacheKey = `${query}:${candidates.map(c => c.id || c.chunk?.id).join(',')}`;
  const cached = rerankerCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.results;
  }

  try {
    // Build prompt for batch scoring
    const chunkTexts = candidates.map((c, i) => {
      const content = c.content || c.chunk?.content || c.content_clean || '';
      const preview = content.slice(0, 300).replace(/\n/g, ' ');
      return `[${i}] ${preview}`;
    }).join('\n\n');

    // Detect language from query and use appropriate prompt
    const lang = getEffectiveLang(query);
    const prompt = getPrompt('reranking', lang, query, chunkTexts);

    const text = await callLLM({ prompt, temperature: 0.1, maxOutputTokens: 200, taskName: 'reranking' }) || '';

    // Parse scores
    const jsonMatch = text.match(/\[[\d,\s.]+\]/);
    if (!jsonMatch) {
      return candidates.slice(0, topK);
    }

    const scores = JSON.parse(jsonMatch[0]);

    // Attach scores and re-sort
    const scored = candidates.map((chunk, i) => ({
      ...chunk,
      rerank_score: scores[i] || 0,
      original_rank: i
    }));

    scored.sort((a, b) => b.rerank_score - a.rerank_score);

    const results = scored
      .filter(c => c.rerank_score >= minScore * 10)
      .slice(0, topK);

    // Cache results
    rerankerCache.set(cacheKey, { results, timestamp: Date.now() });

    // Clean old cache entries
    if (rerankerCache.size > 100) {
      const now = Date.now();
      for (const [key, value] of rerankerCache) {
        if (now - value.timestamp > CACHE_TTL) {
          rerankerCache.delete(key);
        }
      }
    }

    return results;
  } catch (error) {
    logger.warn(`Re-ranking error: ${error.message}`);
    return candidates.slice(0, topK);
  }
}

/**
 * Re-rank nodes using LLM
 * @param {string} query - Original query
 * @param {Array} nodes - Nodes to re-rank
 * @param {object} options - Options
 * @returns {Promise<Array>} Re-ranked nodes
 */
export async function rerankerNodes(query, nodes, options = {}) {
  const { topK = 5 } = options;

  if (!nodes || nodes.length === 0) return [];
  if (nodes.length <= 2) return nodes;

  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return nodes.slice(0, topK);
  }

  try {
    // Detect language from query
    const lang = getEffectiveLang(query);
    const aliasLabel = isChineseLang(lang) ? '别名' : 'aliases';

    const nodeTexts = nodes.map((n, i) => {
      const node = n.node || n;
      const name = node.name || node.node_id;
      const summary = node.node_summary || '';
      const aliases = node.aliases ? ` (${aliasLabel}: ${node.aliases})` : '';
      return `[${i}] ${name}${aliases}: ${summary.slice(0, 200)}`;
    }).join('\n');

    // Use bilingual prompt
    const prompt = getPrompt('nodeReranking', lang, query, nodeTexts);

    const text = await callLLM({ prompt, temperature: 0.1, maxOutputTokens: 100, taskName: 'node_reranking' }) || '';
    const jsonMatch = text.match(/\[[\d,\s.]+\]/);

    if (!jsonMatch) {
      return nodes.slice(0, topK);
    }

    const scores = JSON.parse(jsonMatch[0]);

    const scored = nodes.map((node, i) => ({
      ...node,
      rerank_score: scores[i] || 0
    }));

    scored.sort((a, b) => b.rerank_score - a.rerank_score);

    return scored.slice(0, topK);
  } catch (error) {
    logger.warn(`Node re-ranking error: ${error.message}`);
    return nodes.slice(0, topK);
  }
}
