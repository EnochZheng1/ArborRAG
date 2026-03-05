import { classifyQuery, QUERY_TYPES } from "../query/classifier.js";
import { decomposeQuery } from "../query/decomposer.js";
import { getSuggestions, recordQuery } from "../query/suggestions.js";
import { queryLogger as logger } from "../utils/logger.js";

import { QueryTrace } from "./queryTrace.js";
import {
  callLLMAnswer,
  generateAnswerFromChunks,
  handleComparisonQuery,
  handleRecommendationQuery,
  handleReasoningQuery,
  handleAggregationQuery,
  handleSimpleLookup
} from "./queryHandlers.js";

export { callLLMAnswer };

// Main ask function - orchestrates the full Q&A flow with intelligent routing
export async function ask({ query, queryScope = null, options = {} }) {
  logger.info(`Processing query: "${query.substring(0, 100)}${query.length > 100 ? '...' : ''}"`);

  if (!query || typeof query !== "string") {
    logger.warn("Invalid query received");
    return { error: "Query is required and must be a string" };
  }

  const {
    // Feature toggles
    useClassification = true,
    useHybridSearch = true,
    useDecomposition = true,
    useReranking = true,
    useCitations = true,
    includeRelatedQuestions = true,
    trace: enableTrace = false,
    // Manual query type override (bypasses classification when set)
    forceQueryType = null,        // 'simple_lookup', 'comparison', 'recommendation', 'reasoning', 'aggregation'
    // Retrieval parameters
    topK = 10,                    // Number of top nodes/chunks to retrieve
    maxChunks = 20,               // Maximum chunks to include in context
    minConfidence = 0.0,          // Minimum confidence threshold (0.0-1.0)
    hybridAlpha = 0.5,            // Weight for vector vs BM25 (0=BM25 only, 1=vector only)
    rerankerThreshold = 0.2,      // Minimum reranker score to keep (0.2 * 10 = 2 on LLM 0-10 scale)
    contextWindow = 2,            // Number of neighboring chunks to include on each side
    temperature = 0.3             // LLM temperature for answer generation
  } = options;

  // Store retrieval options for passing to functions
  const retrievalOptions = {
    topK: Math.min(Math.max(1, topK), 50),
    maxChunks: Math.min(Math.max(1, maxChunks), 100),
    minConfidence: Math.min(Math.max(0, minConfidence), 1),
    hybridAlpha: Math.min(Math.max(0, hybridAlpha), 1),
    rerankerThreshold: Math.min(Math.max(0, rerankerThreshold), 1),
    contextWindow: Math.min(Math.max(0, contextWindow), 5),
    temperature: Math.min(Math.max(0, temperature), 1)
  };

  logger.debug(`Options: classification=${useClassification}, hybridSearch=${useHybridSearch}, topK=${retrievalOptions.topK}, minConfidence=${retrievalOptions.minConfidence}`);

  const trace = new QueryTrace(enableTrace);
  trace.addStep('Query Received', `Processing query: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`, {
    query_length: query.length,
    options: { useClassification, useHybridSearch, useDecomposition, useReranking }
  });

  // Record query for suggestions/history
  recordQuery(query, { queryType: 'pending' });

  // Step 0: Check for query decomposition (complex queries)
  let decomposition = null;
  if (useDecomposition) {
    try {
      decomposition = await decomposeQuery(query);
      if (decomposition.isComplex) {
        trace.addStep('Query Decomposition', `Decomposed into ${decomposition.subQueries.length} sub-queries`, {
          strategy: decomposition.strategy,
          subQueries: decomposition.subQueries.map(sq => sq.query)
        });
      }
    } catch (err) {
      logger.warn("Query decomposition failed:", err.message);
    }
  }

  // Step 1: Classify the query to determine handling strategy
  let classification = null;

  // Check for manual query type override
  if (forceQueryType && Object.values(QUERY_TYPES).includes(forceQueryType)) {
    // Manual classification - bypass AI
    classification = {
      query_type: forceQueryType,
      confidence: 1.0,
      entities: [],
      criteria: [],
      reasoning: 'Manual selection by user',
      method: 'manual'
    };
    logger.info(`Query type manually set to: ${forceQueryType}`);
    trace.addStep('Query Classification', `Manual override: ${forceQueryType}`, {
      query_type: forceQueryType,
      confidence: 1.0,
      method: 'manual'
    });
  } else if (useClassification) {
    try {
      classification = await classifyQuery(query, { useLLM: true });
      logger.info(`Query classified as: ${classification?.query_type || 'unknown'}`);
      trace.addStep('Query Classification', `Classified as: ${classification?.query_type || 'unknown'}`, {
        query_type: classification?.query_type,
        confidence: classification?.confidence,
        entities: classification?.entities?.slice(0, 5),
        criteria: classification?.criteria?.slice(0, 5)
      });
    } catch (err) {
      logger.warn("Query classification failed, using default handling:", err.message);
      trace.addStep('Query Classification', `Classification failed: ${err.message}`, null, 'error');
    }
  } else {
    trace.addStep('Query Classification', 'Skipped (disabled)', null, 'skipped');
  }

  // Step 2: Route to appropriate handler based on query type
  if (classification) {
    switch (classification.query_type) {
      case QUERY_TYPES.COMPARISON:
        trace.addStep('Route Decision', 'Routing to comparison handler');
        return { ...await handleComparisonQuery(query, classification, trace), trace: trace.getTrace() };

      case QUERY_TYPES.RECOMMENDATION:
        trace.addStep('Route Decision', 'Routing to recommendation handler');
        return { ...await handleRecommendationQuery(query, classification, trace), trace: trace.getTrace() };

      case QUERY_TYPES.REASONING:
        trace.addStep('Route Decision', 'Routing to reasoning handler');
        return { ...await handleReasoningQuery(query, classification, trace), trace: trace.getTrace() };

      case QUERY_TYPES.AGGREGATION:
        trace.addStep('Route Decision', 'Routing to aggregation handler');
        return { ...await handleAggregationQuery(query, classification, queryScope, useHybridSearch, trace), trace: trace.getTrace() };

      case QUERY_TYPES.SIMPLE_LOOKUP:
      default:
        trace.addStep('Route Decision', 'Using simple lookup handler');
        break;
    }
  }

  // Standard handling for simple lookups
  const result = await handleSimpleLookup(query, queryScope, useHybridSearch, trace, {
    useReranking,
    useCitations,
    includeRelatedQuestions,
    retrievalOptions
  });
  return { ...result, trace: trace.getTrace() };
}

// Simple ask without classification (for backwards compatibility)
export async function simpleAsk({ query, queryScope = null, options = {} }) {
  const { trace: enableTrace = false } = options;
  const trace = new QueryTrace(enableTrace);
  trace.addStep('Simple Ask', 'Using simple lookup without classification');
  const result = await handleSimpleLookup(query, queryScope, false, trace);
  return { ...result, trace: trace.getTrace() };
}
