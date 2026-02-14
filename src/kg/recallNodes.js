import { db, safeJson } from "../db/db.js";
import { generateQueryEmbedding } from "../embedding/embedder.js";
import { searchNodesBySimilarity, searchChunksBySimilarity } from "../embedding/vectorStore.js";
import { queryLogger as logger } from "../utils/logger.js";
import { detectLanguage } from "../utils/langDetect.js";
import { GoogleGenAI } from "@google/genai";
import { getNode, getAncestors, getChildren, getSiblings } from "./graphTraversal.js";

// Cache for expanded queries
const queryExpansionCache = new Map();
const EXPANSION_CACHE_MAX = 500;

const CJK_CHAR_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const CJK_SEQUENCE_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

function extractCjkNgrams(sequence, minN = 2, maxN = 3, maxTerms = 24) {
  if (!sequence) return [];
  const chars = [...sequence].filter(ch => CJK_CHAR_REGEX.test(ch));
  if (chars.length === 0) return [];

  const terms = [];
  if (chars.length >= 2) {
    terms.push(chars.join(""));
  }

  const upper = Math.min(maxN, chars.length);
  for (let n = minN; n <= upper; n++) {
    for (let i = 0; i <= chars.length - n; i++) {
      terms.push(chars.slice(i, i + n).join(""));
      if (terms.length >= maxTerms) return terms;
    }
  }

  return terms;
}

function extractSearchTerms(query, options = {}) {
  const {
    maxTerms = 32,
    includeSingleCjk = false
  } = options;

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
  for (const token of latinTokens) {
    if (!addTerm(token)) return terms;
  }

  const spaceTokens = normalized.split(/\s+/).map(t => t.trim()).filter(Boolean);
  for (const token of spaceTokens) {
    if (CJK_CHAR_REGEX.test(token)) continue;
    if (/[a-z0-9]/.test(token)) continue;
    if (token.length >= 2 && !addTerm(token)) return terms;
  }

  const cjkSequences = normalized.match(CJK_SEQUENCE_REGEX) || [];
  for (const sequence of cjkSequences) {
    const grams = extractCjkNgrams(sequence, 2, 3, maxTerms);
    for (const gram of grams) {
      if (!addTerm(gram)) return terms;
    }
    if (includeSingleCjk && sequence.length <= 8) {
      for (const ch of sequence) {
        if (!addTerm(ch)) return terms;
      }
    }
  }

  return terms;
}

// Alias cache to avoid full DB scans per query
const aliasCache = {
  loadedAt: 0,
  nodeCount: null,
  maxUpdatedAt: null,
  entries: [],
  exactMap: new Map(),
  tokenIndex: new Map()
};
const ALIAS_CACHE_TTL_MS = 60 * 1000;

function refreshAliasCache(force = false) {
  const now = Date.now();
  if (!force && aliasCache.loadedAt && now - aliasCache.loadedAt < ALIAS_CACHE_TTL_MS) {
    return;
  }

  const meta = db.prepare(`
    SELECT COUNT(*) as count, MAX(updated_at) as max_updated_at
    FROM nodes
  `).get();

  if (!force &&
      aliasCache.nodeCount === meta.count &&
      aliasCache.maxUpdatedAt === meta.max_updated_at &&
      aliasCache.loadedAt) {
    aliasCache.loadedAt = now;
    return;
  }

  const rows = db.prepare(`
    SELECT node_id, name, parent_id, level, node_summary, aliases_json, scope_json
    FROM nodes
    WHERE aliases_json IS NOT NULL AND aliases_json != '[]' AND aliases_json != 'null'
  `).all();

  const entries = [];
  const exactMap = new Map();
  const tokenIndex = new Map();

  for (const row of rows) {
    const aliases = safeJson(row.aliases_json, []);
    if (!Array.isArray(aliases) || aliases.length === 0) continue;

    const node = {
      node_id: row.node_id,
      name: row.name,
      parent_id: row.parent_id,
      level: row.level,
      node_summary: row.node_summary,
      scope: safeJson(row.scope_json, {})
    };

    for (const alias of aliases) {
      if (typeof alias !== "string") continue;
      const aliasLower = alias.toLowerCase();
      const entry = { node, alias, aliasLower };
      entries.push(entry);

      if (!exactMap.has(aliasLower)) {
        exactMap.set(aliasLower, []);
      }
      exactMap.get(aliasLower).push(entry);

      const tokens = extractSearchTerms(aliasLower, { maxTerms: 20 });
      for (const token of tokens) {
        if (!tokenIndex.has(token)) tokenIndex.set(token, []);
        tokenIndex.get(token).push(entry);
      }
    }
  }

  aliasCache.entries = entries;
  aliasCache.exactMap = exactMap;
  aliasCache.tokenIndex = tokenIndex;
  aliasCache.loadedAt = now;
  aliasCache.nodeCount = meta.count;
  aliasCache.maxUpdatedAt = meta.max_updated_at;
  logger.debug(`Alias cache refreshed: ${entries.length} aliases`);
}

function normalizeByMax(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

// Escape FTS5 special characters for safe querying
function escapeFtsQuery(query) {
  const terms = extractSearchTerms(query, { maxTerms: 24 });
  if (terms.length === 0) return '""';
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Expand query with related terms using LLM
 * @param {string} query - Original query
 * @returns {Promise<string[]>} Expanded terms
 */
async function expandQuery(query) {
  // Check cache
  if (queryExpansionCache.has(query)) {
    return queryExpansionCache.get(query);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return [query];  // No expansion without API
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    const prompt = `Given this search query, generate 3-5 related search terms or synonyms that might help find relevant content. Include both the original language and translations if applicable.

Query: "${query}"

Return ONLY a JSON array of strings, no explanation:
["term1", "term2", "term3"]`;

    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "[]";
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    const terms = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    // Add original query
    const allTerms = [query, ...terms.filter(t => typeof t === "string" && t.length > 0)];
    const uniqueTerms = [...new Set(allTerms)];

    // Cache result
    if (queryExpansionCache.size >= EXPANSION_CACHE_MAX) {
      const firstKey = queryExpansionCache.keys().next().value;
      queryExpansionCache.delete(firstKey);
    }
    queryExpansionCache.set(query, uniqueTerms);

    logger.debug(`Query expansion: "${query}" -> ${JSON.stringify(uniqueTerms)}`);
    return uniqueTerms;
  } catch (err) {
    logger.warn("Query expansion failed:", err.message);
    return [query];
  }
}

function normalizeVariantText(text) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addQueryVariant(list, seen, text, weight, source) {
  const normalized = normalizeVariantText(text);
  if (!normalized) return;

  const dedupeKey = normalized.toLowerCase();
  if (seen.has(dedupeKey)) {
    const existing = list.find(v => v.key === dedupeKey);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
      }
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

/**
 * Build multilingual retrieval query variants.
 *
 * Variants can come from:
 * - LLM query expansion (synonyms/translations)
 * - Alias matches to pivot into node names/aliases in another language
 *
 * @param {string} query - Original user query
 * @param {object} options - Variant options
 * @returns {Promise<Array<{text: string, weight: number, lang: string, sources: string[]}>>}
 */
export async function buildRetrievalQueryVariants(query, options = {}) {
  const {
    maxVariants = 6,
    useExpansion = true,
    useAliasPivot = true,
    expansionTerms = 4,
    aliasLimit = 8
  } = options;

  const baseQuery = normalizeVariantText(query);
  if (!baseQuery) return [];

  const variants = [];
  const seen = new Set();
  const baseLang = detectLanguage(baseQuery);

  addQueryVariant(variants, seen, baseQuery, 1.0, "original");

  const punctuationStripped = baseQuery.replace(/[“”‘’"'`]/g, "").trim();
  if (punctuationStripped && punctuationStripped !== baseQuery) {
    addQueryVariant(variants, seen, punctuationStripped, 0.97, "normalized");
  }

  if (useExpansion) {
    try {
      const expanded = await expandQuery(baseQuery);
      for (const term of expanded.slice(0, expansionTerms + 1)) {
        const cleaned = normalizeVariantText(term);
        if (!cleaned || cleaned.toLowerCase() === baseQuery.toLowerCase()) continue;
        const variantLang = detectLanguage(cleaned);
        const isCrossLang = variantLang !== baseLang;
        addQueryVariant(variants, seen, cleaned, isCrossLang ? 0.92 : 0.82, isCrossLang ? "translation" : "expansion");
      }
    } catch (err) {
      logger.warn("Failed to build LLM query variants:", err.message);
    }
  }

  if (useAliasPivot) {
    try {
      const aliasMatches = searchByAliases(baseQuery, aliasLimit);

      for (const match of aliasMatches) {
        addQueryVariant(variants, seen, match.matchedAlias, Math.min(0.92, (match.score || 0.6) + 0.1), "alias_match");
        addQueryVariant(variants, seen, match.node?.name, detectLanguage(match.node?.name || "") !== baseLang ? 0.9 : 0.82, "node_name");

        const fullNode = match.node?.node_id ? getNode(match.node.node_id) : null;
        const aliases = Array.isArray(fullNode?.aliases) ? fullNode.aliases : [];
        for (const alias of aliases.slice(0, 3)) {
          const aliasLang = detectLanguage(alias);
          addQueryVariant(variants, seen, alias, aliasLang !== baseLang ? 0.88 : 0.78, "node_alias");
        }
      }
    } catch (err) {
      logger.warn("Alias pivot for query variants failed:", err.message);
    }
  }

  variants.sort((a, b) => b.weight - a.weight || a.text.length - b.text.length);
  return variants.slice(0, maxVariants).map(v => ({
    text: v.text,
    weight: v.weight,
    lang: v.lang,
    sources: v.sources
  }));
}

// BM25 recall for nodes - returns [{ node, bm25 }]
export function bm25RecallNodes(query, limit = 30) {
  const safeQuery = escapeFtsQuery(query);

  try {
    // bm25() returns negative values where smaller = more relevant
    // We negate to make higher = better
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

// BM25 recall for chunks - returns [{ chunk, bm25 }]
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

    return rows.map(r => ({
      chunk: {
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
      },
      bm25: r.score
    }));
  } catch (err) {
    logger.error("BM25 chunk recall error:", err.message);
    return [];
  }
}

// Simple content search using LIKE (fallback when FTS fails or returns nothing)
export function simpleContentSearch(query, limit = 30) {
  try {
    const terms = extractSearchTerms(query, { maxTerms: 32 });
    if (terms.length === 0) return [];

    // Build OR conditions for each term
    const conditions = terms.map(() => 'c.content_clean LIKE ?').join(' OR ');
    const params = terms.map(t => `%${t}%`);

    const rows = db.prepare(`
      SELECT c.*
      FROM chunks c
      WHERE c.status = 'active'
        AND (${conditions})
      ORDER BY c.uploaded_at DESC
      LIMIT ?
    `).all(...params, limit);

    logger.debug(`Simple content search for "${query}" found ${rows.length} chunks`);

    return rows.map(r => {
      const contentLower = (r.content_clean || "").toLowerCase();
      const matchedTerms = terms.filter(t => contentLower.includes(t)).length;
      const score = Math.max(0.1, Math.min(1, matchedTerms / Math.min(terms.length, 8)));

      return {
      chunk: {
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
      },
      score
    };
    });
  } catch (err) {
    logger.error("Simple content search error:", err.message);
    return [];
  }
}

// Search chunks by document title - returns [{ chunk, score }]
export function searchChunksByDocTitle(query, limit = 30) {
  try {
    // Extract potential document name from query (handle quotes and common patterns)
    const docNameMatch = query.match(/[""「『]([^""」』]+)[""」』]/) ||
                         query.match(/《([^》]+)》/) ||
                         query.match(/['']([^'']+)['']/) ||
                         query.match(/(?:文档|文件|document|doc|file)\s*[:：]?\s*(.+?)(?:里|中|的|内容|$)/i);

    const searchTerms = docNameMatch ? [docNameMatch[1], query] : [query];

    const results = [];
    const seenIds = new Set();

    for (const term of searchTerms) {
      // Search by doc_title (exact and partial match)
      const rows = db.prepare(`
        SELECT c.*,
               CASE
                 WHEN c.doc_title = ? THEN 1.0
                 WHEN c.doc_title LIKE ? THEN 0.8
                 ELSE 0.5
               END as title_score
        FROM chunks c
        WHERE c.status = 'active'
          AND (c.doc_title = ? OR c.doc_title LIKE ? OR c.doc_title LIKE ?)
        ORDER BY title_score DESC, c.chunk_index ASC
        LIMIT ?
      `).all(term, `%${term}%`, term, `${term}%`, `%${term}%`, limit);

      for (const r of rows) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id);
          results.push({
            chunk: {
              id: r.id,
              doc_title: r.doc_title,
              content: r.content_clean,
              chunk_type: r.chunk_type,
              keywords: safeJson(r.keywords_json, []),
              fields: safeJson(r.fields_json, {}),
              scope: safeJson(r.scope_json, {}),
              authority_level: r.authority_level,
              node_id: r.node_id,
              uploaded_at: r.uploaded_at,
              chunk_index: r.chunk_index
            },
            score: r.title_score,
            source: 'doc_title'
          });
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

// Search documents by name and get all their chunks
export function getChunksByDocumentName(docName, limit = 50) {
  try {
    const rows = db.prepare(`
      SELECT c.*
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.status = 'active'
        AND (d.original_name = ? OR d.original_name LIKE ? OR c.doc_title = ? OR c.doc_title LIKE ?)
      ORDER BY c.chunk_index ASC
      LIMIT ?
    `).all(docName, `%${docName}%`, docName, `%${docName}%`, limit);

    return rows.map(r => ({
      id: r.id,
      doc_title: r.doc_title,
      content: r.content_clean,
      chunk_type: r.chunk_type,
      keywords: safeJson(r.keywords_json, []),
      fields: safeJson(r.fields_json, {}),
      scope: safeJson(r.scope_json, {}),
      authority_level: r.authority_level,
      node_id: r.node_id,
      chunk_index: r.chunk_index,
      uploaded_at: r.uploaded_at
    }));
  } catch (err) {
    logger.error("Get chunks by document name error:", err.message);
    return [];
  }
}

// Get nodes by exact IDs
export function getNodesByIds(nodeIds) {
  if (!nodeIds.length) return [];

  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM nodes WHERE node_id IN (${placeholders})
  `).all(...nodeIds);

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

// Search nodes by name (partial match)
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

// Vector-based node recall - returns [{ node, similarity }]
export async function vectorRecallNodes(query, limit = 30, threshold = 0.5) {
  try {
    const queryEmbedding = await generateQueryEmbedding(query);
    const results = searchNodesBySimilarity(queryEmbedding, limit, threshold);

    return results.map(r => ({
      node: r.node,
      similarity: r.similarity
    }));
  } catch (err) {
    logger.error("Vector recall error:", err.message);
    return [];
  }
}

// Vector-based chunk recall - returns [{ chunk, similarity }]
export async function vectorRecallChunks(query, limit = 50, threshold = 0.5) {
  try {
    const queryEmbedding = await generateQueryEmbedding(query);
    const results = searchChunksBySimilarity(queryEmbedding, limit, threshold);

    return results.map(r => ({
      chunk: r.chunk,
      similarity: r.similarity
    }));
  } catch (err) {
    logger.error("Vector chunk recall error:", err.message);
    return [];
  }
}

/**
 * Reciprocal Rank Fusion (RRF) for combining rankings
 * @param {Array<Array<{id: string, score: number}>>} rankings - Multiple ranked lists
 * @param {number} k - RRF constant (default 60)
 * @returns {Map<string, number>} Fused scores by ID
 */
function reciprocalRankFusion(rankings, k = 60) {
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

/**
 * Hybrid recall combining BM25 and vector search with multi-stage retrieval
 * @param {string} query - Search query
 * @param {number} limit - Number of results
 * @param {object} options - Options
 * @returns {Promise<Array<{node: object, score: number, sources: string[]}>>}
 */
export async function hybridRecallNodes(query, limit = 30, options = {}) {
  const {
    bm25Weight = 0.4,
    vectorWeight = 0.6,  // Increased vector weight for semantic matching
    vectorThreshold = 0.25,  // Lowered threshold for better coverage
    useRRF = true,
    includeChunkSearch = true,  // Also search chunks and map to nodes
    useMultilingualVariants = true,
    queryVariants = null,
    maxQueryVariants = 4,
    maxVectorVariants = 2,
    useExpansion = true
  } = options;

  const preparedVariants = Array.isArray(queryVariants) && queryVariants.length > 0
    ? queryVariants
    : (useMultilingualVariants
        ? await buildRetrievalQueryVariants(query, {
          maxVariants: maxQueryVariants,
          useExpansion,
          useAliasPivot: true
        })
        : [{ text: query, weight: 1, lang: detectLanguage(query), sources: ["original"] }]);

  const normalizedVariants = preparedVariants
    .map(v => {
      if (typeof v === "string") {
        return { text: normalizeVariantText(v), weight: 1, lang: detectLanguage(v), sources: ["external"] };
      }
      return {
        text: normalizeVariantText(v?.text),
        weight: Number.isFinite(v?.weight) ? v.weight : 1,
        lang: v?.lang || detectLanguage(v?.text || ""),
        sources: Array.isArray(v?.sources) ? v.sources : ["external"]
      };
    })
    .filter(v => v.text);

  if (normalizedVariants.length === 0) {
    normalizedVariants.push({ text: query, weight: 1, lang: detectLanguage(query), sources: ["original"] });
  }

  normalizedVariants.sort((a, b) => b.weight - a.weight);
  const lexicalVariants = normalizedVariants.slice(0, Math.max(1, maxQueryVariants));
  const vectorVariants = lexicalVariants.slice(0, Math.max(1, Math.min(maxVectorVariants, lexicalVariants.length)));

  const nodeMap = new Map();
  const addToNodeMap = (node, source, score, matchedQuery = null) => {
    if (!node?.node_id || !Number.isFinite(score) || score <= 0) return;

    if (!nodeMap.has(node.node_id)) {
      nodeMap.set(node.node_id, { node, sources: [], scores: {}, variantMatches: new Set() });
    }
    const entry = nodeMap.get(node.node_id);
    if (!entry.sources.includes(source)) {
      entry.sources.push(source);
    }
    entry.scores[source] = Math.max(entry.scores[source] || 0, score);
    if (matchedQuery) {
      entry.variantMatches.add(matchedQuery);
    }
  };

  // Stage 1: BM25 on nodes
  let bm25Count = 0;
  for (const variant of lexicalVariants) {
    const bm25Results = bm25RecallNodes(variant.text, limit * 2);
    bm25Count += bm25Results.length;
    for (const r of bm25Results) {
      addToNodeMap(r.node, "bm25_node", (r.bm25 || 0) * variant.weight, variant.text);
    }
  }
  logger.debug(`BM25 node recall (${lexicalVariants.length} variants): ${bm25Count} results`);

  // Stage 2: Vector search on nodes
  let vectorCount = 0;
  for (const variant of vectorVariants) {
    try {
      const vectorResults = await vectorRecallNodes(variant.text, limit * 2, vectorThreshold);
      vectorCount += vectorResults.length;
      for (const r of vectorResults) {
        addToNodeMap(r.node, "vector_node", (r.similarity || 0) * variant.weight, variant.text);
      }
    } catch (err) {
      logger.warn(`Vector node search failed for variant "${variant.text}":`, err.message);
    }
  }
  logger.debug(`Vector node recall (${vectorVariants.length} variants): ${vectorCount} results`);

  // Stage 3: Search chunks and map back to nodes (finds content BM25 missed)
  if (includeChunkSearch) {
    try {
      const chunkBm25 = [];
      for (const variant of lexicalVariants) {
        const results = bm25RecallChunks(variant.text, limit).map(r => ({ ...r, _variantWeight: variant.weight, _variantText: variant.text }));
        chunkBm25.push(...results);
      }

      const chunkNodeIds = new Set();
      const maxBm25 = chunkBm25.reduce((max, r) => Math.max(max, r.bm25 || 0), 0);
      const nodeScoreMap = new Map();
      for (const r of chunkBm25) {
        if (r.chunk.node_id) {
          chunkNodeIds.add(r.chunk.node_id);
          const score = normalizeByMax(r.bm25 || 0, maxBm25) * (r._variantWeight || 1);
          const prev = nodeScoreMap.get(r.chunk.node_id) || 0;
          if (score > prev) nodeScoreMap.set(r.chunk.node_id, score);
        }
      }
      if (chunkNodeIds.size > 0) {
        const nodesFromChunks = getNodesByIds([...chunkNodeIds]);
        for (const node of nodesFromChunks) {
          const score = nodeScoreMap.get(node.node_id) || 0;
          if (score > 0) {
            addToNodeMap(node, "bm25_chunk", score);
          }
        }
        logger.debug(`BM25 chunk recall found ${chunkNodeIds.size} additional nodes`);
      }
    } catch (err) {
      logger.warn("Chunk BM25 search failed:", err.message);
    }

    // Stage 3b: Search by document title (handles "What's in document X?" queries)
    try {
      const docTitleResults = [];
      for (const variant of lexicalVariants) {
        const results = searchChunksByDocTitle(variant.text, limit).map(r => ({ ...r, _variantWeight: variant.weight }));
        docTitleResults.push(...results);
      }

      const docNodeIds = new Set();
      const nodeScoreMap = new Map();
      for (const r of docTitleResults) {
        if (r.chunk.node_id) {
          docNodeIds.add(r.chunk.node_id);
          const score = Math.max(0, Math.min(1, r.score || 0)) * (r._variantWeight || 1);
          const prev = nodeScoreMap.get(r.chunk.node_id) || 0;
          if (score > prev) nodeScoreMap.set(r.chunk.node_id, score);
        }
      }
      if (docNodeIds.size > 0) {
        const nodesFromDocs = getNodesByIds([...docNodeIds]);
        for (const node of nodesFromDocs) {
          const score = nodeScoreMap.get(node.node_id) || 0;
          if (score > 0) {
            addToNodeMap(node, "doc_title", score);
          }
        }
        logger.debug(`Document title search found ${docNodeIds.size} nodes`);
      }
    } catch (err) {
      logger.warn("Document title search failed:", err.message);
    }

    // Stage 4: Vector search on chunks and map back to nodes
    try {
      const chunkVector = [];
      for (const variant of vectorVariants) {
        const results = await vectorRecallChunks(variant.text, limit, vectorThreshold);
        chunkVector.push(...results.map(r => ({ ...r, _variantWeight: variant.weight, _variantText: variant.text })));
      }

      const chunkNodeIds = new Set();
      const maxSim = chunkVector.reduce((max, r) => Math.max(max, r.similarity || 0), 0);
      const nodeScoreMap = new Map();
      for (const r of chunkVector) {
        if (r.chunk.node_id) {
          chunkNodeIds.add(r.chunk.node_id);
          const score = normalizeByMax(r.similarity || 0, maxSim) * (r._variantWeight || 1);
          const prev = nodeScoreMap.get(r.chunk.node_id) || 0;
          if (score > prev) nodeScoreMap.set(r.chunk.node_id, score);
        }
      }
      if (chunkNodeIds.size > 0) {
        const nodesFromChunks = getNodesByIds([...chunkNodeIds]);
        for (const node of nodesFromChunks) {
          const score = nodeScoreMap.get(node.node_id) || 0;
          if (score > 0) {
            addToNodeMap(node, "vector_chunk", score);
          }
        }
        logger.debug(`Vector chunk recall found ${chunkNodeIds.size} additional nodes`);
      }
    } catch (err) {
      logger.warn("Chunk vector search failed:", err.message);
    }
  }

  // Stage 5: Name/alias matching (exact and partial)
  try {
    for (const variant of lexicalVariants) {
      const queryTerms = extractSearchTerms(variant.text, { maxTerms: 16 });
      for (const term of queryTerms) {
        const nameMatches = searchNodesByName(term, 5);
        for (const node of nameMatches) {
          addToNodeMap(node, "name_match", 0.9 * variant.weight, variant.text);  // High score for name match
        }
      }

      const aliasMatches = searchByAliases(variant.text, 8);
      for (const match of aliasMatches) {
        addToNodeMap(match.node, "alias_match", (match.score || 0.6) * variant.weight, variant.text);
      }
    }
  } catch (err) {
    logger.warn("Name matching failed:", err.message);
  }

  // If we have nothing, return empty
  if (nodeMap.size === 0) {
    logger.debug("No results from any retrieval method");
    return [];
  }

  // Combine scores using RRF or weighted combination
  if (useRRF) {
    // Build rankings for each source
    const rankings = {};
    for (const [nodeId, data] of nodeMap) {
      for (const source of data.sources) {
        if (!rankings[source]) rankings[source] = [];
        rankings[source].push({ id: nodeId, score: data.scores[source] });
      }
    }

    // Sort each ranking by score
    for (const source of Object.keys(rankings)) {
      rankings[source].sort((a, b) => b.score - a.score);
    }

    // Apply RRF across all rankings
    const fusedScores = reciprocalRankFusion(Object.values(rankings));

    // Build final results
    const results = [];
    for (const [nodeId, data] of nodeMap) {
      results.push({
        node: data.node,
        score: fusedScores.get(nodeId) || 0,
        sources: data.sources,
        bm25Score: data.scores.bm25_node,
        vectorScore: data.scores.vector_node,
        matched_queries: [...data.variantMatches]
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  } else {
    // Weighted combination
    const results = [];
    for (const [nodeId, data] of nodeMap) {
      let finalScore = 0;
      const scores = data.scores;

      // Weight different sources
      if (scores.bm25_node) finalScore += bm25Weight * scores.bm25_node;
      if (scores.vector_node) finalScore += vectorWeight * scores.vector_node;
      if (scores.bm25_chunk) finalScore += 0.3 * scores.bm25_chunk;
      if (scores.vector_chunk) finalScore += 0.4 * scores.vector_chunk;
      if (scores.name_match) finalScore += 0.5 * scores.name_match;
      if (scores.alias_match) finalScore += 0.45 * scores.alias_match;
      if (scores.doc_title) finalScore += 0.35 * scores.doc_title;

      results.push({
        node: data.node,
        score: finalScore,
        sources: data.sources,
        matched_queries: [...data.variantMatches]
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

/**
 * Hybrid recall for chunks
 * @param {string} query - Search query
 * @param {number} limit - Number of results
 * @param {object} options - Options
 * @returns {Promise<Array<{chunk: object, score: number, sources: string[]}>>}
 */
export async function hybridRecallChunks(query, limit = 50, options = {}) {
  const { vectorThreshold = 0.4 } = options;

  // Get BM25 results
  const bm25Results = bm25RecallChunks(query, limit * 2);

  // Get vector results
  let vectorResults = [];
  try {
    vectorResults = await vectorRecallChunks(query, limit * 2, vectorThreshold);
    logger.debug(`Vector chunk recall found ${vectorResults.length} candidates`);
  } catch (err) {
    logger.warn("Vector chunk search failed, using BM25 only:", err.message);
  }

  // Use RRF to combine
  const bm25Ranking = bm25Results.map(r => ({ id: String(r.chunk.id), score: r.bm25 }));
  const vectorRanking = vectorResults.map(r => ({ id: String(r.chunk.id), score: r.similarity }));

  const fusedScores = reciprocalRankFusion([bm25Ranking, vectorRanking]);

  // Build result map
  const chunkMap = new Map();
  for (const r of bm25Results) {
    chunkMap.set(String(r.chunk.id), { chunk: r.chunk, sources: ["bm25"] });
  }
  for (const r of vectorResults) {
    const id = String(r.chunk.id);
    if (chunkMap.has(id)) {
      chunkMap.get(id).sources.push("vector");
    } else {
      chunkMap.set(id, { chunk: r.chunk, sources: ["vector"] });
    }
  }

  // Combine and sort
  const results = [];
  for (const [chunkId, data] of chunkMap) {
    results.push({
      chunk: data.chunk,
      score: fusedScores.get(chunkId) || 0,
      sources: data.sources
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Smart recall with query expansion for better coverage
 * Uses LLM to expand query with synonyms and related terms
 * @param {string} query - Search query
 * @param {number} limit - Number of results
 * @param {object} options - Options
 * @returns {Promise<Array<{node: object, score: number, sources: string[]}>>}
 */
export async function smartRecallNodes(query, limit = 30, options = {}) {
  const { useExpansion = true } = options;

  // Get expanded query terms
  let queries = [query];
  if (useExpansion) {
    try {
      queries = await expandQuery(query);
    } catch (err) {
      logger.warn("Query expansion failed, using original query");
    }
  }

  // Collect results from all query variants
  const nodeMap = new Map();

  for (const q of queries) {
    const results = await hybridRecallNodes(q, Math.ceil(limit / queries.length) + 5, {
      ...options,
      includeChunkSearch: true
    });

    for (const r of results) {
      if (!nodeMap.has(r.node.node_id)) {
        nodeMap.set(r.node.node_id, {
          node: r.node,
          score: r.score,
          sources: r.sources,
          matchedQueries: [q]
        });
      } else {
        const existing = nodeMap.get(r.node.node_id);
        // Boost score for nodes matching multiple query variants
        existing.score = Math.max(existing.score, r.score) * 1.1;
        existing.sources = [...new Set([...existing.sources, ...r.sources])];
        if (!existing.matchedQueries.includes(q)) {
          existing.matchedQueries.push(q);
        }
      }
    }
  }

  // Convert to array and sort
  const results = [...nodeMap.values()];
  results.sort((a, b) => b.score - a.score);

  logger.debug(`Smart recall found ${results.length} nodes from ${queries.length} query variants`);
  return results.slice(0, limit);
}

/**
 * Export query expansion for external use
 */
export { expandQuery };

/**
 * Search nodes by aliases
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Array<{node: object, matchedAlias: string}>}
 */
export function searchByAliases(query, limit = 10) {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return [];
  const queryTokens = extractSearchTerms(queryLower, { maxTerms: 20 });

  refreshAliasCache();

  const matches = [];

  // Exact match fast path
  const exactEntries = aliasCache.exactMap.get(queryLower) || [];
  for (const entry of exactEntries) {
    matches.push({
      node: entry.node,
      matchedAlias: entry.alias,
      score: 0.9
    });
  }

  // Partial match fallback (in-memory scan)
  const candidateSet = new Set();
  const maxCandidates = Math.max(limit * 20, 100);
  for (const token of queryTokens) {
    const bucket = aliasCache.tokenIndex.get(token) || [];
    for (const entry of bucket) {
      candidateSet.add(entry);
      if (candidateSet.size >= maxCandidates) break;
    }
    if (candidateSet.size >= maxCandidates) break;
  }

  const scanEntries = candidateSet.size > 0 ? [...candidateSet] : aliasCache.entries;
  const maxScan = Math.max(limit * 8, 40);
  for (const entry of scanEntries) {
    if (matches.length >= maxScan) break;
    if (entry.aliasLower === queryLower) continue;
    if (entry.aliasLower.includes(queryLower) || queryLower.includes(entry.aliasLower)) {
      matches.push({
        node: entry.node,
        matchedAlias: entry.alias,
        score: 0.6
      });
      continue;
    }

    if (queryTokens.length > 0) {
      let overlap = 0;
      for (const token of queryTokens) {
        if (token.length < 2) continue;
        if (entry.aliasLower.includes(token) || token.includes(entry.aliasLower)) {
          overlap++;
        }
      }
      if (overlap > 0) {
        const score = Math.min(0.75, 0.45 + overlap * 0.1);
        matches.push({
          node: entry.node,
          matchedAlias: entry.alias,
          score
        });
      }
    }
  }

  // Sort by score and deduplicate
  matches.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const unique = [];
  for (const m of matches) {
    if (!seen.has(m.node.node_id)) {
      seen.add(m.node.node_id);
      unique.push(m);
    }
  }

  logger.debug(`Alias search found ${unique.length} matches for "${query}"`);
  return unique.slice(0, limit);
}

/**
 * Enrich retrieval results with hierarchical context
 * When a node is found, also include relevant ancestors and children
 * @param {Array<{node: object, score: number}>} results - Initial retrieval results
 * @param {object} options - Options
 * @returns {Array<{node: object, score: number, hierarchy: object}>}
 */
export function enrichWithHierarchy(results, options = {}) {
  const {
    includeAncestors = true,
    includeChildren = true,
    includeSiblings = false,
    ancestorBoost = 0.3,  // Score multiplier for ancestors
    childBoost = 0.5,     // Score multiplier for children
    siblingBoost = 0.2,   // Score multiplier for siblings
    maxAncestors = 2,
    maxChildren = 5,
    maxSiblings = 3
  } = options;

  const enrichedMap = new Map();
  const addNode = (node, score, source, relationship = 'direct') => {
    const sources = Array.isArray(source) ? source : [source];
    const existing = enrichedMap.get(node.node_id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      for (const s of sources) {
        if (!existing.sources.includes(s)) {
          existing.sources.push(s);
        }
      }
    } else {
      enrichedMap.set(node.node_id, {
        node,
        score,
        sources: sources.filter(Boolean),
        relationship
      });
    }
  };

  for (const result of results) {
    const { node, score, sources = ['direct'] } = result;

    // Add the direct match
    addNode(node, score, sources.length > 0 ? sources : ['direct'], 'direct');

    // Add ancestors (parent, grandparent) with reduced scores
    if (includeAncestors) {
      try {
        const ancestors = getAncestors(node.node_id);
        for (let i = 0; i < Math.min(ancestors.length, maxAncestors); i++) {
          const ancestorScore = score * ancestorBoost * (1 / (i + 1));
          addNode(ancestors[i], ancestorScore, 'hierarchy_ancestor', 'ancestor');
        }
      } catch (err) {
        logger.warn(`Failed to get ancestors for ${node.node_id}:`, err.message);
      }
    }

    // Add children with reduced scores
    if (includeChildren) {
      try {
        const children = getChildren(node.node_id);
        for (let i = 0; i < Math.min(children.length, maxChildren); i++) {
          const childScore = score * childBoost;
          addNode(children[i], childScore, 'hierarchy_child', 'child');
        }
      } catch (err) {
        logger.warn(`Failed to get children for ${node.node_id}:`, err.message);
      }
    }

    // Add siblings with reduced scores
    if (includeSiblings) {
      try {
        const siblings = getSiblings(node.node_id);
        for (let i = 0; i < Math.min(siblings.length, maxSiblings); i++) {
          const siblingScore = score * siblingBoost;
          addNode(siblings[i], siblingScore, 'hierarchy_sibling', 'sibling');
        }
      } catch (err) {
        logger.warn(`Failed to get siblings for ${node.node_id}:`, err.message);
      }
    }
  }

  // Convert to array and sort by score
  const enriched = [...enrichedMap.values()];
  enriched.sort((a, b) => b.score - a.score);

  logger.debug(`Hierarchy enrichment: ${results.length} -> ${enriched.length} nodes`);
  return enriched;
}

/**
 * Hierarchical hybrid recall - combines standard retrieval with hierarchy expansion
 * @param {string} query - Search query
 * @param {number} limit - Number of results
 * @param {object} options - Options
 * @returns {Promise<Array>}
 */
export async function hierarchicalRecallNodes(query, limit = 30, options = {}) {
  const {
    useHierarchy = true,
    useAliases = true,
    useMultilingualVariants = true,
    maxQueryVariants = 4,
    useExpansion = true,
    ...hybridOptions
  } = options;

  const variantQueries = useMultilingualVariants
    ? await buildRetrievalQueryVariants(query, {
      maxVariants: maxQueryVariants,
      useExpansion,
      useAliasPivot: useAliases
    })
    : [{ text: query, weight: 1, lang: detectLanguage(query), sources: ["original"] }];

  // Start with standard hybrid recall
  const baseResults = await hybridRecallNodes(query, limit, {
    ...hybridOptions,
    useMultilingualVariants,
    queryVariants: variantQueries,
    maxQueryVariants,
    useExpansion
  });

  // Also search by aliases
  if (useAliases) {
    const aliasVariants = variantQueries.length > 0 ? variantQueries : [{ text: query, weight: 1 }];
    for (const variant of aliasVariants.slice(0, maxQueryVariants)) {
      const aliasMatches = searchByAliases(variant.text, 10);
      for (const match of aliasMatches) {
        const weightedAliasScore = (match.score || 0.6) * (variant.weight || 1);
        const existing = baseResults.find(r => r.node.node_id === match.node.node_id);
        if (existing) {
          existing.score = Math.max(existing.score, existing.score * (1 + weightedAliasScore * 0.25));
          existing.sources = [...new Set([...(existing.sources || []), 'alias'])];
        } else {
          baseResults.push({
            node: match.node,
            score: weightedAliasScore * 0.75,  // Alias-only matches get moderate score
            sources: ['alias'],
            matched_queries: [variant.text]
          });
        }
      }
    }
  }

  // Enrich with hierarchical context
  if (useHierarchy) {
    const enriched = enrichWithHierarchy(baseResults, {
      includeAncestors: true,
      includeChildren: true,
      includeSiblings: true,
      ancestorBoost: 0.25,
      childBoost: 0.4,
      siblingBoost: 0.2
    });

    // Re-sort and limit
    enriched.sort((a, b) => b.score - a.score);
    return enriched.slice(0, limit);
  }

  return baseResults.slice(0, limit);
}

/**
 * Get chunks from a node and its children for comprehensive context
 * @param {string} nodeId - Node ID
 * @param {number} maxChunks - Maximum chunks to return
 * @returns {Array} Chunks with source info
 */
export function getHierarchicalChunks(nodeId, maxChunks = 20) {
  const chunks = [];

  // Get chunks from the node itself
  const nodeChunks = db.prepare(`
    SELECT c.*, n.name as node_name
    FROM chunks c
    JOIN nodes n ON n.node_id = c.node_id
    WHERE c.node_id = ? AND c.status = 'active'
    ORDER BY c.authority_level ASC, c.uploaded_at DESC
    LIMIT ?
  `).all(nodeId, Math.ceil(maxChunks / 2));

  for (const c of nodeChunks) {
    chunks.push({
      ...c,
      source: 'direct',
      keywords: safeJson(c.keywords_json, [])
    });
  }

  // Get chunks from children
  const children = getChildren(nodeId);
  const chunksPerChild = Math.max(2, Math.floor((maxChunks - chunks.length) / Math.max(children.length, 1)));

  for (const child of children) {
    if (chunks.length >= maxChunks) break;

    const childChunks = db.prepare(`
      SELECT c.*, n.name as node_name
      FROM chunks c
      JOIN nodes n ON n.node_id = c.node_id
      WHERE c.node_id = ? AND c.status = 'active'
      ORDER BY c.authority_level ASC, c.uploaded_at DESC
      LIMIT ?
    `).all(child.node_id, chunksPerChild);

    for (const c of childChunks) {
      chunks.push({
        ...c,
        source: 'child',
        keywords: safeJson(c.keywords_json, [])
      });
    }
  }

  return chunks.slice(0, maxChunks);
}
