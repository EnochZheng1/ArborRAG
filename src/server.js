import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { initDb, db } from "./db/db.js";
import { ask, simpleAsk } from "./kg/qa.js";
import { logger, apiLogger, requestLogger } from "./utils/logger.js";
import {
  processDocument,
  processDocumentBatch,
  listDocuments,
  getDocument,
  deleteDocument,
  emptyTree,
  isSupportedFileType,
  getSupportedExtensions
} from "./ingest/index.js";
import {
  getFullTree,
  getNode,
  getChildren,
  getNodeWithContext,
  getTreeStats
} from "./kg/graphTraversal.js";
import { createNode } from "./ingest/nodeMapper.js";
import {
  getUnresolvedConflicts,
  resolveConflict,
  getConflictStats
} from "./ingest/conflictDetector.js";
import { syncEmbeddings, getEmbeddingCoverage } from "./embedding/chunkEmbeddings.js";
import { classifyQuery } from "./query/classifier.js";
import { getSuggestions, getTrendingQueries, getExampleQueries } from "./query/suggestions.js";
import { recordFeedback, getFeedbackStats, getPoorlyPerformingQueries } from "./query/feedback.js";
import {
  getEntitiesWithFacts,
  getEntityFacts,
  searchFacts,
  getExtractionStats,
  processDocumentForExtraction,
  getDocumentsNeedingExtraction,
  bulkExtractEntities,
  getNodeEntitiesAndFacts
} from "./extraction/entityFactExtractor.js";
import {
  retrieveFactsForQuery,
  compareEntities,
  getFactsForQuestion,
  verifyClaim,
  getEntityGraph
} from "./extraction/entityFactRetriever.js";
import { getTokenStats, cleanupTokenHistory } from "./utils/tokenTracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config();
initDb();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(requestLogger);

// Serve static files from public directory
const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

// Configure multer for file uploads
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (isSupportedFileType(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type. Supported: ${getSupportedExtensions().join(", ")}`));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// ==================== Q&A ENDPOINTS ====================

// Main ask endpoint with intelligent routing
app.post("/ask", async (req, res) => {
  try {
    const { query, queryScope, options } = req.body || {};
    if (!query) return res.status(400).json({ error: "query required" });

    const result = await ask({ query, queryScope, options });
    res.json(result);
  } catch (err) {
    apiLogger.error("Ask error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simple ask (no classification, BM25 only)
app.post("/ask/simple", async (req, res) => {
  try {
    const { query, queryScope } = req.body || {};
    if (!query) return res.status(400).json({ error: "query required" });

    const result = await simpleAsk({ query, queryScope });
    res.json(result);
  } catch (err) {
    apiLogger.error("Simple ask error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Classify a query without answering
app.post("/classify", async (req, res) => {
  try {
    const { query, useLLM = true } = req.body || {};
    if (!query) return res.status(400).json({ error: "query required" });

    const classification = await classifyQuery(query, { useLLM });
    res.json(classification);
  } catch (err) {
    apiLogger.error("Classification error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== DOCUMENT UPLOAD ENDPOINTS ====================

// Upload and process a single file
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { targetNodeId, useLLM = true, detectConflicts = true } = req.body || {};

    const result = await processDocument(req.file.path, {
      targetNodeId,
      useLLM: useLLM === "true" || useLLM === true,
      detectConflicts: detectConflicts === "true" || detectConflicts === true
    });

    res.json(result);
  } catch (err) {
    apiLogger.error("Upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload multiple files
app.post("/upload/batch", upload.array("files", 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const { targetNodeId, useLLM = true } = req.body || {};
    const filePaths = req.files.map(f => f.path);

    const result = await processDocumentBatch(filePaths, {
      targetNodeId,
      useLLM: useLLM === "true" || useLLM === true
    });

    res.json(result);
  } catch (err) {
    apiLogger.error("Batch upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== DOCUMENT MANAGEMENT ENDPOINTS ====================

// List documents
app.get("/documents", (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const documents = listDocuments({
      status,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    res.json({ documents, count: documents.length });
  } catch (err) {
    apiLogger.error("List documents error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get document by ID
app.get("/documents/:id", (req, res) => {
  try {
    const doc = getDocument(parseInt(req.params.id));
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }
    res.json(doc);
  } catch (err) {
    apiLogger.error("Get document error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete document
app.delete("/documents/:id", (req, res) => {
  try {
    const result = deleteDocument(parseInt(req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    apiLogger.error("Delete document error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== NODE ENDPOINTS ====================

// Get full tree structure
app.get("/nodes", (req, res) => {
  try {
    const tree = getFullTree();
    const stats = getTreeStats();
    res.json({ tree, stats });
  } catch (err) {
    apiLogger.error("Get nodes error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get node by ID
app.get("/nodes/:id", (req, res) => {
  try {
    const nodeId = req.params.id;
    const withContext = req.query.context === "true";

    const result = withContext
      ? getNodeWithContext(nodeId)
      : getNode(nodeId);

    if (!result) {
      return res.status(404).json({ error: "Node not found" });
    }

    res.json(result);
  } catch (err) {
    apiLogger.error("Get node error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get node children
app.get("/nodes/:id/children", (req, res) => {
  try {
    const children = getChildren(req.params.id);
    res.json({ children, count: children.length });
  } catch (err) {
    apiLogger.error("Get children error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get entities and facts for a node
app.get("/nodes/:id/entities", (req, res) => {
  try {
    const nodeId = req.params.id;
    const { limit = 50, debug = 'false' } = req.query;

    const result = getNodeEntitiesAndFacts(nodeId, {
      limit: parseInt(limit),
      debug: debug === 'true'
    });
    res.json(result);
  } catch (err) {
    apiLogger.error("Get node entities error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create new node
app.post("/nodes", (req, res) => {
  try {
    const { node_id, name, parent_id, summary, scope } = req.body;

    if (!node_id || !name) {
      return res.status(400).json({ error: "node_id and name required" });
    }

    const node = createNode({ node_id, name, parent_id, summary, scope });
    res.status(201).json(node);
  } catch (err) {
    apiLogger.error("Create node error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update node
app.put("/nodes/:id", (req, res) => {
  try {
    const nodeId = req.params.id;
    const { name, summary, scope, aliases } = req.body;

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name);
    }
    if (summary !== undefined) {
      updates.push("node_summary = ?");
      params.push(summary);
    }
    if (scope !== undefined) {
      updates.push("scope_json = ?");
      params.push(JSON.stringify(scope));
    }
    if (aliases !== undefined) {
      updates.push("aliases_json = ?");
      params.push(JSON.stringify(aliases));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No updates provided" });
    }

    updates.push("updated_at = datetime('now')");
    params.push(nodeId);

    db.prepare(`UPDATE nodes SET ${updates.join(", ")} WHERE node_id = ?`).run(...params);

    // Update FTS
    if (name !== undefined || summary !== undefined) {
      const node = getNode(nodeId);
      db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);
      db.prepare("INSERT INTO nodes_fts (node_id, text) VALUES (?, ?)").run(
        nodeId,
        `${node.name} ${node.node_summary || ""}`
      );
    }

    res.json(getNode(nodeId));
  } catch (err) {
    apiLogger.error("Update node error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CHUNK ENDPOINTS ====================

// Get chunks for a node
app.get("/chunks/:nodeId", (req, res) => {
  try {
    const chunks = db.prepare(`
      SELECT * FROM chunks
      WHERE node_id = ? AND status = 'active'
      ORDER BY uploaded_at DESC
    `).all(req.params.nodeId);

    res.json({ chunks, count: chunks.length });
  } catch (err) {
    apiLogger.error("Get chunks error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get chunk by ID
app.get("/chunks/detail/:id", (req, res) => {
  try {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(parseInt(req.params.id));
    if (!chunk) {
      return res.status(404).json({ error: "Chunk not found" });
    }
    res.json(chunk);
  } catch (err) {
    apiLogger.error("Get chunk error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CONFLICT ENDPOINTS ====================

// Get unresolved conflicts
app.get("/conflicts", (req, res) => {
  try {
    const { nodeId } = req.query;
    const conflicts = getUnresolvedConflicts(nodeId);
    const stats = getConflictStats();
    res.json({ conflicts, stats });
  } catch (err) {
    apiLogger.error("Get conflicts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolve a conflict
app.post("/conflicts/:id/resolve", (req, res) => {
  try {
    const conflictId = parseInt(req.params.id);
    const { resolution, keepChunkId, archiveChunkId, notes } = req.body;

    if (!resolution) {
      return res.status(400).json({ error: "resolution required" });
    }

    const success = resolveConflict(conflictId, resolution, {
      keepChunkId,
      archiveChunkId,
      notes
    });

    res.json({ success });
  } catch (err) {
    apiLogger.error("Resolve conflict error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== EMBEDDING ENDPOINTS ====================

// Sync embeddings
app.post("/embeddings/sync", async (req, res) => {
  try {
    const result = await syncEmbeddings();
    res.json(result);
  } catch (err) {
    apiLogger.error("Sync embeddings error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get embedding coverage
app.get("/embeddings/coverage", (req, res) => {
  try {
    const coverage = getEmbeddingCoverage();
    res.json(coverage);
  } catch (err) {
    apiLogger.error("Get coverage error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== ALIAS ENDPOINTS ====================

import {
  generateAndSaveAliases,
  generateAliasesForAllNodes
} from "./ingest/nodeMapper.js";

// Generate aliases for a specific node
app.post("/nodes/:id/aliases", async (req, res) => {
  try {
    const nodeId = req.params.id;
    const aliases = await generateAndSaveAliases(nodeId);
    res.json({ success: true, nodeId, aliases, count: aliases.length });
  } catch (err) {
    apiLogger.error("Generate aliases error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate aliases for all nodes missing them
app.post("/aliases/sync", async (req, res) => {
  try {
    const { limit = 50 } = req.body || {};
    const result = await generateAliasesForAllNodes({ limit });
    res.json(result);
  } catch (err) {
    apiLogger.error("Sync aliases error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SYSTEM ENDPOINTS ====================

// Empty the entire tree (dangerous!)
app.delete("/tree", (req, res) => {
  try {
    const { confirm } = req.query;

    if (confirm !== "yes") {
      return res.status(400).json({
        error: "Confirmation required",
        message: "Add ?confirm=yes to confirm tree deletion. This action cannot be undone!"
      });
    }

    apiLogger.warn("Emptying entire tree - user confirmed");
    const result = emptyTree();
    res.json({ success: true, ...result });
  } catch (err) {
    apiLogger.error("Empty tree error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    supported_file_types: getSupportedExtensions()
  });
});

// System stats
app.get("/stats", (req, res) => {
  try {
    const treeStats = getTreeStats();
    const embeddingCoverage = getEmbeddingCoverage();
    const conflictStats = getConflictStats();

    const docStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM documents
    `).get();

    const chunkStats = db.prepare(`
      SELECT COUNT(*) as total FROM chunks WHERE status = 'active'
    `).get();

    // Entity/fact extraction stats
    let extractionStats = { entities: 0, facts: 0, documents_extracted: 0 };
    try {
      const entityCount = db.prepare(`SELECT COUNT(*) as count FROM entities`).get();
      const factCount = db.prepare(`SELECT COUNT(*) as count FROM facts`).get();
      const docsExtracted = db.prepare(`
        SELECT COUNT(DISTINCT document_id) as count
        FROM chunks c
        JOIN fact_evidence fe ON c.id = fe.chunk_id
      `).get();
      extractionStats = {
        entities: entityCount?.count || 0,
        facts: factCount?.count || 0,
        documents_extracted: docsExtracted?.count || 0
      };
    } catch (e) {
      // Tables may not exist yet
    }

    res.json({
      nodes: treeStats,
      documents: docStats,
      chunks: { active: chunkStats.total },
      embeddings: embeddingCoverage,
      conflicts: conflictStats,
      extraction: extractionStats
    });
  } catch (err) {
    apiLogger.error("Get stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Token usage statistics
app.get("/stats/tokens", (req, res) => {
  try {
    const { since, operation, model } = req.query;
    const stats = getTokenStats({ since, operation, model });
    res.json(stats);
  } catch (err) {
    apiLogger.error("Get token stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Clean up old token history
app.delete("/stats/tokens", (req, res) => {
  try {
    const { daysToKeep = 30 } = req.query;
    const deleted = cleanupTokenHistory(parseInt(daysToKeep));
    res.json({ success: true, deleted_records: deleted });
  } catch (err) {
    apiLogger.error("Cleanup token history error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ Query Suggestions ============

// Get autocomplete suggestions
app.get("/suggestions", (req, res) => {
  try {
    const { q, limit = 10, lang = 'auto' } = req.query;
    const suggestions = getSuggestions(q, { limit: parseInt(limit), lang });
    res.json({ suggestions });
  } catch (err) {
    apiLogger.error("Get suggestions error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get trending queries
app.get("/suggestions/trending", (req, res) => {
  try {
    const { limit = 5 } = req.query;
    const trending = getTrendingQueries(parseInt(limit));
    res.json({ trending });
  } catch (err) {
    apiLogger.error("Get trending error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get example queries for empty state
app.get("/suggestions/examples", (req, res) => {
  try {
    const { lang = 'en' } = req.query;
    const examples = getExampleQueries(lang);
    res.json({ examples });
  } catch (err) {
    apiLogger.error("Get examples error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ Feedback ============

// Record feedback on an answer
app.post("/feedback", (req, res) => {
  try {
    const result = recordFeedback(req.body);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    apiLogger.error("Record feedback error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get feedback statistics
app.get("/feedback/stats", (req, res) => {
  try {
    const { days = 30, queryType } = req.query;
    const stats = getFeedbackStats({ days: parseInt(days), queryType });
    res.json(stats);
  } catch (err) {
    apiLogger.error("Get feedback stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get poorly performing queries for improvement
app.get("/feedback/needs-improvement", (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const queries = getPoorlyPerformingQueries(parseInt(limit));
    res.json({ queries });
  } catch (err) {
    apiLogger.error("Get poorly performing queries error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ Entity-Fact Extraction ============

// Get all entities
app.get("/entities", (req, res) => {
  try {
    const { type, nodeId, limit = 50 } = req.query;
    const entities = getEntitiesWithFacts({ type, nodeId, limit: parseInt(limit) });
    res.json({ entities, count: entities.length });
  } catch (err) {
    apiLogger.error("Get entities error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get entity by name with facts
app.get("/entities/:name", (req, res) => {
  try {
    const entity = getEntityFacts(decodeURIComponent(req.params.name));
    if (!entity) {
      return res.status(404).json({ error: "Entity not found" });
    }
    res.json(entity);
  } catch (err) {
    apiLogger.error("Get entity error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get entity relationship graph
app.get("/entities/:name/graph", (req, res) => {
  try {
    const { depth = 2 } = req.query;
    const graph = getEntityGraph(decodeURIComponent(req.params.name), parseInt(depth));
    res.json(graph);
  } catch (err) {
    apiLogger.error("Get entity graph error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Search facts
app.get("/facts/search", (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    if (!q) {
      return res.status(400).json({ error: "Query parameter 'q' is required" });
    }
    const facts = searchFacts(q, parseInt(limit));
    res.json({ facts, count: facts.length });
  } catch (err) {
    apiLogger.error("Search facts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get facts for a question (structured retrieval)
app.post("/facts/retrieve", (req, res) => {
  try {
    const { question, maxFacts = 15, maxEvidence = 10 } = req.body;
    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }
    const result = getFactsForQuestion(question, { maxFacts, maxEvidence });
    res.json(result);
  } catch (err) {
    apiLogger.error("Retrieve facts error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Compare entities
app.post("/entities/compare", (req, res) => {
  try {
    const { entities } = req.body;
    if (!entities || entities.length < 2) {
      return res.status(400).json({ error: "At least 2 entity names required" });
    }
    const comparison = compareEntities(entities);
    res.json(comparison);
  } catch (err) {
    apiLogger.error("Compare entities error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify a claim against facts
app.post("/facts/verify", (req, res) => {
  try {
    const { claim } = req.body;
    if (!claim) {
      return res.status(400).json({ error: "Claim is required" });
    }
    const result = verifyClaim(claim);
    res.json(result);
  } catch (err) {
    apiLogger.error("Verify claim error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trigger entity-fact extraction for a document
app.post("/documents/:id/extract", async (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    const { useLLM = true } = req.body;

    apiLogger.info(`Starting entity-fact extraction for document ${docId}`);
    const result = await processDocumentForExtraction(docId, { useLLM });

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    apiLogger.error("Document extraction error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get extraction statistics
app.get("/extraction/stats", (req, res) => {
  try {
    const stats = getExtractionStats();
    res.json(stats);
  } catch (err) {
    apiLogger.error("Get extraction stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get documents needing extraction
app.get("/extraction/pending", (req, res) => {
  try {
    const docs = getDocumentsNeedingExtraction();
    res.json({
      documents: docs,
      count: docs.length
    });
  } catch (err) {
    apiLogger.error("Get pending extraction error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trigger bulk extraction for all pending documents
app.post("/extraction/bulk", async (req, res) => {
  try {
    const { maxDocuments = 10, useLLM = true } = req.body;

    apiLogger.info(`Starting bulk entity extraction (max ${maxDocuments} documents)`);

    const result = await bulkExtractEntities({ maxDocuments, useLLM });

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    apiLogger.error("Bulk extraction error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  apiLogger.error("Server error:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`TreeKB server running on http://localhost:${PORT}`);
  logger.info(`Supported file types: ${getSupportedExtensions().join(", ")}`);
});
