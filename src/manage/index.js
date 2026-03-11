/**
 * Manage Orchestrator — routes user messages through intent classification
 * and action handlers, managing session state and confirmations.
 */

import {
  getOrCreateSession, addMessage, getRecentMessages,
  setPendingAction, getPendingAction, clearPendingAction, setFocusNode
} from "./chatSession.js";
import { classifyIntent } from "./intentClassifier.js";
import { executeAdd } from "./actions/addAction.js";
import { findEditTargets, executeEdit } from "./actions/editAction.js";
import { findDeleteTargets, executeDelete } from "./actions/deleteAction.js";
import { getRecentChanges, revertChange } from "./actions/undoAction.js";
import { ask } from "../kg/qa.js";
import { logger } from "../utils/logger.js";

/**
 * Handle a single manage-mode message.
 * @param {string} message - User's message
 * @param {string|null} sessionId - Existing session ID or null for new
 * @returns {Promise<object>} Response object
 */
export async function handleManageMessage(message, sessionId) {
  const session = getOrCreateSession(sessionId);
  addMessage(session.id, "user", message);
  session.lastMessage = message;

  try {
    // 1. Check for pending action (confirmation flow)
    const pending = getPendingAction(session.id);
    if (pending) {
      const result = await handlePendingAction(session, message, pending);
      if (result) return result;
    }

    // 2. Classify intent
    const context = {
      recentMessages: getRecentMessages(session.id, 5),
      focusNodeId: session.focusNodeId,
      pendingAction: null
    };

    const { intent, confidence, data } = await classifyIntent(message, context);
    logger.info(`[manage] Intent: ${intent} (${confidence.toFixed(2)})`);

    // 3. Route to handler
    let result;
    switch (intent) {
      case "ADD":
        result = await handleAdd(session, data);
        break;
      case "EDIT":
        result = await handleEdit(session, data);
        break;
      case "DELETE":
        result = await handleDelete(session, data);
        break;
      case "UNDO":
        result = await handleUndo(session);
        break;
      case "HISTORY":
        result = handleHistory();
        break;
      case "QUERY":
        result = await handleQuery(message);
        break;
      default:
        result = buildResponse(session, "CLARIFY",
          "I'm not sure what you'd like to do. You can:\n" +
          "- **Add** information (just state a fact)\n" +
          "- **Edit** existing content (\"change X to Y\")\n" +
          "- **Delete** content (\"remove/delete X\")\n" +
          "- **Ask** a question\n" +
          "- Type **undo** to revert the last change\n" +
          "- Type **history** to see recent changes");
    }

    addMessage(session.id, "assistant", result.response);
    return result;

  } catch (err) {
    logger.error(`[manage] Error: ${err.message}\n${err.stack}`);
    const errResult = buildResponse(session, "ERROR",
      `Something went wrong: ${err.message}. Please try again.`);
    addMessage(session.id, "assistant", errResult.response);
    return errResult;
  }
}

// ── Handler functions ───────────────────────────────────────────────────────

async function handlePendingAction(session, message, pending) {
  const context = { recentMessages: getRecentMessages(session.id, 3) };
  const { intent } = await classifyIntent(message, context);

  if (intent === "CONFIRM") {
    clearPendingAction(session.id);
    return executePendingAction(session, pending);
  }

  if (intent === "CANCEL") {
    clearPendingAction(session.id);
    const result = buildResponse(session, "CANCEL", "Cancelled.");
    addMessage(session.id, "assistant", result.response);
    return result;
  }

  if (intent === "SELECT" || /^\d$/.test(message.trim())) {
    const idx = parseInt(message.trim(), 10);
    if (pending.payload?.candidates) {
      const picked = pending.payload.candidates[idx - 1];
      if (picked) {
        // Update pending to single target
        pending.payload.targetChunkId = picked.chunk.id;
        pending.payload.targetContent = picked.chunk.content_clean;
        pending.payload.candidates = null;

        if (pending.type === "edit") {
          const preview = `**Selected:** "${picked.chunk.content_clean.slice(0, 100)}..."\n` +
            `**New content:** "${pending.payload.newContent}"\n\nConfirm this edit? (yes/no)`;
          const result = buildResponse(session, "EDIT", preview, { pendingAction: pending });
          addMessage(session.id, "assistant", result.response);
          return result;
        }
        if (pending.type === "delete") {
          const preview = `**Selected for deletion:**\n"${picked.chunk.content_clean.slice(0, 200)}"\n\nConfirm delete? (yes/no)`;
          const result = buildResponse(session, "DELETE", preview, { pendingAction: pending });
          addMessage(session.id, "assistant", result.response);
          return result;
        }
      }
    }
  }

  // Not a confirm/cancel/select — clear pending and process as new intent
  clearPendingAction(session.id);
  return null;
}

async function executePendingAction(session, pending) {
  if (pending.type === "edit") {
    const chunkId = pending.payload.targetChunkId;
    const newContent = pending.payload.newContent;
    const editResult = await executeEdit(chunkId, newContent);
    if (editResult.success) {
      setFocusNode(session.id, editResult.nodeId);
      const result = buildResponse(session, "EDIT",
        `Updated successfully.\n**Before:** "${editResult.before.slice(0, 150)}"\n**After:** "${editResult.after.slice(0, 150)}"`,
        { changes: [{ type: "edit", chunkId, nodeId: editResult.nodeId, nodePath: editResult.nodePath }] });
      addMessage(session.id, "assistant", result.response);
      return result;
    }
    const result = buildResponse(session, "ERROR", editResult.message);
    addMessage(session.id, "assistant", result.response);
    return result;
  }

  if (pending.type === "delete") {
    const chunkId = pending.payload.targetChunkId;
    const delResult = executeDelete(chunkId);
    if (delResult.success) {
      const result = buildResponse(session, "DELETE",
        `Deleted: "${delResult.deletedContent.slice(0, 150)}"`,
        { changes: [{ type: "delete", chunkId, nodeId: delResult.nodeId, nodePath: delResult.nodePath }] });
      addMessage(session.id, "assistant", result.response);
      return result;
    }
    const result = buildResponse(session, "ERROR", delResult.message);
    addMessage(session.id, "assistant", result.response);
    return result;
  }

  return null;
}

async function handleAdd(session, data) {
  const content = data.content || "";
  if (!content.trim()) {
    return buildResponse(session, "CLARIFY", "What information would you like to add? Please provide a complete statement.");
  }

  const addResult = await executeAdd(content, data.topic_hint, data.subtopic_hint, session);

  if (!addResult.success) {
    return buildResponse(session, "ADD", addResult.message);
  }

  setFocusNode(session.id, addResult.nodeId);

  const pathStr = addResult.nodePath.join(" > ");
  const newNodeNote = addResult.isNewNode ? " (new node created)" : "";
  return buildResponse(session, "ADD",
    `Added to **${pathStr}**${newNodeNote}:\n"${addResult.content}"`,
    { changes: [{
      type: "add", chunkId: addResult.chunkId,
      nodeId: addResult.nodeId, nodePath: addResult.nodePath, content: addResult.content
    }] });
}

async function handleEdit(session, data) {
  const targetDesc = data.target_description || data.old_value || data.content || "";
  if (!targetDesc.trim()) {
    return buildResponse(session, "CLARIFY", "What would you like to edit? Please describe the content you want to change.");
  }

  const { matches } = findEditTargets(targetDesc, data.old_value);

  if (!matches.length) {
    return buildResponse(session, "EDIT", `I couldn't find any content matching "${targetDesc}". Could you describe it differently?`);
  }

  // Determine new content
  let newContent = data.new_value || data.content || "";
  if (data.old_value && data.new_value && matches[0]) {
    // Replace old_value with new_value in the existing content
    const existing = matches[0].chunk.content_clean || "";
    if (existing.includes(data.old_value)) {
      newContent = existing.replace(data.old_value, data.new_value);
    } else {
      newContent = data.new_value;
    }
  }

  if (!newContent.trim()) {
    return buildResponse(session, "CLARIFY", "What should the new content be? Please provide the updated text.");
  }

  if (matches.length === 1) {
    // Single match — show preview and ask for confirmation
    const m = matches[0];
    const actionId = setPendingAction(session.id, {
      type: "edit",
      payload: { targetChunkId: m.chunk.id, targetContent: m.chunk.content_clean, newContent }
    });

    const pathStr = m.nodePath.join(" > ");
    return buildResponse(session, "EDIT",
      `Found a match in **${pathStr}**:\n**Current:** "${m.chunk.content_clean.slice(0, 200)}"\n**New:** "${newContent.slice(0, 200)}"\n\nConfirm this edit? (yes/no)`,
      { pendingAction: { actionId, type: "edit", preview: { before: m.chunk.content_clean, after: newContent, nodePath: m.nodePath } } });
  }

  // Multiple matches — ask user to pick
  const list = matches.slice(0, 5).map((m, i) => {
    const pathStr = m.nodePath.join(" > ");
    return `**${i + 1}.** [${pathStr}] "${m.chunk.content_clean.slice(0, 100)}..."`;
  }).join("\n");

  const actionId = setPendingAction(session.id, {
    type: "edit",
    payload: { candidates: matches, newContent }
  });

  return buildResponse(session, "EDIT",
    `Found ${matches.length} matches. Which one do you want to edit?\n\n${list}\n\nReply with a number (1-${matches.length}):`,
    { pendingAction: { actionId, type: "edit" } });
}

async function handleDelete(session, data) {
  const targetDesc = data.target_description || data.content || "";
  if (!targetDesc.trim()) {
    return buildResponse(session, "CLARIFY", "What would you like to delete? Please describe the content.");
  }

  const { matches } = findDeleteTargets(targetDesc);

  if (!matches.length) {
    return buildResponse(session, "DELETE", `I couldn't find any content matching "${targetDesc}". Could you describe it differently?`);
  }

  if (matches.length === 1) {
    const m = matches[0];
    const actionId = setPendingAction(session.id, {
      type: "delete",
      payload: { targetChunkId: m.chunk.id, targetContent: m.chunk.content_clean }
    });

    const pathStr = m.nodePath.join(" > ");
    return buildResponse(session, "DELETE",
      `Found in **${pathStr}**:\n"${m.chunk.content_clean.slice(0, 300)}"\n\n⚠ This will permanently remove this knowledge point. Confirm delete? (yes/no)`,
      { pendingAction: { actionId, type: "delete", preview: { content: m.chunk.content_clean, nodePath: m.nodePath } } });
  }

  const list = matches.slice(0, 5).map((m, i) => {
    const pathStr = m.nodePath.join(" > ");
    return `**${i + 1}.** [${pathStr}] "${m.chunk.content_clean.slice(0, 100)}..."`;
  }).join("\n");

  const actionId = setPendingAction(session.id, {
    type: "delete",
    payload: { candidates: matches }
  });

  return buildResponse(session, "DELETE",
    `Found ${matches.length} matches. Which one do you want to delete?\n\n${list}\n\nReply with a number (1-${matches.length}):`,
    { pendingAction: { actionId, type: "delete" } });
}

async function handleUndo(session) {
  const changes = getRecentChanges(1);
  if (!changes.length) {
    return buildResponse(session, "UNDO", "No recent chatbot changes to undo.");
  }

  const latest = changes[0];
  if (!latest.revertable) {
    return buildResponse(session, "UNDO", "The most recent change was already a revert and cannot be undone again.");
  }

  const result = await revertChange(latest.id);
  return buildResponse(session, "UNDO",
    result.success ? `Undo successful: ${result.description}` : `Undo failed: ${result.description}`);
}

function handleHistory() {
  const changes = getRecentChanges(20);
  if (!changes.length) {
    return { sessionId: null, intent: "HISTORY", response: "No chatbot changes recorded yet.", changes: [] };
  }

  return { sessionId: null, intent: "HISTORY", response: "Recent changes:", changes };
}

async function handleQuery(message) {
  try {
    const result = await ask({ query: message, options: { useClassification: true, trace: false } });
    const answer = result?.llm_response?.final_answer || result?.data?.final_answer || "No answer found.";
    return { sessionId: null, intent: "QUERY", response: answer, queryResult: result };
  } catch (err) {
    return { sessionId: null, intent: "QUERY", response: `Query failed: ${err.message}` };
  }
}

// ── Response builder ────────────────────────────────────────────────────────

function buildResponse(session, intent, response, extra = {}) {
  return {
    sessionId: session.id,
    intent,
    response,
    ...extra
  };
}
