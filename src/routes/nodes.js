import express from "express";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { getFullTree, getNode, getChildren, getNodeWithContext, getTreeStats } from "../kg/graphTraversal.js";
import { createNode, generateAndSaveAliases, generateAliasesForAllNodes } from "../ingest/nodeMapper.js";
import { getNodeEntitiesAndFacts } from "../extraction/entityFactExtractor.js";
import { runTransaction, db } from "../db/db.js";
import { apiLogger } from "../utils/logger.js";
import { escapeFtsQuery } from "../kg/strategies/utils.js";
import { ApiError } from "../utils/apiError.js";
import { requireBody } from "../utils/validate.js";

const router = express.Router();

// ==================== NODES ====================

// Tree health report (must come before /:id routes)
router.get("/nodes/health", (req, res) => {
  try {
    const nodes = NodeRepo.getHealthReport();
    const issues = [];
    for (const n of nodes) {
      if (n.chunk_count === 0 && n.child_count === 0) issues.push({ node_id: n.node_id, name: n.name, issue: 'empty' });
      else if (n.chunk_count === 1 && n.child_count === 0) issues.push({ node_id: n.node_id, name: n.name, issue: 'low_chunks' });
      if (!n.has_embedding && n.chunk_count > 0) issues.push({ node_id: n.node_id, name: n.name, issue: 'no_embedding' });
    }
    res.json({ nodes, issues, total: nodes.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("GET /nodes/health error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Search chunks by content, grouped by node
router.get("/nodes/search", (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "q parameter is required" } });
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const safeQ = escapeFtsQuery(q);
    if (!safeQ) return res.json({ results: [] });
    const chunks = ChunkRepo.bm25Search(safeQ, limit);
    // Group by node
    const byNode = new Map();
    for (const c of chunks) {
      if (!byNode.has(c.node_id)) {
        const node = NodeRepo.findById(c.node_id);
        byNode.set(c.node_id, { node_id: c.node_id, node_name: node?.name || c.node_id, chunks: [] });
      }
      byNode.get(c.node_id).chunks.push({
        id: c.id,
        preview: (c.content_clean || "").slice(0, 150),
        score: c.score
      });
    }
    res.json({ results: [...byNode.values()], total_chunks: chunks.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("GET /nodes/search error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get full tree structure
router.get("/nodes", (req, res) => {
  try {
    const tree = getFullTree();
    const stats = getTreeStats();
    res.json({ tree, stats });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get nodes error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get node by ID
router.get("/nodes/:id", (req, res) => {
  try {
    const nodeId = req.params.id;
    const withContext = req.query.context === "true";
    const result = withContext ? getNodeWithContext(nodeId) : getNode(nodeId);
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Node not found" } });
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get node error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get node children
router.get("/nodes/:id/children", (req, res) => {
  try {
    const children = getChildren(req.params.id);
    res.json({ children, count: children.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get children error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get entities and facts for a node
router.get("/nodes/:id/entities", (req, res) => {
  try {
    const { debug = "false" } = req.query;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const result = getNodeEntitiesAndFacts(req.params.id, {
      limit,
      debug: debug === "true"
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get node entities error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Create new node
router.post("/nodes", (req, res) => {
  try {
    requireBody(req.body, 'node_id', 'name');
    const { node_id, name, parent_id, summary, scope } = req.body;
    const node = createNode({ node_id, name, parent_id, summary, scope });
    res.status(201).json(node);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Create node error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Update node
router.put("/nodes/:id", (req, res) => {
  try {
    const nodeId = req.params.id;
    const { name, summary, scope, aliases, node_description, parent_id } = req.body;

    if (!NodeRepo.existsById(nodeId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Node not found" } });

    const hasUpdates = name !== undefined || summary !== undefined ||
                       scope !== undefined || aliases !== undefined ||
                       node_description !== undefined || parent_id !== undefined;
    if (!hasUpdates) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "No updates provided" } });

    // Capture old state for audit
    const oldNode = NodeRepo.findById(nodeId);
    const oldState = {
      name: oldNode.name,
      parent_id: oldNode.parent_id,
      node_summary: oldNode.node_summary,
      node_description: oldNode.node_description
    };

    // Handle reparenting
    if (parent_id !== undefined) {
      const newParent = parent_id === null ? null : parent_id;
      if (newParent && !NodeRepo.existsById(newParent)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "Target parent node not found" } });
      }
      if (newParent === nodeId) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "Cannot set a node as its own parent" } });
      }
      NodeRepo.reparentNode(nodeId, newParent);
    }

    NodeRepo.update(nodeId, { name, summary, scope, aliases });

    if (node_description !== undefined) {
      NodeRepo.updateDescription(nodeId, node_description);
    } else if (name !== undefined || summary !== undefined || aliases !== undefined) {
      NodeRepo.rebuildFts(nodeId);
    }

    // Audit log for tree mutations (rename, reparent, description change)
    const newNode = NodeRepo.findById(nodeId);
    const newState = {
      name: newNode.name,
      parent_id: newNode.parent_id,
      node_summary: newNode.node_summary,
      node_description: newNode.node_description
    };

    let auditAction = 'tree_update';
    if (parent_id !== undefined && parent_id !== oldState.parent_id) auditAction = 'tree_move';
    else if (name !== undefined && name !== oldState.name) auditAction = 'tree_rename';

    const auditResult = db.prepare(
      "INSERT INTO audit_log (action, table_name, record_id, old_value_json, new_value_json, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).run(auditAction, 'nodes', nodeId, JSON.stringify(oldState), JSON.stringify(newState));

    const result = getNode(nodeId);
    result.audit_id = Number(auditResult.lastInsertRowid);
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Update node error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Delete a node (re-parents children, deletes all chunks)
router.delete("/nodes/:id", (req, res) => {
  try {
    const nodeId = req.params.id;
    if (nodeId === "root") return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "Cannot delete the root node" } });

    const node = NodeRepo.findById(nodeId);
    if (!node) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Node not found" } });

    const children = NodeRepo.findByParent(nodeId);
    const chunkIds = NodeRepo.getChunkIdsForNode(nodeId);

    let auditId;
    runTransaction(() => {
      // Re-parent children to this node's parent
      if (children.length > 0) {
        const newParentId = node.parent_id || null;
        const newLevel = node.level;
        NodeRepo.reparentChildren(nodeId, newParentId, newLevel);
      }

      // Delete all chunks belonging to this node
      for (const id of chunkIds) {
        ChunkRepo.deleteById(id);
      }

      // Delete the node itself
      NodeRepo.deleteNode(nodeId);

      // Audit
      const oldState = {
        name: node.name, parent_id: node.parent_id, level: node.level,
        chunks_deleted: chunkIds.length, children_reparented: children.length
      };
      const auditResult = db.prepare(
        "INSERT INTO audit_log (action, table_name, record_id, old_value_json, new_value_json, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run('tree_delete', 'nodes', nodeId, JSON.stringify(oldState), null);
      auditId = Number(auditResult.lastInsertRowid);
    });

    apiLogger.info(`Deleted node ${nodeId} (${node.name}): ${chunkIds.length} chunks removed, ${children.length} children re-parented`);
    res.json({
      ok: true,
      name: node.name,
      chunksDeleted: chunkIds.length,
      childrenReparented: children.length,
      audit_id: auditId
    });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Delete node error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Generate aliases for a specific node
router.post("/nodes/:id/aliases", async (req, res) => {
  try {
    const aliases = await generateAndSaveAliases(req.params.id);
    res.json({ success: true, nodeId: req.params.id, aliases, count: aliases.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Generate aliases error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Generate aliases for all nodes missing them
router.post("/aliases/sync", async (req, res) => {
  try {
    const { limit = 50 } = req.body || {};
    const result = await generateAliasesForAllNodes({ limit });
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Sync aliases error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ==================== CHUNKS ====================

// Get chunks for a node
router.get("/chunks/:nodeId", (req, res) => {
  try {
    const chunks = ChunkRepo.getActiveForNode(req.params.nodeId);
    res.json({ chunks, count: chunks.length });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get chunks error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Get chunk by ID
router.get("/chunks/detail/:id", (req, res) => {
  try {
    const chunk = ChunkRepo.getById(parseInt(req.params.id));
    if (!chunk) return res.status(404).json({ error: { code: 'NOT_FOUND', message: "Chunk not found" } });
    res.json(chunk);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Get chunk error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Create a manual chunk on a node
router.post("/nodes/:id/chunks", (req, res) => {
  try {
    const { content, kp_type = 'fact', doc_title = 'Manual Entry' } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'content is required' } });
    const validTypes = ['fact', 'rule', 'definition', 'procedure', 'example', 'context'];
    if (!validTypes.includes(kp_type)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'invalid kp_type' } });
    if (!NodeRepo.existsById(req.params.id)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'node not found' } });

    const result = ChunkRepo.insertKP({
      doc_title,
      content: content.trim(),
      chunk_type: 'manual',
      kp_type,
      nodeId: req.params.id,
      documentId: null,
      index: 0
    });
    ChunkRepo.insertFts(result.lastInsertRowid, content.trim());
    NodeRepo.touch(req.params.id);
    res.json({ chunk: { id: result.lastInsertRowid, content: content.trim(), kp_type, doc_title } });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Create chunk error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// Delete a manually-created chunk (guards against file-ingested chunks)
router.delete("/chunks/:id", (req, res) => {
  try {
    const chunk = ChunkRepo.getById(parseInt(req.params.id, 10));
    if (!chunk) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'chunk not found' } });
    if (chunk.document_id != null) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'cannot delete file-ingested chunks' } });
    ChunkRepo.deleteById(chunk.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    apiLogger.error("Delete chunk error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
