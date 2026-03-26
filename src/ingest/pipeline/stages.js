/**
 * Ingestion pipeline stage functions.
 *
 * Each stage receives a shared `ctx` object and mutates it.
 * Stages must be called in order by the pipeline runner.
 *
 * ctx shape:
 *   filePath, options
 *   → (stageParseFile)    content, fileMetadata
 *   → (stageRegister)     documentId, isDuplicate
 *   → (stageEnrichChunks) enrichedChunks
 *   → (stageMapChunks)    mappingResult, conflictsFound
 *   → (stageEntities)     extractionResult
 *   → (stageFinalize)     [results.success = true]
 */

import { db, logAudit, runTransaction, safeJson } from "../../db/db.js";
import { DocumentRepo } from "../../db/repositories/DocumentRepo.js";
import { DatasetConfigRepo } from "../../db/repositories/DatasetConfigRepo.js";
import { parseFile, isSupportedFileType } from "../fileParser.js";
import { extractKnowledgePoints } from "../knowledgeExtractor.js";
import { detectAuthorityLevel } from "../metadataExtractor.js";
import { autoMapChunks, assignChunkToNode, generateAndSaveAliases, generateAliasesBatch } from "../nodeMapper.js";

const SKIP_ALIASES = process.env.INGEST_SKIP_ALIASES === 'true';
import { syncEmbeddings } from "../../embedding/chunkEmbeddings.js";
import { invalidateVectorCache } from "../../kg/vectorTreeRouter.js";
import { recordIngestionMetrics } from "../../learning/ingestionTracker.js";
import { callLLM, isLlmConfigured } from "../../utils/llm.js";
import { getCustomPrompt } from "../../prompts/promptManager.js";
import { findMergeCandidates, queueNodeMergeSuggestion } from "../nodeMerger.js";
import { reclassifyGeneralKPs } from "../kpNormaliser.js";
import { enrichNodeKeywords, computeNodeQuality } from "../nodeEnrichment.js";
import { findSplitCandidates, clusterChunksByKeywords, executeSplit } from "../nodeSplitter.js";
import { ChunkRepo } from "../../db/repositories/ChunkRepo.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { DecisionRepo } from "../../db/repositories/DecisionRepo.js";
import { wordDiceSimilarity } from "../knowledgeExtractor.js";
import { ingestLogger as logger } from "../../utils/logger.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const AUTO_EMBED = process.env.INGEST_AUTO_EMBED !== "false";

// ── Internal DB helpers ───────────────────────────────────────────────────────

function calculateFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function registerDocument(fileInfo) {
  const { filename, originalName, fileType, fileSize, fileHash, metadata = {} } = fileInfo;
  return runTransaction(() => {
    const existing = DocumentRepo.findByHash(fileHash);
    if (existing) {
      if (existing.status === 'processed') {
        // Genuine duplicate — document already fully processed
        return { id: existing.id, duplicate: true };
      }
      // 'failed' or 'pending' — previous attempt was rolled back; reuse the document row
      // so the Documents view doesn't accumulate orphan rows for the same file.
      DocumentRepo.updateStatus(existing.id, 'processing', null);
      logger.info(`[doc:${existing.id}] Retrying previously ${existing.status} document`);
      return { id: existing.id, duplicate: false };
    }

    const result = DocumentRepo.insert({
      filename,
      originalName,
      fileType,
      fileSize,
      fileHash,
      metadataJson: JSON.stringify(metadata)
    });

    logAudit("create", "documents", result.lastInsertRowid, null, { filename, originalName });
    return { id: Number(result.lastInsertRowid), duplicate: false };
  });
}

function updateDocumentStatus(docId, status, chunkCount = null) {
  DocumentRepo.updateStatus(docId, status, chunkCount);
}

// ── Stage 1: Validate and parse the source file ───────────────────────────────

export async function stageParseFile(ctx) {
  const { filePath } = ctx;
  logger.info(`Processing document: ${path.basename(filePath)}`);

  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  if (!isSupportedFileType(filePath)) throw new Error(`Unsupported file type: ${path.extname(filePath)}`);

  const { content, metadata } = await parseFile(filePath);
  if (!content || content.trim().length === 0) throw new Error("File contains no extractable text");

  ctx.content = content;
  ctx.fileMetadata = metadata;
  logger.debug("File parsed successfully.");
}

// ── Stage 2: Hash and register the document in the DB ────────────────────────

export function stageRegister(ctx) {
  const { filePath, content: _c, fileMetadata, options } = ctx;
  const fileHash = calculateFileHash(filePath);

  const docResult = registerDocument({
    filename: path.basename(filePath),
    originalName: options.originalName || fileMetadata.filename,
    fileType: fileMetadata.fileType,
    fileSize: fileMetadata.fileSize,
    fileHash,
    metadata: fileMetadata
  });

  ctx.documentId = docResult.id;
  ctx.isDuplicate = docResult.duplicate;

  if (docResult.duplicate) {
    ctx.results.documentId = docResult.id;
    ctx.results.errors.push("Document already exists (duplicate hash)");
    logger.info(`[doc:${docResult.id}] duplicate_detected — existing document reused.`);
  }
}

// ── Stage 3: Extract Knowledge Points from document content ───────────────────

export async function stageExtractKPs(ctx) {
  const { content, fileMetadata, options, documentId } = ctx;
  const { useLLM, jobId } = options;

  ctx.enrichedChunks = []; // ensure downstream never sees undefined on early throw
  ctx.setStep(documentId, "kp_extraction", "Extracting knowledge points…", 25);

  // Use original filename for docTitle (not the temp multer filename)
  const docTitle = options.originalName || fileMetadata.filename;
  const kps = await extractKnowledgePoints(content, docTitle, {
    useLLM,
    authorityLevel: detectAuthorityLevel(content, fileMetadata.filename),
    documentId,
    jobId,
    onProgress: (done, total) => {
      if (total <= 1) return; // single-segment docs don't need intermediate updates
      const pct = 25 + Math.round((done / total) * 38);
      ctx.setStep(documentId, "kp_extraction",
        `Extracting KPs (${done}/${total} segments)…`, pct);
    }
  });

  ctx.results.stats.chunkCount = kps.length;
  ctx.enrichedChunks = kps;

  ctx.setStep(documentId, "kp_extraction", `Extracted ${kps.length} knowledge points.`, 65);
  logger.info(`Extracted ${kps.length} KPs from "${fileMetadata.filename}"`);
}

// ── Stage 4: Map chunks to nodes, generate aliases ───────────────────────────

export async function stageMapChunks(ctx) {
  const { enrichedChunks, documentId, options } = ctx;
  const { targetNodeId, targetSchemaNodeId, useLLM, createNewNodes } = options;

  ctx.setStep(documentId, "mapping_chunks", "Mapping chunks to tree nodes.", 68);

  if (targetNodeId) {
    // All chunks go to the specified node
    for (let i = 0; i < enrichedChunks.length; i++) {
      const chunk = enrichedChunks[i];
      const chunkId = assignChunkToNode(chunk, targetNodeId, documentId);
      ctx.results.chunks.push({ chunkId, nodeId: targetNodeId, index: chunk.index });

      if (i === 0 || (i + 1) % 10 === 0 || i === enrichedChunks.length - 1) {
        const progress = 90 + ((i + 1) / enrichedChunks.length) * 8;
        ctx.setStep(documentId, "mapping_chunks",
          `Mapping (${i + 1}/${enrichedChunks.length}).`, progress);
      }
    }
  } else {
    // Auto-map chunks to the best-fitting nodes
    const mappingMode       = DatasetConfigRepo.get('mapping_mode')       ?? 'free';
    const mappingStrictness = DatasetConfigRepo.get('mapping_strictness') ?? 'soft';
    const mappingResult = await autoMapChunks(enrichedChunks, documentId, { useLLM, createNewNodes, mappingMode, mappingStrictness, targetSchemaNodeId });
    ctx.results.mappings = mappingResult;
    ctx.results.chunks = mappingResult.mapped;
    // Track newly-created node IDs so rollback can clean them up if a later stage fails
    ctx.createdNodeIds = (mappingResult.newNodes || []).map(n => n.node_id);
    ctx.setStep(documentId, "mapping_chunks",
      `Mapped ${mappingResult.mapped.length}/${enrichedChunks.length} chunks.`, 84);

    if (mappingResult.unmapped.length > 0) {
      ctx.results.errors.push(`${mappingResult.unmapped.length} chunks could not be mapped to nodes`);
    }

    // Generate search aliases for newly created nodes (batched, optional)
    if (useLLM && !SKIP_ALIASES && mappingResult.newNodes?.length > 0) {
      ctx.setStep(documentId, "generating_aliases", "Generating search aliases for new nodes.", 95);
      const nodeIds = mappingResult.newNodes.map(n => n.node_id);
      // Batch up to 5 nodes per LLM call
      for (let b = 0; b < nodeIds.length; b += 5) {
        const batch = nodeIds.slice(b, b + 5);
        try {
          await generateAliasesBatch(batch, { maxAliases: 8 });
        } catch (err) {
          logger.warn(`Batch alias generation failed: ${err.message}`);
        }
        if (b + 5 < nodeIds.length) await new Promise(r => setTimeout(r, 100));
      }
    } else if (SKIP_ALIASES && mappingResult.newNodes?.length > 0) {
      logger.info(`Alias generation skipped (INGEST_SKIP_ALIASES=true) for ${mappingResult.newNodes.length} new nodes`);
    }
  }
}

// ── Stage 5: Extract entities and facts from chunks ───────────────────────────
// Controlled by the per-dataset `entity_extraction_enabled` setting.
// When disabled (default), schema and tables are preserved but LLM calls are skipped.

export async function stageExtractEntities(ctx) {
  const { documentId } = ctx;
  const enabled = DatasetConfigRepo.get('entity_extraction_enabled') === 'true';

  if (!enabled) {
    ctx.setStep(documentId, "entity_extraction", "Entity extraction skipped (disabled).", 96);
    ctx.results.stats.entitiesExtracted = 0;
    ctx.results.stats.factsExtracted = 0;
    ctx.results.extraction = { entities: 0, facts: 0, chunks_processed: 0, errors: [] };
    return;
  }

  ctx.setStep(documentId, "entity_extraction", "Extracting entities and facts…", 84);
  logger.info(`[doc:${documentId}] Entity extraction enabled — processing chunks`);

  try {
    const { processDocumentForExtraction } = await import("../../extraction/entityFactExtractor.js");
    const result = await processDocumentForExtraction(documentId, {
      useLLM: true,
      batchSize: 1,
      onProgress: (progress) => {
        ctx.setStep(documentId, "entity_extraction",
          `Extracting entities… ${progress.chunks_processed}/${progress.chunks_total}`,
          84 + Math.floor((progress.chunks_processed / Math.max(1, progress.chunks_total)) * 10)
        );
      }
    });

    ctx.results.stats.entitiesExtracted = result.total_entities || 0;
    ctx.results.stats.factsExtracted = result.total_facts || 0;
    ctx.results.extraction = result;
    logger.info(`[doc:${documentId}] Entity extraction complete: ${result.total_entities} entities, ${result.total_facts} facts`);
    ctx.setStep(documentId, "entity_extraction",
      `Extracted ${result.total_entities} entities, ${result.total_facts} facts.`, 96);
  } catch (err) {
    logger.warn(`[doc:${documentId}] Entity extraction failed (non-fatal): ${err.message}`);
    ctx.setStep(documentId, "entity_extraction", `Entity extraction failed: ${err.message}`, 96);
    ctx.results.stats.entitiesExtracted = 0;
    ctx.results.stats.factsExtracted = 0;
    ctx.results.extraction = { entities: 0, facts: 0, chunks_processed: 0, errors: [err.message] };
  }
}

// ── Stage 5b: Generate node summaries for newly created nodes ─────────────────

export async function stageNodeSummaries(ctx) {
  const { documentId, options } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];

  if (!options.useLLM || !isLlmConfigured() || newNodeIds.length === 0) {
    return; // nothing to summarize
  }

  ctx.setStep(documentId, "node_summaries", "Generating node summaries…", 86);

  let generated = 0;
  for (const nodeId of newNodeIds) {
    const node = NodeRepo.findById(nodeId);
    if (!node || node.node_summary) continue; // skip if already has summary

    const chunks = ChunkRepo.getForNodeLimited(nodeId, 8);
    if (chunks.length === 0) continue;

    const chunkTexts = chunks
      .map(c => (c.content_clean || c.content || '').slice(0, 200))
      .join('\n- ');

    const prompt = getCustomPrompt('node_summary_generation', { node_name: node.name, chunks: chunkTexts })
      ?? `Given a knowledge base node named "${node.name}" containing these knowledge points:\n- ${chunkTexts}\n\nWrite a concise 1-2 sentence summary describing what this node covers. Be specific about the topics and types of information it contains. Return ONLY the summary text, nothing else.`;

    try {
      const summary = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 150, taskName: 'node_summary_generation' });
      if (summary && summary.trim().length > 10) {
        NodeRepo.update(nodeId, { summary: summary.trim() });
        NodeRepo.rebuildFts(nodeId);
        generated++;
      }
    } catch (err) {
      logger.warn(`Node summary generation failed for "${node.name}": ${err.message}`);
    }

    // Small delay between LLM calls to respect rate limits
    if (generated < newNodeIds.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  if (generated > 0) {
    logger.info(`Generated summaries for ${generated}/${newNodeIds.length} new nodes`);
    ctx.setStep(documentId, "node_summaries", `Generated ${generated} node summaries.`, 88);
  }
}

// ── Stage 5b-enrich: Extract structured keywords from chunk content (zero LLM) ─

// Common English stopwords / acronym false-positives to filter out
const ACRONYM_STOP = new Set([
  'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'HAS', 'HIS', 'HOW', 'ITS', 'MAY', 'NEW',
  'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'DID', 'GET', 'HIM', 'LET', 'SAY',
  'SHE', 'TOO', 'USE', 'THIS', 'THAT', 'WITH', 'HAVE', 'FROM', 'THEY',
  'BEEN', 'SAID', 'EACH', 'THAN', 'THEM', 'THEN', 'WHEN', 'WILL', 'INTO',
  'TEXT', 'NULL', 'TRUE', 'ALSO', 'JUST', 'ONLY', 'VERY', 'EVEN', 'MOST',
  'II', 'III', 'IV'
]);

export async function stageEnrichNodeKeywords(ctx) {
  const { documentId } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];

  // Enrich newly created nodes + reused nodes that received chunks from this document.
  const nodeIdsToEnrich = new Set(newNodeIds);
  if (documentId) {
    try {
      for (const c of ChunkRepo.getForDoc(documentId)) {
        if (c.node_id) nodeIdsToEnrich.add(c.node_id);
      }
    } catch { /* non-fatal */ }
  }
  if (nodeIdsToEnrich.size === 0) return;

  ctx.setStep(documentId, "enrich_keywords", "Extracting structured keywords…", 87);

  let enriched = 0;
  for (const nodeId of nodeIdsToEnrich) {
    const result = enrichNodeKeywords(nodeId);
    if (result.added > 0) enriched++;
  }

  if (enriched > 0) {
    logger.info(`Enriched keywords for ${enriched}/${nodeIdsToEnrich.size} nodes`);
  }
}

// ── Stage 5b-quality: Compute heuristic node quality score (zero LLM) ────────

export async function stageComputeNodeQuality(ctx) {
  const { documentId } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];
  if (newNodeIds.length === 0) return;

  ctx.setStep(documentId, "node_quality", "Computing node quality scores…", 87);

  let scored = 0;
  for (const nodeId of newNodeIds) {
    const q = computeNodeQuality(nodeId);
    if (q !== null) scored++;
  }

  if (scored > 0) {
    logger.info(`Computed quality scores for ${scored}/${newNodeIds.length} new nodes`);
  }
}

// ── Stage 5b2: Reclassify "General" KPs to better-matching nodes ─────────────

export async function stageReclassifyGeneral(ctx) {
  const { documentId } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];
  if (newNodeIds.length === 0) return; // no new nodes to reclassify against

  ctx.setStep(documentId, "reclassify_general", "Reclassifying General KPs…", 88);

  try {
    const result = reclassifyGeneralKPs();
    if (result.moved > 0 || result.suggested > 0) {
      logger.info(`Reclassified General KPs: ${result.moved} moved, ${result.suggested} suggestions, ${result.unchanged} unchanged`);
      ctx.setStep(documentId, "reclassify_general",
        `Reclassified ${result.moved} KPs, ${result.suggested} suggestions.`, 89);
    }
  } catch (err) {
    logger.warn(`General reclassification failed (non-fatal): ${err.message}`);
  }
}

// ── Stage 5c: Check for near-duplicate sibling nodes ──────────────────────────

export async function stageTopicCanonicalization(ctx) {
  const { documentId } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];

  if (newNodeIds.length === 0) return;

  ctx.setStep(documentId, "topic_canonicalization", "Checking for duplicate nodes…", 89);

  let queued = 0;
  for (const nodeId of newNodeIds) {
    try {
      const candidates = await findMergeCandidates(nodeId);
      for (const candidate of candidates) {
        // Determine which node has fewer chunks (that one is the merge source)
        const nodeChunks = ChunkRepo.getForNodeLimited(nodeId, 1).length;
        const candidateChunks = ChunkRepo.getForNodeLimited(candidate.nodeId, 1).length;
        const [sourceId, targetId] = nodeChunks <= candidateChunks
          ? [nodeId, candidate.nodeId]
          : [candidate.nodeId, nodeId];

        queueNodeMergeSuggestion(sourceId, targetId, {
          nameSim: candidate.nameSim,
          contentSim: candidate.contentSim,
          reason: candidate.reason
        });
        queued++;
      }
    } catch (err) {
      logger.warn(`Topic canonicalization failed for node ${nodeId}: ${err.message}`);
    }
  }

  if (queued > 0) {
    logger.info(`Queued ${queued} node merge suggestion(s) from topic canonicalization`);
    ctx.setStep(documentId, "topic_canonicalization", `Found ${queued} potential merge(s).`, 90);
  }
}

// ── Stage 5c2: Node consolidation — move outlier chunks, flag mixed nodes ─────
// Controlled by INGEST_NODE_CONSOLIDATION env var:
//   disabled (default) — stage skipped entirely
//   dry_run            — logs what it would do, no actual chunk moves
//   enabled            — moves outlier chunks and queues split suggestions

const NODE_CONSOLIDATION_MODE = (process.env.INGEST_NODE_CONSOLIDATION || 'disabled').toLowerCase();

export async function stageNodeConsolidation(ctx) {
  if (NODE_CONSOLIDATION_MODE === 'disabled') return;

  const { documentId } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];
  if (newNodeIds.length === 0) return;

  const isDryRun = NODE_CONSOLIDATION_MODE === 'dry_run';
  ctx.setStep(documentId, "node_consolidation",
    `${isDryRun ? '[DRY RUN] ' : ''}Consolidating nodes…`, 90);

  let outliersMoved = 0;
  let splitsFlagged = 0;

  for (const nodeId of newNodeIds) {
    const node = NodeRepo.findById(nodeId);
    if (!node) continue;
    if (node.is_schema_node) continue;

    const chunks = ChunkRepo.getForNodeLimited(nodeId, 50);
    if (chunks.length < 5) continue;    // skip small nodes
    if (chunks.length > 50) continue;   // skip huge nodes — flag for manual review

    const nodeText = [node.name, node.node_summary || ''].join(' ').toLowerCase();

    // ── 1. Move outlier chunks ────────────────────────────────────────────
    // Sample up to 8 chunks, check Dice vs node summary+name
    const sample = chunks.slice(0, 8);
    for (const chunk of sample) {
      const content = (chunk.content_clean || '').toLowerCase();
      const diceSim = wordDiceSimilarity(content, nodeText);

      if (diceSim >= 0.15) continue; // not an outlier

      // Check if any sibling node is a better home
      const siblings = node.parent_id
        ? NodeRepo.findSiblings(node.parent_id, nodeId)
        : NodeRepo.findRootSiblings(nodeId);

      let bestSibling = null;
      let bestSibScore = 0;
      for (const sib of siblings.slice(0, 10)) {
        const sibText = [sib.name, sib.node_summary || ''].join(' ').toLowerCase();
        const sibScore = wordDiceSimilarity(content, sibText);
        if (sibScore > bestSibScore) {
          bestSibScore = sibScore;
          bestSibling = sib;
        }
      }

      if (bestSibling && bestSibScore > 0.40) {
        if (isDryRun) {
          logger.info(`[DRY RUN] Would move chunk ${chunk.id} from "${node.name}" to "${bestSibling.name}" (dice=${bestSibScore.toFixed(2)})`);
        } else {
          ChunkRepo.moveToNode(chunk.id, bestSibling.node_id);
          NodeRepo.touch(bestSibling.node_id);
          logAudit("consolidation_move", "chunks", chunk.id, { from_node: nodeId }, { to_node: bestSibling.node_id, dice: bestSibScore });
        }
        outliersMoved++;
      }
    }

    // ── 2. Flag oversized mixed nodes ─────────────────────────────────────
    // Only check nodes with >20 chunks; sample 10 random pairs for Dice avg
    if (chunks.length > 20) {
      let totalDice = 0;
      let pairs = 0;
      const sampleSize = Math.min(chunks.length, 10);
      for (let i = 0; i < sampleSize && pairs < 10; i++) {
        const j = (i + 1) % sampleSize;
        if (i === j) continue;
        totalDice += wordDiceSimilarity(
          (chunks[i].content_clean || '').toLowerCase(),
          (chunks[j].content_clean || '').toLowerCase()
        );
        pairs++;
      }
      const avgDice = pairs > 0 ? totalDice / pairs : 0;

      if (avgDice < 0.30) {
        if (isDryRun) {
          logger.info(`[DRY RUN] Would flag node "${node.name}" (${chunks.length} chunks, avg dice=${avgDice.toFixed(2)}) for split`);
        } else {
          DecisionRepo.insert({
            action: 'node_split_suggestion',
            node_id: nodeId,
            confidence: 1 - avgDice,
            reason: `Node "${node.name}" has ${chunks.length} chunks with low internal coherence (avg dice=${avgDice.toFixed(2)})`
          });
        }
        splitsFlagged++;
      }
    }
  }

  if (outliersMoved > 0 || splitsFlagged > 0) {
    const prefix = isDryRun ? '[DRY RUN] ' : '';
    logger.info(`${prefix}Node consolidation: ${outliersMoved} outlier chunks moved, ${splitsFlagged} split suggestions`);
    ctx.setStep(documentId, "node_consolidation",
      `${prefix}${outliersMoved} outliers moved, ${splitsFlagged} splits flagged.`, 91);
  }
}

// ── Stage 5c3: Node splitting — break oversized nodes into keyword clusters ───

const NODE_SPLIT_MODE = (process.env.INGEST_NODE_SPLIT || 'disabled').toLowerCase();

export async function stageNodeSplitting(ctx) {
  if (NODE_SPLIT_MODE === 'disabled') return;

  const { documentId } = ctx;
  const newNodeIds = ctx.createdNodeIds || [];
  if (newNodeIds.length === 0) return;

  const isDryRun = NODE_SPLIT_MODE === 'dry_run';
  ctx.setStep(documentId, "node_splitting",
    `${isDryRun ? '[DRY RUN] ' : ''}Splitting oversized nodes…`, 92);

  const candidates = findSplitCandidates(newNodeIds);
  let splitCount = 0;

  for (const { nodeId, name, chunkCount } of candidates) {
    const chunks = ChunkRepo.getForNodeFull(nodeId, 100);
    const targetClusters = Math.min(5, Math.max(3, Math.ceil(chunkCount / 10)));
    const clusters = clusterChunksByKeywords(chunks, targetClusters);

    if (!clusters) {
      logger.info(`Node "${name}" (${chunkCount} chunks): clustering returned null, skipping split`);
      continue;
    }

    if (isDryRun) {
      logger.info(`[DRY RUN] Would split "${name}" (${chunkCount} chunks) into ${clusters.length} clusters:`);
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        const kws = c.seed ? [...c.seed.kws].slice(0, 5).join(', ') : 'misc';
        logger.info(`  Cluster ${i + 1}: ${c.chunks.length} chunks (seeds: ${kws})`);
      }
    } else {
      const result = executeSplit(nodeId, clusters);
      // Append new child IDs so downstream stages (embedding sync, finalize) see them
      ctx.createdNodeIds.push(...result.childNodeIds);
      splitCount++;
    }
  }

  if (splitCount > 0 || (isDryRun && candidates.length > 0)) {
    const prefix = isDryRun ? '[DRY RUN] ' : '';
    logger.info(`${prefix}Node splitting: ${isDryRun ? candidates.length + ' candidates found' : splitCount + ' nodes split'}`);
  }
}

// ── Stage 5d: Orphan node cleanup — merge tiny nodes into parent ──────────────
// Only runs when INGEST_ORPHAN_CLEANUP=true (disabled by default to avoid
// premature deletion during multi-document batch ingestion).

const ORPHAN_CLEANUP_ENABLED = process.env.INGEST_ORPHAN_CLEANUP === 'true';

export async function stageOrphanCleanup(ctx) {
  const { documentId } = ctx;

  if (!ORPHAN_CLEANUP_ENABLED) return;

  ctx.setStep(documentId, "orphan_cleanup", "Checking for orphan nodes…", 91);

  try {
    const allNodes = NodeRepo.getAllSortedByLevel();
    let cleaned = 0;

    // Process deepest nodes first (reverse level order)
    const sortedByDepth = [...allNodes].sort((a, b) => b.level - a.level);

    for (const node of sortedByDepth) {
      // Never touch root nodes, schema nodes, or the root node itself
      if (!node.parent_id || node.is_schema_node || node.node_id === 'root') continue;

      const chunks = ChunkRepo.getForNodeLimited(node.node_id, 2);
      if (chunks.length >= 2) continue; // has enough content

      // Check if this node has children — if so, don't merge
      const children = NodeRepo.findByParent(node.node_id);
      if (children.length > 0) continue;

      // Node has 0-1 chunks and no children — merge into parent
      const parent = NodeRepo.findById(node.parent_id);
      if (!parent) continue;

      if (chunks.length > 0) {
        // Move chunk(s) to parent, then delete node
        const { executeMerge } = await import("../nodeMerger.js");
        executeMerge(node.node_id, node.parent_id);
      } else {
        // Empty node — just delete
        NodeRepo.deleteNode(node.node_id);
      }
      cleaned++;
    }

    if (cleaned > 0) {
      logger.info(`Orphan cleanup: merged/deleted ${cleaned} sparse node(s)`);
      ctx.setStep(documentId, "orphan_cleanup", `Cleaned up ${cleaned} sparse node(s).`, 92);
    }
  } catch (err) {
    logger.warn(`Orphan node cleanup failed (non-fatal): ${err.message}`);
  }
}

// ── Stage 6: Auto-generate embeddings ────────────────────────────────────────
// NOTE: This stage is NOT in the per-document STAGES array in index.js.
// Embedding sync runs once after the entire batch completes via
// runPostIngestEmbeddingSync() in the pipeline runner, avoiding redundant
// per-document syncs during multi-document batch ingestion.

export async function stageEmbeddingSync(ctx) {
  const { documentId } = ctx;

  if (!AUTO_EMBED || process.env.DISABLE_EMBEDDINGS === "true") {
    ctx.setStep(documentId, "embedding_sync", "Auto-embedding skipped.", 98);
    return;
  }

  ctx.setStep(documentId, "embedding_sync", "Generating embeddings…", 96);

  try {
    const result = await syncEmbeddings();
    invalidateVectorCache();
    const n = result.nodes?.success || 0;
    const c = result.chunks?.success || 0;
    ctx.setStep(documentId, "embedding_sync", `Embedded ${n} nodes, ${c} chunks.`, 98);
    ctx.results.stats.embeddingsGenerated = n + c;
  } catch (err) {
    logger.warn(`[embedding_sync] Failed for doc ${documentId}: ${err.message}`);
    ctx.setStep(documentId, "embedding_sync", `Embedding sync failed (non-fatal): ${err.message}`, 98);
    ctx.results.stats.embeddingsGenerated = 0;
  }
}

// ── Stage 7: Mark document as processed ──────────────────────────────────────

export function stageFinalize(ctx) {
  const { documentId, results } = ctx;
  ctx.setStep(documentId, "finalizing", "Finalizing document processing.", 99);
  updateDocumentStatus(documentId, "processed", results.chunks.length);

  // Record ingestion metrics for the learning system
  try {
    // Derive metrics from available ctx data (not all stats are tracked inline)
    const mappedChunks = results.chunks?.length ?? 0;
    const newNodeCount = (ctx.createdNodeIds || []).length;

    // Count decisions created during this document's ingestion
    let decisionsCreated = 0;
    try {
      const decRows = db.prepare(`
        SELECT COUNT(*) as c FROM pending_decisions
        WHERE incoming_chunk_id IN (
          SELECT id FROM chunks WHERE document_id = ?
        )
      `).get(documentId);
      decisionsCreated = decRows?.c ?? 0;
    } catch (_) { /* table may not have data yet */ }

    recordIngestionMetrics(documentId, {
      kpCount: mappedChunks,
      avgKpConfidence: results.stats?.avgKpConfidence ?? 0,
      decisionsCreated,
      autoResolvedCount: 0, // auto-resolve happens inline; not tracked per-doc yet
      newNodeCount
    });
  } catch (_) { /* non-fatal */ }

  ctx.setStep(documentId, "completed", "Document processed successfully.", 100, "processed");
}

// Re-export updateDocumentStatus so the pipeline runner can call it on failure
export { updateDocumentStatus };
