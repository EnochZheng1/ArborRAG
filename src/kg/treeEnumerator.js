/**
 * Tree Enumeration Retrieval
 *
 * For enumeration queries ("How many plans?", "List all products"),
 * queries the tree directly instead of dumping chunks into the LLM.
 * Returns structured node data with count, names, summaries.
 */

import { safeJson } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { getChildren } from "./graphTraversal.js";
import { bm25RecallNodes, searchNodesByName } from "./recallNodes.js";
import { queryLogger as logger } from "../utils/logger.js";

/**
 * Extract the noun/topic the user is asking about from an enumeration query.
 * @param {string} query
 * @returns {string} topic term to search for
 */
function extractEnumerationTopic(query) {
  // Strip enumeration phrasing to isolate the topic noun
  let topic = query;

  // English patterns
  topic = topic.replace(/^(how\s+many|list\s+(all|the|every)|what\s+are\s+(the|all)|count\s+(the|all)?|enumerate\s+(the|all)?)\s*/i, '');
  topic = topic.replace(/\s*(do\s+you\s+have|are\s+there|do\s+we\s+have|does\s+it\s+have)\s*[?？]*$/i, '');
  topic = topic.replace(/\s*(types?\s+of|kinds?\s+of|categories\s+of)\s*/i, '');
  topic = topic.replace(/[?？。.!！]+$/g, '');

  // Chinese patterns
  topic = topic.replace(/^(有哪些|有多少|列出[所全]?[有部]?|列举|都有(?:什么|哪些)?)\s*/g, '');
  topic = topic.replace(/[有]?[几多少]+[种个类项]?\s*[?？]*$/g, '');
  topic = topic.replace(/[?？。.!！]+$/g, '');

  return topic.trim();
}

/**
 * Enumerate items from the tree structure.
 *
 * Strategy:
 * 1. Extract topic noun from query
 * 2. Search for matching parent nodes via BM25 + name search
 * 3. Get children of best parent
 * 4. Return structured result with count, names, summaries
 *
 * @param {string} query - User query
 * @returns {{ nodes: object[], count: number, parentNode: object, structured: boolean } | null}
 */
export function enumerateFromTree(query) {
  const topic = extractEnumerationTopic(query);
  if (!topic || topic.length < 2) {
    logger.debug(`[treeEnumerator] Could not extract topic from: "${query}"`);
    return null;
  }

  logger.debug(`[treeEnumerator] Extracted topic: "${topic}"`);

  // Search for candidate parent nodes
  const bm25Results = bm25RecallNodes(topic, 10);
  const nameResults = searchNodesByName(topic, 10);

  // Merge candidates, preferring name matches
  const seen = new Set();
  const candidates = [];

  for (const node of nameResults) {
    if (!seen.has(node.node_id)) {
      seen.add(node.node_id);
      candidates.push({ node, score: 2.0, source: 'name' });
    }
  }
  for (const r of bm25Results) {
    if (!seen.has(r.node.node_id)) {
      seen.add(r.node.node_id);
      candidates.push({ node: r.node, score: r.bm25 || 0, source: 'bm25' });
    }
  }

  if (candidates.length === 0) {
    logger.debug(`[treeEnumerator] No candidate nodes found for topic: "${topic}"`);
    return null;
  }

  // Try each candidate as a parent — pick the first one with 2+ children
  for (const candidate of candidates) {
    const children = getChildren(candidate.node.node_id);

    if (children.length >= 2) {
      // Enrich children with chunk counts
      const enriched = children.map(child => ({
        node_id: child.node_id,
        name: child.name,
        summary: child.node_summary || '',
        description: child.node_description || '',
        keywords: child.keywords || safeJson(child.keywords_json, []),
        level: child.level,
        chunk_count: ChunkRepo.getForNodeLimited(child.node_id, 20).length
      }));

      logger.debug(`[treeEnumerator] Found parent "${candidate.node.name}" with ${children.length} children`);

      return {
        nodes: enriched,
        count: enriched.length,
        parentNode: {
          node_id: candidate.node.node_id,
          name: candidate.node.name,
          summary: candidate.node.node_summary || '',
          description: candidate.node.node_description || '',
          level: candidate.node.level
        },
        structured: true
      };
    }
  }

  // No candidate had 2+ children — also try root nodes if topic is very broad
  const allRoots = NodeRepo.findByParent(null);
  if (allRoots.length >= 2) {
    // Check if the topic matches the overall KB scope (very generic query like "what topics do you have")
    const genericPatterns = [
      /topic|subject|categor|section|content|node|item|thing/i,
      /主题|内容|分类|类别|节点|项目|东西/
    ];
    const isGeneric = genericPatterns.some(p => p.test(topic));

    if (isGeneric) {
      const enriched = allRoots.map(r => ({
        node_id: r.node_id,
        name: r.name,
        summary: r.node_summary || '',
        description: r.node_description || '',
        keywords: safeJson(r.keywords_json, []),
        level: r.level || 0,
        chunk_count: 0
      }));

      return {
        nodes: enriched,
        count: enriched.length,
        parentNode: { node_id: 'root', name: 'Knowledge Base', summary: '', description: '', level: -1 },
        structured: true
      };
    }
  }

  logger.debug(`[treeEnumerator] No parent with 2+ children found for topic: "${topic}"`);
  return null;
}

/**
 * Get a few supporting chunks for each enumerated child node.
 * @param {object[]} nodes - Enumerated child nodes
 * @param {number} chunksPerNode - Max chunks per child node
 * @returns {object[]} Chunks with node context
 */
export function getEnumerationChunks(nodes, chunksPerNode = 3) {
  const allChunks = [];

  for (const node of nodes) {
    const rows = ChunkRepo.getForNodeLimited(node.node_id, chunksPerNode);
    for (const r of rows) {
      allChunks.push({
        id: r.id,
        content: r.content_clean || r.content,
        doc_title: r.doc_title,
        node_id: node.node_id,
        node_name: node.name,
        authority_level: r.authority_level,
        kp_type: r.kp_type || 'legacy_chunk'
      });
    }
  }

  return allChunks;
}
