/**
 * Dataset Manager
 *
 * Manages the connection pool (Map<datasetId, connection>) and all
 * dataset lifecycle operations: create, rename, delete, duplicate, export.
 * Also handles the one-time migration from the legacy kg.db.
 */
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { setDefaultDb } from "./activeDb.js";
import { initDatasetDb } from "./initDatasetDb.js";
import {
  initRegistryDb,
  listDatasets,
  getDataset,
  createDataset as registryCreate,
  renameDataset as registryRename,
  deleteDataset as registryDelete,
  getDefaultDatasetId,
  datasetNameExists
} from "./registry.js";
import { JobRepo } from "./repositories/JobRepo.js";
import { dbLogger as logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const DATASETS_DIR = path.join(DATA_DIR, "datasets");
const LEGACY_DB_PATH = path.join(DATA_DIR, "kg.db");

/** Map<datasetId, better-sqlite3 connection> */
const pool = new Map();

function openConnection(dbPath) {
  const conn = new Database(dbPath);
  conn.pragma("journal_mode = WAL");   // concurrent reads during writes
  conn.pragma("synchronous = NORMAL"); // safe with WAL, faster than FULL
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  return conn;
}

/**
 * Initialize the dataset manager on server startup.
 * - Creates directories if needed
 * - Initializes the registry
 * - Migrates legacy kg.db on first run
 * - Opens connections for all registered datasets
 * - Sets the default DB context
 */
export function initDatasetManager() {
  // Ensure directories exist
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATASETS_DIR)) fs.mkdirSync(DATASETS_DIR, { recursive: true });

  // Initialize registry
  initRegistryDb();

  // First-run migration
  const existing = listDatasets();
  if (existing.length === 0) {
    const defaultDbPath = path.join(DATASETS_DIR, "default.db");

    if (fs.existsSync(LEGACY_DB_PATH)) {
      logger.info(`Migrating legacy kg.db → datasets/default.db`);
      fs.copyFileSync(LEGACY_DB_PATH, defaultDbPath);
    } else {
      logger.info("No legacy kg.db found — creating fresh default dataset");
      // File will be created by new Database()
    }

    registryCreate({
      id: "default",
      name: "Default",
      description: "Default knowledge base",
      dbPath: defaultDbPath
    });

    logger.info("Default dataset registered in registry");
  }

  // Open connections for all registered datasets.
  // better-sqlite3 creates the file automatically if it doesn't exist,
  // so new datasets (no legacy kg.db) get their file created here.
  for (const dataset of listDatasets()) {
    try {
      const conn = openConnection(dataset.db_path);
      initDatasetDb(conn);
      pool.set(dataset.id, conn);
      logger.info(`Opened dataset connection: ${dataset.name} (${dataset.id})`);
    } catch (err) {
      logger.error(`Failed to open dataset '${dataset.id}' at ${dataset.db_path}: ${err.message}`);
    }
  }

  // Set default connection for background/non-request contexts
  const defaultId = getDefaultDatasetId();
  if (defaultId && pool.has(defaultId)) {
    setDefaultDb(pool.get(defaultId));
  } else if (pool.size > 0) {
    setDefaultDb(pool.values().next().value);
  }

  logger.info(`Dataset manager ready — ${pool.size} dataset(s) loaded`);
}

/**
 * Get an open connection by dataset ID.
 * Throws a descriptive error if not found.
 */
export function getConnection(datasetId) {
  const conn = pool.get(datasetId);
  if (!conn) {
    throw Object.assign(new Error(`Dataset '${datasetId}' not found`), { status: 404 });
  }
  return conn;
}

/**
 * Returns all open connections as an array of { datasetId, connection }.
 * Used by the job queue pump to process jobs across all datasets.
 */
export function getAllConnections() {
  return Array.from(pool.entries()).map(([datasetId, connection]) => ({
    datasetId,
    connection
  }));
}

/**
 * Create a new dataset with its own SQLite file.
 * @param {string} name - Human-readable name (must be unique)
 * @param {string} [description]
 * @returns {object} Registry row for the new dataset
 */
export function createDataset(name, description = "") {
  if (!name?.trim()) throw new Error("Dataset name is required");
  if (datasetNameExists(name)) throw new Error(`A dataset named '${name}' already exists`);

  const id = crypto.randomUUID();
  const dbPath = path.join(DATASETS_DIR, `${id}.db`);

  const conn = openConnection(dbPath);
  initDatasetDb(conn);
  pool.set(id, conn);

  const dataset = registryCreate({ id, name: name.trim(), description, dbPath });
  logger.info(`Created dataset: ${name} (${id})`);
  return dataset;
}

/**
 * Rename a dataset and/or update its description.
 * @param {string} id
 * @param {string} [name]
 * @param {string} [description]
 * @returns {object} Updated registry row
 */
export function renameDataset(id, name, description) {
  if (!pool.has(id)) throw Object.assign(new Error(`Dataset '${id}' not found`), { status: 404 });
  if (name !== undefined && datasetNameExists(name, id)) {
    throw new Error(`A dataset named '${name}' already exists`);
  }
  return registryRename(id, name, description);
}

/**
 * Delete a dataset: closes connection, removes registry entry, deletes file.
 * Refuses to delete the last remaining dataset.
 * @param {string} id
 */
export function deleteDataset(id) {
  const datasets = listDatasets();
  if (datasets.length <= 1) {
    throw new Error("Cannot delete the only remaining dataset");
  }
  const dataset = getDataset(id);
  if (!dataset) throw Object.assign(new Error(`Dataset '${id}' not found`), { status: 404 });

  const conn = pool.get(id);
  if (conn) {
    // Cancel queued jobs so the pump doesn't pick them up after the connection closes.
    // In-flight jobs will naturally fail when their next DB call throws on the closed conn.
    try {
      const cancelled = JobRepo.cancelAllOnConnection(conn);
      if (cancelled > 0) logger.warn(`Cancelled ${cancelled} active job(s) for deleted dataset '${dataset.name}'`);
    } catch (_) {}
    try { conn.close(); } catch (_) {}
    pool.delete(id);
  }

  registryDelete(id);

  if (fs.existsSync(dataset.db_path)) {
    fs.unlinkSync(dataset.db_path);
    logger.info(`Deleted dataset file: ${dataset.db_path}`);
  }

  logger.info(`Deleted dataset: ${dataset.name} (${id})`);
}

/**
 * Duplicate a dataset by performing an online backup.
 * @param {string} sourceId
 * @param {string} [newName] - Defaults to "<source name> (copy)"
 * @returns {object} Registry row for the new dataset
 */
export async function duplicateDataset(sourceId, newName) {
  const source = getDataset(sourceId);
  if (!source) throw Object.assign(new Error(`Dataset '${sourceId}' not found`), { status: 404 });

  const resolvedName = newName?.trim() || `${source.name} (copy)`;
  if (datasetNameExists(resolvedName)) {
    throw new Error(`A dataset named '${resolvedName}' already exists`);
  }

  const sourceConn = getConnection(sourceId);
  const newId = crypto.randomUUID();
  const destPath = path.join(DATASETS_DIR, `${newId}.db`);

  // Online backup — safe while source is open and being written to
  await sourceConn.backup(destPath);

  const destConn = openConnection(destPath);
  pool.set(newId, destConn);

  const dataset = registryCreate({
    id: newId,
    name: resolvedName,
    description: source.description,
    dbPath: destPath
  });

  logger.info(`Duplicated dataset '${source.name}' → '${resolvedName}' (${newId})`);
  return dataset;
}

/**
 * Export a dataset by creating a consistent backup copy.
 * Returns the path to the temporary backup file.
 * Caller is responsible for deleting the temp file after streaming.
 * @param {string} id
 * @returns {Promise<{tempPath: string, name: string}>}
 */
export async function exportDataset(id) {
  const dataset = getDataset(id);
  if (!dataset) throw Object.assign(new Error(`Dataset '${id}' not found`), { status: 404 });

  const conn = getConnection(id);
  const tempPath = path.join(DATASETS_DIR, `export-${Date.now()}-${id}.db`);

  await conn.backup(tempPath);

  return { tempPath, name: dataset.name };
}

/**
 * Get quick stats for a dataset by querying its connection directly.
 * @param {string} id
 * @returns {object}
 */
export function getDatasetStats(id) {
  const conn = getConnection(id);

  const nodeCount = conn.prepare("SELECT COUNT(*) AS n FROM nodes").get()?.n ?? 0;
  const docCount = conn.prepare("SELECT COUNT(*) AS n FROM documents WHERE status != 'deleted'").get()?.n ?? 0;
  const chunkCount = conn.prepare("SELECT COUNT(*) AS n FROM chunks WHERE status = 'active'").get()?.n ?? 0;
  const embeddingCount = conn.prepare("SELECT COUNT(*) AS n FROM embeddings").get()?.n ?? 0;

  return {
    id,
    node_count: nodeCount,
    document_count: docCount,
    chunk_count: chunkCount,
    embedding_count: embeddingCount
  };
}
