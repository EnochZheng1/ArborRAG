import { callLLM, llmConfig } from "../utils/llm.js";
import { safeJson } from "../db/db.js";
import { EntityFactRepo } from "../db/repositories/EntityFactRepo.js";
import { getPrompt, isChineseLang } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { logger } from "../utils/logger.js";

/**
 * Entity-Fact Extraction Module
 *
 * Extracts structured entities and facts from document chunks,
 * maintaining links back to source chunks as evidence.
 */

// Note: entity/fact tables are initialized by initDatasetDb() for each dataset connection.

/**
 * Extract entities and facts from a chunk
 * @param {object} chunk - Chunk object with content
 * @param {object} options - Extraction options
 * @returns {Promise<object>} Extracted entities and facts
 */
export async function extractEntitiesAndFacts(chunk, options = {}) {
  const { useLLM = true, existingEntities = [] } = options;

  const content = chunk.content || chunk.content_clean || '';
  if (!content || content.length < 20) {
    return { entities: [], facts: [] };
  }

  if (!useLLM) {
    return extractWithRules(content, chunk);
  }

  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return extractWithRules(content, chunk);
  }

  try {
    // Detect language from content
    const lang = getEffectiveLang(content);

    // Provide existing entities for deduplication hints
    const existingHint = existingEntities.length > 0
      ? (isChineseLang(lang)
        ? `\n已知实体(如引用相同内容请使用完全相同的名称): ${existingEntities.slice(0, 15).map(e => e.name).join(', ')}`
        : `\nKnown entities (reuse exact names if referring to same thing): ${existingEntities.slice(0, 15).map(e => e.name).join(', ')}`)
      : '';

    // Use bilingual prompt based on content language
    const prompt = getPrompt('entityFactExtraction', lang, content.slice(0, 3000), existingHint);

    const text = await callLLM({ prompt, temperature: 0.1, maxOutputTokens: 4000, taskName: 'entity_extraction' }) || '';

    // Try to extract JSON, handling various formats
    let jsonStr = text;

    // Remove markdown code blocks if present
    jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // Find JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Entity extraction: no JSON found in LLM response, falling back to rules');
      return extractWithRules(content, chunk);
    }

    jsonStr = jsonMatch[0];

    // Try to parse, with repair attempts if needed
    let extracted;
    try {
      extracted = JSON.parse(jsonStr);
    } catch (parseError) {
      // Try to repair common JSON issues
      extracted = tryRepairAndParseJSON(jsonStr);
      if (!extracted) {
        logger.warn('Entity extraction: JSON repair failed, falling back to rules');
        return extractWithRules(content, chunk);
      }
    }

    // Validate and clean entities
    const entities = (extracted.entities || []).map(e => ({
      name: String(e.name || '').trim(),
      type: validateEntityType(e.type),
      description: e.description ? String(e.description).trim() : null,
      aliases: Array.isArray(e.aliases) ? e.aliases.map(a => String(a).trim()) : []
    })).filter(e => e.name && e.name.length >= 2);

    // Validate and clean facts
    const facts = (extracted.facts || []).map(f => ({
      content: String(f.content || '').trim(),
      type: validateFactType(f.type),
      confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : 0.8,
      entities: Array.isArray(f.entities) ? f.entities.map(e => String(e).trim()) : []
    })).filter(f => f.content && f.content.length >= 10);

    return { entities, facts };
  } catch (error) {
    rethrowIfRateLimit(error);
    logger.error(`Entity-fact extraction error: ${error.message}`);
    return extractWithRules(content, chunk);
  }
}

/**
 * Attempt to repair and parse malformed JSON
 */
function tryRepairAndParseJSON(jsonStr) {
  try {
    // First try as-is
    return JSON.parse(jsonStr);
  } catch (e) {
    // Try various repairs
    let repaired = jsonStr;

    // Remove trailing commas before ] or }
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    // Fix unquoted keys
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

    // Fix single quotes to double quotes (careful with apostrophes)
    repaired = repaired.replace(/:\s*'([^']*?)'/g, ': "$1"');

    // Truncated JSON - try to close arrays and objects
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;

    // Add missing closing brackets/braces
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
      repaired += ']';
    }
    for (let i = 0; i < openBraces - closeBraces; i++) {
      repaired += '}';
    }

    // Remove incomplete last element if ending with comma
    repaired = repaired.replace(/,\s*([}\]])$/g, '$1');

    try {
      return JSON.parse(repaired);
    } catch (e2) {
      // Last resort: try to extract just entities or facts arrays
      try {
        const entitiesMatch = jsonStr.match(/"entities"\s*:\s*\[([\s\S]*?)\]/);
        const factsMatch = jsonStr.match(/"facts"\s*:\s*\[([\s\S]*?)\]/);

        const result = { entities: [], facts: [] };

        if (entitiesMatch) {
          try {
            result.entities = JSON.parse('[' + entitiesMatch[1] + ']');
          } catch (e) {}
        }

        if (factsMatch) {
          try {
            result.facts = JSON.parse('[' + factsMatch[1] + ']');
          } catch (e) {}
        }

        if (result.entities.length > 0 || result.facts.length > 0) {
          return result;
        }
      } catch (e3) {}

      return null;
    }
  }
}

/**
 * Rule-based extraction fallback
 */
function extractWithRules(content, chunk) {
  const entities = [];
  const facts = [];
  const entityNames = new Set();

  // Extract capitalized phrases as potential entities (English)
  const capitalizedMatches = content.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
  for (const match of capitalizedMatches) {
    if (match.length >= 3 && !isCommonWord(match) && !entityNames.has(match.toLowerCase())) {
      entityNames.add(match.toLowerCase());
      entities.push({
        name: match,
        type: guessEntityType(match),
        description: null,
        aliases: []
      });
    }
  }

  // Extract quoted terms
  const quotedMatches = content.match(/["'「」『』]([^"'「」『』]+)["'「」『』]/g) || [];
  for (const match of quotedMatches) {
    const clean = match.replace(/["'「」『』]/g, '').trim();
    if (clean.length >= 2 && clean.length <= 30 && !entityNames.has(clean.toLowerCase())) {
      entityNames.add(clean.toLowerCase());
      entities.push({
        name: clean,
        type: 'concept',
        description: null,
        aliases: []
      });
    }
  }

  // Extract Chinese noun phrases (more comprehensive patterns)
  const chinesePatterns = [
    /[\u4e00-\u9fa5]{2,6}(?:系统|平台|功能|模块|服务|产品|方案|流程|管理|处理)/g,
    /[\u4e00-\u9fa5]{2,4}(?:部门|公司|团队|中心)/g,
    /[\u4e00-\u9fa5]{3,8}/g
  ];

  for (const pattern of chinesePatterns) {
    const matches = content.match(pattern) || [];
    for (const match of matches) {
      if (!isChineseStopWord(match) && !entityNames.has(match)) {
        entityNames.add(match);
        entities.push({
          name: match,
          type: guessChineseEntityType(match),
          description: null,
          aliases: []
        });
      }
    }
  }

  // Limit entities
  const limitedEntities = entities.slice(0, 30);

  // Extract facts from sentences
  const sentences = content.split(/[.。!?！？;\n]+/).filter(s => s.trim().length > 15);

  for (const sentence of sentences.slice(0, 20)) {
    const trimmed = sentence.trim();
    if (trimmed.length >= 15 && trimmed.length <= 500) {
      // Try to identify related entities
      const relatedEntities = limitedEntities
        .filter(e => trimmed.includes(e.name))
        .map(e => e.name)
        .slice(0, 5);

      // Detect fact type based on patterns
      const factType = detectFactType(trimmed);

      if (relatedEntities.length > 0 || factType !== 'attribute') {
        facts.push({
          content: trimmed,
          type: factType,
          confidence: relatedEntities.length > 0 ? 0.7 : 0.5,
          entities: relatedEntities
        });
      }
    }
  }

  return { entities: limitedEntities, facts: facts.slice(0, 30) };
}

/**
 * Guess entity type from English name
 */
function guessEntityType(name) {
  const lower = name.toLowerCase();
  if (/inc|corp|ltd|llc|company|group/i.test(lower)) return 'organization';
  if (/system|platform|software|app|tool/i.test(lower)) return 'product';
  if (/process|workflow|procedure/i.test(lower)) return 'process';
  if (/feature|function|capability/i.test(lower)) return 'feature';
  return 'concept';
}

/**
 * Guess entity type from Chinese name
 */
function guessChineseEntityType(name) {
  if (/公司|集团|部门|团队|中心/.test(name)) return 'organization';
  if (/系统|平台|软件|产品|工具/.test(name)) return 'product';
  if (/流程|过程|步骤|程序/.test(name)) return 'process';
  if (/功能|特性|能力/.test(name)) return 'feature';
  if (/服务/.test(name)) return 'service';
  return 'concept';
}

/**
 * Detect fact type from content
 */
function detectFactType(content) {
  if (/是指|定义为|即|means|is defined as|refers to/i.test(content)) return 'definition';
  if (/步骤|首先|然后|接着|最后|step|first|then|finally/i.test(content)) return 'procedure';
  if (/比|相比|优于|不如|compared|versus|better|worse/i.test(content)) return 'comparison';
  if (/包含|由.*组成|consists of|contains|includes/i.test(content)) return 'relationship';
  if (/规格|参数|尺寸|重量|spec|parameter|dimension/i.test(content)) return 'specification';
  return 'attribute';
}

/**
 * Save extracted entities and facts to database
 * @param {object} extraction - Extracted entities and facts
 * @param {number} chunkId - Source chunk ID
 * @param {object} options - Options
 * @returns {object} Saved entity and fact IDs
 */
export function saveExtraction(extraction, chunkId, options = {}) {
  const { nodeId = null } = options;
  const savedEntities = new Map();
  const savedFacts = [];

  // Save entities (with deduplication)
  for (const entity of extraction.entities) {
    const normalizedName = normalizeEntityName(entity.name);

    const existing = EntityFactRepo.findByNormalizedAndType(normalizedName, entity.type);

    let entityId;
    if (existing) {
      entityId = existing.id;
      const existingAliases = safeJson(existing.aliases_json, []);
      const newAliases = [...new Set([...existingAliases, ...entity.aliases])];
      EntityFactRepo.updateAliases(entityId, JSON.stringify(newAliases));
    } else {
      const result = EntityFactRepo.insertEntity({
        name: entity.name,
        normalizedName,
        type: entity.type,
        description: entity.description,
        nodeId,
        aliasesJson: JSON.stringify(entity.aliases)
      });
      entityId = result.lastInsertRowid;
    }

    savedEntities.set(entity.name, entityId);

    // Record entity mention in chunk
    try {
      if (chunkId) {
        EntityFactRepo.upsertMention(entityId, chunkId);
      }
    } catch (e) {
      logger.warn(`Failed to record entity mention: entity=${entityId}, chunk=${chunkId}: ${e.message}`);
    }
  }

  // Save facts
  for (const fact of extraction.facts) {
    const existingFact = EntityFactRepo.findFactByContent(fact.content);

    let factId;
    if (existingFact) {
      factId = existingFact.id;
    } else {
      const result = EntityFactRepo.insertFact({
        content: fact.content,
        factType: fact.type,
        confidence: fact.confidence
      });
      factId = result.lastInsertRowid;
    }

    savedFacts.push(factId);

    // Link fact to entities
    for (const entityName of fact.entities) {
      const entityId = savedEntities.get(entityName);
      if (entityId) {
        try {
          EntityFactRepo.insertEntityFactLink(entityId, factId);
        } catch (e) {
          // Ignore duplicates
        }
      }
    }

    // Link fact to source chunk (evidence)
    try {
      EntityFactRepo.insertFactEvidence(factId, chunkId, fact.confidence);
    } catch (e) {
      // Ignore if chunk doesn't exist
    }
  }

  return {
    entityIds: Array.from(savedEntities.values()),
    factIds: savedFacts
  };
}

/**
 * Process a chunk for entity-fact extraction
 * @param {object} chunk - Chunk to process
 * @param {object} options - Options
 * @returns {Promise<object>} Extraction results
 */
export async function processChunkForExtraction(chunk, options = {}) {
  const existingEntities = EntityFactRepo.getRecent(50);

  const extraction = await extractEntitiesAndFacts(chunk, {
    ...options,
    existingEntities
  });

  if (extraction.entities.length > 0 || extraction.facts.length > 0) {
    const saved = saveExtraction(extraction, chunk.id, {
      nodeId: chunk.node_id
    });

    return {
      chunk_id: chunk.id,
      entities_extracted: extraction.entities.length,
      facts_extracted: extraction.facts.length,
      entity_ids: saved.entityIds,
      fact_ids: saved.factIds
    };
  }

  return {
    chunk_id: chunk.id,
    entities_extracted: 0,
    facts_extracted: 0
  };
}

/**
 * Process all chunks in a document
 * @param {number} docId - Document ID
 * @param {object} options - Options
 * @returns {Promise<object>} Processing summary
 */
export async function processDocumentForExtraction(docId, options = {}) {
  const {
    useLLM = true,
    batchSize = 5,           // Process chunks in batches
    delayBetweenBatches = 500, // ms delay between batches for rate limiting
    onProgress = null        // Optional progress callback
  } = options;

  const chunks = EntityFactRepo.getActiveChunksForDoc(docId);

  const results = {
    doc_id: docId,
    chunks_total: chunks.length,
    chunks_processed: 0,
    chunks_skipped: 0,
    total_entities: 0,
    total_facts: 0,
    unique_entities: new Set(),
    errors: []
  };

  if (chunks.length === 0) {
    return results;
  }

  logger.info(`Entity extraction: processing ${chunks.length} chunks for document ${docId}`);

  // Process in batches to avoid rate limits
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    // Process batch sequentially (LLM calls shouldn't be parallelized)
    for (const chunk of batch) {
      // Skip very short chunks
      if (!chunk.content_clean || chunk.content_clean.length < 50) {
        results.chunks_skipped++;
        continue;
      }

      try {
        const result = await processChunkForExtraction({
          id: chunk.id,
          content_clean: chunk.content_clean,
          node_id: chunk.node_id,
          doc_title: chunk.doc_title
        }, { useLLM });

        results.chunks_processed++;
        results.total_entities += result.entities_extracted;
        results.total_facts += result.facts_extracted;

        // Track unique entities
        if (result.entity_ids) {
          result.entity_ids.forEach(id => results.unique_entities.add(id));
        }

        // Report progress
        if (onProgress) {
          onProgress({
            processed: results.chunks_processed,
            total: chunks.length,
            entities: results.total_entities,
            facts: results.total_facts
          });
        }
      } catch (error) {
        results.errors.push({ chunk_id: chunk.id, error: error.message });
        logger.error(`Entity extraction: error on chunk ${chunk.id}: ${error.message}`);
      }
    }

    // Rate limit delay between batches (only if using LLM and not the last batch)
    if (useLLM && i + batchSize < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }

    // Log progress every few batches
    if ((i / batchSize) % 5 === 0 || i + batchSize >= chunks.length) {
      logger.debug(`Entity extraction progress: ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks, ${results.total_entities} entities, ${results.total_facts} facts`);
    }
  }

  // Convert Set to count
  results.unique_entity_count = results.unique_entities.size;
  delete results.unique_entities;

  logger.info(`Entity extraction complete: ${results.total_entities} entities, ${results.total_facts} facts from ${results.chunks_processed} chunks`);

  return results;
}

// Helper functions

function normalizeEntityName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function validateEntityType(type) {
  const validTypes = ['product', 'concept', 'person', 'organization', 'location', 'process', 'feature'];
  return validTypes.includes(type) ? type : 'concept';
}

function validateFactType(type) {
  const validTypes = ['attribute', 'relationship', 'definition', 'procedure', 'comparison'];
  return validTypes.includes(type) ? type : 'attribute';
}

function isCommonWord(word) {
  const common = new Set([
    'The', 'This', 'That', 'These', 'Those', 'Here', 'There', 'When', 'Where',
    'What', 'Which', 'Who', 'How', 'Why', 'And', 'But', 'For', 'With', 'From'
  ]);
  return common.has(word);
}

function isChineseStopWord(word) {
  const stops = new Set([
    '的', '是', '在', '了', '和', '与', '或', '但', '如果', '那么',
    '这个', '那个', '什么', '怎么', '为什么', '可以', '需要', '应该',
    '因为', '所以', '然后', '但是', '而且', '或者', '如果', '虽然'
  ]);
  return stops.has(word);
}

/**
 * Get all entities with their facts
 * @param {object} filters - Filters
 * @returns {Array} Entities with facts
 */
export function getEntitiesWithFacts(filters = {}) {
  const { type, nodeId, limit = 50 } = filters;
  const entities = EntityFactRepo.getEntitiesFiltered({ type, nodeId, limit });

  return entities.map(entity => ({
    ...entity,
    aliases: safeJson(entity.aliases_json, []),
    facts: EntityFactRepo.getFactsForEntityWithEvidence(entity.id)
  }));
}

/**
 * Get facts about a specific entity
 * @param {string} entityName - Entity name
 * @returns {object} Entity with facts and evidence
 */
export function getEntityFacts(entityName) {
  const normalizedName = normalizeEntityName(entityName);

  const entity = EntityFactRepo.findByNormalized(normalizedName)
    ?? EntityFactRepo.findByPartialMatch(normalizedName, entityName);

  if (!entity) return null;
  return getEntityFactsById(entity.id);
}

/**
 * Get facts by entity ID with evidence
 */
function getEntityFactsById(entityId) {
  const entity = EntityFactRepo.findById(entityId);
  if (!entity) return null;

  const facts = EntityFactRepo.getEntityFullFacts(entityId);
  const factsWithEvidence = facts.map(fact => ({
    ...fact,
    evidence: EntityFactRepo.getFactEvidenceWithChunks(fact.id)
  }));

  return {
    ...entity,
    aliases: safeJson(entity.aliases_json, []),
    facts: factsWithEvidence,
    related_entities: EntityFactRepo.getRelatedEntitiesForEntity(entityId)
  };
}

/**
 * Search facts by content
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Array} Matching facts with entities and evidence
 */
export function searchFacts(query, limit = 20) {
  return EntityFactRepo.searchFactsByContent(query, limit).map(fact => ({
    ...fact,
    entities: fact.entity_names ? fact.entity_names.split(',') : [],
    evidence: EntityFactRepo.getEvidenceForFact(fact.id)
  }));
}

/**
 * Find conflicting facts
 * @returns {Array} Potential conflicts
 */
export function findConflictingFacts() {
  return EntityFactRepo.findConflictingFacts();
}

/**
 * Link entity to tree node
 * @param {number} entityId - Entity ID
 * @param {string} nodeId - Node ID
 */
export function linkEntityToNode(entityId, nodeId) {
  EntityFactRepo.linkToNode(entityId, nodeId);
}

/**
 * Get extraction statistics
 */
export function getExtractionStats() {
  return {
    entities: EntityFactRepo.getEntityCount(),
    facts: EntityFactRepo.getActiveFactCount(),
    entity_fact_links: EntityFactRepo.getEntityFactLinkCount(),
    fact_evidence_links: EntityFactRepo.getFactEvidenceLinkCount(),
    entities_by_type: EntityFactRepo.getEntitiesByType(),
    facts_by_type: EntityFactRepo.getFactsByType(),
    top_entities: EntityFactRepo.getTopEntities(10)
  };
}

/**
 * Get documents that need entity extraction
 * @returns {Array} Documents without entity extraction
 */
export function getDocumentsNeedingExtraction() {
  return EntityFactRepo.getDocsNeedingExtraction().map(d => ({
    ...d,
    title: d.original_name || d.filename,
    needs_extraction: d.extracted_chunks < d.chunk_count * 0.5,
    extraction_coverage: d.chunk_count > 0 ? Math.round(d.extracted_chunks / d.chunk_count * 100) : 0
  }));
}

/**
 * Bulk extract entities from all unprocessed documents
 * @param {object} options - Options
 * @returns {Promise<object>} Bulk extraction results
 */
export async function bulkExtractEntities(options = {}) {
  const { maxDocuments = 10, useLLM = true, onDocumentComplete = null } = options;

  const docs = getDocumentsNeedingExtraction().slice(0, maxDocuments);

  const results = {
    documents_processed: 0,
    documents_total: docs.length,
    total_entities: 0,
    total_facts: 0,
    errors: [],
    documents: []
  };

  logger.info(`Bulk entity extraction: starting for ${docs.length} documents`);

  for (const doc of docs) {
    try {
      logger.info(`Bulk entity extraction: processing document ${doc.id} (${doc.original_name || doc.filename})`);

      const docResult = await processDocumentForExtraction(doc.id, { useLLM });

      results.documents_processed++;
      results.total_entities += docResult.total_entities;
      results.total_facts += docResult.total_facts;

      results.documents.push({
        doc_id: doc.id,
        filename: doc.filename,
        entities: docResult.total_entities,
        facts: docResult.total_facts,
        success: true
      });

      if (onDocumentComplete) {
        onDocumentComplete({
          doc_id: doc.id,
          progress: results.documents_processed,
          total: docs.length
        });
      }
    } catch (error) {
      logger.error(`Bulk entity extraction: error on document ${doc.id}: ${error.message}`);
      results.errors.push({ doc_id: doc.id, error: error.message });
      results.documents.push({
        doc_id: doc.id,
        filename: doc.filename,
        success: false,
        error: error.message
      });
    }
  }

  logger.info(`Bulk entity extraction complete: ${results.documents_processed} documents, ${results.total_entities} entities, ${results.total_facts} facts`);

  return results;
}

/**
 * Extract entities from specific chunks (for incremental extraction)
 * @param {number[]} chunkIds - Chunk IDs to process
 * @param {object} options - Options
 * @returns {Promise<object>} Extraction results
 */
export async function extractFromChunks(chunkIds, options = {}) {
  const { useLLM = true } = options;

  const results = {
    chunks_processed: 0,
    total_entities: 0,
    total_facts: 0,
    errors: []
  };

  for (const chunkId of chunkIds) {
    const chunk = EntityFactRepo.getActiveChunk(chunkId);

    if (!chunk) {
      results.errors.push({ chunk_id: chunkId, error: 'Chunk not found' });
      continue;
    }

    try {
      const result = await processChunkForExtraction({
        id: chunk.id,
        content_clean: chunk.content_clean,
        node_id: chunk.node_id,
        doc_title: chunk.doc_title
      }, { useLLM });

      results.chunks_processed++;
      results.total_entities += result.entities_extracted;
      results.total_facts += result.facts_extracted;
    } catch (error) {
      results.errors.push({ chunk_id: chunkId, error: error.message });
    }
  }

  return results;
}

/**
 * Get entities and facts for a specific tree node
 * @param {string} nodeId - Node ID
 * @param {object} options - Options
 * @returns {object} Entities and facts for the node
 */
export function getNodeEntitiesAndFacts(nodeId, options = {}) {
  const { limit = 50, debug = false } = options;

  if (debug) {
    logger.debug(`getNodeEntitiesAndFacts: totalEntities=${EntityFactRepo.countEntities()}, totalMentions=${EntityFactRepo.countMentions()}, entitiesWithNodeId=${EntityFactRepo.countEntitiesWithNodeId(nodeId)}, chunksInNode=${EntityFactRepo.countChunksInNode(nodeId)}`);
  }

  // Get entities via mention_stats + fact_stats (primary)
  let entities = EntityFactRepo.getEntitiesForNodePrimary(nodeId, limit);

  // Fallback 1: simpler entity_mentions join
  if (entities.length === 0) {
    entities = EntityFactRepo.getEntitiesForNodeFallback1(nodeId, limit);
  }

  // Fallback 2: via fact_evidence → chunks
  if (entities.length === 0) {
    const chunkIds = EntityFactRepo.getChunkIdsForNode(nodeId);
    if (chunkIds.length > 0) {
      entities = EntityFactRepo.getEntitiesForNodeFallback2(chunkIds, limit);
    }
  }

  // Fallback 3 (debug only): all entities
  if (entities.length === 0 && debug) {
    entities = EntityFactRepo.getAllEntitiesForDebug(10);
    logger.debug(`getNodeEntitiesAndFacts: fallback to all entities, found ${entities.length}`);
  }

  const facts = EntityFactRepo.getFactsForNode(nodeId, limit);

  const enrichedEntities = entities.map(entity => ({
    id: entity.id,
    name: entity.name,
    type: entity.type,
    description: entity.description,
    mention_count: entity.mention_count,
    fact_count: entity.fact_count,
    aliases: safeJson(entity.aliases_json, []),
    facts: EntityFactRepo.getTopFactsForEntity(entity.id)
  }));

  let debugInfo = null;
  if (debug) {
    debugInfo = {
      total_entities_in_db: EntityFactRepo.countEntities(),
      total_mentions_in_db: EntityFactRepo.countMentions(),
      total_facts_in_db: EntityFactRepo.countFacts(),
      total_evidence_in_db: EntityFactRepo.countEvidence(),
      entities_with_this_node_id: EntityFactRepo.countEntitiesWithNodeId(nodeId),
      chunks_in_this_node: EntityFactRepo.countChunksInNode(nodeId),
      mentions_for_node_chunks: EntityFactRepo.countMentionsForNodeChunks(nodeId),
      queried_node_id: nodeId,
      nodes_with_entities: EntityFactRepo.getNodesWithEntities()
    };
  }

  return {
    node_id: nodeId,
    entities: enrichedEntities,
    facts: facts.map(f => ({
      id: f.id,
      content: f.content,
      fact_type: f.fact_type,
      confidence: f.confidence,
      source_doc: f.source_doc,
      source_excerpt: f.source_excerpt
    })),
    summary: {
      entity_count: entities.length,
      fact_count: facts.length,
      entity_types: [...new Set(entities.map(e => e.type))],
      fact_types: [...new Set(facts.map(f => f.fact_type))]
    },
    ...(debug ? { debug: debugInfo } : {})
  };
}
