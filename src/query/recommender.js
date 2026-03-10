import { callLLM, isLlmConfigured } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { retrieveForRecommendation, retrieveAndAggregate } from "./multiNodeRetriever.js";
import { logger } from "../utils/logger.js";
import { getCustomPrompt } from "../prompts/promptManager.js";

/**
 * Recommendation Query Handler
 *
 * Handles queries that ask for recommendations or suggestions
 */

/**
 * Generate recommendation based on query and criteria
 * @param {string} query - Recommendation query
 * @param {object} options - Options and criteria
 * @returns {Promise<object>} Recommendation result
 */
export async function generateRecommendation(query, options = {}) {
  const {
    criteria = [],
    maxCandidates = 5,
    userContext = {}
  } = options;

  // Build criteria object
  const criteriaObj = {
    minScore: 0.3,
    maxCandidates: maxCandidates * 2
  };
  for (const c of criteria) {
    criteriaObj[c] = true;
  }

  // Retrieve candidates
  const candidateData = await retrieveForRecommendation(query, criteriaObj);

  if (candidateData.candidates.length === 0) {
    return {
      success: false,
      error: "No suitable candidates found for recommendation",
      query
    };
  }

  // Use LLM to analyze and recommend
  const recommendation = await llmGenerateRecommendation(
    query,
    candidateData,
    criteria,
    userContext
  );

  return {
    success: true,
    query,
    criteria,
    recommendations: recommendation.recommendations,
    reasoning: recommendation.reasoning,
    alternatives: recommendation.alternatives,
    considerations: recommendation.considerations,
    sources: candidateData.candidates.slice(0, maxCandidates).map(c => ({
      name: c.node.name,
      node_id: c.node.node_id,
      score: c.total_score
    }))
  };
}

/**
 * Use LLM to generate recommendation
 */
async function llmGenerateRecommendation(query, candidateData, criteria, userContext) {
  if (!isLlmConfigured()) {
    return generateBasicRecommendation(candidateData, criteria);
  }

  // Build context
  const contextParts = [];
  for (const candidate of candidateData.candidates.slice(0, 10)) {
    contextParts.push(`## ${candidate.node.name}`);
    contextParts.push(`Score: ${candidate.total_score.toFixed(2)}`);
    contextParts.push(`Summary: ${candidate.node.node_summary || "N/A"}`);

    if (candidate.sample_content.length > 0) {
      contextParts.push("Details:");
      for (const sample of candidate.sample_content) {
        contextParts.push(`- ${sample.preview}`);
      }
    }
    contextParts.push("");
  }

  const context = contextParts.join("\n");

  const criteriaText = criteria.length > 0 ? `Criteria to consider: ${criteria.join(", ")}` : "";
  const userContextText = Object.keys(userContext).length > 0 ? `User Context: ${JSON.stringify(userContext)}` : "";
  const prompt = getCustomPrompt('recommendation', { query, criteria: criteriaText, userContext: userContextText, context }) ?? `You are a recommendation assistant. Based on the user's query and available options, provide recommendations.

User Query: "${query}"

${criteriaText}

${userContextText}

Available Options:
${context}

Generate recommendations. Return JSON:
{
  "recommendations": [
    {
      "name": "option name",
      "rank": 1,
      "match_score": 0.0-1.0,
      "why_recommended": "explanation",
      "pros": ["advantages"],
      "cons": ["disadvantages"]
    }
  ],
  "top_recommendation": "name of best option",
  "reasoning": "overall reasoning for recommendations",
  "alternatives": ["other options to consider"],
  "considerations": ["things to keep in mind"]
}`;

  try {
    const text = await callLLM({ prompt, taskName: 'recommendation' }) ?? "{}";
    const result = await parseLLMJson(text, 'object', { context: 'recommendation', fallback: null });
    if (!result) throw new Error('Failed to parse recommendation JSON');
    return result;
  } catch (err) {
    logger.warn(`LLM recommendation failed: ${err.message}`);
    return generateBasicRecommendation(candidateData, criteria);
  }
}

/**
 * Generate basic recommendation without LLM
 */
function generateBasicRecommendation(candidateData, criteria) {
  const recommendations = candidateData.candidates.slice(0, 5).map((c, i) => ({
    name: c.node.name,
    rank: i + 1,
    match_score: c.total_score,
    why_recommended: `Matched query with score ${c.total_score.toFixed(2)}`,
    pros: [],
    cons: []
  }));

  return {
    recommendations,
    top_recommendation: recommendations[0]?.name,
    reasoning: "Recommendations based on relevance scoring",
    alternatives: [],
    considerations: criteria.length > 0
      ? [`Considered criteria: ${criteria.join(", ")}`]
      : ["Consider your specific requirements"]
  };
}

/**
 * Extract criteria from a recommendation query
 * @param {string} query - User query
 * @returns {string[]} Extracted criteria
 */
export function extractCriteriaFromQuery(query) {
  const criteria = [];

  // Common criteria patterns
  const patterns = [
    { pattern: /(?:价格|便宜|经济|budget|cheap|affordable|cost)/i, criterion: "price" },
    { pattern: /(?:性能|快|速度|performance|fast|speed)/i, criterion: "performance" },
    { pattern: /(?:质量|可靠|稳定|quality|reliable|stable)/i, criterion: "quality" },
    { pattern: /(?:易用|简单|方便|easy|simple|convenient)/i, criterion: "ease_of_use" },
    { pattern: /(?:功能|特性|feature)/i, criterion: "features" },
    { pattern: /(?:支持|服务|support|service)/i, criterion: "support" },
    { pattern: /(?:安全|security|safe)/i, criterion: "security" },
    { pattern: /(?:兼容|compatible)/i, criterion: "compatibility" }
  ];

  for (const { pattern, criterion } of patterns) {
    if (pattern.test(query)) {
      criteria.push(criterion);
    }
  }

  return criteria;
}

/**
 * Format recommendation result as text
 * @param {object} result - Result from generateRecommendation
 * @returns {string} Formatted text
 */
export function formatRecommendationAsText(result) {
  if (!result.success) {
    return `Recommendation failed: ${result.error}`;
  }

  const lines = [];
  lines.push("# Recommendations");
  lines.push("");

  if (result.recommendations?.top_recommendation) {
    lines.push(`**Top Recommendation: ${result.recommendations.top_recommendation}**`);
    lines.push("");
  }

  const recs = result.recommendations?.recommendations || result.recommendations;
  if (Array.isArray(recs)) {
    for (const rec of recs) {
      lines.push(`## ${rec.rank}. ${rec.name}`);
      lines.push(`Match Score: ${(rec.match_score * 100).toFixed(0)}%`);
      lines.push(`Reason: ${rec.why_recommended}`);

      if (rec.pros?.length > 0) {
        lines.push("Pros:");
        for (const pro of rec.pros) {
          lines.push(`  + ${pro}`);
        }
      }

      if (rec.cons?.length > 0) {
        lines.push("Cons:");
        for (const con of rec.cons) {
          lines.push(`  - ${con}`);
        }
      }
      lines.push("");
    }
  }

  if (result.reasoning) {
    lines.push("## Reasoning");
    lines.push(result.reasoning);
    lines.push("");
  }

  if (result.considerations?.length > 0) {
    lines.push("## Considerations");
    for (const consideration of result.considerations) {
      lines.push(`- ${consideration}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format recommendation for API response
 * @param {object} result - Result from generateRecommendation
 * @returns {object} API response format
 */
export function formatRecommendationForAPI(result) {
  return {
    type: "recommendation",
    success: result.success,
    data: {
      query: result.query,
      criteria: result.criteria,
      recommendations: result.recommendations,
      reasoning: result.reasoning,
      alternatives: result.alternatives,
      considerations: result.considerations
    },
    sources: result.sources,
    error: result.error
  };
}
