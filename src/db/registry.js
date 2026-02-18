/**
 * Dataset Registry
 *
 * Manages data/registry.db — the master list of all datasets.
 * This connection is always open, independent of the Proxy,
 * and is never affected by request-scoped DB switching.
 */
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(__dirname, "../../data/registry.db");

let registryDb = null;

export function initRegistryDb() {
  // Ensure data/ directory exists
  const dataDir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  registryDb = new Database(REGISTRY_PATH);
  registryDb.pragma("foreign_keys = ON");
  registryDb.pragma("busy_timeout = 5000");

  registryDb.exec(`
    CREATE TABLE IF NOT EXISTS datasets (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      db_path     TEXT NOT NULL UNIQUE,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_datasets_created ON datasets(created_at);
  `);
}

function getRegistry() {
  if (!registryDb) throw new Error("Registry not initialized — call initRegistryDb() first");
  return registryDb;
}

export function listDatasets() {
  return getRegistry()
    .prepare("SELECT * FROM datasets ORDER BY created_at ASC")
    .all();
}

export function getDataset(id) {
  return getRegistry()
    .prepare("SELECT * FROM datasets WHERE id = ?")
    .get(id) ?? null;
}

export function createDataset({ id, name, description = "", dbPath }) {
  getRegistry()
    .prepare(`
      INSERT INTO datasets (id, name, description, db_path)
      VALUES (?, ?, ?, ?)
    `)
    .run(id, name, description, dbPath);
  return getDataset(id);
}

export function renameDataset(id, newName, newDescription) {
  const updates = [];
  const params = [];

  if (newName !== undefined) {
    updates.push("name = ?");
    params.push(newName);
  }
  if (newDescription !== undefined) {
    updates.push("description = ?");
    params.push(newDescription);
  }
  if (updates.length === 0) return getDataset(id);

  updates.push("updated_at = datetime('now')");
  params.push(id);

  getRegistry()
    .prepare(`UPDATE datasets SET ${updates.join(", ")} WHERE id = ?`)
    .run(...params);

  return getDataset(id);
}

export function deleteDataset(id) {
  getRegistry().prepare("DELETE FROM datasets WHERE id = ?").run(id);
}

/** Returns the id of the default dataset (earliest created_at), or null. */
export function getDefaultDatasetId() {
  const row = getRegistry()
    .prepare("SELECT id FROM datasets ORDER BY created_at ASC LIMIT 1")
    .get();
  return row?.id ?? null;
}

/** Check if a dataset name is already taken (case-insensitive). */
export function datasetNameExists(name, excludeId = null) {
  let sql = "SELECT id FROM datasets WHERE lower(name) = lower(?)";
  const params = [name];
  if (excludeId) {
    sql += " AND id != ?";
    params.push(excludeId);
  }
  return Boolean(getRegistry().prepare(sql).get(...params));
}
