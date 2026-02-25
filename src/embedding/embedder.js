import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { embedLogger as logger } from "../utils/logger.js";
import { recordTokenUsage } from "../utils/tokenTracker.js";
import { llmConfig, getCurrentEmbedModel } from "../utils/llm.js";

/**
 * Embedding generation — supports OpenAI and Gemini via llmConfig.
 */

// Both text-embedding-3-large (OpenAI) and gemini-embedding-001 use 3072 dimensions
const EMBEDDING_DIMENSION = 3072;
const MAX_BATCH_SIZE = 100;
const MAX_INPUT_LENGTH = 2048; // Characters

// Check if embeddings are disabled
const EMBEDDINGS_DISABLED = process.env.DISABLE_EMBEDDINGS === "true";

logger.info(`Embeddings disabled: ${EMBEDDINGS_DISABLED}`);

// Simple in-memory cache
const embeddingCache = new Map();
const CACHE_MAX_SIZE = 1000;

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // ms between requests

// Lazy provider clients
let _geminiClient = null;
let _openaiClient = null;

function getGeminiClient() {
  if (!_geminiClient) {
    const apiKey = llmConfig.gemini.apiKey;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
    _geminiClient = new GoogleGenAI({ apiKey });
  }
  return _geminiClient;
}

function getOpenAIClient() {
  if (!_openaiClient) {
    const apiKey = llmConfig.openai.apiKey;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

/**
 * Reset cached clients (call when llmConfig changes provider or keys).
 */
export function resetEmbedderClient() {
  _geminiClient = null;
  _openaiClient = null;
}

/**
 * Rate limit helper
 */
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();
}

/**
 * Truncate text to max length
 */
function truncateText(text, maxLen = MAX_INPUT_LENGTH) {
  if (text.length <= maxLen) return text;
  // Try to cut at word boundary
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxLen * 0.8 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Generate cache key for text
 */
function getCacheKey(text) {
  // Simple hash for cache key
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${hash}_${text.length}`;
}

/**
 * Generate an embedding vector using the configured provider.
 * taskType is used only for Gemini (ignored by OpenAI).
 */
async function generateEmbeddingVector(text, taskType) {
  await rateLimitWait();

  if (llmConfig.provider === 'openai') {
    const client = getOpenAIClient();
    const resp = await client.embeddings.create({
      model: llmConfig.openai.embeddingModel,
      input: text,
      encoding_format: 'float',
    });
    recordTokenUsage(
      { usageMetadata: { totalTokenCount: resp.usage?.total_tokens ?? 0 } },
      'embedding',
      { provider: 'openai', model: llmConfig.openai.embeddingModel }
    );
    return resp.data[0].embedding;
  } else {
    const ai = getGeminiClient();
    const result = await ai.models.embedContent({
      model: llmConfig.gemini.embeddingModel,
      contents: [{ parts: [{ text }] }],
      config: { taskType },
    });
    recordTokenUsage(result, 'embedding', { provider: 'gemini', model: llmConfig.gemini.embeddingModel });
    return result?.embedding?.values || result?.embeddings?.[0]?.values;
  }
}

/**
 * Generate embedding for a single text
 * @param {string} text - Text to embed
 * @param {object} options - Options
 * @returns {Promise<number[]>} Embedding vector
 */
export async function generateEmbedding(text, options = {}) {
  // Check if embeddings are disabled
  if (EMBEDDINGS_DISABLED) {
    throw new Error("Embeddings are disabled via DISABLE_EMBEDDINGS=true");
  }

  const { useCache = true, taskType = "RETRIEVAL_DOCUMENT" } = options;

  if (!text || typeof text !== "string") {
    throw new Error("Text must be a non-empty string");
  }

  const normalizedText = truncateText(text.trim());

  // Check cache
  if (useCache) {
    const cacheKey = getCacheKey(normalizedText);
    if (embeddingCache.has(cacheKey)) {
      return embeddingCache.get(cacheKey);
    }
  }

  try {
    const embedding = await generateEmbeddingVector(normalizedText, taskType);

    if (!embedding || !Array.isArray(embedding)) {
      logger.error("Invalid embedding response format:", JSON.stringify(embedding));
      throw new Error("Invalid embedding response from API");
    }

    // Cache result
    if (useCache) {
      const cacheKey = getCacheKey(normalizedText);
      if (embeddingCache.size >= CACHE_MAX_SIZE) {
        // Remove oldest entry (first key)
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
      }
      embeddingCache.set(cacheKey, embedding);
    }

    return embedding;
  } catch (err) {
    logger.error("Embedding generation failed:", err.message);
    throw err;
  }
}

/**
 * Generate embedding for a query (uses different task type)
 * @param {string} query - Query text
 * @returns {Promise<number[]>} Embedding vector
 */
export async function generateQueryEmbedding(query) {
  return generateEmbedding(query, {
    useCache: false, // Queries are usually unique
    taskType: "RETRIEVAL_QUERY"
  });
}

/**
 * Generate embeddings for multiple texts in batch
 * @param {string[]} texts - Array of texts to embed
 * @param {object} options - Options
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function generateEmbeddingBatch(texts, options = {}) {
  const { useCache = true, taskType = "RETRIEVAL_DOCUMENT", onProgress = null } = options;

  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const results = new Array(texts.length).fill(null);
  const toGenerate = [];

  // Check cache first
  if (useCache) {
    for (let i = 0; i < texts.length; i++) {
      const text = truncateText(texts[i]?.trim() || "");
      const cacheKey = getCacheKey(text);

      if (embeddingCache.has(cacheKey)) {
        results[i] = embeddingCache.get(cacheKey);
      } else {
        toGenerate.push({ index: i, text });
      }
    }
  } else {
    for (let i = 0; i < texts.length; i++) {
      toGenerate.push({ index: i, text: truncateText(texts[i]?.trim() || "") });
    }
  }

  // Generate embeddings for non-cached texts in batches
  for (let batchStart = 0; batchStart < toGenerate.length; batchStart += MAX_BATCH_SIZE) {
    const batch = toGenerate.slice(batchStart, batchStart + MAX_BATCH_SIZE);

    try {
      // Generate embeddings one at a time
      for (const item of batch) {
        const embedding = await generateEmbeddingVector(item.text, taskType);

        if (embedding && Array.isArray(embedding)) {
          results[item.index] = embedding;

          // Cache result
          if (useCache) {
            const cacheKey = getCacheKey(item.text);
            if (embeddingCache.size >= CACHE_MAX_SIZE) {
              const firstKey = embeddingCache.keys().next().value;
              embeddingCache.delete(firstKey);
            }
            embeddingCache.set(cacheKey, embedding);
          }
        }
      }

      // Progress callback
      if (onProgress) {
        onProgress(Math.min(batchStart + MAX_BATCH_SIZE, toGenerate.length), toGenerate.length);
      }
    } catch (err) {
      logger.error(`Batch embedding failed at index ${batchStart}:`, err.message);
      // Continue with remaining batches
    }
  }

  return results;
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Similarity score (0-1)
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Find most similar vectors from a list
 * @param {number[]} queryVector - Query embedding
 * @param {Array<{id: string, embedding: number[]}>} candidates - Candidate embeddings
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Minimum similarity threshold
 * @returns {Array<{id: string, similarity: number}>} Sorted results
 */
export function findMostSimilar(queryVector, candidates, topK = 10, threshold = 0) {
  const results = [];

  for (const candidate of candidates) {
    const similarity = cosineSimilarity(queryVector, candidate.embedding);

    if (similarity >= threshold) {
      results.push({
        id: candidate.id,
        similarity,
        ...candidate.metadata
      });
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, topK);
}

/**
 * Get embedding dimension
 */
export function getEmbeddingDimension() {
  return EMBEDDING_DIMENSION;
}

/**
 * Get embedding model name (reflects current provider config).
 */
export function getEmbeddingModel() {
  return getCurrentEmbedModel();
}

/**
 * Clear embedding cache
 */
export function clearEmbeddingCache() {
  embeddingCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    size: embeddingCache.size,
    maxSize: CACHE_MAX_SIZE
  };
}
