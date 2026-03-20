/**
 * Gap Detector
 *
 * Detects knowledge gaps and suggests KB expansion.
 * Combines low-confidence + low-rating queries to compute gap severity.
 * Severity = frequency × (3 - avg_rating) × (1 - avg_confidence)
 */

import { db } from "../db/db.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { logger } from "../utils/logger.js";

/**
 * Detect knowledge gaps from feedback and query patterns.
 * @param {number} days - Look-back window (default 30)
 * @returns {Array<{ query: string, frequency: number, avg_rating: number, severity: number, topic_terms: string[] }>}
 */
export function detectKnowledgeGaps(days = 30) {
  const safeDays = Math.max(1, Math.floor(Number(days)));
  try {
    // Get poorly-rated queries with frequency
    const gaps = db.prepare(`
      SELECT query,
             COUNT(*) as frequency,
             AVG(rating) as avg_rating,
             GROUP_CONCAT(DISTINCT query_type) as query_types,
             GROUP_CONCAT(node_ids_json, '|') as all_node_ids
      FROM feedback
      WHERE created_at > datetime('now', '-' || ? || ' days')
        AND rating <= 2
      GROUP BY query
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC
      LIMIT 50
    `).all(safeDays);

    return gaps.map(gap => {
      const avgRating = gap.avg_rating ?? 2;
      // Severity: higher = more urgent gap
      const severity = gap.frequency * (3 - avgRating);

      // Extract topic terms from query
      const topicTerms = gap.query.toLowerCase()
        .replace(/[?？。.!！,，]/g, '')
        .split(/\s+/)
        .filter(t => t.length > 2)
        .slice(0, 8);

      // Find related nodes from feedback
      let relatedNodeIds = [];
      try {
        const nodeJsons = (gap.all_node_ids || '').split('|').filter(Boolean);
        for (const json of nodeJsons) {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) relatedNodeIds.push(...parsed);
        }
        relatedNodeIds = [...new Set(relatedNodeIds)].slice(0, 10);
      } catch (_) { /* ignore parse errors */ }

      return {
        query: gap.query,
        frequency: gap.frequency,
        avg_rating: Math.round(avgRating * 100) / 100,
        severity: Math.round(severity * 100) / 100,
        query_types: gap.query_types,
        topic_terms: topicTerms,
        related_node_ids: relatedNodeIds
      };
    }).sort((a, b) => b.severity - a.severity);
  } catch (err) {
    logger.warn(`detectKnowledgeGaps failed: ${err.message}`);
    return [];
  }
}

/**
 * Suggest documents to ingest based on knowledge gaps.
 * Cross-references gap topics with existing nodes and documents.
 * @returns {Array<{ suggestion: string, gap_queries: string[], coverage: string }>}
 */
export function suggestDocumentsToIngest() {
  try {
    const gaps = detectKnowledgeGaps(60);
    if (gaps.length === 0) return [];

    // Get existing node names for cross-referencing
    const nodes = db.prepare(`SELECT name FROM nodes`).all();
    const nodeNames = new Set(nodes.map(n => n.name.toLowerCase()));

    // Get existing document titles
    const docs = db.prepare(`SELECT DISTINCT doc_title FROM chunks WHERE doc_title IS NOT NULL`).all();
    const docTitles = new Set(docs.map(d => d.doc_title.toLowerCase()));

    const suggestions = [];
    const seenTopics = new Set();

    for (const gap of gaps) {
      // Find topic terms not covered by existing nodes
      const uncoveredTerms = gap.topic_terms.filter(term =>
        ![...nodeNames].some(name => name.includes(term))
      );

      if (uncoveredTerms.length === 0) continue;

      const topicKey = uncoveredTerms.sort().join(' ');
      if (seenTopics.has(topicKey)) continue;
      seenTopics.add(topicKey);

      // Check if any existing doc covers this topic
      const hasExistingDoc = uncoveredTerms.some(term =>
        [...docTitles].some(title => title.includes(term))
      );

      suggestions.push({
        suggestion: `Add documentation covering: ${uncoveredTerms.join(', ')}`,
        gap_queries: [gap.query],
        severity: gap.severity,
        coverage: hasExistingDoc
          ? 'Partially covered — existing docs may need updates'
          : 'Not covered — new documentation needed',
        uncovered_terms: uncoveredTerms
      });
    }

    return suggestions.sort((a, b) => b.severity - a.severity).slice(0, 10);
  } catch (err) {
    logger.warn(`suggestDocumentsToIngest failed: ${err.message}`);
    return [];
  }
}
