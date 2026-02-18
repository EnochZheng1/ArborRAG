import { GoogleGenAI } from "@google/genai";
import { db, safeJson } from "../db/db.js";
import { recordTokenUsage } from "../utils/tokenTracker.js";
import { detectLanguage, getPrompt } from "../utils/langDetect.js";

/**
 * Entity-Fact Extraction Module
 *
 * Extracts structured entities and facts from document chunks,
 * maintaining links back to source chunks as evidence.
 */

// Initialize tables
export function initEntityFactTables() {
  db.exec(`
    -- Entities table: stores extracted entities
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      type TEXT NOT NULL,  -- product, concept, person, organization, location, process, feature
      description TEXT,
      node_id TEXT,  -- optional link to tree node
      aliases_json TEXT,  -- JSON array of alternative names
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(normalized_name, type)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_node ON entities(node_id);

    -- Facts table: stores extracted factual statements
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      fact_type TEXT,  -- attribute, relationship, definition, procedure, comparison
      confidence REAL DEFAULT 0.8,
      status TEXT DEFAULT 'active',  -- active, superseded, disputed
      superseded_by INTEGER,  -- reference to newer fact
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(fact_type);
    CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);

    -- Entity-Fact relationships (many-to-many)
    CREATE TABLE IF NOT EXISTS entity_facts (
      entity_id INTEGER NOT NULL,
      fact_id INTEGER NOT NULL,
      role TEXT DEFAULT 'subject',  -- subject, object, related
      PRIMARY KEY (entity_id, fact_id),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entity_facts_entity ON entity_facts(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_facts_fact ON entity_facts(fact_id);

    -- Fact-Chunk evidence links (provenance)
    CREATE TABLE IF NOT EXISTS fact_evidence (
      fact_id INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      relevance_score REAL DEFAULT 1.0,
      extraction_confidence REAL DEFAULT 0.8,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (fact_id, chunk_id),
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_fact_evidence_fact ON fact_evidence(fact_id);
    CREATE INDEX IF NOT EXISTS idx_fact_evidence_chunk ON fact_evidence(chunk_id);

    -- Entity mentions in chunks (for quick lookups)
    CREATE TABLE IF NOT EXISTS entity_mentions (
      entity_id INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      mention_count INTEGER DEFAULT 1,
      context_snippet TEXT,  -- short context around mention
      PRIMARY KEY (entity_id, chunk_id),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_chunk ON entity_mentions(chunk_id);
  `);
}

// Note: initEntityFactTables() is called by initDatasetDb() for each dataset connection.

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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return extractWithRules(content, chunk);
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    // Detect language from content
    const lang = detectLanguage(content);

    // Provide existing entities for deduplication hints
    const existingHint = existingEntities.length > 0
      ? (lang === 'zh'
        ? `\n已知实体(如引用相同内容请使用完全相同的名称): ${existingEntities.slice(0, 15).map(e => e.name).join(', ')}`
        : `\nKnown entities (reuse exact names if referring to same thing): ${existingEntities.slice(0, 15).map(e => e.name).join(', ')}`)
      : '';

    // Use bilingual prompt based on content language
    const prompt = getPrompt('entityFactExtraction', lang, content.slice(0, 3000), existingHint);

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.1,
        maxOutputTokens: 4000
      }
    });

    // Track token usage
    recordTokenUsage(response, 'entity_extraction', { model });

    const text = response.text?.trim() || '';

    // Try to extract JSON, handling various formats
    let jsonStr = text;

    // Remove markdown code blocks if present
    jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // Find JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('No JSON found in LLM response, falling back to rules');
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
        console.warn('JSON repair failed, falling back to rules');
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
    console.error('Entity-fact extraction error:', error.message);
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

    // Check if entity already exists
    const existing = db.prepare(`
      SELECT id, aliases_json FROM entities
      WHERE normalized_name = ? AND type = ?
    `).get(normalizedName, entity.type);

    let entityId;
    if (existing) {
      entityId = existing.id;

      // Merge aliases
      const existingAliases = safeJson(existing.aliases_json, []);
      const newAliases = [...new Set([...existingAliases, ...entity.aliases])];

      db.prepare(`
        UPDATE entities SET aliases_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(newAliases), entityId);
    } else {
      // Insert new entity
      const result = db.prepare(`
        INSERT INTO entities (name, normalized_name, type, description, node_id, aliases_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entity.name,
        normalizedName,
        entity.type,
        entity.description,
        nodeId,
        JSON.stringify(entity.aliases)
      );
      entityId = result.lastInsertRowid;
    }

    savedEntities.set(entity.name, entityId);

    // Record entity mention in chunk - this is the key link for finding entities by node
    try {
      if (chunkId) {
        db.prepare(`
          INSERT INTO entity_mentions (entity_id, chunk_id, mention_count)
          VALUES (?, ?, 1)
          ON CONFLICT(entity_id, chunk_id) DO UPDATE SET
            mention_count = mention_count + 1
        `).run(entityId, chunkId);
      }
    } catch (e) {
      console.warn(`Failed to record entity mention: entity=${entityId}, chunk=${chunkId}, error=${e.message}`);
    }
  }

  // Save facts
  for (const fact of extraction.facts) {
    // Check for duplicate facts
    const existingFact = db.prepare(`
      SELECT id FROM facts WHERE content = ?
    `).get(fact.content);

    let factId;
    if (existingFact) {
      factId = existingFact.id;
    } else {
      const result = db.prepare(`
        INSERT INTO facts (content, fact_type, confidence)
        VALUES (?, ?, ?)
      `).run(fact.content, fact.type, fact.confidence);
      factId = result.lastInsertRowid;
    }

    savedFacts.push(factId);

    // Link fact to entities
    for (const entityName of fact.entities) {
      const entityId = savedEntities.get(entityName);
      if (entityId) {
        try {
          db.prepare(`
            INSERT OR IGNORE INTO entity_facts (entity_id, fact_id, role)
            VALUES (?, ?, 'subject')
          `).run(entityId, factId);
        } catch (e) {
          // Ignore duplicates
        }
      }
    }

    // Link fact to source chunk (evidence)
    try {
      db.prepare(`
        INSERT OR IGNORE INTO fact_evidence (fact_id, chunk_id, extraction_confidence)
        VALUES (?, ?, ?)
      `).run(factId, chunkId, fact.confidence);
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
  // Get existing entities for deduplication hints
  const existingEntities = db.prepare(`
    SELECT name, type FROM entities ORDER BY id DESC LIMIT 50
  `).all();

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

  const chunks = db.prepare(`
    SELECT id, content_clean, node_id, doc_title
    FROM chunks
    WHERE document_id = ? AND status = 'active'
    ORDER BY chunk_index
  `).all(docId);

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

  console.log(`[EntityExtraction] Processing ${chunks.length} chunks for document ${docId}`);

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
        console.error(`[EntityExtraction] Error processing chunk ${chunk.id}:`, error.message);
      }
    }

    // Rate limit delay between batches (only if using LLM and not the last batch)
    if (useLLM && i + batchSize < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }

    // Log progress every few batches
    if ((i / batchSize) % 5 === 0 || i + batchSize >= chunks.length) {
      console.log(`[EntityExtraction] Progress: ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks, ${results.total_entities} entities, ${results.total_facts} facts`);
    }
  }

  // Convert Set to count
  results.unique_entity_count = results.unique_entities.size;
  delete results.unique_entities;

  console.log(`[EntityExtraction] Complete: ${results.total_entities} entities, ${results.total_facts} facts from ${results.chunks_processed} chunks`);

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

  let whereClause = '1=1';
  const params = [];

  if (type) {
    whereClause += ' AND e.type = ?';
    params.push(type);
  }
  if (nodeId) {
    whereClause += ' AND e.node_id = ?';
    params.push(nodeId);
  }

  const entities = db.prepare(`
    SELECT e.*,
           COUNT(DISTINCT ef.fact_id) as fact_count,
           COUNT(DISTINCT em.chunk_id) as mention_count
    FROM entities e
    LEFT JOIN entity_facts ef ON e.id = ef.entity_id
    LEFT JOIN entity_mentions em ON e.id = em.entity_id
    WHERE ${whereClause}
    GROUP BY e.id
    ORDER BY mention_count DESC, fact_count DESC
    LIMIT ?
  `).all(...params, limit);

  // Get facts for each entity
  return entities.map(entity => {
    const facts = db.prepare(`
      SELECT f.*, fe.chunk_id, fe.extraction_confidence
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      LEFT JOIN fact_evidence fe ON f.id = fe.fact_id
      WHERE ef.entity_id = ? AND f.status = 'active'
      ORDER BY f.confidence DESC
    `).all(entity.id);

    return {
      ...entity,
      aliases: safeJson(entity.aliases_json, []),
      facts
    };
  });
}

/**
 * Get facts about a specific entity
 * @param {string} entityName - Entity name
 * @returns {object} Entity with facts and evidence
 */
export function getEntityFacts(entityName) {
  const normalizedName = normalizeEntityName(entityName);

  const entity = db.prepare(`
    SELECT * FROM entities WHERE normalized_name = ?
  `).get(normalizedName);

  if (!entity) {
    // Try partial match
    const partialMatch = db.prepare(`
      SELECT * FROM entities
      WHERE normalized_name LIKE ? OR aliases_json LIKE ?
      ORDER BY id
      LIMIT 1
    `).get(`%${normalizedName}%`, `%${entityName}%`);

    if (!partialMatch) return null;
    return getEntityFactsById(partialMatch.id);
  }

  return getEntityFactsById(entity.id);
}

/**
 * Get facts by entity ID with evidence
 */
function getEntityFactsById(entityId) {
  const entity = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(entityId);
  if (!entity) return null;

  const facts = db.prepare(`
    SELECT f.*, ef.role
    FROM facts f
    JOIN entity_facts ef ON f.id = ef.fact_id
    WHERE ef.entity_id = ? AND f.status = 'active'
    ORDER BY f.confidence DESC
  `).all(entityId);

  // Get evidence for each fact
  const factsWithEvidence = facts.map(fact => {
    const evidence = db.prepare(`
      SELECT fe.*, c.content_clean, c.doc_title
      FROM fact_evidence fe
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE fe.fact_id = ?
    `).all(fact.id);

    return {
      ...fact,
      evidence
    };
  });

  // Get related entities
  const relatedEntities = db.prepare(`
    SELECT DISTINCT e2.*
    FROM entity_facts ef1
    JOIN entity_facts ef2 ON ef1.fact_id = ef2.fact_id
    JOIN entities e2 ON ef2.entity_id = e2.id
    WHERE ef1.entity_id = ? AND ef2.entity_id != ?
    LIMIT 10
  `).all(entityId, entityId);

  return {
    ...entity,
    aliases: safeJson(entity.aliases_json, []),
    facts: factsWithEvidence,
    related_entities: relatedEntities
  };
}

/**
 * Search facts by content
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Array} Matching facts with entities and evidence
 */
export function searchFacts(query, limit = 20) {
  const facts = db.prepare(`
    SELECT f.*, GROUP_CONCAT(DISTINCT e.name) as entity_names
    FROM facts f
    LEFT JOIN entity_facts ef ON f.id = ef.fact_id
    LEFT JOIN entities e ON ef.entity_id = e.id
    WHERE f.content LIKE ? AND f.status = 'active'
    GROUP BY f.id
    ORDER BY f.confidence DESC
    LIMIT ?
  `).all(`%${query}%`, limit);

  return facts.map(fact => {
    const evidence = db.prepare(`
      SELECT c.id, c.doc_title, c.content_clean
      FROM fact_evidence fe
      JOIN chunks c ON fe.chunk_id = c.id
      WHERE fe.fact_id = ?
      LIMIT 3
    `).all(fact.id);

    return {
      ...fact,
      entities: fact.entity_names ? fact.entity_names.split(',') : [],
      evidence
    };
  });
}

/**
 * Find conflicting facts
 * @returns {Array} Potential conflicts
 */
export function findConflictingFacts() {
  // Find facts about the same entity that might conflict
  const potentialConflicts = db.prepare(`
    SELECT
      e.name as entity_name,
      f1.id as fact1_id, f1.content as fact1_content,
      f2.id as fact2_id, f2.content as fact2_content
    FROM entity_facts ef1
    JOIN entity_facts ef2 ON ef1.entity_id = ef2.entity_id AND ef1.fact_id < ef2.fact_id
    JOIN entities e ON ef1.entity_id = e.id
    JOIN facts f1 ON ef1.fact_id = f1.id
    JOIN facts f2 ON ef2.fact_id = f2.id
    WHERE f1.fact_type = f2.fact_type
      AND f1.status = 'active' AND f2.status = 'active'
    LIMIT 50
  `).all();

  return potentialConflicts;
}

/**
 * Link entity to tree node
 * @param {number} entityId - Entity ID
 * @param {string} nodeId - Node ID
 */
export function linkEntityToNode(entityId, nodeId) {
  db.prepare(`
    UPDATE entities SET node_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nodeId, entityId);
}

/**
 * Get extraction statistics
 */
export function getExtractionStats() {
  const stats = {
    entities: db.prepare(`SELECT COUNT(*) as count FROM entities`).get().count,
    facts: db.prepare(`SELECT COUNT(*) as count FROM facts WHERE status = 'active'`).get().count,
    entity_fact_links: db.prepare(`SELECT COUNT(*) as count FROM entity_facts`).get().count,
    fact_evidence_links: db.prepare(`SELECT COUNT(*) as count FROM fact_evidence`).get().count,

    entities_by_type: db.prepare(`
      SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC
    `).all(),

    facts_by_type: db.prepare(`
      SELECT fact_type, COUNT(*) as count FROM facts WHERE status = 'active' GROUP BY fact_type ORDER BY count DESC
    `).all(),

    top_entities: db.prepare(`
      SELECT e.name, e.type, COUNT(ef.fact_id) as fact_count
      FROM entities e
      LEFT JOIN entity_facts ef ON e.id = ef.entity_id
      GROUP BY e.id
      ORDER BY fact_count DESC
      LIMIT 10
    `).all()
  };

  return stats;
}

/**
 * Get documents that need entity extraction
 * @returns {Array} Documents without entity extraction
 */
export function getDocumentsNeedingExtraction() {
  // Find documents that have chunks but no fact_evidence links
  const docs = db.prepare(`
    SELECT DISTINCT d.id, d.original_name, d.filename, d.status,
           COUNT(DISTINCT c.id) as chunk_count,
           COUNT(DISTINCT fe.chunk_id) as extracted_chunks
    FROM documents d
    JOIN chunks c ON c.document_id = d.id AND c.status = 'active'
    LEFT JOIN fact_evidence fe ON fe.chunk_id = c.id
    WHERE d.status = 'processed'
    GROUP BY d.id
    HAVING extracted_chunks < chunk_count * 0.5
    ORDER BY d.uploaded_at DESC
  `).all();

  return docs.map(d => ({
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

  console.log(`[BulkExtraction] Starting extraction for ${docs.length} documents`);

  for (const doc of docs) {
    try {
      console.log(`[BulkExtraction] Processing document ${doc.id}: ${doc.filename || doc.title}`);

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
      console.error(`[BulkExtraction] Error processing document ${doc.id}:`, error.message);
      results.errors.push({ doc_id: doc.id, error: error.message });
      results.documents.push({
        doc_id: doc.id,
        filename: doc.filename,
        success: false,
        error: error.message
      });
    }
  }

  console.log(`[BulkExtraction] Complete: ${results.documents_processed} documents, ${results.total_entities} entities, ${results.total_facts} facts`);

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
    const chunk = db.prepare(`
      SELECT id, content_clean, node_id, doc_title
      FROM chunks
      WHERE id = ? AND status = 'active'
    `).get(chunkId);

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

  // Debug: Check what data exists
  if (debug) {
    const totalEntities = db.prepare(`SELECT COUNT(*) as c FROM entities`).get();
    const totalMentions = db.prepare(`SELECT COUNT(*) as c FROM entity_mentions`).get();
    const entitiesWithNodeId = db.prepare(`SELECT COUNT(*) as c FROM entities WHERE node_id = ?`).get(nodeId);
    const chunksInNode = db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE node_id = ? AND status = 'active'`).get(nodeId);
    console.log(`[getNodeEntitiesAndFacts] Debug: totalEntities=${totalEntities.c}, totalMentions=${totalMentions.c}, entitiesWithNodeId=${entitiesWithNodeId.c}, chunksInNode=${chunksInNode.c}`);
  }

  // Get entities for this node using multiple approaches:
  // 1. Entities with direct node_id match
  // 2. Entities linked via entity_mentions -> chunks
  let entities = db.prepare(`
    SELECT e.*,
           COALESCE(mention_stats.mention_count, 0) as mention_count,
           COALESCE(fact_stats.fact_count, 0) as fact_count
    FROM entities e
    LEFT JOIN (
      SELECT em.entity_id, COUNT(DISTINCT em.chunk_id) as mention_count
      FROM entity_mentions em
      JOIN chunks c ON em.chunk_id = c.id
      WHERE c.node_id = ? AND c.status = 'active'
      GROUP BY em.entity_id
    ) mention_stats ON e.id = mention_stats.entity_id
    LEFT JOIN (
      SELECT ef.entity_id, COUNT(DISTINCT ef.fact_id) as fact_count
      FROM entity_facts ef
      GROUP BY ef.entity_id
    ) fact_stats ON e.id = fact_stats.entity_id
    WHERE e.node_id = ? OR mention_stats.entity_id IS NOT NULL
    ORDER BY mention_count DESC, fact_count DESC
    LIMIT ?
  `).all(nodeId, nodeId, limit);

  // Fallback 1: If no entities found, try simpler query via entity_mentions
  if (entities.length === 0) {
    entities = db.prepare(`
      SELECT DISTINCT e.*,
             SUM(em.mention_count) as mention_count,
             0 as fact_count
      FROM entities e
      JOIN entity_mentions em ON e.id = em.entity_id
      JOIN chunks c ON em.chunk_id = c.id
      WHERE c.node_id = ? AND c.status = 'active'
      GROUP BY e.id
      ORDER BY mention_count DESC
      LIMIT ?
    `).all(nodeId, limit);
  }

  // Fallback 2: Try getting entities via fact_evidence -> chunks
  if (entities.length === 0) {
    const chunkIds = db.prepare(`
      SELECT id FROM chunks WHERE node_id = ? AND status = 'active'
    `).all(nodeId).map(c => c.id);

    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => '?').join(',');
      entities = db.prepare(`
        SELECT DISTINCT e.*, 1 as mention_count,
               COUNT(DISTINCT ef.fact_id) as fact_count
        FROM entities e
        JOIN entity_facts ef ON e.id = ef.entity_id
        JOIN fact_evidence fe ON ef.fact_id = fe.fact_id
        WHERE fe.chunk_id IN (${placeholders})
        GROUP BY e.id
        ORDER BY fact_count DESC
        LIMIT ?
      `).all(...chunkIds, limit);
    }
  }

  // Fallback 3: If still nothing, just get all entities for debugging
  if (entities.length === 0 && debug) {
    entities = db.prepare(`
      SELECT e.*, 0 as mention_count, 0 as fact_count
      FROM entities e
      LIMIT 10
    `).all();
    console.log(`[getNodeEntitiesAndFacts] Fallback to all entities: found ${entities.length}`);
  }

  // Get facts from multiple sources:
  // 1. Facts linked via fact_evidence -> chunks in this node
  // 2. Facts linked via entity_facts -> entities in this node
  const facts = db.prepare(`
    SELECT DISTINCT f.*,
           COALESCE(fe.extraction_confidence, 0.5) as extraction_confidence,
           c.doc_title as source_doc,
           SUBSTR(c.content_clean, 1, 200) as source_excerpt
    FROM facts f
    LEFT JOIN fact_evidence fe ON f.id = fe.fact_id
    LEFT JOIN chunks c ON fe.chunk_id = c.id
    LEFT JOIN entity_facts ef ON f.id = ef.fact_id
    LEFT JOIN entities e ON ef.entity_id = e.id
    WHERE f.status = 'active' AND (
      (c.node_id = ? AND c.status = 'active')
      OR e.node_id = ?
    )
    ORDER BY f.confidence DESC, extraction_confidence DESC
    LIMIT ?
  `).all(nodeId, nodeId, limit);

  // Enrich entities with their facts
  const enrichedEntities = entities.map(entity => {
    const entityFacts = db.prepare(`
      SELECT f.content, f.fact_type, f.confidence
      FROM facts f
      JOIN entity_facts ef ON f.id = ef.fact_id
      WHERE ef.entity_id = ? AND f.status = 'active'
      ORDER BY f.confidence DESC
      LIMIT 5
    `).all(entity.id);

    return {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      description: entity.description,
      mention_count: entity.mention_count,
      fact_count: entity.fact_count,
      aliases: safeJson(entity.aliases_json, []),
      facts: entityFacts
    };
  });

  // Build debug info if requested
  let debugInfo = null;
  if (debug) {
    const totalEntities = db.prepare(`SELECT COUNT(*) as c FROM entities`).get();
    const totalMentions = db.prepare(`SELECT COUNT(*) as c FROM entity_mentions`).get();
    const totalFacts = db.prepare(`SELECT COUNT(*) as c FROM facts`).get();
    const totalEvidence = db.prepare(`SELECT COUNT(*) as c FROM fact_evidence`).get();
    const entitiesWithNodeId = db.prepare(`SELECT COUNT(*) as c FROM entities WHERE node_id = ?`).get(nodeId);
    const chunksInNode = db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE node_id = ? AND status = 'active'`).get(nodeId);

    // Check entity_mentions for this node's chunks
    const mentionsForNodeChunks = db.prepare(`
      SELECT COUNT(*) as c
      FROM entity_mentions em
      JOIN chunks c ON em.chunk_id = c.id
      WHERE c.node_id = ? AND c.status = 'active'
    `).get(nodeId);

    // Show distinct node_ids that have entities
    const nodesWithEntities = db.prepare(`
      SELECT DISTINCT e.node_id, COUNT(*) as entity_count
      FROM entities e
      WHERE e.node_id IS NOT NULL
      GROUP BY e.node_id
      LIMIT 10
    `).all();

    debugInfo = {
      total_entities_in_db: totalEntities.c,
      total_mentions_in_db: totalMentions.c,
      total_facts_in_db: totalFacts.c,
      total_evidence_in_db: totalEvidence.c,
      entities_with_this_node_id: entitiesWithNodeId.c,
      chunks_in_this_node: chunksInNode.c,
      mentions_for_node_chunks: mentionsForNodeChunks.c,
      queried_node_id: nodeId,
      nodes_with_entities: nodesWithEntities
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
