/**
 * Chat Session Manager — in-memory session store with TTL.
 * Sessions track multi-turn conversation context and pending confirmations.
 * The audit_log is the permanent record; sessions are ephemeral.
 */

import { randomUUID } from "crypto";

const SESSION_TTL = 30 * 60 * 1000;   // 30 minutes
const PENDING_TTL = 5 * 60 * 1000;    // 5 minutes for pending actions
const MAX_MESSAGES = 20;

const sessions = new Map();

function now() { return new Date().toISOString(); }

export function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    s.lastActiveAt = now();
    return s;
  }
  const s = {
    id: sessionId || randomUUID(),
    createdAt: now(),
    lastActiveAt: now(),
    messages: [],
    focusNodeId: null,
    pendingAction: null
  };
  sessions.set(s.id, s);
  return s;
}

export function addMessage(sessionId, role, content, metadata = {}) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.messages.push({ role, content, timestamp: now(), metadata });
  if (s.messages.length > MAX_MESSAGES) {
    s.messages = s.messages.slice(-MAX_MESSAGES);
  }
  s.lastActiveAt = now();
}

export function getRecentMessages(sessionId, count = 5) {
  const s = sessions.get(sessionId);
  if (!s) return [];
  return s.messages.slice(-count);
}

export function setPendingAction(sessionId, action) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const actionId = randomUUID().slice(0, 8);
  s.pendingAction = {
    actionId,
    ...action,
    expiresAt: new Date(Date.now() + PENDING_TTL).toISOString()
  };
  return actionId;
}

export function getPendingAction(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.pendingAction) return null;
  if (new Date(s.pendingAction.expiresAt) < new Date()) {
    s.pendingAction = null;
    return null;
  }
  return s.pendingAction;
}

export function clearPendingAction(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.pendingAction = null;
}

export function setFocusNode(sessionId, nodeId) {
  const s = sessions.get(sessionId);
  if (s) s.focusNodeId = nodeId;
}

export function cleanupExpired() {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, s] of sessions) {
    if (new Date(s.lastActiveAt).getTime() < cutoff) {
      sessions.delete(id);
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupExpired, 5 * 60 * 1000).unref();
