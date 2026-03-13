/**
 * Schema Interview Engine — LLM-driven adaptive interview and schema generation.
 *
 * Three core functions:
 *  - generateNextQuestion(session)  — Adaptive follow-up based on accumulated context
 *  - generateSchema(session)        — Full schema tree from interview context
 *  - refineSchema(session, instructions) — Natural language schema adjustments
 */

import { callLLM } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { getCustomPrompt } from "../prompts/promptManager.js";
import { logger } from "../utils/logger.js";

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 12;

// ── First question (no LLM call needed) ──────────────────────────────────────

const FIRST_QUESTION = "What is this knowledge base about? Describe the domain, the type of documents you'll store, and what users will typically search for.";

// ── Question generation ──────────────────────────────────────────────────────

/**
 * Generate the next interview question based on accumulated context.
 * Returns { nextQuestion, contextUpdate, shouldStop, confidence }.
 */
export async function generateNextQuestion(session) {
  // First question is always the same broad domain question
  if (session.questionCount === 0) {
    return {
      nextQuestion: FIRST_QUESTION,
      contextUpdate: {},
      shouldStop: false,
      confidence: 0
    };
  }

  const prompt = buildQuestionPrompt(session);
  const customPrompt = getCustomPrompt('schemaInterview_question', {
    interviewContext: JSON.stringify(session.context, null, 2),
    answers: formatAnswers(session.answers),
    existingTree: session.existingTreeSummary || '(empty — no existing nodes)',
    existingStats: session.existingStats ? JSON.stringify(session.existingStats) : '(no data yet)',
    questionCount: String(session.questionCount),
    minQuestions: String(MIN_QUESTIONS),
    maxQuestions: String(MAX_QUESTIONS)
  });

  const raw = await callLLM({
    prompt: customPrompt || prompt,
    temperature: 0.1,
    seed: 42,
    maxOutputTokens: 800,
    taskName: 'schema_interview_question'
  });

  const result = await parseLLMJson(raw, 'object', {
    fallback: { nextQuestion: "What main categories or topics should the knowledge base cover?", contextUpdate: {}, shouldStop: false, confidence: 0.3 },
    context: 'schema_interview_question'
  });

  // Enforce guardrails
  const shouldStop = (result.shouldStop === true && session.questionCount >= MIN_QUESTIONS)
    || session.questionCount >= MAX_QUESTIONS;

  return {
    nextQuestion: result.nextQuestion || "What else should I know about your knowledge base?",
    contextUpdate: result.contextUpdate || {},
    shouldStop,
    confidence: Math.min(1, Math.max(0, result.confidence || 0))
  };
}

// ── Schema generation ────────────────────────────────────────────────────────

/**
 * Generate a complete schema tree from the accumulated interview context.
 * Returns array of { name, description, aliases, keywords, children } nodes.
 */
export async function generateSchema(session) {
  const prompt = buildGeneratePrompt(session);
  const customPrompt = getCustomPrompt('schemaInterview_generate', {
    interviewContext: JSON.stringify(session.context, null, 2),
    answers: formatAnswers(session.answers),
    existingTree: session.existingTreeSummary || '(empty — no existing nodes)',
    existingStats: session.existingStats ? JSON.stringify(session.existingStats) : '(no data yet)'
  });

  const raw = await callLLM({
    prompt: customPrompt || prompt,
    temperature: 0.1,
    seed: 42,
    maxOutputTokens: 4000,
    taskName: 'schema_interview_generate'
  });

  const schema = await parseLLMJson(raw, 'array', {
    fallback: [],
    context: 'schema_interview_generate'
  });

  if (!Array.isArray(schema) || schema.length === 0) {
    throw new Error('Failed to generate schema — LLM returned empty or invalid result');
  }

  // Post-process: cap depth, validate names
  return postProcessSchema(schema, 0);
}

// ── Schema refinement ────────────────────────────────────────────────────────

/**
 * Refine an existing generated schema based on natural language instructions.
 * Returns the adjusted schema array.
 */
export async function refineSchema(session, instructions) {
  const prompt = `You are a knowledge base schema designer. The user wants to modify the schema below.

Current schema (JSON):
${JSON.stringify(session.generatedSchema, null, 2)}

Interview context:
- Domain: ${session.context.domain || 'not specified'}
- Subdomains: ${(session.context.subdomains || []).join(', ') || 'not specified'}
- Language: ${session.context.language || 'auto'}

User's modification request: "${instructions}"

Apply the requested changes and return the COMPLETE updated schema as a JSON array.
Each node: { "name": "...", "description": "...", "aliases": [...], "keywords": [...], "children": [...] }

Rules:
- Preserve nodes the user didn't mention changing
- Node names should match the content language (Chinese content → Chinese names)
- Max 4 levels of depth
- Return ONLY the JSON array, no explanation

JSON:`;

  const raw = await callLLM({
    prompt,
    temperature: 0.1,
    seed: 42,
    maxOutputTokens: 4000,
    taskName: 'schema_interview_refine'
  });

  const schema = await parseLLMJson(raw, 'array', {
    fallback: session.generatedSchema,
    context: 'schema_interview_refine'
  });

  return postProcessSchema(schema, 0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatAnswers(answers) {
  return answers.map((a, i) =>
    `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`
  ).join('\n\n');
}

function buildQuestionPrompt(session) {
  return `You are interviewing a user to design a knowledge base schema (tree structure for organizing information).

Interview so far:
${formatAnswers(session.answers)}

Current understanding:
${JSON.stringify(session.context, null, 2)}

${session.existingTreeSummary ? `Existing tree structure:\n${session.existingTreeSummary}\n` : ''}${session.existingStats ? `Existing data: ${JSON.stringify(session.existingStats)}\n` : ''}
Question ${session.questionCount + 1} (asked ${session.questionCount} so far, min ${MIN_QUESTIONS}, max ${MAX_QUESTIONS}).

Generate ONE single follow-up question — the most useful question to deepen your understanding of their knowledge domain. Pick the single most important gap from this priority list:
1. Domain unclear → ask about the subject area
2. Categories unclear → ask about main topics/categories
3. Depth unclear → ask how detailed the organization should be
4. Query patterns unclear → ask what users will search for
5. Language unclear → ask about content language
6. Entity types unclear → ask about key concepts/entities

CRITICAL RULES:
- Ask exactly ONE question, never combine multiple questions
- Keep the question short and conversational (1-2 sentences max)
- Do NOT list options or bullet points inside the question
- Extract structured info from the user's PREVIOUS answers into contextUpdate

Return JSON only:
{
  "nextQuestion": "Your single question here?",
  "contextUpdate": {
    "domain": "extracted domain (or empty to keep current)",
    "subdomains": ["extracted subdomains"],
    "queryPatterns": ["how users will search"],
    "depthPreference": "shallow|medium|deep",
    "language": "en|zh|auto",
    "entityTypes": ["types of entities mentioned"],
    "additionalNotes": "any other relevant info"
  },
  "shouldStop": false,
  "confidence": 0.0-1.0
}

Set shouldStop=true only when confidence >= 0.85 AND you have enough context to generate a good schema.
Only include non-empty fields in contextUpdate. JSON only:`;
}

function buildGeneratePrompt(session) {
  return `You are a knowledge base architect. Based on the interview below, design an optimal tree structure for organizing information.

Interview answers:
${formatAnswers(session.answers)}

Accumulated context:
- Domain: ${session.context.domain || 'general'}
- Subdomains: ${(session.context.subdomains || []).join(', ') || 'none specified'}
- Query patterns: ${(session.context.queryPatterns || []).join(', ') || 'general search'}
- Depth preference: ${session.context.depthPreference || 'medium'}
- Language: ${session.context.language || 'auto'}
- Entity types: ${(session.context.entityTypes || []).join(', ') || 'general'}
- Additional notes: ${session.context.additionalNotes || 'none'}
${session.existingTreeSummary ? `\nExisting tree (for reference — build upon or reorganize as needed):\n${session.existingTreeSummary}\n` : ''}${session.existingStats ? `Existing data: ${JSON.stringify(session.existingStats)}\n` : ''}

Design a schema tree. Rules:
1. Top-level nodes = main knowledge categories
2. Each node needs: name, description (1-sentence purpose), aliases (2-3 search terms), keywords (3-5 indexing terms)
3. Max 4 levels of depth. Aim for ${session.context.depthPreference === 'shallow' ? '2' : session.context.depthPreference === 'deep' ? '3-4' : '2-3'} levels.
4. Target ${session.context.depthPreference === 'shallow' ? '5-10' : session.context.depthPreference === 'deep' ? '15-30' : '8-20'} total nodes.
5. Node names MUST match the content language (if Chinese domain → Chinese node names)
6. Make categories mutually exclusive but collectively exhaustive for the domain.
7. Leaf nodes should be specific enough that documents can be clearly assigned.

Return ONLY a JSON array of top-level nodes with nested children:
[
  {
    "name": "Category Name",
    "description": "What this category covers",
    "aliases": ["alt name 1", "alt name 2"],
    "keywords": ["keyword1", "keyword2", "keyword3"],
    "children": [
      {
        "name": "Subcategory",
        "description": "...",
        "aliases": [],
        "keywords": [],
        "children": []
      }
    ]
  }
]

JSON array:`;
}

/**
 * Post-process schema: cap depth at 4, validate names, ensure arrays.
 */
function postProcessSchema(nodes, depth) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter(n => n && typeof n.name === 'string' && n.name.trim())
    .map(n => ({
      name: n.name.trim(),
      description: (n.description || '').trim(),
      aliases: Array.isArray(n.aliases) ? n.aliases.filter(a => typeof a === 'string') : [],
      keywords: Array.isArray(n.keywords) ? n.keywords.filter(k => typeof k === 'string') : [],
      children: depth < 3 ? postProcessSchema(n.children || [], depth + 1) : []
    }));
}

/**
 * Count total nodes in a schema tree.
 */
export function countSchemaNodes(nodes) {
  if (!Array.isArray(nodes)) return 0;
  let count = nodes.length;
  for (const n of nodes) {
    count += countSchemaNodes(n.children || []);
  }
  return count;
}

/**
 * Get max depth of a schema tree.
 */
export function getSchemaDepth(nodes, depth = 1) {
  if (!Array.isArray(nodes) || nodes.length === 0) return depth - 1;
  let maxD = depth;
  for (const n of nodes) {
    if (n.children?.length) {
      maxD = Math.max(maxD, getSchemaDepth(n.children, depth + 1));
    }
  }
  return maxD;
}
