import { callLLM } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
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

import { QueryTrace } from "./queryTrace.js";

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

  const parsed = await parseLLMJson(text, 'object', { context: 'qa_answer', fallback: null });
  if (parsed) return parsed;
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

// Generate answer directly from chunks (bypassing node-based retrieval)
export async function generateAnswerFromChunks(query, chunks, trace, options = {}) {
  const {
    maxChunks = 20,
    useReranking = true,
    useCitations = true,
    includeRelatedQuestions = true,
    rerankerThreshold = 0.2,
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

// Handle comparison queries
export async function handleComparisonQuery(query, classification, trace) {
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
export async function handleRecommendationQuery(query, classification, trace) {
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
export async function handleReasoningQuery(query, classification, trace) {
  trace?.addStep('Reasoning Handler', 'Starting multi-hop reasoning');

  // Use enhanced retrieval with multi-hop for reasoning queries
  let additionalContext = '';
  let enhancedFacts = [];
  let enhancedEntities = [];

  // Step 0: Hierarchical tree retrieval — navigates tree with LLM routing
  // to find relevant branches that keyword-only methods miss.
  try {
    const hierarchicalResult = await hierarchicalRetrieve(query, {
      maxChunks: 15,
      beamWidth: 3,
      maxDepth: 5,
      includeAncestors: true,
      includeSiblings: true,
      includeDescendants: true,
    });

    if (hierarchicalResult.chunks.length > 0) {
      const treeContext = getTreeContextSummary(hierarchicalResult.chunks);
      const treeChunkText = hierarchicalResult.chunks
        .slice(0, 12)
        .map(c => `[${c.node_name || 'unknown'}] ${(c.content || c.content_clean || '').slice(0, 500)}`)
        .join('\n\n');
      additionalContext = `## Tree-Retrieved Context\nPaths: ${(treeContext.paths || []).slice(0, 3).join(' | ')}\n\n${treeChunkText}`;

      trace?.addStep('Hierarchical Tree Retrieval', `Found ${hierarchicalResult.chunks.length} chunks via tree navigation`, {
        node_count: hierarchicalResult.nodes?.length || 0,
        paths: treeContext.paths?.slice(0, 3)
      });
    }
  } catch (err) {
    trace?.addStep('Hierarchical Tree Retrieval', `Skipped: ${err.message}`, null, 'skipped');
    logger.debug(`Hierarchical retrieval for reasoning failed: ${err.message}`);
  }

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
      const enhancedText = buildEnhancedContext(enhancedResults, {
        maxLength: 4000,
        includeFacts: true,
        includeEntityInfo: true
      });
      additionalContext = additionalContext
        ? `${additionalContext}\n\n${enhancedText}`
        : enhancedText;
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
export async function handleAggregationQuery(query, classification, queryScope, useHybridSearch, trace) {
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

  // Hierarchical tree retrieval for aggregation: navigates tree with LLM routing
  try {
    const hierarchicalResult = await hierarchicalRetrieve(query, {
      maxChunks: 20,
      beamWidth: 3,
      maxDepth: 5,
      includeAncestors: true,
      includeSiblings: true,
      includeDescendants: true,
    });

    if (hierarchicalResult.chunks.length > 0) {
      const existingIds = new Set(allChunks.map(c => c.id));
      let added = 0;
      for (const c of hierarchicalResult.chunks) {
        if (!existingIds.has(c.id)) {
          existingIds.add(c.id);
          allChunks.push(c);
          added++;
        }
      }
      if (added > 0) {
        trace?.addStep('Hierarchical Tree Retrieval', `Added ${added} chunks via tree navigation`, {
          node_count: hierarchicalResult.nodes?.length || 0
        });
      }
    }
  } catch (err) {
    logger.debug(`Hierarchical retrieval for aggregation failed: ${err.message}`);
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
export async function handleSimpleLookup(query, queryScope, useHybridSearch, trace, enhancedOptions = {}) {
  const {
    useReranking = true,
    useCitations = true,
    includeRelatedQuestions = true,
    retrievalOptions = {}
  } = enhancedOptions;

  // Extract retrieval parameters with defaults.
  // maxChunks reduced from 20 → 12: with 20 sources the answer-generation LLM gets
  // overwhelmed by noise and says "not in sources" despite the answer being present.
  // 12 balances enough context for multi-fact queries against LLM attention limits.
  // Aggregation queries use a separate path with higher limits.
  const {
    topK = 30,
    maxChunks = 12,
    minConfidence = 0.0,
    hybridAlpha = 0.5,
    rerankerThreshold = 0.2,
    contextWindow = 2,
    temperature = 0.1
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

    // Numeric-fact boost — queries seeking specific numbers ("how many days",
    // "what percentage") need chunks containing those numbers to rank higher.
    // BM25 IDF down-weights short numbers; this post-hoc pass compensates.
    const queryNumbers = query.match(/\b\d+(?:\.\d+)?\b/g) || [];
    const isNumericQuery = /\bhow many\b|\bhow long\b|\bhow often\b|what percentage|how much|多少|几天|几个|多长/i.test(query);

    if (queryNumbers.length > 0 || isNumericQuery) {
      for (const [, chunk] of directChunkMap) {
        const content = (chunk.content || chunk.content_clean || '').toLowerCase();
        let boost = 0;
        for (const num of queryNumbers) {
          if (new RegExp(`\\b${num}\\b`).test(content)) {
            boost = Math.max(boost, 0.15);
          }
        }
        if (isNumericQuery && boost === 0 && /\d/.test(content)) {
          boost = 0.08;
        }
        if (boost > 0) chunk.relevance_score = (chunk.relevance_score || 0) + boost;
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
      // IMPORTANT: prefer same-document chunks to avoid cross-doc contamination.
      // E.g. if tree navigated to CompanyA's node, adding CompanyB's "CEO" chunk
      // from direct search causes the LLM to conflate the two companies.
      const hierarchicalDocs = new Set(
        hierarchicalChunks.map(c => c.doc_title).filter(Boolean)
      );

      // Partition direct chunks: same-doc first, cross-doc second
      const sameDocChunks = [];
      const crossDocChunks = [];
      for (const chunk of directChunks) {
        if (seenChunkIds.has(chunk.id)) continue;
        if (!chunk.doc_title || hierarchicalDocs.has(chunk.doc_title)) {
          sameDocChunks.push(chunk);
        } else {
          crossDocChunks.push(chunk);
        }
      }

      // Add same-doc supplements first
      for (const chunk of sameDocChunks) {
        seenChunkIds.add(chunk.id);
        allChunks.push({ ...chunk, retrieval_source: 'supplement_same_doc' });
      }
      // Only add cross-doc if still very thin (< 4 chunks total)
      if (allChunks.length < 4) {
        for (const chunk of crossDocChunks) {
          seenChunkIds.add(chunk.id);
          allChunks.push({ ...chunk, retrieval_source: 'supplement_cross_doc' });
        }
      }

      const supplementCount = allChunks.length - hierarchicalChunks.length;
      trace?.addStep('Chunk Selection', `Used ${hierarchicalChunks.length} hierarchical + ${supplementCount} supplemental chunks (${sameDocChunks.length} same-doc, ${Math.max(0, supplementCount - sameDocChunks.length)} cross-doc)`, {
        from_hierarchical: hierarchicalChunks.length,
        from_supplement: supplementCount,
        same_doc: sameDocChunks.length,
        cross_doc_added: Math.max(0, supplementCount - sameDocChunks.length)
      });
    } else if (directChunks.length > 0) {
      // Hierarchical has enough chunks — but BM25 may have found relevant chunks
      // from nodes the tree didn't navigate to (same doc) or from other documents.
      const hierarchicalDocs = new Set(
        hierarchicalChunks.map(c => c.doc_title).filter(Boolean)
      );
      const queryLower = query.toLowerCase();
      let supplementedCount = 0;

      // Collect node IDs already covered by hierarchical search
      const hierarchicalNodeIds = new Set(
        hierarchicalChunks.map(c => c.node_id).filter(Boolean)
      );

      // Sort direct chunks by relevance so the best BM25 hits get priority
      const sortedDirect = [...directChunks].sort(
        (a, b) => (b.relevance_score || 0) - (a.relevance_score || 0)
      );

      // Only add the very best same-doc BM25 hits (from unvisited nodes).
      // Cap at 2 to avoid diluting the tree's focused results.
      const MAX_SAME_DOC = 2;
      const MAX_CROSS_DOC = 4;
      let sameDocAdded = 0;
      let crossDocAdded = 0;

      for (const chunk of sortedDirect) {
        if (seenChunkIds.has(chunk.id)) continue;

        const isCrossDoc = chunk.doc_title && !hierarchicalDocs.has(chunk.doc_title);

        if (isCrossDoc) {
          if (crossDocAdded >= MAX_CROSS_DOC) continue;
          // Cross-doc: only include if doc_title contains a distinctive query term
          const titleTerms = (chunk.doc_title || '').replace(/[-_.]/g, ' ')
            .toLowerCase().split(/\s+/)
            .filter((t, i, a) => t.length >= 5 && a.indexOf(t) === i);
          if (!titleTerms.some(term => queryLower.includes(term))) continue;
          crossDocAdded++;
        } else {
          if (sameDocAdded >= MAX_SAME_DOC) continue;
          // Same-doc: only include chunks from nodes the tree DIDN'T visit.
          if (chunk.node_id && hierarchicalNodeIds.has(chunk.node_id)) continue;
          sameDocAdded++;
        }

        seenChunkIds.add(chunk.id);
        allChunks.push({ ...chunk, retrieval_source: isCrossDoc ? 'query_matched_doc' : 'supplement_same_doc' });
        supplementedCount++;
      }

      if (supplementedCount > 0) {
        trace?.addStep('Chunk Selection', `Using ${hierarchicalChunks.length} hierarchical + ${supplementedCount} direct BM25 chunks`, {
          from_hierarchical: hierarchicalChunks.length,
          supplemented: supplementedCount
        });
      } else {
        trace?.addStep('Chunk Selection', `Using ${allChunks.length} node-scoped chunks (hierarchical only)`, {
          from_hierarchical: hierarchicalChunks.length,
          direct_discarded: directChunks.length
        });
      }
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

  // STEP 3: Score and rank combined chunks.
  allChunks.sort((a, b) => {
    const scoreA = a.hierarchical_score || a.relevance_score || 0;
    const scoreB = b.hierarchical_score || b.relevance_score || 0;
    return scoreB - scoreA;
  });
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

    // STEP 5b: Document-scope filter — when the query explicitly names a document or
    // company (e.g. "Quantum Labs"), demote chunks from other documents. This prevents
    // cross-doc contamination where e.g. TechServe's CEO appears in Quantum Labs results
    // because they share a "Leadership" node in the topical tree.
    {
      const queryLower = query.toLowerCase();
      // Collect all unique doc titles
      const allDocTitles = [...new Set(chunks.map(c => c.doc_title).filter(Boolean))];

      if (allDocTitles.length > 1) {
        // Check which doc titles are mentioned in the query
        const matchedDocs = new Set();
        for (const title of allDocTitles) {
          const titleTerms = (title || '').replace(/[-_.]/g, ' ')
            .toLowerCase().split(/\s+/)
            .filter(t => t.length >= 5);
          if (titleTerms.some(t => queryLower.includes(t))) {
            matchedDocs.add(title);
          }
        }

        // If the query names a specific document, filter out chunks from other docs
        if (matchedDocs.size > 0 && matchedDocs.size < allDocTitles.length) {
          const before = chunks.length;
          chunks = chunks.filter(c => !c.doc_title || matchedDocs.has(c.doc_title));
          if (chunks.length < 2) {
            // Safety: if filtering removed too many, keep at least the top scored ones
            chunks = allChunks
              .filter(c => !c.doc_title || matchedDocs.has(c.doc_title))
              .slice(0, maxChunks);
          }
          if (chunks.length < before) {
            trace?.addStep('Document Scope Filter', `Filtered ${before - chunks.length} cross-doc chunks (query mentions: ${[...matchedDocs].join(', ')})`);
          }
        }
      }
    }

    // STEP 5c: Term-overlap re-sort — promote chunks containing actual query terms to
    // the top of the list. The LLM reranker (gpt-5-nano) sometimes gives all chunks
    // similar scores, so a chunk about "SLA response time" might end up at position [8]
    // behind chunks about vacations and products. The answer LLM is more likely to find
    // and use information from the first few sources, so this simple heuristic ensures
    // content-relevant chunks appear early in the source list.
    {
      const queryTerms = query.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3);

      if (queryTerms.length > 0) {
        for (const chunk of chunks) {
          const content = (chunk.content || chunk.content_clean || '').toLowerCase();
          let termHits = 0;
          for (const term of queryTerms) {
            if (content.includes(term)) termHits++;
          }
          chunk._termOverlap = termHits / queryTerms.length;
        }

        // Stable sort: among chunks with similar reranker scores, prefer those with
        // higher term overlap. This preserves the reranker's relative ordering while
        // boosting content-relevant chunks to the top.
        chunks.sort((a, b) => {
          const overlapDiff = (b._termOverlap || 0) - (a._termOverlap || 0);
          if (Math.abs(overlapDiff) > 0.2) return overlapDiff;
          // Fall back to reranker score for similar overlap
          return (b.rerank_score || 0) - (a.rerank_score || 0);
        });
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
    // maxTotalLength: with maxContextLength=400 each expanded chunk is ~600 chars.
    // 12000 chars accommodates ~20 focused chunks. The old 7000-char budget only fit
    // ~11 chunks, silently dropping 45% of retrieved facts (SLA tiers, probation periods,
    // founding years) that ranked in positions 12-20 after reranking.
    // "Lost in the middle" is a concern at 50k+ tokens; 12000 chars ≈ 3k tokens is well
    // within the reliable extraction range for modern LLMs.
    const chunkContext = buildExpandedContext(expandedChunks, { includeNeighbors: true, maxTotalLength: 12000 });
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

export { QueryTrace };
