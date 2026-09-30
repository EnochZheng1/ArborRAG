# ArborKB

**v3.3.0 · Node.js · SQLite · OpenAI or Google Gemini**

ArborKB turns a set of documents into a navigable topic tree and answers questions with citations to the stored material. It is a local, single-operator application with a web UI and REST API. Each dataset has its own SQLite database; ingestion and queries use a selected LLM provider.

## What it does

1. Create or select a dataset in the web UI. Optionally import a guided tree schema before ingesting documents.
2. Upload documents. A background queue parses them, extracts knowledge points, assigns them to tree nodes, and records decisions for potential conflicts.
3. Inspect the tree and pending decisions. Adjust nodes, review source chunks, and regenerate embeddings or node metadata when needed.
4. Ask questions. Retrieval combines SQLite full-text search, optional vector embeddings, and the hierarchy; the answer includes source citations and confidence signals.
5. Save test questions and compare local runs when changing data, prompts, or retrieval settings.

Supported inputs in `src/ingest/fileParser.js`: `.txt`, `.md`, `.pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`, `.html`, `.htm`, `.json`, `.csv`, and `.pptx`. Extraction quality depends on the document structure and provider response; check the parsed content and citations for important answers.

## Start locally

You need Node.js, npm, and credentials for either OpenAI or Google Gemini. This project uses `better-sqlite3`, which may need a compatible native build on your platform.

```sh
npm ci
cp .env.example .env
# Edit .env: choose LLM_PROVIDER and set the matching provider key.
npm start
```

Open <http://localhost:3000>. The `.env.example` template selects Gemini; set `GEMINI_API_KEY`, or switch `LLM_PROVIDER=openai` and set `OPENAI_API_KEY`. Gemini can also use Vertex AI service-account authentication (see the template). `npm run dev` restarts the server as source files change.

For a first run, create a dataset in **Datasets**, upload a small document in **Ingest**, wait for the job to finish, then ask a question in **Ask**. The server exposes `GET /health` for a basic process check. Documents, databases, credentials, and logs should remain local and are excluded by `.gitignore`.

If ingestion fails, inspect the job in **Ingest** or `GET /ingest/jobs/:id` and the local server log. First check the file extension, provider credentials, and any rate or upload limit in `.env`. An upload is queued by default; an accepted HTTP response means the job was created, not that extraction has finished.

## Configuration

Copy `.env.example` and change only the settings you need. Do not commit `.env` or service-account files.

| Setting | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `gemini` or `openai`; initial provider for LLM calls. |
| `GEMINI_API_KEY`, `OPENAI_API_KEY` | Credential for the selected provider. |
| `GEMINI_MODEL`, `OPENAI_MODEL` | Provider model names for extraction and answers. |
| `GEMINI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_MODEL` | Embedding models used by vector retrieval. |
| `VERTEX_AI`, `VERTEX_PROJECT`, `VERTEX_LOCATION`, `GOOGLE_SERVICE_ACCOUNT_KEY` | Optional Vertex AI authentication for Gemini. |
| `PORT` | HTTP port, default `3000`. |
| `INGEST_QUEUE_CONCURRENCY`, `INGEST_QUEUE_MAX_ATTEMPTS` | Background ingestion throughput and retries. |
| `INGEST_AUTO_EMBED`, `DISABLE_EMBEDDINGS` | Embedding generation and vector-retrieval availability. |
| `INGEST_MAX_FILE_MB`, `INGEST_MAX_BATCH_FILES` | Upload limits. |
| `RETRIEVAL_MAX_HIERARCHICAL`, `RETRIEVAL_MAX_DIRECT`, `RETRIEVAL_RERANKER_POOL`, `VECTOR_RECALL_THRESHOLD` | Retrieval candidate limits and vector threshold. |

The **Settings** tab can switch provider and model at runtime and customize prompts per dataset. Other ingestion options, timeouts, and defaults are documented in `.env.example`; guided schema settings are described in [the schema manual](docs/GUIDED_SCHEMA_MANUAL.md).

## Main interfaces

The UI is served from `public/`. API requests can select a dataset with the `X-Dataset-ID` header; without it, the server uses its default dataset. This header selects a database, not an access-control boundary.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/upload`, `/upload/batch` | Queue one or more files for ingestion. |
| `GET` | `/ingest/jobs/:id` | Read a queued job's status. |
| `POST` | `/ask` | Ask a question (`{"query":"..."}`); returns an answer and supporting material. |
| `GET`, `POST` | `/datasets` | List or create datasets. |
| `GET` | `/nodes` | Inspect the topic tree. |
| `GET` | `/decisions` | Review pending knowledge-point decisions. |
| `POST` | `/reprocess` | Refresh node metadata, search index, or embeddings. |
| `GET` | `/health` | Basic server status. |

For the broader route inventory and request schemas, see [the OpenAPI file](docs/openapi.yaml) and `src/routes/`. Check the route implementation if a specification detail differs from the running code.

For example, after starting the server and selecting a default dataset, these requests upload one file and ask a question:

```sh
curl -F "file=@./example.md" http://localhost:3000/upload
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query":"What does the uploaded document say?"}'
```

Wait for the ingestion job to complete before asking. To use a particular dataset from the API, add `-H "X-Dataset-ID: <dataset-id>"` to each dataset-scoped request. The browser UI sets this context as you switch datasets.

## Code map

```text
src/server.js          Express, WebSocket, middleware, and route registration
src/routes/            REST handlers for uploads, queries, datasets, tree, settings
src/ingest/            File parsing, queue, extraction, node mapping, decisions
src/kg/                Question answering and tree-based retrieval
src/query/             Ranking, citations, confidence, and query helpers
src/embedding/         Provider embeddings and vector support
src/db/                Dataset registry and SQLite repositories
src/utils/llm.js       OpenAI/Gemini provider configuration and calls
public/               Browser UI
```

The v3.3.0 default retrieval path starts with node-first recall, expands nearby nodes, and can use direct search when that result is weak. Guided schemas can constrain or extend the topic tree. The ingestion queue reports progress through WebSocket events. See [document processing](docs/DOCUMENT_PROCESSING_FLOW.md) and [retrieval flow](docs/RETRIEVAL_FLOW.md) for deeper implementation notes; those older TreeKB-named documents may describe earlier defaults, so use the source for exact current behavior.

### Working with a dataset

- **Tree:** inspect topic nodes and their source chunks; edit or reparent a node when the taxonomy is wrong.
- **Decisions:** review knowledge-point conflicts or replacements before treating the result as settled knowledge.
- **Schema:** import a predefined tree when consistent names matter. Soft mode permits new child nodes; hard mode keeps mapping inside the defined tree.
- **Embeddings:** use the UI or `/embeddings/sync` after changing embedding settings. Without embeddings, full-text and tree retrieval still operate, but vector recall is unavailable.
- **Tests:** save representative Q&A pairs in the UI and compare run history after changing prompts, documents, or retrieval settings.

Dataset databases and the registry are local SQLite files in `data/`; uploads are staged under `uploads/`. Back up the database files before significant changes to the tree or ingestion settings. By default the ingestion pipeline removes an uploaded source file after successful processing, while extracted knowledge remains in the database.

## Operational limits and evidence

The server has no user login or per-user dataset authorization. It is intended for a trusted local environment. Its rate limits and security headers do not make it ready for internet exposure; the current server disables Content Security Policy for the UI. Provider calls can send document text and query context outside the machine. Confirm data rights and the selected provider's handling before uploading sensitive material. Review answers against their citations, especially for consequential use.

The v3.3.0 release notes report **100% “effective accuracy”** on two small local query sets (14 and 16 queries), with average confidence of 0.63 and 0.64. These are project-reported, dataset-specific runs; they were not rerun for this documentation update and are not held-out or independent validation. The named datasets and full qualifications remain in [version history](docs/version-history.md). The benchmark harness is `tests/benchmark.mjs`; saved test cases and their data determine what it actually measures.

For local development, `npm test` runs the project's test runner, `npm run lint` checks `src/`, and `npm run benchmark` executes the configured query set against a running server. A benchmark result depends on the selected dataset, provider, prompts, query set, and configuration; keep those inputs with any reported score. These commands were not run for this README update.

## Further reading

- [Version history](docs/version-history.md) — release details and qualified local benchmark report.
- [Guided schema manual](docs/GUIDED_SCHEMA_MANUAL.md) — schema design, import, and strictness modes.
- [Document processing flow](docs/DOCUMENT_PROCESSING_FLOW.md) — queue and ingestion stages.
- [Retrieval flow](docs/RETRIEVAL_FLOW.md) — recall, ranking, and answer generation.
- [OpenAPI specification](docs/openapi.yaml) — API reference; verify details against `src/routes/`.
