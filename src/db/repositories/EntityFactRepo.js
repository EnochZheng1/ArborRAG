/**
 * EntityFact repository — SQL for entity/fact extraction, storage, and querying.
 * Used exclusively by entityFactExtractor.js.
 * Retrieval-side entity queries live in EntityRepo.js.
 */

import { db } from "../db.js";

export const EntityFactRepo = {
  // ── Entity reads ──────────────────────────────────────────────────────────────

  /** Find entity by normalized name AND type (for deduplication). Returns {id, aliases_json} or null. */
  findByNormalizedAndType(normalizedName, type) {
    return db.prepare(
      "SELECT id, aliases_json FROM entities WHERE normalized_name = ? AND type = ?"
    ).get(normalizedName, type) ?? null;
  },

  /** Find entity by exact normalized name. Returns full row or null. */
  findByNormalized(normalizedName) {
    return db.prepare("SELECT * FROM entities WHERE normalized_name = ?").get(normalizedName) ?? null;
  },

  /** Partial-match lookup: LIKE on normalized_name or aliases_json. Returns first match or null. */
  findByPartialMatch(normalizedName, originalName) {
    return db.prepare(
      "SELECT * FROM entities WHERE normalized_name LIKE ? OR aliases_json LIKE ? ORDER BY id LIMIT 1"
    ).get(`%${normalizedName}%`, `%${originalName}%`) ?? null;
  },

  /** Single entity row by id. */
  findById(entityId) {
    return db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId) ?? null;
  },

  /** Most-recently inserted entities (for deduplication hints during extraction). */
  getRecent(limit = 50) {
    return db.prepare("SELECT name, type FROM entities ORDER BY id DESC LIMIT ?").all(limit);
  },

  // ── Entity writes ─────────────────────────────────────────────────────────────

  /** Update aliases_json for an existing entity. */
  updateAliases(entityId, aliasesJson) {
    return db.prepare(
      "UPDATE entities SET aliases_json = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(aliasesJson, entityId);
  },

  /** Insert a new entity. Returns the run() result (has lastInsertRowid). */
  insertEntity({ name, normalizedName, type, description, nodeId, aliasesJson }) {
    return db.prepare(`
      INSERT INTO entities (name, normalized_name, type, description, node_id, aliases_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, normalizedName, type, description ?? null, nodeId ?? null, aliasesJson);
  },

  /** Set entity.node_id. */
  linkToNode(entityId, nodeId) {
    return db.prepare(
      "UPDATE entities SET node_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(nodeId, entityId);
  },

  // ── Entity-mention writes ─────────────────────────────────────────────────────

  /** Upsert an entity mention for a chunk (increments mention_count on conflict). */
  upsertMention(entityId, chunkId) {
    return db.prepare(`
      INSERT INTO entity_mentions (entity_id, chunk_id, mention_count)
      VALUES (?, ?, 1)
      ON CONFLICT(entity_id, chunk_id) DO UPDATE SET mention_count = mention_count + 1
    `).run(entityId, chunkId);
  },

  // ── Fact reads ────────────────────────────────────────────────────────────────

  /** Find a fact by exact content string. Returns {id} or null. */
  findFactByContent(content) {
    return db.prepare("SELECT id FROM facts WHERE content = ?").get(content) ?? null;
  },

  // ── Fact writes ───────────────────────────────────────────────────────────────

  /** Insert a new fact. Returns run() result. */
  insertFact({ content, factType, confidence, attributeName = null }) {
    return db.prepare(
      "INSERT INTO facts (content, fact_type, confidence, attribute_name) VALUES (?, ?, ?, ?)"
    ).run(content, factType, confidence, attributeName);
  },

  /** Link an entity to a fact (INSERT OR IGNORE). */
  insertEntityFactLink(entityId, factId) {
    return db.prepare(
      "INSERT OR IGNORE INTO entity_facts (entity_id, fact_id, role) VALUES (?, ?, 'subject')"
    ).run(entityId, factId);
  },

  /** Record a chunk as evidence for a fact (INSERT OR IGNORE). */
  insertFactEvidence(factId, chunkId, confidence) {
    return db.prepare(
      "INSERT OR IGNORE INTO fact_evidence (fact_id, chunk_id, extraction_confidence) VALUES (?, ?, ?)"
    ).run(factId, chunkId, confidence);
  },

  // ── Chunk reads (for extraction pipeline) ────────────────────────────────────

  /** All active chunks for a document, ordered by chunk_index. */
  getActiveChunksForDoc(docId) {
    return db.prepare(`
      SELECT id, content_clean, node_id, doc_title
      FROM chunks
      WHERE document_id = ? AND status = 'active'
      ORDER BY chunk_index
    `).all(docId);
  },

  /** Single active chunk row (id, content_clean, node_id, doc_title), or null. */
  getActiveChunk(chunkId) {
    return db.prepare(
      "SELECT id, content_clean, node_id, doc_title FROM chunks WHERE id = ? AND status = 'active'"
    ).get(chunkId) ?? null;
  },

  // ── getEntitiesWithFacts ──────────────────────────────────────────────────────

  /**
   * Entities with fact_count and mention_count, filtered by type and/or nodeId.
   * @param {object} filters - { type?, nodeId?, limit }
   */
  getEntitiesFiltered({ type, nodeId, limit = 50 }) {
    const conditions = ["1=1"];
    const params = [];
    if (type)   { conditions.push("e.type = ?");   params.push(type); }
    if (nodeId) { conditions.push("e.node_id = ?"); params.push(nodeId); }
    params.push(limit);
    return db.prepare(`
      SELECT e.*,
             COUNT(DISTINCT ef.fact_id) as fact_count,
             COUNT(DISTINCT em.chunk_id) as mention_count
      FROM entities e
      LEFT JOIN entity_facts ef ON e.id = ef.entity_id
      LEFT JOIN entity_mentions em ON e.id = em.entity_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY e.id
      ORDER BY mention_count DESC, fact_count DESC
      LIMIT ?
    `).all(...params);
  },

  /** Facts with evidence info for a single entity (for getEntitiesWithFacts enrichment). */
  getFactsForEntityWithEvidence(entityId) {
    return db.prepare(`
      SELECT f.*, fe.chunk_id, fe.extraction_confidence
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      LEFT JOIN fact_evidence fe ON f.id = fe.fact_id
      WHERE ef.entity_id = ? AND f.status = 'active'
      ORDER BY f.confidence DESC
    `).all(entityId);
  },

  // ── getEntityFactsById ────────────────────────────────────────────────────────

  /** Facts with role for a single entity (active only). */
  getEntityFullFacts(entityId) {
    return db.prepare(`
      SELECT f.*, ef.role
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      WHERE ef.entity_id = ? AND f.status = 'active'
      ORDER BY f.confidence DESC
    `).all(entityId);
  },

  /** Evidence (with chunk content and doc_title) for a single fact. */
  getFactEvidenceWithChunks(factId) {
    return db.prepare(`
      SELECT fe.*, c.content_clean, c.doc_title
      FROM fact_evidence fe
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE fe.fact_id = ?
    `).all(factId);
  },

  /** Entities related to an entity via shared facts (multi-hop). */
  getRelatedEntitiesForEntity(entityId) {
    return db.prepare(`
      SELECT DISTINCT e2.*
      FROM entity_facts ef1
      JOIN entity_facts ef2 ON ef1.fact_id = ef2.fact_id
      JOIN entities e2 ON ef2.entity_id = e2.id
      WHERE ef1.entity_id = ? AND ef2.entity_id != ?
      LIMIT 10
    `).all(entityId, entityId);
  },

  // ── searchFacts ───────────────────────────────────────────────────────────────

  /** Facts matching a LIKE query, with associated entity names concatenated. */
  searchFactsByContent(query, limit = 20) {
    return db.prepare(`
      SELECT f.*, GROUP_CONCAT(DISTINCT e.name) as entity_names
      FROM facts f
      LEFT JOIN entity_facts ef ON f.id = ef.fact_id
      LEFT JOIN entities e ON ef.entity_id = e.id
      WHERE f.content LIKE ? AND f.status = 'active'
      GROUP BY f.id
      ORDER BY f.confidence DESC
      LIMIT ?
    `).all(`%${query}%`, limit);
  },

  /** Up to 3 source chunk previews for a fact. */
  getEvidenceForFact(factId) {
    return db.prepare(`
      SELECT c.id, c.doc_title, c.content_clean
      FROM fact_evidence fe
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE fe.fact_id = ?
      LIMIT 3
    `).all(factId);
  },

  // ── findConflictingFacts ──────────────────────────────────────────────────────

  /** Pairs of facts about the same entity with the same type (potential conflicts). */
  findConflictingFacts() {
    return db.prepare(`
      SELECT
        e.name as entity_name,
        f1.id as fact1_id, f1.content as fact1_content,
        f2.id as fact2_id, f2.content as fact2_content
      FROM entity_facts ef1
      JOIN entity_facts ef2 ON ef1.entity_id = ef2.entity_id AND ef1.fact_id < ef2.fact_id
      JOIN entities e ON ef1.entity_id = e.id
      JOIN facts f1 ON ef1.fact_id = f1.id
      JOIN facts f2 ON ef2.fact_id = f2.id
      WHERE f1.fact_type = f2.fact_type
        AND f1.status = 'active' AND f2.status = 'active'
      LIMIT 50
    `).all();
  },

  // ── getExtractionStats ────────────────────────────────────────────────────────

  getEntityCount() {
    return db.prepare("SELECT COUNT(*) as count FROM entities").get().count;
  },
  getActiveFactCount() {
    return db.prepare("SELECT COUNT(*) as count FROM facts WHERE status = 'active'").get().count;
  },
  getEntityFactLinkCount() {
    return db.prepare("SELECT COUNT(*) as count FROM entity_facts").get().count;
  },
  getFactEvidenceLinkCount() {
    return db.prepare("SELECT COUNT(*) as count FROM fact_evidence").get().count;
  },
  getEntitiesByType() {
    return db.prepare(
      "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC"
    ).all();
  },
  getFactsByType() {
    return db.prepare(
      "SELECT fact_type, COUNT(*) as count FROM facts WHERE status = 'active' GROUP BY fact_type ORDER BY count DESC"
    ).all();
  },
  getTopEntities(limit = 10) {
    return db.prepare(`
      SELECT e.name, e.type, COUNT(ef.fact_id) as fact_count
      FROM entities e
      LEFT JOIN entity_facts ef ON e.id = ef.entity_id
      GROUP BY e.id
      ORDER BY fact_count DESC
      LIMIT ?
    `).all(limit);
  },

  // ── getDocumentsNeedingExtraction ─────────────────────────────────────────────

  /** Documents with fewer than 50% of chunks having fact_evidence. */
  getDocsNeedingExtraction() {
    return db.prepare(`
      SELECT DISTINCT d.id, d.original_name, d.filename, d.status,
             COUNT(DISTINCT c.id) as chunk_count,
             COUNT(DISTINCT fe.chunk_id) as extracted_chunks
      FROM documents d
      JOIN chunks c ON c.document_id = d.id AND c.status = 'active'
      LEFT JOIN fact_evidence fe ON fe.chunk_id = c.id
      WHERE d.status = 'processed'
      GROUP BY d.id
      HAVING extracted_chunks < chunk_count * 0.5
      ORDER BY d.uploaded_at DESC
    `).all();
  },

  // ── getNodeEntitiesAndFacts ───────────────────────────────────────────────────

  /** Primary query: entities linked to a node via entity_mentions + chunks, with counts. */
  getEntitiesForNodePrimary(nodeId, limit) {
    return db.prepare(`
      SELECT e.*,
             COALESCE(mention_stats.mention_count, 0) as mention_count,
             COALESCE(fact_stats.fact_count, 0) as fact_count
      FROM entities e
      LEFT JOIN (
        SELECT em.entity_id, COUNT(DISTINCT em.chunk_id) as mention_count
        FROM entity_mentions em
        JOIN chunks c ON em.chunk_id = c.id
        WHERE c.node_id = ? AND c.status = 'active'
        GROUP BY em.entity_id
      ) mention_stats ON e.id = mention_stats.entity_id
      LEFT JOIN (
        SELECT ef.entity_id, COUNT(DISTINCT ef.fact_id) as fact_count
        FROM entity_facts ef
        GROUP BY ef.entity_id
      ) fact_stats ON e.id = fact_stats.entity_id
      WHERE e.node_id = ? OR mention_stats.entity_id IS NOT NULL
      ORDER BY mention_count DESC, fact_count DESC
      LIMIT ?
    `).all(nodeId, nodeId, limit);
  },

  /** Fallback 1: entities via entity_mentions + chunks (simpler join). */
  getEntitiesForNodeFallback1(nodeId, limit) {
    return db.prepare(`
      SELECT DISTINCT e.*,
             SUM(em.mention_count) as mention_count,
             0 as fact_count
      FROM entities e
      JOIN entity_mentions em ON e.id = em.entity_id
      JOIN chunks c ON em.chunk_id = c.id
      WHERE c.node_id = ? AND c.status = 'active'
      GROUP BY e.id
      ORDER BY mention_count DESC
      LIMIT ?
    `).all(nodeId, limit);
  },

  /** Chunk ids for a node (used to build fallback 2 IN clause). */
  getChunkIdsForNode(nodeId) {
    return db.prepare(
      "SELECT id FROM chunks WHERE node_id = ? AND status = 'active'"
    ).all(nodeId).map(c => c.id);
  },

  /** Fallback 2: entities via fact_evidence → entity_facts for a set of chunk ids. */
  getEntitiesForNodeFallback2(chunkIds, limit) {
    if (!chunkIds.length) return [];
    const ph = chunkIds.map(() => "?").join(",");
    return db.prepare(`
      SELECT DISTINCT e.*, 1 as mention_count,
             COUNT(DISTINCT ef.fact_id) as fact_count
      FROM entities e
      JOIN entity_facts ef ON e.id = ef.entity_id
      JOIN fact_evidence fe ON ef.fact_id = fe.fact_id
      WHERE fe.chunk_id IN (${ph})
      GROUP BY e.id
      ORDER BY fact_count DESC
      LIMIT ?
    `).all(...chunkIds, limit);
  },

  /** Fallback 3 (debug only): first N entities regardless of node. */
  getAllEntitiesForDebug(limit = 10) {
    return db.prepare(
      "SELECT e.*, 0 as mention_count, 0 as fact_count FROM entities e LIMIT ?"
    ).all(limit);
  },

  /** Facts for a node — only facts with evidence in this node's chunks. */
  getFactsForNode(nodeId, limit) {
    return db.prepare(`
      SELECT DISTINCT f.*,
             COALESCE(fe.extraction_confidence, 0.5) as extraction_confidence,
             c.doc_title as source_doc,
             SUBSTR(c.content_clean, 1, 200) as source_excerpt
      FROM facts f
      JOIN fact_evidence fe ON f.id = fe.fact_id
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE f.status = 'active' AND c.node_id = ? AND c.status = 'active'
      ORDER BY f.confidence DESC, extraction_confidence DESC
      LIMIT ?
    `).all(nodeId, limit);
  },

  /** Up to 5 facts for an entity (for entity enrichment in getNodeEntitiesAndFacts). */
  getTopFactsForEntity(entityId) {
    return db.prepare(`
      SELECT f.content, f.fact_type, f.confidence
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      WHERE ef.entity_id = ? AND f.status = 'active'
      ORDER BY f.confidence DESC
      LIMIT 5
    `).all(entityId);
  },

  // ── Debug info queries ────────────────────────────────────────────────────────

  countEntities() {
    return db.prepare("SELECT COUNT(*) as c FROM entities").get().c;
  },
  countMentions() {
    return db.prepare("SELECT COUNT(*) as c FROM entity_mentions").get().c;
  },
  countFacts() {
    return db.prepare("SELECT COUNT(*) as c FROM facts").get().c;
  },
  countEvidence() {
    return db.prepare("SELECT COUNT(*) as c FROM fact_evidence").get().c;
  },
  countEntitiesWithNodeId(nodeId) {
    return db.prepare("SELECT COUNT(*) as c FROM entities WHERE node_id = ?").get(nodeId).c;
  },
  countChunksInNode(nodeId) {
    return db.prepare("SELECT COUNT(*) as c FROM chunks WHERE node_id = ? AND status = 'active'").get(nodeId).c;
  },
  countMentionsForNodeChunks(nodeId) {
    return db.prepare(`
      SELECT COUNT(*) as c
      FROM entity_mentions em
      JOIN chunks c ON em.chunk_id = c.id
      WHERE c.node_id = ? AND c.status = 'active'
    `).get(nodeId).c;
  },
  getNodesWithEntities() {
    return db.prepare(`
      SELECT DISTINCT e.node_id, COUNT(*) as entity_count
      FROM entities e
      WHERE e.node_id IS NOT NULL
      GROUP BY e.node_id
      LIMIT 10
    `).all();
  },

  // ── Attribute-based queries (Phase 2C) ──────────────────────────────────────

  /** Get facts by attribute name, optionally filtered to specific entity IDs. */
  getFactsByAttribute(attributeName, entityIds = []) {
    if (entityIds.length > 0) {
      const ph = entityIds.map(() => "?").join(",");
      return db.prepare(`
        SELECT f.*, e.name as entity_name, e.type as entity_type
        FROM facts f
        JOIN entity_facts ef ON f.id = ef.fact_id
        JOIN entities e ON ef.entity_id = e.id
        WHERE f.attribute_name = ? AND f.status = 'active'
          AND e.id IN (${ph})
        ORDER BY f.confidence DESC
      `).all(attributeName, ...entityIds);
    }
    return db.prepare(`
      SELECT f.*, e.name as entity_name, e.type as entity_type
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      JOIN entities e ON ef.entity_id = e.id
      WHERE f.attribute_name = ? AND f.status = 'active'
      ORDER BY f.confidence DESC
    `).all(attributeName);
  },

  /** Search facts by attribute value using LIKE. */
  searchFactsByAttributeValue(attributeName, searchValue, limit = 20) {
    return db.prepare(`
      SELECT f.*, e.name as entity_name, e.type as entity_type
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      JOIN entities e ON ef.entity_id = e.id
      WHERE f.attribute_name = ? AND f.status = 'active'
        AND f.content LIKE ?
      ORDER BY f.confidence DESC
      LIMIT ?
    `).all(attributeName, `%${searchValue}%`, limit);
  },

  /** Get all facts with attribute_name set, grouped by entity. */
  getStructuredFactsForEntities(entityIds, limit = 50) {
    if (!entityIds.length) return [];
    const ph = entityIds.map(() => "?").join(",");
    return db.prepare(`
      SELECT f.*, f.attribute_name, e.name as entity_name, e.id as entity_id
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      JOIN entities e ON ef.entity_id = e.id
      WHERE f.attribute_name IS NOT NULL AND f.status = 'active'
        AND e.id IN (${ph})
      ORDER BY e.name, f.attribute_name
      LIMIT ?
    `).all(...entityIds, limit);
  }
};
