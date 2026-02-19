/**
 * Query expansion and multilingual variant building.
 */

import { GoogleGenAI } from "@google/genai";
import { queryLogger as logger } from "../../utils/logger.js";
import { detectLanguage } from "../../utils/langDetect.js";
import { getNode } from "../graphTraversal.js";
import { normalizeVariantText, addQueryVariant } from "./utils.js";
import { searchByAliases } from "./aliases.js";

// LRU-style cache for LLM expansion results
const queryExpansionCache = new Map();
const EXPANSION_CACHE_MAX = 500;

export async function expandQuery(query) {
  if (queryExpansionCache.has(query)) return queryExpansionCache.get(query);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [query];

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

  variants.sort((a, b) => b.weight - a.weight || a.text.length - b.text.length);
  return variants.slice(0, maxVariants).map(v => ({
    text: v.text,
    weight: v.weight,
    lang: v.lang,
    sources: v.sources
  }));
}
