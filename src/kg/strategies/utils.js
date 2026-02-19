/**
 * Shared utility functions for retrieval strategies.
 */

import { detectLanguage } from "../../utils/langDetect.js";

const CJK_CHAR_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const CJK_SEQUENCE_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

export function extractCjkNgrams(sequence, minN = 2, maxN = 3, maxTerms = 24) {
  if (!sequence) return [];
  const chars = [...sequence].filter(ch => CJK_CHAR_REGEX.test(ch));
  if (chars.length === 0) return [];

  const terms = [];
  if (chars.length >= 2) terms.push(chars.join(""));

  const upper = Math.min(maxN, chars.length);
  for (let n = minN; n <= upper; n++) {
    for (let i = 0; i <= chars.length - n; i++) {
      terms.push(chars.slice(i, i + n).join(""));
      if (terms.length >= maxTerms) return terms;
    }
  }
  return terms;
}

export function extractSearchTerms(query, options = {}) {
  const { maxTerms = 32, includeSingleCjk = false } = options;
  if (!query || typeof query !== "string") return [];
  const normalized = query.toLowerCase().trim();
  if (!normalized) return [];

  const terms = [];
  const seen = new Set();
  const addTerm = (term) => {
    const value = String(term || "").trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    terms.push(value);
    return terms.length < maxTerms;
  };

  const latinTokens = normalized.match(/[a-z0-9]{2,}/g) || [];
  for (const token of latinTokens) if (!addTerm(token)) return terms;

  const spaceTokens = normalized.split(/\s+/).map(t => t.trim()).filter(Boolean);
  for (const token of spaceTokens) {
    if (CJK_CHAR_REGEX.test(token)) continue;
    if (/[a-z0-9]/.test(token)) continue;
    if (token.length >= 2 && !addTerm(token)) return terms;
  }

  const cjkSequences = normalized.match(CJK_SEQUENCE_REGEX) || [];
  for (const sequence of cjkSequences) {
    const grams = extractCjkNgrams(sequence, 2, 3, maxTerms);
    for (const gram of grams) if (!addTerm(gram)) return terms;
    if (includeSingleCjk && sequence.length <= 8) {
      for (const ch of sequence) if (!addTerm(ch)) return terms;
    }
  }

  return terms;
}

export function escapeFtsQuery(query) {
  const terms = extractSearchTerms(query, { maxTerms: 24 });
  if (terms.length === 0) return '""';
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function normalizeByMax(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export function normalizeVariantText(text) {
  return String(text || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function addQueryVariant(list, seen, text, weight, source) {
  const normalized = normalizeVariantText(text);
  if (!normalized) return;

  const dedupeKey = normalized.toLowerCase();
  if (seen.has(dedupeKey)) {
    const existing = list.find(v => v.key === dedupeKey);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
    return;
  }

  seen.add(dedupeKey);
  list.push({
    key: dedupeKey,
    text: normalized,
    weight: Math.max(0.3, Math.min(1.0, weight)),
    lang: detectLanguage(normalized),
    sources: [source]
  });
}

export function reciprocalRankFusion(rankings, k = 60) {
  const scores = new Map();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank++) {
      const item = ranking[rank];
      const rrfScore = 1 / (k + rank + 1);
      scores.set(item.id, (scores.get(item.id) || 0) + rrfScore);
    }
  }
  return scores;
}
