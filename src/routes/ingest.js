import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { processDocument, processDocumentBatch, isSupportedFileType, getSupportedExtensions } from "../ingest/index.js";
import {
  enqueueIngestionJob,
  enqueueIngestionJobs,
  getIngestionJob,
  listIngestionJobs,
  retryIngestionJob,
  cancelIngestionJob,
  getIngestionQueueStats
} from "../ingest/jobQueue.js";
import { runWithDb } from "../db/activeDb.js";
import { apiLogger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();

// Configure multer for file uploads
const uploadDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || "";
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Multer reads originalname as latin1 per HTTP spec; browsers send UTF-8.
    // Re-decode so Chinese (and other non-ASCII) names display correctly.
    file.originalname = Buffer.from(file.originalname, "latin1").toString("utf8");
    if (isSupportedFileType(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type. Supported: ${getSupportedExtensions().join(", ")}`));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// ==================== UPLOAD ====================

// Upload and process a single file
router.post("/upload", upload.single("file"), (req, res) => {
  // Re-establish dataset context: multer's async processing breaks AsyncLocalStorage
  runWithDb(req.datasetConn, async () => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const { targetNodeId, useLLM = true, detectConflicts = true, sync = false } = req.body || {};
      const processOptions = {
        targetNodeId,
        useLLM: useLLM === "true" || useLLM === true,
        detectConflicts: detectConflicts === "true" || detectConflicts === true,
        originalName: req.file.originalname
      };

      if (sync === "true" || sync === true) {
        let result;
        try {
          result = await processDocument(req.file.path, processOptions);
        } catch (procErr) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          throw procErr;
        }
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.json(result);
      }

      const job = enqueueIngestionJob(req.file.path, {
        originalName: req.file.originalname,
        fileSize: req.file.size,
        processOptions
      });

      res.status(202).json({
        queued: true,
        message: "File queued for background processing",
        job
      });
    } catch (err) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      apiLogger.error("Upload error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

// Upload and process multiple files
router.post("/upload/batch", upload.array("files", 20), (req, res) => {
  // Re-establish dataset context: multer's async processing breaks AsyncLocalStorage
  runWithDb(req.datasetConn, async () => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const { targetNodeId, useLLM = true, detectConflicts = true, sync = false } = req.body || {};
      const processOptions = {
        targetNodeId,
        useLLM: useLLM === "true" || useLLM === true,
        detectConflicts: detectConflicts === "true" || detectConflicts === true
      };

      if (sync === "true" || sync === true) {
        const filePaths = req.files.map(f => f.path);
        const result = await processDocumentBatch(filePaths, processOptions);
        return res.json(result);
      }

      const jobs = enqueueIngestionJobs(req.files, { processOptions });
      res.status(202).json({
        queued: true,
        message: `${jobs.length} files queued for background processing`,
        jobs,
        count: jobs.length
      });
    } catch (err) {
      apiLogger.error("Batch upload error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

// ==================== INGESTION JOBS ====================

router.get("/ingest/jobs", (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const jobs = listIngestionJobs({ status, limit, offset });
    res.json({ jobs, count: jobs.length });
  } catch (err) {
    apiLogger.error("List ingestion jobs error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/ingest/jobs/:id", (req, res) => {
  try {
    const job = getIngestionJob(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: "Ingestion job not found" });
    res.json(job);
  } catch (err) {
    apiLogger.error("Get ingestion job error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/ingest/jobs/:id/retry", (req, res) => {
  try {
    const job = retryIngestionJob(parseInt(req.params.id));
    res.json({ success: true, job });
  } catch (err) {
    apiLogger.error("Retry ingestion job error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post("/ingest/jobs/:id/cancel", (req, res) => {
  try {
    const job = cancelIngestionJob(parseInt(req.params.id));
    res.json({ success: true, job });
  } catch (err) {
    apiLogger.error("Cancel ingestion job error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

router.get("/ingest/queue/stats", (req, res) => {
  try {
    res.json(getIngestionQueueStats());
  } catch (err) {
    apiLogger.error("Get ingestion queue stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
