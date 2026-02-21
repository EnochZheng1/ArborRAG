/**
 * Token Usage Tracker
 *
 * Tracks token consumption across all LLM API calls.
 */

import { TokenRepo } from "../db/repositories/TokenRepo.js";

// Note: initTokenTrackingTable() is called by initDatasetDb() for each dataset connection.
export function initTokenTrackingTable() {
  // Table is initialized by initDatasetDb() for each dataset connection.
}

/**
 * Record token usage from an API response
 * @param {object} response - The API response object
 * @param {string} operation - The operation type (e.g., 'qa', 'extraction', 'embedding')
 * @param {object} metadata - Additional metadata
 */
export function recordTokenUsage(response, operation, metadata = {}) {
  try {
    const usageMetadata = response?.usageMetadata || response?.usage || {};

    const inputTokens = usageMetadata.promptTokenCount || usageMetadata.input_tokens || 0;
    const outputTokens = usageMetadata.candidatesTokenCount || usageMetadata.output_tokens || 0;
    const cachedTokens = usageMetadata.cachedContentTokenCount || 0;
    const totalTokens = usageMetadata.totalTokenCount || (inputTokens + outputTokens);

    // Get model from metadata or default
    const model = metadata.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';

    // Estimate cost (approximate pricing)
    const costEstimate = estimateCost(model, inputTokens, outputTokens, cachedTokens);

    TokenRepo.record({ model, operation, inputTokens, outputTokens, totalTokens, cachedTokens, costEstimate, metadata });

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cached_tokens: cachedTokens,
      cost_estimate: costEstimate
    };
  } catch (error) {
    console.error('Failed to record token usage:', error.message);
    return null;
  }
}

/**
 * Estimate cost based on model and token counts
 * Prices are approximate and may need updating
 */
function estimateCost(model, inputTokens, outputTokens, cachedTokens = 0) {
  // Pricing per 1M tokens (approximate as of 2024)
  const pricing = {
    'gemini-2.0-flash': { input: 0.075, output: 0.30, cached: 0.01875 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30, cached: 0.01875 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00, cached: 0.3125 },
    'gemini-pro': { input: 0.50, output: 1.50, cached: 0.125 },
    'text-embedding-004': { input: 0.00, output: 0.00, cached: 0.00 } // Embedding is free/different pricing
  };

  const modelPricing = pricing[model] || pricing['gemini-2.0-flash'];

  const inputCost = ((inputTokens - cachedTokens) / 1_000_000) * modelPricing.input;
  const cachedCost = (cachedTokens / 1_000_000) * modelPricing.cached;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + cachedCost + outputCost;
}

/**
 * Get token usage statistics
 * @param {object} options - Filter options
 * @returns {object} Usage statistics
 */
export function getTokenStats(options = {}) {
  const { since, operation, model } = options;
  const { totals, byOperation, byModel, recentUsage, today } = TokenRepo.getStats({ since, operation, model });

  return {
    totals: {
      calls: totals.total_calls || 0,
      input_tokens: totals.total_input_tokens || 0,
      output_tokens: totals.total_output_tokens || 0,
      total_tokens: totals.total_tokens || 0,
      cached_tokens: totals.total_cached_tokens || 0,
      cost_estimate: totals.total_cost || 0
    },
    today: {
      calls: today?.calls || 0,
      input_tokens: today?.input_tokens || 0,
      output_tokens: today?.output_tokens || 0,
      total_tokens: today?.total_tokens || 0,
      cost_estimate: today?.cost || 0
    },
    by_operation: byOperation,
    by_model: byModel,
    recent_hourly: recentUsage
  };
}

/**
 * Clear old token usage records
 * @param {number} daysToKeep - Number of days of history to retain
 */
export function cleanupTokenHistory(daysToKeep = 30) {
  return TokenRepo.cleanup(daysToKeep);
}

/**
 * Helper to wrap LLM calls and automatically track tokens
 * @param {Function} llmCall - Async function that makes the LLM call
 * @param {string} operation - Operation name for tracking
 * @param {object} metadata - Additional metadata
 * @returns {Promise<object>} The LLM response
 */
export async function trackLLMCall(llmCall, operation, metadata = {}) {
  const response = await llmCall();
  recordTokenUsage(response, operation, metadata);
  return response;
}
