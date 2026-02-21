import { EntityRepo } from "../db/repositories/EntityRepo.js";
import { getEntityFacts, searchFacts } from "./entityFactExtractor.js";

/**
 * Entity-Fact Retrieval Module
 *
 * Retrieves information using extracted entities and facts
 * for more precise and structured answers.
 */

/**
 * Retrieve by entity name
 * @param {string} entityName - Entity to find
 * @returns {object} Entity with facts and evidence
 */
export function retrieveByEntity(entityName) {
  return getEntityFacts(entityName);
}

/**
 * Retrieve facts relevant to a query
 * @param {string} query - Search query
 * @param {object} options - Options
 * @returns {object} Retrieved facts and entities
 */
export function retrieveFactsForQuery(query, options = {}) {
  const { limit = 20, includeEvidence = true } = options;

  // Extract potential entity names from query
  const queryEntities = extractQueryEntities(query);

  const result = {
    query,
    matched_entities: [],
    relevant_facts: [],
    evidence_chunks: []
  };

  // Find matching entities
  for (const entityName of queryEntities) {
    const entity = findEntity(entityName);
    if (entity) {
      result.matched_entities.push(entity);
    }
  }

  // Get facts for matched entities
  const entityFactIds = new Set();
  for (const entity of result.matched_entities) {
    const facts = EntityRepo.getFactsByEntityId(entity.id, 10);

    for (const fact of facts) {
      if (!entityFactIds.has(fact.id)) {
        entityFactIds.add(fact.id);
        result.relevant_facts.push({
          ...fact,
          source_entity: entity.name
        });
      }
    }
  }

  // Also search facts by content
  const contentFacts = searchFacts(query, limit);
  for (const fact of contentFacts) {
    if (!entityFactIds.has(fact.id)) {
      entityFactIds.add(fact.id);
      result.relevant_facts.push(fact);
    }
  }

  // Sort facts by confidence
  result.relevant_facts.sort((a, b) => b.confidence - a.confidence);
  result.relevant_facts = result.relevant_facts.slice(0, limit);

  // Get evidence chunks
  if (includeEvidence) {
    const factIds = result.relevant_facts.map(f => f.id);
    if (factIds.length > 0) {
      result.evidence_chunks = EntityRepo.getEvidenceForFacts(factIds);
    }
  }

  return result;
}

/**
 * Find entity by name (fuzzy)
 */
function findEntity(name) {
  const normalized = name.toLowerCase().trim();
  return EntityRepo.findByNormalized(normalized)
    ?? EntityRepo.findByLike(normalized, name)
    ?? EntityRepo.findByAlias(name);
}

/**
 * Extract potential entity names from query
 */
function extractQueryEntities(query) {
  const entities = [];

  // Capitalized phrases
  const capitalizedMatches = query.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  entities.push(...capitalizedMatches);

  // Chinese noun phrases (2-6 chars)
  const chineseMatches = query.match(/[\u4e00-\u9fa5]{2,6}/g) || [];
  entities.push(...chineseMatches);

  // Quoted strings
  const quotedMatches = query.match(/["']([^"']+)["']/g) || [];
  entities.push(...quotedMatches.map(m => m.replace(/["']/g, '')));

  return [...new Set(entities)];
}

/**
 * Compare entities using their facts
 * @param {string[]} entityNames - Entity names to compare
 * @returns {object} Comparison data
 */
export function compareEntities(entityNames) {
  const entities = [];

  for (const name of entityNames) {
    const entityData = getEntityFacts(name);
    if (entityData) {
      entities.push(entityData);
    }
  }

  if (entities.length < 2) {
    return {
      success: false,
      error: 'Not enough entities found for comparison',
      found: entities.map(e => e.name)
    };
  }

  // Group facts by type
  const comparison = {
    entities: entities.map(e => ({
      name: e.name,
      type: e.type,
      description: e.description
    })),
    fact_comparison: {},
    shared_facts: [],
    unique_facts: {}
  };

  // Collect all facts by type
  const factsByEntity = new Map();
  for (const entity of entities) {
    factsByEntity.set(entity.name, entity.facts);
  }

  // Find fact types present
  const allFactTypes = new Set();
  for (const entity of entities) {
    for (const fact of entity.facts) {
      allFactTypes.add(fact.fact_type);
    }
  }

  // Compare facts by type
  for (const factType of allFactTypes) {
    comparison.fact_comparison[factType] = {};

    for (const entity of entities) {
      const typeFacts = entity.facts.filter(f => f.fact_type === factType);
      comparison.fact_comparison[factType][entity.name] = typeFacts.map(f => f.content);
    }
  }

  // Find unique facts for each entity
  for (const entity of entities) {
    comparison.unique_facts[entity.name] = entity.facts
      .filter(f => {
        // Check if fact content is unique to this entity
        const otherEntities = entities.filter(e => e.name !== entity.name);
        return !otherEntities.some(other =>
          other.facts.some(of => of.content === f.content)
        );
      })
      .map(f => f.content);
  }

  return {
    success: true,
    comparison
  };
}

/**
 * Get facts for answering a question
 * @param {string} question - Question to answer
 * @param {object} options - Options
 * @returns {object} Facts and context for answering
 */
export function getFactsForQuestion(question, options = {}) {
  const { maxFacts = 15, maxEvidence = 10 } = options;

  const retrieval = retrieveFactsForQuery(question, {
    limit: maxFacts,
    includeEvidence: true
  });

  // Build context from facts
  const factContext = retrieval.relevant_facts
    .map((f, i) => `[Fact ${i + 1}] ${f.content} (confidence: ${(f.confidence * 100).toFixed(0)}%)`)
    .join('\n');

  // Build entity context
  const entityContext = retrieval.matched_entities
    .map(e => `[Entity: ${e.name}] Type: ${e.type}${e.description ? `, ${e.description}` : ''}`)
    .join('\n');

  // Build evidence context (original chunks)
  const evidenceContext = retrieval.evidence_chunks
    .slice(0, maxEvidence)
    .map(c => `[Source: ${c.doc_title || 'Unknown'}]\n${c.content_clean?.slice(0, 400)}`)
    .join('\n\n');

  return {
    entities: retrieval.matched_entities,
    facts: retrieval.relevant_facts,
    evidence: retrieval.evidence_chunks.slice(0, maxEvidence),
    context: {
      entities: entityContext,
      facts: factContext,
      evidence: evidenceContext,
      combined: `${entityContext}\n\n${factContext}\n\n---\nSource Evidence:\n${evidenceContext}`
    }
  };
}

/**
 * Verify a claim against stored facts
 * @param {string} claim - Claim to verify
 * @returns {object} Verification result
 */
export function verifyClaim(claim) {
  // Search for similar facts
  const similarFacts = searchFacts(claim, 10);

  if (similarFacts.length === 0) {
    return {
      verified: false,
      confidence: 0,
      reason: 'No related facts found in knowledge base',
      supporting_facts: [],
      contradicting_facts: []
    };
  }

  // Simple similarity check
  const claimLower = claim.toLowerCase();
  const supporting = [];
  const contradicting = [];

  for (const fact of similarFacts) {
    const factLower = fact.content.toLowerCase();

    // Check for contradiction indicators
    const hasNegation = factLower.includes('not ') || factLower.includes('no ') ||
                        factLower.includes('never') || factLower.includes('不') ||
                        factLower.includes('没有');

    // Simple overlap check
    const claimWords = new Set(claimLower.split(/\s+/).filter(w => w.length > 2));
    const factWords = new Set(factLower.split(/\s+/).filter(w => w.length > 2));

    let overlap = 0;
    for (const word of claimWords) {
      if (factWords.has(word)) overlap++;
    }

    const similarity = claimWords.size > 0 ? overlap / claimWords.size : 0;

    if (similarity > 0.3) {
      if (hasNegation !== claimLower.includes('not ')) {
        contradicting.push({ fact, similarity });
      } else {
        supporting.push({ fact, similarity });
      }
    }
  }

  const verified = supporting.length > 0 && contradicting.length === 0;
  const confidence = supporting.length > 0
    ? Math.min(0.9, supporting.reduce((sum, s) => sum + s.fact.confidence * s.similarity, 0) / supporting.length)
    : 0;

  return {
    verified,
    confidence,
    reason: verified
      ? `Claim supported by ${supporting.length} fact(s)`
      : contradicting.length > 0
        ? `Potential contradiction found`
        : `Insufficient evidence`,
    supporting_facts: supporting.map(s => s.fact),
    contradicting_facts: contradicting.map(c => c.fact)
  };
}

/**
 * Get entity graph (relationships via shared facts)
 * @param {string} entityName - Starting entity
 * @param {number} depth - How many hops to traverse
 * @returns {object} Entity relationship graph
 */
export function getEntityGraph(entityName, depth = 2) {
  const visited = new Set();
  const nodes = [];
  const edges = [];

  function traverse(name, currentDepth) {
    if (currentDepth > depth || visited.has(name.toLowerCase())) return;
    visited.add(name.toLowerCase());

    const entity = getEntityFacts(name);
    if (!entity) return;

    nodes.push({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      fact_count: entity.facts.length
    });

    // Find related entities through facts
    for (const related of entity.related_entities || []) {
      if (!visited.has(related.name.toLowerCase())) {
        edges.push({
          from: entity.id,
          to: related.id,
          label: 'related'
        });

        traverse(related.name, currentDepth + 1);
      }
    }
  }

  traverse(entityName, 0);

  return { nodes, edges };
}
