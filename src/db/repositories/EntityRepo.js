/**
 * Entity / fact repository — entities, facts, entity_facts, fact_evidence,
 * entity_mentions tables.
 */

import { db } from "../db.js";

export const EntityRepo = {
  // ── Entity lookups (basic) ─────────────────────────────────────────────────

  /** Exact match on normalized_name. */
  findByNormalized(name) {
    return db.prepare("SELECT * FROM entities WHERE normalized_name = ?").get(name) ?? null;
  },

  /** Partial LIKE match on normalized_name or display name. Returns shortest match. */
  findByLike(normalized, original) {
    return db.prepare(`
      SELECT * FROM entities
      WHERE normalized_name LIKE ? OR name LIKE ?
      ORDER BY LENGTH(name)
      LIMIT 1
    `).get(`%${normalized}%`, `%${original}%`) ?? null;
  },

  /** Match on aliases_json string content. */
  findByAlias(name) {
    return db.prepare(
      "SELECT * FROM entities WHERE aliases_json LIKE ? LIMIT 1"
    ).get(`%${name}%`) ?? null;
  },

  /** Total entity count (for stats). */
  countAll() {
    return db.prepare("SELECT COUNT(*) as count FROM entities").get()?.count ?? 0;
  },

  // ── Entity lookups (enhanced — with mention_count) ─────────────────────────

  /**
   * Exact match returning ALL matching rows with mention_count.
   * Used by enhancedRetrieval's findMatchingEntities (may return multiple rows).
   */
  searchExact(name, normalized) {
    return db.prepare(`
      SELECT e.*,
             (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = e.id) as mention_count
      FROM entities e
      WHERE e.name = ? OR e.normalized_name = ?
    `).all(name, normalized);
  },

  /** Fuzzy LIKE match with mention_count for scoring. */
  searchFuzzy(name, limit = 20) {
    return db.prepare(`
      SELECT e.*,
             (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = e.id) as mention_count
      FROM entities e
      WHERE e.name LIKE ? OR e.normalized_name LIKE ?
      LIMIT ?
    `).all(`%${name}%`, `%${name.toLowerCase()}%`, limit);
  },

  /** Alias LIKE match with mention_count for scoring. */
  searchByAliasWithCount(name, limit = 20) {
    return db.prepare(`
      SELECT e.*,
             (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = e.id) as mention_count
      FROM entities e
      WHERE e.aliases_json LIKE ?
      LIMIT ?
    `).all(`%${name}%`, limit);
  },

  // ── Chunk retrieval via entity mentions ────────────────────────────────────

  /** Active chunks that mention the given entity IDs, with entity and node metadata. */
  getChunksByEntityIds(entityIds, limit = 30) {
    if (!entityIds.length) return [];
    const ph = entityIds.map(() => "?").join(",");
    return db.prepare(`
      SELECT DISTINCT c.*,
             em.context_snippet as mention_context,
             em.mention_count,
             e.name as entity_name,
             e.type as entity_type,
             n.name as node_name,
             n.node_id,
             n.level as node_level
      FROM entity_mentions em
      JOIN entities e ON em.entity_id = e.id
      JOIN chunks c ON em.chunk_id = c.id
      LEFT JOIN nodes n ON c.node_id = n.node_id
      WHERE em.entity_id IN (${ph})
        AND c.status = 'active'
      ORDER BY em.mention_count DESC, c.authority_level ASC
      LIMIT ?
    `).all(...entityIds, limit);
  },

  // ── Fact lookups ──────────────────────────────────────────────────────────────

  /** Active facts for an entity, ordered by confidence descending. */
  getFactsByEntityId(entityId, limit = 10) {
    return db.prepare(`
      SELECT f.*, ef.role
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      WHERE ef.entity_id = ? AND f.status = 'active'
      ORDER BY f.confidence DESC
      LIMIT ?
    `).all(entityId, limit);
  },

  /**
   * Fact search with pre-built OR conditions string.
   * @param {string} conditions - SQL condition string e.g. "f.content LIKE ? OR f.content LIKE ?"
   * @param {string[]} params   - values for the condition placeholders
   */
  searchFacts(conditions, params, minConfidence, limit) {
    return db.prepare(`
      SELECT f.*,
             e.name as subject_name,
             e.type as subject_type,
             (SELECT COUNT(*) FROM fact_evidence WHERE fact_id = f.id) as evidence_count
      FROM facts f
      LEFT JOIN entity_facts ef ON f.id = ef.fact_id
      LEFT JOIN entities e ON ef.entity_id = e.id
      WHERE (${conditions})
        AND f.confidence >= ?
      ORDER BY f.confidence DESC, evidence_count DESC
      LIMIT ?
    `).all(...params, minConfidence, limit);
  },

  /** Total fact count (for stats). */
  countFacts() {
    return db.prepare("SELECT COUNT(*) as count FROM facts").get()?.count ?? 0;
  },

  // ── Evidence lookups ──────────────────────────────────────────────────────────

  /** Source chunks that support a set of fact IDs, ordered by extraction confidence. */
  getEvidenceForFacts(factIds) {
    if (!factIds || factIds.length === 0) return [];
    const placeholders = factIds.map(() => "?").join(",");
    return db.prepare(`
      SELECT DISTINCT c.id, c.content_clean, c.doc_title, c.node_id,
             fe.fact_id, fe.extraction_confidence
      FROM fact_evidence fe
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE fe.fact_id IN (${placeholders})
      ORDER BY fe.extraction_confidence DESC
    `).all(...factIds);
  },

  /** Evidence chunks for a single fact, ordered by relevance_score. */
  getEvidenceForFact(factId, limit = 3) {
    return db.prepare(`
      SELECT c.id, c.content_clean, c.doc_title, c.node_id,
             fe.relevance_score
      FROM fact_evidence fe
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE fe.fact_id = ?
      ORDER BY fe.relevance_score DESC
      LIMIT ?
    `).all(factId, limit);
  },

  /** Count of distinct documents that have at least one extracted fact (for stats). */
  countDocumentsExtracted() {
    try {
      return db.prepare(`
        SELECT COUNT(DISTINCT document_id) as count
        FROM chunks c
        JOIN fact_evidence fe ON c.id = fe.chunk_id
      `).get()?.count ?? 0;
    } catch {
      return 0;
    }
  },

  // ── Multi-hop entity discovery ────────────────────────────────────────────────

  /**
   * Entities related to the given seed entities through shared facts,
   * excluding the seeds themselves. Used for multi-hop retrieval.
   */
  getRelatedEntities(entityIds, limit = 5) {
    if (!entityIds.length) return [];
    const ph = entityIds.map(() => "?").join(",");
    return db.prepare(`
      SELECT DISTINCT e2.id, e2.name, e2.entity_type,
             COUNT(*) as shared_facts
      FROM entity_facts ef1
      JOIN entity_facts ef2 ON ef1.fact_id = ef2.fact_id
      JOIN entities e2 ON ef2.entity_id = e2.id
      WHERE ef1.entity_id IN (${ph})
        AND e2.id NOT IN (${ph})
      GROUP BY e2.id
      ORDER BY shared_facts DESC
      LIMIT ?
    `).all(...entityIds, ...entityIds, limit);
  }
};
