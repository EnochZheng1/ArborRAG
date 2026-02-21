import { GoogleGenAI } from "@google/genai";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { getNode, getRelatedNodes, getPathToNode, getChildren, getAncestors } from "../kg/graphTraversal.js";
import { hybridRecallNodes, hybridRecallChunks } from "../kg/recallNodes.js";

/**
 * Multi-Hop Reasoning System
 *
 * Handles queries that require reasoning across multiple nodes
 */

/**
 * Get chunks for a node
 */
function getChunksForNode(nodeId, limit = 10) {
  const rows = ChunkRepo.getForNodeLimited(nodeId, limit);

  return rows.map(r => ({
    id: r.id,
    doc_title: r.doc_title,
    content: r.content_clean,
    chunk_type: r.chunk_type,
    authority_level: r.authority_level
  }));
}

/**
 * Gather context from graph traversal
 * @param {string} nodeId - Starting node
 * @param {object} options - Options
 * @returns {object} Gathered context
 */
export function gatherGraphContext(nodeId, options = {}) {
  const { depth = 2, maxChunksPerNode = 5 } = options;

  const context = {
    primary_node: null,
    related_nodes: [],
    path_context: [],
    total_chunks: 0
  };

  // Get primary node and its chunks
  const primaryNode = getNode(nodeId);
  if (!primaryNode) return context;

  const primaryChunks = getChunksForNode(nodeId, maxChunksPerNode);
  context.primary_node = {
    ...primaryNode,
    chunks: primaryChunks
  };
  context.total_chunks += primaryChunks.length;

  // Get related nodes
  const relatedNodes = getRelatedNodes(nodeId, depth);

  for (const related of relatedNodes.slice(0, 10)) {
    const chunks = getChunksForNode(related.node_id, Math.max(2, maxChunksPerNode - 2));
    context.related_nodes.push({
      ...related,
      chunks
    });
    context.total_chunks += chunks.length;
  }

  // Get path context (for hierarchical understanding)
  const path = getPathToNode(nodeId);
  context.path_context = path.map(n => ({
    node_id: n.node_id,
    name: n.name,
    summary: n.node_summary
  }));

  return context;
}

/**
 * Build rich context for reasoning
 * @param {string} query - User query
 * @param {object} options - Options
 * @returns {Promise<object>} Rich context
 */
export async function buildReasoningContext(query, options = {}) {
  const { maxNodes = 5, graphDepth = 2 } = options;

  // First, find relevant nodes
  const nodeResults = await hybridRecallNodes(query, maxNodes);

  if (nodeResults.length === 0) {
    return {
      query,
      nodes: [],
      graph_context: null,
      combined_context: ""
    };
  }

  const context = {
    query,
    nodes: [],
    graph_context: null,
    combined_context: ""
  };

  // Gather context from top nodes
  for (const result of nodeResults.slice(0, 3)) {
    const graphContext = gatherGraphContext(result.node.node_id, { depth: graphDepth });
    context.nodes.push({
      node: result.node,
      score: result.score,
      ...graphContext
    });
  }

  // Use the top node for primary graph context
  if (nodeResults.length > 0) {
    context.graph_context = gatherGraphContext(nodeResults[0].node.node_id, {
      depth: graphDepth,
      maxChunksPerNode: 5
    });
  }

  // Build combined context string
  context.combined_context = formatReasoningContext(context);

  return context;
}

/**
 * Format reasoning context as string
 */
function formatReasoningContext(context) {
  const parts = [];

  // Add path/hierarchy context
  if (context.graph_context?.path_context?.length > 0) {
    parts.push("## Knowledge Hierarchy");
    parts.push(context.graph_context.path_context.map(n => n.name).join(" > "));
    parts.push("");
  }

  // Add primary node content
  if (context.graph_context?.primary_node) {
    const primary = context.graph_context.primary_node;
    parts.push(`## Primary Topic: ${primary.name}`);
    if (primary.node_summary) {
      parts.push(`Summary: ${primary.node_summary}`);
    }
    if (primary.chunks?.length > 0) {
      parts.push("Content:");
      for (const chunk of primary.chunks) {
        parts.push(`[${chunk.authority_level}] ${chunk.content}`);
      }
    }
    parts.push("");
  }

  // Add related context
  if (context.graph_context?.related_nodes?.length > 0) {
    parts.push("## Related Information");
    for (const related of context.graph_context.related_nodes.slice(0, 5)) {
      parts.push(`### ${related.name} (${related.relationship})`);
      if (related.chunks?.length > 0) {
        for (const chunk of related.chunks.slice(0, 2)) {
          parts.push(chunk.content.slice(0, 500));
        }
      }
      parts.push("");
    }
  }

  return parts.join("\n");
}

/**
 * Perform multi-hop reasoning using LLM
 * @param {string} query - User query
 * @param {object} context - Reasoning context
 * @returns {Promise<object>} Reasoning result
 */
export async function performReasoning(query, context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: "LLM required for reasoning queries"
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  const prompt = `You are a knowledge base reasoning assistant. Answer the user's question by reasoning through the provided context.

User Question: "${query}"

Context:
${context.combined_context}

Instructions:
1. Analyze the question and identify what information is needed
2. Trace through the context to find relevant facts
3. Connect facts to form a logical chain of reasoning
4. Provide a clear, well-reasoned answer
5. Cite specific sources when possible

Return JSON:
{
  "reasoning_steps": [
    {"step": 1, "thought": "First, I look at...", "finding": "..."},
    {"step": 2, "thought": "Then, I connect...", "finding": "..."}
  ],
  "answer": "The final answer based on reasoning",
  "confidence": 0.0-1.0,
  "key_facts": ["list of key facts used"],
  "assumptions": ["any assumptions made"],
  "limitations": ["what the context doesn't cover"]
}`;

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];

    const result = JSON.parse(jsonMatch[1] || text);

    return {
      success: true,
      query,
      ...result,
      sources: context.nodes.map(n => ({
        node_id: n.node.node_id,
        name: n.node.name,
        score: n.score
      }))
    };
  } catch (err) {
    console.error("Reasoning failed:", err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Main reasoning entry point
 * @param {string} query - User query
 * @param {object} options - Options
 * @returns {Promise<object>} Reasoning result
 */
export async function reason(query, options = {}) {
  const { additionalContext = '' } = options;

  // Build context
  const context = await buildReasoningContext(query, options);

  // Append additional context from enhanced retrieval (entities, facts, multi-hop)
  if (additionalContext) {
    context.combined_context = `${context.combined_context}\n\n## Additional Context (from entity/fact retrieval)\n${additionalContext}`;
  }

  if (context.nodes.length === 0 && !additionalContext) {
    return {
      success: false,
      query,
      error: "No relevant context found for reasoning"
    };
  }

  // Perform reasoning
  const result = await performReasoning(query, context);

  return result;
}

/**
 * Chain-of-thought reasoning for complex queries
 * @param {string} query - Complex query
 * @param {string[]} subQueries - Decomposed sub-queries
 * @returns {Promise<object>} Combined reasoning result
 */
export async function chainOfThoughtReason(query, subQueries = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { success: false, error: "LLM required" };
  }

  // If no sub-queries provided, decompose the query
  if (subQueries.length === 0) {
    subQueries = await decomposeQuery(query);
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Gather context for each sub-query
  const subResults = [];
  for (const subQuery of subQueries) {
    const context = await buildReasoningContext(subQuery, { maxNodes: 3 });
    subResults.push({
      query: subQuery,
      context: context.combined_context,
      nodes: context.nodes.map(n => n.node.name)
    });
  }

  // Synthesize final answer
  const synthesisPrompt = `You are a reasoning assistant. Synthesize an answer to the main question using the results from sub-queries.

Main Question: "${query}"

Sub-query Results:
${subResults.map((r, i) => `
## Sub-query ${i + 1}: ${r.query}
Context: ${r.context.slice(0, 1000)}
`).join("\n")}

Synthesize a comprehensive answer that combines insights from all sub-queries.

Return JSON:
{
  "synthesis_steps": [
    {"sub_query": "...", "key_insight": "..."}
  ],
  "final_answer": "Comprehensive answer",
  "confidence": 0.0-1.0
}`;

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: synthesisPrompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];

    return {
      success: true,
      query,
      sub_queries: subQueries,
      ...JSON.parse(jsonMatch[1] || text)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Decompose a complex query into sub-queries
 */
async function decomposeQuery(query) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [query];

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  const prompt = `Decompose this complex question into 2-4 simpler sub-questions that can be answered independently.

Question: "${query}"

Return JSON array of sub-questions:
["sub-question 1", "sub-question 2", ...]`;

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "[]";
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];

    return JSON.parse(jsonMatch[1] || text);
  } catch {
    return [query];
  }
}

/**
 * Format reasoning result as text
 */
export function formatReasoningAsText(result) {
  if (!result.success) {
    return `Reasoning failed: ${result.error}`;
  }

  const lines = [];
  lines.push("# Reasoning Analysis");
  lines.push("");

  if (result.reasoning_steps?.length > 0) {
    lines.push("## Reasoning Steps");
    for (const step of result.reasoning_steps) {
      lines.push(`${step.step}. ${step.thought}`);
      if (step.finding) {
        lines.push(`   → ${step.finding}`);
      }
    }
    lines.push("");
  }

  lines.push("## Answer");
  lines.push(result.answer || result.final_answer);
  lines.push("");

  if (result.confidence) {
    lines.push(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
  }

  if (result.key_facts?.length > 0) {
    lines.push("");
    lines.push("## Key Facts Used");
    for (const fact of result.key_facts) {
      lines.push(`- ${fact}`);
    }
  }

  if (result.limitations?.length > 0) {
    lines.push("");
    lines.push("## Limitations");
    for (const limitation of result.limitations) {
      lines.push(`- ${limitation}`);
    }
  }

  return lines.join("\n");
}
