/**
 * RateLimitError — thrown when an LLM API call is rejected with HTTP 429
 * (Resource Exhausted / Quota Exceeded). Propagates up through all fallback
 * catch blocks so the job queue can pause the job instead of failing it.
 */
export class RateLimitError extends Error {
  constructor(message, originalError = null) {
    super(message);
    this.name = 'RateLimitError';
    this.originalError = originalError;
  }
}

/**
 * Returns true if the error looks like an API rate-limit / quota error.
 */
export function isRateLimitError(err) {
  const msg = String(err?.message || err || '');
  return /429|resource.?exhausted|rate.?limit|quota.?exceed/i.test(msg);
}

/**
 * Re-throws the error as a RateLimitError if it is a rate-limit error.
 * Call this at the TOP of every LLM catch block, before any fallback logic,
 * so 429 errors are never silently swallowed.
 */
export function rethrowIfRateLimit(err) {
  if (isRateLimitError(err)) {
    throw new RateLimitError(err.message, err);
  }
}
