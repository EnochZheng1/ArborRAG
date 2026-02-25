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
import { logger, requestLogger } from "./utils/logger.js";
import { startIngestionQueue } from "./ingest/jobQueue.js";
import { subscribeToJob, unsubscribeFromJob, unsubscribeAll } from "./utils/progressEmitter.js";

// Route modules
import datasetsRouter from "./routes/datasets.js";
import settingsRouter from "./routes/settings.js";
import queryRouter from "./routes/query.js";
import ingestRouter from "./routes/ingest.js";
import documentsRouter from "./routes/documents.js";
import nodesRouter from "./routes/nodes.js";
import conflictsRouter from "./routes/conflicts.js";
import embeddingsRouter from "./routes/embeddings.js";
import statsRouter from "./routes/stats.js";
import entitiesRouter from "./routes/entities.js";
import decisionsRouter from "./routes/decisions.js";
import testsRouter from "./routes/tests.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

initDb();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(requestLogger);
startIngestionQueue();

// ── Dataset registry endpoints (no DB context required) ──────────────────────
app.use("/datasets", datasetsRouter);

// ── Settings (no DB context required) ────────────────────────────────────────
app.use(settingsRouter);

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public")));

// ── Dataset middleware ────────────────────────────────────────────────────────
// Resolves X-Dataset-ID header and runs all downstream handlers inside the
// correct SQLite connection via AsyncLocalStorage.
app.use((req, res, next) => {
  const datasetId = req.headers["x-dataset-id"] || getDefaultDatasetId();
  try {
    const conn = getConnection(datasetId);
    req.datasetConn = conn; // survives multer's async boundary
    runWithDb(conn, next);
  } catch {
    res.status(404).json({ error: `Dataset '${datasetId}' not found` });
  }
});

// ── Dataset-context-aware routes ─────────────────────────────────────────────
app.use(ingestRouter);
app.use(queryRouter);
app.use("/documents", documentsRouter);
app.use(nodesRouter);
app.use(conflictsRouter);
app.use(embeddingsRouter);
app.use(statsRouter);
app.use(entitiesRouter);
app.use(decisionsRouter);
app.use(testsRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error("Server error:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ── WebSocket server (progress events) ───────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
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
  ws.on("close", () => unsubscribeAll(ws));
  ws.on("error", () => unsubscribeAll(ws));
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
