import { GoogleGenAI } from "@google/genai";
import { queryLogger as logger } from "../utils/logger.js";
import { recordTokenUsage } from "../utils/tokenTracker.js";
import { detectLanguage, getPrompt } from "../utils/langDetect.js";

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

// Pattern-based classification rules
const CLASSIFICATION_PATTERNS = {
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY required for LLM classification");
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Detect query language and use appropriate prompt
  const lang = detectLanguage(query);
  const prompt = getPrompt('queryClassification', lang, query);

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    // Track token usage
    recordTokenUsage(resp, 'query_classification', { model });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];

    return JSON.parse(jsonMatch[1] || text);
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

  // If pattern gives a result with high confidence, use it
  if (patternResult && entities.length > 0) {
    // For comparison queries with clear entities, trust the pattern
    if (patternResult === "comparison" && entities.length >= 2) {
      return {
        query_type: patternResult,
        confidence: 0.9,
        entities,
        criteria: [],
        reasoning: "Pattern match with entity extraction",
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
