/**
 * WebSocket progress emitter for ingestion jobs.
 *
 * Two event types:
 *  - job_progress   : per-job stage updates (sent only to subscribed clients)
 *  - queue_update   : lightweight "something changed in the queue" broadcast
 *                     sent to ALL connected clients so they can refresh the
 *                     Documents view without polling every 2s.
 */

import { ingestLogger as logger } from "./logger.js";

// All connected WebSocket clients
const allClients = new Set();

// jobId (string) → Set<WebSocket>
const jobClients = new Map();

/** Register a new connection. Must be called from server.js on "connection". */
export function addClient(ws) {
  allClients.add(ws);
}

/** Remove a client from all subscriptions and the global set. */
export function removeClient(ws) {
  allClients.delete(ws);
  for (const [jobId, clients] of jobClients) {
    clients.delete(ws);
    if (clients.size === 0) jobClients.delete(jobId);
  }
}

export function subscribeToJob(jobId, ws) {
  const key = String(jobId);
  if (!jobClients.has(key)) jobClients.set(key, new Set());
  jobClients.get(key).add(ws);
  logger.debug(`WS: client subscribed to job ${jobId}`);
}

export function unsubscribeFromJob(jobId, ws) {
  const key = String(jobId);
  const clients = jobClients.get(key);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) jobClients.delete(key);
}

/**
 * Broadcast a lightweight queue_update to every connected client.
 * The frontend uses this to trigger an immediate reload of the Documents view
 * instead of relying on 2-second polling.
 */
export function emitQueueUpdate() {
  if (allClients.size === 0) return;
  const payload = JSON.stringify({ type: "queue_update", ts: Date.now() });
  for (const ws of allClients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(payload); } catch { /* client already gone */ }
    }
  }
}

export function emitJobProgress(jobId, step, progress, message, status = "processing", datasetId = null) {
  const key = String(jobId);
  const clients = jobClients.get(key);
  if (!clients || clients.size === 0) return;

  const payload = JSON.stringify({
    type: "job_progress",
    jobId,
    datasetId,
    step,
    progress,
    message,
    status,
    ts: Date.now()
  });

  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      try { ws.send(payload); } catch { /* client already gone */ }
    }
  }
}
