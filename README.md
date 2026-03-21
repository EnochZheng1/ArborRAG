# ArborRAG — Tree-Based Knowledge Graph

**v3.2.0** · Node.js · SQLite · OpenAI / Gemini

A local knowledge management system that ingests documents into a hierarchical knowledge graph, then answers questions with cited, reasoned responses.

---

## Features

- **Modular ES Module Frontend** — 8,200-line monolith split into 10 focused ES modules; thin entry point; shared state via module imports; function registry for cross-module calls
- **Security Hardening** — helmet security headers (HSTS, X-Frame-Options, CSP); express-rate-limit (120 req/min general, 20 req/min for LLM); file magic byte validation; orphaned upload cleanup; sanitized error messages in production
- **Structured API Errors** — all endpoints return `{ error: { code, message, details? } }` with typed error codes (VALIDATION_ERROR, NOT_FOUND, CONFLICT, RATE_LIMITED); request ID on every response via `X-Request-ID` header
- **Retrieval Quality** — result caching (5-min TTL); skip LLM classification on high-confidence patterns; consolidated citation LLM calls (4→2 max); early cross-doc filtering; query-specific confidence scoring; recency signal in confidence; centralized query helpers
- **Ingestion Quality** — paragraph fallback cap; fuzzy match in node creation recovery; batched keyword merging; sibling scan limit (50); improved CJK heading detection; checkpoint-before-processing; table KP cross-dedup
- **Conversational Knowledge Management** — add, edit, delete, and query knowledge through natural language chat; LLM intent classification routes messages to the right action; session-based confirmation flow for destructive operations; full change history with per-entry revert
- **Per-Dataset Prompt Customisation** — override any LLM prompt per dataset via the Prompts settings UI; defaults restored with one click; variables auto-injected at call time; search/filter across 33 prompt templates
- **Guided Tree Schema** — pre-define the knowledge tree structure via JSON import; ingested KPs map into your taxonomy instead of inventing arbitrary topic names; soft (extends with child nodes) or hard (clamps to existing schema) strictness; global template library for reuse across datasets
- **Tree Routing Modes** — keyword (fast, default), LLM (Gemini scores node relevance 0-10), or vector (embedding similarity); configurable per dataset in schema settings
- **Answer Quality Hardening** — answer-source alignment verification, source pre-summarization for 8+ sources, confidence-answer grounding with value-level checks, model-specific answer generation via `ANSWER_MODEL` env var
- **Smart Reranking** — cross-encoder weighted reranking (keyword 30% / BM25 20% / embedding 50%), adaptive score-gap cutoff, query-type aware boosts (numeric, entity, negation queries)
- **Ingestion Pipeline** — table-aware KP extraction (tab-separated and markdown tables), PPTX support, depth-aware node creation (5 heading levels), node summary generation, orphan node cleanup, topic canonicalization
- **Follow-up Query Context** — detects follow-up patterns and expands queries with prior context; per-dataset session history with 30-min TTL
- **Multi-provider LLM** — switch between OpenAI and Google Gemini (including Vertex AI) at runtime via the Settings tab
- **Knowledge Point (KP) extraction** — LLM decomposes documents into atomic, typed statements (fact, rule, definition, procedure, example, context) and places them into a topical hierarchy
- **KP decision engine** — deduplicates, merges, replaces, or normalises incoming KPs against existing knowledge; LLM-confirmed value conflicts queued for human review in the Decisions tab with diff view
- **Multi-dataset support** — separate SQLite databases per dataset, switched via `X-Dataset-ID` header or the Datasets tab
- **Hybrid retrieval** — BM25 full-text search + vector embeddings + hierarchy traversal, fused by score; schema node keywords boost BM25 recall; two retrieval strategies: Node First (direct node recall + local expansion, faster) and Top Down (beam-search tree walk, legacy)
- **Tree Management** — lazy-rendered tree for 500+ nodes, drag-and-drop reparenting, batch operations (move/delete), content search across chunks, tree health dashboard; undo for tree mutations
- **Accessibility** — ARIA roles/labels on all interactive elements, focus-visible outlines, confidence badge text indicators, focus trap in modals, keyboard shortcuts (Ctrl+K search, Ctrl+Enter submit, Escape close)
- **Background ingestion queue** — async job processing with configurable concurrency, retries, and WebSocket progress events; reconnection banner with manual reconnect
- **Entity & fact extraction** — named entities and relational facts extracted and stored for graph queries
- **Test case management** — save and replay Q&A pairs to track retrieval quality over time; persistent test runs with per-item metrics (confidence, latency, citations); run history with baseline comparison; runner/history/manage UI tabs
- **Dark mode UI** — fully themed web interface with embedding coverage indicator, query favorites, WebSocket status; mobile-responsive with 480px breakpoint

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

# Vertex AI (optional, overrides API key auth for Gemini)
VERTEX_AI=true
VERTEX_PROJECT=my-project
VERTEX_LOCATION=us-central1
GOOGLE_SERVICE_ACCOUNT_KEY=service-account.json

# Server
PORT=3000

# Ingestion queue
INGEST_QUEUE_CONCURRENCY=2
INGEST_QUEUE_MAX_ATTEMPTS=3
INGEST_QUEUE_RETRY_DELAY_MS=5000
INGEST_CLEANUP_ON_SUCCESS=true

# Ingestion tuning (v3.1)
INGEST_AUTO_EMBED=true             # Auto-run embedding sync after ingestion batch
INGEST_SKIP_ALIASES=false          # Skip alias generation during ingestion
INGEST_ORPHAN_CLEANUP=false        # Merge sparse nodes into parents

# Retrieval tuning (v3.1)
RETRIEVAL_MAX_HIERARCHICAL=15      # Max chunks from tree retrieval
RETRIEVAL_MAX_DIRECT=15            # Max chunks from direct BM25 search
RETRIEVAL_RERANKER_POOL=30         # Pre-reranker candidate pool size
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
| `POST` | `/manage/chat` | Conversational knowledge management (add/edit/delete) |
| `GET` | `/manage/history` | List chatbot change history |
| `POST` | `/manage/revert/:id` | Revert a chatbot change |
| `GET` | `/documents` | List documents |
| `DELETE` | `/documents/:id` | Delete document and its knowledge |
| `GET` | `/nodes` | Get knowledge tree |
| `GET` | `/nodes/health` | Tree health report (empty/low-content/missing-embedding nodes) |
| `GET` | `/nodes/search?q=` | Search chunks by content, grouped by node |
| `PUT` | `/nodes/:id` | Update node (name, summary, parent, description) |
| `DELETE` | `/nodes/:id` | Delete node (re-parents children) |
| `GET` | `/decisions` | List pending KP decisions (filterable by action type) |
| `GET` | `/schema` | Get schema nodes as hierarchical tree |
| `POST` | `/schema/import` | Import schema from JSON |
| `GET` | `/schema/export` | Export schema as JSON |
| `GET` | `/schema/health` | Tree health stats and General node monitoring |
| `POST` | `/schema/reclassify` | Reclassify General KPs to better-matching nodes |
| `GET/PATCH` | `/schema/settings` | Get or update mapping mode / strictness / routing |
| `GET/POST` | `/schema/templates` | List or create global schema templates |
| `POST` | `/schema/templates/:id/apply` | Apply a template to the current dataset |
| `GET/PATCH` | `/prompts` | List or update per-dataset prompt overrides |
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
  middleware/       Request ID, etc.
  db/              SQLite schema, migrations, repositories
  ingest/          Document parsing → KP extraction → node mapping
  embedding/       Vector embedding (OpenAI or Gemini)
  query/           Retrieval pipeline (BM25 + vector + hierarchy)
  kg/              Knowledge graph reasoning, Q&A, tree routing
  manage/          Conversational knowledge management (intent → action)
  prompts/         Prompt defaults, per-dataset prompt manager
  routes/          REST API route handlers (16 modules)
  utils/           LLM abstraction, logger, error classes, query helpers, validation
public/
  app.js           ES module entry point
  modules/         10 feature modules (ask, tree, ingest, manage, datasets, settings, ...)
  index.html       SPA shell
  styles.css       Full theme (light/dark, mobile-responsive)
docs/
  openapi.yaml     OpenAPI 3.0 specification (108 operations)
```

---

## Changelog

### v3.2.0 — Node-First Retrieval & Test Run Persistence

**Node-First Retrieval Strategy**
- **New default retrieval strategy** — `nodeFirstRetrieve()` finds the best nodes directly via hybrid recall (BM25 + vector + alias + doc-title, one pass), then expands locally (ancestors, siblings, descendants). Replaces the top-down beam-search tree walk as the default, avoiding error propagation at each depth level.
- **Rank-based score calibration** — `hybridRecallNodes()` RRF scores (0-0.1 range) normalized to 0-2.0 via rank decay (`1.0 - rank * 0.12`), compatible with downstream `applyHierarchicalScoring()`.
- **Tiered chunk limits** — top seed node gets 15 chunks, ranks 1-4 get 8, ranks 5-7 get 5. Balances depth on best matches with breadth across weaker ones.
- **Quality-aware fallback** — compound rule (`isNodeFirstResultWeak()`) checks chunk count, distinct node diversity, top score strength, and doc-title alignment. When weak, falls back to full direct search (doc-title + BM25 + keyword-tags + LIKE). When strong, skips direct search entirely.
- **Strategy toggle** — `retrieval_strategy` setting (`node_first` | `top_down`) in schema settings API and frontend UI. Top-down preserved as user-selectable option.
- **`seed_node` source type** — new source boost (1.0) in `applyHierarchicalScoring()` for node-first chunks, with `hierarchy_relation: 'direct'` tagging.
- **Extracted `_exploreDescendants()` helper** — shared by both `hierarchicalRetrieve()` and `nodeFirstRetrieve()`, no behavior change to existing code.

**Test Run Persistence**
- **Persistent test runs** — new `test_runs` and `test_run_items` tables store execution history with per-item metrics (confidence, latency, citation count, pass/fail).
- **9 new test endpoints** — `GET/POST/DELETE /tests/runs`, `GET /tests/runs/:id`, `PUT /tests/runs/:id/finish`, `POST /tests/runs/:id/items`, `PUT /tests/runs/:id/items/:itemId`, `PUT /tests/runs/:id/baseline`, `GET /tests/env`.
- **Test UI redesign** — 3-section tabs (Runner, History, Manage) with progress bar, dashboard stat cards, filter toolbar, and run history cards with pass-rate visualization.
- **Tests module extraction** — ~1,900 lines moved from `settings.js` to dedicated `modules/tests.js` for maintainability.

**Other**
- **NodeRepo fix** — `MAX(uploaded_at)` replaces `MAX(created_at)` in chunk aggregation for correct node last-updated timestamps.
- **Schema version bump** — v3 adds `suite`, `tags_json`, `priority` columns to `test_cases` table.

**Files changed:** 12 modified + 1 new (`public/modules/tests.js`)

### v3.1.2 — Retrieval Pipeline Bug Fixes

- **Feedback boost score resolution** — `applyFeedbackBoost()` now reads `hierarchical_score` / `relevance_score` instead of always falling back to 0.5 when `score` is absent; fixes ranking compression that affected every query
- **Stale feedback score reset** — `recomputeFeedbackScores()` handles the empty-set case correctly; previously `NOT IN (NULL)` evaluated to UNKNOWN in SQLite, leaving stale scores permanently non-zero
- **Frontend confidence tracking** — feedback submissions now include `confidenceAtAnswer` from the query result, populating the previously-empty `confidence_at_answer` column for calibration
- **Reranker candidate pool** — pre-reranker slice now uses `RETRIEVAL_RERANKER_POOL` (default 30, env-configurable) instead of `maxChunks`, giving the reranker 50% more candidates to select from

**Files changed:** 5 modified

### v3.1.1 — Scoring Simplification & Feedback Deferral

- **Retrieval pipeline simplification** — Removed 2 redundant scoring steps from `handleSimpleLookup()`: doc-scope pre-boost (invisible to reranker) and term-overlap re-sort (overrode reranker output). Doc-scope signal folded into the reranker as a 4th heuristic signal alongside keyword, BM25 rank, and embedding. Pipeline reduced from 10+ steps to 8.
- **Deferred feedback writes** — `recordFeedback()` no longer updates `feedback_score` or `feedback_count` on chunks immediately. Both columns are now written exclusively by the learning cycle's `recomputeFeedbackScores()` (every 6h), eliminating the sawtooth between naive accumulation and periodic decay recomputation. `feedback_count` now reflects events within the active 90-day decay window.
- **Frontend confidence split** — Execution summary now shows "Retrieval: X%" and "Grounding: Y%" instead of a single "Confidence: Z%". Confidence badge tooltip expanded to include both split values. Combined score remains as the badge text.
- **Documentation sync** — Updated `INGESTION_AND_RETRIEVAL_GUIDE.txt`, `docs/RETRIEVAL_FLOW.md`, and `README.md` to reflect unified merge (replaces supplement strategy), 10-stage pipeline (added `stageReclassifyGeneral`), 4-signal reranker, deferred feedback, and new env vars (`INGEST_AUTO_EMBED`, `RETRIEVAL_MAX_*`).

**Files changed:** 8 modified (−132 lines, +73 lines)

### v3.1.0 — Architectural Fixes

Three-phase release addressing data integrity, knowledge quality, and ingestion fidelity.

**Phase 1: Data Integrity**
- **PDF column detection** — `parsePdfFile()` now collects text items with X/Y coordinates, detects multi-column layouts by analysing X-gaps (> 4× median char width), and reconstructs columns separately instead of interleaving. Single-column PDFs produce identical output (no regression).
- **Feedback score bounds + decay** — `feedback_score` clamped to [-1.0, 1.0] on every update. Learning cycle (every 6h) recomputes all cached scores from raw feedback events with exponential time-decay (half-life 60 days, 90-day window). `checkKnownIssues` sensitivity lowered from `negRate > 0.6` to `negRate > 0.4 OR negative_count >= 5`. Schema v2 migration clamps existing out-of-bounds values.

**Phase 2: Knowledge Quality**
- **General node cap + reclassification** — When a single document sends >15 KPs to "General", excess sub-grouped by subtopic or doc title (e.g. "General — HR Policy"). New `stageReclassifyGeneral` pipeline stage auto-moves KPs to better-matching nodes (Dice >= 0.6) or logs suggestions (0.4-0.6). New `GET /schema/health` and `POST /schema/reclassify` endpoints for monitoring and manual trigger.
- **Confidence split** — `calculateConfidence` now returns `retrieval_confidence` (source quality) and `answer_groundedness` (answer faithfulness) as separate signals alongside the combined `score`. Stricter hallucination detection: if <30% of answer values (numbers, dates, currency) appear in source chunks, groundedness capped at 0.25. "No answer" floor: phrases like "not found" / "cannot find" cap both scores at 0.10. Removed `isSpecificQuery × 1.08` boost and `isVagueQuery × 0.92` penalty (rewarded/punished question format, not answer quality). `confidence_at_answer` now stored with feedback events for future calibration.
- **Scoring observability** — Per-chunk `_scoring` object tracks `initial_relevance`, `feedback_adj`, `learned_penalty`, `doc_boost`, and `rerank` breakdown at each step. New `src/query/scoringConfig.js` centralises all 27+ scoring constants. Trace output includes "Scoring Breakdown" (top-10 chunks with full scoring detail) and "Retrieval Sources" (per-source counts + overlap).
- **Unified retrieval** — Direct BM25 and hierarchical tree search merged as equal peers (replaces supplement strategy). Configurable per-source caps via `RETRIEVAL_MAX_HIERARCHICAL` and `RETRIEVAL_MAX_DIRECT` env vars (default 15 each). Dedup collisions keep max score and union provenance tags (`retrieval_source: ['hierarchical', 'direct']`). Reranker selects top 20 from the merged pool.

**Phase 3: Ingestion Quality**
- **Temporal detection expanded** — 18 new temporal patterns: supersede, deprecate, expire, obsolete, replace, amend, rescind, withdrawn, version markers, "valid through/until", CJK signals (已废止, 生效日期, 有效期至). Sibling-node version scan: when within-node Dice < 0.55, scans up to 5 sibling nodes (same parent) with Dice >= 0.75 to catch facts that drifted to neighbouring topic nodes.
- **Segmentation fidelity** — `detectTables()` now runs BEFORE segmentation; table boundaries become no-break zones that the splitter will not cut through. Heading-boundary awareness: prefers breaking just before section headings in the 50-100% window. CJK overlap increase: when text is >30% CJK characters, overlap widens from 300 to 600 chars.
- **LLM call reduction** — New `generateAliasesBatch()` batches up to 5 nodes per LLM call (5 calls → 1). `INGEST_SKIP_ALIASES=true` env var skips alias generation entirely (useful for vector-routing datasets). Pipeline stages re-ordered: reclassify → canonicalize → orphan cleanup.

**Files changed:** 16 modified + 1 new (`src/query/scoringConfig.js`)

### v3.0.0
- **Frontend Modularization** — split monolithic 8,200-line `app.js` into 10 ES modules under `public/modules/`; thin entry point with `<script type="module">`; shared state via imports; function registry for cross-module calls without circular dependencies
- **Security Hardening** — `helmet` middleware (HSTS, X-Frame-Options, X-Content-Type-Options, DNS prefetch control); `express-rate-limit` (120 req/min general, 20 req/min for LLM endpoints); magic byte file validation for PDF/DOCX/XLSX; orphaned upload cleanup (24h TTL, runs at startup + every 6h); sanitized error messages in production mode
- **Structured API Errors** — new `ApiError` class with typed error codes; all 16 route files return `{ error: { code, message, details? } }` format; `X-Request-ID` header on every response; input validation via `requireBody()`/`requireQuery()` helpers
- **Retrieval Quality** — query result cache (5-min TTL, 200 entries); skip LLM classification when pattern confidence ≥0.85 (saves 2-3s/query); consolidated citation LLM calls from 4 sequential to 2 max; early cross-doc chunk pre-boost before reranking; query-specific confidence (fact queries boosted, vague penalized); recency signal (15% weight, 2-year decay); centralized `queryHelpers.js` deduplicates numeric/negation/entity patterns across 3 files
- **Ingestion Quality** — paragraph fallback capped at `min(40, kpCount/3)` to prevent DB bloat; fuzzy match (Dice ≥0.85) in node creation UNIQUE constraint recovery; batched keyword merging (one write per node, not per KP); sibling scan limited to 50 (fixes O(n²) scaling); CJK heading detection for `【一】` bracket and `1)` parenthesis patterns; checkpoint saved before batch processing (not after); table KP cross-dedup against paragraph fallbacks
- **Accessibility** — ARIA roles/labels on navigation, tabs, modals, toast, inputs; `role="dialog"` + `aria-modal` on all overlays; `aria-live="polite"` for dynamic content; `:focus-visible` outlines; confidence badge text indicators (high/med/low)
- **Custom Confirm Modals** — replaced all 18 native `confirm()`/`prompt()` calls with styled async modals; danger styling for destructive operations; Escape key dismissal
- **Keyboard Shortcuts** — Ctrl/Cmd+K focuses search; Ctrl/Cmd+Enter submits forms; Escape closes modals/panels
- **Mobile Responsiveness** — 480px breakpoint for small phones; 44px minimum tap targets; safe-area padding for soft keyboard; single-column layouts on narrow screens
- **WebSocket Reconnection Banner** — sticky warning banner when connection lost; shows reconnection state; manual Reconnect button when retries exhausted
- **Tree Undo** — tree mutations (move, rename, delete) log to audit_log with `audit_id` returned to frontend; undo toast with one-click revert
- **Progress Improvements** — pipeline stage tooltips explaining each step; elapsed time display; ETA estimation based on progress %
- **Developer Experience** — `.env.example` with all 28 env vars documented; `npm test` wired to test-runner; `npm run lint` via ESLint 10 (0 errors); GitHub Actions CI pipeline; OpenAPI 3.0 spec (4,540 lines, 108 operations); schema version tracking in each dataset DB
- **AbortController for API Requests** — duplicate requests to same endpoint auto-cancelled; silent abort handling; opt-out via `dedupe: false` for polling
- **Prompt Search** — filter 33 prompt templates by name or description in Settings
- **Copy-to-Clipboard Fallback** — textarea-based fallback for non-HTTPS environments
- **Error Toast Persistence** — error toasts persist 8 seconds (was 3) with dismiss button
- **Settings Parallel Loading** — stats, prompts, and config load via `Promise.all` instead of sequential

### v2.10.0
- **Answer Quality Hardening** — answer-source alignment check with regeneration on <30% alignment; source pre-summarization for 5+ sources; confidence-answer grounding combines term-level (50%) and value-level (50%) checks; aggregation queries now return confidence scores; `ANSWER_MODEL` env var for dedicated answer generation model
- **Smart Reranking** — cross-encoder weighted reranking (keyword 30% / BM25 20% / embedding 50%); adaptive score-gap cutoff (keep within 40% of top score); query-type aware boosts for numeric, entity, and negation queries
- **Follow-up Query Context** — per-dataset query session (last 3 queries, 10-min TTL); detects follow-up patterns ("tell me more", "what about X", "继续") and expands with prior context
- **Table-aware KP Extraction** — detects tab-separated and markdown `| col |` table structures; converts rows to structured KPs with column headers as topic hints; deduplicates against LLM-extracted KPs
- **PPTX Support** — slide text extraction via raw buffer regex; speaker notes; metadata via `docProps/core.xml`
- **Depth-aware Node Creation** — heading level detection expanded from 3 to 5 levels; subtopic hints with `" > "` separators create intermediate nodes at each level
- **Node Summary Generation** — LLM generates 1-2 sentence summaries for new nodes using up to 8 chunks as context; runs post-ingestion
- **Orphan Node Cleanup** — merges nodes with <2 chunks and no children into parent; opt-in via `INGEST_ORPHAN_CLEANUP=true`
- **Topic Canonicalization** — post-ingest sibling node dedup via `findMergeCandidates()` (name similarity ≥0.60 or content overlap ≥0.50)
- **Tree Virtualization** — lazy child rendering defers subtrees beyond depth 2; materializes on first expand; force-renders all for search
- **Drag-and-Drop Reparenting** — tree nodes are draggable; drop on another node reparents with level recalculation
- **Batch Node Operations** — checkbox selection, bulk move-to and delete via toolbar
- **Tree Health Dashboard** — per-node stats (chunk count, embedding, summary, children); identifies empty, low-content, and unembedded nodes
- **Tree Content Search** — BM25 search across chunks grouped by node, alongside existing node name filter
- **Decision Diff View** — extracts and highlights numeric/currency/date differences between conflicting KPs
- **Action Type Filter** — filter decisions by type (conflicts/replacements/merges/node merges) alongside status filter
- **Bulk Reject** — respects current action filter; shows count in button
- **Embedding Coverage Indicator** — always-visible progress bar with color coding in Settings header
- **Query Favorites** — localStorage-based star toggle; favorites section above recent queries
- **WebSocket Status Indicator** — green/amber/red dot in sidebar with connection state
- **Negative Query Handling** — detects "not", "except", "excluding" patterns; penalizes chunks containing negated terms
- **Cross-document Disambiguation** — document-scope filter prevents cross-doc chunk bleed when query names a specific document

### v2.6.0
- Smart conflict detection with LLM-confirmed value conflicts
- Auto-embedding after ingest and chatbot operations
- Node deletion with child re-parenting
- Chatbot improvements

### v2.5.0
- **Conversational Knowledge Management** — new Manage mode in the Ask tab lets users add, edit, delete, and query knowledge through natural language; LLM classifies intent and extracts structured data (content, topic, old/new values); fast-path regex skips LLM for confirm/cancel/undo/history; session-based confirmation flow for edits and deletes; full change history with per-entry revert; handles empty datasets; bilingual EN/CJK support
- **Per-Dataset Prompt System** — every LLM prompt is now customisable per dataset via a new Prompts settings panel; variable injection, reset to default, prompt catalog with categories
- **Vector Tree Routing** — third routing mode alongside keyword and LLM; uses embedding cosine similarity to score node relevance during tree traversal
- **Prompt CSS theme fix** — prompt settings UI now uses CSS variables for full light/dark theme compatibility
- **Embedder LRU cache** — fixed cache invalidation issue in embedding pipeline
- **Retrieval tuning** — answer generation temperature lowered to 0.1; citation generator prompt improved to reduce false "not found" answers

### v2.4.0
- **LLM Tree Routing** — optional mode where Gemini scores node relevance 0-10 during tree traversal; LRU cache (200 entries); batched scoring (40 nodes/call); all query handlers (simple, reasoning, aggregation) now use hierarchical retrieval
- **Retrieval quality tuning** — maxChunks reduced to 12; reranker score-gap cutoff; document-scope filter prevents cross-doc bleed; context window limits raised (400/12000); single-digit number extraction fixed
- **Multi-dataset fixes** — beam search explores all root nodes; confidence NaN guard; activity logging

### v2.3.4
- Schema UI polish, activity logging, rate-limit defaults, CJK heading detection

### v2.3.3
- Tree diagram view + reliability fixes

### v2.3.2
- Reliability hardening — 8 fixes for robustness

### v2.3.1
- Schema node CRUD, alias support, answer retry, LLM reranker, schema branch routing

### v2.3.0
- **Guided Tree Schema** — pre-define dataset structure via JSON import; KPs map to schema nodes using heuristic scoring (name/description/keyword overlap) plus batched LLM disambiguation; soft/hard strictness modes; global template library stored in `registry.db`
- **Schema panel** — new collapsible panel in the Tree tab for import/export, settings, and template management; mode badge shows current mapping mode at a glance
- **Keyword accumulation** — KP keywords written back to schema nodes on every ingest, boosting BM25 recall for those nodes over time
- **Node detail** — schema nodes marked with pin badge; description and keyword chips shown inline
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
