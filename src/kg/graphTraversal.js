import { safeJson } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";

/**
 * Graph Traversal Utilities
 *
 * Functions for navigating the knowledge tree structure
 */

/**
 * Get a node by ID
 * @param {string} nodeId - Node ID
 * @returns {object|null} Node or null
 */
export function getNode(nodeId) {
  const row = NodeRepo.findById(nodeId);

  if (!row) return null;

  return {
    node_id: row.node_id,
    name: row.name,
    parent_id: row.parent_id,
    level: row.level,
    node_summary: row.node_summary,
    aliases: safeJson(row.aliases_json, []),
    scope: safeJson(row.scope_json, {}),
    authority_level_mode: row.authority_level_mode,
    conflict_score: row.conflict_score,
    updated_at: row.updated_at
  };
}

/**
 * Get all ancestors of a node (path to root)
 * @param {string} nodeId - Node ID
 * @returns {Array<object>} Ancestors from immediate parent to root
 */
export function getAncestors(nodeId) {
  const ancestors = [];
  let currentId = nodeId;

  while (currentId) {
    const node = getNode(currentId);
    if (!node) break;

    if (node.parent_id) {
      const parent = getNode(node.parent_id);
      if (parent) {
        ancestors.push(parent);
        currentId = parent.node_id;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return ancestors;
}

/**
 * Get the full path from root to a node
 * @param {string} nodeId - Node ID
 * @returns {Array<object>} Path from root to node
 */
export function getPathToNode(nodeId) {
  const node = getNode(nodeId);
  if (!node) return [];

  const ancestors = getAncestors(nodeId);
  return [...ancestors.reverse(), node];
}

/**
 * Get direct children of a node
 * @param {string} nodeId - Node ID
 * @returns {Array<object>} Child nodes
 */
export function getChildren(nodeId) {
  const rows = NodeRepo.findByParent(nodeId);

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    node_description: r.node_description || '',
    aliases: safeJson(r.aliases_json, []),
    keywords: safeJson(r.keywords_json, []),
    scope: safeJson(r.scope_json, {}),
    authority_level_mode: r.authority_level_mode,
    conflict_score: r.conflict_score
  }));
}

/**
 * Get children of multiple parent nodes in a single DB query.
 * @param {string[]} parentIds - Array of parent node IDs
 * @returns {Map<string, Array<object>>} Map from parentId to children array
 */
export function getChildrenBatch(parentIds) {
  if (!parentIds || parentIds.length === 0) return new Map();

  const rows = NodeRepo.findByParents(parentIds);
  const result = new Map();
  // Initialize all requested parents (some may have no children)
  for (const pid of parentIds) result.set(pid, []);

  for (const r of rows) {
    const child = {
      node_id: r.node_id,
      name: r.name,
      parent_id: r.parent_id,
      level: r.level,
      node_summary: r.node_summary,
      node_description: r.node_description || '',
      aliases: safeJson(r.aliases_json, []),
      keywords: safeJson(r.keywords_json, []),
      scope: safeJson(r.scope_json, {}),
      authority_level_mode: r.authority_level_mode,
      conflict_score: r.conflict_score
    };
    result.get(r.parent_id)?.push(child);
  }
  return result;
}

/**
 * Get all descendants of a node recursively
 * @param {string} nodeId - Node ID
 * @param {number} maxDepth - Maximum depth to traverse (default: unlimited)
 * @returns {Array<object>} All descendant nodes
 */
export function getDescendants(nodeId, maxDepth = Infinity) {
  const descendants = [];
  let currentIds = [nodeId];
  let depth = 0;

  while (currentIds.length > 0 && depth < maxDepth) {
    const childrenMap = getChildrenBatch(currentIds);
    const nextIds = [];
    for (const pid of currentIds) {
      const children = childrenMap.get(pid) || [];
      for (const child of children) {
        descendants.push({ ...child, depth: depth + 1 });
        nextIds.push(child.node_id);
      }
    }
    currentIds = nextIds;
    depth++;
  }

  return descendants;
}

/**
 * Get siblings of a node (nodes with same parent)
 * @param {string} nodeId - Node ID
 * @param {boolean} includeSelf - Whether to include the node itself
 * @returns {Array<object>} Sibling nodes
 */
export function getSiblings(nodeId, includeSelf = false) {
  const node = getNode(nodeId);
  if (!node) return [];

  let rows;
  if (node.parent_id) {
    rows = NodeRepo.findSiblings(node.parent_id, includeSelf ? null : nodeId);
  } else {
    rows = NodeRepo.findRootSiblings(includeSelf ? null : nodeId);
  }

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    node_description: r.node_description || '',
    aliases: safeJson(r.aliases_json, []),
    keywords: safeJson(r.keywords_json, []),
    scope: safeJson(r.scope_json, {})
  }));
}

/**
 * Find the lowest common ancestor of multiple nodes
 * @param {string[]} nodeIds - Array of node IDs
 * @returns {object|null} Common ancestor or null
 */
export function findCommonAncestor(nodeIds) {
  if (nodeIds.length === 0) return null;
  if (nodeIds.length === 1) return getNode(nodeIds[0]);

  // Get ancestor paths for all nodes
  const paths = nodeIds.map(id => {
    const path = getPathToNode(id);
    return path.map(n => n.node_id);
  });

  // Find the longest common prefix
  let commonAncestorId = null;

  const minPathLength = Math.min(...paths.map(p => p.length));

  for (let i = 0; i < minPathLength; i++) {
    const ancestorAtLevel = paths[0][i];
    const allMatch = paths.every(p => p[i] === ancestorAtLevel);

    if (allMatch) {
      commonAncestorId = ancestorAtLevel;
    } else {
      break;
    }
  }

  return commonAncestorId ? getNode(commonAncestorId) : null;
}

/**
 * Get related nodes using BFS traversal
 * @param {string} nodeId - Starting node ID
 * @param {number} depth - How many levels to traverse
 * @returns {Array<object>} Related nodes with relationship info
 */
export function getRelatedNodes(nodeId, depth = 2) {
  const related = [];
  const visited = new Set([nodeId]);

  // Get ancestors
  const ancestors = getAncestors(nodeId);
  for (let i = 0; i < Math.min(ancestors.length, depth); i++) {
    if (!visited.has(ancestors[i].node_id)) {
      visited.add(ancestors[i].node_id);
      related.push({
        ...ancestors[i],
        relationship: "ancestor",
        distance: i + 1
      });
    }
  }

  // Get siblings
  const siblings = getSiblings(nodeId);
  for (const sibling of siblings) {
    if (!visited.has(sibling.node_id)) {
      visited.add(sibling.node_id);
      related.push({
        ...sibling,
        relationship: "sibling",
        distance: 1
      });
    }
  }

  // Get children
  const children = getChildren(nodeId);
  for (const child of children) {
    if (!visited.has(child.node_id)) {
      visited.add(child.node_id);
      related.push({
        ...child,
        relationship: "child",
        distance: 1
      });
    }
  }

  // If depth > 1, also get children of siblings and grandchildren
  if (depth > 1) {
    // Children of siblings (cousins)
    for (const sibling of siblings) {
      const nephews = getChildren(sibling.node_id);
      for (const nephew of nephews) {
        if (!visited.has(nephew.node_id)) {
          visited.add(nephew.node_id);
          related.push({
            ...nephew,
            relationship: "cousin",
            distance: 2
          });
        }
      }
    }

    // Grandchildren
    for (const child of children) {
      const grandchildren = getChildren(child.node_id);
      for (const gc of grandchildren) {
        if (!visited.has(gc.node_id)) {
          visited.add(gc.node_id);
          related.push({
            ...gc,
            relationship: "grandchild",
            distance: 2
          });
        }
      }
    }
  }

  return related;
}

/**
 * Get the subtree rooted at a node
 * @param {string} nodeId - Root node ID
 * @param {number} maxDepth - Maximum depth
 * @returns {object} Tree structure
 */
export function getSubtree(nodeId, maxDepth = 3) {
  const node = getNode(nodeId);
  if (!node) return null;

  function buildTree(id, depth) {
    if (depth >= maxDepth) return null;

    const n = getNode(id);
    if (!n) return null;

    const children = getChildren(id);

    return {
      ...n,
      children: children.map(c => buildTree(c.node_id, depth + 1)).filter(Boolean)
    };
  }

  return buildTree(nodeId, 0);
}

/**
 * Get all root nodes (nodes without parents)
 * @returns {Array<object>} Root nodes
 */
export function getRootNodes() {
  const rows = NodeRepo.findRoots();

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    level: r.level,
    node_summary: r.node_summary,
    node_description: r.node_description || '',
    aliases: safeJson(r.aliases_json, []),
    keywords: safeJson(r.keywords_json, []),
    scope: safeJson(r.scope_json, {})
  }));
}

/**
 * Get the full tree structure
 * @returns {Array<object>} Full tree from roots
 */
export function getFullTree() {
  const roots = getRootNodes();
  const trees = roots.map(root => getSubtree(root.node_id, 10)).filter(Boolean);

  // Display fallback: if data has a canonical "root" plus orphan top-level nodes,
  // group those top-level nodes under "root" for a true tree visualization.
  if (trees.length > 1) {
    let rootIndex = trees.findIndex(n => n.node_id === "root");
    if (rootIndex < 0) {
      const levelZeroRoots = trees
        .map((n, i) => ({ node: n, index: i }))
        .filter(({ node }) => Number(node.level) === 0);
      if (levelZeroRoots.length === 1) {
        rootIndex = levelZeroRoots[0].index;
      }
    }

    if (rootIndex >= 0) {
      const rootTree = trees[rootIndex];
      const siblingRoots = trees.filter((_, i) => i !== rootIndex);
      rootTree.children = [...(rootTree.children || []), ...siblingRoots];
      return [rootTree];
    }
  }

  return trees;
}

/**
 * Find nodes by level
 * @param {number} level - Tree level
 * @returns {Array<object>} Nodes at that level
 */
export function getNodesByLevel(level) {
  const rows = NodeRepo.findByLevel(level);

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    scope: safeJson(r.scope_json, {})
  }));
}

/**
 * Calculate tree statistics
 * @returns {object} Tree statistics
 */
export function getTreeStats() {
  return NodeRepo.getTreeStats();
}

/**
 * Get node with its context (parent, siblings, children)
 * @param {string} nodeId - Node ID
 * @returns {object} Node with context
 */
export function getNodeWithContext(nodeId) {
  const node = getNode(nodeId);
  if (!node) return null;

  return {
    node,
    parent: node.parent_id ? getNode(node.parent_id) : null,
    siblings: getSiblings(nodeId),
    children: getChildren(nodeId),
    path: getPathToNode(nodeId)
  };
}
