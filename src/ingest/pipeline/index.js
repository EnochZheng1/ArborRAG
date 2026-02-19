/**
 * Ingestion Pipeline Runner
 *
 * Orchestrates the 6 pipeline stages for a single document.
 * Handles rollback on failure and re-throws RateLimitErrors.
 */

import { db, runTransaction, safeJson } from "../../db/db.js";
import { ingestLogger as logger } from "../../utils/logger.js";
import { RateLimitError } from "../../utils/rateLimitError.js";
import { emitJobProgress } from "../../utils/progressEmitter.js";
import {
  stageParseFile,
  stageRegister,
  stageEnrichChunks,
  stageMapChunks,
  stageExtractEntities,
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
    const row = db.prepare("SELECT metadata_json FROM documents WHERE id = ?").get(docId);
    if (!row) return;

    const metadata = safeJson(row.metadata_json, {});
    const existing = metadata.processing && typeof metadata.processing === "object"
      ? metadata.processing : {};
    const now = new Date().toISOString();
    const normalizedProgress = withStepProgress(progress);

    const history = Array.isArray(existing.history) ? existing.history.slice(-24) : [];
    history.push({ step, message, progress: normalizedProgress, status, timestamp: now });

    metadata.processing = { ...existing, step, message, progress: normalizedProgress, status, updated_at: now, history };

    db.prepare("UPDATE documents SET status = ?, metadata_json = ? WHERE id = ?")
      .run(status, JSON.stringify(metadata), docId);

    const progressSuffix = normalizedProgress === null ? "" : ` (${normalizedProgress}%)`;
    logger.info(`[doc:${docId}] ${step}${progressSuffix} - ${message}`);
  } catch (err) {
    logger.warn(`Failed to update processing step for document ${docId}: ${err.message}`);
  }
}

// ── Rollback ──────────────────────────────────────────────────────────────────

function rollbackFailedDocument(docId) {
  return runTransaction(() => {
    const chunks = db.prepare("SELECT id, node_id FROM chunks WHERE document_id = ?").all(docId);
    const chunkIds = chunks.map(c => Number(c.id));
    const affectedNodeIds = new Set(chunks.map(c => c.node_id).filter(Boolean));

    if (chunkIds.length > 0) {
      const ph = chunkIds.map(() => "?").join(",");

      const conflictNodes = db.prepare(`
        SELECT DISTINCT node_id FROM conflicts
        WHERE chunk_a_id IN (${ph}) OR chunk_b_id IN (${ph})
      `).all(...chunkIds, ...chunkIds);
      for (const row of conflictNodes) if (row.node_id) affectedNodeIds.add(row.node_id);

      db.prepare(`DELETE FROM conflicts WHERE chunk_a_id IN (${ph}) OR chunk_b_id IN (${ph})`)
        .run(...chunkIds, ...chunkIds);

      const strPh = chunkIds.map(() => "?").join(",");
      const strIds = chunkIds.map(String);
      db.prepare(`DELETE FROM embeddings WHERE ref_type = 'chunk' AND ref_id IN (${strPh})`).run(...strIds);
      db.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${strPh})`).run(...strIds);
      db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
    }

    for (const nodeId of affectedNodeIds) {
      const openConflicts = db.prepare(`
        SELECT COUNT(*) as count FROM conflicts WHERE node_id = ? AND resolution = 'human_review'
      `).get(nodeId).count;
      db.prepare("UPDATE nodes SET conflict_score = ?, updated_at = datetime('now') WHERE node_id = ?")
        .run(openConflicts, nodeId);
    }

    db.prepare("UPDATE documents SET status = 'failed', chunk_count = 0 WHERE id = ?").run(docId);
  });
}

// ── Pipeline runner ───────────────────────────────────────────────────────────

const STAGES = [
  { name: "parse",    fn: stageParseFile,      skip: () => false },
  { name: "register", fn: stageRegister,       skip: () => false },
  { name: "enrich",   fn: stageEnrichChunks,   skip: ctx => ctx.isDuplicate },
  { name: "map",      fn: stageMapChunks,      skip: ctx => ctx.isDuplicate },
  { name: "entities", fn: stageExtractEntities,skip: ctx => ctx.isDuplicate || !ctx.options.extractEntities },
  { name: "finalize", fn: stageFinalize,       skip: ctx => ctx.isDuplicate }
];

export async function processDocument(filePath, options = {}) {
  const {
    targetNodeId    = null,
    useLLM          = true,
    detectConflicts = true,
    createNewNodes  = true,
    extractEntities = true,
    chunkConfig     = {},
    originalName    = null,
    jobId           = null
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
      emitJobProgress(jobId, step, withStepProgress(progress), message, status);
    }
  };

  const ctx = {
    filePath,
    options: { targetNodeId, useLLM, detectConflicts, createNewNodes, extractEntities, chunkConfig, originalName },
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
        rollbackFailedDocument(ctx.documentId);
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

export async function processDocumentBatch(filePaths, options = {}) {
  const results = { total: filePaths.length, successful: 0, failed: 0, documents: [] };
  for (const filePath of filePaths) {
    const result = await processDocument(filePath, options);
    results.documents.push(result);
    if (result.success) results.successful++; else results.failed++;
  }
  return results;
}
