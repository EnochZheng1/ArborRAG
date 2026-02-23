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
import { parseFile, isSupportedFileType } from "../fileParser.js";
import { extractKnowledgePoints } from "../knowledgeExtractor.js";
import { detectAuthorityLevel } from "../metadataExtractor.js";
import { autoMapChunks, assignChunkToNode, generateAndSaveAliases } from "../nodeMapper.js";
import { processNewChunkConflicts } from "../conflictDetector.js";
import { processDocumentForExtraction } from "../../extraction/entityFactExtractor.js";
import { ingestLogger as logger } from "../../utils/logger.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// ── Internal DB helpers ───────────────────────────────────────────────────────

function calculateFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function registerDocument(fileInfo) {
  const { filename, originalName, fileType, fileSize, fileHash, metadata = {} } = fileInfo;
  return runTransaction(() => {
    const existing = DocumentRepo.findByHash(fileHash);
    if (existing) return { id: existing.id, duplicate: true };

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
  const { useLLM } = options;

  ctx.enrichedChunks = []; // ensure downstream never sees undefined on early throw
  ctx.setStep(documentId, "kp_extraction", "Extracting knowledge points…", 25);

  const kps = await extractKnowledgePoints(content, fileMetadata.filename, {
    useLLM,
    authorityLevel: detectAuthorityLevel(content, fileMetadata.filename),
    documentId,
    maxKPs: 150
  });

  ctx.results.stats.chunkCount = kps.length;
  ctx.enrichedChunks = kps;

  ctx.setStep(documentId, "kp_extraction", `Extracted ${kps.length} knowledge points.`, 65);
  logger.info(`Extracted ${kps.length} KPs from "${fileMetadata.filename}"`);
}

// ── Stage 4: Map chunks to nodes, detect conflicts, generate aliases ──────────

export async function stageMapChunks(ctx) {
  const { enrichedChunks, documentId, options } = ctx;
  const { targetNodeId, useLLM, detectConflicts, createNewNodes } = options;

  ctx.setStep(documentId, "mapping_chunks", "Mapping chunks to tree nodes.", 68);

  if (targetNodeId) {
    // All chunks go to the specified node
    for (let i = 0; i < enrichedChunks.length; i++) {
      const chunk = enrichedChunks[i];
      const chunkId = assignChunkToNode(chunk, targetNodeId, documentId);
      ctx.results.chunks.push({ chunkId, nodeId: targetNodeId, index: chunk.index });

      if (detectConflicts) {
        if (i === 0) ctx.setStep(documentId, "conflict_detection", "Checking for conflicts.", 85);
        const conflictResult = await processNewChunkConflicts(chunkId, targetNodeId);
        if (conflictResult.total_conflicts > 0) ctx.results.conflicts.push(...conflictResult.recorded);
      }

      if (i === 0 || (i + 1) % 10 === 0 || i === enrichedChunks.length - 1) {
        const base = detectConflicts ? 85 : 90;
        const progress = base + ((i + 1) / enrichedChunks.length) * (detectConflicts ? 10 : 8);
        ctx.setStep(documentId,
          detectConflicts ? "conflict_detection" : "mapping_chunks",
          `${detectConflicts ? "Checking conflicts" : "Mapping"} (${i + 1}/${enrichedChunks.length}).`,
          progress);
      }
    }
  } else {
    // Auto-map chunks to the best-fitting nodes
    const mappingResult = await autoMapChunks(enrichedChunks, documentId, { useLLM, createNewNodes });
    ctx.results.mappings = mappingResult;
    ctx.results.chunks = mappingResult.mapped;
    ctx.setStep(documentId, "mapping_chunks",
      `Mapped ${mappingResult.mapped.length}/${enrichedChunks.length} chunks.`, 84);

    if (detectConflicts) {
      ctx.setStep(documentId, "conflict_detection", "Checking mapped chunks for conflicts.", 88);
      for (let i = 0; i < mappingResult.mapped.length; i++) {
        const mapping = mappingResult.mapped[i];
        const conflictResult = await processNewChunkConflicts(mapping.chunkId, mapping.nodeId);
        if (conflictResult.total_conflicts > 0) ctx.results.conflicts.push(...conflictResult.recorded);

        if (i === 0 || (i + 1) % 10 === 0 || i === mappingResult.mapped.length - 1) {
          const progress = 88 + ((i + 1) / mappingResult.mapped.length) * 10;
          ctx.setStep(documentId, "conflict_detection",
            `Checking conflicts (${i + 1}/${mappingResult.mapped.length}).`, progress);
        }
      }
    }

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

export async function stageExtractEntities(ctx) {
  const { documentId, options } = ctx;
  const { useLLM } = options;

  try {
    ctx.setStep(documentId, "entity_extraction", "Extracting entities and facts from chunks.", 96);
    const extractionResult = await processDocumentForExtraction(documentId, { useLLM });

    ctx.results.stats.entitiesExtracted = extractionResult.total_entities;
    ctx.results.stats.factsExtracted = extractionResult.total_facts;
    ctx.results.extraction = {
      entities: extractionResult.total_entities,
      facts: extractionResult.total_facts,
      chunks_processed: extractionResult.chunks_processed,
      errors: extractionResult.errors
    };
    logger.info(`Entity extraction complete: ${extractionResult.total_entities} entities, ${extractionResult.total_facts} facts`);
  } catch (err) {
    logger.warn(`Entity-fact extraction failed: ${err.message}`);
    ctx.results.extraction = { error: err.message };
    // Non-fatal — continue to finalize
  }
}

// ── Stage 6: Mark document as processed ──────────────────────────────────────

export function stageFinalize(ctx) {
  const { documentId, results } = ctx;
  ctx.setStep(documentId, "finalizing", "Finalizing document processing.", 99);
  updateDocumentStatus(documentId, "processed", results.chunks.length);
  ctx.setStep(documentId, "completed", "Document processed successfully.", 100, "processed");
}

// Re-export updateDocumentStatus so the pipeline runner can call it on failure
export { updateDocumentStatus };
