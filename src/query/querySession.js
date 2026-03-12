/**
 * Query Session Tracker
 *
 * Stores the last N queries per dataset for follow-up query detection.
 * When a query looks like a follow-up ("tell me more", "what about X", etc.),
 * expands it with context from the previous query.
 */

import { getActiveDatasetId } from "../db/activeDb.js";

const SESSION_SIZE = 3;   // keep last 3 queries per dataset
const SESSION_TTL  = 10 * 60 * 1000;  // 10-minute idle timeout

// Map<datasetId, { queries: string[], updatedAt: number }>
const _sessions = new Map();

const FOLLOW_UP_PATTERNS = [
  /^tell me more$/i,
  /^(more|elaborate|continue|go on|expand|details?)$/i,
  /^what about\b/i,
  /^how about\b/i,
  /^and (what|how|their|the|its)\b/i,
  /^also\b/i,
  /^can you (also|explain|clarify)\b/i,
  /^(还有|继续|更多|详细|那么|另外)\b/,
];

/**
 * Detect whether a query is a follow-up to the previous query.
 */
function isFollowUp(query) {
  const q = query.trim();
  if (q.length > 100) return false;   // long queries are self-contained
  return FOLLOW_UP_PATTERNS.some(p => p.test(q));
}

/**
 * Record a query in the session history.
 * @param {string} query
 */
export function recordQuerySession(query) {
  const datasetId = getActiveDatasetId() || '__default__';
  let session = _sessions.get(datasetId);
  if (!session) {
    session = { queries: [], updatedAt: Date.now() };
    _sessions.set(datasetId, session);
  }
  session.queries.push(query);
  if (session.queries.length > SESSION_SIZE) {
    session.queries.shift();
  }
  session.updatedAt = Date.now();
}

/**
 * Get the previous query from session history (if recent enough).
 * @returns {string|null}
 */
function getPreviousQuery() {
  const datasetId = getActiveDatasetId() || '__default__';
  const session = _sessions.get(datasetId);
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL) {
    _sessions.delete(datasetId);
    return null;
  }
  // Return the last query (the one before the current one will be recorded)
  return session.queries.length > 0 ? session.queries[session.queries.length - 1] : null;
}

/**
 * Expand a follow-up query with previous query context.
 * Returns { expanded: string, wasFollowUp: boolean, previousQuery: string|null }.
 */
export function expandFollowUpQuery(query) {
  if (!isFollowUp(query)) {
    return { expanded: query, wasFollowUp: false, previousQuery: null };
  }

  const prev = getPreviousQuery();
  if (!prev) {
    return { expanded: query, wasFollowUp: false, previousQuery: null };
  }

  // For "tell me more" / "more details" — reuse the previous query directly
  if (/^(tell me more|more|elaborate|continue|go on|expand|details?|还有|继续|更多|详细)$/i.test(query.trim())) {
    return {
      expanded: prev,
      wasFollowUp: true,
      previousQuery: prev
    };
  }

  // For "what about X" / "how about X" — prepend context
  const expanded = `${query} (in the context of: ${prev})`;
  return {
    expanded,
    wasFollowUp: true,
    previousQuery: prev
  };
}
