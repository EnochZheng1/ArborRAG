/**
 * Initialize a dataset SQLite connection with the full schema.
 * Called on every new or existing dataset connection at startup/creation.
 * Extracted and generalized from db.js so it works on any better-sqlite3 instance.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_VERSION = 3;

/**
 * Read the current schema version from the dataset_config table.
 * Returns 0 if the table does not exist or has no schema_version row.
 */
function getSchemaVersion(conn) {
  try {
    const row = conn
      .prepare("SELECT value FROM dataset_config WHERE key = 'schema_version'")
      .get();
    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch {
    // Table doesn't exist yet — first init
    return 0;
  }
}

function tableExists(conn, tableName) {
  const row = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function ensureColumn(conn, tableName, columnName, definition) {
  if (!tableExists(conn, tableName)) return;
  const columns = conn.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((c) => c.name === columnName);
  if (!exists) {
    conn.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function runMigrations(conn) {
  // Nodes
  ensureColumn(conn, "nodes", "aliases_json", "aliases_json TEXT DEFAULT '[]'");
  ensureColumn(conn, "nodes", "scope_json", "scope_json TEXT DEFAULT '{}'");
  ensureColumn(conn, "nodes", "node_summary", "node_summary TEXT DEFAULT ''");
  ensureColumn(conn, "nodes", "authority_level_mode", "authority_level_mode TEXT DEFAULT 'sop'");
  ensureColumn(conn, "nodes", "conflict_score", "conflict_score INTEGER DEFAULT 0");
  ensureColumn(conn, "nodes", "updated_at", "updated_at TEXT");
  ensureColumn(conn, "nodes", "node_description", "node_description TEXT DEFAULT ''");
  ensureColumn(conn, "nodes", "is_schema_node",   "is_schema_node INTEGER DEFAULT 0");
  ensureColumn(conn, "nodes", "keywords_json",    "keywords_json TEXT DEFAULT '[]'");
  ensureColumn(conn, "nodes", "attributes_json",  "attributes_json TEXT DEFAULT '[]'");

  // Chunks
  ensureColumn(conn, "chunks", "doc_title", "doc_title TEXT");
  ensureColumn(conn, "chunks", "content_clean", "content_clean TEXT");
  ensureColumn(conn, "chunks", "chunk_type", "chunk_type TEXT");
  ensureColumn(conn, "chunks", "keywords_json", "keywords_json TEXT DEFAULT '[]'");
  ensureColumn(conn, "chunks", "fields_json", "fields_json TEXT DEFAULT '{}'");
  ensureColumn(conn, "chunks", "scope_json", "scope_json TEXT DEFAULT '{}'");
  ensureColumn(conn, "chunks", "authority_level", "authority_level TEXT DEFAULT 'sop'");
  ensureColumn(conn, "chunks", "uploaded_at", "uploaded_at TEXT");
  ensureColumn(conn, "chunks", "node_id", "node_id TEXT");
  ensureColumn(conn, "chunks", "status", "status TEXT DEFAULT 'active'");
  ensureColumn(conn, "chunks", "version", "version INTEGER DEFAULT 1");
  ensureColumn(conn, "chunks", "superseded_by", "superseded_by INTEGER");
  ensureColumn(conn, "chunks", "document_id", "document_id INTEGER");
  ensureColumn(conn, "chunks", "chunk_index", "chunk_index INTEGER");
  ensureColumn(conn, "chunks", "feedback_score", "feedback_score REAL DEFAULT 0");
  ensureColumn(conn, "chunks", "feedback_count", "feedback_count INTEGER DEFAULT 0");
  ensureColumn(conn, "chunks", "kp_type",              "kp_type TEXT DEFAULT 'legacy_chunk'");
  ensureColumn(conn, "chunks", "source_excerpt",        "source_excerpt TEXT DEFAULT ''");
  ensureColumn(conn, "chunks", "source_documents_json", "source_documents_json TEXT DEFAULT '[]'");

  // Documents
  ensureColumn(conn, "documents", "filename", "filename TEXT");
  ensureColumn(conn, "documents", "original_name", "original_name TEXT");
  ensureColumn(conn, "documents", "file_type", "file_type TEXT");
  ensureColumn(conn, "documents", "file_size", "file_size INTEGER");
  ensureColumn(conn, "documents", "file_hash", "file_hash TEXT");
  ensureColumn(conn, "documents", "status", "status TEXT DEFAULT 'pending'");
  ensureColumn(conn, "documents", "chunk_count", "chunk_count INTEGER DEFAULT 0");
  ensureColumn(conn, "documents", "metadata_json", "metadata_json TEXT DEFAULT '{}'");
  ensureColumn(conn, "documents", "uploaded_at", "uploaded_at TEXT");
  ensureColumn(conn, "documents", "processed_at", "processed_at TEXT");

  // Ingestion jobs
  ensureColumn(conn, "ingestion_jobs", "file_path", "file_path TEXT");
  ensureColumn(conn, "ingestion_jobs", "original_name", "original_name TEXT");
  ensureColumn(conn, "ingestion_jobs", "file_size", "file_size INTEGER");
  ensureColumn(conn, "ingestion_jobs", "status", "status TEXT DEFAULT 'queued'");
  ensureColumn(conn, "ingestion_jobs", "options_json", "options_json TEXT DEFAULT '{}'");
  ensureColumn(conn, "ingestion_jobs", "attempt_count", "attempt_count INTEGER DEFAULT 0");
  ensureColumn(conn, "ingestion_jobs", "max_attempts", "max_attempts INTEGER DEFAULT 3");
  ensureColumn(conn, "ingestion_jobs", "error_message", "error_message TEXT");
  ensureColumn(conn, "ingestion_jobs", "document_id", "document_id INTEGER");
  ensureColumn(conn, "ingestion_jobs", "result_json", "result_json TEXT");
  ensureColumn(conn, "ingestion_jobs", "created_at", "created_at TEXT");
  ensureColumn(conn, "ingestion_jobs", "queued_at", "queued_at TEXT");
  ensureColumn(conn, "ingestion_jobs", "available_at", "available_at TEXT");
  ensureColumn(conn, "ingestion_jobs", "started_at", "started_at TEXT");
  ensureColumn(conn, "ingestion_jobs", "finished_at", "finished_at TEXT");
  ensureColumn(conn, "ingestion_jobs", "updated_at", "updated_at TEXT");
  ensureColumn(conn, "ingestion_jobs", "checkpoint_json", "checkpoint_json TEXT DEFAULT NULL");

  // Embeddings
  ensureColumn(conn, "embeddings", "ref_type", "ref_type TEXT");
  ensureColumn(conn, "embeddings", "ref_id", "ref_id TEXT");
  ensureColumn(conn, "embeddings", "embedding_json", "embedding_json TEXT");
  ensureColumn(conn, "embeddings", "model", "model TEXT DEFAULT 'text-embedding-004'");
  ensureColumn(conn, "embeddings", "created_at", "created_at TEXT");

  // Conflicts
  ensureColumn(conn, "conflicts", "node_id", "node_id TEXT");
  ensureColumn(conn, "conflicts", "chunk_a_id", "chunk_a_id INTEGER");
  ensureColumn(conn, "conflicts", "chunk_b_id", "chunk_b_id INTEGER");
  ensureColumn(conn, "conflicts", "conflict_type", "conflict_type TEXT");
  ensureColumn(conn, "conflicts", "reason_json", "reason_json TEXT DEFAULT '{}'");
  ensureColumn(conn, "conflicts", "resolution", "resolution TEXT DEFAULT 'human_review'");
  ensureColumn(conn, "conflicts", "resolved_at", "resolved_at TEXT");
  ensureColumn(conn, "conflicts", "created_at", "created_at TEXT");

  // Audit log
  ensureColumn(conn, "audit_log", "action", "action TEXT");
  ensureColumn(conn, "audit_log", "table_name", "table_name TEXT");
  ensureColumn(conn, "audit_log", "record_id", "record_id TEXT");
  ensureColumn(conn, "audit_log", "old_value_json", "old_value_json TEXT");
  ensureColumn(conn, "audit_log", "new_value_json", "new_value_json TEXT");
  ensureColumn(conn, "audit_log", "created_at", "created_at TEXT");

  // Test cases — additive columns for Phase 1 test suite
  ensureColumn(conn, "test_cases", "suite",     "suite TEXT DEFAULT ''");
  ensureColumn(conn, "test_cases", "tags_json",  "tags_json TEXT DEFAULT '[]'");
  ensureColumn(conn, "test_cases", "priority",   "priority INTEGER DEFAULT 2");
}

function ensureIndexes(conn) {
  const indexes = [
    { name: "idx_chunks_node_id", sql: "CREATE INDEX IF NOT EXISTS idx_chunks_node_id ON chunks(node_id)" },
    { name: "idx_chunks_status", sql: "CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(node_id, status)" },
    { name: "idx_chunks_document", sql: "CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)" },
    { name: "idx_embeddings_ref", sql: "CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings(ref_type, ref_id)" },
    { name: "idx_nodes_parent", sql: "CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)" },
    { name: "idx_documents_status", sql: "CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)" },
    { name: "idx_ingestion_jobs_status", sql: "CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs(status, available_at, queued_at)" },
    { name: "idx_ingestion_jobs_created", sql: "CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created ON ingestion_jobs(created_at)" },
    { name: "idx_conflicts_node", sql: "CREATE INDEX IF NOT EXISTS idx_conflicts_node ON conflicts(node_id)" },
    { name: "idx_conflicts_resolution", sql: "CREATE INDEX IF NOT EXISTS idx_conflicts_resolution ON conflicts(resolution)" },
    { name: "idx_chunks_kp_type", sql: "CREATE INDEX IF NOT EXISTS idx_chunks_kp_type ON chunks(kp_type, node_id)" },
    { name: "idx_nodes_schema", sql: "CREATE INDEX IF NOT EXISTS idx_nodes_schema ON nodes(is_schema_node) WHERE is_schema_node = 1" },
    { name: "idx_nodes_parent_name", sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_parent_name ON nodes(parent_id, name) WHERE parent_id IS NOT NULL" },
  ];

  for (const idx of indexes) {
    const exists = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(idx.name);
    if (!exists) {
      conn.exec(idx.sql);
    }
  }
}

function initEntityFactTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      node_id TEXT,
      aliases_json TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(normalized_name, type)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_node ON entities(node_id);

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      fact_type TEXT,
      confidence REAL DEFAULT 0.8,
      status TEXT DEFAULT 'active',
      superseded_by INTEGER,
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(fact_type);
    CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);

    CREATE TABLE IF NOT EXISTS entity_facts (
      entity_id INTEGER NOT NULL,
      fact_id INTEGER NOT NULL,
      role TEXT DEFAULT 'subject',
      PRIMARY KEY (entity_id, fact_id),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_facts_entity ON entity_facts(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_facts_fact ON entity_facts(fact_id);

    CREATE TABLE IF NOT EXISTS fact_evidence (
      fact_id INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      relevance_score REAL DEFAULT 1.0,
      extraction_confidence REAL DEFAULT 0.8,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (fact_id, chunk_id),
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fact_evidence_fact ON fact_evidence(fact_id);
    CREATE INDEX IF NOT EXISTS idx_fact_evidence_chunk ON fact_evidence(chunk_id);

    CREATE TABLE IF NOT EXISTS entity_mentions (
      entity_id INTEGER NOT NULL,
      chunk_id INTEGER NOT NULL,
      mention_count INTEGER DEFAULT 1,
      context_snippet TEXT,
      PRIMARY KEY (entity_id, chunk_id),
      FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_chunk ON entity_mentions(chunk_id);
  `);

  // Migration: add attribute_name to facts for schema-defined attribute extraction
  ensureColumn(conn, "facts", "attribute_name", "attribute_name TEXT DEFAULT NULL");
}

function initTokenTrackingTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      operation TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      cost_estimate REAL DEFAULT 0,
      metadata_json TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_usage_operation ON token_usage(operation);
  `);
}

function initQueryHistoryTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS query_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      query_type TEXT,
      result_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_query_history_query ON query_history(query);
    CREATE INDEX IF NOT EXISTS idx_query_history_created ON query_history(created_at);
  `);
}

function initDecisionTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS pending_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      incoming_chunk_id INTEGER,
      target_chunk_id INTEGER,
      node_id TEXT,
      confidence REAL,
      reason TEXT,
      similarity_score REAL,
      incoming_preview TEXT,
      target_preview TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pd_status ON pending_decisions(status, created_at);
  `);
}

function initDatasetConfigTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS dataset_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  conn.prepare(`INSERT OR IGNORE INTO dataset_config (key, value) VALUES ('language', 'auto')`).run();
  conn.prepare(`INSERT OR IGNORE INTO dataset_config (key, value) VALUES ('mapping_mode', 'free')`).run();
  conn.prepare(`INSERT OR IGNORE INTO dataset_config (key, value) VALUES ('mapping_strictness', 'soft')`).run();
  conn.prepare(`INSERT OR IGNORE INTO dataset_config (key, value) VALUES ('tree_routing_mode', 'keyword')`).run();
}

function initFeedbackTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      query_type TEXT,
      answer_preview TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      node_ids_json TEXT,
      chunk_ids_json TEXT,
      session_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_query ON feedback(query);
    CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

    CREATE TABLE IF NOT EXISTS node_query_relevance (
      node_id TEXT NOT NULL,
      query_pattern TEXT NOT NULL,
      positive_count INTEGER DEFAULT 0,
      negative_count INTEGER DEFAULT 0,
      last_feedback TEXT,
      PRIMARY KEY (node_id, query_pattern)
    );
  `);

  // Add feedback columns to chunks (ignore error if already present)
  try { conn.exec(`ALTER TABLE chunks ADD COLUMN feedback_score REAL DEFAULT 0`); } catch (_) {}
  try { conn.exec(`ALTER TABLE chunks ADD COLUMN feedback_count INTEGER DEFAULT 0`); } catch (_) {}
}

/**
 * Fully initialize a dataset SQLite connection.
 * Idempotent — safe to call on existing databases.
 * @param {import('better-sqlite3').Database} connection
 */
export function initDatasetDb(connection) {
  connection.pragma("foreign_keys = ON");
  connection.pragma("busy_timeout = 5000");

  const sql = fs.readFileSync(path.join(__dirname, "init.sql"), "utf-8");
  connection.exec(sql);

  runMigrations(connection);
  ensureIndexes(connection);
  initEntityFactTables(connection);
  initTokenTrackingTable(connection);
  initFeedbackTables(connection);
  initQueryHistoryTable(connection);
  initDecisionTable(connection);
  initDatasetConfigTable(connection);
  initTestCasesTable(connection);
  initTestRunTables(connection);
  initLearningTables(connection);

  // ── Schema version tracking + migrations ──────────────────────────────────
  const currentVersion = getSchemaVersion(connection);

  // v2: Clamp unbounded feedback_score values + add confidence_at_answer to feedback
  if (currentVersion < 2) {
    connection.exec(`
      UPDATE chunks SET feedback_score = MAX(-1.0, MIN(1.0, feedback_score))
      WHERE feedback_score < -1.0 OR feedback_score > 1.0
    `);
    ensureColumn(connection, "feedback", "confidence_at_answer", "confidence_at_answer REAL");
    console.log(`[initDatasetDb] Migration v2: clamped feedback_score, added confidence_at_answer`);
  }

  // v3: Test run history tables (created via initTestRunTables above — idempotent)
  if (currentVersion < 3) {
    console.log(`[initDatasetDb] Migration v3: test_runs + test_run_items tables`);
  }

  if (currentVersion < SCHEMA_VERSION) {
    connection
      .prepare("INSERT OR REPLACE INTO dataset_config (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
    console.log(`[initDatasetDb] Schema v${SCHEMA_VERSION} applied (was v${currentVersion})`);
  } else {
    console.log(`[initDatasetDb] Schema already at v${currentVersion}`);
  }
}

function initLearningTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS learning_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parameter_key TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      sample_count INTEGER DEFAULT 0,
      confidence REAL,
      reason TEXT,
      cycle_timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_learning_history_key ON learning_history(parameter_key);
    CREATE INDEX IF NOT EXISTS idx_learning_history_ts ON learning_history(cycle_timestamp);

    CREATE TABLE IF NOT EXISTS ingestion_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      kp_count INTEGER DEFAULT 0,
      avg_kp_confidence REAL DEFAULT 0,
      decisions_created INTEGER DEFAULT 0,
      auto_resolved_count INTEGER DEFAULT 0,
      new_node_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ingestion_metrics_doc ON ingestion_metrics(document_id);
    CREATE INDEX IF NOT EXISTS idx_ingestion_metrics_ts ON ingestion_metrics(created_at);
  `);
}

function initTestRunTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT DEFAULT '',
      status        TEXT DEFAULT 'running',
      trigger_type  TEXT DEFAULT 'manual',
      mode          TEXT DEFAULT 'isolated',
      test_count    INTEGER DEFAULT 0,
      passed_count  INTEGER DEFAULT 0,
      failed_count  INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      error_count   INTEGER DEFAULT 0,
      duration_ms   INTEGER DEFAULT 0,
      is_baseline   INTEGER DEFAULT 0,
      cancel_reason TEXT DEFAULT '',
      env_json      TEXT DEFAULT '{}',
      started_at    TEXT DEFAULT (datetime('now')),
      finished_at   TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
    CREATE INDEX IF NOT EXISTS idx_test_runs_created ON test_runs(created_at);

    CREATE TABLE IF NOT EXISTS test_run_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL,
      test_id         TEXT NOT NULL,
      test_name       TEXT NOT NULL,
      category        TEXT DEFAULT '',
      status          TEXT DEFAULT 'pending',
      detail          TEXT DEFAULT '',
      assertion_type  TEXT DEFAULT '',
      assertion_value TEXT DEFAULT '',
      query           TEXT DEFAULT '',
      confidence      REAL,
      retrieval_confidence REAL,
      answer_groundedness  REAL,
      query_type      TEXT DEFAULT '',
      citations_count INTEGER DEFAULT 0,
      chunks_used     INTEGER DEFAULT 0,
      duration_ms     INTEGER DEFAULT 0,
      run_order       INTEGER DEFAULT 0,
      response_json   TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES test_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_test_run_items_run ON test_run_items(run_id);
    CREATE INDEX IF NOT EXISTS idx_test_run_items_test ON test_run_items(test_id);
  `);
}

function initTestCasesTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS test_cases (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      description    TEXT DEFAULT '',
      query          TEXT NOT NULL,
      assertion_type  TEXT NOT NULL,
      assertion_value TEXT DEFAULT '',
      enabled        INTEGER DEFAULT 1,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    );
  `);
}
