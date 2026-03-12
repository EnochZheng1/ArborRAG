/**
 * Ingestion pipeline stage functions.
 *
 * Each stage receives a shared `ctx` object and mutates it.
 * Stages must be called in order by the pipeline runner.
 *
 * ctx shape:
 *   filePath, options
 *   → (stageParseFile)    content, fileMetadata
 *   → (stageRegister)     documentId, isDuplicate
 *   → (stageEnrichChunks) enrichedChunks
 *   → (stageMapChunks)    mappingResult, conflictsFound
 *   → (stageEntities)     extractionResult
 *   → (stageFinalize)     [results.success = true]
 */

import { logAudit, runTransaction } from "../../db/db.js";
import { DocumentRepo } from "../../db/repositories/DocumentRepo.js";
import { DatasetConfigRepo } from "../../db/repositories/DatasetConfigRepo.js";
import { parseFile, isSupportedFileType } from "../fileParser.js";
import { extractKnowledgePoints } from "../knowledgeExtractor.js";
import { detectAuthorityLevel } from "../metadataExtractor.js";
import { autoMapChunks, assignChunkToNode, generateAndSaveAliases } from "../nodeMapper.js";
import { syncEmbeddings } from "../../embedding/chunkEmbeddings.js";
import { invalidateVectorCache } from "../../kg/vectorTreeRouter.js";
import { callLLM, isLlmConfigured } from "../../utils/llm.js";
import { getCustomPrompt } from "../../prompts/promptManager.js";
import { findMergeCandidates, queueNodeMergeSuggestion } from "../nodeMerger.js";
import { ChunkRepo } from "../../db/repositories/ChunkRepo.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { ingestLogger as logger } from "../../utils/logger.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const AUTO_EMBED = process.env.INGEST_AUTO_EMBED !== "false";

// ── Internal DB helpers ───────────────────────────────────────────────────────

function calculateFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function registerDocument(fileInfo) {
  const { filename, originalName, fileType, fileSize, fileHash, metadata = {} } = fileInfo;
  return runTransaction(() => {
    const existing = DocumentRepo.findByHash(fileHash);
    if (existing) {
      if (existing.status === 'processed') {
        // Genuine duplicate — document already fully processed
        return { id: existing.id, duplicate: true };
      }
      // 'failed' or 'pending' — previous attempt was rolled back; reuse the document row
      // so the Documents view doesn't accumulate orphan rows for the same file.
      DocumentRepo.updateStatus(existing.id, 'processing', null);
      logger.info(`[doc:${existing.id}] Retrying previously ${existing.status} document`);
      return { id: existing.id, duplicate: false };
    }

    const result = DocumentRepo.insert({
      filename,
      originalName,
      fileType,
      fileSize,
      fileHash,
      metadataJson: JSON.stringify(metadata)
    });

    logAudit("create", "documents", result.lastInsertRowid, null, { filename, originalName });
    return { id: Number(result.lastInsertRowid), duplicate: false };
  });
}

function updateDocumentStatus(docId, status, chunkCount = null) {
  DocumentRepo.updateStatus(docId, status, chunkCount);
}

// ── Stage 1: Validate and parse the source file ───────────────────────────────

export async function stageParseFile(ctx) {
  const { filePath } = ctx;
  logger.info(`Processing document: ${path.basename(filePath)}`);

  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!isSupportedFileType(filePath)) throw new Error(`Unsupported file type: ${path.extname(filePath)}`);

  const { content, metadata } = await parseFile(filePath);
  if (!content || content.trim().length === 0) throw new Error("File contains no extractable text");

  ctx.content = content;
  ctx.fileMetadata = metadata;
  logger.debug("File parsed successfully.");
}

// ── Stage 2: Hash and register the document in the DB ────────────────────────

export function stageRegister(ctx) {
  const { filePath, content: _c, fileMetadata, options } = ctx;
  const fileHash = calculateFileHash(filePath);

  const docResult = registerDocument({
    filename: path.basename(filePath),
    originalName: options.originalName || fileMetadata.filename,
    fileType: fileMetadata.fileType,
    fileSize: fileMetadata.fileSize,
    fileHash,
    metadata: fileMetadata
  });

  ctx.documentId = docResult.id;
  ctx.isDuplicate = docResult.duplicate;

  if (docResult.duplicate) {
    ctx.results.documentId = docResult.id;
    ctx.results.errors.push("Document already exists (duplicate hash)");
    logger.info(`[doc:${docResult.id}] duplicate_detected — existing document reused.`);
  }
}

// ── Stage 3: Extract Knowledge Points from document content ───────────────────

export async function stageExtractKPs(ctx) {
  const { content, fileMetadata, options, documentId } = ctx;
  const { useLLM, jobId } = options;

  ctx.enrichedChunks = []; // ensure downstream never sees undefined on early throw
  ctx.setStep(documentId, "kp_extraction", "Extracting knowledge points…", 25);

  const kps = await extractKnowledgePoints(content, fileMetadata.filename, {
    useLLM,
    authorityLevel: detectAuthorityLevel(content, fileMetadata.filename),
    documentId,
    jobId,
    onProgress: (done, total) => {
      if (total <= 1) return; // single-segment docs don't need intermediate updates
      const pct = 25 + Math.round((done / total) * 38);
      ctx.setStep(documentId, "kp_extraction",
        `Extracting KPs (${done}/${total} segments)…`, pct);
    }
  });

  ctx.results.stats.chunkCount = kps.length;
  ctx.enrichedChunks = kps;

  ctx.setStep(documentId, "kp_extraction", `Extracted ${kps.length} knowledge points.`, 65);
  logger.info(`Extracted ${kps.length} KPs from "${fileMetadata.filename}"`);
}

// ── Stage 4: Map chunks to nodes, generate aliases ───────────────────────────

export async function stageMapChunks(ctx) {
  const { enrichedChunks, documentId, options } = ctx;
  const { targetNodeId, targetSchemaNodeId, useLLM, createNewNodes } = options;

  ctx.setStep(documentId, "mapping_chunks", "Mapping chunks to tree nodes.", 68);

  if (targetNodeId) {
    // All chunks go to the specified node
    for (let i = 0; i < enrichedChunks.length; i++) {
      const chunk = enrichedChunks[i];
      const chunkId = assignChunkToNode(chunk, targetNodeId, documentId);
      ctx.results.chunks.push({ chunkId, nodeId: targetNodeId, index: chunk.index });

      if (i === 0 || (i + 1) % 10 === 0 || i === enrichedChunks.length - 1) {
        const progress = 90 + ((i + 1) / enrichedChunks.length) * 8;
        ctx.setStep(documentId, "mapping_chunks",
          `Mapping (${i + 1}/${enrichedChunks.length}).`, progress);
      }
    }
  } else {
    // Auto-map chunks to the best-fitting nodes
    const mappingMode       = DatasetConfigRepo.get('mapping_mode')       ?? 'free';
    const mappingStrictness = DatasetConfigRepo.get('mapping_strictness') ?? 'soft';
    const mappingResult = await autoMapChunks(enrichedChunks, documentId, { useLLM, createNewNodes, mappingMode, mappingStrictness, targetSchemaNodeId });
    ctx.results.mappings = mappingResult;
    ctx.results.chunks = mappingResult.mapped;
    // Track newly-created node IDs so rollback can clean them up if a later stage fails
    ctx.createdNodeIds = (mappingResult.newNodes || []).map(n => n.node_id);
    ctx.setStep(documentId, "mapping_chunks",
      `Mapped ${mappingResult.mapped.length}/${enrichedChunks.length} chunks.`, 84);

    if (mappingResult.unmapped.length > 0) {
      ctx.results.errors.push(`${mappingResult.unmapped.length} chunks could not be mapped to nodes`);
    }

    // Generate search aliases for newly created nodes
    if (useLLM && mappingResult.newNodes?.length > 0) {
      ctx.setStep(documentId, "generating_aliases", "Generating search aliases for new nodes.", 95);
      for (let i = 0; i < mappingResult.newNodes.length; i++) {
        const node = mappingResult.newNodes[i];
        try {
          await generateAndSaveAliases(node.node_id, { includeChunks: true, maxAliases: 8 });
        } catch (err) {
          logger.warn(`Failed to generate aliases for node ${node.node_id}: ${err.message}`);
        }
        if (i < mappingResult.newNodes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }
}

// ── Stage 5: Extract entities and facts from chunks ───────────────────────────
// NOTE: Entity/fact LLM extraction is disabled — schema and tables are preserved
// for future use but the LLM call is suppressed to reduce cost and latency.

export async function stageExtractEntities(ctx) {
  const { documentId } = ctx;
  ctx.setStep(documentId, "entity_extraction", "Entity extraction skipped (disabled).", 96);
  ctx.results.stats.entitiesExtracted = 0;
  ctx.results.stats.factsExtracted = 0;
  ctx.results.extraction = { entities: 0, facts: 0, chunks_processed: 0, errors: [] };
}

// ── Stage 5b: Generate node summaries for newly created nodes ─────────────────

export async function stageNodeSummaries(ctx) {
  const { documentId, options } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];

  if (!options.useLLM || !isLlmConfigured() || newNodeIds.length === 0) {
    return; // nothing to summarize
  }

  ctx.setStep(documentId, "node_summaries", "Generating node summaries…", 86);

  let generated = 0;
  for (const nodeId of newNodeIds) {
    const node = NodeRepo.findById(nodeId);
    if (!node || node.node_summary) continue; // skip if already has summary

    const chunks = ChunkRepo.getForNodeLimited(nodeId, 8);
    if (chunks.length === 0) continue;

    const chunkTexts = chunks
      .map(c => (c.content_clean || c.content || '').slice(0, 200))
      .join('\n- ');

    const prompt = getCustomPrompt('node_summary_generation', { node_name: node.name, chunks: chunkTexts })
      ?? `Given a knowledge base node named "${node.name}" containing these knowledge points:\n- ${chunkTexts}\n\nWrite a concise 1-2 sentence summary describing what this node covers. Be specific about the topics and types of information it contains. Return ONLY the summary text, nothing else.`;

    try {
      const summary = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 150, taskName: 'node_summary_generation' });
      if (summary && summary.trim().length > 10) {
        NodeRepo.update(nodeId, { summary: summary.trim() });
        NodeRepo.rebuildFts(nodeId);
        generated++;
      }
    } catch (err) {
      logger.warn(`Node summary generation failed for "${node.name}": ${err.message}`);
    }

    // Small delay between LLM calls to respect rate limits
    if (generated < newNodeIds.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (generated > 0) {
    logger.info(`Generated summaries for ${generated}/${newNodeIds.length} new nodes`);
    ctx.setStep(documentId, "node_summaries", `Generated ${generated} node summaries.`, 88);
  }
}

// ── Stage 5c: Check for near-duplicate sibling nodes ──────────────────────────

export async function stageTopicCanonicalization(ctx) {
  const { documentId } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];

  if (newNodeIds.length === 0) return;

  ctx.setStep(documentId, "topic_canonicalization", "Checking for duplicate nodes…", 89);

  let queued = 0;
  for (const nodeId of newNodeIds) {
    try {
      const candidates = await findMergeCandidates(nodeId);
      for (const candidate of candidates) {
        // Determine which node has fewer chunks (that one is the merge source)
        const nodeChunks = ChunkRepo.getForNodeLimited(nodeId, 1).length;
        const candidateChunks = ChunkRepo.getForNodeLimited(candidate.nodeId, 1).length;
        const [sourceId, targetId] = nodeChunks <= candidateChunks
          ? [nodeId, candidate.nodeId]
          : [candidate.nodeId, nodeId];

        queueNodeMergeSuggestion(sourceId, targetId, {
          nameSim: candidate.nameSim,
          contentSim: candidate.contentSim,
          reason: candidate.reason
        });
        queued++;
      }
    } catch (err) {
      logger.warn(`Topic canonicalization failed for node ${nodeId}: ${err.message}`);
    }
  }

  if (queued > 0) {
    logger.info(`Queued ${queued} node merge suggestion(s) from topic canonicalization`);
    ctx.setStep(documentId, "topic_canonicalization", `Found ${queued} potential merge(s).`, 90);
  }
}

// ── Stage 5d: Orphan node cleanup — merge tiny nodes into parent ──────────────
// Only runs when INGEST_ORPHAN_CLEANUP=true (disabled by default to avoid
// premature deletion during multi-document batch ingestion).

const ORPHAN_CLEANUP_ENABLED = process.env.INGEST_ORPHAN_CLEANUP === 'true';

export async function stageOrphanCleanup(ctx) {
  const { documentId } = ctx;

  if (!ORPHAN_CLEANUP_ENABLED) return;

  ctx.setStep(documentId, "orphan_cleanup", "Checking for orphan nodes…", 91);

  try {
    const allNodes = NodeRepo.getAllSortedByLevel();
    let cleaned = 0;

    // Process deepest nodes first (reverse level order)
    const sortedByDepth = [...allNodes].sort((a, b) => b.level - a.level);

    for (const node of sortedByDepth) {
      // Never touch root nodes, schema nodes, or the root node itself
      if (!node.parent_id || node.is_schema_node || node.node_id === 'root') continue;

      const chunks = ChunkRepo.getForNodeLimited(node.node_id, 2);
      if (chunks.length >= 2) continue; // has enough content

      // Check if this node has children — if so, don't merge
      const children = NodeRepo.findByParent(node.node_id);
      if (children.length > 0) continue;

      // Node has 0-1 chunks and no children — merge into parent
      const parent = NodeRepo.findById(node.parent_id);
      if (!parent) continue;

      if (chunks.length > 0) {
        // Move chunk(s) to parent, then delete node
        const { executeMerge } = await import("../nodeMerger.js");
        executeMerge(node.node_id, node.parent_id);
      } else {
        // Empty node — just delete
        NodeRepo.deleteNode(node.node_id);
      }
      cleaned++;
    }

    if (cleaned > 0) {
      logger.info(`Orphan cleanup: merged/deleted ${cleaned} sparse node(s)`);
      ctx.setStep(documentId, "orphan_cleanup", `Cleaned up ${cleaned} sparse node(s).`, 92);
    }
  } catch (err) {
    logger.warn(`Orphan node cleanup failed (non-fatal): ${err.message}`);
  }
}

// ── Stage 6: Auto-generate embeddings ────────────────────────────────────────

export async function stageEmbeddingSync(ctx) {
  const { documentId } = ctx;

  if (!AUTO_EMBED || process.env.DISABLE_EMBEDDINGS === "true") {
    ctx.setStep(documentId, "embedding_sync", "Auto-embedding skipped.", 98);
    return;
  }

  ctx.setStep(documentId, "embedding_sync", "Generating embeddings…", 96);

  try {
    const result = await syncEmbeddings();
    invalidateVectorCache();
    const n = result.nodes?.success || 0;
    const c = result.chunks?.success || 0;
    ctx.setStep(documentId, "embedding_sync", `Embedded ${n} nodes, ${c} chunks.`, 98);
    ctx.results.stats.embeddingsGenerated = n + c;
  } catch (err) {
    logger.warn(`[embedding_sync] Failed for doc ${documentId}: ${err.message}`);
    ctx.setStep(documentId, "embedding_sync", `Embedding sync failed (non-fatal): ${err.message}`, 98);
    ctx.results.stats.embeddingsGenerated = 0;
  }
}

// ── Stage 7: Mark document as processed ──────────────────────────────────────

export function stageFinalize(ctx) {
  const { documentId, results } = ctx;
  ctx.setStep(documentId, "finalizing", "Finalizing document processing.", 99);
  updateDocumentStatus(documentId, "processed", results.chunks.length);
  ctx.setStep(documentId, "completed", "Document processed successfully.", 100, "processed");
}

// Re-export updateDocumentStatus so the pipeline runner can call it on failure
export { updateDocumentStatus };
