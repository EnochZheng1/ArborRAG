import { callLLM, llmConfig } from "../utils/llm.js";
import { classifyQuery, QUERY_TYPES } from "./classifier.js";
import { logger } from "../utils/logger.js";

/**
 * Query Planning System
 *
 * Breaks complex queries into sub-queries and plans retrieval strategy
 */

/**
 * Query plan structure
 * @typedef {Object} QueryPlan
 * @property {string} original_query - Original user query
 * @property {string} query_type - Classified query type
 * @property {Array<SubQuery>} sub_queries - List of sub-queries to execute
 * @property {string} aggregation_strategy - How to combine results
 * @property {Object} metadata - Additional planning metadata
 */

/**
 * Sub-query structure
 * @typedef {Object} SubQuery
 * @property {string} query - The sub-query text
 * @property {string} purpose - Purpose of this sub-query
 * @property {string[]} target_entities - Entities to search for
 * @property {string} retrieval_type - "node" or "chunk"
 * @property {number} priority - Execution priority (lower = first)
 */

/**
 * Create a simple lookup plan
 */
function createSimpleLookupPlan(query, classification) {
  return {
    original_query: query,
    query_type: QUERY_TYPES.SIMPLE_LOOKUP,
    sub_queries: [{
      query: query,
      purpose: "Direct lookup",
      target_entities: classification.entities || [],
      retrieval_type: "hybrid",
      priority: 1
    }],
    aggregation_strategy: "single_best",
    metadata: {
      classification,
      complexity: "simple"
    }
  };
}

/**
 * Create a comparison plan
 */
function createComparisonPlan(query, classification) {
  const entities = classification.entities || [];
  const criteria = classification.criteria || [];

  const subQueries = [];

  // Create sub-query for each entity
  for (let i = 0; i < entities.length; i++) {
    subQueries.push({
      query: entities[i],
      purpose: `Retrieve information about ${entities[i]}`,
      target_entities: [entities[i]],
      retrieval_type: "node",
      priority: 1
    });
  }

  // If criteria are specified, create sub-queries for each criterion
  if (criteria.length > 0) {
    for (const entity of entities) {
      for (const criterion of criteria) {
        subQueries.push({
          query: `${entity} ${criterion}`,
          purpose: `Get ${criterion} information for ${entity}`,
          target_entities: [entity],
          retrieval_type: "chunk",
          priority: 2
        });
      }
    }
  }

  return {
    original_query: query,
    query_type: QUERY_TYPES.COMPARISON,
    sub_queries: subQueries,
    aggregation_strategy: "compare_merge",
    metadata: {
      classification,
      entities,
      criteria,
      complexity: entities.length > 2 ? "complex" : "moderate"
    }
  };
}

/**
 * Create a recommendation plan
 */
function createRecommendationPlan(query, classification) {
  const criteria = classification.criteria || [];

  const subQueries = [
    {
      query: query,
      purpose: "Find relevant candidates",
      target_entities: [],
      retrieval_type: "hybrid",
      priority: 1
    }
  ];

  // Add sub-queries for each criterion if specified
  for (const criterion of criteria) {
    subQueries.push({
      query: criterion,
      purpose: `Evaluate candidates on ${criterion}`,
      target_entities: [],
      retrieval_type: "chunk",
      priority: 2
    });
  }

  return {
    original_query: query,
    query_type: QUERY_TYPES.RECOMMENDATION,
    sub_queries: subQueries,
    aggregation_strategy: "score_rank",
    metadata: {
      classification,
      criteria,
      complexity: "moderate"
    }
  };
}

/**
 * Create a reasoning plan
 */
function createReasoningPlan(query, classification) {
  return {
    original_query: query,
    query_type: QUERY_TYPES.REASONING,
    sub_queries: [
      {
        query: query,
        purpose: "Primary context retrieval",
        target_entities: classification.entities || [],
        retrieval_type: "hybrid",
        priority: 1
      },
      {
        query: query,
        purpose: "Related context (graph traversal)",
        target_entities: classification.entities || [],
        retrieval_type: "graph",
        priority: 2
      }
    ],
    aggregation_strategy: "chain_reasoning",
    metadata: {
      classification,
      complexity: "complex",
      requires_graph_traversal: true
    }
  };
}

/**
 * Create an aggregation plan
 */
function createAggregationPlan(query, classification) {
  return {
    original_query: query,
    query_type: QUERY_TYPES.AGGREGATION,
    sub_queries: [
      {
        query: query,
        purpose: "Broad retrieval",
        target_entities: [],
        retrieval_type: "hybrid",
        priority: 1
      }
    ],
    aggregation_strategy: "summarize_all",
    metadata: {
      classification,
      complexity: "moderate"
    }
  };
}

/**
 * Use LLM for complex query planning
 */
async function llmPlanQuery(query, classification) {
  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return null;
  }

  const prompt = `You are a query planning assistant for a knowledge base system.

Given this query and its classification, create an execution plan.

Query: "${query}"
Classification: ${JSON.stringify(classification)}

Create a plan with sub-queries that will help answer this query effectively.

Return JSON only:
{
  "sub_queries": [
    {
      "query": "sub-query text",
      "purpose": "why this sub-query is needed",
      "target_entities": ["entity names to look for"],
      "retrieval_type": "node|chunk|hybrid|graph",
      "priority": 1
    }
  ],
  "aggregation_strategy": "single_best|compare_merge|score_rank|chain_reasoning|summarize_all",
  "reasoning": "explanation of the plan"
}`;

  try {
    const text = await callLLM({ prompt, taskName: 'query_planning' }) ?? "{}";
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];

    return JSON.parse(jsonMatch[1] || text);
  } catch (err) {
    logger.warn(`LLM planning failed: ${err.message}`);
    return null;
  }
}

/**
 * Main query planning function
 * @param {string} query - User query
 * @param {object} options - Options
 * @returns {Promise<QueryPlan>} Query execution plan
 */
export async function planQuery(query, options = {}) {
  const { useLLM = true, classification = null } = options;

  // Get or use provided classification
  const classResult = classification || await classifyQuery(query, { useLLM });

  // Create plan based on query type
  let plan;

  switch (classResult.query_type) {
    case QUERY_TYPES.COMPARISON:
      plan = createComparisonPlan(query, classResult);
      break;

    case QUERY_TYPES.RECOMMENDATION:
      plan = createRecommendationPlan(query, classResult);
      break;

    case QUERY_TYPES.REASONING:
      plan = createReasoningPlan(query, classResult);
      break;

    case QUERY_TYPES.AGGREGATION:
      plan = createAggregationPlan(query, classResult);
      break;

    case QUERY_TYPES.SIMPLE_LOOKUP:
    default:
      plan = createSimpleLookupPlan(query, classResult);
      break;
  }

  // For complex queries, enhance with LLM planning
  if (useLLM && classResult.confidence < 0.8) {
    const llmPlan = await llmPlanQuery(query, classResult);
    if (llmPlan && llmPlan.sub_queries) {
      plan.sub_queries = llmPlan.sub_queries;
      plan.aggregation_strategy = llmPlan.aggregation_strategy || plan.aggregation_strategy;
      plan.metadata.llm_enhanced = true;
    }
  }

  return plan;
}

/**
 * Quick planning without LLM (for performance)
 * @param {string} query - User query
 * @returns {QueryPlan} Query execution plan
 */
export function quickPlanQuery(query) {
  const classResult = {
    query_type: QUERY_TYPES.SIMPLE_LOOKUP,
    confidence: 0.5,
    entities: [],
    criteria: []
  };

  // Quick pattern checks
  if (/比较|对比|vs|versus|compare/i.test(query)) {
    classResult.query_type = QUERY_TYPES.COMPARISON;
    // Extract entities
    const match = query.match(/(.+?)(?:和|与|vs\.?)\s*(.+?)(?:[?？]|$)/i);
    if (match) {
      classResult.entities = [match[1].trim(), match[2].trim()];
    }
  } else if (/推荐|建议|suggest|recommend/i.test(query)) {
    classResult.query_type = QUERY_TYPES.RECOMMENDATION;
  } else if (/为什么|怎么|如何|why|how/i.test(query)) {
    classResult.query_type = QUERY_TYPES.REASONING;
  } else if (/所有|全部|列出|all|list/i.test(query)) {
    classResult.query_type = QUERY_TYPES.AGGREGATION;
  }

  return planQuery(query, { useLLM: false, classification: classResult });
}

/**
 * Get execution order for sub-queries
 * @param {QueryPlan} plan - Query plan
 * @returns {Array<Array<SubQuery>>} Grouped sub-queries by priority
 */
export function getExecutionOrder(plan) {
  const byPriority = new Map();

  for (const sq of plan.sub_queries) {
    const priority = sq.priority || 1;
    if (!byPriority.has(priority)) {
      byPriority.set(priority, []);
    }
    byPriority.get(priority).push(sq);
  }

  // Sort by priority and return as array of arrays
  const sortedPriorities = [...byPriority.keys()].sort((a, b) => a - b);
  return sortedPriorities.map(p => byPriority.get(p));
}

/**
 * Estimate plan complexity
 * @param {QueryPlan} plan - Query plan
 * @returns {object} Complexity metrics
 */
export function estimatePlanComplexity(plan) {
  return {
    total_sub_queries: plan.sub_queries.length,
    unique_entities: new Set(plan.sub_queries.flatMap(sq => sq.target_entities)).size,
    requires_graph: plan.sub_queries.some(sq => sq.retrieval_type === "graph"),
    aggregation_type: plan.aggregation_strategy,
    complexity_level: plan.metadata?.complexity || "unknown"
  };
}
