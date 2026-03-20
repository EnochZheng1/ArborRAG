/**
 * Structured Query Handler
 *
 * For queries like "What is Plan A's premium?" or "Plans under $500",
 * queries the facts table by attribute instead of relying on chunk retrieval.
 *
 * Returns structured facts when available, or null to signal fallback to
 * standard chunk-based retrieval.
 */

import { EntityFactRepo } from "../db/repositories/EntityFactRepo.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { safeJson } from "../db/db.js";
import { queryLogger as logger } from "../utils/logger.js";

/**
 * Extract numeric value and operator from a query fragment.
 * E.g. "under $500" → { operator: '<', value: 500 }
 *      "above 1000" → { operator: '>', value: 1000 }
 * @param {string} query
 * @returns {{ operator: string, value: number } | null}
 */
function extractNumericFilter(query) {
  const patterns = [
    { regex: /(?:under|below|less\s+than|cheaper\s+than|低于|不超过)\s*\$?\s*([\d,.]+)/i, op: '<' },
    { regex: /(?:above|over|more\s+than|greater\s+than|超过|高于)\s*\$?\s*([\d,.]+)/i, op: '>' },
    { regex: /(?:exactly|equal\s+to|等于)\s*\$?\s*([\d,.]+)/i, op: '=' },
    { regex: /(?:at\s+least|minimum|最少|至少)\s*\$?\s*([\d,.]+)/i, op: '>=' },
    { regex: /(?:at\s+most|maximum|最多|不超过)\s*\$?\s*([\d,.]+)/i, op: '<=' }
  ];

  for (const { regex, op } of patterns) {
    const m = query.match(regex);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(num)) return { operator: op, value: num };
    }
  }
  return null;
}

/**
 * Extract a numeric value from fact content for comparison.
 * @param {string} content
 * @returns {number | null}
 */
function extractNumberFromContent(content) {
  const m = content.match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    const num = parseFloat(m[1].replace(/,/g, ''));
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Try to answer a query using structured facts from the entity-fact tables.
 *
 * @param {string} query - User query
 * @param {object} classification - Query classification from classifier.js
 * @returns {Promise<{ facts: object[], entities: object[], context: string, structured: true } | null>}
 *          Returns null if structured query is not possible or not useful.
 */
export function tryStructuredQuery(query, classification) {
  // Only attempt if entity extraction is enabled for this dataset
  const enabled = DatasetConfigRepo.get('entity_extraction_enabled');
  if (enabled !== 'true') return null;

  // Check if we even have facts with attributes
  try {
    const factCount = EntityFactRepo.getActiveFactCount();
    if (factCount === 0) return null;
  } catch (_) {
    return null;
  }

  const entities = classification.entities || [];
  const queryLower = query.toLowerCase();

  // Strategy 1: Entity + attribute lookup
  // "What is Plan A's premium?" → entity="Plan A", attribute matches "premium"
  if (entities.length > 0) {
    return tryEntityAttributeLookup(query, entities, queryLower);
  }

  // Strategy 2: Attribute filter across all entities
  // "Plans under $500" → attribute with numeric filter
  const numFilter = extractNumericFilter(query);
  if (numFilter) {
    return tryNumericFilter(query, numFilter, queryLower);
  }

  return null;
}

/**
 * Look up facts for specific entities by matching query terms to attribute names.
 */
function tryEntityAttributeLookup(query, entityNames, queryLower) {
  const results = [];

  for (const entityName of entityNames) {
    // Find the entity in the DB
    const normalizedName = entityName.toLowerCase().replace(/\s+/g, '_');
    let entity = EntityFactRepo.findByNormalized(normalizedName);
    if (!entity) {
      entity = EntityFactRepo.findByPartialMatch(normalizedName, entityName);
    }
    if (!entity) continue;

    // Get all structured facts for this entity
    const facts = EntityFactRepo.getStructuredFactsForEntities([entity.id], 50);
    if (facts.length === 0) continue;

    // Find which attributes the query mentions
    const matchedFacts = [];
    for (const fact of facts) {
      if (!fact.attribute_name) continue;
      const attrLower = fact.attribute_name.toLowerCase();
      // Check if query mentions this attribute
      if (queryLower.includes(attrLower) || queryLower.includes(attrLower.replace(/_/g, ' '))) {
        matchedFacts.push(fact);
      }
    }

    // If no specific attribute matched, return all structured facts
    const relevantFacts = matchedFacts.length > 0 ? matchedFacts : facts.slice(0, 10);

    results.push({
      entity_name: entity.name,
      entity_id: entity.id,
      entity_type: entity.type,
      facts: relevantFacts.map(f => ({
        content: f.content,
        attribute_name: f.attribute_name,
        fact_type: f.fact_type,
        confidence: f.confidence
      }))
    });
  }

  if (results.length === 0) return null;

  // Build context string for the LLM
  const contextParts = [];
  for (const r of results) {
    contextParts.push(`[${r.entity_name}]`);
    for (const f of r.facts) {
      const attr = f.attribute_name ? `(${f.attribute_name}) ` : '';
      contextParts.push(`  ${attr}${f.content}`);
    }
  }

  return {
    facts: results.flatMap(r => r.facts),
    entities: results.map(r => ({ name: r.entity_name, id: r.entity_id, type: r.entity_type })),
    context: contextParts.join('\n'),
    structured: true
  };
}

/**
 * Filter facts across all entities by numeric attribute value.
 */
function tryNumericFilter(query, numFilter, queryLower) {
  // Try to find which attribute the user is filtering on
  // Look for known attribute names in the query
  const allNodes = NodeRepo.getAllSortedByLevel();
  const attributeNames = new Set();

  for (const node of allNodes) {
    const attrs = safeJson(node.attributes_json, []);
    for (const a of attrs) {
      if (['number', 'currency'].includes(a.type)) {
        attributeNames.add(a.name);
      }
    }
  }

  if (attributeNames.size === 0) return null;

  // Match query to an attribute
  let matchedAttr = null;
  for (const attrName of attributeNames) {
    const attrLower = attrName.toLowerCase();
    if (queryLower.includes(attrLower) || queryLower.includes(attrLower.replace(/_/g, ' '))) {
      matchedAttr = attrName;
      break;
    }
  }

  if (!matchedAttr) {
    // If no attribute name matched, try the first numeric attribute as a guess
    matchedAttr = [...attributeNames][0];
  }

  // Get all facts for this attribute
  const facts = EntityFactRepo.getFactsByAttribute(matchedAttr);
  if (facts.length === 0) return null;

  // Apply numeric filter
  const filtered = facts.filter(f => {
    const num = extractNumberFromContent(f.content);
    if (num === null) return false;

    switch (numFilter.operator) {
      case '<':  return num < numFilter.value;
      case '>':  return num > numFilter.value;
      case '=':  return num === numFilter.value;
      case '<=': return num <= numFilter.value;
      case '>=': return num >= numFilter.value;
      default:   return false;
    }
  });

  if (filtered.length === 0) return null;

  // Build context
  const contextParts = [`Attribute: ${matchedAttr}, Filter: ${numFilter.operator} ${numFilter.value}`];
  for (const f of filtered) {
    contextParts.push(`  [${f.entity_name}] ${f.content}`);
  }

  return {
    facts: filtered.map(f => ({
      content: f.content,
      attribute_name: f.attribute_name || matchedAttr,
      entity_name: f.entity_name,
      fact_type: f.fact_type,
      confidence: f.confidence
    })),
    entities: [...new Map(filtered.map(f => [f.entity_name, { name: f.entity_name, type: f.entity_type }])).values()],
    context: contextParts.join('\n'),
    filter: numFilter,
    structured: true
  };
}
