import express from "express";
import { listDocuments, getDocument, deleteDocument } from "../ingest/index.js";
import { processDocumentForExtraction } from "../extraction/entityFactExtractor.js";
import { apiLogger } from "../utils/logger.js";

const router = express.Router();

// List documents
router.get("/", (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const documents = listDocuments({ status, limit: parseInt(limit, 10), offset: parseInt(offset, 10) });
    res.json({ documents, count: documents.length });
  } catch (err) {
    apiLogger.error("List documents error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get document by ID
router.get("/:id", (req, res) => {
  try {
    const doc = getDocument(parseInt(req.params.id, 10));
    if (!doc) return res.status(404).json({ error: "Document not found" });
    res.json(doc);
  } catch (err) {
    apiLogger.error("Get document error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete document
router.delete("/:id", (req, res) => {
  try {
    const result = deleteDocument(parseInt(req.params.id, 10));
    res.json({ success: true, ...result });
  } catch (err) {
    apiLogger.error("Delete document error:", err.message);
    res.status(500).json({ error: err.message });
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
    apiLogger.error("Document extraction error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
