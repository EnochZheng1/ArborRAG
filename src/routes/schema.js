/**
 * Schema Routes
 *
 * All routes run inside the dataset middleware context (X-Dataset-ID header resolved).
 * Mounted at /schema in server.js.
 */
import express from "express";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { DatasetConfigRepo } from "../db/repositories/DatasetConfigRepo.js";
import { SchemaTemplateRepo } from "../db/repositories/SchemaTemplateRepo.js";
import { generateNodeId, ensureRootNode } from "../ingest/nodeHierarchy.js";
import { getGeneralNodeStats, reclassifyGeneralKPs } from "../ingest/kpNormaliser.js";
import { runTransaction, safeJson } from "../db/db.js";
import { apiLogger as logger } from "../utils/logger.js";
import { ApiError } from "../utils/apiError.js";

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a hierarchical tree from a flat list of nodes (ordered level ASC).
 */
function buildTree(nodes) {
  const map = new Map(nodes.map(n => [n.node_id, { ...n, children: [] }]));
  const roots = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Import schema nodes from a raw array.
 * @param {object[]} rawNodes  - array of { id?, name, description?, children? }
 * @param {"merge"|"replace"} mode
 */
function importSchemaNodes(rawNodes, mode) {
  if (mode === 'replace') {
    NodeRepo.clearSchemaFlags();
  }

  const created = [];
  const updated = [];

  function walk(nodeData, parentId, level) {
    const name        = (nodeData.name || '').trim();
    const description = nodeData.description || '';
    const aliases     = Array.isArray(nodeData.aliases) ? nodeData.aliases.filter(a => typeof a === 'string') : [];
    const keywords    = Array.isArray(nodeData.keywords) ? nodeData.keywords.filter(k => typeof k === 'string') : [];
    const attributes  = Array.isArray(nodeData.attributes) ? nodeData.attributes : [];
    if (!name) return;

    const nodeId = nodeData.id || generateNodeId(name);

    const existing = NodeRepo.findById(nodeId) || NodeRepo.searchByName(name, 1).find(
      n => n.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      NodeRepo.setSchemaNode(existing.node_id, true);
      if (description) NodeRepo.updateDescription(existing.node_id, description);
      if (aliases.length > 0) NodeRepo.update(existing.node_id, { aliases });
      if (keywords.length > 0) NodeRepo.mergeKeywords(existing.node_id, keywords);
      if (attributes.length > 0) NodeRepo.setAttributes(existing.node_id, attributes);
      updated.push(existing.node_id);

      for (const child of (nodeData.children || [])) {
        walk(child, existing.node_id, level + 1);
      }
    } else {
      // Create new node
      let actualNodeId = nodeId;
      try {
        runTransaction(() => {
          NodeRepo.insert({
            node_id:          nodeId,
            name,
            parent_id:        parentId,
            level,
            node_summary:     description,
            node_description: description,
            is_schema_node:   1,
            scope_json:       '{}',
            aliases_json:     aliases.length > 0 ? JSON.stringify(aliases) : '[]',
            keywords_json:    keywords.length > 0 ? JSON.stringify(keywords) : '[]'
          });
          NodeRepo.insertFtsText(nodeId, `${name} ${description} ${keywords.join(' ')}`);
        });
        created.push(nodeId);
      } catch (insertErr) {
        // Race condition: another concurrent import created the same node — reuse it.
        if (insertErr.code === 'SQLITE_CONSTRAINT_UNIQUE' || insertErr.message?.includes('UNIQUE constraint failed: nodes')) {
          const winner = NodeRepo.findByParent(parentId).find(n => n.name === name);
          if (winner) {
            actualNodeId = winner.node_id;
            NodeRepo.setSchemaNode(winner.node_id, true);
            updated.push(winner.node_id);
          } else throw insertErr;
        } else throw insertErr;
      }

      for (const child of (nodeData.children || [])) {
        walk(child, actualNodeId, level + 1);
      }
    }
  }

  // Top-level nodes in the JSON always go under the dataset root node.
  // This keeps the tree connected — floating roots only occur if a node
  // explicitly sets parent_id to null AND is the actual root node itself.
  const rootNode = ensureRootNode();

  for (const node of rawNodes) {
    // Allow explicit parent override; default to dataset root
    const parentId = node.parent_id ?? rootNode.node_id;
    const level    = (NodeRepo.getLevel(parentId) ?? 0) + 1;
    walk(node, parentId, level);
  }

  return { created, updated };
}

// ── GET /schema ───────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const nodes = NodeRepo.findSchemaNodes();
    const tree  = buildTree(nodes);
    res.json({ nodes, tree });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("GET /schema error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── POST /schema/import ───────────────────────────────────────────────────────

router.post('/import', (req, res) => {
  try {
    const { nodes: rawNodes = [], mode = 'merge' } = req.body;
    if (!Array.isArray(rawNodes)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`nodes` must be an array' } });
    }
    if (!['merge', 'replace'].includes(mode)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`mode` must be "merge" or "replace"' } });
    }

    const result = importSchemaNodes(rawNodes, mode);
    logger.info(`Schema import (${mode}): ${result.created.length} created, ${result.updated.length} updated`);
    res.json({ ok: true, created: result.created.length, updated: result.updated.length, ...result });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("POST /schema/import error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── GET /schema/export ────────────────────────────────────────────────────────

router.get('/export', (req, res) => {
  try {
    const all = req.query.all === 'true';
    const nodes = all
      ? NodeRepo.getAllSortedByLevel()
      : NodeRepo.findSchemaNodes();

    const tree = buildTree(nodes);
    const filename = `schema-export-${Date.now()}.json`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    logger.info(`Schema exported: ${nodes.length} nodes (all=${all})`);
    res.json({ exported_at: new Date().toISOString(), nodes: tree });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("GET /schema/export error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── GET /schema/settings ──────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  try {
    res.json({
      mapping_mode:               DatasetConfigRepo.get('mapping_mode')               ?? 'free',
      mapping_strictness:         DatasetConfigRepo.get('mapping_strictness')         ?? 'soft',
      schema_template_id:         DatasetConfigRepo.get('schema_template_id')         ?? null,
      tree_routing_mode:          DatasetConfigRepo.get('tree_routing_mode')          ?? 'keyword',
      entity_extraction_enabled:  DatasetConfigRepo.get('entity_extraction_enabled')  ?? 'false',
      retrieval_strategy:         DatasetConfigRepo.get('retrieval_strategy')         ?? 'node_first'
    });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("GET /schema/settings error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── PATCH /schema/settings ────────────────────────────────────────────────────

router.patch('/settings', (req, res) => {
  try {
    const { mapping_mode, mapping_strictness, tree_routing_mode } = req.body;

    if (mapping_mode !== undefined) {
      if (!['free', 'guided'].includes(mapping_mode)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`mapping_mode` must be "free" or "guided"' } });
      }
      DatasetConfigRepo.set('mapping_mode', mapping_mode);
    }

    if (mapping_strictness !== undefined) {
      if (!['soft', 'hard'].includes(mapping_strictness)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`mapping_strictness` must be "soft" or "hard"' } });
      }
      DatasetConfigRepo.set('mapping_strictness', mapping_strictness);
    }

    if (tree_routing_mode !== undefined) {
      if (!['keyword', 'vector', 'llm'].includes(tree_routing_mode)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`tree_routing_mode` must be "keyword", "vector", or "llm"' } });
      }
      DatasetConfigRepo.set('tree_routing_mode', tree_routing_mode);
    }

    const { entity_extraction_enabled, retrieval_strategy } = req.body;

    if (retrieval_strategy !== undefined) {
      if (!['node_first', 'top_down'].includes(retrieval_strategy)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`retrieval_strategy` must be "node_first" or "top_down"' } });
      }
      DatasetConfigRepo.set('retrieval_strategy', retrieval_strategy);
    }

    if (entity_extraction_enabled !== undefined) {
      if (!['true', 'false'].includes(String(entity_extraction_enabled))) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`entity_extraction_enabled` must be "true" or "false"' } });
      }
      DatasetConfigRepo.set('entity_extraction_enabled', String(entity_extraction_enabled));
    }

    const newMode        = DatasetConfigRepo.get('mapping_mode')              ?? 'free';
    const newStrictness  = DatasetConfigRepo.get('mapping_strictness')        ?? 'soft';
    const newRouting     = DatasetConfigRepo.get('tree_routing_mode')         ?? 'keyword';
    const newEntityExt   = DatasetConfigRepo.get('entity_extraction_enabled') ?? 'false';
    const newStrategy    = DatasetConfigRepo.get('retrieval_strategy')        ?? 'node_first';
    logger.info(`Schema settings updated: mode=${newMode} strictness=${newStrictness} routing=${newRouting} entityExtraction=${newEntityExt} strategy=${newStrategy}`);
    res.json({ ok: true, mapping_mode: newMode, mapping_strictness: newStrictness, tree_routing_mode: newRouting, entity_extraction_enabled: newEntityExt, retrieval_strategy: newStrategy });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("PATCH /schema/settings error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── GET /schema/templates ─────────────────────────────────────────────────────

router.get('/templates', (req, res) => {
  try {
    const templates = SchemaTemplateRepo.getAll().map(t => ({
      ...t,
      schema_json: safeJson(t.schema_json, [])
    }));
    res.json(templates);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("GET /schema/templates error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── POST /schema/templates ────────────────────────────────────────────────────

router.post('/templates', (req, res) => {
  try {
    const { name, description = '' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`name` is required' } });

    // Export current schema nodes as the template content
    const nodes   = NodeRepo.findSchemaNodes();
    const tree    = buildTree(nodes);

    const template = SchemaTemplateRepo.create({ name: name.trim(), description, schemaJson: tree });
    logger.info(`Schema template created: "${name.trim()}" (${nodes.length} nodes)`);
    res.status(201).json({ ...template, schema_json: safeJson(template.schema_json, []) });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: `Template name "${req.body.name}" already exists` } });
    }
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("POST /schema/templates error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── DELETE /schema/templates/:id ─────────────────────────────────────────────

router.delete('/templates/:id', (req, res) => {
  try {
    const changes = SchemaTemplateRepo.delete(req.params.id);
    if (!changes) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } });
    logger.info(`Schema template deleted: ${req.params.id}`);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("DELETE /schema/templates/:id error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── POST /schema/templates/:id/apply ─────────────────────────────────────────

router.post('/templates/:id/apply', (req, res) => {
  try {
    const template = SchemaTemplateRepo.getById(req.params.id);
    if (!template) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } });

    const rawNodes = safeJson(template.schema_json, []);
    const { mode = 'merge' } = req.body;

    const result = importSchemaNodes(rawNodes, mode);

    // Switch dataset to guided mode
    DatasetConfigRepo.set('mapping_mode', 'guided');
    DatasetConfigRepo.set('schema_template_id', template.id);

    logger.info(`Schema template applied: "${template.name}" (${result.created.length} created, ${result.updated.length} updated) — mode=guided`);
    res.json({
      ok: true,
      template_name: template.name,
      mapping_mode: 'guided',
      created: result.created.length,
      updated: result.updated.length
    });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("POST /schema/templates/:id/apply error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── POST /schema/nodes ────────────────────────────────────────────────────────
// Create a new schema node (child of parent_id or dataset root).

router.post('/nodes', (req, res) => {
  try {
    const { name, description = '', parent_id } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`name` is required' } });

    const rootNode = ensureRootNode();
    const parentId = parent_id ?? rootNode.node_id;
    if (!NodeRepo.existsById(parentId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Parent node not found' } });

    // Reuse existing node if name matches
    const existing = NodeRepo.searchByName(name.trim(), 1).find(
      n => n.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (existing) {
      NodeRepo.setSchemaNode(existing.node_id, true);
      if (description) NodeRepo.updateDescription(existing.node_id, description);
      return res.json({ ok: true, node_id: existing.node_id, created: false });
    }

    const nodeId = generateNodeId(name.trim());
    const level  = (NodeRepo.getLevel(parentId) ?? 0) + 1;
    runTransaction(() => {
      NodeRepo.insert({
        node_id:          nodeId,
        name:             name.trim(),
        parent_id:        parentId,
        level,
        node_summary:     description,
        node_description: description,
        is_schema_node:   1,
        scope_json:       '{}'
      });
      NodeRepo.insertFtsText(nodeId, `${name.trim()} ${description}`);
    });

    logger.info(`Schema node created: ${nodeId} ("${name.trim()}") under ${parentId}`);
    res.status(201).json({ ok: true, node_id: nodeId, created: true });
  } catch (err) {
    // Race condition: concurrent request created the same node — treat as updated.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE constraint failed: nodes')) {
      try {
        const { name: reqName, parent_id: reqParentId } = req.body;
        const rootNode = ensureRootNode();
        const resolvedParentId = reqParentId ?? rootNode.node_id;
        const winner = NodeRepo.findByParent(resolvedParentId).find(n => n.name === reqName?.trim());
        if (winner) return res.json({ ok: true, node_id: winner.node_id, created: false });
      } catch (_) { /* fall through */ }
    }
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("POST /schema/nodes error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── PATCH /schema/:nodeId ─────────────────────────────────────────────────────
// Update node_description and/or toggle is_schema_node flag.

router.patch('/:nodeId', (req, res) => {
  try {
    const { nodeId } = req.params;
    if (!NodeRepo.existsById(nodeId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Node not found' } });

    const { node_description, is_schema_node } = req.body;

    if (node_description !== undefined) {
      NodeRepo.updateDescription(nodeId, node_description);
    }
    if (is_schema_node !== undefined) {
      NodeRepo.setSchemaNode(nodeId, !!is_schema_node);
    }

    logger.info(`Schema node patched: ${nodeId}`);
    res.json({ ok: true, node_id: nodeId });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error(`PATCH /schema/${req.params.nodeId} error:`, err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── DELETE /schema/:nodeId ────────────────────────────────────────────────────
// Remove the schema flag from a node (does NOT delete the node itself).

router.delete('/:nodeId', (req, res) => {
  try {
    const { nodeId } = req.params;
    if (!NodeRepo.existsById(nodeId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Node not found' } });
    NodeRepo.setSchemaNode(nodeId, false);
    logger.info(`Schema flag removed from node: ${nodeId}`);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error(`DELETE /schema/${req.params.nodeId} error:`, err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── GET /schema/nodes/:nodeId/attributes ────────────────────────────────────
// Get schema-defined attributes for a node.

router.get('/nodes/:nodeId/attributes', (req, res) => {
  try {
    const { nodeId } = req.params;
    if (!NodeRepo.existsById(nodeId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Node not found' } });
    const attributes = NodeRepo.getAttributes(nodeId);
    res.json({ node_id: nodeId, attributes });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error(`GET /schema/nodes/${req.params.nodeId}/attributes error:`, err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── PUT /schema/nodes/:nodeId/attributes ────────────────────────────────────
// Set schema-defined attributes for a node.
// Body: { attributes: [{ name: "premium", type: "currency", label: "Monthly Premium" }, ...] }

router.put('/nodes/:nodeId/attributes', (req, res) => {
  try {
    const { nodeId } = req.params;
    if (!NodeRepo.existsById(nodeId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Node not found' } });

    const { attributes } = req.body;
    if (!Array.isArray(attributes)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '`attributes` must be an array' } });
    }

    // Validate each attribute entry
    const validTypes = ['text', 'number', 'currency', 'date', 'boolean', 'enum'];
    const cleaned = attributes.map(a => {
      const name = String(a.name || '').trim();
      const type = validTypes.includes(a.type) ? a.type : 'text';
      const label = String(a.label || a.name || '').trim();
      return { name, type, label };
    }).filter(a => a.name.length > 0);

    NodeRepo.setAttributes(nodeId, cleaned);
    logger.info(`Attributes set for node ${nodeId}: ${cleaned.length} attributes`);
    res.json({ ok: true, node_id: nodeId, attributes: cleaned });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error(`PUT /schema/nodes/${req.params.nodeId}/attributes error:`, err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── GET /schema/health ─────────────────────────────────────────────────────────
// Returns health stats including General node size and warnings.

router.get('/health', (req, res) => {
  try {
    const generalStats = getGeneralNodeStats();
    const treeStats = NodeRepo.getTreeStats();
    res.json({ general: generalStats, tree: treeStats });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("GET /schema/health error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

// ── POST /schema/reclassify ──────────────────────────────────────────────────
// Trigger reclassification of General KPs to better-matching nodes.

router.post('/reclassify', (req, res) => {
  try {
    const result = reclassifyGeneralKPs();
    logger.info(`Reclassification: ${result.moved} moved, ${result.suggested} suggestions`);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.toJSON());
    logger.error("POST /schema/reclassify error:", err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
});

export { importSchemaNodes };
export default router;
