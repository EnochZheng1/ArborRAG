/**
 * BM25 keyword-based retrieval strategies.
 */

import { safeJson } from "../../db/db.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../../db/repositories/ChunkRepo.js";
import { queryLogger as logger } from "../../utils/logger.js";
import { extractSearchTerms, escapeFtsQuery } from "./utils.js";

// ── Node search ───────────────────────────────────────────────────────────────

export function bm25RecallNodes(query, limit = 30) {
  const safeQuery = escapeFtsQuery(query);
  try {
    const rows = NodeRepo.bm25Search(safeQuery, limit);

    return rows.map(r => ({
      node: {
        node_id: r.node_id,
        name: r.name,
        parent_id: r.parent_id,
        level: r.level,
        node_summary: r.node_summary,
        node_description: r.node_description || '',
        quality_score: r.quality_score ?? null,
        aliases_json: r.aliases_json,
        keywords_json: r.keywords_json,
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
  const rows = NodeRepo.searchByName(name, limit);

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    node_description: r.node_description || '',
    quality_score: r.quality_score ?? null,
    aliases_json: r.aliases_json,
    keywords_json: r.keywords_json,
    scope_json: safeJson(r.scope_json, {}),
    authority_level_mode: r.authority_level_mode,
    conflict_score: r.conflict_score,
    updated_at: r.updated_at
  }));
}

export function getNodesByIds(nodeIds) {
  if (!nodeIds.length) return [];
  return NodeRepo.findByIds(nodeIds).map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    node_description: r.node_description || '',
    quality_score: r.quality_score ?? null,
    aliases_json: r.aliases_json,
    keywords_json: r.keywords_json,
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
    const rows = ChunkRepo.bm25Search(safeQuery, limit);

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

    const rows = ChunkRepo.simpleContentSearch(terms, limit);

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

export function keywordTagSearch(query, limit = 30) {
  try {
    const terms = extractSearchTerms(query, { maxTerms: 16 });
    if (terms.length === 0) return [];

    const rows = ChunkRepo.searchByKeywords(terms, limit);

    return rows.map(r => {
      const keywords = safeJson(r.keywords_json, []).map(k => String(k).toLowerCase());
      const matchedTerms = terms.filter(t => keywords.some(kw => kw.includes(t) || t.includes(kw))).length;
      const score = Math.max(0.3, Math.min(1, matchedTerms / Math.min(terms.length, 6)));
      return { chunk: { ...buildChunkResult(r), node_name: r.node_name, node_level: r.node_level }, score };
    });
  } catch (err) {
    logger.error("Keyword tag search error:", err.message);
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
      const rows = ChunkRepo.searchByDocTitle(term, limit);

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
    return ChunkRepo.getByDocumentName(docName, limit).map(r => ({
      ...buildChunkResult(r), chunk_index: r.chunk_index
    }));
  } catch (err) {
    logger.error("Get chunks by document name error:", err.message);
    return [];
  }
}
