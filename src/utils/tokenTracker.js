/**
 * Token Usage Tracker
 *
 * Tracks token consumption across all LLM API calls.
 */

import { db } from "../db/db.js";

// Initialize token tracking table
export function initTokenTrackingTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      cost_estimate REAL DEFAULT 0,
      metadata_json TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_operation ON token_usage(operation);
  `);
}

// Initialize on module load
initTokenTrackingTable();

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

    db.prepare(`
      INSERT INTO token_usage (model, operation, input_tokens, output_tokens, total_tokens, cached_tokens, cost_estimate, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      model,
      operation,
      inputTokens,
      outputTokens,
      totalTokens,
      cachedTokens,
      costEstimate,
      JSON.stringify(metadata)
    );

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

  let whereClause = '1=1';
  const params = [];

  if (since) {
    whereClause += ' AND timestamp >= ?';
    params.push(since);
  }
  if (operation) {
    whereClause += ' AND operation = ?';
    params.push(operation);
  }
  if (model) {
    whereClause += ' AND model = ?';
    params.push(model);
  }

  // Overall totals
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(cached_tokens) as total_cached_tokens,
      SUM(cost_estimate) as total_cost
    FROM token_usage
    WHERE ${whereClause}
  `).get(...params);

  // By operation
  const byOperation = db.prepare(`
    SELECT
      operation,
      COUNT(*) as calls,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(cost_estimate) as cost
    FROM token_usage
    WHERE ${whereClause}
    GROUP BY operation
    ORDER BY total_tokens DESC
  `).all(...params);

  // By model
  const byModel = db.prepare(`
    SELECT
      model,
      COUNT(*) as calls,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(cost_estimate) as cost
    FROM token_usage
    WHERE ${whereClause}
    GROUP BY model
    ORDER BY total_tokens DESC
  `).all(...params);

  // Recent usage (last 24 hours by hour)
  const recentUsage = db.prepare(`
    SELECT
      strftime('%Y-%m-%d %H:00', timestamp) as hour,
      SUM(total_tokens) as tokens,
      SUM(cost_estimate) as cost,
      COUNT(*) as calls
    FROM token_usage
    WHERE timestamp >= datetime('now', '-24 hours')
    GROUP BY hour
    ORDER BY hour DESC
    LIMIT 24
  `).all();

  // Today's usage
  const today = db.prepare(`
    SELECT
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(cost_estimate) as cost,
      COUNT(*) as calls
    FROM token_usage
    WHERE date(timestamp) = date('now')
  `).get();

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
  const result = db.prepare(`
    DELETE FROM token_usage
    WHERE timestamp < datetime('now', '-' || ? || ' days')
  `).run(daysToKeep);

  return result.changes;
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
