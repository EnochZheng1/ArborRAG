import { callLLM } from "../utils/llm.js";
import { safeJson } from "../db/db.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { bm25RecallNodes, bm25RecallChunks, hybridRecallNodes, hierarchicalRecallNodes, getHierarchicalChunks, searchChunksByDocTitle, simpleContentSearch, keywordTagSearch, buildRetrievalQueryVariants } from "./recallNodes.js";
import { generateSnippet, generateSnippetsForChunks, extractKeySentences } from "../utils/snippetGenerator.js";
import { rankNodes, decideNode } from "./nodeScoring.js";
import { classifyQuery, QUERY_TYPES } from "../query/classifier.js";
import { generateComparison, formatComparisonForAPI } from "../query/comparator.js";
import { generateRecommendation, formatRecommendationForAPI, extractCriteriaFromQuery } from "../query/recommender.js";
import { reason, formatReasoningAsText } from "../query/reasoner.js";
import { queryLogger as logger } from "../utils/logger.js";

// New feature imports
import { rerankerChunks, rerankerNodes } from "../query/reranker.js";
import { expandChunksWithContext, buildExpandedContext } from "../query/chunkExpander.js";
import { decomposeQuery, executeDecomposedRetrieval } from "../query/decomposer.js";
import { generateAnswerWithCitations, addCitationsToAnswer } from "../query/citationGenerator.js";
import { calculateConfidence, quickConfidence } from "../query/confidenceScorer.js";
import { generateRelatedQuestions, formatQuestionsForAPI } from "../query/relatedQuestions.js";
import { getSuggestions, recordQuery } from "../query/suggestions.js";
import { recordFeedback, applyFeedbackBoost } from "../query/feedback.js";
import { getFactsForQuestion, retrieveFactsForQuery } from "../extraction/entityFactRetriever.js";
import { enhancedRetrieval, buildEnhancedContext } from "./enhancedRetrieval.js";
import { hierarchicalRetrieve, getTreeContextSummary } from "./hierarchicalRetrieval.js";
import { detectLanguage as detectLang, isChineseLang } from "../utils/langDetect.js";
import { getDatasetLang, getEffectiveLang } from "../utils/datasetLang.js";

// Detect language - wrapper that considers both query and context (for text metadata only)
function detectLanguage(text) {
  return detectLang(text);
}

/**
 * Detect best language for LLM prompt based on query and context.
 * Dataset language takes priority when explicitly set; otherwise favour
 * Chinese context so the LLM understands Chinese docs better.
 */
function detectPromptLanguage(query, context) {
  // If dataset has an explicit language, always use it for prompts.
  const dl = getDatasetLang();
  if (dl !== 'auto') return dl;

  // auto: favour Chinese context so LLM understands Chinese docs better.
  const contextLang = detectLang(context);
  if (isChineseLang(contextLang)) return contextLang;
  return detectLang(query);
}

// System prompts for both languages
const SYSTEM_PROMPTS = {
  zh: `你是企业知识库问答助手。你必须严格基于提供的上下文回答。
规则：
1) 不能使用上下文之外的信息；不知道就说不知道，并说明缺少什么信息。
2) 必须给出适用范围/条件。
3) 若上下文存在冲突，指出冲突并说明依据（权威/时间/范围）。
4) 输出严格 JSON。`,
  en: `You are an enterprise knowledge base Q&A assistant. You must answer strictly based on the provided context.
Rules:
1) Do not use information outside the context; if you don't know, say so and explain what information is missing.
2) You must specify applicable scope/conditions.
3) If there are conflicts in the context, point them out with reasoning (authority/time/scope).
4) Output strict JSON.`
};

// Call LLM for answer generation
export async function callLLMAnswer({ query, nodeId, nodeName, context, lang = "auto" }) {
  // Use context-aware language detection - if context is Chinese, use Chinese prompts
  // This helps LLM understand Chinese documents even when query is in English
  const detectedLang = lang === "auto" ? detectPromptLanguage(query, context) : lang;
  const system = SYSTEM_PROMPTS[detectedLang] ?? (isChineseLang(detectedLang) ? SYSTEM_PROMPTS.zh : SYSTEM_PROMPTS.en);

  const userPrompt = isChineseLang(detectedLang)
    ? `【问题】\n${query}\n\n【限定节点】\n${nodeId} ${nodeName}\n\n【上下文 chunks】\n${context}`
    : `[Question]\n${query}\n\n[Restricted Node]\n${nodeId} ${nodeName}\n\n[Context Chunks]\n${context}`;

  const schema = `{
  "final_answer":"string",
  "conditions":["string"],
  "citations":[{"chunk_id":"string","why":"string"}],
  "conflicts":[{"chunk_ids":["a","b"],"note":"string"}],
  "missing_info":["string"]
}`;

  const fullPrompt = `${system}\n\n${userPrompt}\n\n[Output JSON Schema]\n${schema}`;

  const text = await callLLM({ prompt: fullPrompt, taskName: 'qa_answer' });

  // Try to extract JSON from response
  try {
    // Handle markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : text;
    return JSON.parse(jsonStr);
  } catch {
    return {
      final_answer: text,
      conditions: [],
      citations: [],
      conflicts: [],
      missing_info: [isChineseLang(detectedLang)
        ? "输出不是JSON（建议开启 Gemini 的结构化输出）"
        : "Output is not valid JSON (consider enabling Gemini structured output)"]
    };
  }
}

// Get chunks for a node
function getChunksForNode(nodeId) {
  const rows = ChunkRepo.getForNode(nodeId);

  return rows.map(r => {
    const sourceDocs = safeJson(r.source_documents_json, []);
    return {
      id: r.id,
      doc_title: r.doc_title,
      content: r.content_clean,
      chunk_type: r.chunk_type,
      kp_type: r.kp_type || 'legacy_chunk',
      source_documents_json: r.source_documents_json || '[]',
      source_count: sourceDocs.length || 1,
      keywords: safeJson(r.keywords_json, []),
      fields: safeJson(r.fields_json, {}),
      scope: safeJson(r.scope_json, {}),
      authority_level: r.authority_level,
      uploaded_at: r.uploaded_at
    };
  });
}

// Format chunks as context string
function formatChunksAsContext(chunks) {
  if (!chunks.length) return "(No relevant content found)";

  return chunks.map((c) => {
    const sourceDocs = safeJson(c.source_documents_json || '[]', []);
    const sourceLabel = sourceDocs.length > 1
      ? `Sources: ${sourceDocs.map(s => s.doc_title).join(', ')} [${sourceDocs.length} docs]`
      : `Source: ${c.doc_title}`;

    const meta = [
      sourceLabel,
      c.authority_level && `Authority: ${c.authority_level}`,
      c.kp_type && c.kp_type !== 'legacy_chunk' && `Type: ${c.kp_type}`
    ].filter(Boolean).join(" | ");

    return `[Chunk ${c.id}] ${meta}\n${c.content}`;
  }).join("\n\n---\n\n");
}

// Trace helper class
class QueryTrace {
  constructor(enabled = false) {
    this.enabled = enabled;
    this.steps = [];
    this.startTime = Date.now();
  }

  addStep(name, description, result = null, status = 'success') {
    if (!this.enabled) return;
    this.steps.push({
      name,
      description,
      result,
      status,
      timestamp: Date.now(),
      duration_ms: this.steps.length > 0
        ? Date.now() - this.steps[this.steps.length - 1].timestamp
        : Date.now() - this.startTime
    });
  }

  getTrace() {
    if (!this.enabled) return null;
    return {
      steps: this.steps,
      total_duration_ms: Date.now() - this.startTime
    };
  }
}

// Generate answer directly from chunks (bypassing node-based retrieval)
async function generateAnswerFromChunks(query, chunks, trace, options = {}) {
  const {
    maxChunks = 20,
    useReranking = true,
    useCitations = true,
    includeRelatedQuestions = true,
    rerankerThreshold = 0.3,
    contextWindow = 1,
    temperature = 0.3
  } = options;

  // Apply feedback-based boosting
  chunks = applyFeedbackBoost(chunks);

  // LLM Re-ranking for better relevance (threshold lowered from > 5 to > 1)
  if (useReranking && chunks.length > 1) {
    try {
      trace?.addStep('LLM Re-ranking', `Re-ranking ${chunks.length} chunks`);
      const rerankedChunks = await rerankerChunks(query, chunks, {
        topK: maxChunks,
        minScore: rerankerThreshold
      });
      if (rerankedChunks.length > 0) {
        chunks = rerankedChunks;
        trace?.addStep('Re-ranking Complete', `Kept ${chunks.length} relevant chunks`);
      }
    } catch (err) {
      trace?.addStep('Re-ranking Skipped', `Error: ${err.message}`, null, 'skipped');
    }
  }

  // Limit chunks
  chunks = chunks.slice(0, maxChunks);

  // Expand chunks with context (200 chars per side to avoid crowding out later chunks)
  const expandedChunks = expandChunksWithContext(chunks, {
    windowBefore: contextWindow,
    windowAfter: contextWindow,
    maxContextLength: 400
  });

  // Generate snippets
  const chunksWithSnippets = generateSnippetsForChunks(chunks, query, { maxLength: 150 });
  const topSnippets = chunksWithSnippets
    .filter(c => c.snippetScore > 0)
    .sort((a, b) => b.snippetScore - a.snippetScore)
    .slice(0, 3)
    .map(c => ({
      text: c.snippet,
      html: c.snippetHtml,
      source: c.doc_title || c.node_name,
      chunkId: c.id
    }));

  // Build context
  const context = buildExpandedContext(expandedChunks, { includeNeighbors: true, maxTotalLength: 12000 });
  const sourceNames = [...new Set(chunks.map(c => c.doc_title).filter(Boolean))].slice(0, 3).join(", ") || "Documents";

  // Generate answer
  let llmResponse;
  let citationData = null;

  if (useCitations) {
    trace?.addStep('LLM Generation', 'Generating answer with citations');
    const citationResult = await generateAnswerWithCitations(query, context, chunks, {
      lang: getEffectiveLang(query),
      temperature,
      maxSources: chunks.length
    });
    llmResponse = {
      final_answer: citationResult.answer,
      final_answer_html: citationResult.answer_html,
      conditions: [],
      citations: citationResult.citations,
      conflicts: [],
      missing_info: []
    };
    citationData = {
      citations: citationResult.citations,
      sources: citationResult.sources
    };
    trace?.addStep('LLM Complete', `Generated answer with ${citationResult.citations.length} citations`);
  } else {
    trace?.addStep('LLM Generation', 'Generating answer');
    llmResponse = await callLLMAnswer({
      query,
      nodeId: "direct_chunks",
      nodeName: sourceNames,
      context
    });
    trace?.addStep('LLM Complete', 'Answer generated');
  }

  // Calculate confidence
  const confidenceResult = calculateConfidence({
    chunks,
    nodes: [],
    query,
    answer: llmResponse.final_answer,
    queryType: QUERY_TYPES.SIMPLE_LOOKUP
  });

  // Generate related questions
  let relatedQuestions = [];
  if (includeRelatedQuestions) {
    try {
      relatedQuestions = await generateRelatedQuestions({
        query,
        answer: llmResponse.final_answer,
        nodes: [],
        chunks,
        queryType: QUERY_TYPES.SIMPLE_LOOKUP
      });
      relatedQuestions = formatQuestionsForAPI(relatedQuestions, getEffectiveLang(query));
    } catch (err) {
      // Non-fatal
    }
  }

  return {
    query_type: QUERY_TYPES.SIMPLE_LOOKUP,
    action: "answer",
    chosen: null,
    confidence: confidenceResult.score,
    confidence_details: confidenceResult,
    top: [],
    llm_response: llmResponse,
    chunks_used: chunks.length,
    snippets: topSnippets,
    citations: citationData,
    related_questions: relatedQuestions,
    message: "Answer generated from direct chunk search",
    trace: trace?.getTrace()
  };
}

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
    rerankerThreshold = 0.3,      // Minimum reranker score to keep
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

// Handle comparison queries
async function handleComparisonQuery(query, classification, trace) {
  const entities = classification.entities || [];
  const criteria = classification.criteria || [];

  if (entities.length < 2) {
    trace?.addStep('Comparison Handler', 'Not enough entities, falling back to simple lookup', { entities_found: entities.length });
    return handleSimpleLookup(query, null, true, trace);
  }

  trace?.addStep('Comparison Handler', `Comparing ${entities.length} entities`, { entities, criteria });
  const result = await generateComparison(query, entities, criteria);
  trace?.addStep('Comparison Complete', `Generated comparison with ${result.comparison?.attributes?.length || 0} attributes`);

  return {
    query_type: QUERY_TYPES.COMPARISON,
    ...formatComparisonForAPI(result),
    classification
  };
}

// Handle recommendation queries
async function handleRecommendationQuery(query, classification, trace) {
  const criteria = classification.criteria?.length > 0
    ? classification.criteria
    : extractCriteriaFromQuery(query);

  trace?.addStep('Recommendation Handler', `Using ${criteria.length} criteria`, { criteria });
  const result = await generateRecommendation(query, { criteria });

  // If no recommendations found or only one weak candidate, fall back to simple lookup
  const recCount = result.recommendations?.length || 0;
  if (!result.success || recCount === 0) {
    trace?.addStep('Recommendation Fallback', 'No recommendations found, falling back to simple lookup', null, 'skipped');
    return handleSimpleLookup(query, null, true, trace);
  }

  // If we only have one result, treat it more like a lookup than a recommendation
  if (recCount === 1) {
    trace?.addStep('Single Result', 'Only one candidate found, may be better suited for simple lookup');
  }

  trace?.addStep('Recommendation Complete', `Generated ${recCount} recommendations`);

  return {
    query_type: QUERY_TYPES.RECOMMENDATION,
    ...formatRecommendationForAPI(result),
    classification
  };
}

// Handle reasoning queries
async function handleReasoningQuery(query, classification, trace) {
  trace?.addStep('Reasoning Handler', 'Starting multi-hop reasoning');

  // Use enhanced retrieval with multi-hop for reasoning queries
  let additionalContext = '';
  let enhancedFacts = [];
  let enhancedEntities = [];

  try {
    const enhancedResults = await enhancedRetrieval(query, {
      useEntities: true,
      useFacts: true,
      useHierarchy: true,
      useMultiHop: true,  // Enable multi-hop for reasoning
      queryType: 'reasoning',
      limit: 25
    });

    if (enhancedResults.chunks.length > 0 || enhancedResults.facts.length > 0) {
      additionalContext = buildEnhancedContext(enhancedResults, {
        maxLength: 4000,
        includeFacts: true,
        includeEntityInfo: true
      });
      enhancedFacts = enhancedResults.facts;
      enhancedEntities = enhancedResults.entities;

      trace?.addStep('Enhanced Retrieval', `Found ${enhancedResults.chunks.length} chunks, ${enhancedResults.facts.length} facts via multi-hop`, {
        sources: enhancedResults.sources,
        entities: enhancedResults.entities.slice(0, 5).map(e => e.name)
      });
    }
  } catch (err) {
    trace?.addStep('Enhanced Retrieval', `Skipped: ${err.message}`, null, 'skipped');
    logger.debug(`Enhanced retrieval for reasoning failed: ${err.message}`);
  }

  // Pass additional context to reasoner
  const result = await reason(query, { additionalContext });
  trace?.addStep('Reasoning Complete', `Completed with ${result.reasoning_steps?.length || 0} reasoning steps`, {
    key_facts: result.key_facts?.slice(0, 3),
    confidence: result.confidence
  });

  return {
    query_type: QUERY_TYPES.REASONING,
    success: result.success,
    data: {
      answer: result.answer || result.final_answer,
      reasoning_steps: result.reasoning_steps,
      confidence: result.confidence,
      key_facts: [...(result.key_facts || []), ...enhancedFacts.map(f => f.content)].slice(0, 10),
      limitations: result.limitations,
      entities_involved: enhancedEntities.slice(0, 5).map(e => ({ name: e.name, type: e.entity_type }))
    },
    sources: result.sources,
    classification,
    error: result.error
  };
}

// Handle aggregation queries
async function handleAggregationQuery(query, classification, queryScope, useHybridSearch, trace) {
  // For aggregation, we want multiple results with hierarchy expansion
  let candidates;
  if (useHybridSearch) {
    trace?.addStep('Node Recall', 'Using hierarchical hybrid search for aggregation');
    candidates = await hierarchicalRecallNodes(query, 30, {
      useHierarchy: true,
      useAliases: true
    });
    candidates = candidates.map(r => ({ node: r.node, bm25: r.score, sources: r.sources }));
  } else {
    trace?.addStep('Node Recall', 'Using BM25 search');
    candidates = bm25RecallNodes(query, 30);
  }

  // Use top 20 nodes (up from 8): multi-document KBs can have 15+ nodes across two
  // documents. Cutting at 8 silently drops entire documents from cross-doc aggregation
  // results when one company's nodes outrank the other's on BM25 relevance.
  const AGGREGATION_TOP_N = 20;
  trace?.addStep('Node Recall Complete', `Found ${candidates.length} candidate nodes`, {
    top_nodes: candidates.slice(0, AGGREGATION_TOP_N).map(c => ({ name: c.node.name, score: c.bm25?.toFixed(3), sources: c.sources }))
  });

  // Get chunks from all relevant nodes
  const allChunks = [];
  for (const c of candidates.slice(0, AGGREGATION_TOP_N)) {
    const chunks = getChunksForNode(c.node.node_id);
    allChunks.push(...chunks.map(chunk => ({
      ...chunk,
      node_id: c.node.node_id,
      node_name: c.node.name
    })));
  }

  // Also search for document-specific chunks (handles "What's in document X?" queries)
  try {
    const docChunks = searchChunksByDocTitle(query, 30);
    if (docChunks.length > 0) {
      trace?.addStep('Document Title Search', `Found ${docChunks.length} chunks by document title`);
      const existingIds = new Set(allChunks.map(c => c.id));
      for (const r of docChunks) {
        if (!existingIds.has(r.chunk.id)) {
          allChunks.push({
            ...r.chunk,
            node_name: r.chunk.doc_title || 'Document'
          });
          existingIds.add(r.chunk.id);
        }
      }
    }
  } catch (err) {
    logger.warn("Document title search in aggregation failed:", err.message);
  }

  // Enhanced retrieval for aggregation: includes child nodes and entity-based content
  try {
    const enhancedResults = await enhancedRetrieval(query, {
      useEntities: true,
      useFacts: true,
      useHierarchy: true,
      useMultiHop: false,
      queryType: 'aggregation',
      limit: 20
    });

    if (enhancedResults.chunks.length > 0) {
      const existingIds = new Set(allChunks.map(c => c.id));
      const newChunks = enhancedResults.chunks.filter(c => !existingIds.has(c.id));

      if (newChunks.length > 0) {
        allChunks.push(...newChunks);
        trace?.addStep('Enhanced Retrieval', `Added ${newChunks.length} chunks from entities/facts/hierarchy`, {
          sources: enhancedResults.sources,
          entities: enhancedResults.entities.length
        });
      }
    }
  } catch (err) {
    logger.debug(`Enhanced retrieval for aggregation failed: ${err.message}`);
  }

  // If still no chunks, try simple content search as last resort
  if (allChunks.length === 0) {
    try {
      const simpleChunks = simpleContentSearch(query, 30);
      for (const r of simpleChunks) {
        allChunks.push({
          id: r.chunk.id,
          content: r.chunk.content,
          doc_title: r.chunk.doc_title,
          node_id: r.chunk.node_id,
          node_name: r.chunk.doc_title || 'Document',
          authority_level: r.chunk.authority_level,
          source: 'simple_content'
        });
      }
      if (simpleChunks.length > 0) {
        trace?.addStep('Simple Content Search', `Found ${simpleChunks.length} chunks via content matching`);
      }
    } catch (err) {
      logger.debug(`Simple content search failed: ${err.message}`);
    }
  }

  if (!allChunks.length && !candidates.length) {
    trace?.addStep('Aggregation Failed', 'No matching content found', null, 'error');
    return {
      query_type: QUERY_TYPES.AGGREGATION,
      success: false,
      error: "No matching content found"
    };
  }

  trace?.addStep('Chunk Retrieval', `Retrieved ${allChunks.length} chunks from ${Math.min(5, candidates.length)} nodes`);

  // Generate snippets for aggregation
  const chunksWithSnippets = generateSnippetsForChunks(allChunks, query, { maxLength: 150 });
  const topSnippets = chunksWithSnippets
    .filter(c => c.snippetScore > 0)
    .sort((a, b) => b.snippetScore - a.snippetScore)
    .slice(0, 5)
    .map(c => ({
      text: c.snippet,
      html: c.snippetHtml,
      source: c.doc_title || c.node_name,
      nodeName: c.node_name,
      chunkId: c.id
    }));

  const context = formatChunksAsContext(allChunks.slice(0, 40));

  // Determine source names for context
  const sourceNames = candidates.length > 0
    ? candidates.slice(0, AGGREGATION_TOP_N).map(c => c.node.name).join(", ")
    : [...new Set(allChunks.map(c => c.doc_title || c.node_name).filter(Boolean))].slice(0, AGGREGATION_TOP_N).join(", ") || "Documents";

  trace?.addStep('LLM Generation', 'Generating aggregated answer');
  const llmResponse = await callLLMAnswer({
    query,
    nodeId: "multiple",
    nodeName: sourceNames,
    context
  });
  trace?.addStep('LLM Complete', 'Answer generated successfully');

  return {
    query_type: QUERY_TYPES.AGGREGATION,
    success: true,
    data: llmResponse,
    nodes_used: candidates.slice(0, AGGREGATION_TOP_N).map(c => ({
      node_id: c.node.node_id,
      name: c.node.name
    })),
    chunks_used: allChunks.length,
    snippets: topSnippets,
    classification
  };
}

// Standard simple lookup handling
async function handleSimpleLookup(query, queryScope, useHybridSearch, trace, enhancedOptions = {}) {
  const {
    useReranking = true,
    useCitations = true,
    includeRelatedQuestions = true,
    retrievalOptions = {}
  } = enhancedOptions;

  // Extract retrieval parameters with defaults
  const {
    topK = 30,
    maxChunks = 20,
    minConfidence = 0.0,
    hybridAlpha = 0.5,
    rerankerThreshold = 0.3,
    contextWindow = 2,
    temperature = 0.3
  } = retrievalOptions;

  let retrievalQueryVariants = [{ text: query, weight: 1, lang: detectLanguage(query), sources: ["original"] }];
  try {
    const variants = await buildRetrievalQueryVariants(query, {
      maxVariants: 6,
      useExpansion: true,
      useAliasPivot: true
    });
    if (variants.length > 0) {
      retrievalQueryVariants = variants;
    }
  } catch (err) {
    logger.warn("Failed to build retrieval query variants:", err.message);
  }

  trace?.addStep("Retrieval Query Variants", `Using ${retrievalQueryVariants.length} query variants`, {
    variants: retrievalQueryVariants.map(v => ({
      text: v.text,
      weight: Number((v.weight || 1).toFixed(2)),
      lang: v.lang,
      sources: v.sources
    }))
  });

  // STEP 0: Direct chunk retrieval (do this FIRST, before node-based search)
  // This ensures we find document content even if node matching fails
  let directChunks = [];
  try {
    trace?.addStep('Direct Chunk Search', 'Searching chunks directly by content');

    const directChunkMap = new Map();
    const variantQueries = retrievalQueryVariants.slice(0, 5);
    const sourceStats = { doc_title: 0, bm25: 0, simple: 0, keywords: 0 };

    const upsertDirectChunk = (chunk, source, score, variant) => {
      if (!chunk?.id) return;

      const weightedScore = Math.max(0, (score || 0) * (variant.weight || 1));
      const existing = directChunkMap.get(chunk.id);
      if (existing) {
        existing.relevance_score = Math.max(existing.relevance_score || 0, weightedScore);
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (!existing.query_variants.includes(variant.text)) existing.query_variants.push(variant.text);
        return;
      }

      directChunkMap.set(chunk.id, {
        id: chunk.id,
        content: chunk.content,
        content_clean: chunk.content,
        doc_title: chunk.doc_title,
        node_id: chunk.node_id,
        node_name: chunk.doc_title || 'Document',
        authority_level: chunk.authority_level,
        source,
        sources: [source],
        query_variants: [variant.text],
        relevance_score: weightedScore
      });
    };

    for (const variant of variantQueries) {
      const perVariantLimit = Math.max(8, Math.ceil(maxChunks / Math.min(variantQueries.length, 3)));

      // Search by document title
      const docTitleChunks = searchChunksByDocTitle(variant.text, perVariantLimit);
      sourceStats.doc_title += docTitleChunks.length;
      for (const r of docTitleChunks) {
        upsertDirectChunk(r.chunk, 'doc_title', Math.max(0, Math.min(1, r.score || 0)), variant);
      }

      // BM25 FTS search on chunk content
      const bm25Chunks = bm25RecallChunks(variant.text, perVariantLimit);
      sourceStats.bm25 += bm25Chunks.length;
      // Absolute normalisation — avoids inflating the "best of a bad batch" to 1.0
      // when all BM25 scores are weak (same fix as nodeScoring.js MAX_EXPECTED_BM25).
      const MAX_EXPECTED_BM25 = 15.0;
      for (const r of bm25Chunks) {
        const normalizedBm25 = Math.min(1.0, (r.bm25 || 0) / MAX_EXPECTED_BM25);
        upsertDirectChunk(r.chunk, 'bm25_content', normalizedBm25, variant);
      }

      // Simple LIKE-based content search (most reliable fallback)
      const simpleChunks = simpleContentSearch(variant.text, perVariantLimit);
      sourceStats.simple += simpleChunks.length;
      for (const r of simpleChunks) {
        upsertDirectChunk(r.chunk, 'simple_content', r.score || 0, variant);
      }

      // Keyword tag search — finds chunks whose LLM-extracted semantic tags match
      // query terms. Bypasses BM25 IDF weighting, so short numeric values and
      // domain-specific labels surface even when they score low in FTS5.
      const kwChunks = keywordTagSearch(variant.text, perVariantLimit);
      sourceStats.keywords += kwChunks.length;
      for (const r of kwChunks) {
        upsertDirectChunk(r.chunk, 'keyword_tags', r.score || 0, variant);
      }
    }

    directChunks = [...directChunkMap.values()];
    directChunks.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

    trace?.addStep('Direct Chunk Search Complete', `Found ${directChunks.length} chunks directly`, {
      variants_used: variantQueries.length,
      doc_title: sourceStats.doc_title,
      bm25: sourceStats.bm25,
      simple: sourceStats.simple,
      keywords: sourceStats.keywords
    });
  } catch (err) {
    logger.warn("Direct chunk search failed:", err.message);
    trace?.addStep('Direct Chunk Search', `Failed: ${err.message}`, null, 'error');
  }

  // STEP 1: Hierarchical tree retrieval (smart tree navigation)
  // This leverages the tree structure with beam search, ancestor context, and sibling expansion
  let hierarchicalChunks = [];
  let hierarchicalNodes = [];
  let treePaths = [];
  try {
    trace?.addStep('Hierarchical Tree Retrieval', 'Navigating tree structure with beam search');

    const hierarchyStepHandler = trace
      ? (step) => trace.addStep(step.name, step.description, step.result, step.status)
      : null;

    const hierarchicalResult = await hierarchicalRetrieve(query, {
      maxChunks: maxChunks,
      beamWidth: 3,
      maxDepth: 5,
      includeAncestors: true,
      includeSiblings: true,
      includeDescendants: true,
      queryVariants: retrievalQueryVariants,
      ancestorLevels: 2,
      siblingNodesPerSeed: 3,
      descendantDepth: 2,
      descendantNodesPerSeed: 5,
      onStep: hierarchyStepHandler
    });

    hierarchicalChunks = hierarchicalResult.chunks || [];
    hierarchicalNodes = hierarchicalResult.nodes || [];
    treePaths = hierarchicalResult.paths || [];

    // Get tree context summary
    const treeContext = getTreeContextSummary(hierarchicalChunks);

    trace?.addStep('Hierarchical Retrieval Complete', `Found ${hierarchicalChunks.length} chunks via tree navigation`, {
      nodes_explored: hierarchicalNodes.length,
      paths: treePaths.slice(0, 3),
      tree_breadth: treeContext.breadth,
      tree_depth: treeContext.depth,
      common_ancestor: treeContext.commonAncestor,
      sources: hierarchicalResult.sources
    });
  } catch (err) {
    logger.warn("Hierarchical retrieval failed:", err.message);
    trace?.addStep('Hierarchical Retrieval', `Failed: ${err.message}`, null, 'error');
  }

  // STEP 2: Supplement strategy — node-scope first, supplement with direct when thin.
  //
  // Hierarchical chunks are the primary source (node-scoped, avoids most cross-doc bleed).
  // When hierarchical returns fewer than SUPPLEMENT_THRESHOLD chunks the tree only found a
  // partial match (e.g., navigated to Company Overview instead of Health Insurance). In that
  // case we supplement with the top direct BM25 chunks so specific numeric facts that live in
  // a different node than the one the tree navigated to are still covered.
  //
  // This avoids both failure modes:
  //   • Pure MERGE: always adds global direct chunks → cross-doc contamination
  //   • Pure STRICT FALLBACK: discards direct when ANY hierarchical found → misses specific facts
  const SUPPLEMENT_THRESHOLD = 8;
  let usedFallback = false;
  const allChunks = [];
  const seenChunkIds = new Set();

  if (hierarchicalChunks.length > 0) {
    // Primary: tree found at least one node — use hierarchical chunks first.
    for (const chunk of hierarchicalChunks) {
      if (!seenChunkIds.has(chunk.id)) {
        seenChunkIds.add(chunk.id);
        allChunks.push({ ...chunk, retrieval_source: 'hierarchical' });
      }
    }

    if (hierarchicalChunks.length < SUPPLEMENT_THRESHOLD && directChunks.length > 0) {
      // Supplement: hierarchical coverage is thin — add direct BM25 chunks to fill gaps.
      // De-duplicate so no chunk appears twice.
      for (const chunk of directChunks) {
        if (!seenChunkIds.has(chunk.id)) {
          seenChunkIds.add(chunk.id);
          allChunks.push({ ...chunk, retrieval_source: 'supplement' });
        }
      }
      trace?.addStep('Chunk Selection', `Used ${hierarchicalChunks.length} hierarchical + ${allChunks.length - hierarchicalChunks.length} supplemental chunks`, {
        from_hierarchical: hierarchicalChunks.length,
        from_supplement: allChunks.length - hierarchicalChunks.length
      });
    } else {
      trace?.addStep('Chunk Selection', `Using ${allChunks.length} node-scoped chunks (hierarchical only)`, {
        from_hierarchical: hierarchicalChunks.length,
        direct_discarded: directChunks.length
      });
    }
  } else {
    // Fallback: tree localization failed entirely — use global direct chunks.
    usedFallback = true;
    for (const chunk of directChunks) {
      if (!seenChunkIds.has(chunk.id)) {
        seenChunkIds.add(chunk.id);
        allChunks.push({ ...chunk, retrieval_source: 'direct' });
      }
    }
    trace?.addStep('Chunk Selection', `Tree localization failed — falling back to ${allChunks.length} global chunks`, {
      from_direct: directChunks.length
    }, 'warn');
  }

  // If no chunks found at all
  if (allChunks.length === 0) {
    trace?.addStep('No Results', 'No matching content found', null, 'error');
    return {
      query_type: QUERY_TYPES.SIMPLE_LOOKUP,
      action: "no_results",
      chosen: null,
      confidence: 0,
      top: [],
      llm_response: null,
      message: "No matching content found in the knowledge base"
    };
  }

  // STEP 3: Score and rank combined chunks
  // Sort by hierarchical_score (if available) or relevance_score
  allChunks.sort((a, b) => {
    const scoreA = a.hierarchical_score || a.relevance_score || 0;
    const scoreB = b.hierarchical_score || b.relevance_score || 0;
    return scoreB - scoreA;
  });

  // Take top chunks
  let chunks = allChunks.slice(0, maxChunks);

  // Determine the best node (if any) from hierarchical search
  let chosenNode = null;
  if (hierarchicalNodes.length > 0) {
    const topNode = hierarchicalNodes[0];
    chosenNode = {
      node: topNode,
      score: topNode.relevance_score
    };
  }

  trace?.addStep('Final Chunk Selection', `Selected ${chunks.length} top chunks for context`, {
    top_chunks: chunks.slice(0, 3).map(c => ({
      id: c.id,
      source: c.source || c.retrieval_source,
      score: (c.hierarchical_score || c.relevance_score || 0).toFixed(3),
      doc: c.doc_title?.substring(0, 30)
    }))
  });

  // STEP 4: Apply feedback-based boosting
  chunks = applyFeedbackBoost(chunks);

  // STEP 5: LLM Re-ranking for better relevance.
  // Threshold lowered from > 5 to > 1: with the merged pool, the reranker must always run
  // to filter wrong-node hierarchical chunks from the correct direct-BM25 chunks.
    if (useReranking && chunks.length > 1) {
      try {
        trace?.addStep('LLM Re-ranking', `Re-ranking chunks (threshold=${rerankerThreshold})`);
        const rerankedChunks = await rerankerChunks(query, chunks, {
          topK: maxChunks,
          minScore: rerankerThreshold
        });
        if (rerankedChunks.length > 0) {
          chunks = rerankedChunks;
          trace?.addStep('Re-ranking Complete', `Re-ranked to ${chunks.length} most relevant chunks`, {
            top_reranked: chunks.slice(0, 3).map(c => ({ id: c.id, score: c.rerank_score }))
          });
        }
      } catch (err) {
        trace?.addStep('Re-ranking Skipped', `Error: ${err.message}`, null, 'error');
      }
    }

    // Expand chunks with context (neighboring chunks).
    // maxContextLength capped at 400 (200 chars per side) to prevent neighbor text from
    // crowding out later chunks in the LLM prompt. With the old default of 2000, each
    // expanded chunk consumed ~2200 chars, fitting only ~3 of 20 chunks in a 7000-char
    // budget — silently dropping the specific facts needed to answer the query.
    const expandedChunks = expandChunksWithContext(chunks, {
      windowBefore: contextWindow,
      windowAfter: contextWindow,
      maxContextLength: 400
    });
    const chunksWithContext = expandedChunks.filter(c => c.has_context).length;
    if (chunksWithContext > 0) {
      trace?.addStep('Context Expansion', `Expanded ${chunksWithContext} chunks with neighboring context`);
    }

    // Generate snippets for chunks
    const chunksWithSnippets = generateSnippetsForChunks(chunks, query, { maxLength: 150 });
    const topSnippets = chunksWithSnippets
      .filter(c => c.snippetScore > 0)
      .sort((a, b) => b.snippetScore - a.snippetScore)
      .slice(0, 3)
      .map(c => ({
        text: c.snippet,
        html: c.snippetHtml,
        source: c.doc_title || c.node_name,
        chunkId: c.id
      }));

    trace?.addStep('Snippet Generation', `Generated ${topSnippets.length} relevant snippets`);

    // Retrieve relevant facts for the query
    let factsContext = '';
    let retrievedFacts = [];
    try {
      const factResult = getFactsForQuestion(query, { maxFacts: 10, maxEvidence: 5 });
      if (factResult.facts.length > 0) {
        retrievedFacts = factResult.facts;
        factsContext = `\n\n[Extracted Facts]\n${factResult.context.facts}`;
        trace?.addStep('Fact Retrieval', `Retrieved ${factResult.facts.length} relevant facts, ${factResult.entities.length} entities`);
      }
    } catch (err) {
      // Non-fatal, continue without facts
      trace?.addStep('Fact Retrieval', `Skipped: ${err.message}`, null, 'skipped');
    }

    // Build context with expanded chunks + facts.
    // maxTotalLength: with maxContextLength=400 each expanded chunk is ~600 chars,
    // 7000 chars accommodates ~11 focused chunks. Keeping the budget moderate prevents
    // the "lost in the middle" effect — LLMs are less reliable at extracting specific
    // numbers (like "85%", "4 hours", "90 days") when surrounded by 20+ other chunks.
    const chunkContext = buildExpandedContext(expandedChunks, { includeNeighbors: true, maxTotalLength: 7000 });
    const context = chunkContext + factsContext;

    // Determine node context for LLM (use chosen node or derive from chunks)
    const nodeId = chosenNode?.node?.node_id || chunks[0]?.node_id || 'direct_search';
    const nodeName = chosenNode?.node?.name ||
      [...new Set(chunks.map(c => c.doc_title || c.node_name).filter(Boolean))].slice(0, 3).join(', ') ||
      'Documents';

    // Generate answer with inline citations if enabled
    let llmResponse;
    let citationData = null;

    if (useCitations) {
      trace?.addStep('LLM Generation', `Generating answer with inline citations (temperature=${temperature})`);
      const citationResult = await generateAnswerWithCitations(query, context, chunks, {
        lang: getEffectiveLang(query),
        temperature,
        maxSources: chunks.length
      });
      llmResponse = {
        final_answer: citationResult.answer,
        final_answer_html: citationResult.answer_html,
        conditions: [],
        citations: citationResult.citations,
        conflicts: [],
        missing_info: []
      };
      citationData = {
        citations: citationResult.citations,
        sources: citationResult.sources
      };
      trace?.addStep('LLM Complete', `Answer generated with ${citationResult.citations.length} citations`);
    } else {
      trace?.addStep('LLM Generation', 'Generating answer with context');
      llmResponse = await callLLMAnswer({
        query,
        nodeId,
        nodeName,
        context
      });
      trace?.addStep('LLM Complete', 'Answer generated successfully', {
        has_conditions: llmResponse.conditions?.length > 0,
        has_conflicts: llmResponse.conflicts?.length > 0,
        has_missing_info: llmResponse.missing_info?.length > 0
      });
    }

    // Calculate calibrated confidence
    const nodesUsed = chosenNode?.node ? [chosenNode.node] : hierarchicalNodes.slice(0, 3);
    const confidenceResult = calculateConfidence({
      chunks,
      nodes: nodesUsed,
      query,
      answer: llmResponse.final_answer,
      queryType: QUERY_TYPES.SIMPLE_LOOKUP
    });
    trace?.addStep('Confidence Calibration', `Score: ${confidenceResult.score} (${confidenceResult.level})`, {
      factors: confidenceResult.factors
    });

    // Generate related questions
    let relatedQuestions = [];
    if (includeRelatedQuestions) {
      try {
        relatedQuestions = await generateRelatedQuestions({
          query,
          answer: llmResponse.final_answer,
          nodes: nodesUsed,
          chunks,
          queryType: QUERY_TYPES.SIMPLE_LOOKUP
        });
        relatedQuestions = formatQuestionsForAPI(relatedQuestions, getEffectiveLang(query));
        trace?.addStep('Related Questions', `Generated ${relatedQuestions.length} follow-up questions`);
      } catch (err) {
        trace?.addStep('Related Questions', `Error: ${err.message}`, null, 'error');
      }
    }

    // Update query history with results
    recordQuery(query, { queryType: QUERY_TYPES.SIMPLE_LOOKUP, resultCount: chunks.length });

    // Build top nodes list from hierarchical results
    const topNodes = hierarchicalNodes.slice(0, 5).map(n => ({
      node: n,
      score: n.relevance_score,
      sources: n.sources || []
    }));

    return {
      query_type: QUERY_TYPES.SIMPLE_LOOKUP,
      action: chunks.length > 0 ? "answer" : "no_results",
      chosen: chosenNode,
      confidence: confidenceResult.score,
      confidence_details: confidenceResult,
      top: topNodes,
      llm_response: llmResponse,
      chunks_used: chunks.length,
      snippets: topSnippets,
      citations: citationData,
      related_questions: relatedQuestions,
      facts: retrievedFacts.slice(0, 5).map(f => ({
        content: f.content,
        type: f.fact_type,
        confidence: f.confidence,
        entities: f.entities || []
      })),
      tree_paths: treePaths.slice(0, 3),
      retrieval_sources: {
        hierarchical: hierarchicalChunks.length,
        direct: directChunks.length
      },
      retrieval_options: { topK, maxChunks, minConfidence, hybridAlpha, rerankerThreshold, contextWindow, temperature },
      ...(usedFallback && { message: "Could not locate an exact node in the current knowledge structure. A global fuzzy search has been performed." })
    };
}

// Simple ask without classification (for backwards compatibility)
export async function simpleAsk({ query, queryScope = null, options = {} }) {
  const { trace: enableTrace = false } = options;
  const trace = new QueryTrace(enableTrace);
  trace.addStep('Simple Ask', 'Using simple lookup without classification');
  const result = await handleSimpleLookup(query, queryScope, false, trace);
  return { ...result, trace: trace.getTrace() };
}
