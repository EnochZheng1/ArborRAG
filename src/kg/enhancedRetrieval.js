/**
 * Enhanced Retrieval System
 *
 * Leverages hierarchy, entities, and facts for better coverage and accuracy:
 * 1. Entity-aware retrieval - finds chunks mentioning query entities
 * 2. Fact-first retrieval - searches facts for direct answers
 * 3. Hierarchical expansion - adds parent/sibling/child context
 * 4. Multi-hop retrieval - follows entity relationships
 */

import { db, safeJson } from "../db/db.js";
import { queryLogger as logger } from "../utils/logger.js";
import { generateQueryEmbedding } from "../embedding/embedder.js";
import { cosineSimilarity } from "../embedding/embedder.js";
import { getNode, getAncestors, getChildren, getSiblings } from "./graphTraversal.js";

/**
 * Extract potential entity mentions from a query
 * @param {string} query - User query
 * @returns {string[]} Potential entity names
 */
export function extractQueryEntities(query) {
  const entities = [];

  // Pattern 1: Quoted text
  const quotedPattern = /["「『《"']([^"」』》"']+)["」』》"']/g;
  let match;
  while ((match = quotedPattern.exec(query)) !== null) {
    entities.push(match[1].trim());
  }

  // Pattern 2: Proper nouns (capitalized words in English)
  const properNouns = query.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || [];
  entities.push(...properNouns);

  // Pattern 3: Chinese noun phrases (simple heuristic)
  const chineseNouns = query.match(/[\u4e00-\u9fa5]{2,8}(?:星|球|山|河|海|国|省|市|区|县|人|物|品|机|器|法|论|学)/g) || [];
  entities.push(...chineseNouns);

  // Pattern 4: Technical terms (words with numbers or special patterns)
  const techTerms = query.match(/\b[A-Za-z]+[-]?\d+[A-Za-z]*\b/g) || [];
  entities.push(...techTerms);

  return [...new Set(entities)];
}

/**
 * Find entities in the knowledge base matching query terms
 * @param {string[]} queryEntities - Entity names from query
 * @param {object} options - Search options
 * @returns {Array} Matching entities with scores
 */
export function findMatchingEntities(queryEntities, options = {}) {
  const { fuzzyMatch = true, limit = 20 } = options;

  if (!queryEntities.length) return [];

  const results = [];
  const seenIds = new Set();

  for (const entityName of queryEntities) {
    // Exact match
    const exactMatches = db.prepare(`
      SELECT e.*,
             (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = e.id) as mention_count
      FROM entities e
      WHERE e.name = ? OR e.normalized_name = ?
    `).all(entityName, entityName.toLowerCase());

    for (const e of exactMatches) {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        results.push({ ...e, entity_type: e.type, match_score: 1.0, match_type: 'exact' });
      }
    }

    // Fuzzy match (LIKE)
    if (fuzzyMatch) {
      const fuzzyMatches = db.prepare(`
        SELECT e.*,
               (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = e.id) as mention_count
        FROM entities e
        WHERE e.name LIKE ? OR e.normalized_name LIKE ?
        LIMIT ?
      `).all(`%${entityName}%`, `%${entityName.toLowerCase()}%`, limit);

      for (const e of fuzzyMatches) {
        if (!seenIds.has(e.id)) {
          seenIds.add(e.id);
          // Score based on how close the match is
          const score = entityName.length / Math.max(e.name.length, entityName.length);
          results.push({ ...e, entity_type: e.type, match_score: score * 0.8, match_type: 'fuzzy' });
        }
      }
    }

    // Check aliases
    const aliasMatches = db.prepare(`
      SELECT e.*,
             (SELECT COUNT(*) FROM entity_mentions WHERE entity_id = e.id) as mention_count
      FROM entities e
      WHERE e.aliases_json LIKE ?
      LIMIT ?
    `).all(`%${entityName}%`, limit);

    for (const e of aliasMatches) {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        results.push({ ...e, entity_type: e.type, match_score: 0.7, match_type: 'alias' });
      }
    }
  }

  // Sort by match score and mention count
  results.sort((a, b) => {
    const scoreA = a.match_score * (1 + Math.log(a.mention_count + 1) * 0.1);
    const scoreB = b.match_score * (1 + Math.log(b.mention_count + 1) * 0.1);
    return scoreB - scoreA;
  });

  return results.slice(0, limit);
}

/**
 * Retrieve chunks that mention specific entities
 * @param {number[]} entityIds - Entity IDs to search for
 * @param {object} options - Retrieval options
 * @returns {Array} Chunks with entity context
 */
export function retrieveChunksByEntities(entityIds, options = {}) {
  const { limit = 30, includeContext = true } = options;

  if (!entityIds.length) return [];

  const placeholders = entityIds.map(() => '?').join(',');

  const chunks = db.prepare(`
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
    WHERE em.entity_id IN (${placeholders})
      AND c.status = 'active'
    ORDER BY em.mention_count DESC, c.authority_level ASC
    LIMIT ?
  `).all(...entityIds, limit);

  return chunks.map(c => ({
    id: c.id,
    content: c.content_clean,
    doc_title: c.doc_title,
    node_id: c.node_id,
    node_name: c.node_name,
    node_level: c.node_level,
    entity_name: c.entity_name,
    entity_type: c.entity_type,
    mention_context: c.mention_context,
    authority_level: c.authority_level,
    source: 'entity_mention'
  }));
}

/**
 * Search facts for direct answers
 * @param {string} query - User query
 * @param {object} options - Search options
 * @returns {Array} Matching facts with evidence
 */
export function searchFacts(query, options = {}) {
  const { limit = 10, minConfidence = 0.5 } = options;

  // Search facts by content similarity (BM25-like)
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);

  if (!queryTerms.length) return [];

  // Build search conditions
  const conditions = queryTerms.map(() => 'f.content LIKE ?').join(' OR ');
  const params = queryTerms.map(t => `%${t}%`);

  const facts = db.prepare(`
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

  // Get evidence for each fact
  return facts.map(fact => {
    const evidence = db.prepare(`
      SELECT c.id, c.content_clean, c.doc_title, c.node_id,
             fe.relevance_score
      FROM fact_evidence fe
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE fe.fact_id = ?
      ORDER BY fe.relevance_score DESC
      LIMIT 3
    `).all(fact.id);

    return {
      ...fact,
      evidence,
      source: 'fact_search'
    };
  });
}

/**
 * Expand retrieval with hierarchical context
 * @param {Array} chunks - Initial retrieved chunks
 * @param {object} options - Expansion options
 * @returns {Array} Chunks with hierarchical context added
 */
export function expandWithHierarchy(chunks, options = {}) {
  const {
    includeParent = true,
    includeSiblings = false,
    includeChildren = false,
    maxParentChunks = 3,
    maxSiblingChunks = 2,
    maxChildChunks = 5
  } = options;

  if (!chunks.length) return chunks;

  const expandedChunks = [...chunks];
  const seenChunkIds = new Set(chunks.map(c => c.id));
  const processedNodeIds = new Set();

  for (const chunk of chunks) {
    if (!chunk.node_id || processedNodeIds.has(chunk.node_id)) continue;
    processedNodeIds.add(chunk.node_id);

    const node = getNode(chunk.node_id);
    if (!node) continue;

    // Add parent context
    if (includeParent && node.parent_id) {
      const parentChunks = db.prepare(`
        SELECT c.*, n.name as node_name, n.level as node_level
        FROM chunks c
        JOIN nodes n ON c.node_id = n.node_id
        WHERE c.node_id = ? AND c.status = 'active'
        ORDER BY c.authority_level ASC, c.chunk_index ASC
        LIMIT ?
      `).all(node.parent_id, maxParentChunks);

      for (const pc of parentChunks) {
        if (!seenChunkIds.has(pc.id)) {
          seenChunkIds.add(pc.id);
          expandedChunks.push({
            id: pc.id,
            content: pc.content_clean,
            doc_title: pc.doc_title,
            node_id: pc.node_id,
            node_name: pc.node_name,
            node_level: pc.node_level,
            authority_level: pc.authority_level,
            source: 'parent_context',
            hierarchy_relation: 'parent'
          });
        }
      }
    }

    // Add sibling context (for comparison queries)
    if (includeSiblings && node.parent_id) {
      const siblingNodes = getSiblings(chunk.node_id);
      for (const sibling of siblingNodes.slice(0, 3)) {
        const siblingChunks = db.prepare(`
          SELECT c.*, n.name as node_name, n.level as node_level
          FROM chunks c
          JOIN nodes n ON c.node_id = n.node_id
          WHERE c.node_id = ? AND c.status = 'active'
          ORDER BY c.authority_level ASC
          LIMIT ?
        `).all(sibling.node_id, maxSiblingChunks);

        for (const sc of siblingChunks) {
          if (!seenChunkIds.has(sc.id)) {
            seenChunkIds.add(sc.id);
            expandedChunks.push({
              id: sc.id,
              content: sc.content_clean,
              doc_title: sc.doc_title,
              node_id: sc.node_id,
              node_name: sc.node_name,
              node_level: sc.node_level,
              authority_level: sc.authority_level,
              source: 'sibling_context',
              hierarchy_relation: 'sibling'
            });
          }
        }
      }
    }

    // Add child context (for aggregation queries)
    if (includeChildren) {
      const children = getChildren(chunk.node_id);
      for (const child of children.slice(0, 5)) {
        const childChunks = db.prepare(`
          SELECT c.*, n.name as node_name, n.level as node_level
          FROM chunks c
          JOIN nodes n ON c.node_id = n.node_id
          WHERE c.node_id = ? AND c.status = 'active'
          ORDER BY c.authority_level ASC
          LIMIT ?
        `).all(child.node_id, maxChildChunks);

        for (const cc of childChunks) {
          if (!seenChunkIds.has(cc.id)) {
            seenChunkIds.add(cc.id);
            expandedChunks.push({
              id: cc.id,
              content: cc.content_clean,
              doc_title: cc.doc_title,
              node_id: cc.node_id,
              node_name: cc.node_name,
              node_level: cc.node_level,
              authority_level: cc.authority_level,
              source: 'child_context',
              hierarchy_relation: 'child'
            });
          }
        }
      }
    }
  }

  return expandedChunks;
}

/**
 * Multi-hop retrieval following entity relationships
 * @param {string} query - User query
 * @param {number[]} seedEntityIds - Starting entity IDs
 * @param {object} options - Options
 * @returns {Array} Chunks from related entities
 */
export function multiHopRetrieval(query, seedEntityIds, options = {}) {
  const { maxHops = 2, maxEntitiesPerHop = 5, limit = 20 } = options;

  if (!seedEntityIds.length) return [];

  const visitedEntities = new Set(seedEntityIds);
  const allChunks = [];
  let currentEntities = seedEntityIds;

  for (let hop = 0; hop < maxHops; hop++) {
    // Find related entities through shared facts
    const placeholders = currentEntities.map(() => '?').join(',');

    const relatedEntities = db.prepare(`
      SELECT DISTINCT e2.id, e2.name, e2.entity_type,
             COUNT(*) as shared_facts
      FROM entity_facts ef1
      JOIN entity_facts ef2 ON ef1.fact_id = ef2.fact_id
      JOIN entities e2 ON ef2.entity_id = e2.id
      WHERE ef1.entity_id IN (${placeholders})
        AND e2.id NOT IN (${placeholders})
      GROUP BY e2.id
      ORDER BY shared_facts DESC
      LIMIT ?
    `).all(...currentEntities, ...currentEntities, maxEntitiesPerHop);

    if (!relatedEntities.length) break;

    // Get chunks for related entities
    const newEntityIds = relatedEntities
      .filter(e => !visitedEntities.has(e.id))
      .map(e => e.id);

    if (!newEntityIds.length) break;

    newEntityIds.forEach(id => visitedEntities.add(id));

    const chunks = retrieveChunksByEntities(newEntityIds, { limit: limit / maxHops });
    chunks.forEach(c => {
      c.hop_distance = hop + 1;
      c.source = `multi_hop_${hop + 1}`;
    });
    allChunks.push(...chunks);

    currentEntities = newEntityIds;
  }

  return allChunks;
}

/**
 * Unified enhanced retrieval combining all methods
 * @param {string} query - User query
 * @param {object} options - Retrieval options
 * @returns {Promise<object>} Combined retrieval results
 */
export async function enhancedRetrieval(query, options = {}) {
  const {
    useEntities = true,
    useFacts = true,
    useHierarchy = true,
    useMultiHop = false,
    queryType = 'simple_lookup',
    limit = 30
  } = options;

  logger.debug(`Enhanced retrieval for: "${query.slice(0, 50)}..."`);

  const results = {
    chunks: [],
    facts: [],
    entities: [],
    sources: new Set()
  };

  // Step 1: Extract and match entities from query
  let matchedEntityIds = [];
  if (useEntities) {
    const queryEntities = extractQueryEntities(query);
    logger.debug(`Extracted query entities: ${queryEntities.join(', ')}`);

    const matchedEntities = findMatchingEntities(queryEntities);
    results.entities = matchedEntities;
    matchedEntityIds = matchedEntities.map(e => e.id);

    if (matchedEntityIds.length > 0) {
      // Get chunks mentioning these entities
      const entityChunks = retrieveChunksByEntities(matchedEntityIds, { limit: limit / 2 });
      results.chunks.push(...entityChunks);
      results.sources.add('entity_retrieval');
      logger.debug(`Entity retrieval found ${entityChunks.length} chunks`);
    }
  }

  // Step 2: Search facts for direct answers
  if (useFacts) {
    const facts = searchFacts(query, { limit: 5 });
    results.facts = facts;

    // Add fact evidence chunks
    for (const fact of facts) {
      for (const ev of fact.evidence || []) {
        if (!results.chunks.find(c => c.id === ev.id)) {
          results.chunks.push({
            id: ev.id,
            content: ev.content_clean,
            doc_title: ev.doc_title,
            node_id: ev.node_id,
            source: 'fact_evidence',
            fact_content: fact.content,
            fact_confidence: fact.confidence
          });
        }
      }
    }

    if (facts.length > 0) {
      results.sources.add('fact_retrieval');
      logger.debug(`Fact retrieval found ${facts.length} facts`);
    }
  }

  // Step 3: Multi-hop retrieval for reasoning queries
  if (useMultiHop && matchedEntityIds.length > 0 && queryType === 'reasoning') {
    const multiHopChunks = multiHopRetrieval(query, matchedEntityIds, { maxHops: 2 });
    for (const c of multiHopChunks) {
      if (!results.chunks.find(existing => existing.id === c.id)) {
        results.chunks.push(c);
      }
    }
    if (multiHopChunks.length > 0) {
      results.sources.add('multi_hop');
      logger.debug(`Multi-hop retrieval found ${multiHopChunks.length} chunks`);
    }
  }

  // Step 4: Expand with hierarchy
  if (useHierarchy && results.chunks.length > 0) {
    const hierarchyOptions = {
      includeParent: true,
      includeSiblings: queryType === 'comparison',
      includeChildren: queryType === 'aggregation'
    };

    const beforeCount = results.chunks.length;
    results.chunks = expandWithHierarchy(results.chunks, hierarchyOptions);

    if (results.chunks.length > beforeCount) {
      results.sources.add('hierarchy_expansion');
      logger.debug(`Hierarchy expansion added ${results.chunks.length - beforeCount} chunks`);
    }
  }

  // Deduplicate and limit
  const seenIds = new Set();
  results.chunks = results.chunks.filter(c => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  }).slice(0, limit);

  results.sources = [...results.sources];

  logger.info(`Enhanced retrieval: ${results.chunks.length} chunks, ${results.facts.length} facts, ${results.entities.length} entities`);

  return results;
}

/**
 * Build context string from enhanced retrieval results
 * @param {object} retrievalResults - Results from enhancedRetrieval
 * @param {object} options - Formatting options
 * @returns {string} Formatted context for LLM
 */
export function buildEnhancedContext(retrievalResults, options = {}) {
  const { maxLength = 8000, includeFacts = true, includeEntityInfo = true } = options;

  let context = '';

  // Add matched entities summary
  if (includeEntityInfo && retrievalResults.entities.length > 0) {
    context += '[Identified Entities]\n';
    for (const entity of retrievalResults.entities.slice(0, 5)) {
      context += `- ${entity.name} (${entity.entity_type || 'unknown type'})\n`;
    }
    context += '\n';
  }

  // Add relevant facts
  if (includeFacts && retrievalResults.facts.length > 0) {
    context += '[Relevant Facts]\n';
    for (const fact of retrievalResults.facts.slice(0, 5)) {
      const confidence = Math.round(fact.confidence * 100);
      context += `- ${fact.content} [${confidence}% confidence]\n`;
    }
    context += '\n';
  }

  // Add chunks grouped by source
  context += '[Retrieved Content]\n';

  // Group chunks by source type
  const chunksBySource = {};
  for (const chunk of retrievalResults.chunks) {
    const source = chunk.source || 'direct';
    if (!chunksBySource[source]) {
      chunksBySource[source] = [];
    }
    chunksBySource[source].push(chunk);
  }

  // Format chunks
  for (const [source, chunks] of Object.entries(chunksBySource)) {
    for (const chunk of chunks) {
      if (context.length >= maxLength) break;

      const meta = [
        chunk.doc_title && `Source: ${chunk.doc_title}`,
        chunk.node_name && `Node: ${chunk.node_name}`,
        chunk.hierarchy_relation && `Relation: ${chunk.hierarchy_relation}`,
        chunk.entity_name && `Entity: ${chunk.entity_name}`
      ].filter(Boolean).join(' | ');

      context += `\n[Chunk ${chunk.id}] ${meta}\n${chunk.content}\n`;
    }
  }

  return context.slice(0, maxLength);
}

export default {
  extractQueryEntities,
  findMatchingEntities,
  retrieveChunksByEntities,
  searchFacts,
  expandWithHierarchy,
  multiHopRetrieval,
  enhancedRetrieval,
  buildEnhancedContext
};
