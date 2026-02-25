/**
 * Document Ingestion — Public API
 *
 * Re-exports the pipeline entry points and provides document management
 * functions (list, get, delete, empty tree).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logAudit, runTransaction, safeJson } from "../db/db.js";
import { DocumentRepo } from "../db/repositories/DocumentRepo.js";
import { IngestRepo } from "../db/repositories/IngestRepo.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ingestLogger as logger } from "../utils/logger.js";

const UPLOADS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../uploads");

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
  return parseDocumentRow(DocumentRepo.getById(docId));
}

export function listDocuments(filters = {}) {
  return DocumentRepo.list(filters).map(parseDocumentRow);
}

// ── Delete document ───────────────────────────────────────────────────────────

export function deleteDocument(docId) {
  // Read filename before the transaction so we can delete the file afterward
  const docRow = DocumentRepo.getById(docId);

  const result = runTransaction(() => {
    logger.info(`Deleting document ${docId} and all associated data...`);

    const chunks = IngestRepo.getChunksForDoc(docId);
    const chunkIds = chunks.map(c => c.id);
    const nodeIds = [...new Set(chunks.map(c => c.node_id).filter(Boolean))];

    // 1. Delete conflicts (no ON DELETE CASCADE on chunk_a_id/chunk_b_id)
    IngestRepo.deleteConflictsForChunks(chunkIds);

    // 2. Delete chunk embeddings
    for (const chunkId of chunkIds) {
      IngestRepo.deleteEmbeddingForChunk(chunkId);
    }

    // 3. Delete from chunks FTS
    for (const chunkId of chunkIds) {
      IngestRepo.deleteChunkFts(chunkId);
    }

    // 4. Clear superseded_by references before deleting chunks (avoids FK violation)
    IngestRepo.clearSupersededByForChunks(chunkIds);
    IngestRepo.clearSupersededByForDoc(docId);

    // 5. Delete chunks (fact_evidence and entity_mentions cascade automatically)
    IngestRepo.deleteChunksForDoc(docId);
    logger.debug(`Deleted ${chunkIds.length} chunks`);

    // 5.5. Clean up orphaned entities and facts left behind after CASCADE deletions
    const deletedFacts = IngestRepo.deleteOrphanedFacts();
    const deletedEntities = IngestRepo.deleteOrphanedEntities();
    if (deletedFacts > 0 || deletedEntities > 0) {
      logger.debug(`Deleted ${deletedEntities} orphaned entities, ${deletedFacts} orphaned facts`);
    }

    // 6. Clean up orphaned nodes (deepest first, then climb the tree)
    let deletedNodes = 0;
    const deletedNodeSet = new Set();

    function deleteNodeById(nodeId) {
      IngestRepo.deleteNodeEmbedding(nodeId);
      NodeRepo.deleteFtsForNode(nodeId);
      IngestRepo.deleteNode(nodeId);
      deletedNodeSet.add(nodeId);
      deletedNodes++;
    }

    function pruneEmptyChildren(parentId) {
      const children = IngestRepo.getChildrenOfNode(parentId);
      for (const { node_id: childId } of children) {
        if (deletedNodeSet.has(childId)) continue;
        pruneEmptyChildren(childId);
        const chunkCount = IngestRepo.getChunkCountForNode(childId);
        const grandChildCount = IngestRepo.getChildCountForNode(childId);
        if (chunkCount === 0 && grandChildCount === 0) {
          logger.debug(`Deleted empty sibling node: ${childId}`);
          deleteNodeById(childId);
        }
      }
    }

    if (nodeIds.length > 0) {
      const nodeRows = IngestRepo.getNodesByIds(nodeIds);

      // Phase A — delete direct chunk nodes, deepest first
      const sorted = nodeRows.sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0));
      for (const { node_id: nodeId } of sorted) {
        if (nodeId === "root") continue;
        const remaining = IngestRepo.getChunkCountForNode(nodeId);
        const children = IngestRepo.getChildCountForNode(nodeId);
        if (remaining === 0 && children === 0) {
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
          const remaining = IngestRepo.getChunkCountForNode(parentId);
          if (remaining === 0) pruneEmptyChildren(parentId);
          const children = IngestRepo.getChildCountForNode(parentId);
          if (remaining === 0 && children === 0) {
            const parentOfParent = IngestRepo.getNodeParentId(parentId);
            deleteNodeById(parentId);
            logger.debug(`Deleted orphaned ancestor node: ${parentId}`);
            if (parentOfParent && parentOfParent !== "root") nextCheck.add(parentOfParent);
          }
        }
        toCheck = nextCheck;
      }
    }

    // 7. Soft-delete the document record
    DocumentRepo.softDelete(docId);
    logAudit("delete", "documents", docId, null, { chunk_count: chunkIds.length, node_count: deletedNodes });
    logger.info(`Document ${docId} deleted: ${chunkIds.length} chunks, ${deletedNodes} nodes removed`);

    return { deletedChunks: chunkIds.length, deletedNodes, deletedEmbeddings: chunkIds.length + deletedNodes };
  });

  // Delete the physical file after the DB transaction succeeds
  if (docRow?.filename) {
    const filePath = path.join(UPLOADS_DIR, docRow.filename);
    try {
      fs.unlinkSync(filePath);
      logger.info(`Deleted upload file: ${docRow.filename}`);
    } catch (err) {
      // Non-fatal: file may have already been removed or never existed
      if (err.code !== 'ENOENT') {
        logger.warn(`Could not delete upload file ${docRow.filename}: ${err.message}`);
      }
    }
  }

  return result;
}

// ── Empty the entire tree ─────────────────────────────────────────────────────

export function emptyTree() {
  return runTransaction(() => {
    logger.warn("Emptying entire knowledge tree...");

    const nodeCount      = IngestRepo.countNodes();
    const chunkCount     = IngestRepo.countChunks();
    const embeddingCount = IngestRepo.countEmbeddings();
    const docCount       = IngestRepo.countActiveDocs();

    IngestRepo.deleteAllConflicts();
    IngestRepo.deleteAllEmbeddings();
    IngestRepo.deleteAllChunkFts();
    IngestRepo.deleteAllChunks();
    IngestRepo.deleteAllFacts();
    IngestRepo.deleteAllEntities();
    IngestRepo.deleteAllNodeFts();
    IngestRepo.deleteAllNodes();
    DocumentRepo.softDeleteAll();

    logAudit("empty_tree", "system", "all", null, { nodes: nodeCount, chunks: chunkCount, embeddings: embeddingCount, documents: docCount });
    logger.warn(`Tree emptied: ${nodeCount} nodes, ${chunkCount} chunks, ${embeddingCount} embeddings, ${docCount} documents`);

    return { deletedNodes: nodeCount, deletedChunks: chunkCount, deletedEmbeddings: embeddingCount, deletedDocuments: docCount };
  });
}
