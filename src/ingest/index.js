/**
 * Document Ingestion — Public API
 *
 * Re-exports the pipeline entry points and provides document management
 * functions (list, get, delete, empty tree).
 */

import { db, logAudit, runTransaction, safeJson } from "../db/db.js";
import { ingestLogger as logger } from "../utils/logger.js";

// Re-export sub-module helpers (used by routes and other callers)
export * from "./fileParser.js";
export * from "./chunker.js";
export * from "./metadataExtractor.js";
export * from "./nodeMapper.js";
export * from "./conflictDetector.js";

// Re-export pipeline entry points
export { processDocument, processDocumentBatch } from "./pipeline/index.js";

// ── Document row helper ───────────────────────────────────────────────────────

function withStepProgress(progress) {
  const p = Number(progress);
  if (!Number.isFinite(p)) return null;
  return Math.max(0, Math.min(100, Math.round(p)));
}

function parseDocumentRow(row) {
  if (!row) return null;
  const metadata = safeJson(row.metadata_json, {});
  const processing = metadata.processing && typeof metadata.processing === "object"
    ? metadata.processing : {};
  return {
    ...row,
    metadata,
    processing_step: processing.step || null,
    processing_message: processing.message || null,
    processing_progress: withStepProgress(processing.progress),
    processing_updated_at: processing.updated_at || null
  };
}

// ── Document queries ──────────────────────────────────────────────────────────

export function getDocument(docId) {
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(docId);
  return parseDocumentRow(row);
}

export function listDocuments(filters = {}) {
  const { status, limit = 50, offset = 0 } = filters;

  let query = "SELECT * FROM documents";
  const params = [];

  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  } else {
    query += " WHERE status != 'deleted'";
  }

  query += " ORDER BY uploaded_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return db.prepare(query).all(...params).map(parseDocumentRow);
}

// ── Delete document ───────────────────────────────────────────────────────────

export function deleteDocument(docId) {
  return runTransaction(() => {
    logger.info(`Deleting document ${docId} and all associated data...`);

    const chunks = db.prepare("SELECT id, node_id FROM chunks WHERE document_id = ?").all(docId);
    const chunkIds = chunks.map(c => c.id);
    const nodeIds = [...new Set(chunks.map(c => c.node_id).filter(Boolean))];

    // 1. Delete conflicts (no ON DELETE CASCADE on chunk_a_id/chunk_b_id)
    if (chunkIds.length > 0) {
      const ph = chunkIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM conflicts WHERE chunk_a_id IN (${ph}) OR chunk_b_id IN (${ph})`)
        .run(...chunkIds, ...chunkIds);
    }

    // 2. Delete chunk embeddings
    for (const chunkId of chunkIds) {
      db.prepare("DELETE FROM embeddings WHERE ref_type = 'chunk' AND ref_id = ?").run(String(chunkId));
    }

    // 3. Delete from chunks FTS
    for (const chunkId of chunkIds) {
      db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(String(chunkId));
    }

    // 4. Clear superseded_by references before deleting chunks (avoids FK violation)
    if (chunkIds.length > 0) {
      const ph = chunkIds.map(() => "?").join(",");
      db.prepare(`UPDATE chunks SET superseded_by = NULL WHERE superseded_by IN (${ph})`).run(...chunkIds);
    }
    db.prepare("UPDATE chunks SET superseded_by = NULL WHERE document_id = ?").run(docId);

    // 5. Delete chunks (fact_evidence and entity_mentions cascade automatically)
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
    logger.debug(`Deleted ${chunkIds.length} chunks`);

    // 5.5. Clean up orphaned entities and facts left behind after CASCADE deletions
    const deletedFacts = db.prepare(
      "DELETE FROM facts WHERE id NOT IN (SELECT DISTINCT fact_id FROM fact_evidence)"
    ).run().changes;
    const deletedEntities = db.prepare(
      "DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)"
    ).run().changes;
    if (deletedFacts > 0 || deletedEntities > 0) {
      logger.debug(`Deleted ${deletedEntities} orphaned entities, ${deletedFacts} orphaned facts`);
    }

    // 6. Clean up orphaned nodes (deepest first, then climb the tree)
    let deletedNodes = 0;
    const deletedNodeSet = new Set();

    function deleteNodeById(nodeId) {
      db.prepare("DELETE FROM embeddings WHERE ref_type = 'node' AND ref_id = ?").run(nodeId);
      db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);
      db.prepare("DELETE FROM nodes WHERE node_id = ?").run(nodeId);
      deletedNodeSet.add(nodeId);
      deletedNodes++;
    }

    function pruneEmptyChildren(parentId) {
      const children = db.prepare("SELECT node_id FROM nodes WHERE parent_id = ?").all(parentId);
      for (const { node_id: childId } of children) {
        if (deletedNodeSet.has(childId)) continue;
        pruneEmptyChildren(childId);
        const childChunks = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE node_id = ?").get(childId);
        const grandChildren = db.prepare("SELECT COUNT(*) as count FROM nodes WHERE parent_id = ?").get(childId);
        if (childChunks.count === 0 && grandChildren.count === 0) {
          logger.debug(`Deleted empty sibling node: ${childId}`);
          deleteNodeById(childId);
        }
      }
    }

    if (nodeIds.length > 0) {
      const ph = nodeIds.map(() => "?").join(",");
      const nodeRows = db.prepare(
        `SELECT node_id, level, parent_id FROM nodes WHERE node_id IN (${ph})`
      ).all(...nodeIds);

      // Phase A — delete direct chunk nodes, deepest first
      const sorted = nodeRows.sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0));
      for (const { node_id: nodeId } of sorted) {
        if (nodeId === "root") continue;
        const remaining = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE node_id = ?").get(nodeId);
        const children = db.prepare("SELECT COUNT(*) as count FROM nodes WHERE parent_id = ?").get(nodeId);
        if (remaining.count === 0 && children.count === 0) {
          deleteNodeById(nodeId);
          logger.debug(`Deleted orphaned node: ${nodeId}`);
        }
      }

      // Phase B — walk upward from original parents
      let toCheck = new Set(
        nodeRows
          .filter(n => n.parent_id && n.parent_id !== "root" && !deletedNodeSet.has(n.parent_id))
          .map(n => n.parent_id)
      );

      while (toCheck.size > 0) {
        const nextCheck = new Set();
        for (const parentId of toCheck) {
          if (parentId === "root" || deletedNodeSet.has(parentId)) continue;
          const remaining = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE node_id = ?").get(parentId);
          if (remaining.count === 0) pruneEmptyChildren(parentId);
          const children = db.prepare("SELECT COUNT(*) as count FROM nodes WHERE parent_id = ?").get(parentId);
          if (remaining.count === 0 && children.count === 0) {
            const row = db.prepare("SELECT parent_id FROM nodes WHERE node_id = ?").get(parentId);
            deleteNodeById(parentId);
            logger.debug(`Deleted orphaned ancestor node: ${parentId}`);
            if (row?.parent_id && row.parent_id !== "root") nextCheck.add(row.parent_id);
          }
        }
        toCheck = nextCheck;
      }
    }

    // 7. Soft-delete the document record
    db.prepare("UPDATE documents SET status = 'deleted' WHERE id = ?").run(docId);
    logAudit("delete", "documents", docId, null, { chunk_count: chunkIds.length, node_count: deletedNodes });
    logger.info(`Document ${docId} deleted: ${chunkIds.length} chunks, ${deletedNodes} nodes removed`);

    return { deletedChunks: chunkIds.length, deletedNodes, deletedEmbeddings: chunkIds.length + deletedNodes };
  });
}

// ── Empty the entire tree ─────────────────────────────────────────────────────

export function emptyTree() {
  return runTransaction(() => {
    logger.warn("Emptying entire knowledge tree...");

    const nodeCount      = db.prepare("SELECT COUNT(*) as count FROM nodes").get().count;
    const chunkCount     = db.prepare("SELECT COUNT(*) as count FROM chunks").get().count;
    const embeddingCount = db.prepare("SELECT COUNT(*) as count FROM embeddings").get().count;
    const docCount       = db.prepare("SELECT COUNT(*) as count FROM documents WHERE status != 'deleted'").get().count;

    db.prepare("DELETE FROM conflicts").run();
    db.prepare("DELETE FROM embeddings").run();
    db.prepare("DELETE FROM chunks_fts").run();
    db.prepare("DELETE FROM chunks").run();
    db.prepare("DELETE FROM facts").run();
    db.prepare("DELETE FROM entities").run();
    db.prepare("DELETE FROM nodes_fts").run();
    db.prepare("DELETE FROM nodes").run();
    db.prepare("UPDATE documents SET status = 'deleted' WHERE status != 'deleted'").run();

    logAudit("empty_tree", "system", "all", null, { nodes: nodeCount, chunks: chunkCount, embeddings: embeddingCount, documents: docCount });
    logger.warn(`Tree emptied: ${nodeCount} nodes, ${chunkCount} chunks, ${embeddingCount} embeddings, ${docCount} documents`);

    return { deletedNodes: nodeCount, deletedChunks: chunkCount, deletedEmbeddings: embeddingCount, deletedDocuments: docCount };
  });
}
