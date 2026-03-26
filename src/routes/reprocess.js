/**
 * Reprocess route — refresh node metadata without re-ingestion.
 *
 * POST /reprocess
 *   ?reembed=true   — delete + re-generate node embeddings
 *   ?summaries=true  — re-generate node summaries via LLM
 */

import express from "express";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { EmbeddingRepo } from "../db/repositories/EmbeddingRepo.js";
import { enrichNodeKeywords, computeNodeQuality } from "../ingest/nodeEnrichment.js";
import { syncEmbeddings } from "../embedding/chunkEmbeddings.js";
import { invalidateVectorCache } from "../kg/vectorTreeRouter.js";
import { callLLM, isLlmConfigured } from "../utils/llm.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { getCustomPrompt } from "../prompts/promptManager.js";
import { findSplitCandidates, clusterChunksByKeywords, executeSplit } from "../ingest/nodeSplitter.js";
import { ingestLogger as logger } from "../utils/logger.js";

const router = express.Router();

router.post("/reprocess", async (req, res) => {
  const reembed = req.query.reembed === "true";
  const summaries = req.query.summaries === "true";
  const split = req.query.split === "true";
  const startTime = Date.now();

  try {
    let nodesSplit = 0;

    // Phase 0: Split oversized nodes FIRST (before taking allNodes snapshot)
    if (split) {
      const candidates = findSplitCandidates();
      logger.info(`Reprocess split: found ${candidates.length} candidates`);
      for (const c of candidates) logger.info(`  Candidate: "${c.name}" (${c.chunkCount} chunks)`);
      for (const { nodeId, name, chunkCount } of candidates) {
        const chunks = ChunkRepo.getForNodeFull(nodeId, 100);
        const targetClusters = Math.min(7, Math.max(3, Math.ceil(chunkCount / 8)));
        const clusters = clusterChunksByKeywords(chunks, targetClusters);
        logger.info(`  clusterChunksByKeywords returned: ${clusters ? clusters.length + ' clusters' : 'null (split aborted)'}`);
        if (clusters) {
          logger.info(`  Clustering produced ${clusters.length} clusters: ${clusters.map(c => c.chunks.length + ' chunks').join(', ')}`);
          executeSplit(nodeId, clusters);
          nodesSplit++;
          logger.info(`Reprocess: split "${name}" (${chunkCount} chunks) into ${clusters.length} children`);
        }
      }
    }

    // Take snapshot AFTER splits so new children are included
    const allNodes = NodeRepo.getAllSortedByLevel();
    const total = allNodes.length;

    let keywordsAdded = 0;
    let qualityScored = 0;
    let summariesGenerated = 0;
    let ftsRebuilt = 0;
    let embeddingsRefreshed = 0;

    logger.info(`Reprocessing ${total} nodes (reembed=${reembed}, summaries=${summaries})`);

    // Phase 1: Keywords + Quality
    for (const node of allNodes) {
      // Keywords
      const kwResult = enrichNodeKeywords(node.node_id);
      if (kwResult.added > 0) keywordsAdded += kwResult.added;

      // Quality score
      const q = computeNodeQuality(node.node_id);
      if (q !== null) qualityScored++;

      ftsRebuilt++; // enrichNodeKeywords already rebuilds FTS
    }

    // Phase 2: Summaries (optional, LLM)
    if (summaries && isLlmConfigured()) {
      for (const node of allNodes) {
        if (node.node_summary && node.node_summary.trim().length > 20) continue; // skip if already has good summary

        const chunks = ChunkRepo.getForNodeLimited(node.node_id, 8);
        if (chunks.length === 0) continue;

        const chunkTexts = chunks
          .map(c => (c.content_clean || c.content || '').slice(0, 350))
          .join('\n- ');

        const prompt = getCustomPrompt('node_summary_generation', { node_name: node.name, chunks: chunkTexts })
          ?? `Given a knowledge base node named "${node.name}" containing these knowledge points:\n- ${chunkTexts}\n\nWrite a 2-3 sentence summary optimized for search retrieval. Include specific entities, numeric thresholds, proper nouns, and domain terminology. Return ONLY the summary text.`;

        try {
          const summary = await callLLM({ prompt, temperature: 0.0, seed: 42, maxOutputTokens: 200, taskName: 'node_summary_generation' });
          if (summary && summary.trim().length > 10) {
            NodeRepo.update(node.node_id, { summary: summary.trim() });
            NodeRepo.rebuildFts(node.node_id);
            summariesGenerated++;
          }
        } catch (err) {
          logger.warn(`Summary generation failed for "${node.name}": ${err.message}`);
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Phase 3: Embedding refresh (optional)
    if (reembed) {
      // Delete existing node embeddings so syncEmbeddings will re-generate them
      const deleted = EmbeddingRepo.deleteAllByType('node');
      logger.info(`Deleted ${deleted.changes || 0} existing node embeddings for re-generation`);

      // Sync will now re-embed all nodes with enriched text (name + summary + keywords + description)
      const syncResult = await syncEmbeddings();
      embeddingsRefreshed = syncResult?.nodes?.success || 0;

      // Clear stale in-memory vector cache
      invalidateVectorCache();
      logger.info(`Refreshed ${embeddingsRefreshed} node embeddings, vector cache invalidated`);
    }

    const duration = Date.now() - startTime;
    logger.info(`Reprocess complete: ${total} nodes, ${keywordsAdded} keywords added, ${qualityScored} quality scores, ${summariesGenerated} summaries, ${embeddingsRefreshed} embeddings refreshed (${duration}ms)`);

    res.json({
      success: true,
      nodes_processed: total,
      nodes_split: nodesSplit,
      keywords_added: keywordsAdded,
      quality_scores_set: qualityScored,
      summaries_generated: summariesGenerated,
      fts_rebuilt: ftsRebuilt,
      embeddings_refreshed: embeddingsRefreshed,
      duration_ms: duration
    });

  } catch (err) {
    logger.error("Reprocess failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
