import { callLLM } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { queryLogger as logger } from "../utils/logger.js";
import { getPrompt } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";

/**
 * Query Classification System
 *
 * Classifies user queries into types for appropriate handling:
 * - simple_lookup: Direct fact retrieval
 * - comparison: Compare 2+ entities
 * - recommendation: Suggest based on criteria
 * - reasoning: Multi-hop reasoning required
 * - aggregation: Summarize across multiple sources
 */

// Query type definitions
export const QUERY_TYPES = {
  SIMPLE_LOOKUP: "simple_lookup",
  COMPARISON: "comparison",
  RECOMMENDATION: "recommendation",
  REASONING: "reasoning",
  AGGREGATION: "aggregation"
};

// Pattern-based classification rules (checked in order — first match wins)
const CLASSIFICATION_PATTERNS = {
  // simple_lookup checked BEFORE recommendation so "what should I do" action
  // queries (medical protocols, emergency steps) are not misrouted.
  simple_lookup: [
    /what.*should\s+I\s+do/i,
    /what.*do\s+I\s+do/i,
    /what.*action|what.*step|what.*procedure/i,
    /怎么办|该怎么做|应该怎么/,
  ],
  comparison: [
    /比较|对比|区别|差异|不同|vs|versus|compare|differ|between.*and/i,
    /哪个更|which.*better|which.*prefer/i,
    /(.+)和(.+)(?:有什么|的)(?:区别|不同|差异)/,
    /(.+)\s*(?:vs\.?|versus)\s*(.+)/i
  ],
  recommendation: [
    /推荐|建议|应该选|哪个好|suggest|recommend|which.*should|best.*for/i,
    /适合|suitable|fit.*for|用什么|选择什么/i
  ],
  reasoning: [
    /为什么|怎么|如何|原因|how.*work|why.*does|explain.*how/i,
    /如果.*那么|假设|when.*then|what.*if|suppose/i,
    /影响|导致|造成|cause|effect|impact|result.*in/i
  ],
  aggregation: [
    /所有|全部|总结|汇总|列出|summarize|all.*of|list.*all|overview/i,
    /有哪些|多少种|types.*of|kinds.*of|categories/i,
    // Document-specific queries: "What's in document X?"
    /[""「『《].*[""」』》].*(?:里|中|内|的).*(?:有什么|内容|讲什么|说什么|包含|contains|about)/i,
    /(?:文档|文件|document|file).*(?:内容|讲|说|包含|contains|about)/i,
    /what.*(?:in|about|does).*(?:document|file|doc)/i,
    // Simpler patterns for "X里有什么内容" style queries
    /.+里有什么/,
    /.+(?:里|中)(?:有|包含|讲)(?:什么|哪些)/,
    /.+的(?:内容|主要内容)是什么/
  ]
};

// Few-shot examples for LLM classification
const CLASSIFICATION_EXAMPLES = `
Examples of query classification:

1. "产品A的价格是多少？" → simple_lookup
   Reason: Direct fact retrieval about a single entity

2. "产品A和产品B哪个性价比更高？" → comparison
   Reason: Comparing two entities on specific criteria

3. "我需要处理大量数据，推荐用哪个产品？" → recommendation
   Reason: Seeking suggestion based on requirements

4. "为什么产品A在高温环境下性能会下降？" → reasoning
   Reason: Requires understanding cause-effect relationships

5. "我们有哪些产品线？" → aggregation
   Reason: Summarizing information across multiple entities

6. "产品A的退款政策是什么？" → simple_lookup
   Reason: Direct policy lookup

7. "产品A和产品B在安全性、性能和价格方面如何比较？" → comparison
   Reason: Multi-aspect comparison between entities

8. "基于我们的预算和需求，应该选择哪个方案？" → recommendation
   Reason: Recommendation based on multiple criteria
`;

/**
 * Pattern-based quick classification
 * @param {string} query - User query
 * @returns {string|null} Query type or null if uncertain
 */
function patternClassify(query) {
  for (const [type, patterns] of Object.entries(CLASSIFICATION_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(query)) {
        return type;
      }
    }
  }
  return null;
}

/**
 * Extract entities mentioned in query
 * @param {string} query - User query
 * @returns {string[]} Extracted entities
 */
export function extractQueryEntities(query) {
  const entities = [];

  // Pattern: X和Y, X与Y, X vs Y
  const vsPatterns = [
    /(.+?)(?:和|与|跟|vs\.?|versus|compared?\s+(?:to|with))\s*(.+?)(?:[?？。，,]|$)/gi,
    /(?:比较|对比)\s*(.+?)(?:和|与|跟)\s*(.+)/gi
  ];

  for (const pattern of vsPatterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      if (match[1]) entities.push(match[1].trim());
      if (match[2]) entities.push(match[2].trim());
    }
  }

  // Pattern: quoted entities "Entity Name"
  const quotedPattern = /["「『"']([^"「『"']+)["」』"']/g;
  let match;
  while ((match = quotedPattern.exec(query)) !== null) {
    entities.push(match[1].trim());
  }

  // Remove duplicates
  return [...new Set(entities)];
}

/**
 * LLM-based query classification
 * @param {string} query - User query
 * @returns {Promise<object>} Classification result
 */
async function llmClassify(query) {
  // Detect query language and use appropriate prompt
  const lang = getEffectiveLang(query);
  const prompt = getPrompt('queryClassification', lang, query);

  try {
    const text = await callLLM({ prompt, temperature: 0.0, seed: 42, taskName: 'query_classification' }) ?? "{}";
    const result = await parseLLMJson(text, 'object', { context: 'query_classification', fallback: null });
    if (!result) throw new Error('Failed to parse classification JSON');
    return result;
  } catch (err) {
    logger.error("LLM classification failed:", err.message);
    throw err;
  }
}

/**
 * Main classification function
 * @param {string} query - User query
 * @param {object} options - Options
 * @returns {Promise<object>} Classification result
 */
export async function classifyQuery(query, options = {}) {
  const { useLLM = true, confidenceThreshold = 0.7 } = options;

  // First try pattern-based classification
  const patternResult = patternClassify(query);
  const entities = extractQueryEntities(query);

  if (patternResult && !useLLM) {
    return {
      query_type: patternResult,
      confidence: 0.8,
      entities,
      criteria: [],
      reasoning: "Pattern-based classification",
      method: "pattern"
    };
  }

  // If pattern gives a high-confidence result, trust it over the LLM.
  // simple_lookup patterns catch "what should I do" action queries that the LLM
  // misclassifies as recommendation; comparison patterns catch "X vs Y" with entities.
  if (patternResult) {
    // Assign confidence per pattern type
    let patternConfidence = 0.7;
    let patternReasoning = "Pattern-based classification";

    if (patternResult === "simple_lookup") {
      patternConfidence = 0.85;
      patternReasoning = "Pattern match: action/protocol lookup";
    } else if (patternResult === "comparison" && entities.length >= 2) {
      patternConfidence = 0.9;
      patternReasoning = "Pattern match with entity extraction";
    } else if (patternResult === "aggregation") {
      patternConfidence = 0.85;
      patternReasoning = "Pattern match: aggregation/listing query";
    }

    // Skip LLM classification when pattern confidence is high enough
    if (patternConfidence >= 0.85) {
      return {
        query_type: patternResult,
        confidence: patternConfidence,
        entities,
        criteria: [],
        reasoning: patternReasoning,
        method: "pattern"
      };
    }
  }

  // Use LLM for more nuanced classification
  if (useLLM) {
    try {
      const llmResult = await llmClassify(query);

      // Merge pattern entities with LLM entities
      const allEntities = [...new Set([...entities, ...(llmResult.entities || [])])];

      return {
        ...llmResult,
        entities: allEntities,
        method: "llm"
      };
    } catch (err) {
      // Fallback to pattern or default
      logger.warn("LLM classification failed, using fallback");
    }
  }

  // Default classification
  return {
    query_type: patternResult || QUERY_TYPES.SIMPLE_LOOKUP,
    confidence: patternResult ? 0.6 : 0.4,
    entities,
    criteria: [],
    reasoning: patternResult ? "Pattern-based fallback" : "Default to simple lookup",
    method: "fallback"
  };
}

/**
 * Quick classification without LLM (for performance)
 * @param {string} query - User query
 * @returns {object} Classification result
 */
export function quickClassify(query) {
  const patternResult = patternClassify(query);
  const entities = extractQueryEntities(query);

  return {
    query_type: patternResult || QUERY_TYPES.SIMPLE_LOOKUP,
    confidence: patternResult ? 0.7 : 0.5,
    entities,
    criteria: [],
    method: "quick"
  };
}

/**
 * Check if query is a comparison query
 */
export function isComparisonQuery(query) {
  return CLASSIFICATION_PATTERNS.comparison.some(p => p.test(query));
}

/**
 * Check if query is a recommendation query
 */
export function isRecommendationQuery(query) {
  return CLASSIFICATION_PATTERNS.recommendation.some(p => p.test(query));
}

/**
 * Check if query requires reasoning
 */
export function isReasoningQuery(query) {
  return CLASSIFICATION_PATTERNS.reasoning.some(p => p.test(query));
}

/**
 * Check if query is an aggregation query
 */
export function isAggregationQuery(query) {
  return CLASSIFICATION_PATTERNS.aggregation.some(p => p.test(query));
}

/**
 * Detect aggregation sub-type: enumeration vs summarization.
 * Enumeration queries ask "how many", "list all", "what are the" — they want a count/list.
 * Summarization queries ask "summarize", "overview", "what's in document X" — they want prose.
 * @param {string} query
 * @returns {'enumeration' | 'summarization'}
 */
export function detectAggregationSubType(query) {
  const enumerationPatterns = [
    /how\s+many/i,
    /多少[种个类项]?/,
    /有哪些/,
    /list\s+(all|the|every)/i,
    /列出[所全]?[有部]/i,
    /列举/,
    /\bcount\b/i,
    /\benumerate\b/i,
    /what\s+are\s+(?:the|all)\b/i,
    /都有(?:什么|哪些)/,
    /types?\s+of\b/i,
    /kinds?\s+of\b/i,
    /categories\s+of\b/i,
    /多少种/,
    /几[种个类项]/
  ];

  for (const p of enumerationPatterns) {
    if (p.test(query)) return 'enumeration';
  }
  return 'summarization';
}
