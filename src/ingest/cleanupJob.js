/**
 * KP Cleanup Job
 *
 * Re-evaluates existing Knowledge Point chunks in batches against the
 * decision engine. Designed for background / scheduled / manual invocation.
 *
 * - MERGE auto → executed immediately (source_documents_json updated)
 * - REPLACE auto → chunk superseded
 * - IGNORE auto → chunk status set to 'ignored'
 * - Borderline MERGE / REPLACE → queued as pending_decisions
 * - STORE / NORMALIZE → no change (KP already stored)
 *
 * Pass dryRun: true to get a preview without modifying any data.
 */

import { db } from "../db/db.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { DecisionRepo } from "../db/repositories/DecisionRepo.js";
import { resolveKPAction } from "./kpDecisionEngine.js";
import { findMergeCandidates, queueNodeMergeSuggestion } from "./nodeMerger.js";
import { ingestLogger as logger } from "../utils/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getKPChunkPage(offset, limit) {
  return db.prepare(`
    SELECT id, content_clean, node_id, document_id, authority_level,
           kp_type, source_excerpt, source_documents_json, confidence
    FROM chunks
    WHERE status = 'active' AND kp_type != 'legacy_chunk'
    ORDER BY id ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function chunkToKPShape(row) {
  return {
    content:              row.content_clean || "",
    authority_level:      row.authority_level || "sop",
    kp_type:              row.kp_type || "fact",
    source_excerpt:       row.source_excerpt || "",
    source_documents_json: row.source_documents_json || "[]",
    confidence:           row.confidence ?? 0.8,
    doc_title:            null,
    keywords:             [],
    index:                row.id
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run the cleanup job.
 *
 * @param {object} options
 * @param {number}  options.batchSize   Number of chunks per batch (default: 100)
 * @param {number}  options.maxBatches  Maximum batches to process (default: 50)
 * @param {boolean} options.useLLM      Whether to use LLM for normalization (default: true)
 * @param {boolean} options.dryRun      If true, compute decisions but apply nothing (default: false)
 * @param {boolean} options.includeNodeMerge  Check for node-level merge candidates (default: true)
 *
 * @returns {Promise<{
 *   batches_processed: number,
 *   chunks_scanned: number,
 *   decisions: { ignored, merged, replaced, queued, unchanged },
 *   node_merge_suggestions: number,
 *   dry_run: boolean
 * }>}
 */
export async function runCleanupJob(options = {}) {
  const {
    batchSize       = 100,
    maxBatches      = 50,
    useLLM          = true,
    dryRun          = false,
    includeNodeMerge = true
  } = options;

  const stats = {
    batches_processed:     0,
    chunks_scanned:        0,
    decisions:             { ignored: 0, merged: 0, replaced: 0, queued: 0, unchanged: 0 },
    node_merge_suggestions: 0,
    dry_run:               dryRun
  };

  logger.info(`KP cleanup job started (batchSize=${batchSize}, maxBatches=${maxBatches}, dryRun=${dryRun})`);

  let offset = 0;
  const seenNodeIds = new Set();

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = getKPChunkPage(offset, batchSize);
    if (rows.length === 0) break;

    stats.batches_processed++;
    stats.chunks_scanned += rows.length;

    for (const row of rows) {
      const kp = chunkToKPShape(row);

      let decision;
      try {
        decision = await resolveKPAction(kp, row.node_id, row.document_id, {
          useLLM,
          excludeChunkId: row.id   // don't match the chunk against itself
        });
      } catch (err) {
        logger.warn(`cleanupJob: resolveKPAction failed for chunk ${row.id}: ${err.message}`);
        stats.decisions.unchanged++;
        continue;
      }

      if (dryRun) {
        // Tally only — no DB writes
        switch (decision.action) {
          case "IGNORE":                stats.decisions.ignored++;   break;
          case "MERGE":                 stats.decisions.merged++;    break;
          case "REPLACE":               stats.decisions.replaced++;  break;
          case "NORMALIZE_THEN_STORE":
          case "STORE":
            if (decision.queued) stats.decisions.queued++;
            else                 stats.decisions.unchanged++;
            break;
          default:                      stats.decisions.unchanged++;
        }
        continue;
      }

      // Apply decisions
      switch (decision.action) {
        case "IGNORE":
          db.prepare("UPDATE chunks SET status = 'ignored' WHERE id = ?").run(row.id);
          stats.decisions.ignored++;
          break;

        case "MERGE":
          // Already applied inside resolveKPAction (source_documents_json updated)
          // Mark this row as superseded by the merged-into chunk
          if (decision.chunkId && decision.chunkId !== row.id) {
            ChunkRepo.supersede(row.id, decision.chunkId);
          }
          DecisionRepo.insert({
            action:           "auto_resolved",
            status:           "auto_resolved",
            incoming_chunk_id: row.id,
            target_chunk_id:   decision.chunkId,
            node_id:           row.node_id,
            similarity_score:  null,
            reason:            decision.reason,
            incoming_preview:  kp.content,
            target_preview:    null
          }).toString();  // discard result
          stats.decisions.merged++;
          break;

        case "REPLACE":
          if (decision.chunkId) {
            ChunkRepo.supersede(decision.chunkId, row.id);
          }
          stats.decisions.replaced++;
          break;

        case "NORMALIZE_THEN_STORE":
        case "STORE":
          if (decision.queued) stats.decisions.queued++;
          else                 stats.decisions.unchanged++;
          break;

        default:
          stats.decisions.unchanged++;
      }

      seenNodeIds.add(row.node_id);
    }

    offset += rows.length;

    logger.info(`cleanupJob batch ${batch + 1}: ${rows.length} chunks processed (total=${stats.chunks_scanned})`);
    await new Promise(r => setTimeout(r, 50)); // yield between batches
  }

  // ── Node-level merge candidates ───────────────────────────────────────────
  if (includeNodeMerge && !dryRun) {
    for (const nodeId of seenNodeIds) {
      const candidates = await findMergeCandidates(nodeId, { useLLM: false });
      for (const cand of candidates) {
        try {
          queueNodeMergeSuggestion(nodeId, cand.nodeId, cand);
          stats.node_merge_suggestions++;
        } catch (err) {
          logger.warn(`cleanupJob: queueNodeMergeSuggestion failed: ${err.message}`);
        }
      }
    }
  }

  logger.info(`KP cleanup job complete: ${JSON.stringify(stats)}`);
  return stats;
}
