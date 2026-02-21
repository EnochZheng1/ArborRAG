/**
 * WebSocket progress emitter for ingestion jobs.
 *
 * Clients subscribe to a jobId and receive real-time stage updates
 * as the pipeline processes each document.
 */

import { ingestLogger as logger } from "./logger.js";

// jobId (string) → Set<WebSocket>
const jobClients = new Map();

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

// Called on WS disconnect — removes a client from all subscriptions
export function unsubscribeAll(ws) {
  for (const [jobId, clients] of jobClients) {
    clients.delete(ws);
    if (clients.size === 0) jobClients.delete(jobId);
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
