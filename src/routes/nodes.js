import express from "express";
import { db } from "../db/db.js";
import { getFullTree, getNode, getChildren, getNodeWithContext, getTreeStats } from "../kg/graphTraversal.js";
import { createNode, generateAndSaveAliases, generateAliasesForAllNodes } from "../ingest/nodeMapper.js";
import { getNodeEntitiesAndFacts } from "../extraction/entityFactExtractor.js";
import { apiLogger } from "../utils/logger.js";

const router = express.Router();

// ==================== NODES ====================

// Get full tree structure
router.get("/nodes", (req, res) => {
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
router.get("/nodes/:id", (req, res) => {
  try {
    const nodeId = req.params.id;
    const withContext = req.query.context === "true";
    const result = withContext ? getNodeWithContext(nodeId) : getNode(nodeId);
    if (!result) return res.status(404).json({ error: "Node not found" });
    res.json(result);
  } catch (err) {
    apiLogger.error("Get node error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get node children
router.get("/nodes/:id/children", (req, res) => {
  try {
    const children = getChildren(req.params.id);
    res.json({ children, count: children.length });
  } catch (err) {
    apiLogger.error("Get children error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get entities and facts for a node
router.get("/nodes/:id/entities", (req, res) => {
  try {
    const { limit = 50, debug = "false" } = req.query;
    const result = getNodeEntitiesAndFacts(req.params.id, {
      limit: parseInt(limit),
      debug: debug === "true"
    });
    res.json(result);
  } catch (err) {
    apiLogger.error("Get node entities error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create new node
router.post("/nodes", (req, res) => {
  try {
    const { node_id, name, parent_id, summary, scope } = req.body;
    if (!node_id || !name) return res.status(400).json({ error: "node_id and name required" });
    const node = createNode({ node_id, name, parent_id, summary, scope });
    res.status(201).json(node);
  } catch (err) {
    apiLogger.error("Create node error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update node
router.put("/nodes/:id", (req, res) => {
  try {
    const nodeId = req.params.id;
    const { name, summary, scope, aliases } = req.body;

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push("name = ?"); params.push(name); }
    if (summary !== undefined) { updates.push("node_summary = ?"); params.push(summary); }
    if (scope !== undefined) { updates.push("scope_json = ?"); params.push(JSON.stringify(scope)); }
    if (aliases !== undefined) { updates.push("aliases_json = ?"); params.push(JSON.stringify(aliases)); }

    if (updates.length === 0) return res.status(400).json({ error: "No updates provided" });

    updates.push("updated_at = datetime('now')");
    params.push(nodeId);

    db.prepare(`UPDATE nodes SET ${updates.join(", ")} WHERE node_id = ?`).run(...params);

    // Update FTS index
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

// Generate aliases for a specific node
router.post("/nodes/:id/aliases", async (req, res) => {
  try {
    const aliases = await generateAndSaveAliases(req.params.id);
    res.json({ success: true, nodeId: req.params.id, aliases, count: aliases.length });
  } catch (err) {
    apiLogger.error("Generate aliases error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate aliases for all nodes missing them
router.post("/aliases/sync", async (req, res) => {
  try {
    const { limit = 50 } = req.body || {};
    const result = await generateAliasesForAllNodes({ limit });
    res.json(result);
  } catch (err) {
    apiLogger.error("Sync aliases error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CHUNKS ====================

// Get chunks for a node
router.get("/chunks/:nodeId", (req, res) => {
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
router.get("/chunks/detail/:id", (req, res) => {
  try {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(parseInt(req.params.id));
    if (!chunk) return res.status(404).json({ error: "Chunk not found" });
    res.json(chunk);
  } catch (err) {
    apiLogger.error("Get chunk error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
