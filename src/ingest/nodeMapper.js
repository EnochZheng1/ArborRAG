import { safeJson, logAudit, runTransaction } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { DecisionRepo } from "../db/repositories/DecisionRepo.js";
import { bm25RecallNodes, searchNodesByName } from "../kg/recallNodes.js";
import { callLLM, isLlmConfigured } from "../utils/llm.js";
import { parseLLMJson } from "../utils/parseJSON.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { getPrompt, isChineseLang } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { wordDiceSimilarity } from "./knowledgeExtractor.js";
import { resolveKPAction } from "./kpDecisionEngine.js";
import {
  buildTopicalHierarchy,
  assignKPToNode
} from "./kpNormaliser.js";
import { buildGuidedTopicalHierarchy } from "./guidedMapper.js";
import {
  generateNodeId,
  analyzeDocumentStructure,
  createDocumentHierarchy,
  generateNodeFromChunk,
  updateNodeSummaries,
  ensureRootNode
} from "./nodeHierarchy.js";

/**
 * Map chunks to appropriate tree nodes
 */

/**
 * Find best matching node for a chunk using BM25 + keywords
 * @param {object} chunk - Chunk with content and keywords
 * @returns {object|null} Best matching node or null
 */
export function findBestNodeMatch(chunk) {
  const { content, keywords = [] } = chunk;

  // Build search query from content and keywords
  const searchTerms = [
    ...keywords.slice(0, 5),
    ...(content.slice(0, 200).split(/\s+/).slice(0, 10))
  ].join(" ");

  // Use BM25 to find candidates
  // 30 candidates — in large KBs the correct node can rank 20+;
  // raising the cap ensures it's always considered during ingestion mapping.
  const candidates = bm25RecallNodes(searchTerms, 30);

  if (candidates.length === 0) {
    return null;
  }

  // Score candidates based on keyword overlap
  const scored = candidates.map(c => {
    let score = c.bm25;

    // Bonus for keyword matches in node name/summary
    const nodeText = `${c.node.name} ${c.node.node_summary}`.toLowerCase();
    for (const kw of keywords) {
      if (nodeText.includes(kw.toLowerCase())) {
        score += 0.5;
      }
    }

    return { ...c, finalScore: score };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Only return if confidence is reasonable
  if (scored[0].finalScore > 0) {
    return {
      node: scored[0].node,
      score: scored[0].finalScore,
      alternatives: scored.slice(1, 4).map(s => ({
        node: s.node,
        score: s.finalScore
      }))
    };
  }

  return null;
}

/**
 * Use LLM to suggest node mapping for ambiguous cases
 * @param {object} chunk - Chunk to map
 * @param {Array} candidates - Candidate nodes
 * @returns {Promise<object>} LLM suggestion
 */
export async function suggestNodeWithLLM(chunk, candidates) {
  if (!isLlmConfigured()) {
    throw new Error("LLM API key required for node suggestion");
  }

  // Detect language from chunk content
  const lang = getEffectiveLang(chunk.content || '');

  const nodeList = candidates.map((c, i) =>
    `${i + 1}. ${c.node.node_id} - ${c.node.name}: ${c.node.node_summary || (isChineseLang(lang) ? "(无摘要)" : "(no summary)")}`
  ).join("\n");

  const chunkPreview = chunk.content.slice(0, 500);
  const keywords = (chunk.keywords || []).join(", ");
  const noExisting = candidates.length === 0;

  // Use bilingual prompt based on content language
  const prompt = getPrompt('nodeSuggestion', lang, chunkPreview, keywords, nodeList, noExisting);

  try {
    const text = await callLLM({ prompt, temperature: 0.0, seed: 42, taskName: 'node_suggestion' }) ?? "{}";
    return await parseLLMJson(text, 'object', { context: 'node_suggestion', fallback: null }) ?? {
      selected_index: candidates.length > 0 ? 1 : 0,
      confidence: 0.3,
      reasoning: isChineseLang(lang) ? "LLM调用失败,使用后备方案" : "LLM call failed, using fallback"
    };
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.error("LLM node suggestion failed:", err.message);
    return {
      selected_index: candidates.length > 0 ? 1 : 0,
      confidence: 0.3,
      reasoning: isChineseLang(lang) ? "LLM调用失败,使用后备方案" : "LLM call failed, using fallback"
    };
  }
}

/**
 * Create a new node in the tree
 * @param {object} nodeData - Node data
 * @returns {object} Created node
 */
export function createNode(nodeData) {
  const { node_id, name, parent_id = null, level = 1, summary = "", scope = {} } = nodeData;

  // Validate parent exists if specified
  if (parent_id && !NodeRepo.existsById(parent_id)) {
    throw new Error(`Parent node not found: ${parent_id}`);
  }

  // Calculate level from parent
  let calculatedLevel = level;
  if (parent_id) {
    const parentLevel = NodeRepo.getLevel(parent_id);
    calculatedLevel = (Number(parentLevel) || 0) + 1;
  }

  return runTransaction(() => {
    NodeRepo.insert({
      node_id,
      name,
      parent_id,
      level: calculatedLevel,
      node_summary: summary,
      scope_json: JSON.stringify(scope)
    });

    NodeRepo.insertFtsText(node_id, `${name} ${summary}`);

    logAudit("create", "nodes", node_id, null, { node_id, name, parent_id, level: calculatedLevel });

    return {
      node_id,
      name,
      parent_id,
      level: calculatedLevel,
      node_summary: summary,
      scope_json: scope
    };
  });
}

/**
 * Map a chunk to a node (create chunk record)
 * @param {object} chunk - Chunk data
 * @param {string} nodeId - Target node ID
 * @param {number} documentId - Source document ID
 * @returns {number} Created chunk ID
 */
export function assignChunkToNode(chunk, nodeId, documentId) {
  const {
    content,
    index = 0,
    doc_title = "",
    chunk_type = "other",
    keywords = [],
    fields = {},
    scope = {},
    authority_level = "sop"
  } = chunk;

  return runTransaction(() => {
    const result = ChunkRepo.insert({
      doc_title,
      content,
      chunk_type,
      keywords,
      fields,
      scope,
      authority_level,
      nodeId,
      documentId,
      index
    });

    const chunkId = result.lastInsertRowid;

    ChunkRepo.insertFts(chunkId, content);
    NodeRepo.touch(nodeId);

    logAudit("create", "chunks", chunkId, null, { node_id: nodeId, doc_title, chunk_index: index });

    return Number(chunkId);
  });
}

/**
 * Get all root nodes (no parent)
 */
export function getRootNodes() {
  return NodeRepo.findRoots().map(r => ({
    node_id: r.node_id,
    name: r.name,
    level: r.level,
    node_summary: r.node_summary,
    scope_json: safeJson(r.scope_json, {})
  }));
}

/**
 * Get children of a node
 */
export function getChildNodes(parentId) {
  return NodeRepo.findByParent(parentId).map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    scope_json: safeJson(r.scope_json, {})
  }));
}

/**
 * Get full tree structure
 */
export function getTreeStructure() {
  const allNodes = NodeRepo.getAllSortedByLevel();

  const nodeMap = new Map();
  const roots = [];

  // First pass: create node objects
  for (const r of allNodes) {
    nodeMap.set(r.node_id, {
      node_id: r.node_id,
      name: r.name,
      parent_id: r.parent_id,
      level: r.level,
      node_summary: r.node_summary,
      scope_json: safeJson(r.scope_json, {}),
      children: []
    });
  }

  // Second pass: build tree
  for (const node of nodeMap.values()) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Auto-map multiple chunks to nodes
 * @param {Array} chunks - Chunks to map
 * @param {number} documentId - Document ID
 * @param {object} options - Mapping options
 * @returns {Promise<object>} Mapping results
 */
export async function autoMapChunks(chunks, documentId, options = {}) {
  const { useLLM = true, createNewNodes = true } = options;

  const results = {
    mapped: [],
    unmapped: [],
    newNodes: []
  };

  // Ensure at least a root node exists
  ensureRootNode();

  if (chunks.length === 0) {
    return results;
  }

  // ── KP topical mapping path ──────────────────────────────────────────────────
  // Detected by the presence of a topic_hint field set by knowledgeExtractor.
  const isKPMode = chunks.some(c => c.topic_hint !== undefined);

  if (isKPMode) {
    const docTitle = chunks[0]?.doc_title || "Untitled";
    logger.info(`KP mapping mode: ${chunks.length} KPs from "${docTitle}"`);

    const mappingMode         = options.mappingMode         ?? DatasetConfigRepo.get('mapping_mode')       ?? 'free';
    const mappingStrictness   = options.mappingStrictness   ?? DatasetConfigRepo.get('mapping_strictness') ?? 'soft';
    const targetSchemaNodeId  = options.targetSchemaNodeId  ?? null;

    let nodeMapResult;
    if (mappingMode === 'guided') {
      const schemaNodes = NodeRepo.findSchemaNodes();
      if (schemaNodes.length > 0) {
        nodeMapResult = await buildGuidedTopicalHierarchy(chunks, docTitle, documentId, schemaNodes, { useLLM, mappingStrictness, targetSchemaNodeId });
      } else {
        logger.warn('Guided mode: no schema nodes found, falling back to free mapping');
        nodeMapResult = await buildTopicalHierarchy(chunks, docTitle, documentId, { useLLM });
      }
    } else {
      nodeMapResult = await buildTopicalHierarchy(chunks, docTitle, documentId, { useLLM });
    }

    const { nodeMap, newNodes } = nodeMapResult;
    results.newNodes.push(...newNodes);

    // Phase 1 — LLM decisions.
    // KP_BATCH=1 (default) processes sequentially to respect low rate limits.
    // Set env INGEST_KP_BATCH=8 to restore parallel processing.
    const KP_BATCH = Math.max(1, Number.parseInt(process.env.INGEST_KP_BATCH || "1", 10) || 1);
    const allDecisions = [];

    for (let b = 0; b < chunks.length; b += KP_BATCH) {
      const batch = chunks.slice(b, b + KP_BATCH);
      const settled = await Promise.allSettled(
        batch.map(kp => {
          const targetNodeId = nodeMap.get(kp.index) || "root";
          return resolveKPAction(kp, targetNodeId, documentId, { useLLM })
            .then(decision => ({ kp, decision, targetNodeId }));
        })
      );
      allDecisions.push(...settled);
      // Small inter-batch pause to stay within rate limits
      if (b + KP_BATCH < chunks.length) await new Promise(r => setTimeout(r, 100));
    }

    // Phase 2 — single-transaction batch DB writes
    // better-sqlite3 promotes inner .transaction() calls to SAVEPOINT when an outer
    // transaction is active, so nesting is safe and well-documented.
    runTransaction(() => {
      for (const outcome of allDecisions) {
        if (outcome.status === 'rejected') {
          rethrowIfRateLimit(outcome.reason);
          logger.warn(`KP decision failed: ${outcome.reason.message}`);
          continue;
        }
        const { kp, decision, targetNodeId } = outcome.value;
        switch (decision.action) {
          case "IGNORE":
            results.ignored = (results.ignored || 0) + 1;
            logger.debug(`KP ignored: ${decision.reason}`);
            break;

          case "MERGE":
            results.mapped.push({
              chunkIndex: kp.index, chunkId: decision.chunkId,
              nodeId: targetNodeId, merge: true, queued: false
            });
            break;

          case "REPLACE": {
            const newChunkId = assignKPToNode(kp, targetNodeId, documentId);
            ChunkRepo.supersede(decision.chunkId, newChunkId);
            if (kp.keywords?.length > 0) {
              try { NodeRepo.mergeKeywords(targetNodeId, kp.keywords); } catch (kwErr) { logger.warn(`Keyword merge failed for ${targetNodeId}: ${kwErr.message}`); }
            }
            results.mapped.push({
              chunkIndex: kp.index, chunkId: newChunkId,
              nodeId: targetNodeId, replace: true
            });
            break;
          }

          case "NORMALIZE_THEN_STORE":
          case "STORE":
          default: {
            const chunkId = assignKPToNode(kp, targetNodeId, documentId);
            if (kp.keywords?.length > 0) {
              try { NodeRepo.mergeKeywords(targetNodeId, kp.keywords); } catch (kwErr) { logger.warn(`Keyword merge failed for ${targetNodeId}: ${kwErr.message}`); }
            }
            // Back-fill incoming_chunk_id on queued decisions so human review can link to the stored KP
            if (decision.queued) {
              try {
                if (decision.decisionId) {
                  DecisionRepo.updateIncomingChunkIdById(decision.decisionId, chunkId);
                } else {
                  DecisionRepo.updateIncomingChunkId(targetNodeId, chunkId);
                }
              } catch (_) {}
            }
            results.mapped.push({
              chunkIndex: kp.index, chunkId,
              nodeId: targetNodeId, queued: decision.queued ?? false
            });
            break;
          }
        }
      }
    });

    // Generate aliases for new nodes
    if (useLLM && results.newNodes.length > 0) {
      for (const node of results.newNodes) {
        try {
          await generateAndSaveAliases(node.node_id, { includeChunks: true, maxAliases: 8 });
        } catch (err) {
          logger.warn(`Failed to generate aliases for KP node ${node.node_id}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return results;
  }

  // Get document title from first chunk
  const docTitle = chunks[0]?.doc_title || "Untitled Document";

  // Detect language once from first chunk content — passed to all sub-functions
  // so they can use language-appropriate strings and prompts.
  const lang = getEffectiveLang(chunks[0]?.content || '');

  // Strategy: Create a document hierarchy for new documents
  if (createNewNodes && chunks.length > 0) {
    // First, check if there are existing nodes that match well
    const firstChunkMatch = findBestNodeMatch(chunks[0]);
    const hasGoodExistingMatch = firstChunkMatch && firstChunkMatch.score > 0.5;

    if (!hasGoodExistingMatch) {
      // No good existing match - create new document hierarchy
      logger.info(`Creating document hierarchy for: ${docTitle} (lang: ${lang})`);

      // Analyze document structure with LLM if enabled
      let structure = null;
      if (useLLM) {
        structure = await analyzeDocumentStructure(docTitle, chunks, lang);
      }

      // Create the hierarchy with language context
      const hierarchy = createDocumentHierarchy(docTitle, chunks, structure, lang);
      results.newNodes.push(hierarchy.documentNode, ...hierarchy.sectionNodes);

      // Map chunks to their respective nodes
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const targetNode = hierarchy.chunkToSection.get(i) || hierarchy.documentNode;

        const chunkId = assignChunkToNode(chunk, targetNode.node_id, documentId);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: targetNode.node_id,
          nodeName: targetNode.name,
          score: 1.0,
          newNode: true
        });
      }

      // Update node summaries based on assigned chunks
      updateNodeSummaries(results.newNodes, chunks, results.mapped, lang);

      return results;
    }
  }

  // Fallback: Map chunks individually (existing behavior for matching to existing nodes)
  for (const chunk of chunks) {
    // Find best match
    const match = findBestNodeMatch(chunk);

    if (match && match.score > 0.3) {
      // Good match found
      const chunkId = assignChunkToNode(chunk, match.node.node_id, documentId);
      results.mapped.push({
        chunkIndex: chunk.index,
        chunkId,
        nodeId: match.node.node_id,
        nodeName: match.node.name,
        score: match.score
      });
    } else if (useLLM) {
      // Try LLM suggestion
      const candidates = match?.alternatives || [];
      const suggestion = await suggestNodeWithLLM(chunk, candidates);

      if (suggestion.selected_index > 0 && candidates[suggestion.selected_index - 1]) {
        const selectedNode = candidates[suggestion.selected_index - 1].node;
        const chunkId = assignChunkToNode(chunk, selectedNode.node_id, documentId);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: selectedNode.node_id,
          nodeName: selectedNode.name,
          score: suggestion.confidence,
          llmAssisted: true
        });
      } else if (createNewNodes) {
        // Create new node from LLM suggestion or generate from chunk
        try {
          let newNodeData = suggestion.suggested_new_node;

          // If LLM didn't suggest a node, create one from chunk metadata
          if (!newNodeData || !newNodeData.node_id) {
            newNodeData = generateNodeFromChunk(chunk);
          }

          const newNode = createNode(newNodeData);
          const chunkId = assignChunkToNode(chunk, newNode.node_id, documentId);
          results.newNodes.push(newNode);
          results.mapped.push({
            chunkIndex: chunk.index,
            chunkId,
            nodeId: newNode.node_id,
            nodeName: newNode.name,
            score: suggestion.confidence || 0.5,
            newNode: true
          });
        } catch (err) {
          logger.error("Failed to create new node:", err.message);
          // Fallback: assign to root node
          const rootNode = ensureRootNode();
          const chunkId = assignChunkToNode(chunk, rootNode.node_id, documentId);
          results.mapped.push({
            chunkIndex: chunk.index,
            chunkId,
            nodeId: rootNode.node_id,
            nodeName: rootNode.name,
            score: 0.3,
            fallbackToRoot: true
          });
        }
      } else {
        results.unmapped.push({
          chunkIndex: chunk.index,
          reason: "No suitable node found",
          suggestion: suggestion.suggested_new_node
        });
      }
    } else if (createNewNodes) {
      // No LLM, but createNewNodes is enabled - create from chunk metadata
      try {
        const newNodeData = generateNodeFromChunk(chunk);
        const newNode = createNode(newNodeData);
        const chunkId = assignChunkToNode(chunk, newNode.node_id, documentId);
        results.newNodes.push(newNode);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: newNode.node_id,
          nodeName: newNode.name,
          score: 0.5,
          newNode: true
        });
      } catch (err) {
        logger.error("Failed to create node from chunk:", err.message);
        // Fallback: assign to root node
        const rootNode = ensureRootNode();
        const chunkId = assignChunkToNode(chunk, rootNode.node_id, documentId);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: rootNode.node_id,
          nodeName: rootNode.name,
          score: 0.3,
          fallbackToRoot: true
        });
      }
    } else {
      results.unmapped.push({
        chunkIndex: chunk.index,
        reason: "No suitable node found"
      });
    }
  }

  return results;
}

/**
 * Generate aliases for a node using LLM
 * @param {string} nodeId - Node ID
 * @param {object} options - Options
 * @returns {Promise<string[]>} Generated aliases
 */
export async function generateNodeAliases(nodeId, options = {}) {
  const { includeChunks = true, maxAliases = 10 } = options;

  // Get the node
  const node = NodeRepo.findById(nodeId);
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  // Gather context from node and optionally its chunks
  let context = `Node name: ${node.name}`;
  if (node.node_summary) {
    context += `\nSummary: ${node.node_summary}`;
  }

  if (includeChunks) {
    const chunks = ChunkRepo.getWithKeywords(nodeId, 5);

    if (chunks.length > 0) {
      const keywords = new Set();
      let contentPreview = "";

      for (const chunk of chunks) {
        // Collect keywords
        const chunkKeywords = safeJson(chunk.keywords_json, []);
        chunkKeywords.forEach(k => keywords.add(k));

        // Add content preview
        if (contentPreview.length < 500) {
          contentPreview += (chunk.content_clean || "").slice(0, 200) + " ";
        }
      }

      if (keywords.size > 0) {
        context += `\nKeywords: ${[...keywords].slice(0, 20).join(", ")}`;
      }
      context += `\nContent preview: ${contentPreview.trim().slice(0, 500)}`;
    }
  }

  // Use LLM to generate aliases
  if (!isLlmConfigured()) {
    return generateSimpleAliases(node.name);
  }

  // Detect language from context
  const lang = getEffectiveLang(context);

  // Use bilingual prompt based on content language
  const prompt = getPrompt('aliasGeneration', lang, context, maxAliases);

  try {
    const text = await callLLM({ prompt, taskName: 'alias_generation' }) ?? "[]";
    const aliases = await parseLLMJson(text, 'array', { context: 'alias_generation', fallback: [] });

    // Filter and clean aliases
    const validAliases = aliases
      .filter(a => typeof a === "string" && a.length > 0 && a.length < 100)
      .filter(a => a.toLowerCase() !== node.name.toLowerCase())
      .slice(0, maxAliases);

    logger.info(`Generated ${validAliases.length} aliases for node ${nodeId}`);
    return validAliases;
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.error(`Failed to generate aliases for ${nodeId}:`, err.message);
    return generateSimpleAliases(node.name);
  }
}

/**
 * Generate simple aliases from node name (fallback without LLM)
 * @param {string} nodeName - Node name
 * @returns {string[]} Simple aliases
 */
function generateSimpleAliases(nodeName) {
  const aliases = [];

  // Add lowercase version
  if (nodeName !== nodeName.toLowerCase()) {
    aliases.push(nodeName.toLowerCase());
  }

  // Split by common separators and create variations
  const parts = nodeName.split(/[-_\s]+/);
  if (parts.length > 1) {
    // Join without spaces
    aliases.push(parts.join(""));
    // Join with different separators
    aliases.push(parts.join("-"));
    aliases.push(parts.join("_"));
  }

  // Remove common prefixes/suffixes
  const withoutDoc = nodeName.replace(/^(doc|document|file)[-_\s]*/i, "");
  if (withoutDoc !== nodeName && withoutDoc.length > 2) {
    aliases.push(withoutDoc);
  }

  return [...new Set(aliases)].slice(0, 5);
}

/**
 * Update node aliases in database
 * @param {string} nodeId - Node ID
 * @param {string[]} aliases - Aliases to set
 * @returns {boolean} Success
 */
export function updateNodeAliases(nodeId, aliases) {
  try {
    if (!NodeRepo.existsById(nodeId)) return false;

    const existingAliasesJson = NodeRepo.getAliasesJson(nodeId);
    const existingAliases = safeJson(existingAliasesJson, []);
    const mergedAliases = [...new Set([...existingAliases, ...aliases])];

    const nodeData = NodeRepo.getNameAndSummary(nodeId);
    const ftsText = nodeData
      ? `${nodeData.name} ${nodeData.node_summary || ""} ${mergedAliases.join(" ")}`
      : mergedAliases.join(" ");

    NodeRepo.updateAliasesAndFts(nodeId, JSON.stringify(mergedAliases), ftsText);

    logger.info(`Updated aliases for node ${nodeId}: ${mergedAliases.length} total`);
    return true;
  } catch (err) {
    logger.error(`Failed to update aliases for ${nodeId}:`, err.message);
    return false;
  }
}

/**
 * Generate and save aliases for a node
 * @param {string} nodeId - Node ID
 * @param {object} options - Options
 * @returns {Promise<string[]>} Generated aliases
 */
export async function generateAndSaveAliases(nodeId, options = {}) {
  const aliases = await generateNodeAliases(nodeId, options);
  if (aliases.length > 0) {
    updateNodeAliases(nodeId, aliases);
  }
  return aliases;
}

/**
 * Generate aliases for all nodes missing aliases
 * @param {object} options - Options
 * @returns {Promise<object>} Results
 */
export async function generateAliasesForAllNodes(options = {}) {
  const { limit = 50, onProgress = null } = options;

  // Find nodes without aliases
  const nodes = NodeRepo.findWithoutAliases(limit);

  const results = {
    processed: 0,
    success: 0,
    failed: 0,
    aliases_generated: 0
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    try {
      const aliases = await generateAndSaveAliases(node.node_id, options);
      results.success++;
      results.aliases_generated += aliases.length;
    } catch (err) {
      logger.error(`Failed to generate aliases for ${node.node_id}:`, err.message);
      results.failed++;
    }

    results.processed++;

    if (onProgress) {
      onProgress(results.processed, nodes.length);
    }

    // Rate limiting - wait a bit between LLM calls
    if (i < nodes.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  logger.info(`Alias generation complete: ${results.success}/${results.processed} nodes, ${results.aliases_generated} aliases`);
  return results;
}
