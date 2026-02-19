/**
 * Hierarchy-based enrichment and chunk retrieval strategies.
 */

import { db, safeJson } from "../../db/db.js";
import { queryLogger as logger } from "../../utils/logger.js";
import { getAncestors, getChildren, getSiblings } from "../graphTraversal.js";

/**
 * Enrich retrieval results with hierarchical context (ancestors, children, siblings).
 */
export function enrichWithHierarchy(results, options = {}) {
  const {
    includeAncestors = true,
    includeChildren  = true,
    includeSiblings  = false,
    ancestorBoost    = 0.3,
    childBoost       = 0.5,
    siblingBoost     = 0.2,
    maxAncestors     = 2,
    maxChildren      = 5,
    maxSiblings      = 3
  } = options;

  const enrichedMap = new Map();

  const addNode = (node, score, source, relationship = "direct") => {
    const sources = Array.isArray(source) ? source : [source];
    const existing = enrichedMap.get(node.node_id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      for (const s of sources) {
        if (!existing.sources.includes(s)) existing.sources.push(s);
      }
    } else {
      enrichedMap.set(node.node_id, { node, score, sources: sources.filter(Boolean), relationship });
    }
  };

  for (const result of results) {
    const { node, score, sources = ["direct"] } = result;
    addNode(node, score, sources.length > 0 ? sources : ["direct"], "direct");

    if (includeAncestors) {
      try {
        const ancestors = getAncestors(node.node_id);
        for (let i = 0; i < Math.min(ancestors.length, maxAncestors); i++) {
          addNode(ancestors[i], score * ancestorBoost * (1 / (i + 1)), "hierarchy_ancestor", "ancestor");
        }
      } catch (err) {
        logger.warn(`Failed to get ancestors for ${node.node_id}:`, err.message);
      }
    }

    if (includeChildren) {
      try {
        const children = getChildren(node.node_id);
        for (let i = 0; i < Math.min(children.length, maxChildren); i++) {
          addNode(children[i], score * childBoost, "hierarchy_child", "child");
        }
      } catch (err) {
        logger.warn(`Failed to get children for ${node.node_id}:`, err.message);
      }
    }

    if (includeSiblings) {
      try {
        const siblings = getSiblings(node.node_id);
        for (let i = 0; i < Math.min(siblings.length, maxSiblings); i++) {
          addNode(siblings[i], score * siblingBoost, "hierarchy_sibling", "sibling");
        }
      } catch (err) {
        logger.warn(`Failed to get siblings for ${node.node_id}:`, err.message);
      }
    }
  }

  const enriched = [...enrichedMap.values()];
  enriched.sort((a, b) => b.score - a.score);
  logger.debug(`Hierarchy enrichment: ${results.length} -> ${enriched.length} nodes`);
  return enriched;
}

/**
 * Get chunks from a node and its direct children for comprehensive context.
 */
export function getHierarchicalChunks(nodeId, maxChunks = 20) {
  const chunks = [];

  const nodeChunks = db.prepare(`
    SELECT c.*, n.name as node_name FROM chunks c
    JOIN nodes n ON n.node_id = c.node_id
    WHERE c.node_id = ? AND c.status = 'active'
    ORDER BY c.authority_level ASC, c.uploaded_at DESC
    LIMIT ?
  `).all(nodeId, Math.ceil(maxChunks / 2));

  for (const c of nodeChunks) {
    chunks.push({ ...c, source: "direct", keywords: safeJson(c.keywords_json, []) });
  }

  const children = getChildren(nodeId);
  const chunksPerChild = Math.max(2, Math.floor((maxChunks - chunks.length) / Math.max(children.length, 1)));

  for (const child of children) {
    if (chunks.length >= maxChunks) break;
    const childChunks = db.prepare(`
      SELECT c.*, n.name as node_name FROM chunks c
      JOIN nodes n ON n.node_id = c.node_id
      WHERE c.node_id = ? AND c.status = 'active'
      ORDER BY c.authority_level ASC, c.uploaded_at DESC
      LIMIT ?
    `).all(child.node_id, chunksPerChild);

    for (const c of childChunks) {
      chunks.push({ ...c, source: "child", keywords: safeJson(c.keywords_json, []) });
    }
  }

  return chunks.slice(0, maxChunks);
}
