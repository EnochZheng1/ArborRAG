import { GoogleGenAI } from "@google/genai";
import { SuggestionRepo } from "../db/repositories/SuggestionRepo.js";
import { isChineseLang } from "../utils/langDetect.js";

/**
 * Related Questions Module
 *
 * Generates follow-up questions based on query, answer, and tree structure
 */

const questionsCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

/**
 * Generate related questions
 * @param {object} context - Query context
 * @returns {Promise<Array>} Related questions
 */
export async function generateRelatedQuestions(context) {
  const {
    query,
    answer,
    nodes = [],
    chunks = [],
    queryType = 'simple_lookup'
  } = context;

  // Check cache
  const cacheKey = `${query}:${nodes.map(n => n.node_id || n.node?.node_id).join(',')}`;
  const cached = questionsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.questions;
  }

  const questions = [];

  // Strategy 1: Tree-based suggestions (siblings, children, parent topics)
  const treeQuestions = await generateTreeBasedQuestions(nodes);
  questions.push(...treeQuestions);

  // Strategy 2: Content-based suggestions (from chunks)
  const contentQuestions = extractQuestionsFromContent(chunks, query);
  questions.push(...contentQuestions);

  // Strategy 3: LLM-generated follow-ups
  const llmQuestions = await generateLLMQuestions(query, answer, chunks, queryType);
  questions.push(...llmQuestions);

  // Deduplicate and rank
  const uniqueQuestions = deduplicateQuestions(questions);
  const rankedQuestions = rankQuestions(uniqueQuestions, query);

  // Take top results
  const finalQuestions = rankedQuestions.slice(0, 5);

  // Cache
  questionsCache.set(cacheKey, { questions: finalQuestions, timestamp: Date.now() });

  // Clean old cache
  if (questionsCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of questionsCache) {
      if (now - value.timestamp > CACHE_TTL) {
        questionsCache.delete(key);
      }
    }
  }

  return finalQuestions;
}

/**
 * Generate questions based on tree structure
 */
async function generateTreeBasedQuestions(nodes) {
  const questions = [];

  for (const nodeData of nodes.slice(0, 3)) {
    const node = nodeData.node || nodeData;
    const nodeId = node.node_id;

    if (!nodeId) continue;

    try {
      // Get siblings
      const siblings = SuggestionRepo.getSiblings(nodeId);

      for (const sibling of siblings) {
        if (sibling.name) {
          questions.push({
            text: `What about ${sibling.name}?`,
            text_zh: `${sibling.name}怎么样？`,
            type: 'sibling',
            node_id: sibling.node_id,
            score: 0.7
          });
        }
      }

      // Get children
      const children = SuggestionRepo.getChildren(nodeId);

      for (const child of children) {
        if (child.name) {
          questions.push({
            text: `Tell me more about ${child.name}`,
            text_zh: `详细介绍一下${child.name}`,
            type: 'child',
            node_id: child.node_id,
            score: 0.8
          });
        }
      }

      // Get parent for broader context
      const parent = SuggestionRepo.getParent(nodeId);

      if (parent && parent.name) {
        questions.push({
          text: `What else is under ${parent.name}?`,
          text_zh: `${parent.name}还有什么内容？`,
          type: 'parent',
          node_id: parent.node_id,
          score: 0.6
        });
      }
    } catch (error) {
      // Continue on error
    }
  }

  return questions;
}

/**
 * Extract potential questions from chunk content
 */
function extractQuestionsFromContent(chunks, originalQuery) {
  const questions = [];
  const queryTerms = new Set(originalQuery.toLowerCase().split(/\s+/));

  for (const chunk of chunks.slice(0, 5)) {
    const content = chunk.content || chunk.content_clean || '';

    // Look for topics mentioned but not in query
    const entities = extractEntities(content);

    for (const entity of entities) {
      if (!queryTerms.has(entity.toLowerCase()) && entity.length > 2) {
        questions.push({
          text: `What is ${entity}?`,
          text_zh: `什么是${entity}？`,
          type: 'entity',
          score: 0.5
        });
      }
    }

    // Look for comparison opportunities
    const comparisonPairs = extractComparisonPairs(content);
    for (const pair of comparisonPairs) {
      questions.push({
        text: `How does ${pair[0]} compare to ${pair[1]}?`,
        text_zh: `${pair[0]}和${pair[1]}有什么区别？`,
        type: 'comparison',
        score: 0.6
      });
    }
  }

  return questions;
}

/**
 * Generate questions using LLM
 */
async function generateLLMQuestions(query, answer, chunks, queryType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    const contentPreview = chunks.slice(0, 3)
      .map(c => (c.content || c.content_clean || '').slice(0, 200))
      .join('\n');

    const prompt = `Based on this Q&A, suggest 3 natural follow-up questions a user might ask.

Original Question: "${query}"
${answer ? `Answer Summary: "${answer.slice(0, 300)}"` : ''}
Related Content: "${contentPreview}"

Generate questions that:
1. Dig deeper into the topic
2. Explore related aspects
3. Clarify or expand on the answer

Return JSON array with both English and Chinese versions:
[
  {"en": "English question?", "zh": "中文问题？", "type": "deeper|related|clarify"}
]

JSON only:`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.7, maxOutputTokens: 300 }
    });

    const text = response.text?.trim() || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);

    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);

    return parsed.map(q => ({
      text: q.en,
      text_zh: q.zh,
      type: q.type || 'llm',
      score: 0.9
    }));
  } catch (error) {
    console.error('LLM question generation error:', error.message);
    return [];
  }
}

/**
 * Extract named entities from text
 */
function extractEntities(text) {
  const entities = [];

  // Chinese entities (2-4 char proper nouns)
  const chineseEntities = text.match(/[A-Z]?[\u4e00-\u9fa5]{2,6}/g) || [];
  entities.push(...chineseEntities);

  // English entities (capitalized words)
  const englishEntities = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  entities.push(...englishEntities);

  // Deduplicate
  return [...new Set(entities)].slice(0, 10);
}

/**
 * Extract potential comparison pairs
 */
function extractComparisonPairs(text) {
  const pairs = [];

  // Look for "A和B", "A vs B", "A or B" patterns
  const patterns = [
    /([^\s,，]+)和([^\s,，]+)/g,
    /([^\s,，]+)\s+(?:vs|versus|or)\s+([^\s,，]+)/gi,
    /([^\s,，]+)、([^\s,，]+)/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1].length > 1 && match[2].length > 1) {
        pairs.push([match[1], match[2]]);
      }
    }
  }

  return pairs.slice(0, 3);
}

/**
 * Deduplicate questions by similarity
 */
function deduplicateQuestions(questions) {
  const unique = [];
  const seenTexts = new Set();

  for (const q of questions) {
    const normalized = q.text.toLowerCase().replace(/[?？\s]/g, '');
    if (!seenTexts.has(normalized) && normalized.length > 5) {
      seenTexts.add(normalized);
      unique.push(q);
    }
  }

  return unique;
}

/**
 * Rank questions by relevance and diversity
 */
function rankQuestions(questions, originalQuery) {
  // Score each question
  for (const q of questions) {
    let score = q.score || 0.5;

    // Boost questions that share terms with original query
    const queryTerms = originalQuery.toLowerCase().split(/\s+/);
    const questionTerms = q.text.toLowerCase().split(/\s+/);
    const overlap = queryTerms.filter(t => questionTerms.includes(t)).length;
    score += overlap * 0.1;

    // Slightly penalize very long questions
    if (q.text.length > 100) score -= 0.1;

    // Boost LLM-generated questions
    if (q.type === 'llm') score += 0.1;

    q.finalScore = score;
  }

  // Sort by score
  questions.sort((a, b) => b.finalScore - a.finalScore);

  // Ensure type diversity (at least try to have different types in top 5)
  const diverse = [];
  const seenTypes = new Set();

  // First pass: one of each type
  for (const q of questions) {
    if (!seenTypes.has(q.type) && diverse.length < 5) {
      diverse.push(q);
      seenTypes.add(q.type);
    }
  }

  // Second pass: fill remaining slots
  for (const q of questions) {
    if (!diverse.includes(q) && diverse.length < 5) {
      diverse.push(q);
    }
  }

  return diverse;
}

/**
 * Format questions for API response
 * @param {Array} questions - Generated questions
 * @param {string} lang - Language preference
 * @returns {Array} Formatted questions
 */
export function formatQuestionsForAPI(questions, lang = 'en') {
  return questions.map(q => ({
    question: isChineseLang(lang) && q.text_zh ? q.text_zh : q.text,
    question_alt: isChineseLang(lang) ? q.text : q.text_zh,
    type: q.type,
    node_id: q.node_id
  }));
}
