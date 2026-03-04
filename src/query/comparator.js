import { callLLM, llmConfig } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { retrieveForComparison, buildMultiNodeContext } from "./multiNodeRetriever.js";
import { logger } from "../utils/logger.js";

/**
 * Comparison Query Handler
 *
 * Handles queries that compare multiple entities
 */

/**
 * Generate a structured comparison
 * @param {string} query - Original comparison query
 * @param {string[]} entities - Entities to compare
 * @param {string[]} aspects - Comparison aspects/criteria
 * @returns {Promise<object>} Comparison result
 */
export async function generateComparison(query, entities, aspects = []) {
  // Retrieve data for all entities
  const comparisonData = await retrieveForComparison(entities, aspects);

  // Check if we have enough data
  const foundEntities = comparisonData.entities.filter(e => e.found);

  if (foundEntities.length < 2) {
    return {
      success: false,
      error: "Could not find enough entities to compare",
      found: foundEntities.map(e => e.name),
      missing: comparisonData.entities.filter(e => !e.found).map(e => e.name)
    };
  }

  // Use LLM to generate comparison
  const comparison = await llmGenerateComparison(query, comparisonData, aspects);

  return {
    success: true,
    query,
    entities: foundEntities.map(e => e.name),
    aspects: comparison.aspects || aspects,
    comparison_table: comparison.table,
    summary: comparison.summary,
    recommendation: comparison.recommendation,
    sources: foundEntities.map(e => ({
      entity: e.name,
      node_id: e.node_id,
      chunk_count: e.chunks.length
    }))
  };
}

/**
 * Use LLM to generate comparison analysis
 */
async function llmGenerateComparison(query, comparisonData, aspects) {
  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return generateBasicComparison(comparisonData, aspects);
  }

  // Build context from comparison data
  const contextParts = [];
  for (const entity of comparisonData.entities) {
    if (!entity.found) continue;

    contextParts.push(`## ${entity.name}\n`);
    contextParts.push(`Summary: ${entity.summary || "N/A"}\n`);

    if (entity.chunks.length > 0) {
      contextParts.push("Details:");
      for (const chunk of entity.chunks.slice(0, 5)) {
        contextParts.push(`- ${chunk.content.slice(0, 500)}`);
      }
    }
    contextParts.push("");
  }

  const context = contextParts.join("\n");

  const prompt = `You are a comparison analyst. Generate a detailed comparison based on the provided information.

User Query: "${query}"

${aspects.length > 0 ? `Comparison Aspects: ${aspects.join(", ")}` : ""}

Context:
${context}

Generate a structured comparison. Return JSON:
{
  "aspects": ["list of comparison aspects used"],
  "table": {
    "headers": ["Aspect", "Entity1", "Entity2", ...],
    "rows": [
      ["aspect_name", "entity1_value", "entity2_value", ...]
    ]
  },
  "summary": "Overall comparison summary",
  "recommendation": "Which option might be better and why (if applicable)",
  "key_differences": ["list of key differences"],
  "key_similarities": ["list of key similarities"]
}`;

  try {
    const text = await callLLM({ prompt, taskName: 'comparison' }) ?? "{}";
    const result = await parseLLMJson(text, 'object', { context: 'comparison', fallback: null });
    if (!result) throw new Error('Failed to parse comparison JSON');
    return result;
  } catch (err) {
    logger.warn(`LLM comparison failed: ${err.message}`);
    return generateBasicComparison(comparisonData, aspects);
  }
}

/**
 * Generate basic comparison without LLM
 */
function generateBasicComparison(comparisonData, aspects) {
  const entities = comparisonData.entities.filter(e => e.found);
  const entityNames = entities.map(e => e.name);

  // Auto-detect aspects if not provided
  const detectedAspects = aspects.length > 0 ? aspects : detectAspects(entities);

  const table = {
    headers: ["Aspect", ...entityNames],
    rows: []
  };

  for (const aspect of detectedAspects) {
    const row = [aspect];
    for (const entity of entities) {
      const relevantContent = entity.aspect_data?.[aspect] ||
        findRelevantContent(entity.chunks, aspect);
      row.push(relevantContent || "Information not available");
    }
    table.rows.push(row);
  }

  return {
    aspects: detectedAspects,
    table,
    summary: `Comparison between ${entityNames.join(" and ")} across ${detectedAspects.length} aspects.`,
    recommendation: null
  };
}

/**
 * Detect comparison aspects from entity content
 */
function detectAspects(entities) {
  const commonAspects = ["price", "features", "performance", "quality", "support"];
  const chineseAspects = ["价格", "功能", "性能", "质量", "服务"];

  const detectedAspects = [];

  // Check which aspects have content in the entities
  for (let i = 0; i < commonAspects.length; i++) {
    for (const entity of entities) {
      const allContent = entity.chunks.map(c => c.content).join(" ").toLowerCase();
      if (allContent.includes(commonAspects[i]) || allContent.includes(chineseAspects[i])) {
        if (!detectedAspects.includes(commonAspects[i])) {
          detectedAspects.push(commonAspects[i]);
        }
        break;
      }
    }
  }

  // If no aspects detected, use defaults
  if (detectedAspects.length === 0) {
    return ["overview", "key_features"];
  }

  return detectedAspects;
}

/**
 * Find content relevant to an aspect
 */
function findRelevantContent(chunks, aspect) {
  const aspectLower = aspect.toLowerCase();

  for (const chunk of chunks) {
    const contentLower = chunk.content.toLowerCase();
    if (contentLower.includes(aspectLower)) {
      // Extract relevant sentence/paragraph
      const sentences = chunk.content.split(/[.。!！?？\n]/);
      for (const sentence of sentences) {
        if (sentence.toLowerCase().includes(aspectLower)) {
          return sentence.trim().slice(0, 300);
        }
      }
    }
  }

  return null;
}

/**
 * Format comparison result as text
 * @param {object} comparisonResult - Result from generateComparison
 * @returns {string} Formatted text
 */
export function formatComparisonAsText(comparisonResult) {
  if (!comparisonResult.success) {
    return `Comparison failed: ${comparisonResult.error}`;
  }

  const lines = [];
  lines.push(`# Comparison: ${comparisonResult.entities.join(" vs ")}`);
  lines.push("");

  // Table
  if (comparisonResult.comparison_table) {
    const { headers, rows } = comparisonResult.comparison_table;

    // Header
    lines.push("| " + headers.join(" | ") + " |");
    lines.push("| " + headers.map(() => "---").join(" | ") + " |");

    // Rows
    for (const row of rows) {
      lines.push("| " + row.join(" | ") + " |");
    }
    lines.push("");
  }

  // Summary
  if (comparisonResult.summary) {
    lines.push("## Summary");
    lines.push(comparisonResult.summary);
    lines.push("");
  }

  // Recommendation
  if (comparisonResult.recommendation) {
    lines.push("## Recommendation");
    lines.push(comparisonResult.recommendation);
  }

  return lines.join("\n");
}

/**
 * Format comparison as JSON response for API
 * @param {object} comparisonResult - Result from generateComparison
 * @returns {object} API response format
 */
export function formatComparisonForAPI(comparisonResult) {
  return {
    type: "comparison",
    success: comparisonResult.success,
    data: {
      entities: comparisonResult.entities,
      aspects: comparisonResult.aspects,
      table: comparisonResult.comparison_table,
      summary: comparisonResult.summary,
      recommendation: comparisonResult.recommendation
    },
    sources: comparisonResult.sources,
    error: comparisonResult.error
  };
}
