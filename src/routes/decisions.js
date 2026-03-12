/**
 * Decisions API — manage pending_decisions from the KP Decision Engine.
 *
 * GET    /decisions             — list (filterable by ?status=pending|accepted|rejected)
 * GET    /decisions/stats       — count per status
 * GET    /decisions/:id         — single decision by id
 * POST   /decisions/:id/accept  — apply and mark accepted
 * POST   /decisions/:id/reject  — mark rejected (no data change)
 * POST   /decisions/cleanup     — run background cleanup job
 * GET    /decisions/cleanup/dry-run — dry-run preview (no writes)
 */

import express from "express";
import { DecisionRepo } from "../db/repositories/DecisionRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { executeMerge } from "../ingest/nodeMerger.js";
import { apiLogger as logger } from "../utils/logger.js";

const router = express.Router();

// ── List ──────────────────────────────────────────────────────────────────────

router.get("/decisions", (req, res) => {
  try {
    const { status, action, limit = "50", offset = "0" } = req.query;
    const decisions = DecisionRepo.getAll({
      status: status || null,
      action: action || null,
      limit:  Math.min(200, Math.max(1, parseInt(limit, 10) || 50)),
      offset: Math.max(0, parseInt(offset, 10) || 0)
    });
    res.json({ decisions });
  } catch (err) {
    logger.error("GET /decisions error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stats (must come before /:id) ─────────────────────────────────────────────

router.get("/decisions/stats", (req, res) => {
  try {
    const stats = DecisionRepo.countByStatus();
    stats.by_action = DecisionRepo.countPendingByAction();
    res.json(stats);
  } catch (err) {
    logger.error("GET /decisions/stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk reject by action type ────────────────────────────────────────────────

router.post("/decisions/bulk-reject", (req, res) => {
  try {
    const { action } = req.body || {};
    if (!action) return res.status(400).json({ error: "action is required" });
    const rejected = DecisionRepo.bulkRejectByAction(action);
    res.json({ success: true, rejected });
  } catch (err) {
    logger.error("POST /decisions/bulk-reject error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cleanup dry-run (disabled) ────────────────────────────────────────────────

router.get("/decisions/cleanup/dry-run", (_req, res) => {
  res.status(410).json({ error: "Cleanup job has been removed" });
});

// ── Single decision ───────────────────────────────────────────────────────────

router.get("/decisions/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const decision = DecisionRepo.getById(id);
    if (!decision) return res.status(404).json({ error: "Decision not found" });
    res.json(decision);
  } catch (err) {
    logger.error("GET /decisions/:id error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Accept ────────────────────────────────────────────────────────────────────

router.post("/decisions/:id/accept", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const decision = DecisionRepo.getById(id);
    if (!decision) return res.status(404).json({ error: "Decision not found" });
    if (decision.status !== "pending") {
      return res.status(400).json({ error: `Decision is already ${decision.status}` });
    }

    let actionResult = {};

    switch (decision.action) {
      case "merge_suggestion": {
        // Merge: update source_documents_json of target chunk
        if (!decision.incoming_chunk_id || !decision.target_chunk_id) {
          return res.status(422).json({ error: "Decision is missing chunk references" });
        }
        const incoming = ChunkRepo.getById(decision.incoming_chunk_id);
        const target   = ChunkRepo.getById(decision.target_chunk_id);
        if (!incoming || !target) {
          return res.status(409).json({
            error: "One or both referenced chunks no longer exist — decision cannot be applied",
            missing: [!incoming && decision.incoming_chunk_id, !target && decision.target_chunk_id].filter(Boolean)
          });
        }
        const existingDocs = safeJson(target.source_documents_json, []);
        const incomingDocs = safeJson(incoming.source_documents_json, []);
        const merged = mergeSourceDocs(existingDocs, incomingDocs);
        ChunkRepo.updateSourceDocuments(decision.target_chunk_id, JSON.stringify(merged));
        ChunkRepo.supersede(decision.incoming_chunk_id, decision.target_chunk_id);
        actionResult = { merged: true, target_chunk_id: decision.target_chunk_id };
        break;
      }

      case "replace_suggestion": {
        // Replace: supersede target with incoming
        if (!decision.incoming_chunk_id || !decision.target_chunk_id) {
          return res.status(422).json({ error: "Decision is missing chunk references" });
        }
        const incomingChunk = ChunkRepo.getById(decision.incoming_chunk_id);
        const targetChunk   = ChunkRepo.getById(decision.target_chunk_id);
        if (!incomingChunk || !targetChunk) {
          return res.status(409).json({
            error: "One or both referenced chunks no longer exist — decision cannot be applied",
            missing: [!incomingChunk && decision.incoming_chunk_id, !targetChunk && decision.target_chunk_id].filter(Boolean)
          });
        }
        ChunkRepo.supersede(decision.target_chunk_id, decision.incoming_chunk_id);
        actionResult = { replaced: true, superseded_chunk_id: decision.target_chunk_id };
        break;
      }

      case "node_merge_suggestion": {
        // Node merge: move chunks from source node to target node
        // incoming_preview contains "node:<sourceId> ..."
        const match = String(decision.incoming_preview || "").match(/^node:(\S+)/);
        const sourceNodeId = match?.[1];
        const targetNodeId = decision.node_id;
        if (!sourceNodeId || !targetNodeId) {
          return res.status(422).json({ error: "Decision is missing node references" });
        }
        const result = executeMerge(sourceNodeId, targetNodeId);
        actionResult = { nodesMerged: true, ...result };
        break;
      }

      case "value_conflict": {
        const { resolution } = req.body || {};
        if (!resolution || !["keep_incoming", "keep_existing", "keep_both"].includes(resolution)) {
          return res.status(400).json({ error: "resolution must be keep_incoming, keep_existing, or keep_both" });
        }
        if (resolution === "keep_both") {
          // Both chunks stay as-is
          actionResult = { kept: "both" };
        } else if (decision.incoming_chunk_id && decision.target_chunk_id) {
          if (resolution === "keep_incoming") {
            ChunkRepo.supersede(decision.target_chunk_id, decision.incoming_chunk_id);
            actionResult = { kept: "incoming", superseded: decision.target_chunk_id };
          } else {
            ChunkRepo.supersede(decision.incoming_chunk_id, decision.target_chunk_id);
            actionResult = { kept: "existing", superseded: decision.incoming_chunk_id };
          }
        } else {
          // Missing chunk refs — just resolve without data changes
          actionResult = { kept: resolution.replace("keep_", ""), note: "chunk references missing, resolved without data change" };
        }
        break;
      }

      default:
        actionResult = { note: "No action required for this decision type" };
    }

    DecisionRepo.updateStatus(id, "accepted", "user");
    res.json({ success: true, ...actionResult });
  } catch (err) {
    logger.error("POST /decisions/:id/accept error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Reject ────────────────────────────────────────────────────────────────────

router.post("/decisions/:id/reject", (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const decision = DecisionRepo.getById(id);
    if (!decision) return res.status(404).json({ error: "Decision not found" });
    if (decision.status !== "pending") {
      return res.status(400).json({ error: `Decision is already ${decision.status}` });
    }
    DecisionRepo.updateStatus(id, "rejected", "user");
    res.json({ success: true });
  } catch (err) {
    logger.error("POST /decisions/:id/reject error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Run cleanup job (disabled) ────────────────────────────────────────────────

router.post("/decisions/cleanup", (_req, res) => {
  res.status(410).json({ error: "Cleanup job has been removed" });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJson(str, fallback) {
  try { return JSON.parse(str) || fallback; } catch { return fallback; }
}

function mergeSourceDocs(existing, incoming) {
  const seen = new Set(existing.map(d => d.doc_id));
  const additions = incoming.filter(d => !seen.has(d.doc_id));
  return [...existing, ...additions];
}

export default router;
