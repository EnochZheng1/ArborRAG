/**
 * Centralized Query Helper Utilities
 *
 * Shared patterns for query analysis used across reranker, hierarchicalRetrieval,
 * and queryHandlers. Consolidates duplicated regex patterns and helper functions.
 */

// Numeric query detection (used in 3+ files)
export const NUMERIC_QUERY_RE = /\bhow many\b|\bhow much\b|\bhow often\b|\bhow long\b|\bwhat percentage\b|\bwhat rate\b|\bcount\b|\bnumber of\b|\btotal\b|\baverage\b|\bminimum\b|\bmaximum\b|多少|几天|几个|多长/i;

export function isNumericQuery(query) {
  return NUMERIC_QUERY_RE.test(query);
}

// Negation detection (used in reranker)
export const NEGATION_RE = /\b(?:not|no|never|neither|nor|except|excluding|without|don't|doesn't|didn't|won't|can't|cannot|shouldn't)\b|除了/i;

export function extractNegatedTerms(query) {
  const negPatterns = [
    /\b(?:not|except|excluding|other\s+than|besides|without|除了|不包括|排除)\s+([a-z\u4e00-\u9fa5\s]+?)(?:\s*[,.\?!]|\s+(?:and|or|what|which|how|do|is|are|can|will|does|the)|\s*$)/gi,
  ];
  const terms = [];
  for (const re of negPatterns) {
    let m;
    while ((m = re.exec(query))) {
      const term = m[1].toLowerCase().trim();
      if (term.length >= 2) terms.push(term);
    }
  }
  return terms;
}

// Entity/company detection for doc-scope filtering
export function extractQueryEntities(query) {
  // Extract capitalized multi-word terms (likely proper nouns)
  const entities = [];
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  let m;
  while ((m = re.exec(query))) {
    if (m[1].length >= 3) entities.push(m[1]);
  }
  return entities;
}

// Check if chunk content contains numbers/quantities
export function hasNumericContent(text) {
  return /\d+(?:\.\d+)?(?:\s*(?:%|percent|年|天|日|月|hours?|days?|weeks?|months?|years?|USD|RMB|元|¥|\$|€))/i.test(text);
}
