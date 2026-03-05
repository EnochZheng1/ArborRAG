# TreeKB — Tree-Based Knowledge Graph

**v2.3.0** · Node.js · SQLite · OpenAI / Gemini

A local knowledge management system that ingests documents into a hierarchical knowledge graph, then answers questions with cited, reasoned responses.

---

## Features

- **Guided Tree Schema** — pre-define the knowledge tree structure via JSON import; ingested KPs map into your taxonomy instead of inventing arbitrary topic names; soft (extends with child nodes) or hard (clamps to existing schema) strictness; global template library for reuse across datasets
- **Multi-provider LLM** — switch between OpenAI and Google Gemini at runtime via the Settings tab; defaults to OpenAI (`gpt-5-nano`)
- **Knowledge Point (KP) extraction** — LLM decomposes documents into atomic, typed statements (fact, rule, definition, procedure, example, context) and places them into a topical hierarchy
- **KP decision engine** — deduplicates, merges, replaces, or normalises incoming KPs against existing knowledge; borderline cases are queued for human review in the Decisions tab
- **Multi-dataset support** — separate SQLite databases per dataset, switched via `X-Dataset-ID` header or the Datasets tab
- **Hybrid retrieval** — BM25 full-text search + vector embeddings + hierarchy traversal, fused by score; schema node keywords boost BM25 recall
- **Background ingestion queue** — async job processing with configurable concurrency, retries, and WebSocket progress events
- **Entity & fact extraction** — named entities and relational facts extracted and stored for graph queries
- **Test case management** — save and replay Q&A pairs to track retrieval quality over time
- **Dark mode UI** — fully themed web interface

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy and fill in your API keys
cp .env.example .env

# Start the server
npm start          # production
npm run dev        # auto-restart on file changes
```

Open `http://localhost:3000` in your browser.

---

## Environment Variables

```env
# Active LLM provider: 'openai' | 'gemini'
LLM_PROVIDER=openai

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-nano
OPENAI_EMBEDDING_MODEL=text-embedding-3-large

# Google Gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001

# Server
PORT=3000

# Ingestion queue
INGEST_QUEUE_CONCURRENCY=2
INGEST_QUEUE_MAX_ATTEMPTS=3
INGEST_QUEUE_RETRY_DELAY_MS=5000
INGEST_CLEANUP_ON_SUCCESS=true
```

---

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/upload` | Upload and ingest a single document |
| `POST` | `/upload/batch` | Upload and ingest multiple documents |
| `GET` | `/upload/status/:jobId` | Check ingestion job status |
| `GET` | `/jobs` | List all background jobs |
| `POST` | `/ask` | Ask a question |
| `GET` | `/documents` | List documents |
| `DELETE` | `/documents/:id` | Delete document and its knowledge |
| `GET` | `/nodes` | Get knowledge tree |
| `GET` | `/decisions` | List pending KP decisions |
| `GET` | `/schema` | Get schema nodes as hierarchical tree |
| `POST` | `/schema/import` | Import schema from JSON |
| `GET` | `/schema/export` | Export schema as JSON |
| `GET/PATCH` | `/schema/settings` | Get or update mapping mode / strictness |
| `GET/POST` | `/schema/templates` | List or create global schema templates |
| `POST` | `/schema/templates/:id/apply` | Apply a template to the current dataset |
| `GET` | `/entities` | List extracted entities |
| `GET` | `/facts` | List extracted facts |
| `GET` | `/datasets` | List datasets |
| `POST` | `/datasets` | Create a dataset |
| `GET` | `/settings/llm` | Get LLM configuration |
| `POST` | `/settings/llm` | Update LLM provider / model |
| `POST` | `/embeddings/sync` | Re-generate all embeddings |
| `GET` | `/stats` | System statistics |
| `GET` | `/health` | Health check |

---

## Architecture

```
uploads/           Uploaded source files
src/
  server.js        Express + WebSocket entry point
  db/              SQLite schema, migrations, repositories
  ingest/          Document parsing → KP extraction → node mapping
  embedding/       Vector embedding (OpenAI or Gemini)
  query/           Retrieval pipeline (BM25 + vector + hierarchy)
  kg/              Knowledge graph reasoning and Q&A
  routes/          REST API route handlers
  utils/           LLM abstraction, logger, rate-limit helpers
public/            Single-page web UI
```

---

## Changelog

### v2.3.0
- **Guided Tree Schema** — pre-define dataset structure via JSON import; KPs map to schema nodes using heuristic scoring (name/description/keyword overlap) plus batched LLM disambiguation; soft/hard strictness modes; global template library stored in `registry.db`
- **Schema panel** — new collapsible panel in the Tree tab for import/export, settings, and template management; mode badge shows current mapping mode at a glance
- **Keyword accumulation** — KP keywords written back to schema nodes on every ingest, boosting BM25 recall for those nodes over time
- **Node detail** — schema nodes marked with 📌 badge; description and keyword chips shown inline
- **Query handlers & trace** — structured query handling (`queryHandlers.js`) and step-by-step trace support (`queryTrace.js`)
- **Reranker** — score-gap cutoff prevents low-relevance chunks diluting LLM context
- **Ingest refactor** — `kpNormaliser.js` and `nodeHierarchy.js` extracted from `nodeMapper.js`; section heading detection; paragraph fallback chunks
- **Removed** — `cleanupJob.js`, `conflictDetector.js`, `queryPlanner.js` (superseded)

### v2.2.0
- **Node scope isolation** — simple lookup now uses only node-scoped (hierarchical) chunks; global direct chunks used only as fallback when tree localization fails entirely, with a user-visible fallback message
- **BM25 scoring fix** — replaced dynamic `normalize01` with absolute cap (`MAX_EXPECTED_BM25 = 15.0`) to prevent low-quality nodes from being inflated to a false perfect score
- **Superseded chunk filtering** — all 6 node-scoped `ChunkRepo` read methods now enforce `superseded_by IS NULL` in addition to `status = 'active'`
- **Aggregation query UI** — fixed raw JSON being displayed for aggregation queries; answer, conditions, and missing-info now rendered properly
- **Entity field name fix** — bulk entity extraction log now uses `doc.original_name` (was `doc.title`, always undefined)

### v2.1.0
- Multi-provider LLM support (OpenAI + Gemini) with runtime switching
- Settings tab UI for provider / model configuration
- KP decision engine (merge, replace, normalize, queue for review)
- Decisions tab UI
- Multi-dataset support with per-dataset language configuration
- Background ingestion queue with retries and WebSocket progress
- Test case management tab
- Physical file deletion on document delete
- FTS5 query sanitisation (Unicode whitelist)
- Upload file preserved across retries; deleted only on final failure
- Generic LLM topic-hint placeholders normalised to prevent noise nodes

### v2.0.0
- Knowledge Point ingestion system
- Conflict detection
- Entity and fact extraction
- Hybrid retrieval (BM25 + vector + hierarchy)
- Repository pattern, multi-dataset schema
