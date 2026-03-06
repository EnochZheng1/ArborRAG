/**
 * Chunk repository — chunks table reads.
 * Write operations (insert, update, supersede) are handled by the ingest pipeline.
 */

import { db } from "../db.js";

export const ChunkRepo = {
  // ── Node-scoped reads ────────────────────────────────────────────────────────

  /** All active chunks for a node (no row limit). */
  getForNode(nodeId) {
    return db.prepare(`
      SELECT * FROM chunks
      WHERE node_id = ? AND status = 'active' AND superseded_by IS NULL
      ORDER BY authority_level ASC, uploaded_at DESC
    `).all(nodeId);
  },

  /** Active chunks for a node, with a row limit. */
  getForNodeLimited(nodeId, limit) {
    return db.prepare(`
      SELECT * FROM chunks
      WHERE node_id = ? AND status = 'active' AND superseded_by IS NULL
      ORDER BY authority_level ASC, uploaded_at DESC
      LIMIT ?
    `).all(nodeId, Math.max(1, Math.floor(Number(limit))));
  },

  /** Active chunks for a node, joined with the node name column. */
  getForNodeWithNodeName(nodeId, limit) {
    return db.prepare(`
      SELECT c.*, n.name as node_name FROM chunks c
      JOIN nodes n ON n.node_id = c.node_id
      WHERE c.node_id = ? AND c.status = 'active' AND c.superseded_by IS NULL
      ORDER BY c.authority_level ASC, c.uploaded_at DESC
      LIMIT ?
    `).all(nodeId, Math.max(1, Math.floor(Number(limit))));
  },

  /** Active chunks with node_name AND node_level, ordered by authority then upload date. */
  getForNodeFull(nodeId, limit) {
    return db.prepare(`
      SELECT c.*, n.name as node_name, n.level as node_level
      FROM chunks c
      JOIN nodes n ON c.node_id = n.node_id
      WHERE c.node_id = ? AND c.status = 'active' AND c.superseded_by IS NULL
      ORDER BY c.authority_level ASC, c.uploaded_at DESC
      LIMIT ?
    `).all(nodeId, Math.max(1, Math.floor(Number(limit))));
  },

  /** Active chunks with node_name AND node_level, ordered by authority then chunk_index. */
  getForNodeFullByIndex(nodeId, limit) {
    return db.prepare(`
      SELECT c.*, n.name as node_name, n.level as node_level
      FROM chunks c
      JOIN nodes n ON c.node_id = n.node_id
      WHERE c.node_id = ? AND c.status = 'active' AND c.superseded_by IS NULL
      ORDER BY c.authority_level ASC, c.chunk_index ASC
      LIMIT ?
    `).all(nodeId, Math.max(1, Math.floor(Number(limit))));
  },

  /** All active chunks for a node ordered by upload date (for route handlers). */
  getActiveForNode(nodeId) {
    return db.prepare(`
      SELECT * FROM chunks
      WHERE node_id = ? AND status = 'active' AND superseded_by IS NULL
      ORDER BY uploaded_at DESC
    `).all(nodeId);
  },

  // ── Single-chunk reads ───────────────────────────────────────────────────────

  /** Single chunk by primary key. */
  getById(id) {
    return db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) ?? null;
  },

  /** Chunk id/document_id/chunk_index for context-expansion window logic. */
  getSequenceInfo(chunkId) {
    return db.prepare(
      "SELECT id, document_id, chunk_index FROM chunks WHERE id = ?"
    ).get(chunkId) ?? null;
  },

  /** Fetch multiple chunks by an array of IDs (active only). */
  getByIds(chunkIds) {
    if (!Array.isArray(chunkIds) || !chunkIds.length) return [];
    const ph = chunkIds.map(() => "?").join(",");
    return db.prepare(
      `SELECT * FROM chunks WHERE id IN (${ph}) AND status = 'active'`
    ).all(...chunkIds);
  },

  // ── Context-window neighbors ────────────────────────────────────────────────

  /** Chunks immediately before a given chunk_index in the same document. Returned in ascending order. */
  getNeighborsBefore(docId, chunkIndex, window) {
    return db.prepare(`
      SELECT id, content_clean, chunk_index FROM chunks
      WHERE document_id = ? AND chunk_index < ? AND chunk_index >= ? AND status = 'active'
      ORDER BY chunk_index DESC
      LIMIT ?
    `).all(docId, chunkIndex, chunkIndex - window, window).reverse();
  },

  /** Chunks immediately after a given chunk_index in the same document. */
  getNeighborsAfter(docId, chunkIndex, window) {
    return db.prepare(`
      SELECT id, content_clean, chunk_index FROM chunks
      WHERE document_id = ? AND chunk_index > ? AND chunk_index <= ? AND status = 'active'
      ORDER BY chunk_index ASC
      LIMIT ?
    `).all(docId, chunkIndex, chunkIndex + window, window);
  },

  // ── Search reads ──────────────────────────────────────────────────────────────

  /** BM25 full-text search via chunks_fts. Returns rows with a `score` column. */
  bm25Search(safeQuery, limit = 50) {
    // Column weights: chunk_id col = 0 (ID, not content), content col = 1.0
    return db.prepare(`
      SELECT c.*, -bm25(chunks_fts, 0, 1) as score
      FROM chunks_fts
      JOIN chunks c ON c.id = CAST(chunks_fts.chunk_id AS INTEGER)
      WHERE chunks_fts MATCH ? AND c.status = 'active'
      ORDER BY bm25(chunks_fts, 0, 1) ASC
      LIMIT ?
    `).all(safeQuery, limit);
  },

  /**
   * LIKE search across content_clean for an array of terms (OR conditions).
   * @param {string[]} terms - raw search terms (not pre-escaped with %)
   */
  simpleContentSearch(terms, limit = 30) {
    if (!terms.length) return [];
    const conditions = terms.map(() => "c.content_clean LIKE ?").join(" OR ");
    const params = terms.map(t => `%${t}%`);
    return db.prepare(`
      SELECT c.* FROM chunks c
      WHERE c.status = 'active' AND (${conditions})
      ORDER BY c.uploaded_at DESC
      LIMIT ?
    `).all(...params, limit);
  },

  /**
   * LIKE search on keywords_json for an array of terms (OR conditions).
   * Complements BM25 FTS by directly targeting LLM-extracted semantic tags.
   * @param {string[]} terms - plain search terms (not pre-escaped)
   */
  searchByKeywords(terms, limit = 30) {
    if (!terms || !terms.length) return [];
    const capped = terms.slice(0, 8); // cap to avoid runaway SQL
    const conditions = capped.map(() => "c.keywords_json LIKE ?").join(" OR ");
    const params = capped.map(t => `%${t}%`);
    return db.prepare(`
      SELECT c.*, n.name as node_name, n.level as node_level
      FROM chunks c
      JOIN nodes n ON c.node_id = n.node_id
      WHERE c.status = 'active' AND c.superseded_by IS NULL AND (${conditions})
      ORDER BY c.uploaded_at DESC
      LIMIT ?
    `).all(...params, limit);
  },

  /**
   * Search active chunks by doc_title with a relevance score column.
   * @param {string} term - exact or partial document title
   */
  searchByDocTitle(term, limit = 30) {
    return db.prepare(`
      SELECT c.*,
        CASE WHEN c.doc_title = ? THEN 1.0
             WHEN c.doc_title LIKE ? THEN 0.8
             ELSE 0.5 END as title_score
      FROM chunks c
      WHERE c.status = 'active'
        AND (c.doc_title = ? OR c.doc_title LIKE ? OR c.doc_title LIKE ?)
      ORDER BY title_score DESC, c.chunk_index ASC
      LIMIT ?
    `).all(term, `%${term}%`, term, `${term}%`, `%${term}%`, limit);
  },

  /** Fetch active chunks matching a document name via JOIN to documents table. */
  getByDocumentName(docName, limit = 50) {
    return db.prepare(`
      SELECT c.* FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.status = 'active'
        AND (d.original_name = ? OR d.original_name LIKE ? OR c.doc_title = ? OR c.doc_title LIKE ?)
      ORDER BY c.chunk_index ASC
      LIMIT ?
    `).all(docName, `%${docName}%`, docName, `%${docName}%`, limit);
  },

  // ── Aggregates ───────────────────────────────────────────────────────────────

  /** Count of all active chunks. */
  countActive() {
    return db.prepare("SELECT COUNT(*) as total FROM chunks WHERE status = 'active'").get().total ?? 0;
  },

  // ── Writes (ingest pipeline) ──────────────────────────────────────────────────

  /** INSERT a new chunk row. Returns the better-sqlite3 run() result (has lastInsertRowid). */
  insert({ doc_title, content, chunk_type, keywords, fields, scope, authority_level, nodeId, documentId, index }) {
    return db.prepare(`
      INSERT INTO chunks (
        doc_title, content_clean, chunk_type, keywords_json, fields_json,
        scope_json, authority_level, node_id, document_id, chunk_index,
        uploaded_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'active')
    `).run(
      doc_title,
      content,
      chunk_type,
      JSON.stringify(keywords),
      JSON.stringify(fields),
      JSON.stringify(scope),
      authority_level,
      nodeId,
      documentId,
      index
    );
  },

  /** INSERT a chunks_fts row for a chunk. */
  insertFts(chunkId, content) {
    return db.prepare("INSERT INTO chunks_fts (chunk_id, content) VALUES (?, ?)").run(String(chunkId), content);
  },

  // ── Reads for ingest helpers ─────────────────────────────────────────────────

  /** content_clean and keywords_json for active chunks of a node (alias generation context). */
  getWithKeywords(nodeId, limit = 5) {
    return db.prepare(`
      SELECT content_clean, keywords_json FROM chunks
      WHERE node_id = ? AND status = 'active'
      LIMIT ?
    `).all(nodeId, limit);
  },

  /** id and node_id for all chunks of a document (for delete / rollback). */
  getForDoc(docId) {
    return db.prepare("SELECT id, node_id FROM chunks WHERE document_id = ?").all(docId);
  },

  // ── KP-specific operations ───────────────────────────────────────────────────

  /**
   * BM25 search within a specific node (for KP deduplication / decision engine).
   * Returns chunks with content_clean, authority_level, and source_documents_json.
   * @param {string} nodeId
   * @param {string} queryText
   * @param {number} limit
   * @param {number|null} excludeChunkId - Skip this chunk id (cleanup / self-match avoidance)
   */
  findSimilarInNode(nodeId, queryText, limit = 5, excludeChunkId = null) {
    // Keep only Unicode letters, digits and whitespace — strips all punctuation
    // that could be interpreted as FTS5 query operators (., %, *, -, :, etc.).
    const safeQ = queryText
      .slice(0, 500)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!safeQ) return [];
    if (excludeChunkId != null) {
      return db.prepare(`
        SELECT c.id, c.content_clean, c.authority_level, c.source_documents_json, -bm25(chunks_fts, 0, 1) AS bm25_score
        FROM chunks_fts
        JOIN chunks c ON c.id = CAST(chunks_fts.chunk_id AS INTEGER)
        WHERE chunks_fts MATCH ? AND c.node_id = ? AND c.status = 'active' AND c.id != ?
        ORDER BY bm25(chunks_fts, 0, 1) ASC
        LIMIT ?
      `).all(safeQ, nodeId, excludeChunkId, Math.max(1, Math.floor(Number(limit))));
    }
    return db.prepare(`
      SELECT c.id, c.content_clean, c.authority_level, c.source_documents_json, -bm25(chunks_fts, 0, 1) AS bm25_score
      FROM chunks_fts
      JOIN chunks c ON c.id = CAST(chunks_fts.chunk_id AS INTEGER)
      WHERE chunks_fts MATCH ? AND c.node_id = ? AND c.status = 'active'
      ORDER BY bm25(chunks_fts, 0, 1) ASC
      LIMIT ?
    `).all(safeQ, nodeId, Math.max(1, Math.floor(Number(limit))));
  },

  /** Update source_documents_json for a chunk (used when merging duplicate KPs). */
  updateSourceDocuments(chunkId, sourceDocsJson) {
    return db.prepare(
      "UPDATE chunks SET source_documents_json = ? WHERE id = ?"
    ).run(sourceDocsJson, chunkId);
  },

  /**
   * Mark an existing chunk as superseded by a newer one.
   * Sets status='superseded' and superseded_by=newChunkId.
   */
  supersede(existingId, newChunkId) {
    return db.prepare(
      "UPDATE chunks SET superseded_by = ?, status = 'superseded' WHERE id = ?"
    ).run(newChunkId, existingId);
  },

  /** Delete a chunk and its FTS entry by primary key. */
  deleteById(id) {
    db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(String(id));
    db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
  },

  /** INSERT a Knowledge Point row (includes KP-specific columns). */
  insertKP({ doc_title, content, chunk_type, kp_type, keywords, fields, scope,
             authority_level, source_excerpt, source_documents_json, nodeId, documentId, index }) {
    return db.prepare(`
      INSERT INTO chunks
        (doc_title, content_clean, chunk_type, kp_type, keywords_json, fields_json,
         scope_json, authority_level, source_excerpt, source_documents_json,
         node_id, document_id, chunk_index, uploaded_at, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),'active')
    `).run(
      doc_title, content, chunk_type, kp_type,
      JSON.stringify(keywords || []),
      JSON.stringify(fields || {}),
      JSON.stringify(scope || {}),
      authority_level,
      source_excerpt || '',
      source_documents_json || '[]',
      nodeId, documentId, index
    );
  }
};
