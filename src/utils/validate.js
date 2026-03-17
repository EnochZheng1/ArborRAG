/**
 * Input validation helpers for route handlers.
 *
 * All validators throw a ValidationError (from apiError.js) on failure,
 * which the global error handler converts to a 400 JSON response.
 */

import { ValidationError } from './apiError.js';

/**
 * Ensure all listed fields are present and non-empty in `body`.
 * @param {object} body   - req.body
 * @param {...string} fields - required field names
 * @throws {ApiError} ValidationError if any field is missing or empty
 */
export function requireBody(body, ...fields) {
  if (!body || typeof body !== 'object') {
    throw ValidationError('Request body is required');
  }
  const missing = fields.filter(f => {
    const v = body[f];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  });
  if (missing.length > 0) {
    throw ValidationError(
      `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      { missing }
    );
  }
}

/**
 * Ensure all listed fields are present and non-empty in `query`.
 * @param {object} query  - req.query
 * @param {...string} fields - required query param names
 * @throws {ApiError} ValidationError if any param is missing or empty
 */
export function requireQuery(query, ...fields) {
  const missing = fields.filter(f => {
    const v = query?.[f];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  });
  if (missing.length > 0) {
    throw ValidationError(
      `Missing required query parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      { missing }
    );
  }
}

/**
 * Parse a value as an integer and clamp it within [min, max].
 * Returns `fallback` if the value is not a valid integer.
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
