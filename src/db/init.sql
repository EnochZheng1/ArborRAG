-- nodes：知识树节点
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  level INTEGER DEFAULT 1,
  aliases_json TEXT DEFAULT '[]',
  scope_json TEXT DEFAULT '{}',
  node_summary TEXT DEFAULT '',
  authority_level_mode TEXT DEFAULT 'sop',
  conflict_score INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (parent_id) REFERENCES nodes(node_id)
);

-- chunks：结构化知识片段
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_title TEXT,
  content_clean TEXT NOT NULL,
  chunk_type TEXT,
  keywords_json TEXT DEFAULT '[]',
  fields_json TEXT DEFAULT '{}',
  scope_json TEXT DEFAULT '{}',
  authority_level TEXT DEFAULT 'sop',
  uploaded_at TEXT DEFAULT (datetime('now')),
  node_id TEXT,
  status TEXT DEFAULT 'active',
  version INTEGER DEFAULT 1,
  superseded_by INTEGER,
  document_id INTEGER,
  chunk_index INTEGER,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id),
  FOREIGN KEY (superseded_by) REFERENCES chunks(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

-- documents：上传文档追踪
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER,
  file_hash TEXT,
  status TEXT DEFAULT 'pending',
  chunk_count INTEGER DEFAULT 0,
  metadata_json TEXT DEFAULT '{}',
  uploaded_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT
);

-- embeddings：向量存储
CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  model TEXT DEFAULT 'text-embedding-004',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ref_type, ref_id)
);

-- conflicts：冲突记录
CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT,
  chunk_a_id INTEGER,
  chunk_b_id INTEGER,
  conflict_type TEXT,
  reason_json TEXT DEFAULT '{}',
  resolution TEXT DEFAULT 'human_review',
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (node_id) REFERENCES nodes(node_id),
  FOREIGN KEY (chunk_a_id) REFERENCES chunks(id),
  FOREIGN KEY (chunk_b_id) REFERENCES chunks(id)
);

-- audit_log：审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- FTS5：节点全文索引（BM25候选召回）
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id,
  text
);

-- FTS5：Chunk内容全文索引
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id,
  content
);

-- 索引优化 (created in db.js after migrations)
