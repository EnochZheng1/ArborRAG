/**
 * Hierarchical Retrieval System
 *
 * Smart retrieval that leverages tree structure and graph traversal:
 * 1. Top-down navigation: Use node summaries to guide search down relevant branches
 * 2. Bottom-up enrichment: Add ancestor context to found chunks
 * 3. Sibling expansion: Find related content in sibling nodes
 * 4. Hierarchical scoring: Score based on tree position and path relevance
 * 5. Adaptive depth: Go deeper in relevant branches, prune irrelevant ones
 */

import { db, safeJson } from "../db/db.js";
import { queryLogger as logger } from "../utils/logger.js";
import {
  getNode, getChildren, getAncestors, getSiblings, getDescendants,
  getPathToNode, getRelatedNodes, findCommonAncestor
} from "./graphTraversal.js";

/**
 * Calculate text similarity score (simple term overlap)
 */
function calculateSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  const terms1 = new Set(extractQueryTerms(text1));
  const terms2 = new Set(extractQueryTerms(text2));

  if (terms1.size === 0 || terms2.size === 0) return 0;

  let overlap = 0;
  for (const term of terms1) {
    if (terms2.has(term)) overlap++;
  }

  return overlap / Math.max(terms1.size, terms2.size);
}

function extractQueryTerms(query) {
  const normalized = String(query || "").toLowerCase().trim();
  if (!normalized) return [];

  const terms = [];
  const seen = new Set();
  const add = (value) => {
    const token = String(value || "").trim();
    if (!token || seen.has(token)) return;
    seen.add(token);
    terms.push(token);
  };

  const latin = normalized.match(/[a-z0-9]{2,}/g) || [];
  for (const token of latin) {
    add(token);
  }

  const cjkSequences = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || [];
  for (const sequence of cjkSequences) {
    const chars = [...sequence];
    if (chars.length >= 2) {
      add(sequence);
    }

    const maxN = Math.min(3, chars.length);
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i <= chars.length - n; i++) {
        add(chars.slice(i, i + n).join(""));
      }
    }
  }

  const otherTokens = normalized.split(/\s+/).filter(t => t.length >= 2);
  for (const token of otherTokens) {
    add(token);
  }

  return terms.slice(0, 36);
}

/**
 * Score a node's relevance to a query based on name, summary, and aliases
 */
function scoreNodeRelevance(node, query, queryTerms) {
  let score = 0;
  const queryLower = query.toLowerCase();
  const nameLower = (node.name || '').toLowerCase();
  const summaryLower = (node.node_summary || '').toLowerCase();

  // Exact name match
  if (nameLower === queryLower) {
    score += 1.0;
  } else if (queryLower.includes(nameLower) || nameLower.includes(queryLower)) {
    score += 0.7;
  }

  // Query terms in name
  for (const term of queryTerms) {
    if (nameLower.includes(term)) {
      score += 0.3;
    }
  }

  // Query terms in summary
  for (const term of queryTerms) {
    if (summaryLower.includes(term)) {
      score += 0.2;
    }
  }

  // Check aliases
  const aliases = node.aliases || [];
  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase();
    if (aliasLower === queryLower || queryLower.includes(aliasLower)) {
      score += 0.5;
    }
    for (const term of queryTerms) {
      if (aliasLower.includes(term)) {
        score += 0.15;
      }
    }
  }

  // Text similarity with summary
  score += calculateSimilarity(query, node.node_summary) * 0.4;

  return Math.min(score, 2.0); // Cap at 2.0
}

/**
 * Get all root nodes
 */
function getRootNodes() {
  const rows = db.prepare(`
    SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY name
  `).all();

  return rows.map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    aliases: safeJson(r.aliases_json, []),
    scope: safeJson(r.scope_json, {})
  }));
}

/**
 * Get chunks for a node with relevance scoring
 */
function getNodeChunks(nodeId, query, limit = 10) {
  const queryTerms = extractQueryTerms(query);

  const rows = db.prepare(`
    SELECT c.*, n.name as node_name, n.level as node_level
    FROM chunks c
    JOIN nodes n ON c.node_id = n.node_id
    WHERE c.node_id = ? AND c.status = 'active'
    ORDER BY c.authority_level ASC, c.uploaded_at DESC
    LIMIT ?
  `).all(nodeId, limit * 2); // Get more, then filter by relevance

  const chunks = rows.map(r => {
    const content = r.content_clean || '';
    const contentLower = content.toLowerCase();

    // Calculate content relevance
    let relevance = 0;
    for (const term of queryTerms) {
      if (contentLower.includes(term)) {
        relevance += 0.3;
        // Bonus for multiple occurrences
        const matches = (contentLower.match(new RegExp(term, 'g')) || []).length;
        relevance += Math.min(matches * 0.05, 0.2);
      }
    }

    return {
      id: r.id,
      content: content,
      content_clean: content,
      doc_title: r.doc_title,
      node_id: r.node_id,
      node_name: r.node_name,
      node_level: r.node_level,
      chunk_type: r.chunk_type,
      authority_level: r.authority_level,
      keywords: safeJson(r.keywords_json, []),
      relevance_score: relevance
    };
  });

  const authorityRank = { sop: 0, policy: 1, guide: 2, faq: 3 };
  const relevant = chunks.filter(c => c.relevance_score > 0);

  if (relevant.length > 0) {
    relevant.sort((a, b) => {
      const scoreDiff = b.relevance_score - a.relevance_score;
      if (scoreDiff !== 0) return scoreDiff;
      const rankA = authorityRank[a.authority_level] ?? 99;
      const rankB = authorityRank[b.authority_level] ?? 99;
      if (rankA !== rankB) return rankA - rankB;
      return 0;
    });
    return relevant.slice(0, limit);
  }

  // Fallback to the original ordering if no relevance is found
  return chunks.slice(0, limit);
}

/**
 * Top-down tree navigation - find relevant branches
 * Uses beam search to explore most promising paths
 */
export function navigateTreeTopDown(query, options = {}) {
  const {
    beamWidth = 3,      // How many branches to explore at each level
    maxDepth = 5,       // Maximum tree depth to explore
    minNodeScore = 0.1  // Minimum relevance score to continue exploring
  } = options;

  const queryTerms = extractQueryTerms(query);
  const relevantNodes = [];
  const visitedNodes = new Set();

  // Start with root nodes
  let currentLevel = getRootNodes().map(node => ({
    node,
    score: scoreNodeRelevance(node, query, queryTerms),
    path: [node.node_id]
  }));

  // Sort by score and keep top beamWidth
  currentLevel.sort((a, b) => b.score - a.score);
  currentLevel = currentLevel.slice(0, beamWidth);

  // Add initial nodes if they score well
  for (const item of currentLevel) {
    if (item.score >= minNodeScore && !visitedNodes.has(item.node.node_id)) {
      visitedNodes.add(item.node.node_id);
      relevantNodes.push({
        ...item.node,
        relevance_score: item.score,
        path: item.path,
        depth: 0
      });
    }
  }

  // Navigate down the tree
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextLevel = [];

    for (const current of currentLevel) {
      if (current.score < minNodeScore) continue;

      const children = getChildren(current.node.node_id);

      for (const child of children) {
        if (visitedNodes.has(child.node_id)) continue;

        const childScore = scoreNodeRelevance(child, query, queryTerms);
        // Inherit some score from parent (relevant parent = likely relevant children)
        const combinedScore = childScore * 0.7 + current.score * 0.3;

        if (combinedScore >= minNodeScore) {
          nextLevel.push({
            node: child,
            score: combinedScore,
            path: [...current.path, child.node_id]
          });
        }
      }
    }

    if (nextLevel.length === 0) break;

    // Sort and keep top beamWidth
    nextLevel.sort((a, b) => b.score - a.score);
    currentLevel = nextLevel.slice(0, beamWidth * 2); // Allow more exploration at deeper levels

    // Add relevant nodes
    for (const item of currentLevel) {
      if (!visitedNodes.has(item.node.node_id)) {
        visitedNodes.add(item.node.node_id);
        relevantNodes.push({
          ...item.node,
          relevance_score: item.score,
          path: item.path,
          depth
        });
      }
    }
  }

  // Sort by relevance
  relevantNodes.sort((a, b) => b.relevance_score - a.relevance_score);

  logger.debug(`Top-down navigation found ${relevantNodes.length} relevant nodes`);
  return relevantNodes;
}

/**
 * Bottom-up context enrichment - add ancestor context to chunks
 */
export function enrichWithAncestorContext(chunks, options = {}) {
  const {
    maxAncestors = 2,
    ancestorChunksPerLevel = 2
  } = options;

  const enrichedChunks = [...chunks];
  const seenChunkIds = new Set(chunks.map(c => c.id));
  const processedNodes = new Set();

  for (const chunk of chunks) {
    if (!chunk.node_id || processedNodes.has(chunk.node_id)) continue;
    processedNodes.add(chunk.node_id);

    const ancestors = getAncestors(chunk.node_id);

    for (let i = 0; i < Math.min(ancestors.length, maxAncestors); i++) {
      const ancestor = ancestors[i];

      // Get ancestor's chunks
      const ancestorChunks = db.prepare(`
        SELECT c.*, n.name as node_name
        FROM chunks c
        JOIN nodes n ON c.node_id = n.node_id
        WHERE c.node_id = ? AND c.status = 'active'
        ORDER BY c.authority_level ASC
        LIMIT ?
      `).all(ancestor.node_id, ancestorChunksPerLevel);

      for (const ac of ancestorChunks) {
        if (!seenChunkIds.has(ac.id)) {
          seenChunkIds.add(ac.id);
          enrichedChunks.push({
            id: ac.id,
            content: ac.content_clean,
            content_clean: ac.content_clean,
            doc_title: ac.doc_title,
            node_id: ac.node_id,
            node_name: ac.node_name,
            authority_level: ac.authority_level,
            source: 'ancestor_context',
            ancestor_level: i + 1,
            original_chunk_id: chunk.id
          });
        }
      }
    }
  }

  return enrichedChunks;
}

/**
 * Sibling expansion - find related content in sibling nodes
 */
export function expandWithSiblings(nodeIds, query, options = {}) {
  const {
    maxSiblings = 3,
    chunksPerSibling = 3,
    minSiblingScore = 0.15
  } = options;

  const queryTerms = extractQueryTerms(query);
  const siblingChunks = [];
  const processedSiblings = new Set(nodeIds);

  for (const nodeId of nodeIds) {
    const siblings = getSiblings(nodeId, false);

    // Score siblings by relevance
    const scoredSiblings = siblings
      .filter(s => !processedSiblings.has(s.node_id))
      .map(s => ({
        ...s,
        score: scoreNodeRelevance(s, query, queryTerms)
      }))
      .filter(s => s.score >= minSiblingScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSiblings);

    for (const sibling of scoredSiblings) {
      processedSiblings.add(sibling.node_id);

      const chunks = getNodeChunks(sibling.node_id, query, chunksPerSibling);
      for (const chunk of chunks) {
        siblingChunks.push({
          ...chunk,
          source: 'sibling_expansion',
          sibling_of: nodeId,
          sibling_score: sibling.score
        });
      }
    }
  }

  return siblingChunks;
}

/**
 * Hierarchical scoring - score chunks based on tree position
 */
export function applyHierarchicalScoring(chunks, relevantNodes, query) {
  const nodeScores = new Map();
  for (const node of relevantNodes) {
    nodeScores.set(node.node_id, node.relevance_score || 0);
  }

  const queryTerms = extractQueryTerms(query);

  return chunks.map(chunk => {
    let score = chunk.relevance_score || 0;

    // Add node-level score
    if (chunk.node_id && nodeScores.has(chunk.node_id)) {
      score += nodeScores.get(chunk.node_id) * 0.5;
    }

    // Boost based on source type
    const sourceBoosts = {
      'direct': 1.0,
      'ancestor_context': 0.7,
      'sibling_expansion': 0.6,
      'child_context': 0.8,
      'doc_title': 0.9,
      'bm25_content': 0.85,
      'simple_content': 0.75
    };
    score *= sourceBoosts[chunk.source] || 0.8;

    // Depth penalty (deeper = slightly less authoritative for general queries)
    const depth = chunk.node_level || chunk.depth || 0;
    score *= Math.pow(0.95, depth);

    // Authority boost
    const authorityBoosts = { 'sop': 1.0, 'policy': 0.95, 'guide': 0.9, 'faq': 0.85 };
    score *= authorityBoosts[chunk.authority_level] || 0.8;

    // Content relevance boost
    const contentLower = (chunk.content || '').toLowerCase();
    for (const term of queryTerms) {
      if (contentLower.includes(term)) {
        score += 0.1;
      }
    }

    return {
      ...chunk,
      hierarchical_score: score
    };
  });
}

/**
 * Main hierarchical retrieval function
 */
export async function hierarchicalRetrieve(query, options = {}) {
  const {
    maxChunks = 30,
    beamWidth = 3,
    maxDepth = 5,
    includeAncestors = true,
    includeSiblings = true,
    includeDescendants = true,
    onStep = null
  } = options;

  const traceState = {
    steps: [],
    onStep: typeof onStep === "function" ? onStep : null
  };

  const nodeNameCache = new Map();
  function formatPath(pathIds) {
    if (!Array.isArray(pathIds) || pathIds.length === 0) return [];
    return pathIds.map(id => {
      if (nodeNameCache.has(id)) return nodeNameCache.get(id);
      const node = getNode(id);
      const name = node?.name || id;
      nodeNameCache.set(id, name);
      return name;
    });
  }

  function emitStep(name, description, result = null, status = "success") {
    const step = { name, description, result, status };
    traceState.steps.push(step);
    if (traceState.onStep) {
      traceState.onStep(step);
    }
  }

  logger.info(`Hierarchical retrieval for: "${query.slice(0, 50)}..."`);

  const results = {
    chunks: [],
    nodes: [],
    paths: [],
    sources: new Set()
  };

  emitStep(
    "Hierarchy: Start",
    `Beam search over tree (maxDepth=${maxDepth})`,
    {
      beam_width: beamWidth,
      max_chunks: maxChunks,
      include_ancestors: includeAncestors,
      include_siblings: includeSiblings,
      include_descendants: includeDescendants
    }
  );

  // Step 1: Top-down navigation to find relevant branches
  const relevantNodes = navigateTreeTopDown(query, { beamWidth, maxDepth });
  results.nodes = relevantNodes;
  results.sources.add('tree_navigation');

  if (relevantNodes.length > 0) {
    // Record paths
    results.paths = relevantNodes.slice(0, 5).map(n => n.path);
  }

  const topNodes = relevantNodes.slice(0, 5).map(n => ({
    id: n.node_id,
    name: n.name,
    score: Number((n.relevance_score || 0).toFixed(3)),
    depth: n.depth
  }));
  const topPaths = relevantNodes.slice(0, 3).map(n => formatPath(n.path));
  const maxDepthReached = relevantNodes.reduce((max, n) => Math.max(max, n.depth || 0), 0);
  emitStep(
    "Hierarchy: Top-Down Navigation",
    `Found ${relevantNodes.length} relevant nodes`,
    {
      top_nodes: topNodes,
      paths: topPaths,
      max_depth_reached: maxDepthReached
    }
  );

  // Step 2: Get chunks from relevant nodes
  const seenChunkIds = new Set();
  const nodeChunkStats = [];

  for (const node of relevantNodes.slice(0, 10)) {
    const nodeChunks = getNodeChunks(node.node_id, query, 5);
    let added = 0;

    for (const chunk of nodeChunks) {
      if (!seenChunkIds.has(chunk.id)) {
        seenChunkIds.add(chunk.id);
        results.chunks.push({
          ...chunk,
          source: 'direct',
          node_relevance: node.relevance_score
        });
        added++;
      }
    }
    if (added > 0) {
      nodeChunkStats.push({
        id: node.node_id,
        name: node.name,
        chunks_added: added,
        node_score: Number((node.relevance_score || 0).toFixed(3))
      });
    }
  }

  logger.debug(`Found ${results.chunks.length} chunks from ${relevantNodes.length} nodes`);
  emitStep(
    "Hierarchy: Node Chunk Retrieval",
    `Added ${results.chunks.length} chunks from ${nodeChunkStats.length} nodes`,
    {
      nodes: nodeChunkStats.slice(0, 5)
    }
  );

  // Step 3: Bottom-up enrichment (add ancestor context)
  if (includeAncestors && results.chunks.length > 0) {
    const enriched = enrichWithAncestorContext(results.chunks);
    const newChunks = enriched.filter(c => !seenChunkIds.has(c.id));

    for (const chunk of newChunks) {
      seenChunkIds.add(chunk.id);
      results.chunks.push(chunk);
    }

    if (newChunks.length > 0) {
      results.sources.add('ancestor_enrichment');
      logger.debug(`Added ${newChunks.length} ancestor context chunks`);
    }
    emitStep(
      "Hierarchy: Ancestor Enrichment",
      `Added ${newChunks.length} ancestor chunks`,
      { added: newChunks.length, total: results.chunks.length }
    );
  } else if (!includeAncestors) {
    emitStep("Hierarchy: Ancestor Enrichment", "Skipped (disabled)", null, "skipped");
  } else {
    emitStep("Hierarchy: Ancestor Enrichment", "Skipped (no chunks to enrich)", null, "skipped");
  }

  // Step 4: Sibling expansion
  if (includeSiblings && relevantNodes.length > 0) {
    const nodeIds = relevantNodes.slice(0, 5).map(n => n.node_id);
    const siblingChunks = expandWithSiblings(nodeIds, query);

    for (const chunk of siblingChunks) {
      if (!seenChunkIds.has(chunk.id)) {
        seenChunkIds.add(chunk.id);
        results.chunks.push(chunk);
      }
    }

    if (siblingChunks.length > 0) {
      results.sources.add('sibling_expansion');
      logger.debug(`Added ${siblingChunks.length} sibling chunks`);
    }
    emitStep(
      "Hierarchy: Sibling Expansion",
      `Added ${siblingChunks.length} sibling chunks`,
      { considered_nodes: nodeIds }
    );
  } else if (!includeSiblings) {
    emitStep("Hierarchy: Sibling Expansion", "Skipped (disabled)", null, "skipped");
  } else {
    emitStep("Hierarchy: Sibling Expansion", "Skipped (no relevant nodes)", null, "skipped");
  }

  // Step 5: Descendant exploration (go deeper in most relevant branches)
  if (includeDescendants && relevantNodes.length > 0) {
    const topNodes = relevantNodes.slice(0, 3);
    let descendantNodes = 0;
    let descendantChunksAdded = 0;

    for (const node of topNodes) {
      const descendants = getDescendants(node.node_id, 2);
      descendantNodes += descendants.length;

      for (const desc of descendants.slice(0, 5)) {
        const descChunks = getNodeChunks(desc.node_id, query, 2);

        for (const chunk of descChunks) {
          if (!seenChunkIds.has(chunk.id) && chunk.relevance_score > 0.1) {
            seenChunkIds.add(chunk.id);
            results.chunks.push({
              ...chunk,
              source: 'child_context',
              parent_node: node.node_id
            });
            descendantChunksAdded++;
          }
        }
      }
    }

    results.sources.add('descendant_exploration');
    emitStep(
      "Hierarchy: Descendant Exploration",
      `Added ${descendantChunksAdded} chunks from ${descendantNodes} descendant nodes`,
      { top_nodes: topNodes.map(n => ({ id: n.node_id, name: n.name })) }
    );
  } else if (!includeDescendants) {
    emitStep("Hierarchy: Descendant Exploration", "Skipped (disabled)", null, "skipped");
  } else {
    emitStep("Hierarchy: Descendant Exploration", "Skipped (no relevant nodes)", null, "skipped");
  }

  // Step 6: Apply hierarchical scoring
  results.chunks = applyHierarchicalScoring(results.chunks, relevantNodes, query);

  // Sort by hierarchical score and limit
  results.chunks.sort((a, b) => b.hierarchical_score - a.hierarchical_score);
  results.chunks = results.chunks.slice(0, maxChunks);

  results.sources = [...results.sources];
  emitStep(
    "Hierarchy: Scoring",
    `Applied hierarchical scoring; kept ${results.chunks.length} chunks`,
    {
      top_chunks: results.chunks.slice(0, 5).map(c => ({
        id: c.id,
        node: c.node_name,
        score: Number((c.hierarchical_score || 0).toFixed(3)),
        source: c.source
      }))
    }
  );
  results.trace_steps = traceState.steps;

  logger.info(`Hierarchical retrieval complete: ${results.chunks.length} chunks from ${results.sources.join(', ')}`);

  return results;
}

/**
 * Get tree context summary for a set of chunks
 */
export function getTreeContextSummary(chunks) {
  const nodeIds = [...new Set(chunks.map(c => c.node_id).filter(Boolean))];

  if (nodeIds.length === 0) {
    return { paths: [], commonAncestor: null, breadth: 0, depth: 0 };
  }

  // Find common ancestor
  const commonAncestor = findCommonAncestor(nodeIds);

  // Get paths
  const paths = nodeIds.slice(0, 5).map(id => {
    const path = getPathToNode(id);
    return path.map(n => n.name).join(' > ');
  });

  // Calculate tree metrics
  const depths = chunks.map(c => c.node_level || 0);
  const maxDepth = Math.max(...depths, 0);
  const breadth = nodeIds.length;

  return {
    paths,
    commonAncestor: commonAncestor ? commonAncestor.name : null,
    breadth,
    depth: maxDepth,
    nodeCount: nodeIds.length
  };
}

export default {
  hierarchicalRetrieve,
  navigateTreeTopDown,
  enrichWithAncestorContext,
  expandWithSiblings,
  applyHierarchicalScoring,
  getTreeContextSummary
};
