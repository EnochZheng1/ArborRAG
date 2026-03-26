/**
 * Node splitting — breaks oversized nodes into keyword-clustered sub-nodes.
 *
 * Keeps the parent as a structural container (0 direct chunks).
 * Each child gets bootstrapped with keywords, minimal summary, quality score.
 * No LLM calls — pure keyword-based clustering.
 */

import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { runTransaction, logAudit, safeJson } from "../db/db.js";
import { enrichNodeKeywords, computeNodeQuality } from "./nodeEnrichment.js";
import { generateNodeId } from "./nodeHierarchy.js";
import { ingestLogger as logger } from "../utils/logger.js";

// ── Constants ────────────────────────────────────────────────────────────────
const MIN_CHUNKS_TO_SPLIT = 25;
const MIN_CLUSTER_SIM = 0.08;  // must be very low — diverse multi-topic nodes have near-zero keyword overlap
const MAX_MISC_RATIO = 0.40;   // abort if more than 40% of chunks are unassignable

const CLUSTER_STOP_KEYWORDS = new Set([
  'general', 'information', 'document', 'content', 'section', 'overview',
  'description', 'details', 'summary', 'note', 'notes', 'introduction',
  'chapter', 'part', 'page', 'item', 'list', 'table', 'figure', 'appendix'
]);

// ── Keyword Set Dice Similarity ──────────────────────────────────────────────

function keywordSetDice(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const k of setA) { if (setB.has(k)) intersection++; }
  return (2 * intersection) / (setA.size + setB.size);
}

// ── Clustering ───────────────────────────────────────────────────────────────

export function clusterChunksByKeywords(chunks, targetClusters = 3) {
  // Pre-process: clean keywords
  const parsed = chunks.map(c => {
    const raw = safeJson(c.keywords_json, []);
    const cleaned = raw
      .map(k => String(k).toLowerCase().trim())
      .filter(k => k.length >= 2 && !CLUSTER_STOP_KEYWORDS.has(k));
    return { ...c, kws: new Set(cleaned) };
  });

  const withKws = parsed.filter(c => c.kws.size > 0);
  const misc = parsed.filter(c => c.kws.size === 0);

  if (withKws.length < targetClusters * 2) return null;

  // Seed selection: first by richness, then by diversity
  const sorted = [...withKws].sort((a, b) => b.kws.size - a.kws.size);
  const seeds = [sorted[0]];
  for (let s = 1; s < targetClusters && s < sorted.length; s++) {
    let bestCandidate = null, lowestMaxSim = Infinity;
    for (const candidate of sorted) {
      if (seeds.some(sd => sd.id === candidate.id)) continue;
      const maxSim = Math.max(...seeds.map(sd => keywordSetDice(candidate.kws, sd.kws)));
      if (maxSim < lowestMaxSim) { lowestMaxSim = maxSim; bestCandidate = candidate; }
    }
    if (bestCandidate) seeds.push(bestCandidate);
  }

  const clusters = seeds.map(s => ({ seed: s, chunks: [s] }));
  const assigned = new Set(seeds.map(s => s.id));

  // Assign with min similarity threshold
  for (const chunk of withKws) {
    if (assigned.has(chunk.id)) continue;
    let bestIdx = -1, bestSim = -1;
    for (let i = 0; i < clusters.length; i++) {
      const sim = keywordSetDice(chunk.kws, clusters[i].seed.kws);
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    if (bestSim >= MIN_CLUSTER_SIM) {
      clusters[bestIdx].chunks.push(chunk);
    } else {
      misc.push(chunk);
    }
    assigned.add(chunk.id);
  }

  // Second pass: try to assign misc chunks by content similarity to cluster content
  // (not just seed keywords). Uses aggregated keyword pool of each cluster.
  if (misc.length > 0) {
    const clusterKwPools = clusters.map(c => {
      const pool = new Set();
      for (const ch of c.chunks) { for (const kw of ch.kws) pool.add(kw); }
      return pool;
    });

    const stillMisc = [];
    for (const chunk of misc) {
      let bestIdx = -1, bestSim = -1;
      for (let i = 0; i < clusters.length; i++) {
        const sim = keywordSetDice(chunk.kws, clusterKwPools[i]);
        if (sim > bestSim) { bestSim = sim; bestIdx = i; }
      }
      if (bestSim > 0) {
        clusters[bestIdx].chunks.push(chunk);
        // Update pool
        for (const kw of chunk.kws) clusterKwPools[bestIdx].add(kw);
      } else {
        stillMisc.push(chunk);
      }
    }
    misc.length = 0;
    misc.push(...stillMisc);
  }

  // Post-validation: merge tiny clusters into nearest
  for (let i = clusters.length - 1; i >= 0; i--) {
    if (clusters[i].chunks.length < 3 && clusters.length > 1) {
      let nearestIdx = -1, nearestSim = -1;
      for (let j = 0; j < clusters.length; j++) {
        if (i === j) continue;
        const sim = keywordSetDice(clusters[i].seed.kws, clusters[j].seed.kws);
        if (sim > nearestSim) { nearestSim = sim; nearestIdx = j; }
      }
      if (nearestIdx >= 0) {
        clusters[nearestIdx].chunks.push(...clusters[i].chunks);
        clusters.splice(i, 1);
      }
    }
  }

  // Add misc cluster if non-empty
  if (misc.length > 0) clusters.push({ seed: null, chunks: misc });

  // Abort if misc dominates or only 1 cluster
  if (clusters.length < 2) return null;
  const miscCluster = clusters.find(c => c.seed === null);
  if (miscCluster && miscCluster.chunks.length > chunks.length * MAX_MISC_RATIO) return null;

  return clusters;
}

// ── Cluster Naming ───────────────────────────────────────────────────────────

export function generateClusterName(parentName, cluster, index, siblingNames) {
  const nameSet = new Set(siblingNames.map(n => n.toLowerCase()));

  if (cluster.seed) {
    const kwFreq = new Map();
    for (const chunk of cluster.chunks) {
      for (const kw of safeJson(chunk.keywords_json, [])) {
        const k = String(kw).toLowerCase();
        if (!CLUSTER_STOP_KEYWORDS.has(k)) kwFreq.set(k, (kwFreq.get(k) || 0) + 1);
      }
    }
    const topKws = [...kwFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k.charAt(0).toUpperCase() + k.slice(1));

    let candidate = topKws.length > 0
      ? `${parentName} — ${topKws.join(' & ')}`
      : `${parentName} — Group ${index + 1}`;

    let attempt = 0;
    while (nameSet.has(candidate.toLowerCase())) {
      attempt++;
      candidate = topKws.length > 0
        ? `${parentName} — ${topKws.join(' & ')} (${attempt})`
        : `${parentName} — Group ${index + 1} (${attempt})`;
    }
    return candidate.slice(0, 80);
  }

  let misc = `${parentName} — Misc`;
  let attempt = 0;
  while (nameSet.has(misc.toLowerCase())) {
    attempt++;
    misc = `${parentName} — Misc (${attempt})`;
  }
  return misc.slice(0, 80);
}

// ── Split Execution ──────────────────────────────────────────────────────────

export function executeSplit(sourceNodeId, clusters) {
  return runTransaction(() => {
    const sourceNode = NodeRepo.findById(sourceNodeId);
    if (!sourceNode) throw new Error(`Node ${sourceNodeId} not found`);

    // Get existing sibling names for collision avoidance
    const siblings = sourceNode.parent_id
      ? NodeRepo.findByParent(sourceNode.parent_id)
      : NodeRepo.findRoots();
    const siblingNames = siblings.map(s => s.name);

    const childNodeIds = [];

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const childName = generateClusterName(sourceNode.name, cluster, i, siblingNames);
      const childId = generateNodeId(childName);

      // Minimal summary from keywords + first chunk preview
      const topKws = cluster.seed ? [...cluster.seed.kws].slice(0, 5) : [];
      const firstChunk = cluster.chunks[0];
      const preview = (firstChunk?.content_clean || '').slice(0, 100).replace(/\n/g, ' ');
      const summary = topKws.length > 0
        ? `Covers: ${topKws.join(', ')}. ${preview}`
        : preview;

      // Create child node
      NodeRepo.insert({
        node_id: childId,
        name: childName,
        parent_id: sourceNodeId,
        level: sourceNode.level + 1,
        node_summary: summary.slice(0, 300)
      });

      // Move chunks
      for (const chunk of cluster.chunks) {
        ChunkRepo.moveToNode(chunk.id, childId);
      }

      // Bootstrap keywords via shared helper (no pipeline context needed)
      enrichNodeKeywords(childId);

      // Rebuild FTS after metadata bootstrap
      NodeRepo.rebuildFts(childId);

      // Compute quality
      computeNodeQuality(childId);

      // Track for collision avoidance in subsequent iterations
      siblingNames.push(childName);
      childNodeIds.push(childId);
    }

    // Rebuild parent FTS (now a container, reflects its own metadata)
    NodeRepo.rebuildFts(sourceNodeId);

    // Recompute parent quality (will drop — 0 chunks expected)
    computeNodeQuality(sourceNodeId);

    logAudit('node_split', 'nodes', sourceNodeId, null, {
      child_nodes: childNodeIds,
      cluster_count: clusters.length,
      chunks_moved: clusters.reduce((s, c) => s + c.chunks.length, 0)
    });

    logger.info(`Split node "${sourceNode.name}" (${sourceNodeId}) into ${clusters.length} children: ${childNodeIds.join(', ')}`);

    return { childNodeIds, clusterCount: clusters.length };
  });
}

// ── Candidate Detection ──────────────────────────────────────────────────────

export function findSplitCandidates(nodeIds = null) {
  const nodes = nodeIds
    ? nodeIds.map(id => NodeRepo.findById(id)).filter(Boolean)
    : NodeRepo.getAllSortedByLevel();

  const candidates = [];
  for (const node of nodes) {
    if (node.is_schema_node) continue;
    const count = ChunkRepo.countForNode(node.node_id);
    if (count > MIN_CHUNKS_TO_SPLIT) {
      candidates.push({ nodeId: node.node_id, name: node.name, chunkCount: count });
    }
  }
  return candidates;
}
