/**
 * Node repository — nodes table reads, writes, and FTS maintenance.
 */

import { db, safeJson } from "../db.js";

export const NodeRepo = {
  // ── Graph traversal reads ─────────────────────────────────────────────────────

  /** Single node row by node_id, or null. */
  findById(nodeId) {
    return db.prepare("SELECT * FROM nodes WHERE node_id = ?").get(nodeId) ?? null;
  },

  /** All direct children of a node, ordered by name. */
  findByParent(parentId) {
    return db.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY name").all(parentId);
  },

  /** Children of multiple parents in one query. Returns all rows; caller groups by parent_id. */
  findByParents(parentIds) {
    if (!parentIds || parentIds.length === 0) return [];
    const placeholders = parentIds.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM nodes WHERE parent_id IN (${placeholders}) ORDER BY parent_id, name`
    ).all(...parentIds);
  },

  /** All root nodes (no parent), ordered by name. */
  findRoots() {
    return db.prepare("SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY name").all();
  },

  /** All nodes at a given tree level, ordered by name. */
  findByLevel(level) {
    return db.prepare("SELECT * FROM nodes WHERE level = ? ORDER BY name").all(level);
  },

  /**
   * Siblings sharing the same parent_id, optionally excluding a node.
   * @param {string} parentId
   * @param {string|null} excludeNodeId - pass null to include all siblings
   */
  findSiblings(parentId, excludeNodeId = null) {
    if (excludeNodeId !== null) {
      return db.prepare(
        "SELECT * FROM nodes WHERE parent_id = ? AND node_id != ? ORDER BY name"
      ).all(parentId, excludeNodeId);
    }
    return db.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY name").all(parentId);
  },

  /**
   * Root-level siblings (parent_id IS NULL), optionally excluding a node.
   * @param {string|null} excludeNodeId
   */
  findRootSiblings(excludeNodeId = null) {
    if (excludeNodeId !== null) {
      return db.prepare(
        "SELECT * FROM nodes WHERE parent_id IS NULL AND node_id != ? ORDER BY name"
      ).all(excludeNodeId);
    }
    return db.prepare("SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY name").all();
  },

  /** Aggregate stats for the whole tree (4 queries, pre-combined). */
  getTreeStats() {
    const stats = db.prepare(
      "SELECT COUNT(*) as total_nodes, MAX(level) as max_depth FROM nodes"
    ).get();
    const nodesWithChildren = db.prepare(
      "SELECT COUNT(DISTINCT parent_id) as count FROM nodes WHERE parent_id IS NOT NULL"
    ).get();
    const levelCounts = db.prepare(
      "SELECT level, COUNT(*) as count FROM nodes GROUP BY level ORDER BY level"
    ).all();
    const rootCount = db.prepare(
      "SELECT COUNT(*) as count FROM nodes WHERE parent_id IS NULL"
    ).get();
    return {
      total_nodes: stats.total_nodes || 0,
      max_depth: stats.max_depth,
      root_nodes: rootCount.count || 0,
      nodes_with_children: nodesWithChildren.count || 0,
      nodes_by_level: levelCounts.reduce((acc, l) => ({ ...acc, [l.level]: l.count }), {})
    };
  },

  // ── Search reads ──────────────────────────────────────────────────────────────

  /** LIKE search on name and node_id. */
  searchByName(name, limit = 10) {
    return db.prepare(`
      SELECT * FROM nodes
      WHERE name LIKE ? OR node_id LIKE ?
      ORDER BY level ASC, name ASC
      LIMIT ?
    `).all(`%${name}%`, `%${name}%`, limit);
  },

  /** Fetch multiple nodes by an array of node_id values. */
  findByIds(nodeIds) {
    if (!nodeIds.length) return [];
    const ph = nodeIds.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM nodes WHERE node_id IN (${ph})`).all(...nodeIds);
  },

  /** BM25 full-text search via nodes_fts. Returns rows with a `score` column. */
  bm25Search(safeQuery, limit = 30) {
    // Column weights: node_id col = 0 (ID, not content), text col = 1.0
    // Ensures BM25 score is computed only from the text column, not node IDs.
    return db.prepare(`
      SELECT n.*, -bm25(nodes_fts, 0, 1) as score
      FROM nodes_fts
      JOIN nodes n ON n.node_id = nodes_fts.node_id
      WHERE nodes_fts MATCH ?
      ORDER BY bm25(nodes_fts, 0, 1) ASC
      LIMIT ?
    `).all(safeQuery, limit);
  },

  // ── Writes ───────────────────────────────────────────────────────────────────

  /**
   * Update editable node fields.
   * Only the fields present in the options object are written.
   * @returns {number} number of rows changed (0 or 1)
   */
  update(nodeId, { name, summary, scope, aliases } = {}) {
    const sets = [];
    const params = [];

    if (name    !== undefined) { sets.push("name = ?");         params.push(name); }
    if (summary !== undefined) { sets.push("node_summary = ?"); params.push(summary); }
    if (scope   !== undefined) { sets.push("scope_json = ?");   params.push(JSON.stringify(scope)); }
    if (aliases !== undefined) { sets.push("aliases_json = ?"); params.push(JSON.stringify(aliases)); }

    if (sets.length === 0) return 0;

    sets.push("updated_at = datetime('now')");
    params.push(nodeId);

    return db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE node_id = ?`).run(...params).changes;
  },

  /** INSERT OR REPLACE a node row (used by seed scripts). */
  upsert({ node_id, name, parent_id, level, summary }) {
    return db.prepare(`
      INSERT OR REPLACE INTO nodes(node_id, name, parent_id, level, node_summary, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(node_id, name, parent_id ?? null, level, summary ?? null);
  },

  // ── FTS maintenance ───────────────────────────────────────────────────────────

  /**
   * Rebuild the FTS index entry for a node from all searchable fields.
   * Always reads from DB so the index stays consistent regardless of
   * which subset of fields was just updated.
   */
  rebuildFts(nodeId) {
    const row = db.prepare(
      "SELECT name, node_summary, node_description, keywords_json, aliases_json FROM nodes WHERE node_id = ?"
    ).get(nodeId);
    if (!row) return;
    const kws     = safeJson(row.keywords_json, []).join(' ');
    const aliases = safeJson(row.aliases_json, []).join(' ');
    db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);
    db.prepare("INSERT INTO nodes_fts (node_id, text) VALUES (?, ?)").run(
      nodeId,
      `${row.name} ${row.node_summary || ''} ${row.node_description || ''} ${kws} ${aliases}`
    );
  },

  /** Clear the entire nodes_fts table (used by seed scripts). */
  clearFts() {
    return db.prepare("DELETE FROM nodes_fts").run();
  },

  /** Insert a new FTS row (used by seed scripts). */
  insertFtsText(nodeId, text) {
    return db.prepare("INSERT INTO nodes_fts(node_id, text) VALUES (?, ?)").run(nodeId, text);
  },

  /** Delete FTS entry for a single node. */
  deleteFtsForNode(nodeId) {
    return db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);
  },

  // ── Alias-cache meta ─────────────────────────────────────────────────────────

  /** Returns { count, max_updated_at } for alias cache invalidation. */
  getCountAndMaxUpdatedAt() {
    return db.prepare(
      "SELECT COUNT(*) as count, MAX(updated_at) as max_updated_at FROM nodes"
    ).get();
  },

  /** All nodes that have a non-empty aliases_json (for alias cache rebuild). */
  getAllWithAliases() {
    return db.prepare(`
      SELECT node_id, name, parent_id, level, node_summary, aliases_json, scope_json
      FROM nodes
      WHERE aliases_json IS NOT NULL AND aliases_json != '[]' AND aliases_json != 'null'
    `).all();
  },

  // ── Point reads used by ingest / embedding ───────────────────────────────────

  /** Node level for a given node_id, or null if not found. */
  getLevel(nodeId) {
    return db.prepare("SELECT level FROM nodes WHERE node_id = ?").get(nodeId)?.level ?? null;
  },

  /** Check whether a node exists. */
  existsById(nodeId) {
    return !!db.prepare("SELECT 1 FROM nodes WHERE node_id = ?").get(nodeId);
  },

  // ── Full inserts (ingest pipeline) ────────────────────────────────────────────

  /** INSERT a new node row. scope_json should be pre-serialized JSON string. */
  insert({ node_id, name, parent_id, level, node_summary, scope_json,
           node_description = '', is_schema_node = 0, keywords_json = '[]', aliases_json = '[]' }) {
    return db.prepare(`
      INSERT INTO nodes (node_id, name, parent_id, level, node_summary, scope_json,
                         node_description, is_schema_node, keywords_json, aliases_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(node_id, name, parent_id ?? null, level, node_summary ?? null, scope_json ?? null,
           node_description, is_schema_node ? 1 : 0, keywords_json, aliases_json);
  },

  /** Touch updated_at for a node (called after a chunk is assigned). */
  touch(nodeId) {
    return db.prepare("UPDATE nodes SET updated_at = datetime('now') WHERE node_id = ?").run(nodeId);
  },

  /** First root node (parent_id IS NULL), or null if none exists. */
  findAnyRoot() {
    return db.prepare("SELECT * FROM nodes WHERE parent_id IS NULL LIMIT 1").get() ?? null;
  },

  /** Insert the default 'root' node and its FTS entry. Returns the inserted row. */
  insertRoot() {
    db.prepare(`
      INSERT INTO nodes (node_id, name, parent_id, level, node_summary, updated_at)
      VALUES ('root', 'Knowledge Base', NULL, 0, 'Root node of the knowledge base', datetime('now'))
    `).run();
    db.prepare(
      "INSERT INTO nodes_fts (node_id, text) VALUES ('root', 'Knowledge Base Root node of the knowledge base')"
    ).run();
    return db.prepare("SELECT * FROM nodes WHERE node_id = 'root'").get();
  },

  /** All nodes ordered by level then name (for full tree structure). */
  getAllSortedByLevel() {
    return db.prepare("SELECT * FROM nodes ORDER BY level, name").all();
  },

  /** Nodes that have no aliases, up to `limit` rows. */
  findWithoutAliases(limit = 50) {
    return db.prepare(`
      SELECT node_id, name FROM nodes
      WHERE aliases_json IS NULL OR aliases_json = '[]' OR aliases_json = 'null'
      LIMIT ?
    `).all(limit);
  },

  /** Raw aliases_json string for a node, or null if not found. */
  getAliasesJson(nodeId) {
    return db.prepare("SELECT aliases_json FROM nodes WHERE node_id = ?").get(nodeId)?.aliases_json ?? null;
  },

  /** name and node_summary columns for a node, or null if not found. */
  getNameAndSummary(nodeId) {
    return db.prepare("SELECT name, node_summary FROM nodes WHERE node_id = ?").get(nodeId) ?? null;
  },

  /** Update aliases_json and atomically refresh the FTS entry. */
  updateAliasesAndFts(nodeId, aliasesJson, ftsText) {
    db.prepare("UPDATE nodes SET aliases_json = ?, updated_at = datetime('now') WHERE node_id = ?")
      .run(aliasesJson, nodeId);
    db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);
    db.prepare("INSERT INTO nodes_fts (node_id, text) VALUES (?, ?)").run(nodeId, ftsText);
  },

  /** Update node_summary and atomically refresh the FTS entry. */
  updateSummaryAndFts(nodeId, summary, name) {
    db.prepare("UPDATE nodes SET node_summary = ?, updated_at = datetime('now') WHERE node_id = ?")
      .run(summary, nodeId);
    db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);
    db.prepare("INSERT INTO nodes_fts (node_id, text) VALUES (?, ?)").run(nodeId, `${name} ${summary}`);
  },

  /** Count nodes whose node_id starts with a given prefix (for seed verification). */
  countByPrefix(prefix) {
    return db.prepare("SELECT COUNT(*) as count FROM nodes WHERE node_id LIKE ?")
      .get(`${prefix}%`)?.count ?? 0;
  },

  // ── Schema node methods ───────────────────────────────────────────────────────

  /** All nodes marked as schema nodes, ordered by level then name. */
  findSchemaNodes() {
    return db.prepare(`
      SELECT node_id, name, parent_id, level, node_description, keywords_json,
             aliases_json, node_summary
      FROM nodes WHERE is_schema_node = 1 ORDER BY level ASC, name ASC
    `).all();
  },

  /** Set or clear the is_schema_node flag for a node. */
  setSchemaNode(nodeId, flag) {
    return db.prepare("UPDATE nodes SET is_schema_node = ?, updated_at = datetime('now') WHERE node_id = ?")
      .run(flag ? 1 : 0, nodeId).changes;
  },

  /** Clear is_schema_node flag on all nodes. */
  clearSchemaFlags() {
    return db.prepare("UPDATE nodes SET is_schema_node = 0, updated_at = datetime('now')").run().changes;
  },

  /** Update node_description and refresh FTS. */
  updateDescription(nodeId, description) {
    db.prepare("UPDATE nodes SET node_description = ?, updated_at = datetime('now') WHERE node_id = ?")
      .run(description, nodeId);
    NodeRepo.rebuildFts(nodeId);
  },

  /**
   * Merge new keywords into a node's keywords_json, deduplicating (lowercased).
   * Also refreshes the FTS entry to include the keyword text.
   */
  mergeKeywords(nodeId, newKeywords) {
    if (!newKeywords?.length) return;
    const row = db.prepare("SELECT keywords_json FROM nodes WHERE node_id = ?").get(nodeId);
    if (!row) return;

    const existing = safeJson(row.keywords_json, []);
    const merged = [...new Set([...existing, ...newKeywords.map(k => String(k).toLowerCase())])];

    db.prepare("UPDATE nodes SET keywords_json = ?, updated_at = datetime('now') WHERE node_id = ?")
      .run(JSON.stringify(merged), nodeId);

    NodeRepo.rebuildFts(nodeId);
  }
};
