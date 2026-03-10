/**
 * UNDO Action — revert chatbot changes using audit_log snapshots.
 */

import { AuditRepo } from "../../db/repositories/AuditRepo.js";
import { ChunkRepo } from "../../db/repositories/ChunkRepo.js";
import { NodeRepo } from "../../db/repositories/NodeRepo.js";
import { logAudit, runTransaction } from "../../db/db.js";
import { logger } from "../../utils/logger.js";

/**
 * Get recent chatbot changes (for history display).
 */
export function getRecentChanges(limit = 20) {
  const changes = AuditRepo.getChatbotChanges(limit);
  return changes.map(c => ({
    id: c.id,
    action: c.action,
    record_id: c.record_id,
    old_value: c.old_value,
    new_value: c.new_value,
    created_at: c.created_at,
    revertable: c.action !== "chatbot_revert",
    description: describeChange(c)
  }));
}

function describeChange(change) {
  const content = change.new_value?.content || change.new_value?.content_clean
    || change.old_value?.content_clean || "";
  const preview = content.length > 80 ? content.slice(0, 80) + "..." : content;

  switch (change.action) {
    case "chatbot_add":
      return `Added: "${preview}"`;
    case "chatbot_edit":
      return `Edited chunk ${change.record_id}`;
    case "chatbot_delete":
      return `Deleted: "${preview}"`;
    case "chatbot_revert":
      return `Reverted change #${change.new_value?.reverted_audit_id || "?"}`;
    default:
      return `${change.action} on ${change.table_name} #${change.record_id}`;
  }
}

/**
 * Revert a specific chatbot change by audit_log ID.
 * @param {number} auditId - The audit_log row ID to revert
 * @returns {{ success: boolean, description: string }}
 */
export function revertChange(auditId) {
  const entry = AuditRepo.getById(auditId);
  if (!entry) {
    return { success: false, description: "Change not found." };
  }
  if (entry.action === "chatbot_revert") {
    return { success: false, description: "Cannot revert a revert. Please re-add the content manually." };
  }
  if (!entry.action.startsWith("chatbot_")) {
    return { success: false, description: "Only chatbot changes can be reverted." };
  }

  try {
    switch (entry.action) {
      case "chatbot_add":
        return revertAdd(entry);
      case "chatbot_edit":
        return revertEdit(entry);
      case "chatbot_delete":
        return revertDelete(entry);
      default:
        return { success: false, description: `Unknown action: ${entry.action}` };
    }
  } catch (err) {
    logger.error(`[manage:undo] Revert failed for audit ${auditId}: ${err.message}`);
    return { success: false, description: `Revert failed: ${err.message}` };
  }
}

/**
 * Revert an ADD → delete the chunk that was added.
 */
function revertAdd(entry) {
  const chunkId = Number(entry.record_id);
  const chunk = ChunkRepo.getById(chunkId);
  if (!chunk) {
    return { success: false, description: "Chunk already deleted — nothing to revert." };
  }

  runTransaction(() => {
    ChunkRepo.deleteById(chunkId);
    if (chunk.node_id) NodeRepo.touch(chunk.node_id);
    logAudit("chatbot_revert", "chunks", chunkId, { content_clean: chunk.content_clean },
      { reverted_audit_id: entry.id, reverted_action: "chatbot_add" });
  });

  logger.info(`[manage:undo] Reverted ADD — deleted chunk ${chunkId}`);
  return { success: true, description: "Reverted: removed the added knowledge point." };
}

/**
 * Revert an EDIT → restore the old content.
 */
function revertEdit(entry) {
  const chunkId = Number(entry.record_id);
  const chunk = ChunkRepo.getById(chunkId);
  if (!chunk) {
    return { success: false, description: "Chunk no longer exists — cannot restore." };
  }

  const oldContent = entry.old_value?.content_clean;
  if (!oldContent) {
    return { success: false, description: "No previous content snapshot available." };
  }

  runTransaction(() => {
    ChunkRepo.updateContent(chunkId, oldContent);
    if (chunk.node_id) NodeRepo.touch(chunk.node_id);
    logAudit("chatbot_revert", "chunks", chunkId,
      { content_clean: chunk.content_clean },
      { content_clean: oldContent, reverted_audit_id: entry.id, reverted_action: "chatbot_edit" });
  });

  logger.info(`[manage:undo] Reverted EDIT — restored chunk ${chunkId}`);
  return { success: true, description: "Reverted: restored the previous content." };
}

/**
 * Revert a DELETE → re-insert the chunk from snapshot.
 */
function revertDelete(entry) {
  const old = entry.old_value;
  if (!old || !old.content_clean) {
    return { success: false, description: "No snapshot available to restore deleted content." };
  }

  let newChunkId;
  runTransaction(() => {
    const result = ChunkRepo.insertKP({
      doc_title: old.doc_title || "Manual Entry",
      content: old.content_clean,
      chunk_type: old.chunk_type || "fact",
      kp_type: old.kp_type || "fact",
      keywords: old.keywords_json ? JSON.parse(old.keywords_json) : [],
      fields: old.fields_json ? JSON.parse(old.fields_json) : {},
      scope: old.scope_json ? JSON.parse(old.scope_json) : {},
      authority_level: old.authority_level || "sop",
      source_excerpt: old.source_excerpt || "",
      source_documents_json: old.source_documents_json || "[]",
      nodeId: old.node_id,
      documentId: old.document_id || null,
      index: old.chunk_index || 0
    });
    newChunkId = Number(result.lastInsertRowid);
    ChunkRepo.insertFts(newChunkId, old.content_clean);
    if (old.node_id) NodeRepo.touch(old.node_id);
    logAudit("chatbot_revert", "chunks", newChunkId, null,
      { content_clean: old.content_clean, reverted_audit_id: entry.id, reverted_action: "chatbot_delete" });
  });

  logger.info(`[manage:undo] Reverted DELETE — re-inserted as chunk ${newChunkId}`);
  return {
    success: true,
    description: "Reverted: re-inserted the deleted knowledge point. Run embedding sync to update search indexes."
  };
}
