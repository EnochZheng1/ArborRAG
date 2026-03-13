/**
 * Schema Interview Session Store — in-memory session store with TTL.
 * Mirrors the chatSession.js pattern for the AI schema interview flow.
 */

import { randomUUID } from "crypto";

const SESSION_TTL = 60 * 60 * 1000;   // 60 minutes
const sessions = new Map();

function now() { return new Date().toISOString(); }

export function createSession(existingTreeSummary = null, existingStats = null) {
  const s = {
    id: randomUUID(),
    createdAt: now(),
    lastActiveAt: now(),
    phase: 'interviewing',       // interviewing | generating | reviewing | applied
    answers: [],                 // { questionId, question, answer, timestamp }
    context: {
      domain: '',
      subdomains: [],
      queryPatterns: [],
      depthPreference: 'medium', // shallow | medium | deep
      language: '',
      entityTypes: [],
      additionalNotes: ''
    },
    existingTreeSummary,
    existingStats,
    generatedSchema: null,
    questionCount: 0
  };
  sessions.set(s.id, s);
  return s;
}

export function getSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return null;
  const s = sessions.get(sessionId);
  s.lastActiveAt = now();
  return s;
}

export function deleteSession(sessionId) {
  sessions.delete(sessionId);
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
