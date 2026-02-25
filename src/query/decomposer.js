import { callLLM, llmConfig } from "../utils/llm.js";
import { logger } from "../utils/logger.js";

/**
 * Query Decomposition Module
 *
 * Breaks complex queries into simpler sub-queries for better retrieval
 */

const decompositionCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Decompose a complex query into sub-queries
 * @param {string} query - Original query
 * @param {object} options - Options
 * @returns {Promise<object>} Decomposition result
 */
export async function decomposeQuery(query, options = {}) {
  const { maxSubQueries = 4, minComplexity = 2 } = options;

  // Check cache
  const cached = decompositionCache.get(query);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  // Quick check: if query is simple, don't decompose
  if (isSimpleQuery(query)) {
    const result = {
      isComplex: false,
      original: query,
      subQueries: [{ query, type: 'direct', priority: 1 }],
      strategy: 'direct'
    };
    return result;
  }

  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return {
      isComplex: false,
      original: query,
      subQueries: [{ query, type: 'direct', priority: 1 }],
      strategy: 'direct'
    };
  }

  try {
    const prompt = `Analyze this query and determine if it should be broken into simpler sub-queries for better information retrieval.

Query: "${query}"

If the query is complex (asks multiple things, requires comparing, or needs multi-step reasoning), decompose it.
If simple (single topic, direct question), keep it as-is.

Return JSON:
{
  "isComplex": true/false,
  "strategy": "direct" | "parallel" | "sequential" | "comparison",
  "subQueries": [
    {"query": "sub-query text", "type": "main|supporting|comparison", "priority": 1-3}
  ],
  "mergeStrategy": "combine" | "compare" | "aggregate"
}

Rules:
- Maximum ${maxSubQueries} sub-queries
- Each sub-query should be self-contained
- "parallel" = retrieve all independently, merge results
- "sequential" = later queries may depend on earlier results
- "comparison" = retrieve info for each entity separately

JSON only:`;

    const text = await callLLM({ prompt, temperature: 0.2, maxOutputTokens: 500, taskName: 'query_decomposition' }) || '';

    // Parse JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        isComplex: false,
        original: query,
        subQueries: [{ query, type: 'direct', priority: 1 }],
        strategy: 'direct'
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    result.original = query;

    // Validate and clean
    if (!result.subQueries || result.subQueries.length === 0) {
      result.subQueries = [{ query, type: 'direct', priority: 1 }];
      result.isComplex = false;
    }

    // Sort by priority
    result.subQueries.sort((a, b) => (a.priority || 1) - (b.priority || 1));

    // Cache result
    decompositionCache.set(query, { result, timestamp: Date.now() });

    // Clean old cache
    if (decompositionCache.size > 50) {
      const now = Date.now();
      for (const [key, value] of decompositionCache) {
        if (now - value.timestamp > CACHE_TTL) {
          decompositionCache.delete(key);
        }
      }
    }

    return result;
  } catch (error) {
    logger.warn(`Query decomposition error: ${error.message}`);
    return {
      isComplex: false,
      original: query,
      subQueries: [{ query, type: 'direct', priority: 1 }],
      strategy: 'direct'
    };
  }
}

/**
 * Check if query is simple (heuristic)
 */
function isSimpleQuery(query) {
  const words = query.split(/\s+/).length;

  // Very short queries are simple
  if (words <= 5) return true;

  // Check for complexity indicators
  const complexPatterns = [
    /和|与|以及|还有/,           // Chinese "and"
    /比较|对比|区别|不同/,        // Comparison
    /为什么.*怎么|怎么.*为什么/,   // Multiple question words
    /首先.*然后|第一.*第二/,       // Sequential
    /and|or|versus|vs|compare/i,  // English connectors
    /what.*how|how.*what|why.*when/i,  // Multiple question types
    /both|all|each|every/i        // Plural references
  ];

  for (const pattern of complexPatterns) {
    if (pattern.test(query)) return false;
  }

  // Count question marks
  const questionMarks = (query.match(/[？?]/g) || []).length;
  if (questionMarks > 1) return false;

  return true;
}

/**
 * Merge results from sub-queries
 * @param {Array} subResults - Results from each sub-query
 * @param {object} decomposition - Original decomposition
 * @returns {object} Merged results
 */
export function mergeSubQueryResults(subResults, decomposition) {
  const merged = {
    original_query: decomposition.original,
    strategy: decomposition.strategy,
    sub_queries: [],
    all_chunks: [],
    all_nodes: new Map(),
    combined_context: ''
  };

  const seenChunkIds = new Set();

  for (let i = 0; i < subResults.length; i++) {
    const subQuery = decomposition.subQueries[i];
    const result = subResults[i];

    merged.sub_queries.push({
      query: subQuery.query,
      type: subQuery.type,
      chunk_count: result.chunks?.length || 0,
      node_count: result.nodes?.length || 0
    });

    // Collect chunks (deduplicated)
    const chunks = result.chunks || [];
    for (const chunk of chunks) {
      const chunkId = chunk.id || chunk.chunk?.id;
      if (chunkId && !seenChunkIds.has(chunkId)) {
        seenChunkIds.add(chunkId);
        merged.all_chunks.push({
          ...chunk,
          from_subquery: i,
          subquery_type: subQuery.type
        });
      }
    }

    // Collect nodes
    const nodes = result.nodes || [];
    for (const node of nodes) {
      const nodeId = node.node_id || node.node?.node_id;
      if (nodeId && !merged.all_nodes.has(nodeId)) {
        merged.all_nodes.set(nodeId, node);
      }
    }
  }

  // Sort chunks by relevance
  merged.all_chunks.sort((a, b) => {
    // Prioritize main query results
    const aMain = a.subquery_type === 'main' ? 1 : 0;
    const bMain = b.subquery_type === 'main' ? 1 : 0;
    if (aMain !== bMain) return bMain - aMain;

    // Then by score
    const aScore = a.score || a.rerank_score || 0;
    const bScore = b.score || b.rerank_score || 0;
    return bScore - aScore;
  });

  // Build combined context
  merged.combined_context = buildMergedContext(merged, decomposition.mergeStrategy);

  // Convert nodes map to array
  merged.all_nodes = Array.from(merged.all_nodes.values());

  return merged;
}

/**
 * Build context string from merged results
 */
function buildMergedContext(merged, mergeStrategy) {
  const parts = [];

  if (mergeStrategy === 'compare') {
    // Group by subquery for comparison
    const bySubquery = new Map();
    for (const chunk of merged.all_chunks) {
      const key = chunk.from_subquery;
      if (!bySubquery.has(key)) bySubquery.set(key, []);
      bySubquery.get(key).push(chunk);
    }

    for (const [idx, chunks] of bySubquery) {
      const subQuery = merged.sub_queries[idx];
      parts.push(`## ${subQuery.query}\n`);
      for (const chunk of chunks.slice(0, 5)) {
        const content = chunk.content || chunk.content_clean || chunk.chunk?.content || '';
        parts.push(content.slice(0, 500));
      }
      parts.push('');
    }
  } else {
    // Default: combine all chunks
    for (const chunk of merged.all_chunks.slice(0, 15)) {
      const content = chunk.content || chunk.content_clean || chunk.chunk?.content || '';
      const source = chunk.doc_title || chunk.chunk?.doc_title || '';
      parts.push(`[${source}]\n${content.slice(0, 600)}`);
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Execute decomposed query retrieval
 * @param {object} decomposition - Decomposition result
 * @param {function} retrieveFn - Function to retrieve for single query
 * @returns {Promise<object>} Merged results
 */
export async function executeDecomposedRetrieval(decomposition, retrieveFn) {
  if (!decomposition.isComplex || decomposition.subQueries.length <= 1) {
    // Simple query, just retrieve directly
    const result = await retrieveFn(decomposition.original);
    return {
      original_query: decomposition.original,
      strategy: 'direct',
      ...result
    };
  }

  // Execute sub-queries based on strategy
  let subResults;

  if (decomposition.strategy === 'sequential') {
    // Execute sequentially
    subResults = [];
    for (const subQuery of decomposition.subQueries) {
      const result = await retrieveFn(subQuery.query);
      subResults.push(result);
    }
  } else {
    // Execute in parallel
    subResults = await Promise.all(
      decomposition.subQueries.map(sq => retrieveFn(sq.query))
    );
  }

  // Merge results
  return mergeSubQueryResults(subResults, decomposition);
}
