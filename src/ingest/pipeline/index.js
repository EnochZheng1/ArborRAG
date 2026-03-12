/**
 * Ingestion Pipeline Runner
 *
 * Orchestrates the 6 pipeline stages for a single document.
 * Handles rollback on failure and re-throws RateLimitErrors.
 */

import { runTransaction, safeJson } from "../../db/db.js";
import { DocumentRepo } from "../../db/repositories/DocumentRepo.js";
import { IngestRepo } from "../../db/repositories/IngestRepo.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { DecisionRepo } from "../../db/repositories/DecisionRepo.js";
import { ingestLogger as logger } from "../../utils/logger.js";
import { RateLimitError } from "../../utils/rateLimitError.js";
import { emitJobProgress } from "../../utils/progressEmitter.js";
import {
  stageParseFile,
  stageRegister,
  stageExtractKPs,
  stageMapChunks,
  stageExtractEntities,
  stageNodeSummaries,
  stageTopicCanonicalization,
  stageOrphanCleanup,
  stageEmbeddingSync,
  stageFinalize,
  updateDocumentStatus
} from "./stages.js";
import path from "path";

// ── Step progress tracking ────────────────────────────────────────────────────

function withStepProgress(progress) {
  const p = Number(progress);
  if (!Number.isFinite(p)) return null;
  return Math.max(0, Math.min(100, Math.round(p)));
}

function setDocumentProcessingStep(docId, step, message, progress, status = "processing") {
  if (!docId) return;
  try {
    const metadataJson = DocumentRepo.getMetadataJson(docId);
    if (metadataJson === null) return;

    const metadata = safeJson(metadataJson, {});
    const existing = metadata.processing && typeof metadata.processing === "object"
      ? metadata.processing : {};
    const now = new Date().toISOString();
    const normalizedProgress = withStepProgress(progress);

    const history = Array.isArray(existing.history) ? existing.history.slice(-24) : [];
    history.push({ step, message, progress: normalizedProgress, status, timestamp: now });

    metadata.processing = { ...existing, step, message, progress: normalizedProgress, status, updated_at: now, history };

    DocumentRepo.updateStatusAndMetadata(docId, status, JSON.stringify(metadata));

    const progressSuffix = normalizedProgress === null ? "" : ` (${normalizedProgress}%)`;
    logger.info(`[doc:${docId}] ${step}${progressSuffix} - ${message}`);
  } catch (err) {
    logger.warn(`Failed to update processing step for document ${docId}: ${err.message}`);
  }
}

// ── Rollback ──────────────────────────────────────────────────────────────────

function rollbackFailedDocument(docId, newNodeIds = []) {
  return runTransaction(() => {
    const chunks = IngestRepo.getChunksForDoc(docId);
    const affectedNodeIds = new Set(chunks.map(c => c.node_id).filter(Boolean));

    // Separate shared KP chunks (source_documents_json has >1 entry) from unique ones.
    // Shared KPs must not be deleted — only remove this doc's source entry.
    const toDelete  = [];
    const toShrink  = [];

    for (const chunk of chunks) {
      const sourceDocs = safeJson(chunk.source_documents_json, []);
      if (sourceDocs.length > 1) {
        toShrink.push({ id: chunk.id, sourceDocs });
      } else {
        toDelete.push(Number(chunk.id));
      }
    }

    // Remove this document's source entry from shared KPs (keep the row)
    for (const { id, sourceDocs } of toShrink) {
      const remaining = sourceDocs.filter(d => d.doc_id !== docId);
      IngestRepo.updateChunkSourceDocuments(id, JSON.stringify(remaining));
    }

    if (toDelete.length > 0) {
      const conflictNodes = IngestRepo.getConflictNodeIds(toDelete);
      for (const row of conflictNodes) if (row.node_id) affectedNodeIds.add(row.node_id);

      IngestRepo.deleteConflictsForChunks(toDelete);
      DecisionRepo.deleteByChunkIds(toDelete);

      const strIds = toDelete.map(String);
      IngestRepo.deleteEmbeddingsForChunks(strIds);
      IngestRepo.deleteChunkFtsForIds(strIds);
      IngestRepo.deleteChunksByIds(toDelete);
    }

    for (const nodeId of affectedNodeIds) {
      const openConflicts = IngestRepo.getOpenConflictCount(nodeId);
      IngestRepo.updateNodeConflictScore(nodeId, openConflicts);
    }

    // Remove nodes that were created during this ingestion and are now empty.
    // Only delete if the node has no remaining chunks AND no child nodes —
    // another document may have legitimately mapped content to the same node.
    // Never delete schema nodes — they are user-defined structure, not document artifacts.
    for (const nodeId of newNodeIds) {
      if (NodeRepo.findById(nodeId)?.is_schema_node) continue;
      const chunkCount = IngestRepo.getChunkCountForNode(nodeId);
      const childCount = IngestRepo.getChildCountForNode(nodeId);
      if (chunkCount === 0 && childCount === 0) {
        IngestRepo.deleteNodeFts(nodeId);
        IngestRepo.deleteNodeEmbedding(nodeId);
        IngestRepo.deleteNode(nodeId);
      }
    }

    IngestRepo.markDocumentFailed(docId);
  });
}

// ── Pipeline runner ───────────────────────────────────────────────────────────

const STAGES = [
  { name: "parse",          fn: stageParseFile,              skip: () => false },
  { name: "register",       fn: stageRegister,               skip: () => false },
  { name: "enrich",         fn: stageExtractKPs,             skip: ctx => ctx.isDuplicate },
  { name: "map",            fn: stageMapChunks,              skip: ctx => ctx.isDuplicate },
  { name: "entities",       fn: stageExtractEntities,        skip: ctx => ctx.isDuplicate || !ctx.options.extractEntities },
  { name: "nodeSummaries",  fn: stageNodeSummaries,          skip: ctx => ctx.isDuplicate },
  { name: "canonicalize",   fn: stageTopicCanonicalization,  skip: ctx => ctx.isDuplicate },
  { name: "orphanCleanup", fn: stageOrphanCleanup,          skip: ctx => ctx.isDuplicate },
  { name: "finalize",       fn: stageFinalize,               skip: ctx => ctx.isDuplicate }
];

export async function processDocument(filePath, options = {}) {
  const {
    targetNodeId    = null,
    useLLM          = true,
    detectConflicts = false,
    createNewNodes  = true,
    extractEntities = true,
    chunkConfig     = {},
    originalName    = null,
    jobId           = null,
    datasetId       = null
  } = options;

  const startTime = Date.now();
  const results = {
    success: false,
    documentId: null,
    filename: path.basename(filePath),
    stats: {},
    chunks: [],
    mappings: [],
    conflicts: [],
    errors: []
  };

  // Closure that writes step progress to DB and emits WS update when jobId is set.
  const setStep = (docId, step, message, progress, status = "processing") => {
    setDocumentProcessingStep(docId, step, message, progress, status);
    if (jobId) {
      emitJobProgress(jobId, step, withStepProgress(progress), message, status, datasetId);
    }
  };

  const ctx = {
    filePath,
    options: { targetNodeId, useLLM, detectConflicts, createNewNodes, extractEntities, chunkConfig, originalName, jobId },
    results,
    setStep
  };

  try {
    for (const stage of STAGES) {
      if (!stage.skip(ctx)) {
        await stage.fn(ctx);
        // Short-circuit after register if duplicate detected
        if (stage.name === "register" && ctx.isDuplicate) break;
      }
    }

    results.documentId = ctx.documentId;
    results.success = !ctx.isDuplicate;
    results.stats.processingTime = Date.now() - startTime;

    if (!ctx.isDuplicate) {
      logger.info(`Document processed in ${results.stats.processingTime}ms: ${results.chunks.length} chunks, ${results.conflicts.length} conflicts`);
    }

  } catch (err) {
    logger.error(`Document processing failed: ${err.message}`);
    results.errors.push(err.message);
    results.documentId = ctx.documentId || null;

    if (ctx.documentId) {
      try {
        rollbackFailedDocument(ctx.documentId, ctx.createdNodeIds ?? []);
        setStep(ctx.documentId, "failed", `Processing failed: ${err.message}`, 100, "failed");
      } catch (rollbackErr) {
        logger.error(`Rollback failed for document ${ctx.documentId}: ${rollbackErr.message}`);
        updateDocumentStatus(ctx.documentId, "failed");
        setStep(ctx.documentId, "failed",
          `Processing failed and rollback failed: ${rollbackErr.message}`, 100, "failed");
      }
    }

    // Re-throw rate limit errors so the job queue pauses the job
    if (err instanceof RateLimitError) throw err;
  }

  return results;
}

// Parallel documents per batch. Default 1 (sequential) to respect low rate limits.
// Set env INGEST_BATCH_CONCURRENCY=3 to restore parallel processing.
const BATCH_CONCURRENCY = Math.max(1, Number.parseInt(process.env.INGEST_BATCH_CONCURRENCY || "1", 10) || 1);

export async function processDocumentBatch(filePaths, options = {}) {
  const results = { total: filePaths.length, successful: 0, failed: 0, documents: [] };

  for (let i = 0; i < filePaths.length; i += BATCH_CONCURRENCY) {
    const slice = filePaths.slice(i, i + BATCH_CONCURRENCY);
    const settled = await Promise.allSettled(slice.map(fp => processDocument(fp, options)));

    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      if (outcome.status === 'fulfilled') {
        results.documents.push(outcome.value);
        if (outcome.value.success) results.successful++; else results.failed++;
      } else {
        results.failed++;
        results.documents.push({
          success: false,
          filename: path.basename(slice[j]),
          errors: [outcome.reason?.message ?? 'Unknown error'],
          stats: {}, chunks: [], mappings: [], conflicts: []
        });
      }
    }
  }

  // Run embedding sync once after all documents are processed
  if (results.successful > 0) {
    await runPostIngestEmbeddingSync();
  }

  return results;
}

/**
 * Run embedding sync once after ingestion completes.
 * Called by processDocumentBatch and by jobQueue after each job.
 */
export async function runPostIngestEmbeddingSync() {
  try {
    await stageEmbeddingSync({
      documentId: null,
      setStep: () => {},
      results: { stats: {} }
    });
  } catch (err) {
    logger.warn(`Post-ingest embedding sync failed (non-fatal): ${err.message}`);
  }
}
