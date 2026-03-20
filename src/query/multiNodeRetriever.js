import { safeJson } from "../db/db.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { hybridRecallNodes, hybridRecallChunks, searchNodesByName, getNodesByIds, hierarchicalRecallNodes, searchByAliases } from "../kg/recallNodes.js";

/**
 * Multi-Node Retrieval System
 *
 * Retrieves information from multiple nodes for comparison and aggregation queries
 */

/**
 * Retrieve multiple nodes by entity names
 * @param {string[]} entityNames - Names of entities to find
 * @param {object} options - Options
 * @returns {Promise<Array<{entity: string, node: object, chunks: Array}>>}
 */
export async function retrieveByEntityNames(entityNames, options = {}) {
  const { includeChunks = true, maxChunksPerNode = 10 } = options;

  const results = [];

  for (const entity of entityNames) {
    // Try exact match first
    let nodes = searchNodesByName(entity, 5);

    // If no exact match, try alias search
    if (nodes.length === 0) {
      const aliasMatches = searchByAliases(entity, 5);
      nodes = aliasMatches.map(m => m.node);
    }

    // If still no match, try hierarchical hybrid search
    if (nodes.length === 0) {
      const hybridResults = await hierarchicalRecallNodes(entity, 5, {
        useHierarchy: false,  // For entity lookup, don't expand hierarchy
        useAliases: true
      });
      nodes = hybridResults.map(r => r.node);
    }

    if (nodes.length > 0) {
      const bestNode = nodes[0];

      let chunks = [];
      if (includeChunks) {
        chunks = getChunksForNode(bestNode.node_id, maxChunksPerNode);
      }

      results.push({
        entity,
        node: bestNode,
        chunks,
        confidence: nodes.length === 1 ? 0.9 : 0.7
      });
    } else {
      results.push({
        entity,
        node: null,
        chunks: [],
        confidence: 0,
        error: "Entity not found"
      });
    }
  }

  return results;
}

/**
 * Get chunks for a specific node
 */
function getChunksForNode(nodeId, limit = 10) {
  const rows = ChunkRepo.getForNodeLimited(nodeId, limit);

  return rows.map(r => ({
    id: r.id,
    doc_title: r.doc_title,
    content: r.content_clean,
    chunk_type: r.chunk_type,
    keywords: safeJson(r.keywords_json, []),
    authority_level: r.authority_level
  }));
}

/**
 * Retrieve nodes relevant to a query and aggregate their chunks
 * @param {string} query - Search query
 * @param {object} options - Options
 * @returns {Promise<object>} Aggregated results
 */
export async function retrieveAndAggregate(query, options = {}) {
  const {
    maxNodes = 5,
    maxChunksPerNode = 5,
    minScore = 0.08  // Very low for better coverage
  } = options;

  // Get relevant nodes with hierarchical search
  const nodeResults = await hierarchicalRecallNodes(query, maxNodes * 2, {
    vectorThreshold: 0.2,
    includeChunkSearch: true,
    useHierarchy: true,
    useAliases: true
  });

  const aggregated = {
    query,
    nodes: [],
    total_chunks: 0,
    combined_context: ""
  };

  const contextParts = [];

  for (const result of nodeResults) {
    if (result.score < minScore) continue;

    const chunks = getChunksForNode(result.node.node_id, maxChunksPerNode);

    aggregated.nodes.push({
      node: result.node,
      score: result.score,
      sources: result.sources,
      chunks
    });

    aggregated.total_chunks += chunks.length;

    // Build context
    if (chunks.length > 0) {
      const nodeContext = `[${result.node.name}]\n` +
        chunks.map(c => c.content).join("\n\n");
      contextParts.push(nodeContext);
    }
  }

  aggregated.combined_context = contextParts.join("\n\n---\n\n");

  return aggregated;
}

/**
 * Retrieve chunks across multiple nodes for a query
 * @param {string} query - Search query
 * @param {object} options - Options
 * @returns {Promise<Array>} Chunks with node info
 */
export async function retrieveChunksAcrossNodes(query, options = {}) {
  const { maxChunks = 20, minScore = 0.02 } = options;

  const chunkResults = await hybridRecallChunks(query, maxChunks);

  // Enrich with node information
  const nodeIds = [...new Set(chunkResults.map(r => r.chunk.node_id).filter(Boolean))];
  const nodes = getNodesByIds(nodeIds);
  const nodeMap = new Map(nodes.map(n => [n.node_id, n]));

  return chunkResults
    .filter(r => r.score >= minScore)
    .map(r => ({
      chunk: r.chunk,
      score: r.score,
      sources: r.sources,
      node: nodeMap.get(r.chunk.node_id) || null
    }));
}

/**
 * Retrieve for comparison - get info about multiple entities
 * @param {string[]} entities - Entities to compare
 * @param {string[]} aspects - Aspects/criteria to compare on (optional)
 * @returns {Promise<object>} Comparison data
 */
export async function retrieveForComparison(entities, aspects = []) {
  const entityData = await retrieveByEntityNames(entities, {
    includeChunks: true,
    maxChunksPerNode: 15
  });

  const comparison = {
    entities: [],
    aspects: aspects.length > 0 ? aspects : [],
    matrix: {}
  };

  for (const data of entityData) {
    if (!data.node) {
      comparison.entities.push({
        name: data.entity,
        found: false
      });
      continue;
    }

    const entityInfo = {
      name: data.entity,
      found: true,
      node_id: data.node.node_id,
      node_name: data.node.name,
      summary: data.node.node_summary,
      description: data.node.node_description || '',
      keywords: safeJson(data.node.keywords_json, []),
      chunks: data.chunks
    };

    // If aspects are specified, try to extract relevant info for each
    if (aspects.length > 0) {
      entityInfo.aspect_data = {};
      for (const aspect of aspects) {
        const relevantChunks = data.chunks.filter(c =>
          c.content.toLowerCase().includes(aspect.toLowerCase()) ||
          (c.keywords && c.keywords.some(k => k.toLowerCase().includes(aspect.toLowerCase())))
        );
        entityInfo.aspect_data[aspect] = relevantChunks.map(c => c.content).join("\n");
      }
    }

    comparison.entities.push(entityInfo);
  }

  return comparison;
}

/**
 * Retrieve candidates for recommendation
 * @param {string} query - Recommendation query
 * @param {object} criteria - Criteria to evaluate
 * @returns {Promise<object>} Candidates with scores
 */
export async function retrieveForRecommendation(query, criteria = {}) {
  const { minScore = 0.08, maxCandidates = 10 } = criteria;  // Very low minScore for maximum coverage

  // Find candidate nodes with hierarchical search including aliases
  const candidates = await hierarchicalRecallNodes(query, maxCandidates * 3, {
    vectorThreshold: 0.2,
    includeChunkSearch: true,
    useHierarchy: true,
    useAliases: true
  });

  const results = {
    query,
    criteria: Object.keys(criteria).filter(k => k !== "minScore" && k !== "maxCandidates"),
    candidates: []
  };

  for (const candidate of candidates) {
    if (candidate.score < minScore) continue;

    const chunks = getChunksForNode(candidate.node.node_id, 10);

    const candidateInfo = {
      node: candidate.node,
      base_score: candidate.score,
      chunks_count: chunks.length,
      criteria_scores: {},
      total_score: candidate.score
    };

    // Score against each criterion
    const criteriaKeys = results.criteria;
    if (criteriaKeys.length > 0) {
      const allContent = chunks.map(c => c.content).join(" ").toLowerCase();

      for (const criterion of criteriaKeys) {
        const criterionLower = criterion.toLowerCase();
        // Simple relevance scoring based on keyword presence
        const mentions = (allContent.match(new RegExp(criterionLower, "g")) || []).length;
        const criterionScore = Math.min(1, mentions / 5);
        candidateInfo.criteria_scores[criterion] = criterionScore;
        candidateInfo.total_score += criterionScore * 0.1;
      }
    }

    // Add sample content
    candidateInfo.sample_content = chunks.slice(0, 3).map(c => ({
      id: c.id,
      preview: c.content.slice(0, 200)
    }));

    results.candidates.push(candidateInfo);
  }

  // Sort by total score
  results.candidates.sort((a, b) => b.total_score - a.total_score);
  results.candidates = results.candidates.slice(0, maxCandidates);

  return results;
}

/**
 * Build context string from multi-node results
 * @param {object} results - Results from retrieval
 * @returns {string} Formatted context
 */
export function buildMultiNodeContext(results) {
  if (results.combined_context) {
    return results.combined_context;
  }

  const parts = [];

  if (results.nodes) {
    for (const nodeData of results.nodes) {
      const header = `[Node: ${nodeData.node.name}]`;
      const chunkTexts = nodeData.chunks.map((c, i) =>
        `  [Chunk ${c.id}] ${c.content}`
      ).join("\n\n");

      parts.push(`${header}\n${chunkTexts}`);
    }
  }

  if (results.entities) {
    for (const entity of results.entities) {
      if (!entity.found) continue;

      const header = `[Entity: ${entity.name}]`;
      const chunkTexts = entity.chunks.map(c =>
        `  ${c.content}`
      ).join("\n\n");

      parts.push(`${header}\n${chunkTexts}`);
    }
  }

  return parts.join("\n\n---\n\n");
}
