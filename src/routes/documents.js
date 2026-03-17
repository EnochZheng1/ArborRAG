import express from "express";
import { listDocuments, getDocument, deleteDocument } from "../ingest/index.js";
import { processDocumentForExtraction } from "../extraction/entityFactExtractor.js";
import { apiLogger } from "../utils/logger.js";
import { JobRepo } from "../db/repositories/JobRepo.js";
import { ApiError } from "../utils/apiError.js";

const router = express.Router();

/**
 * Unified view: active jobs + completed documents in one sorted list.
 * Active jobs come first (newest-created first), then completed/failed docs.
 * For jobs that already have a document (processing state), the document's
 * progress fields are merged in so the frontend gets one consistent row shape.
 */
router.get("/unified", (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

    const activeJobs    = JobRepo.listActive();
    const allDocs       = listDocuments({ limit });
    const queuePosByJob = JobRepo.getAllQueuePositions();

    // Build lookup maps
    const docById      = Object.fromEntries(allDocs.map(d => [d.id, d]));
    // Name-keyed fallback for jobs whose document_id wasn't saved (pre-fix records)
    const docByName    = {};
    for (const d of allDocs) {
      if (!docByName[d.original_name || d.filename]) {
        docByName[d.original_name || d.filename] = d;
      }
    }

    // Track all document IDs that are already represented by a job row
    const jobDocIds = new Set();

    const rows = [];

    // Active jobs (queued / processing / rate_limited / failed)
    for (const j of activeJobs) {
      // Prefer explicit document_id; fall back to name match for legacy orphans
      let doc = j.document_id ? (docById[j.document_id] ?? null) : null;
      if (!doc && j.original_name) doc = docByName[j.original_name] ?? null;

      const effectiveDocId = j.document_id ?? doc?.id ?? null;
      if (effectiveDocId) jobDocIds.add(effectiveDocId);

      rows.push({
        row_type:            "job",
        job_id:              j.id,
        doc_id:              effectiveDocId,
        name:                j.original_name || j.file_path || "",
        file_type:           doc?.file_type  ?? null,
        status:              j.status,
        error_message:       j.error_message ?? null,
        attempt_count:       j.attempt_count,
        max_attempts:        j.max_attempts,
        chunk_count:         doc?.chunk_count          ?? null,
        processing_step:     doc?.processing_step      ?? null,
        processing_message:  doc?.processing_message   ?? null,
        processing_progress: doc?.processing_progress  ?? null,
        time:                j.updated_at ?? j.created_at,
        started_at:          j.started_at  ?? null,
        queue_position:      j.status === "queued" ? (queuePosByJob.get(j.id) ?? null) : null,
      });
    }

    // Completed / failed / pending documents that have no active job row
    for (const d of allDocs) {
      if (!jobDocIds.has(d.id)) {
        rows.push({
          row_type:            "doc",
          job_id:              null,
          doc_id:              d.id,
          name:                d.original_name || d.filename || "",
          file_type:           d.file_type     ?? null,
          status:              d.status,
          error_message:       null,
          attempt_count:       null,
          max_attempts:        null,
          chunk_count:         d.chunk_count,
          processing_step:     null,
          processing_message:  null,
          processing_progress: null,
          time:                d.uploaded_at,
        });
      }
    }

    res.json({ rows, count: rows.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Unified documents error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// List documents
router.get("/", (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const documents = listDocuments({ status, limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
    res.json({ documents, count: documents.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("List documents error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get document by ID
router.get("/:id", (req, res) => {
  try {
    const doc = getDocument(parseInt(req.params.id, 10));
    if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Document not found" } });
    res.json(doc);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get document error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Delete document — also cancel any queued/rate_limited job for this document
router.delete("/:id", (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    JobRepo.cancelForDocument(docId);
    const result = deleteDocument(docId);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Delete document error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Trigger entity-fact extraction for a document
router.post("/:id/extract", async (req, res) => {
  try {
    const docId = parseInt(req.params.id, 10);
    const { useLLM = true } = req.body;
    apiLogger.info(`Starting entity-fact extraction for document ${docId}`);
    const result = await processDocumentForExtraction(docId, { useLLM });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Document extraction error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
