import "dotenv/config";
import http from "http";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { initDb } from "./db/db.js";
import { getConnection, getAllConnections } from "./db/datasetManager.js";
import { getDefaultDatasetId } from "./db/registry.js";
import { runWithDb } from "./db/activeDb.js";
import { logger, apiLogger, requestLogger } from "./utils/logger.js";
import { startIngestionQueue } from "./ingest/jobQueue.js";
import { addClient, removeClient, subscribeToJob, unsubscribeFromJob } from "./utils/progressEmitter.js";

// Route modules
import datasetsRouter from "./routes/datasets.js";
import settingsRouter from "./routes/settings.js";
import queryRouter from "./routes/query.js";
import ingestRouter from "./routes/ingest.js";
import documentsRouter from "./routes/documents.js";
import nodesRouter from "./routes/nodes.js";
import embeddingsRouter from "./routes/embeddings.js";
import statsRouter from "./routes/stats.js";
import entitiesRouter from "./routes/entities.js";
import decisionsRouter from "./routes/decisions.js";
import testsRouter from "./routes/tests.js";
import schemaRouter from "./routes/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

initDb();

const app = express();
app.use(express.json({ limit: `${Number(process.env.INGEST_MAX_FILE_MB) || 200}mb` }));
app.use(requestLogger);
startIngestionQueue();

// ── Dataset registry endpoints (no DB context required) ──────────────────────
app.use("/datasets", datasetsRouter);

// ── Settings (no DB context required) ────────────────────────────────────────
app.use(settingsRouter);

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ── Health & metrics (no DB context required) ────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    datasets: getAllConnections().length
  });
});

app.get('/metrics', (req, res) => {
  const connections = getAllConnections();
  const queue = { queued: 0, processing: 0, completed: 0, failed: 0, rate_limited: 0, cancelled: 0 };
  for (const { connection } of connections) {
    try {
      const rows = connection.prepare("SELECT status, COUNT(*) as c FROM ingestion_jobs GROUP BY status").all();
      for (const r of rows) { if (queue[r.status] !== undefined) queue[r.status] += r.c; }
    } catch {}
  }
  res.json({
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1048576),
    datasets: connections.length,
    queue,
    timestamp: new Date().toISOString()
  });
});

// ── Dataset middleware ────────────────────────────────────────────────────────
// Resolves X-Dataset-ID header and runs all downstream handlers inside the
// correct SQLite connection via AsyncLocalStorage.
app.use((req, res, next) => {
  const datasetId = req.headers["x-dataset-id"] || getDefaultDatasetId();
  try {
    const conn = getConnection(datasetId);
    req.datasetConn = conn; // survives multer's async boundary
    runWithDb(conn, next);
  } catch (err) {
    apiLogger.warn(`Dataset '${datasetId}' not found: ${err.message}`);
    res.status(404).json({ error: `Dataset '${datasetId}' not found` });
  }
});

// ── Dataset-context-aware routes ─────────────────────────────────────────────
app.use(ingestRouter);
app.use(queryRouter);
app.use("/documents", documentsRouter);
app.use(nodesRouter);
app.use(embeddingsRouter);
app.use(statsRouter);
app.use(entitiesRouter);
app.use(decisionsRouter);
app.use(testsRouter);
app.use("/schema", schemaRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error("Server error:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ── WebSocket server (progress events) ───────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  addClient(ws);
  const clientIp = req.socket?.remoteAddress ?? 'unknown';
  logger.debug(`WS client connected (${clientIp}), total: ${wss.clients.size}`);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === "watch" && msg.jobId) {
        subscribeToJob(String(msg.jobId), ws);
      } else if (msg.type === "unwatch" && msg.jobId) {
        unsubscribeFromJob(String(msg.jobId), ws);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on("close", () => {
    removeClient(ws);
    logger.debug(`WS client disconnected (${clientIp}), remaining: ${wss.clients.size}`);
  });

  ws.on("error", (err) => {
    logger.warn(`WS client error (${clientIp}): ${err.message}`);
    removeClient(ws);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`TreeKB server running on http://localhost:${PORT}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down`);
  httpServer.close(() => {
    for (const { connection } of getAllConnections()) {
      try { connection.close(); } catch (_) {}
    }
    logger.info("All DB connections closed");
    process.exit(0);
  });
  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
