import { db, safeJson, logAudit, runTransaction } from "../db/db.js";
import { GoogleGenAI } from "@google/genai";
import { detectLanguage, getPrompt } from "../utils/langDetect.js";

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return compareChunks(chunkA, chunkB);
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Detect language from chunk content
  const combinedContent = (chunkA.content || '') + (chunkB.content || '');
  const lang = detectLanguage(combinedContent);

  // Use bilingual prompt based on content language
  const prompt = getPrompt('conflictDetection', lang, chunkA, chunkB);

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
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
    console.error("LLM conflict detection failed:", err.message);
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

  // Get the new chunk
  const newChunk = db.prepare(`
    SELECT id, doc_title, content_clean as content, authority_level, uploaded_at
    FROM chunks WHERE id = ?
  `).get(chunkId);

  if (!newChunk) {
    throw new Error(`Chunk not found: ${chunkId}`);
  }

  // Get existing active chunks in the same node
  const existingChunks = db.prepare(`
    SELECT id, doc_title, content_clean as content, authority_level, uploaded_at
    FROM chunks
    WHERE node_id = ? AND id != ? AND status = 'active'
    ORDER BY uploaded_at DESC
    LIMIT ?
  `).all(nodeId, chunkId, maxComparisons);

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
    // Check if conflict already exists
    const existing = db.prepare(`
      SELECT id FROM conflicts
      WHERE node_id = ? AND chunk_a_id = ? AND chunk_b_id = ? AND resolution = 'human_review'
    `).get(node_id, chunk_a_id, chunk_b_id);

    if (existing) {
      return existing.id;
    }

    // Insert conflict
    const result = db.prepare(`
      INSERT INTO conflicts (node_id, chunk_a_id, chunk_b_id, conflict_type, reason_json, resolution, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(node_id, chunk_a_id, chunk_b_id, conflict_type, JSON.stringify(details), resolution);

    const conflictId = result.lastInsertRowid;

    // Update node's conflict score
    db.prepare(`
      UPDATE nodes SET conflict_score = conflict_score + 1 WHERE node_id = ?
    `).run(node_id);

    // Log audit
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
  let query = `
    SELECT c.*,
           ca.content_clean as chunk_a_content, ca.doc_title as chunk_a_title,
           cb.content_clean as chunk_b_content, cb.doc_title as chunk_b_title,
           n.name as node_name
    FROM conflicts c
    JOIN chunks ca ON c.chunk_a_id = ca.id
    JOIN chunks cb ON c.chunk_b_id = cb.id
    JOIN nodes n ON c.node_id = n.node_id
    WHERE c.resolution = 'human_review'
  `;

  const params = [];
  if (nodeId) {
    query += " AND c.node_id = ?";
    params.push(nodeId);
  }

  query += " ORDER BY c.created_at DESC";

  const rows = db.prepare(query).all(...params);

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
    // Get conflict
    const conflict = db.prepare("SELECT * FROM conflicts WHERE id = ?").get(conflictId);
    if (!conflict) {
      throw new Error(`Conflict not found: ${conflictId}`);
    }

    // Update conflict record
    db.prepare(`
      UPDATE conflicts SET resolution = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(`${resolution}: ${notes}`, conflictId);

    // Archive the non-preferred chunk if specified
    if (archiveChunkId) {
      db.prepare(`
        UPDATE chunks SET status = 'archived' WHERE id = ?
      `).run(archiveChunkId);
    }

    // Decrease node's conflict score
    db.prepare(`
      UPDATE nodes SET conflict_score = MAX(0, conflict_score - 1) WHERE node_id = ?
    `).run(conflict.node_id);

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
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN resolution = 'human_review' THEN 1 ELSE 0 END) as unresolved,
      SUM(CASE WHEN resolution != 'human_review' THEN 1 ELSE 0 END) as resolved
    FROM conflicts
  `).get();

  const byType = db.prepare(`
    SELECT conflict_type, COUNT(*) as count
    FROM conflicts
    WHERE resolution = 'human_review'
    GROUP BY conflict_type
  `).all();

  const byNode = db.prepare(`
    SELECT n.node_id, n.name, COUNT(c.id) as conflict_count
    FROM conflicts c
    JOIN nodes n ON c.node_id = n.node_id
    WHERE c.resolution = 'human_review'
    GROUP BY n.node_id
    ORDER BY conflict_count DESC
    LIMIT 10
  `).all();

  return {
    total: stats.total,
    unresolved: stats.unresolved,
    resolved: stats.resolved,
    by_type: byType,
    top_conflict_nodes: byNode
  };
}
