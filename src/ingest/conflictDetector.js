import { safeJson, logAudit, runTransaction } from "../db/db.js";
import { ConflictRepo } from "../db/repositories/ConflictRepo.js";
import { callLLM, llmConfig } from "../utils/llm.js";
import { getPrompt } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { ingestLogger as logger } from "../utils/logger.js";

/**
 * Detect and manage conflicts between chunks
 */

/**
 * Compare two chunks for conflicts
 * @param {object} chunkA - First chunk
 * @param {object} chunkB - Second chunk
 * @returns {object|null} Conflict info or null if no conflict
 */
function compareChunks(chunkA, chunkB) {
  // Basic heuristics for potential conflicts

  // 1. Check for contradictory numbers
  const numbersA = extractNumbers(chunkA.content);
  const numbersB = extractNumbers(chunkB.content);

  for (const [contextA, numA] of numbersA) {
    for (const [contextB, numB] of numbersB) {
      // Same context but different numbers
      if (contextsSimilar(contextA, contextB) && numA !== numB) {
        return {
          type: "numeric_contradiction",
          details: {
            chunk_a_context: contextA,
            chunk_a_value: numA,
            chunk_b_context: contextB,
            chunk_b_value: numB
          }
        };
      }
    }
  }

  // 2. Check for contradictory statements (negation patterns)
  const contradictionPatterns = [
    [/必须/g, /不(?:能|可以|需要)/g],
    [/允许/g, /禁止/g],
    [/可以/g, /不可以/g],
    [/required/gi, /not required|optional/gi],
    [/must/gi, /must not|cannot/gi],
    [/allowed/gi, /prohibited|forbidden/gi]
  ];

  for (const [patternA, patternB] of contradictionPatterns) {
    const hasA1 = patternA.test(chunkA.content);
    const hasB1 = patternB.test(chunkA.content);
    const hasA2 = patternA.test(chunkB.content);
    const hasB2 = patternB.test(chunkB.content);

    if ((hasA1 && hasB2) || (hasB1 && hasA2)) {
      return {
        type: "statement_contradiction",
        details: {
          pattern_found: "Contradictory requirements detected"
        }
      };
    }
  }

  return null;
}

// Extract numbers with context
function extractNumbers(text) {
  const results = [];
  const pattern = /(.{0,30}?)(\d+(?:\.\d+)?)\s*(%|元|美元|USD|CNY|万|亿|天|小时|分钟)?(.{0,30})/g;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const context = (match[1] + match[3] + match[4]).trim();
    const value = parseFloat(match[2]);
    results.push([context, value]);
  }

  return results;
}

// Check if two contexts are similar
function contextsSimilar(contextA, contextB) {
  if (!contextA || !contextB) return false;

  const wordsA = new Set(contextA.toLowerCase().split(/\s+/));
  const wordsB = new Set(contextB.toLowerCase().split(/\s+/));

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word) && word.length > 2) overlap++;
  }

  const minSize = Math.min(wordsA.size, wordsB.size);
  return minSize > 0 && overlap / minSize > 0.3;
}

/**
 * Use LLM to detect semantic conflicts
 * @param {object} chunkA - First chunk
 * @param {object} chunkB - Second chunk
 * @returns {Promise<object|null>} Conflict info or null
 */
export async function detectConflictWithLLM(chunkA, chunkB) {
  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return compareChunks(chunkA, chunkB);
  }

  // Detect language from chunk content
  const combinedContent = (chunkA.content || '') + (chunkB.content || '');
  const lang = getEffectiveLang(combinedContent);

  // Use bilingual prompt based on content language
  const prompt = getPrompt('conflictDetection', lang, chunkA, chunkB);

  try {
    const text = await callLLM({ prompt, taskName: 'conflict_detection' }) ?? "{}";
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    const result = JSON.parse(jsonMatch[1] || text);

    if (result.has_conflict) {
      return {
        type: result.conflict_type,
        severity: result.severity,
        details: {
          explanation: result.explanation,
          recommendation: result.recommendation
        }
      };
    }

    return null;
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.warn(`LLM conflict detection failed: ${err.message}`);
    return compareChunks(chunkA, chunkB);
  }
}

/**
 * Check a new chunk against existing chunks in the same node
 * @param {number} chunkId - New chunk ID
 * @param {string} nodeId - Node ID
 * @param {object} options - Options
 * @returns {Promise<Array>} List of conflicts found
 */
export async function checkChunkConflicts(chunkId, nodeId, options = {}) {
  const { useLLM = true, maxComparisons = 20 } = options;

  const newChunk = ConflictRepo.getChunkForConflict(chunkId);
  if (!newChunk) throw new Error(`Chunk not found: ${chunkId}`);

  const existingChunks = ConflictRepo.getExistingChunks(nodeId, chunkId, maxComparisons);

  const conflicts = [];

  for (const existingChunk of existingChunks) {
    let conflict;

    if (useLLM) {
      conflict = await detectConflictWithLLM(newChunk, existingChunk);
    } else {
      conflict = compareChunks(newChunk, existingChunk);
    }

    if (conflict) {
      conflicts.push({
        chunk_a_id: newChunk.id,
        chunk_b_id: existingChunk.id,
        ...conflict
      });
    }
  }

  return conflicts;
}

/**
 * Record a conflict in the database
 * @param {object} conflictData - Conflict details
 * @returns {number} Conflict record ID
 */
export function recordConflict(conflictData) {
  const {
    node_id,
    chunk_a_id,
    chunk_b_id,
    conflict_type,
    details = {},
    resolution = "human_review"
  } = conflictData;

  return runTransaction(() => {
    const existing = ConflictRepo.findExisting(node_id, chunk_a_id, chunk_b_id);
    if (existing) return existing.id;

    const result = ConflictRepo.insert({
      nodeId: node_id,
      chunkAId: chunk_a_id,
      chunkBId: chunk_b_id,
      conflictType: conflict_type,
      reasonJson: JSON.stringify(details),
      resolution
    });

    const conflictId = result.lastInsertRowid;
    ConflictRepo.incrementNodeScore(node_id);
    logAudit("create", "conflicts", conflictId, null, conflictData);
    return Number(conflictId);
  });
}

/**
 * Process conflicts for a newly added chunk
 * @param {number} chunkId - Chunk ID
 * @param {string} nodeId - Node ID
 * @returns {Promise<object>} Processing results
 */
export async function processNewChunkConflicts(chunkId, nodeId) {
  const conflicts = await checkChunkConflicts(chunkId, nodeId);

  const recorded = [];
  for (const conflict of conflicts) {
    const id = recordConflict({
      node_id: nodeId,
      chunk_a_id: conflict.chunk_a_id,
      chunk_b_id: conflict.chunk_b_id,
      conflict_type: conflict.type,
      details: conflict.details
    });
    recorded.push({ id, ...conflict });
  }

  return {
    total_conflicts: conflicts.length,
    recorded: recorded
  };
}

/**
 * Get unresolved conflicts for a node
 * @param {string} nodeId - Node ID (optional, all if not specified)
 * @returns {Array} Unresolved conflicts
 */
export function getUnresolvedConflicts(nodeId = null) {
  const rows = ConflictRepo.getUnresolved(nodeId);

  return rows.map(r => ({
    id: r.id,
    node_id: r.node_id,
    node_name: r.node_name,
    conflict_type: r.conflict_type,
    reason: safeJson(r.reason_json, {}),
    created_at: r.created_at,
    chunk_a: {
      id: r.chunk_a_id,
      title: r.chunk_a_title,
      content: r.chunk_a_content?.slice(0, 500)
    },
    chunk_b: {
      id: r.chunk_b_id,
      title: r.chunk_b_title,
      content: r.chunk_b_content?.slice(0, 500)
    }
  }));
}

/**
 * Resolve a conflict
 * @param {number} conflictId - Conflict ID
 * @param {string} resolution - Resolution type
 * @param {object} options - Resolution options
 * @returns {boolean} Success
 */
export function resolveConflict(conflictId, resolution, options = {}) {
  const { keepChunkId = null, archiveChunkId = null, notes = "" } = options;

  return runTransaction(() => {
    const conflict = ConflictRepo.findById(conflictId);
    if (!conflict) throw new Error(`Conflict not found: ${conflictId}`);

    ConflictRepo.resolve(conflictId, `${resolution}: ${notes}`);

    if (archiveChunkId) {
      ConflictRepo.archiveChunk(archiveChunkId);
    }

    ConflictRepo.decrementNodeScore(conflict.node_id);

    // Log audit
    logAudit("update", "conflicts", conflictId, { resolution: "human_review" }, {
      resolution: `${resolution}: ${notes}`,
      keep_chunk: keepChunkId,
      archive_chunk: archiveChunkId
    });

    return true;
  });
}

/**
 * Get conflict statistics
 * @returns {object} Statistics
 */
export function getConflictStats() {
  const stats = ConflictRepo.getStats();
  return {
    total: stats.total,
    unresolved: stats.unresolved,
    resolved: stats.resolved,
    by_type: ConflictRepo.getByType(),
    top_conflict_nodes: ConflictRepo.getByNode(10)
  };
}
