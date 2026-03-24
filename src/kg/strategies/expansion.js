/**
 * Query expansion and multilingual variant building.
 */

import { callLLM, isLlmConfigured } from "../../utils/llm.js";
import { parseLLMJson } from "../../utils/parseJSON.js";
import { queryLogger as logger } from "../../utils/logger.js";
import { detectLanguage } from "../../utils/langDetect.js";
import { getNode } from "../graphTraversal.js";
import { normalizeVariantText, addQueryVariant } from "./utils.js";
import { searchByAliases } from "./aliases.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { safeJson } from "../../db/db.js";
import { getCustomPrompt } from "../../prompts/promptManager.js";

// LRU-style cache for LLM expansion results
const queryExpansionCache = new Map();
const EXPANSION_CACHE_MAX = 500;

// ── Acronym resolution ───────────────────────────────────────────────────────
// Cached index of uppercase acronyms → node names, built from aliases + keywords.
// Invalidated when node count/updated_at changes.

let _acronymCache = null;
let _acronymCacheKey = null;

function getAcronymIndex() {
  try {
    const countAndUpdate = NodeRepo.getCountAndMaxUpdatedAt();
    const cacheKey = `${countAndUpdate.count}:${countAndUpdate.max_updated_at}`;
    if (_acronymCache && _acronymCacheKey === cacheKey) return _acronymCache;

    const index = new Map();
    const allNodes = NodeRepo.getAllForAcronymIndex();
    for (const node of allNodes) {
      const aliases = safeJson(node.aliases_json, []);
      const keywords = safeJson(node.keywords_json, []);
      const sources = [...aliases, ...keywords];
      for (const term of sources) {
        const upper = String(term).trim().toUpperCase();
        if (/^[A-Z]{2,5}$/.test(upper)) {
          if (!index.has(upper)) index.set(upper, []);
          if (!index.get(upper).some(e => e.nodeId === node.node_id)) {
            index.get(upper).push({
              nodeName: node.name, nodeId: node.node_id,
              quality: node.quality_score ?? 0.5
            });
          }
        }
      }
    }
    _acronymCache = index;
    _acronymCacheKey = cacheKey;
    return index;
  } catch (err) {
    logger.warn("Acronym index build failed:", err.message);
    return new Map();
  }
}

export function expandAcronyms(query) {
  // Match short alpha tokens case-insensitively ("hpi" and "HPI" both resolve)
  const tokens = query.match(/\b[a-zA-Z]{2,5}\b/g) || [];
  const acronyms = [...new Set(tokens.map(t => t.toUpperCase()))].filter(t => /^[A-Z]{2,5}$/.test(t));
  if (acronyms.length === 0) return [];

  const index = getAcronymIndex();
  const expansions = [];
  for (const acronym of acronyms) {
    const matches = index.get(acronym);
    if (!matches || matches.length === 0) continue;

    if (matches.length === 1) {
      expansions.push({ acronym, expansion: matches[0].nodeName, source: 'acronym' });
      // Also add longest descriptive alias if available
      try {
        const aliasesJson = NodeRepo.getAliasesJson?.(matches[0].nodeId);
        const nodeAliases = safeJson(aliasesJson || '[]', []);
        const longestAlias = nodeAliases
          .filter(a => a.length > matches[0].nodeName.length + 3)
          .sort((a, b) => b.length - a.length)[0];
        if (longestAlias) {
          expansions.push({ acronym, expansion: longestAlias, source: 'acronym_alias' });
        }
      } catch { /* non-fatal */ }
    } else {
      // Multiple matches — pick highest quality only if clearly dominant
      const sorted = [...matches].sort((a, b) => b.quality - a.quality);
      if (sorted[0].quality - (sorted[1]?.quality ?? 0) >= 0.15) {
        expansions.push({ acronym, expansion: sorted[0].nodeName, source: 'acronym' });
      }
      // Otherwise skip — ambiguous acronym
    }
  }
  return expansions;
}

export async function expandQuery(query) {
  if (queryExpansionCache.has(query)) return queryExpansionCache.get(query);

  if (!isLlmConfigured()) return [query];

  try {
    const prompt = getCustomPrompt('queryExpansion', { query }) ??
      `Given this search query for a knowledge base, generate 3-5 alternative search terms that would find the same information. Include:
- Synonyms and paraphrases (e.g., "temperature" → "hypothermia", "thermal")
- Acronym expansions if the query contains acronyms (e.g., "PTO" → "paid time off")
- Related technical/domain terms (e.g., "docking" → "dilator insertion")
- Both formal and informal variants

Query: "${query}"

Return ONLY a JSON array of strings:
["term1", "term2", "term3"]`;

    const text = await callLLM({ prompt, taskName: 'query_expansion' }) ?? "[]";
    const terms = await parseLLMJson(text, 'array', { context: 'query_expansion', fallback: [] });
    const allTerms = [query, ...terms.filter(t => typeof t === "string" && t.length > 0)];
    const uniqueTerms = [...new Set(allTerms)];

    if (queryExpansionCache.size >= EXPANSION_CACHE_MAX) {
      queryExpansionCache.delete(queryExpansionCache.keys().next().value);
    }
    queryExpansionCache.set(query, uniqueTerms);
    logger.debug(`Query expansion: "${query}" -> ${JSON.stringify(uniqueTerms)}`);
    return uniqueTerms;
  } catch (err) {
    logger.warn("Query expansion failed:", err.message);
    return [query];
  }
}

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

  const punctuationStripped = baseQuery.replace(/[""''"'`]/g, "").trim();
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
        addQueryVariant(variants, seen, cleaned,
          isCrossLang ? 0.92 : 0.82,
          isCrossLang ? "translation" : "expansion");
      }
    } catch (err) {
      logger.warn("Failed to build LLM query variants:", err.message);
    }
  }

  if (useAliasPivot) {
    try {
      const aliasMatches = searchByAliases(baseQuery, aliasLimit);
      for (const match of aliasMatches) {
        addQueryVariant(variants, seen, match.matchedAlias,
          Math.min(0.92, (match.score || 0.6) + 0.1), "alias_match");
        addQueryVariant(variants, seen, match.node?.name,
          detectLanguage(match.node?.name || "") !== baseLang ? 0.9 : 0.82, "node_name");

        const fullNode = match.node?.node_id ? getNode(match.node.node_id) : null;
        const aliases = Array.isArray(fullNode?.aliases) ? fullNode.aliases : [];
        for (const alias of aliases.slice(0, 3)) {
          addQueryVariant(variants, seen, alias,
            detectLanguage(alias) !== baseLang ? 0.88 : 0.78, "node_alias");
        }
      }
    } catch (err) {
      logger.warn("Alias pivot for query variants failed:", err.message);
    }
  }

  // Acronym resolution — deterministic, no LLM
  try {
    const acronymExpansions = expandAcronyms(baseQuery);
    for (const { expansion } of acronymExpansions) {
      addQueryVariant(variants, seen, expansion, 0.85, "acronym_expansion");
    }
    if (acronymExpansions.length > 0) {
      logger.debug(`Acronym expansion: ${acronymExpansions.map(e => `${e.acronym}→${e.expansion}`).join(', ')}`);
    }
  } catch (err) {
    logger.warn("Acronym expansion failed:", err.message);
  }

  variants.sort((a, b) => b.weight - a.weight || a.text.length - b.text.length);
  return variants.slice(0, maxVariants).map(v => ({
    text: v.text,
    weight: v.weight,
    lang: v.lang,
    sources: v.sources
  }));
}
