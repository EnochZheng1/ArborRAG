import "dotenv/config";
import http from "http";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDb } from "./db/db.js";
import { getConnection, getAllConnections } from "./db/datasetManager.js";
import { getDefaultDatasetId } from "./db/registry.js";
import { runWithDb } from "./db/activeDb.js";
import { logger, apiLogger, requestLogger } from "./utils/logger.js";
import { startIngestionQueue } from "./ingest/jobQueue.js";
import { addClient, removeClient, subscribeToJob, unsubscribeFromJob } from "./utils/progressEmitter.js";
import requestId from './middleware/requestId.js';
import { ApiError } from './utils/apiError.js';
import { cleanupOrphanedUploads } from './utils/uploadCleanup.js';

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
import promptsRouter from "./routes/prompts.js";
import manageRouter from "./routes/manage.js";
import schemaInterviewRouter from "./routes/schemaInterview.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

initDb();

const app = express();

// ── Security headers (S1) ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // CSP would block inline scripts in frontend
  crossOriginEmbedderPolicy: false, // Allow loading D3 from CDN
}));

// ── Rate limiting (S2) ──────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } },
});

const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 LLM requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many AI requests, please slow down' } },
});

app.use(express.json({ limit: `${Number(process.env.INGEST_MAX_FILE_MB) || 200}mb` }));
app.use(requestId);
app.use(requestLogger);
startIngestionQueue();

// ── Dataset registry endpoints (no DB context required) ──────────────────────
app.use("/datasets", datasetsRouter);

// ── Settings (no DB context required) ────────────────────────────────────────
app.use(settingsRouter);

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../public"), {
  // Prevent aggressive browser caching of JS/CSS during development
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

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

// ── Rate limiting for API routes (after static files) ────────────────────────
app.use('/ask', llmLimiter);
app.use('/upload', llmLimiter);
app.use(apiLimiter);

// ── Dataset middleware ────────────────────────────────────────────────────────
// Resolves X-Dataset-ID header and runs all downstream handlers inside the
// correct SQLite connection via AsyncLocalStorage.
app.use((req, res, next) => {
  const datasetId = req.headers["x-dataset-id"] || getDefaultDatasetId();
  try {
    const conn = getConnection(datasetId);
    req.datasetConn = conn; // survives multer's async boundary
    runWithDb(conn, next, datasetId);
  } catch (err) {
    apiLogger.warn(`Dataset '${datasetId}' not found: ${err.message}`);
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Dataset '${datasetId}' not found` } });
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
app.use("/schema/interview", schemaInterviewRouter);
app.use("/schema", schemaRouter);
app.use("/prompts", promptsRouter);
app.use("/manage", manageRouter);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  const reqId = req.id || '-';
  if (err.status && err.toJSON) {
    logger.warn(`API error [${reqId}]: ${err.code} - ${err.message}`);
    return res.status(err.status).json(err.toJSON());
  }
  // Log full error internally but send generic message to client
  logger.error(`Server error [${reqId}]:`, err.stack || err.message);
  const isProduction = process.env.NODE_ENV === 'production';
  const clientMessage = isProduction ? 'Internal server error' : (err.message || 'Internal server error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: clientMessage } });
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
  cleanupOrphanedUploads(); // Run once at startup
  setInterval(cleanupOrphanedUploads, 6 * 60 * 60 * 1000); // Every 6 hours
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
