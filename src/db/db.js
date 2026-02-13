import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dbLogger as logger } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

logger.info("Opening database: kg.db");
export const db = new Database("kg.db");

// Enable foreign keys
db.pragma("foreign_keys = ON");
// Let concurrent writers wait briefly instead of immediately throwing SQLITE_BUSY.
db.pragma("busy_timeout = 5000");

export function initDb() {
  logger.info("Initializing database schema...");
  const sql = fs.readFileSync(path.join(__dirname, "init.sql"), "utf-8");
  db.exec(sql);
  logger.info("Running migrations...");
  runMigrations();
  logger.info("Ensuring indexes...");
  ensureIndexes();
  logger.info("Database initialization complete");
}

function tableExists(tableName) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName);
  return Boolean(row);
}

function ensureColumn(tableName, columnName, definition) {
  if (!tableExists(tableName)) return;

  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(c => c.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function runMigrations() {
  // Nodes table columns
  ensureColumn("nodes", "aliases_json", "aliases_json TEXT DEFAULT '[]'");
  ensureColumn("nodes", "scope_json", "scope_json TEXT DEFAULT '{}'");
  ensureColumn("nodes", "node_summary", "node_summary TEXT DEFAULT ''");
  ensureColumn("nodes", "authority_level_mode", "authority_level_mode TEXT DEFAULT 'sop'");
  ensureColumn("nodes", "conflict_score", "conflict_score INTEGER DEFAULT 0");
  ensureColumn("nodes", "updated_at", "updated_at TEXT");

  // Chunks table columns
  ensureColumn("chunks", "doc_title", "doc_title TEXT");
  ensureColumn("chunks", "content_clean", "content_clean TEXT");
  ensureColumn("chunks", "chunk_type", "chunk_type TEXT");
  ensureColumn("chunks", "keywords_json", "keywords_json TEXT DEFAULT '[]'");
  ensureColumn("chunks", "fields_json", "fields_json TEXT DEFAULT '{}'");
  ensureColumn("chunks", "scope_json", "scope_json TEXT DEFAULT '{}'");
  ensureColumn("chunks", "authority_level", "authority_level TEXT DEFAULT 'sop'");
  ensureColumn("chunks", "uploaded_at", "uploaded_at TEXT");
  ensureColumn("chunks", "node_id", "node_id TEXT");
  ensureColumn("chunks", "status", "status TEXT DEFAULT 'active'");
  ensureColumn("chunks", "version", "version INTEGER DEFAULT 1");
  ensureColumn("chunks", "superseded_by", "superseded_by INTEGER");
  ensureColumn("chunks", "document_id", "document_id INTEGER");
  ensureColumn("chunks", "chunk_index", "chunk_index INTEGER");

  // Documents table columns
  ensureColumn("documents", "filename", "filename TEXT");
  ensureColumn("documents", "original_name", "original_name TEXT");
  ensureColumn("documents", "file_type", "file_type TEXT");
  ensureColumn("documents", "file_size", "file_size INTEGER");
  ensureColumn("documents", "file_hash", "file_hash TEXT");
  ensureColumn("documents", "status", "status TEXT DEFAULT 'pending'");
  ensureColumn("documents", "chunk_count", "chunk_count INTEGER DEFAULT 0");
  ensureColumn("documents", "metadata_json", "metadata_json TEXT DEFAULT '{}'");
  ensureColumn("documents", "uploaded_at", "uploaded_at TEXT");
  ensureColumn("documents", "processed_at", "processed_at TEXT");

  // Ingestion jobs table columns
  ensureColumn("ingestion_jobs", "file_path", "file_path TEXT");
  ensureColumn("ingestion_jobs", "original_name", "original_name TEXT");
  ensureColumn("ingestion_jobs", "file_size", "file_size INTEGER");
  ensureColumn("ingestion_jobs", "status", "status TEXT DEFAULT 'queued'");
  ensureColumn("ingestion_jobs", "options_json", "options_json TEXT DEFAULT '{}'");
  ensureColumn("ingestion_jobs", "attempt_count", "attempt_count INTEGER DEFAULT 0");
  ensureColumn("ingestion_jobs", "max_attempts", "max_attempts INTEGER DEFAULT 3");
  ensureColumn("ingestion_jobs", "error_message", "error_message TEXT");
  ensureColumn("ingestion_jobs", "document_id", "document_id INTEGER");
  ensureColumn("ingestion_jobs", "result_json", "result_json TEXT");
  ensureColumn("ingestion_jobs", "created_at", "created_at TEXT");
  ensureColumn("ingestion_jobs", "queued_at", "queued_at TEXT");
  ensureColumn("ingestion_jobs", "available_at", "available_at TEXT");
  ensureColumn("ingestion_jobs", "started_at", "started_at TEXT");
  ensureColumn("ingestion_jobs", "finished_at", "finished_at TEXT");
  ensureColumn("ingestion_jobs", "updated_at", "updated_at TEXT");

  // Embeddings table columns
  ensureColumn("embeddings", "ref_type", "ref_type TEXT");
  ensureColumn("embeddings", "ref_id", "ref_id TEXT");
  ensureColumn("embeddings", "embedding_json", "embedding_json TEXT");
  ensureColumn("embeddings", "model", "model TEXT DEFAULT 'text-embedding-004'");
  ensureColumn("embeddings", "created_at", "created_at TEXT");

  // Conflicts table columns
  ensureColumn("conflicts", "node_id", "node_id TEXT");
  ensureColumn("conflicts", "chunk_a_id", "chunk_a_id INTEGER");
  ensureColumn("conflicts", "chunk_b_id", "chunk_b_id INTEGER");
  ensureColumn("conflicts", "conflict_type", "conflict_type TEXT");
  ensureColumn("conflicts", "reason_json", "reason_json TEXT DEFAULT '{}'");
  ensureColumn("conflicts", "resolution", "resolution TEXT DEFAULT 'human_review'");
  ensureColumn("conflicts", "resolved_at", "resolved_at TEXT");
  ensureColumn("conflicts", "created_at", "created_at TEXT");

  // Audit log table columns
  ensureColumn("audit_log", "action", "action TEXT");
  ensureColumn("audit_log", "table_name", "table_name TEXT");
  ensureColumn("audit_log", "record_id", "record_id TEXT");
  ensureColumn("audit_log", "old_value_json", "old_value_json TEXT");
  ensureColumn("audit_log", "new_value_json", "new_value_json TEXT");
  ensureColumn("audit_log", "created_at", "created_at TEXT");
}

function ensureIndexes() {
  const indexes = [
    {
      name: "idx_chunks_node_id",
      sql: "CREATE INDEX IF NOT EXISTS idx_chunks_node_id ON chunks(node_id)"
    },
    {
      name: "idx_chunks_status",
      sql: "CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(node_id, status)"
    },
    {
      name: "idx_chunks_document",
      sql: "CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)"
    },
    {
      name: "idx_embeddings_ref",
      sql: "CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings(ref_type, ref_id)"
    },
    {
      name: "idx_nodes_parent",
      sql: "CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)"
    },
    {
      name: "idx_documents_status",
      sql: "CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)"
    },
    {
      name: "idx_ingestion_jobs_status",
      sql: "CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs(status, available_at, queued_at)"
    },
    {
      name: "idx_ingestion_jobs_created",
      sql: "CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created ON ingestion_jobs(created_at)"
    },
    {
      name: "idx_conflicts_node",
      sql: "CREATE INDEX IF NOT EXISTS idx_conflicts_node ON conflicts(node_id)"
    },
    {
      name: "idx_conflicts_resolution",
      sql: "CREATE INDEX IF NOT EXISTS idx_conflicts_resolution ON conflicts(resolution)"
    }
  ];

  for (const idx of indexes) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?"
    ).get(idx.name);
    if (!exists) {
      db.exec(idx.sql);
    }
  }
}

// Helper to safely parse JSON
export function safeJson(s, fallback = null) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// Audit log helper
export function logAudit(action, tableName, recordId, oldValue = null, newValue = null) {
  db.prepare(`
    INSERT INTO audit_log (action, table_name, record_id, old_value_json, new_value_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    action,
    tableName,
    String(recordId),
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null
  );
}

// Transaction helper
export function runTransaction(fn) {
  return db.transaction(fn)();
}
