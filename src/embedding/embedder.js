import { GoogleGenAI } from "@google/genai";
import { embedLogger as logger } from "../utils/logger.js";
import { recordTokenUsage } from "../utils/tokenTracker.js";

/**
 * Embedding generation using Google Gemini
 */

// Embedding model configuration
// Available model: "gemini-embedding-001"
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIMENSION = 3072; // gemini-embedding-001 uses 3072 dimensions
const MAX_BATCH_SIZE = 100;
const MAX_INPUT_LENGTH = 2048; // Characters

// Check if embeddings are disabled
const EMBEDDINGS_DISABLED = process.env.DISABLE_EMBEDDINGS === "true";

// Log configuration on load
logger.info(`Embedding model: ${EMBEDDING_MODEL}`);
logger.info(`Embeddings disabled: ${EMBEDDINGS_DISABLED}`);

// Simple in-memory cache
const embeddingCache = new Map();
const CACHE_MAX_SIZE = 1000;

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // ms between requests

// Cached client
let cachedClient = null;

/**
 * Get Gemini client
 */
function getClient() {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
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

  const ai = getClient();

  try {
    await rateLimitWait();

    // Use ai.models.embedContent with the model name
    const result = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: [{ parts: [{ text: normalizedText }] }]
    });

    // Track token usage (embeddings count tokens differently)
    recordTokenUsage(result, 'embedding', { model: EMBEDDING_MODEL, text_length: normalizedText.length });

    // Extract embedding from response
    const embedding = result?.embedding?.values || result?.embeddings?.[0]?.values;

    if (!embedding || !Array.isArray(embedding)) {
      logger.error("Invalid embedding response format:", JSON.stringify(result));
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
  const ai = getClient();

  for (let batchStart = 0; batchStart < toGenerate.length; batchStart += MAX_BATCH_SIZE) {
    const batch = toGenerate.slice(batchStart, batchStart + MAX_BATCH_SIZE);

    try {
      // Generate embeddings one at a time
      for (const item of batch) {
        await rateLimitWait();
        const result = await ai.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: [{ parts: [{ text: item.text }] }]
        });
        const embedding = result?.embedding?.values || result?.embeddings?.[0]?.values;

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
 * Get embedding model name
 */
export function getEmbeddingModel() {
  return EMBEDDING_MODEL;
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
