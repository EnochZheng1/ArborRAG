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
import { generateNodeId } from "../ingest/nodeHierarchy.js";
import { runTransaction, safeJson } from "../db/db.js";

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
    if (!name) return;

    const nodeId = nodeData.id || generateNodeId(name);

    const existing = NodeRepo.findById(nodeId) || NodeRepo.searchByName(name, 1).find(
      n => n.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      NodeRepo.setSchemaNode(existing.node_id, true);
      if (description) NodeRepo.updateDescription(existing.node_id, description);
      updated.push(existing.node_id);

      for (const child of (nodeData.children || [])) {
        walk(child, existing.node_id, level + 1);
      }
    } else {
      // Create new node
      runTransaction(() => {
        NodeRepo.insert({
          node_id:          nodeId,
          name,
          parent_id:        parentId,
          level,
          node_summary:     description,
          node_description: description,
          is_schema_node:   1,
          scope_json:       '{}'
        });
        NodeRepo.insertFtsText(nodeId, `${name} ${description}`);
      });
      created.push(nodeId);

      for (const child of (nodeData.children || [])) {
        walk(child, nodeId, level + 1);
      }
    }
  }

  for (const node of rawNodes) {
    const parentId = node.parent_id || null;
    const level    = parentId ? (NodeRepo.getLevel(parentId) ?? 0) + 1 : 1;
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
    res.status(500).json({ error: err.message });
  }
});

// ── POST /schema/import ───────────────────────────────────────────────────────

router.post('/import', (req, res) => {
  try {
    const { nodes: rawNodes = [], mode = 'merge' } = req.body;
    if (!Array.isArray(rawNodes)) {
      return res.status(400).json({ error: '`nodes` must be an array' });
    }
    if (!['merge', 'replace'].includes(mode)) {
      return res.status(400).json({ error: '`mode` must be "merge" or "replace"' });
    }

    const result = importSchemaNodes(rawNodes, mode);
    res.json({ ok: true, created: result.created.length, updated: result.updated.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.json({ exported_at: new Date().toISOString(), nodes: tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /schema/settings ──────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  try {
    res.json({
      mapping_mode:        DatasetConfigRepo.get('mapping_mode')        ?? 'free',
      mapping_strictness:  DatasetConfigRepo.get('mapping_strictness')  ?? 'soft',
      schema_template_id:  DatasetConfigRepo.get('schema_template_id')  ?? null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /schema/settings ────────────────────────────────────────────────────

router.patch('/settings', (req, res) => {
  try {
    const { mapping_mode, mapping_strictness } = req.body;

    if (mapping_mode !== undefined) {
      if (!['free', 'guided'].includes(mapping_mode)) {
        return res.status(400).json({ error: '`mapping_mode` must be "free" or "guided"' });
      }
      DatasetConfigRepo.set('mapping_mode', mapping_mode);
    }

    if (mapping_strictness !== undefined) {
      if (!['soft', 'hard'].includes(mapping_strictness)) {
        return res.status(400).json({ error: '`mapping_strictness` must be "soft" or "hard"' });
      }
      DatasetConfigRepo.set('mapping_strictness', mapping_strictness);
    }

    res.json({
      ok: true,
      mapping_mode:       DatasetConfigRepo.get('mapping_mode')       ?? 'free',
      mapping_strictness: DatasetConfigRepo.get('mapping_strictness') ?? 'soft'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── POST /schema/templates ────────────────────────────────────────────────────

router.post('/templates', (req, res) => {
  try {
    const { name, description = '' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: '`name` is required' });

    // Export current schema nodes as the template content
    const nodes   = NodeRepo.findSchemaNodes();
    const tree    = buildTree(nodes);

    const template = SchemaTemplateRepo.create({ name: name.trim(), description, schemaJson: tree });
    res.status(201).json({ ...template, schema_json: safeJson(template.schema_json, []) });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: `Template name "${req.body.name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /schema/templates/:id ─────────────────────────────────────────────

router.delete('/templates/:id', (req, res) => {
  try {
    const changes = SchemaTemplateRepo.delete(req.params.id);
    if (!changes) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /schema/templates/:id/apply ─────────────────────────────────────────

router.post('/templates/:id/apply', (req, res) => {
  try {
    const template = SchemaTemplateRepo.getById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const rawNodes = safeJson(template.schema_json, []);
    const { mode = 'merge' } = req.body;

    const result = importSchemaNodes(rawNodes, mode);

    // Switch dataset to guided mode
    DatasetConfigRepo.set('mapping_mode', 'guided');
    DatasetConfigRepo.set('schema_template_id', template.id);

    res.json({
      ok: true,
      template_name: template.name,
      mapping_mode: 'guided',
      created: result.created.length,
      updated: result.updated.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
