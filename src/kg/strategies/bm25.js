/**
 * BM25 keyword-based retrieval strategies.
 */

import { db, safeJson } from "../../db/db.js";
import { queryLogger as logger } from "../../utils/logger.js";
import { extractSearchTerms, escapeFtsQuery } from "./utils.js";

// ── Node search ───────────────────────────────────────────────────────────────

export function bm25RecallNodes(query, limit = 30) {
  const safeQuery = escapeFtsQuery(query);
  try {
    const rows = db.prepare(`
      SELECT n.*, -bm25(nodes_fts) as score
      FROM nodes_fts
      JOIN nodes n ON n.node_id = nodes_fts.node_id
      WHERE nodes_fts MATCH ?
      ORDER BY bm25(nodes_fts) ASC
      LIMIT ?
    `).all(safeQuery, limit);

    return rows.map(r => ({
      node: {
        node_id: r.node_id,
        name: r.name,
        parent_id: r.parent_id,
        level: r.level,
        node_summary: r.node_summary,
        scope_json: safeJson(r.scope_json, {}),
        authority_level_mode: r.authority_level_mode,
        conflict_score: r.conflict_score,
        updated_at: r.updated_at
      },
      bm25: r.score
    }));
  } catch (err) {
    logger.error("BM25 recall error:", err.message);
    return [];
  }
}

export function searchNodesByName(name, limit = 10) {
  const rows = db.prepare(`
    SELECT * FROM nodes
    WHERE name LIKE ? OR node_id LIKE ?
    ORDER BY level ASC, name ASC
    LIMIT ?
  `).all(`%${name}%`, `%${name}%`, limit);

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    scope_json: safeJson(r.scope_json, {}),
    authority_level_mode: r.authority_level_mode,
    conflict_score: r.conflict_score,
    updated_at: r.updated_at
  }));
}

export function getNodesByIds(nodeIds) {
  if (!nodeIds.length) return [];
  const ph = nodeIds.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM nodes WHERE node_id IN (${ph})`).all(...nodeIds).map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    scope_json: safeJson(r.scope_json, {}),
    authority_level_mode: r.authority_level_mode,
    conflict_score: r.conflict_score,
    updated_at: r.updated_at
  }));
}

// ── Chunk search ──────────────────────────────────────────────────────────────

function buildChunkResult(r) {
  return {
    id: r.id,
    doc_title: r.doc_title,
    content: r.content_clean,
    chunk_type: r.chunk_type,
    keywords: safeJson(r.keywords_json, []),
    fields: safeJson(r.fields_json, {}),
    scope: safeJson(r.scope_json, {}),
    authority_level: r.authority_level,
    node_id: r.node_id,
    uploaded_at: r.uploaded_at
  };
}

export function bm25RecallChunks(query, limit = 50) {
  const safeQuery = escapeFtsQuery(query);
  try {
    const rows = db.prepare(`
      SELECT c.*, -bm25(chunks_fts) as score
      FROM chunks_fts
      JOIN chunks c ON c.id = CAST(chunks_fts.chunk_id AS INTEGER)
      WHERE chunks_fts MATCH ? AND c.status = 'active'
      ORDER BY bm25(chunks_fts) ASC
      LIMIT ?
    `).all(safeQuery, limit);

    return rows.map(r => ({ chunk: buildChunkResult(r), bm25: r.score }));
  } catch (err) {
    logger.error("BM25 chunk recall error:", err.message);
    return [];
  }
}

export function simpleContentSearch(query, limit = 30) {
  try {
    const terms = extractSearchTerms(query, { maxTerms: 32 });
    if (terms.length === 0) return [];

    const conditions = terms.map(() => "c.content_clean LIKE ?").join(" OR ");
    const params = terms.map(t => `%${t}%`);

    const rows = db.prepare(`
      SELECT c.* FROM chunks c
      WHERE c.status = 'active' AND (${conditions})
      ORDER BY c.uploaded_at DESC
      LIMIT ?
    `).all(...params, limit);

    logger.debug(`Simple content search for "${query}" found ${rows.length} chunks`);
    return rows.map(r => {
      const contentLower = (r.content_clean || "").toLowerCase();
      const matchedTerms = terms.filter(t => contentLower.includes(t)).length;
      const score = Math.max(0.1, Math.min(1, matchedTerms / Math.min(terms.length, 8)));
      return { chunk: buildChunkResult(r), score };
    });
  } catch (err) {
    logger.error("Simple content search error:", err.message);
    return [];
  }
}

export function searchChunksByDocTitle(query, limit = 30) {
  try {
    const docNameMatch =
      query.match(/[""「『]([^""」』]+)[""」』]/) ||
      query.match(/《([^》]+)》/) ||
      query.match(/['']([^'']+)['']/) ||
      query.match(/(?:文档|文件|document|doc|file)\s*[:：]?\s*(.+?)(?:里|中|的|内容|$)/i);

    const searchTerms = docNameMatch ? [docNameMatch[1], query] : [query];
    const results = [];
    const seenIds = new Set();

    for (const term of searchTerms) {
      const rows = db.prepare(`
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

      for (const r of rows) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          results.push({ chunk: { ...buildChunkResult(r), chunk_index: r.chunk_index }, score: r.title_score, source: "doc_title" });
        }
      }
    }

    logger.debug(`Document title search for "${query}" found ${results.length} chunks`);
    return results;
  } catch (err) {
    logger.error("Document title search error:", err.message);
    return [];
  }
}

export function getChunksByDocumentName(docName, limit = 50) {
  try {
    return db.prepare(`
      SELECT c.* FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.status = 'active'
        AND (d.original_name = ? OR d.original_name LIKE ? OR c.doc_title = ? OR c.doc_title LIKE ?)
      ORDER BY c.chunk_index ASC
      LIMIT ?
    `).all(docName, `%${docName}%`, docName, `%${docName}%`, limit).map(r => ({
      ...buildChunkResult(r), chunk_index: r.chunk_index
    }));
  } catch (err) {
    logger.error("Get chunks by document name error:", err.message);
    return [];
  }
}
