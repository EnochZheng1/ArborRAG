import { classifyQuery, QUERY_TYPES } from "../query/classifier.js";
import { decomposeQuery } from "../query/decomposer.js";
import { getSuggestions, recordQuery } from "../query/suggestions.js";
import { expandFollowUpQuery, recordQuerySession } from "../query/querySession.js";
import { queryLogger as logger } from "../utils/logger.js";
import { getActiveDatasetId } from "../db/activeDb.js";

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

// ── Result cache with TTL ──────────────────────────────────────────────────────
const _resultCache = new Map();
const RESULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function _getCachedResult(query, datasetId) {
  const key = `${datasetId}:${query.trim().toLowerCase()}`;
  const entry = _resultCache.get(key);
  if (entry && Date.now() - entry.ts < RESULT_CACHE_TTL) return entry.result;
  _resultCache.delete(key);
  return null;
}

function _setCachedResult(query, datasetId, result) {
  const key = `${datasetId}:${query.trim().toLowerCase()}`;
  _resultCache.set(key, { result, ts: Date.now() });
  // Evict old entries periodically
  if (_resultCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _resultCache) {
      if (now - v.ts > RESULT_CACHE_TTL) _resultCache.delete(k);
    }
  }
}

// Main ask function - orchestrates the full Q&A flow with intelligent routing
export async function ask({ query, queryScope = null, options = {} }) {
  logger.info(`Processing query: "${query.substring(0, 100)}${query.length > 100 ? '...' : ''}"`);

  if (!query || typeof query !== "string") {
    logger.warn("Invalid query received");
    return { error: "Query is required and must be a string" };
  }

  // Check result cache — return immediately on hit (saves full retrieval + LLM round-trip)
  const datasetId = getActiveDatasetId() || '__default__';
  const cached = _getCachedResult(query, datasetId);
  if (cached) {
    logger.info(`Cache hit for query: "${query.substring(0, 60)}"`);
    return cached;
  }

  // Follow-up query expansion: detect "tell me more", "what about X", etc.
  // and expand with context from the previous query in this session.
  const followUp = expandFollowUpQuery(query);
  if (followUp.wasFollowUp) {
    logger.info(`Follow-up detected: "${query}" → expanded to "${followUp.expanded.substring(0, 100)}"`);
    query = followUp.expanded;
  }
  // Record this query in session history for future follow-up detection
  recordQuerySession(query);

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
    rerankerThreshold = 0.05,     // Minimum reranker score to keep
    contextWindow = 2,            // Number of neighboring chunks to include on each side
    temperature = 0.1             // LLM temperature for answer generation
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
    options: { useClassification, useHybridSearch, useDecomposition, useReranking },
    ...(followUp.wasFollowUp && { follow_up: { previous: followUp.previousQuery, expanded: followUp.expanded } })
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
    let routedResult = null;
    switch (classification.query_type) {
      case QUERY_TYPES.COMPARISON:
        trace.addStep('Route Decision', 'Routing to comparison handler');
        routedResult = { ...await handleComparisonQuery(query, classification, trace), trace: trace.getTrace() };
        break;

      case QUERY_TYPES.RECOMMENDATION:
        trace.addStep('Route Decision', 'Routing to recommendation handler');
        routedResult = { ...await handleRecommendationQuery(query, classification, trace), trace: trace.getTrace() };
        break;

      case QUERY_TYPES.REASONING:
        trace.addStep('Route Decision', 'Routing to reasoning handler');
        routedResult = { ...await handleReasoningQuery(query, classification, trace), trace: trace.getTrace() };
        break;

      case QUERY_TYPES.AGGREGATION:
        trace.addStep('Route Decision', 'Routing to aggregation handler');
        routedResult = { ...await handleAggregationQuery(query, classification, queryScope, useHybridSearch, trace), trace: trace.getTrace() };
        break;

      case QUERY_TYPES.SIMPLE_LOOKUP:
      default:
        trace.addStep('Route Decision', 'Using simple lookup handler');
        break;
    }
    if (routedResult) {
      _setCachedResult(query, datasetId, routedResult);
      return routedResult;
    }
  }

  // Standard handling for simple lookups
  const result = await handleSimpleLookup(query, queryScope, useHybridSearch, trace, {
    useReranking,
    useCitations,
    includeRelatedQuestions,
    retrievalOptions,
    classification
  });
  const finalResult = { ...result, trace: trace.getTrace() };
  _setCachedResult(query, datasetId, finalResult);
  return finalResult;
}

// Simple ask without classification (for backwards compatibility)
export async function simpleAsk({ query, queryScope = null, options = {} }) {
  const { trace: enableTrace = false } = options;
  const trace = new QueryTrace(enableTrace);
  trace.addStep('Simple Ask', 'Using simple lookup without classification');
  const result = await handleSimpleLookup(query, queryScope, false, trace);
  return { ...result, trace: trace.getTrace() };
}
