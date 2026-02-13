/**
 * Document Ingestion Pipeline
 *
 * Main entry point for processing documents into the knowledge tree
 */

import { db, logAudit, runTransaction, safeJson } from "../db/db.js";
import { parseFile, isSupportedFileType, getFileType } from "./fileParser.js";
import { chunkText, getChunkStats } from "./chunker.js";
import { extractKeywords, extractMetadataWithLLM, extractScope, detectChunkType, detectAuthorityLevel } from "./metadataExtractor.js";
import { autoMapChunks, assignChunkToNode, createNode, generateAndSaveAliases } from "./nodeMapper.js";
import { processNewChunkConflicts } from "./conflictDetector.js";
import { processDocumentForExtraction } from "../extraction/entityFactExtractor.js";
import { ingestLogger as logger } from "../utils/logger.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// Re-export individual modules
export * from "./fileParser.js";
export * from "./chunker.js";
export * from "./metadataExtractor.js";
export * from "./nodeMapper.js";
export * from "./conflictDetector.js";

/**
 * Calculate file hash for deduplication
 */
function calculateFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Register a document in the database
 * @param {object} fileInfo - File information
 * @returns {number} Document ID
 */
export function registerDocument(fileInfo) {
  const { filename, originalName, fileType, fileSize, fileHash, metadata = {} } = fileInfo;

  // Use an immediate write lock so duplicate-check + insert is atomic even across processes.
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(`
      SELECT id FROM documents WHERE file_hash = ? AND status != 'deleted'
    `).get(fileHash);

    if (existing) {
      db.exec("COMMIT");
      return { id: existing.id, duplicate: true };
    }

    const result = db.prepare(`
      INSERT INTO documents (filename, original_name, file_type, file_size, file_hash, metadata_json, status, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
    `).run(filename, originalName, fileType, fileSize, fileHash, JSON.stringify(metadata));

    logAudit("create", "documents", result.lastInsertRowid, null, { filename, originalName });

    db.exec("COMMIT");
    return { id: Number(result.lastInsertRowid), duplicate: false };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Update document status
 */
export function updateDocumentStatus(docId, status, chunkCount = null) {
  const updates = ["status = ?"];
  const params = [status];

  if (status === "processed") {
    updates.push("processed_at = datetime('now')");
  }

  if (chunkCount !== null) {
    updates.push("chunk_count = ?");
    params.push(chunkCount);
  }

  params.push(docId);

  db.prepare(`
    UPDATE documents SET ${updates.join(", ")} WHERE id = ?
  `).run(...params);
}

function withStepProgress(progress) {
  const p = Number(progress);
  if (!Number.isFinite(p)) return null;
  return Math.max(0, Math.min(100, Math.round(p)));
}

function setDocumentProcessingStep(docId, step, message, progress, status = "processing") {
  if (!docId) return;

  try {
    const row = db.prepare(`
      SELECT metadata_json FROM documents WHERE id = ?
    `).get(docId);
    if (!row) return;

    const metadata = safeJson(row.metadata_json, {});
    const existing = metadata.processing && typeof metadata.processing === "object"
      ? metadata.processing
      : {};
    const now = new Date().toISOString();
    const normalizedProgress = withStepProgress(progress);

    const history = Array.isArray(existing.history) ? existing.history.slice(-24) : [];
    history.push({
      step,
      message,
      progress: normalizedProgress,
      status,
      timestamp: now
    });

    metadata.processing = {
      ...existing,
      step,
      message,
      progress: normalizedProgress,
      status,
      updated_at: now,
      history
    };

    db.prepare(`
      UPDATE documents
      SET status = ?, metadata_json = ?
      WHERE id = ?
    `).run(status, JSON.stringify(metadata), docId);

    const progressSuffix = normalizedProgress === null ? "" : ` (${normalizedProgress}%)`;
    logger.info(`[doc:${docId}] ${step}${progressSuffix} - ${message}`);
  } catch (err) {
    logger.warn(`Failed to update processing step for document ${docId}: ${err.message}`);
  }
}

function parseDocumentRow(row) {
  if (!row) return null;

  const metadata = safeJson(row.metadata_json, {});
  const processing = metadata.processing && typeof metadata.processing === "object"
    ? metadata.processing
    : {};

  return {
    ...row,
    metadata,
    processing_step: processing.step || null,
    processing_message: processing.message || null,
    processing_progress: withStepProgress(processing.progress),
    processing_updated_at: processing.updated_at || null
  };
}

/**
 * Roll back partial writes for a failed document ingest.
 * Keeps the document record for observability, but removes chunks/conflicts created so far.
 */
function rollbackFailedDocument(docId) {
  return runTransaction(() => {
    const chunks = db.prepare(`
      SELECT id, node_id FROM chunks WHERE document_id = ?
    `).all(docId);

    const chunkIds = chunks.map(c => Number(c.id));
    const affectedNodeIds = new Set(chunks.map(c => c.node_id).filter(Boolean));

    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => "?").join(",");

      const conflictNodes = db.prepare(`
        SELECT DISTINCT node_id
        FROM conflicts
        WHERE chunk_a_id IN (${placeholders}) OR chunk_b_id IN (${placeholders})
      `).all(...chunkIds, ...chunkIds);
      for (const row of conflictNodes) {
        if (row.node_id) affectedNodeIds.add(row.node_id);
      }

      db.prepare(`
        DELETE FROM conflicts
        WHERE chunk_a_id IN (${placeholders}) OR chunk_b_id IN (${placeholders})
      `).run(...chunkIds, ...chunkIds);

      const chunkRefIds = chunkIds.map(id => String(id));
      const refPlaceholders = chunkRefIds.map(() => "?").join(",");
      db.prepare(`
        DELETE FROM embeddings
        WHERE ref_type = 'chunk' AND ref_id IN (${refPlaceholders})
      `).run(...chunkRefIds);

      db.prepare(`
        DELETE FROM chunks_fts
        WHERE chunk_id IN (${refPlaceholders})
      `).run(...chunkRefIds);

      db.prepare(`
        DELETE FROM chunks
        WHERE document_id = ?
      `).run(docId);
    }

    // Recompute conflict score for affected nodes to avoid stale counters.
    for (const nodeId of affectedNodeIds) {
      const openConflicts = db.prepare(`
        SELECT COUNT(*) as count
        FROM conflicts
        WHERE node_id = ? AND resolution = 'human_review'
      `).get(nodeId).count;

      db.prepare(`
        UPDATE nodes
        SET conflict_score = ?, updated_at = datetime('now')
        WHERE node_id = ?
      `).run(openConflicts, nodeId);
    }

    db.prepare(`
      UPDATE documents
      SET status = 'failed', chunk_count = 0
      WHERE id = ?
    `).run(docId);
  });
}

/**
 * Full document processing pipeline
 * @param {string} filePath - Path to the file
 * @param {object} options - Processing options
 * @returns {Promise<object>} Processing results
 */
export async function processDocument(filePath, options = {}) {
  const {
    targetNodeId = null,     // If specified, all chunks go to this node
    useLLM = true,           // Use LLM for metadata and mapping
    detectConflicts = true,  // Check for conflicts
    createNewNodes = true,   // Allow creating new nodes (default: true)
    extractEntities = true,  // Extract entities and facts from chunks
    chunkConfig = {}         // Chunking configuration
  } = options;

  const startTime = Date.now();
  const results = {
    success: false,
    documentId: null,
    filename: path.basename(filePath),
    stats: {},
    chunks: [],
    mappings: [],
    conflicts: [],
    errors: []
  };

  try {
    // 1. Validate file
    logger.info(`Processing document: ${path.basename(filePath)}`);
    logger.info(`[${path.basename(filePath)}] Step: validate_input`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    if (!isSupportedFileType(filePath)) {
      throw new Error(`Unsupported file type: ${path.extname(filePath)}`);
    }

    // 2. Parse file
    logger.info(`[${path.basename(filePath)}] Step: parse_file`);
    logger.debug("Parsing file content...");
    const { content, metadata } = await parseFile(filePath);

    if (!content || content.trim().length === 0) {
      throw new Error("File contains no extractable text");
    }

    // 3. Register document
    const fileHash = calculateFileHash(filePath);
    const docResult = registerDocument({
      filename: path.basename(filePath),
      originalName: metadata.filename,
      fileType: metadata.fileType,
      fileSize: metadata.fileSize,
      fileHash,
      metadata
    });

    if (docResult.duplicate) {
      results.documentId = docResult.id;
      results.errors.push("Document already exists (duplicate hash)");
      logger.info(`[doc:${results.documentId}] duplicate_detected - Existing document reused.`);
      return results;
    }

    results.documentId = docResult.id;
    setDocumentProcessingStep(results.documentId, "registered", "Document registered. Starting processing.", 10);

    // 4. Chunk the content
    setDocumentProcessingStep(results.documentId, "chunking", "Splitting content into chunks.", 25);
    logger.debug("Chunking content...");
    const chunks = chunkText(content, chunkConfig);
    results.stats.chunkCount = chunks.length;
    results.stats.chunkStats = getChunkStats(chunks);
    logger.info(`Created ${chunks.length} chunks`);

    // 5. Extract metadata for each chunk
    setDocumentProcessingStep(
      results.documentId,
      "metadata_extraction",
      `Extracting chunk metadata (0/${chunks.length}).`,
      40
    );
    logger.debug(`Extracting metadata for ${chunks.length} chunks (useLLM=${useLLM})...`);
    const enrichedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let chunkMeta;

      if (useLLM && chunk.content.length > 100) {
        chunkMeta = await extractMetadataWithLLM(chunk.content, metadata.filename);
      } else {
        chunkMeta = {
          keywords: extractKeywords(chunk.content),
          chunk_type: detectChunkType(chunk.content),
          authority_level: detectAuthorityLevel(chunk.content, metadata.filename)
        };
      }

      const scope = extractScope(chunk.content, metadata.filename);

      enrichedChunks.push({
        ...chunk,
        doc_title: metadata.filename,
        keywords: chunkMeta.keywords || [],
        chunk_type: chunkMeta.chunk_type || "other",
        authority_level: chunkMeta.authority_level || "sop",
        scope: { ...scope, ...(chunkMeta.entities || {}) },
        fields: chunkMeta.entities || {}
      });

      if (chunks.length > 0 && (i === 0 || (i + 1) % 10 === 0 || i === chunks.length - 1)) {
        const progress = 40 + ((i + 1) / chunks.length) * 25;
        setDocumentProcessingStep(
          results.documentId,
          "metadata_extraction",
          `Extracting chunk metadata (${i + 1}/${chunks.length}).`,
          progress
        );
      }
    }

    // 6. Map chunks to nodes
    setDocumentProcessingStep(results.documentId, "mapping_chunks", "Mapping chunks to tree nodes.", 68);
    logger.debug("Mapping chunks to nodes...");
    if (targetNodeId) {
      logger.debug(`Using target node: ${targetNodeId}`);
      // All chunks go to specified node
      for (let i = 0; i < enrichedChunks.length; i++) {
        const chunk = enrichedChunks[i];
        const chunkId = assignChunkToNode(chunk, targetNodeId, results.documentId);
        results.chunks.push({ chunkId, nodeId: targetNodeId, index: chunk.index });

        // Check for conflicts
        if (detectConflicts) {
          if (i === 0) {
            setDocumentProcessingStep(results.documentId, "conflict_detection", "Checking for conflicts.", 85);
          }
          const conflictResult = await processNewChunkConflicts(chunkId, targetNodeId);
          if (conflictResult.total_conflicts > 0) {
            results.conflicts.push(...conflictResult.recorded);
          }
        }

        if (enrichedChunks.length > 0 && (i === 0 || (i + 1) % 10 === 0 || i === enrichedChunks.length - 1)) {
          const mappedProgress = detectConflicts ? 85 : 90;
          const progress = mappedProgress + ((i + 1) / enrichedChunks.length) * (detectConflicts ? 10 : 8);
          setDocumentProcessingStep(
            results.documentId,
            detectConflicts ? "conflict_detection" : "mapping_chunks",
            `${detectConflicts ? "Checking conflicts" : "Mapping"} (${i + 1}/${enrichedChunks.length}).`,
            progress
          );
        }
      }
    } else {
      // Auto-map chunks to nodes
      const mappingResult = await autoMapChunks(enrichedChunks, results.documentId, {
        useLLM,
        createNewNodes
      });

      results.mappings = mappingResult;
      results.chunks = mappingResult.mapped;
      setDocumentProcessingStep(
        results.documentId,
        "mapping_chunks",
        `Mapped ${mappingResult.mapped.length}/${enrichedChunks.length} chunks.`,
        84
      );

      // Process conflicts for mapped chunks
      if (detectConflicts) {
        setDocumentProcessingStep(results.documentId, "conflict_detection", "Checking mapped chunks for conflicts.", 88);
        for (let i = 0; i < mappingResult.mapped.length; i++) {
          const mapping = mappingResult.mapped[i];
          const conflictResult = await processNewChunkConflicts(mapping.chunkId, mapping.nodeId);
          if (conflictResult.total_conflicts > 0) {
            results.conflicts.push(...conflictResult.recorded);
          }

          if (mappingResult.mapped.length > 0 && (i === 0 || (i + 1) % 10 === 0 || i === mappingResult.mapped.length - 1)) {
            const progress = 88 + ((i + 1) / mappingResult.mapped.length) * 10;
            setDocumentProcessingStep(
              results.documentId,
              "conflict_detection",
              `Checking conflicts (${i + 1}/${mappingResult.mapped.length}).`,
              progress
            );
          }
        }
      }

      // Report unmapped chunks
      if (mappingResult.unmapped.length > 0) {
        results.errors.push(`${mappingResult.unmapped.length} chunks could not be mapped to nodes`);
      }

      // Generate aliases for newly created nodes
      if (useLLM && mappingResult.newNodes && mappingResult.newNodes.length > 0) {
        setDocumentProcessingStep(results.documentId, "generating_aliases", "Generating search aliases for new nodes.", 95);
        logger.debug(`Generating aliases for ${mappingResult.newNodes.length} new nodes...`);

        for (let i = 0; i < mappingResult.newNodes.length; i++) {
          const node = mappingResult.newNodes[i];
          try {
            await generateAndSaveAliases(node.node_id, { includeChunks: true, maxAliases: 8 });
          } catch (err) {
            logger.warn(`Failed to generate aliases for node ${node.node_id}: ${err.message}`);
          }

          // Rate limit between LLM calls
          if (i < mappingResult.newNodes.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        logger.debug(`Alias generation complete for ${mappingResult.newNodes.length} nodes`);
      }
    }

    // 6.5. Entity-Fact Extraction
    if (extractEntities) {
      try {
        setDocumentProcessingStep(results.documentId, "entity_extraction", "Extracting entities and facts from chunks.", 96);
        logger.info(`Starting entity-fact extraction for document ${results.documentId} (${results.chunks.length} chunks)...`);

        const extractionResult = await processDocumentForExtraction(results.documentId, { useLLM });

        results.stats.entitiesExtracted = extractionResult.total_entities;
        results.stats.factsExtracted = extractionResult.total_facts;
        results.extraction = {
          entities: extractionResult.total_entities,
          facts: extractionResult.total_facts,
          chunks_processed: extractionResult.chunks_processed,
          errors: extractionResult.errors
        };

        logger.info(`Entity-fact extraction complete: ${extractionResult.total_entities} entities, ${extractionResult.total_facts} facts from ${extractionResult.chunks_processed} chunks`);

        if (extractionResult.errors?.length > 0) {
          logger.warn(`Entity extraction had ${extractionResult.errors.length} errors`);
        }
      } catch (err) {
        logger.warn(`Entity-fact extraction failed: ${err.message}`);
        results.extraction = { error: err.message };
        // Non-fatal, continue processing
      }
    } else {
      logger.debug('Entity-fact extraction skipped (disabled)');
    }

    // 7. Update document status
    setDocumentProcessingStep(results.documentId, "finalizing", "Finalizing document processing.", 99);
    updateDocumentStatus(results.documentId, "processed", results.chunks.length);
    setDocumentProcessingStep(results.documentId, "completed", "Document processed successfully.", 100, "processed");

    results.success = true;
    results.stats.processingTime = Date.now() - startTime;
    logger.info(`Document processed successfully in ${results.stats.processingTime}ms: ${results.chunks.length} chunks, ${results.conflicts.length} conflicts`);

  } catch (err) {
    logger.error(`Document processing failed: ${err.message}`);
    results.errors.push(err.message);

    if (results.documentId) {
      try {
        rollbackFailedDocument(results.documentId);
        setDocumentProcessingStep(results.documentId, "failed", `Processing failed: ${err.message}`, 100, "failed");
      } catch (rollbackErr) {
        logger.error(`Failed to roll back partial ingest for document ${results.documentId}: ${rollbackErr.message}`);
        updateDocumentStatus(results.documentId, "failed");
        setDocumentProcessingStep(
          results.documentId,
          "failed",
          `Processing failed and rollback failed: ${rollbackErr.message}`,
          100,
          "failed"
        );
      }
    }
  }

  return results;
}

/**
 * Process multiple documents
 * @param {string[]} filePaths - Array of file paths
 * @param {object} options - Processing options
 * @returns {Promise<object>} Batch results
 */
export async function processDocumentBatch(filePaths, options = {}) {
  const results = {
    total: filePaths.length,
    successful: 0,
    failed: 0,
    documents: []
  };

  for (const filePath of filePaths) {
    const result = await processDocument(filePath, options);
    results.documents.push(result);

    if (result.success) {
      results.successful++;
    } else {
      results.failed++;
    }
  }

  return results;
}

/**
 * Get document by ID
 */
export function getDocument(docId) {
  const row = db.prepare(`
    SELECT * FROM documents WHERE id = ?
  `).get(docId);
  return parseDocumentRow(row);
}

/**
 * List documents with optional filters
 */
export function listDocuments(filters = {}) {
  const { status, limit = 50, offset = 0 } = filters;

  let query = "SELECT * FROM documents";
  const params = [];

  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY uploaded_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);
  return rows.map(parseDocumentRow);
}

/**
 * Empty the entire tree - delete all nodes, chunks, embeddings
 * Marks all documents as deleted
 */
export function emptyTree() {
  return runTransaction(() => {
    logger.warn("Emptying entire knowledge tree...");

    // Get counts before deletion
    const nodeCount = db.prepare("SELECT COUNT(*) as count FROM nodes").get().count;
    const chunkCount = db.prepare("SELECT COUNT(*) as count FROM chunks").get().count;
    const embeddingCount = db.prepare("SELECT COUNT(*) as count FROM embeddings").get().count;
    const docCount = db.prepare("SELECT COUNT(*) as count FROM documents WHERE status != 'deleted'").get().count;

    // 1. Delete all embeddings
    db.prepare("DELETE FROM embeddings").run();
    logger.debug(`Deleted ${embeddingCount} embeddings`);

    // 2. Delete all chunks FTS
    db.prepare("DELETE FROM chunks_fts").run();

    // 3. Delete all chunks
    db.prepare("DELETE FROM chunks").run();
    logger.debug(`Deleted ${chunkCount} chunks`);

    // 4. Delete all conflicts
    db.prepare("DELETE FROM conflicts").run();

    // 5. Delete all nodes FTS
    db.prepare("DELETE FROM nodes_fts").run();

    // 6. Delete all nodes
    db.prepare("DELETE FROM nodes").run();
    logger.debug(`Deleted ${nodeCount} nodes`);

    // 7. Mark all documents as deleted
    db.prepare("UPDATE documents SET status = 'deleted' WHERE status != 'deleted'").run();
    logger.debug(`Marked ${docCount} documents as deleted`);

    // 8. Log audit
    logAudit("empty_tree", "system", "all", null, {
      nodes: nodeCount,
      chunks: chunkCount,
      embeddings: embeddingCount,
      documents: docCount
    });

    logger.warn(`Tree emptied: ${nodeCount} nodes, ${chunkCount} chunks, ${embeddingCount} embeddings, ${docCount} documents`);

    return {
      deletedNodes: nodeCount,
      deletedChunks: chunkCount,
      deletedEmbeddings: embeddingCount,
      deletedDocuments: docCount
    };
  });
}

/**
 * Delete a document and all associated data (chunks, nodes, embeddings)
 */
export function deleteDocument(docId) {
  return runTransaction(() => {
    logger.info(`Deleting document ${docId} and all associated data...`);

    // Get chunks for this document
    const chunks = db.prepare("SELECT id, node_id FROM chunks WHERE document_id = ?").all(docId);
    const chunkIds = chunks.map(c => c.id);
    const nodeIds = [...new Set(chunks.map(c => c.node_id).filter(Boolean))];

    // 1. Delete chunk embeddings
    for (const chunkId of chunkIds) {
      db.prepare("DELETE FROM embeddings WHERE ref_type = 'chunk' AND ref_id = ?").run(String(chunkId));
    }
    logger.debug(`Deleted ${chunkIds.length} chunk embeddings`);

    // 2. Delete from chunks FTS
    for (const chunkId of chunkIds) {
      db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?").run(String(chunkId));
    }

    // 3. Delete chunks
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
    logger.debug(`Deleted ${chunkIds.length} chunks`);

    // 4. Delete conflicts related to these chunks
    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM conflicts WHERE chunk_a_id IN (${placeholders}) OR chunk_b_id IN (${placeholders})`).run(...chunkIds, ...chunkIds);
    }

    // 5. Check and delete orphaned nodes (nodes with no remaining chunks)
    let deletedNodes = 0;
    let sortedNodeIds = nodeIds;
    if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => "?").join(",");
      const nodeRows = db.prepare(`
        SELECT node_id, level
        FROM nodes
        WHERE node_id IN (${placeholders})
      `).all(...nodeIds);

      // Delete deeper nodes first so parent deletions don't violate self-referential FK.
      sortedNodeIds = nodeRows
        .sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0))
        .map(n => n.node_id);
    }

    for (const nodeId of sortedNodeIds) {
      // Skip root node
      if (nodeId === 'root') continue;

      // Check if node has any remaining chunks
      const remainingChunks = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE node_id = ?").get(nodeId);
      const childNodes = db.prepare("SELECT COUNT(*) as count FROM nodes WHERE parent_id = ?").get(nodeId);

      if (remainingChunks.count === 0 && childNodes.count === 0) {
        // Delete node embedding
        db.prepare("DELETE FROM embeddings WHERE ref_type = 'node' AND ref_id = ?").run(nodeId);

        // Delete from nodes FTS
        db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(nodeId);

        // Delete the node
        db.prepare("DELETE FROM nodes WHERE node_id = ?").run(nodeId);

        deletedNodes++;
        logger.debug(`Deleted orphaned node: ${nodeId}`);
      }
    }

    // 6. Update document status
    db.prepare("UPDATE documents SET status = 'deleted' WHERE id = ?").run(docId);

    logAudit("delete", "documents", docId, null, {
      chunk_count: chunkIds.length,
      node_count: deletedNodes
    });

    logger.info(`Document ${docId} deleted: ${chunkIds.length} chunks, ${deletedNodes} nodes removed`);

    return {
      deletedChunks: chunkIds.length,
      deletedNodes: deletedNodes,
      deletedEmbeddings: chunkIds.length + deletedNodes
    };
  });
}
