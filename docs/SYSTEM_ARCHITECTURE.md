# TreeKB kg-mvp — Complete System Architecture

> Implementation-level reference. Every constant, SQL query, LLM prompt, threshold, and
> algorithm is documented verbatim so the system can be rebuilt from this document alone.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Document Ingestion Pipeline](#2-document-ingestion-pipeline)
   - 2.1 Upload & Text Extraction
   - 2.2 Metadata Extraction
   - 2.3 Knowledge Point Extraction (LLM)
   - 2.4 Topical Tree Building
   - 2.5 KP Decision Engine
   - 2.6 Node Merger
3. [Embedding Generation](#3-embedding-generation)
4. [Query & Retrieval Pipeline](#4-query--retrieval-pipeline)
   - 4.1 ask() — Top-level Orchestrator
   - 4.2 Query Classification
   - 4.3 handleSimpleLookup() — 11-Step Pipeline
   - 4.4 handleAggregationQuery()
   - 4.5 Specialist Handlers (Comparison, Recommendation, Reasoning)
5. [Recall Strategies](#5-recall-strategies)
   - 5.1 FTS5 Query Safety — escapeFtsQuery & extractSearchTerms
   - 5.2 BM25 Node Recall
   - 5.3 Vector Recall
   - 5.4 hybridRecallNodes — 5-Stage Orchestration
   - 5.5 hierarchicalRetrieve — Beam Search
   - 5.6 BM25 Node Scoring Formula
   - 5.7 Hierarchical Chunk Scoring
6. [Post-Retrieval Processing](#6-post-retrieval-processing)
   - 6.1 LLM Reranker
   - 6.2 Context Expansion
   - 6.3 Snippet Generation
   - 6.4 Citation Generation
   - 6.5 Confidence Scoring
7. [LLM Integration](#7-llm-integration)
   - 7.1 callLLM() Implementation
   - 7.2 Language Detection
8. [All LLM Prompts (Verbatim)](#8-all-llm-prompts-verbatim)
9. [Database Schema & SQL Queries](#9-database-schema--sql-queries)
   - 9.1 Core Tables
   - 9.2 ChunkRepo — All SQL
   - 9.3 FTS5 Tables
10. [Multi-Dataset Architecture](#10-multi-dataset-architecture)
11. [Key Constants & Thresholds Reference](#11-key-constants--thresholds-reference)

---

## 1. System Overview

TreeKB is a knowledge-graph QA system. Documents are ingested, decomposed into atomic
**Knowledge Points (KPs)**, stored in a topical **node tree**, and made searchable via
BM25 full-text search + optional vector embeddings.

Queries flow through: classification → retrieval (tree beam search + direct BM25) →
LLM reranker → context expansion → LLM answer generation with inline citations.

### Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM), Express |
| Database | SQLite via better-sqlite3 |
| Full-text search | SQLite FTS5 (BM25) |
| Vector search | SQLite custom (float32 BLOB columns) |
| LLM | OpenAI (gpt-5-nano default) or Google Gemini (gemini-2.0-flash) |
| Embeddings | text-embedding-3-large (3072-dim) or gemini-embedding-001 |
| Frontend | Vanilla JS, no framework |

### File Map (critical paths)

```
src/
  server.js                   — Express entry point, middleware, all API routes
  kg/
    qa.js                     — ask(), handleSimpleLookup(), handleAggregationQuery()
    recallNodes.js            — hybridRecallNodes, hierarchicalRecallNodes orchestrators
    hierarchicalRetrieval.js  — beam search + ancestor/sibling/descendant expansion
    nodeScoring.js            — rankNodes(), decideNode() with BM25 absolute cap
    strategies/
      bm25.js                 — bm25RecallNodes, bm25RecallChunks, simpleContentSearch
      utils.js                — escapeFtsQuery, extractSearchTerms, reciprocalRankFusion
      vector.js               — vectorRecallNodes, vectorRecallChunks
      hierarchy.js            — enrichWithHierarchy, getHierarchicalChunks
  ingest/
    knowledgeExtractor.js     — LLM KP extraction, wordDiceSimilarity
    nodeMapper.js             — buildTopicalHierarchy, autoMapChunks, assignKPToNode
    kpDecisionEngine.js       — resolveKPAction (IGNORE/MERGE/REPLACE/NORMALIZE/STORE)
    nodeMerger.js             — findMergeCandidates, executeMerge for sibling dedup
    cleanupJob.js             — batch KP re-evaluation
  query/
    confidenceScorer.js       — calculateConfidence (6 factors)
    citationGenerator.js      — generateAnswerWithCitations, HTML <cite> output
    chunkExpander.js          — expandChunksWithContext, buildExpandedContext
    reranker.js               — rerankerChunks (LLM 0-10 scoring)
  utils/
    llm.js                    — callLLM(), dual-provider, token tracking
    langDetect.js             — language detection, ALL LLM prompts, getLangInstruction
    logger.js                 — ingestLogger, queryLogger (file + console)
  db/
    db.js                     — Proxy forwarding to AsyncLocalStorage active DB
    activeDb.js               — runWithDb(conn, fn) scopes connection per request
    repositories/
      ChunkRepo.js            — all chunk SQL
      NodeRepo.js             — all node SQL
      DecisionRepo.js         — pending_decisions CRUD
public/
  app.js, index.html, styles.css  — frontend SPA
data/
  registry.db                 — dataset registry (never proxied)
  datasets/<uuid>.db          — per-dataset SQLite files
```

---

## 2. Document Ingestion Pipeline

### 2.1 Upload & Text Extraction

**Endpoint:** `POST /upload`

1. Multer stores file to `data/uploads/` (or temp).
2. Text extracted based on MIME type:
   - `.txt`, `.md` → raw UTF-8 read
   - `.pdf` → `pdf-parse` library → `.text` field
   - `.docx` → `mammoth` library → `.value` (plain text)
3. A `documents` row is inserted with `original_name`, `file_path`, `status='processing'`.
4. Ingest job is enqueued in `jobQueue.js`.

### 2.2 Metadata Extraction

**Function:** `extractMetadata(text, docTitle)` in `src/ingest/metadataExtractor.js`

Calls the LLM with the `metadataExtraction` prompt (see §8). Returns:

```json
{
  "keywords": ["up to 10 keywords"],
  "entities": { "products": [], "organizations": [], "people": [], "locations": [], "dates": [] },
  "chunk_type": "policy|procedure|faq|guide|reference|announcement|report|other",
  "topics": ["max 5 topics"],
  "summary": "one sentence summary",
  "language": "en|zh",
  "authority_level": "policy|sop|training|personal"
}
```

`authority_level` ranking (numeric): `policy=3, sop=2, training=1, personal=0`.

**Fallback:** If no LLM key, `extractKeywords(text)` uses regex word frequency and
`detectAuthorityLevel(text, docTitle)` uses regex heuristics on keywords like "policy", "procedure".

### 2.3 Knowledge Point Extraction (LLM)

**File:** `src/ingest/knowledgeExtractor.js`

#### Constants

```js
const SEGMENT_SIZE    = 5000;   // chars per LLM call
const SEGMENT_OVERLAP = 500;    // overlap between segments (for paragraph boundary snap)
// No KP count cap — extraction is unbounded; the LLM determines granularity
```

#### Step 1 — Segment the text

`splitIntoSegments(text, 5000, 500)`:
1. If `text.length <= 5000`: return `[text]`.
2. Otherwise slide a window forward:
   - `end = min(start + 5000, text.length)`
   - Try to break at a `\n\n` paragraph boundary: if `text.lastIndexOf('\n\n', end) > start + 5000 * 0.6` → snap `end` there.
   - Push `text.slice(start, end)`.
   - `start = max(start+1, end - 500)` (overlap zone).
   - Snap back to next `\n\n` within overlap zone to avoid mid-paragraph starts.

#### Step 2 — LLM extraction per segment

`extractKPsFromSegment(segment, docTitle, lang)`:
- Calls `getPrompt("kpExtraction", lang, docTitle, segment)` (see §8 for full prompt).
- `callLLM({ prompt, temperature: 0.1, taskName: 'kp_extraction' })` — low temperature for determinism.
- Parses response: `text.match(/\[[\s\S]*\]/)` — finds JSON array anywhere (handles preamble/code fences).
- `JSON.parse(jsonMatch[0])` → raw array.
- Empty array throws `"LLM returned empty KP array"`.
- On any error: falls back to paragraph splitting for that segment, tagged `kp_type: "context", confidence: 0.5`.
- A 200ms delay is inserted between segment calls.

LLM returns per-KP objects:
```json
{
  "statement": "Each warranty period is 90 days from purchase date.",
  "kp_type": "rule",
  "topic_hint": "Warranty Policy",
  "subtopic_hint": "Duration",
  "tags": ["warranty", "90-day", "purchase"],
  "confidence": 0.95,
  "source_excerpt": "Each warranty period is 90 days from purchase date."
}
```

Valid `kp_type` values: `fact | rule | definition | procedure | example | context`.

#### Step 3 — Normalise raw KPs

`normaliseKP(raw, index, docTitle, documentId, authorityLevel)`:
- `statement` must be ≥ 10 chars; `kp_type` defaults to `"fact"` if not in valid set.
- `sourceExcerpt = raw.source_excerpt.slice(0, 200)`.
- **Content field:** `content = "${statement}\n${sourceExcerpt}"` when excerpt differs from statement.
  - This preserves exact numbers like "90-day" in the FTS5 index regardless of LLM paraphrasing.
- `keywords = raw.tags.slice(0, 20)`.
- `topic_hint = raw.topic_hint.slice(0, 80)` (default `"General"`).
- `subtopic_hint = raw.subtopic_hint.slice(0, 80)`.
- `confidence = clamp(raw.confidence, 0, 1)` (default `0.8`).
- `source_documents_json = JSON.stringify([{ doc_id, doc_title, excerpt }])`.

#### Step 4 — Cross-segment deduplication

`deduplicateAcrossSegments(kps, threshold=0.9)`:
- For each KP, compute `wordDiceSimilarity(kp.content, existing.content)` against all already-kept KPs.
- Skip if similarity ≥ 0.90.

#### Word Dice Similarity (wordDiceSimilarity)

```
Tokenisation:
  CJK characters → each char is one token  (regex /[\u4e00-\u9fa5]/)
  Latin          → /[a-zA-Z0-9]+/ words, lowercased

Unigram Dice = 2 * |tokensA ∩ tokensB| / (|uniqueA| + |uniqueB|)

Bigram sets: bigrams([t0,t1,t2,...]) = { "t0|t1", "t1|t2", ... }
Bigram Dice  = 2 * |bigramsA ∩ bigramsB| / (|bigramsA| + |bigramsB|)

Final score:
  if |tokensA| < 4 OR |tokensB| < 4:   return unigramDice
  else:                                  return unigramDice*0.3 + bigramDice*0.7
```

#### Step 5 — Cap and re-index

```js
const result = deduped.slice(0, MAX_KPS_PER_DOC).map((kp, i) => ({ ...kp, index: i }));
```

#### Fallback (no LLM)

`extractKPsFromParagraphs(text, docTitle, options)`:
- Split on `/\n{2,}/`, filter paragraphs ≥ 50 chars.
- Each paragraph becomes a KP with `kp_type: "legacy_chunk"`, `confidence: 0.5`.

---

### 2.4 Topical Tree Building

**File:** `src/ingest/nodeMapper.js`

The topical tree is **topic-based** (not document hierarchy). Each KP's `topic_hint` and
`subtopic_hint` determine its position in the tree.

#### Tree Levels

```
root (level=0)
└── topic node (level=1)  ← from KP's topic_hint
    └── subtopic node (level=2)  ← from KP's subtopic_hint (optional)
```

#### Step 1 — Group KPs by topic_hint

`buildTopicalHierarchy(kps)` groups all KPs into topics:
```js
const topicGroups = new Map();  // topic_hint → [kp, ...]
for (const kp of kps) {
  const key = kp.topic_hint || "General";
  topicGroups.get(key)?.push(kp) ?? topicGroups.set(key, [kp]);
}
```

#### Step 2 — Decide if subtopic level is needed

For each topic group, compare all KP subtopic_hints pairwise:
- Compute `wordDiceSimilarity` for every pair of non-empty subtopic hints.
- If any pair has similarity < 0.60, topics are diverse enough → create subtopic nodes.
- If all pairs are similar (≥ 0.60) or all hints are empty → flat structure (all KPs go directly under topic node).

#### Step 3 — findOrCreateTopicNode

`findOrCreateTopicNode(topicName, parentNodeId, level)`:
1. `NodeRepo.bm25Search(escapeFtsQuery(topicName), 10)` — find existing nodes under same parent.
2. Filter to `parent_node_id = parentNodeId`.
3. For each candidate, compute `wordDiceSimilarity(topicName, candidate.name)`.
4. Find `bestSim` and `bestNode`.
5. **Decision thresholds:**

| Condition | Action |
|---|---|
| `bestSim >= 0.40` (TOPIC_MATCH_THRESHOLD) | Reuse existing node |
| `bestSim in [0.35, 0.40)` | Call LLM to confirm (nodeSuggestion prompt) |
| `bestSim < 0.35` | Create new node |

6. **Create new node:**
   ```js
   NodeRepo.insert({ node_id, name, summary, parent_node_id, level });
   NodeRepo.insertFtsText(nodeId, `${name} ${summary}`);
   ```
   `node_id` is a slug: `topicName.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40)`.

#### Step 4 — assignKPToNode

For each KP after tree assignment:
1. Run `resolveKPAction(kp, nodeId, documentId)` (decision engine — see §2.5).
2. Based on action:
   - **IGNORE:** skip.
   - **MERGE:** update `source_documents_json` on existing chunk, skip insert.
   - **REPLACE:** insert new KP, then `ChunkRepo.supersede(oldChunkId, newChunkId)`.
   - **NORMALIZE_THEN_STORE:** kp.content has been mutated to canonical → insert normally.
   - **STORE:** insert via `ChunkRepo.insertKP(...)` + `ChunkRepo.insertFts(chunkId, content)`.
3. After insert: `NodeRepo.touch(nodeId)` to update `updated_at`.

---

### 2.5 KP Decision Engine

**File:** `src/ingest/kpDecisionEngine.js`

`resolveKPAction(kp, nodeId, documentId, options)` — called once per KP per target node.

#### Thresholds

```js
const IGNORE_CONF_THRESHOLD  = 0.35;
const IGNORE_MIN_LENGTH      = 15;      // chars
const MERGE_AUTO_THRESHOLD   = 0.90;   // Dice similarity → auto-merge
const MERGE_QUEUE_THRESHOLD  = 0.70;   // Dice similarity → queue for review
const REPLACE_AUTO_CONF      = 0.85;   // confidence needed for auto-replace
```

#### Boilerplate Patterns (→ IGNORE)

```js
const BOILERPLATE_PATTERNS = [
  /^page\s+\d+(\s+of\s+\d+)?$/i,          // "Page 3 of 12"
  /^chapter\s+\d+/i,                       // "Chapter 4"
  /^\d+\s*\/\s*\d+$/,                      // "3 / 12"
  /^(table of contents|toc)$/i,
  /^last\s+(modified|updated|revised)/i,
  /^(confidential|internal use only|proprietary)$/i,
  /^(header|footer):/i,
  /^\s*[\d]+\s*$/,                          // lone number
];
```

#### Temporal Signal Patterns (→ may trigger REPLACE)

```js
const TEMPORAL_PATTERNS = [
  /\bas\s+of\b/i,
  /\bupdated\b/i,
  /\beffective\b/i,
  /\brevised\b/i,
  /\bnew\b/i,
  /\b(since|from)\s+\d{4}\b/i,
  /\b20\d{2}\b/,                            // any 4-digit year 20xx
];
```

#### Decision Flow (5 Steps)

```
[1] IGNORE checks:
    content.length < 15              → IGNORE "content too short"
    kp.confidence < 0.35             → IGNORE "low confidence"
    isBoilerplate(content)           → IGNORE "boilerplate content"

[2] Similarity scan:
    ChunkRepo.findSimilarInNode(nodeId, content, 8, excludeChunkId)
    → compute wordDiceSimilarity for each candidate
    → track bestSim + bestCandidate

    bestSim >= 0.98 AND candidates.length >= 3
                                     → IGNORE "exact duplicate (Dice X.XX)"

    bestSim >= 0.90 (MERGE_AUTO_THRESHOLD):
      • append doc to existing chunk's source_documents_json (if not already there)
        via ChunkRepo.updateSourceDocuments(bestCandidate.id, JSON.stringify(merged))
      • return MERGE { chunkId: bestCandidate.id }

    bestSim in [0.70, 0.90) (MERGE_QUEUE_THRESHOLD):
      • DecisionRepo.insert({ action: "merge_suggestion",
          incoming_chunk_id: null, target_chunk_id: bestCandidate.id,
          node_id, confidence, reason, similarity_score, incoming_preview, target_preview })
      • return STORE (queued=true)  ← store incoming KP anyway so it's not lost

[3] Temporal/authority REPLACE:
    bestCandidate exists AND detectTemporalSignal(content):
      incomingRank = authorityRank(kp.authority_level)
        // policy=3, sop=2, training=1, personal=0
      existingRank = authorityRank(bestCandidate.authority_level)
      IF incomingRank >= existingRank AND kp.confidence >= 0.85:
        → REPLACE { chunkId: bestCandidate.id }
          (caller inserts new KP, then calls ChunkRepo.supersede(oldId, newId))
      ELSE:
        → DecisionRepo.insert({ action: "replace_suggestion", ... })
        → STORE (queued=true)

[4] Normalize (soft similarity + LLM rewrite):
    bestSim >= 0.40 AND useLLM:
      normalizeWithLLM(content, bestCandidate.content_clean)
      → LLM rewrites both into canonical statement
      → if normalized.confidence >= 0.70:
          kp.content = normalized.canonical  (mutate in-place)
          return NORMALIZE_THEN_STORE

[5] Default:
    return STORE "no match found — store as new KP"
```

#### normalizeWithLLM Prompt (verbatim)

```
Two knowledge statements express the same fact but use different phrasing.
Rewrite them as a single canonical statement that is precise, complete, and neutral.

Statement A: "<kpContent.slice(0,400)>"
Statement B: "<existingContent.slice(0,400)>"

Return JSON only: {"canonical": "...", "confidence": 0.0-1.0}
```

- `callLLM({ prompt, temperature: 0.1, maxOutputTokens: 300, taskName: 'kp_normalize' })`
- Parses `text.match(/\{[\s\S]*\}/)`.
- Returns `null` on failure (falls through to STORE).

---

### 2.6 Node Merger

**File:** `src/ingest/nodeMerger.js`

After ingest, sibling topic nodes that are too similar are merged:

- `findMergeCandidates(parentNodeId)`: gets all children of parent, computes pairwise `wordDiceSimilarity` on node names + summaries.
- `executeMerge(targetNode, sourceNode)`: moves all chunks from `sourceNode` to `targetNode` (SQL UPDATE chunks SET node_id = target WHERE node_id = source), deletes `sourceNode`.
- Threshold: siblings with name+summary Dice similarity ≥ 0.75 are candidates.

---

## 3. Embedding Generation

**File:** `src/embedding/embedder.js`

Embeddings are **NOT** generated automatically on ingest. Must be triggered manually via `POST /embeddings/sync`.

### Constants

```js
const EMBEDDING_DIMENSION = 3072;    // both text-embedding-3-large and gemini-embedding-001
const MAX_BATCH_SIZE      = 100;     // chunks per API call
const MAX_INPUT_LENGTH    = 2048;    // chars — text truncated before embedding
const RATE_LIMIT_DELAY_MS = 100;     // ms between batch calls
const CACHE_MAX_SIZE      = 1000;    // in-memory LRU cache entries
```

### Dual Provider

**OpenAI:**
```js
client.embeddings.create({
  model: 'text-embedding-3-large',
  input: texts,                        // array of strings
  encoding_format: 'float'
});
// response.data[i].embedding → Float32Array stored as BLOB
```

**Gemini:**
```js
ai.models.embedContent({
  model: 'gemini-embedding-001',
  contents: texts,
  config: { taskType }
});
// taskType: 'RETRIEVAL_DOCUMENT' for storage, 'RETRIEVAL_QUERY' for queries
```

### Cache

In-memory LRU Map: `hash(text) → Float32Array`. Max 1000 entries (oldest evicted on overflow).

### Vector Storage

Embeddings stored as raw `BLOB` (IEEE 754 float32 × 3072) in columns:
- `nodes.embedding` — node name+summary embedding
- `chunks.embedding` — chunk content embedding

Vector similarity computed in JS (dot product + magnitude) since SQLite has no native vector operations.

---

## 4. Query & Retrieval Pipeline

### 4.1 ask() — Top-level Orchestrator

**File:** `src/kg/qa.js`, function `ask({ query, queryScope, options })`

#### Options (with defaults)

```js
{
  useClassification:       true,   // LLM query type classifier
  useHybridSearch:         true,   // BM25 + vector hybrid
  useDecomposition:        true,   // decompose complex queries into sub-queries
  useReranking:            true,   // LLM reranker pass
  useCitations:            true,   // inline [n] citations in answer
  includeRelatedQuestions: true,
  trace:                   false,  // append trace[] to response
  forceQueryType:          null,   // bypass classifier
  topK:                    10,     // top nodes/chunks
  maxChunks:               20,     // max context chunks
  minConfidence:           0.0,
  hybridAlpha:             0.5,    // 0=BM25 only, 1=vector only
  rerankerThreshold:       0.3,    // minimum reranker score (0-1)
  contextWindow:           2,      // neighboring chunks on each side
  temperature:             0.3     // LLM answer temperature
}
```

#### Execution Flow

```
1. Validate query (non-empty string)
2. recordQuery(query, { queryType: 'pending' })
3. [optional] decomposeQuery(query)
    → if isComplex: executeDecomposedRetrieval(subQueries)
4. classifyQuery(query, { useLLM: true })
    → LLM returns one of:
      simple_lookup | comparison | recommendation | reasoning | aggregation
5. Route:
    comparison     → handleComparisonQuery()
    recommendation → handleRecommendationQuery()
    reasoning      → handleReasoningQuery()
    aggregation    → handleAggregationQuery()
    simple_lookup  → handleSimpleLookup()   (default)
6. Attach trace if enabled, return response
```

---

### 4.2 Query Classification

**File:** `src/query/classifier.js`

Calls LLM with `queryClassification` prompt (see §8). Returns:

```json
{
  "query_type": "simple_lookup|comparison|recommendation|reasoning|aggregation",
  "confidence": 0.0-1.0,
  "entities": ["ProductA", "ProductB"],
  "criteria": ["price", "performance"],
  "reasoning": "brief explanation"
}
```

Classification examples from prompt:
- `"What is the price of X?"` → `simple_lookup` (single entity, direct fact)
- `"Compare A and B"` → `comparison` (two entities, criteria)
- `"Which product is better for heavy loads?"` → `recommendation` (needs suggestion)
- `"Why does X fail at high temp?"` → `reasoning` (causal chain)
- `"What product lines do we have?"` → `aggregation` (enumerate many)

---

### 4.3 handleSimpleLookup() — 11-Step Pipeline

**File:** `src/kg/qa.js`, function `handleSimpleLookup(query, queryScope, useHybridSearch, trace, enhancedOptions)`

Default parameters extracted from `retrievalOptions`:
```js
topK = 30, maxChunks = 20, minConfidence = 0.0, hybridAlpha = 0.5,
rerankerThreshold = 0.3, contextWindow = 2, temperature = 0.3
```

---

#### PRE-STEP: Build Query Variants

```js
buildRetrievalQueryVariants(query, { maxVariants: 6, useExpansion: true, useAliasPivot: true })
```

Returns an array of variant objects:
```js
[{ text: "original query", weight: 1.0, lang: "en", sources: ["original"] }, ...]
```

Variants include: original query, keyword extraction, alias expansion, CJK character variants, etc.
Falls back to `[{ text: query, weight: 1, lang, sources: ["original"] }]` on error.

---

#### STEP 0: Direct Chunk Retrieval

Runs **first** — before tree navigation — to ensure content is found even when tree topology fails.

```
For each variant v in retrievalQueryVariants.slice(0, 5):
  perVariantLimit = max(8, ceil(maxChunks / min(numVariants, 3)))

  Sub-search A: searchChunksByDocTitle(v.text, perVariantLimit)
    → regex extracts quoted doc name from query (e.g., 'from "Document X"')
    → ChunkRepo.searchByDocTitle(term, limit)
    → score: exact match=1.0, LIKE match=0.8, else=0.5
    → weightedScore = score * variant.weight

  Sub-search B: bm25RecallChunks(v.text, perVariantLimit)
    → escapeFtsQuery(v.text) → ChunkRepo.bm25Search(safeQuery, limit)
    → normalize: normalizedBm25 = r.bm25 / maxBm25InBatch
    → weightedScore = normalizedBm25 * variant.weight

  Sub-search C: simpleContentSearch(v.text, perVariantLimit)
    → extractSearchTerms(v.text) → ChunkRepo.simpleContentSearch(terms, limit)
    → LIKE %term% OR conditions on content_clean

All results merged via directChunkMap (Map<chunk.id, chunk+metadata>):
  upsertDirectChunk(chunk, source, score, variant):
    if existing: relevance_score = max(old, weightedScore); append to sources[], query_variants[]
    if new: insert { id, content, doc_title, node_id, authority_level,
                     source, sources: [source], query_variants: [v.text],
                     relevance_score: weightedScore }

directChunks = [...directChunkMap.values()].sort by relevance_score DESC
```

---

#### STEP 1: Hierarchical Tree Retrieval

```js
hierarchicalRetrieve(query, {
  maxChunks,              // default 20
  beamWidth: 3,           // explore top 3 nodes per depth level
  maxDepth: 5,
  includeAncestors: true,
  includeSiblings: true,
  includeDescendants: true,
  queryVariants: retrievalQueryVariants,
  ancestorLevels: 2,
  siblingNodesPerSeed: 3,
  descendantDepth: 2,
  descendantNodesPerSeed: 5
})
```

**Internal beam search (`navigateTreeTopDown` in `hierarchicalRetrieval.js`):**

1. Start at root children: score each with `rankNodes()`.
2. Root level: no slice (all root children explored).
3. Depth ≥ 1: keep top `beamWidth * 2 = 6` nodes.
4. For each beam node, score its children:
   `childScore = (childScore * 0.72 + parentScore * 0.28) * 0.96^depth`
5. Continue until depth 5 or no more children.

**`enrichWithAncestorContext`:** For each seed node, fetch up to 2 ancestor levels.
Fetch 2 chunks each. Apply `decay = 0.82^level`.

**`expandWithSiblings`:** For each seed node, fetch siblings (same parent).
Filter: `siblingScore >= 0.15`. Fetch 3 chunks per sibling. Apply `siblingDecay = 0.78`.

**`applyHierarchicalScoring`** (per chunk — see §5.7 for full formula).

Returns: `{ chunks: [...], nodes: [...], paths: [...], sources: {...} }`.

---

#### STEP 2: Merge Chunk Pools

```js
const allChunks = [];
const seenChunkIds = new Set();

// Hierarchical chunks first (carry tree-context metadata)
for (const chunk of hierarchicalChunks) {
  if (!seenChunkIds.has(chunk.id)) {
    seenChunkIds.add(chunk.id);
    allChunks.push({ ...chunk, retrieval_source: 'hierarchical' });
  }
}

// Direct BM25 — add any not already present
for (const chunk of directChunks) {
  if (!seenChunkIds.has(chunk.id)) {
    seenChunkIds.add(chunk.id);
    allChunks.push({ ...chunk, retrieval_source: 'direct' });
  }
}

usedFallback = (hierarchicalChunks.length === 0);
// When usedFallback: response includes message "Could not locate an exact node..."
```

---

#### STEP 3: Sort and Cap

```js
allChunks.sort((a, b) => {
  const scoreA = a.hierarchical_score || a.relevance_score || 0;
  const scoreB = b.hierarchical_score || b.relevance_score || 0;
  return scoreB - scoreA;
});
let chunks = allChunks.slice(0, maxChunks);  // default 20
```

---

#### STEP 4: Feedback Boosting

```js
chunks = applyFeedbackBoost(chunks);
```

Reads stored feedback signals (thumbs up/down) from the `query_feedback` table and applies
a multiplicative boost to chunks that previously received positive ratings for similar queries.

---

#### STEP 5: LLM Reranker

```js
// Triggers when chunks.length > 1 (threshold lowered from > 5 to > 1)
if (useReranking && chunks.length > 1) {
  const rerankedChunks = await rerankerChunks(query, chunks, {
    topK: maxChunks,
    minScore: rerankerThreshold   // default 0.3
  });
  if (rerankedChunks.length > 0) chunks = rerankedChunks;
}
```

`rerankerChunks(query, chunks, { topK, minScore=0.3 })`:
1. Format passages: `chunks.map((c, i) => "[${i+1}] ${content.slice(0,300)}")`.
2. Call LLM with `reranking` prompt (see §8): returns JSON integer array `[8,3,9,5,...]`.
3. Normalize: `score = rawScore / 10`.
4. Filter: `score >= minScore`.
5. Return sorted by score descending, capped at `topK`, with `rerank_score` field added.

---

#### STEP 6: Context Expansion

```js
const expandedChunks = expandChunksWithContext(chunks, {
  windowBefore: contextWindow,   // default 2
  windowAfter: contextWindow     // default 2
});
```

For each chunk, fetches `windowBefore` chunks before and `windowAfter` chunks after from the
**same document** by `chunk_index` (see §6.2 for full details).

---

#### STEP 7: Snippet Generation

```js
const chunksWithSnippets = generateSnippetsForChunks(chunks, query, { maxLength: 150 });
const topSnippets = chunksWithSnippets
  .filter(c => c.snippetScore > 0)
  .sort((a, b) => b.snippetScore - a.snippetScore)
  .slice(0, 3)
  .map(c => ({ text: c.snippet, html: c.snippetHtml, source: c.doc_title, chunkId: c.id }));
```

---

#### STEP 8: Fact Retrieval

```js
const factResult = getFactsForQuestion(query, { maxFacts: 10, maxEvidence: 5 });
if (factResult.facts.length > 0) {
  retrievedFacts = factResult.facts;
  factsContext = `\n\n[Extracted Facts]\n${factResult.context.facts}`;
}
```

`getFactsForQuestion` queries the `entity_facts` table using BM25 FTS on fact content,
filtered to facts relevant to query terms.

---

#### STEP 9: Build Context String

```js
const chunkContext = buildExpandedContext(expandedChunks, {
  includeNeighbors: true,
  maxTotalLength: 7000      // max chars for chunk portion
});
const context = chunkContext + factsContext;
```

---

#### STEP 10: LLM Answer Generation

**With citations (default `useCitations=true`):**

```js
const citationResult = await generateAnswerWithCitations(query, context, chunks, {
  lang: getEffectiveLang(query),
  temperature,
  maxSources: chunks.length
});
llmResponse = {
  final_answer:      citationResult.answer,         // plain text with [n] markers
  final_answer_html: citationResult.answer_html,    // HTML with <cite> elements
  conditions: [],
  citations: citationResult.citations,
  conflicts: [],
  missing_info: []
};
```

**Without citations (`useCitations=false`):**
```js
llmResponse = await callLLMAnswer({ query, nodeId, nodeName, context });
// Returns JSON: { final_answer, conditions, citations, conflicts, missing_info }
```

---

#### STEP 11: Confidence Scoring

```js
const confidenceResult = calculateConfidence({
  chunks,
  nodes: hierarchicalNodes.slice(0, 3),
  query,
  answer: llmResponse.final_answer,
  queryType: QUERY_TYPES.SIMPLE_LOOKUP
});
```

See §6.5 for full confidence scoring algorithm.

---

#### Return Value Structure

```json
{
  "query_type": "simple_lookup",
  "action": "answer",
  "chosen": { "node": {...}, "score": 0.82 },
  "confidence": 0.71,
  "confidence_details": {
    "score": 0.71, "level": "medium",
    "factors": { "source_coverage": 0.72, "source_agreement": 0.55, ... },
    "explanation": { "issues": [...], "strengths": [...], "summary": "..." }
  },
  "top": [{ "node": {...}, "score": 0.82, "sources": ["bm25_node"] }],
  "llm_response": {
    "final_answer": "The warranty period is 90 days [1].",
    "final_answer_html": "...warranty is 90 days <cite data-citation='1' data-chunk-id='42'>[1]</cite>.",
    "conditions": [],
    "citations": [{ "num": 1, "chunk_id": "42", "text": "..." }],
    "conflicts": [],
    "missing_info": []
  },
  "chunks_used": 8,
  "snippets": [{ "text": "...", "html": "...", "source": "Warranty Policy", "chunkId": 42 }],
  "citations": { "citations": [...], "sources": [...] },
  "related_questions": ["How do I claim warranty?"],
  "facts": [{ "content": "...", "type": "attribute", "confidence": 0.9, "entities": [] }],
  "tree_paths": [["root", "Warranty", "Duration"]],
  "retrieval_sources": { "hierarchical": 12, "direct": 6 },
  "retrieval_options": { "topK": 30, "maxChunks": 20, ... },
  "message": "Could not locate an exact node..."  // only present if usedFallback=true
}
```

---

### 4.4 handleAggregationQuery()

Used for "What X do we have?" type queries that need to enumerate across multiple nodes.

```
1. hierarchicalRecallNodes(query, 15, { useHierarchy: true, useAliases: true })
   → returns top 15 candidate nodes with scores

2. AGGREGATION_TOP_N = 8
   → take top 8 nodes

3. For each of the 8 nodes:
   getChunksForNode(nodeId)  → all active chunks (no row limit)
   Push to allChunks with node_id, node_name

4. Also run: searchChunksByDocTitle(query, 30)
   → append chunks not already in allChunks (by id)

5. Also run: enhancedRetrieval(query, {
     useEntities: true, useFacts: true, useHierarchy: true,
     useMultiHop: false, queryType: 'aggregation', limit: 20 })
   → append any new chunks from entity/fact cross-reference

6. Last resort if allChunks still empty: simpleContentSearch(query, 30)

7. generateSnippetsForChunks(allChunks, query, { maxLength: 150 })
   → topSnippets: top 5 by snippetScore

8. context = formatChunksAsContext(allChunks.slice(0, 20))
   Format: "[Chunk {id}] Source: {doc_title} | Authority: {auth} | Type: {kp_type}\n{content}"
   Chunks separated by "\n\n---\n\n"

9. callLLMAnswer({ query, nodeId: "multiple", nodeName: sourceNames, context })
   → JSON: { final_answer, conditions, citations, conflicts, missing_info }

Return:
{
  "query_type": "aggregation",
  "success": true,
  "data": llmResponse,
  "nodes_used": [{ "node_id": "...", "name": "..." }],
  "chunks_used": N,
  "snippets": [...]
}
```

---

### 4.5 Specialist Handlers

**Comparison:** `handleComparisonQuery(query, classification, trace)`
- Needs ≥ 2 entities from classification.
- Calls `generateComparison(query, entities, criteria)`.
- Falls back to `handleSimpleLookup` if < 2 entities.

**Recommendation:** `handleRecommendationQuery(query, classification, trace)`
- Calls `generateRecommendation(query, { criteria })`.
- Falls back to `handleSimpleLookup` if 0 recommendations.

**Reasoning:** `handleReasoningQuery(query, classification, trace)`
- Calls `enhancedRetrieval(query, { useMultiHop: true, ... })` for multi-hop chain.
- Then calls `reason(query, { additionalContext })`.
- Returns `reasoning_steps`, `key_facts`, `limitations`.

---

## 5. Recall Strategies

### 5.1 FTS5 Query Safety — escapeFtsQuery & extractSearchTerms

**File:** `src/kg/strategies/utils.js`

All FTS5 queries go through `escapeFtsQuery` to prevent injection of FTS5 operators
(AND, OR, NOT, NEAR, `*`, `^`, `:`, `-`, `"`, etc.).

```js
function extractSearchTerms(query) {
  // Latin: words 2+ chars
  const latinTokens = query.toLowerCase().match(/[a-z0-9]{2,}/g) || [];

  // CJK: extract character sequences, then split into 2-grams and 3-grams
  const cjkSeqs = query.match(/[\u4e00-\u9fa5]+/g) || [];
  const cjkGrams = [];
  for (const seq of cjkSeqs) {
    for (let i = 0; i < seq.length - 1; i++) cjkGrams.push(seq.slice(i, i+2));  // bigrams
    for (let i = 0; i < seq.length - 2; i++) cjkGrams.push(seq.slice(i, i+3));  // trigrams
  }
  return [...new Set([...latinTokens, ...cjkGrams])].slice(0, 32);
}

function escapeFtsQuery(query) {
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return `"${query.replace(/"/g, '')}"`;
  return terms.map(t => `"${t}"`).join(' OR ');
  // Output example: '"warranty" OR "period" OR "90" OR "days"'
}
```

**findSimilarInNode in ChunkRepo** uses a separate, stricter sanitization:
```js
const safeQ = queryText
  .slice(0, 500)
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')       // strip everything except letters, digits, spaces
  .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')  // strip FTS5 boolean keywords
  .replace(/\s+/g, ' ')
  .trim();
```

### 5.2 BM25 Node Recall

```js
// bm25RecallNodes(query, limit):
const safeQ = escapeFtsQuery(query);
// SQL:
SELECT n.*, -bm25(nodes_fts) as score
FROM nodes_fts
JOIN nodes n ON n.node_id = nodes_fts.node_id
WHERE nodes_fts MATCH ?
ORDER BY bm25(nodes_fts) ASC
LIMIT ?
```

BM25 from SQLite FTS5 is negative (more negative = better match).
`-bm25()` converts to positive where higher = better.

### 5.3 Vector Recall

```js
// vectorRecallNodes(query, limit, threshold=0.25):
const queryEmbedding = await embedText(query, 'RETRIEVAL_QUERY');
// Load all node embeddings from DB (BLOB → Float32Array)
// Compute cosine similarity for each node
// Filter: similarity >= threshold (0.25)
// Return top `limit` nodes sorted by similarity DESC
```

### 5.4 hybridRecallNodes — 5-Stage Orchestration

**File:** `src/kg/recallNodes.js`

```
Stage 1: BM25 on nodes
  For each lexical variant (up to maxQueryVariants=4):
    bm25RecallNodes(v.text, limit*2)
    addToNodeMap(node, "bm25_node", score * v.weight)

Stage 2: Vector on nodes
  For each vector variant (up to maxVectorVariants=2):
    vectorRecallNodes(v.text, limit*2, vectorThreshold=0.25)
    addToNodeMap(node, "vector_node", similarity * v.weight)

Stage 3: BM25 on chunks → promote to nodes
  For each variant:
    bm25RecallChunks(v.text, limit*2)
    maxScore = max BM25 in batch
    For each chunk result:
      normalizedScore = chunk.bm25 / maxScore
      addToNodeMap(chunk.node, "bm25_chunk", normalizedScore * v.weight)

Stage 4: Document title → nodes
  searchChunksByDocTitle(query, limit)
  For each result: addToNodeMap(node, "doc_title", titleScore)

Stage 5: Vector on chunks → promote to nodes
  For each vector variant:
    vectorRecallChunks(v.text, limit*2, vectorThreshold)
    addToNodeMap(chunk.node, "vector_chunk", similarity * v.weight)

Name/Alias matching (supplement all stages):
  searchNodesByName(query, limit) → addToNodeMap(..., "name_match", score)
  searchByAliases(query, limit)   → addToNodeMap(..., "alias_match", score)
```

**buildNodeMap()** — internal state:
```js
// nodeMap: Map<nodeId, { node, sources: [], scores: { bm25_node: X, vector_node: Y, ... }, variantMatches: Set }>
// addToNodeMap: if node exists, scores[source] = max(old, new)
```

**fuseNodeMap() — RRF fusion (useRRF=true, default):**

```js
// reciprocalRankFusion(rankings, k=60):
// rankings = array of arrays sorted by score DESC
// For each list L, for each item at position rank (0-indexed):
//   rrfScore[item.id] += 1 / (60 + rank + 1)
// k=60 is the standard constant from Cormack & Clarke (2009)
```

**fuseNodeMap() — Weighted sum (useRRF=false):**
```js
finalScore =
    0.40 * scores.bm25_node    +
    0.60 * scores.vector_node  +
    0.30 * scores.bm25_chunk   +
    0.40 * scores.vector_chunk +
    0.50 * scores.name_match   +
    0.45 * scores.alias_match  +
    0.35 * scores.doc_title;
```

Results sorted by fused score DESC, sliced to `limit`.

### 5.5 hierarchicalRetrieve — Beam Search

See §4.3 STEP 1 for full parameters. Key beam scoring formula:

```
childScore(node at depth d) =
    (nodeRankScore * 0.72 + parentScore * 0.28) * 0.96^d
```

Where `nodeRankScore` comes from `rankNodes()` (BM25 absolute scoring — see §5.6).

### 5.6 BM25 Node Scoring Formula

**File:** `src/kg/nodeScoring.js`

```js
const MAX_EXPECTED_BM25 = 15.0;
// Empirical cap: typical good BM25 hits score 8-15.
// Replaces dynamic min/max normalization which inflated "best of bad batch" to score=1.0

function rankNodes(candidates, query) {
  return candidates.map(c => {
    const sim      = Math.min(1.0, (c.bm25 || 0) / MAX_EXPECTED_BM25);
    const scopeFit = c.scopeMatch ? 1.0 : 0.5;
    const authFit  = { policy: 1.0, sop: 0.85, training: 0.7, personal: 0.5 }[c.authorityLevel] ?? 0.7;
    const recency  = 1 / (1 + (c.recencyDays || 365) / 365);
    const risk     = c.conflictCount ? Math.min(1, c.conflictCount * 0.2) : 0;

    const score = 0.60*sim + 0.15*scopeFit + 0.10*authFit + 0.10*recency - 0.05*risk;
    return { ...c, score };
  }).sort((a, b) => b.score - a.score);
}
```

`decideNode(rankedNodes)` thresholds:
```js
const GOOD_THRESHOLD = 0.70;   // score >= 0.70 → confident match
const LOW_THRESHOLD  = 0.55;   // score in [0.55, 0.70)
const GAP_THRESHOLD  = 0.08;   // gap between top-2 scores

// Use top node if: score >= 0.70 OR (score >= 0.55 AND gap between #1 and #2 >= 0.08)
// Otherwise: no confident match
```

### 5.7 Hierarchical Chunk Scoring

**File:** `src/kg/hierarchicalRetrieval.js` — `applyHierarchicalScoring()`

```
For each chunk:
  nodeRelevance = rankNodes score of its parent node
  source        = 'seed' | 'ancestor' | 'sibling' | 'descendant'
  hops          = hops from seed node (0 for seed)
  nodeDepth     = node's level in tree
  authorityLevel = chunk's authority_level field

  sourceBoost:
    seed       = 1.00
    descendant = 0.85
    ancestor   = 0.82
    sibling    = 0.78

  authorityBoost:
    policy   = 1.20
    sop      = 1.10
    training = 1.00
    personal = 0.80

  structuralDecay = 0.88^hops
  depthDecay      = 0.95^nodeDepth

  lexicalBonus:
    = (query terms found in chunk.content) / (total query terms) * 0.10

  hierarchical_score =
      nodeRelevance
    × structuralDecay
    × depthDecay
    × sourceBoost
    × authorityBoost
    + lexicalBonus
```

---

## 6. Post-Retrieval Processing

### 6.1 LLM Reranker

**File:** `src/query/reranker.js`

See §4.3 STEP 5 for trigger conditions and normalization.

`rerankerNodes(query, nodes, { topK, minScore=0.3 })`:
- Same flow but uses `nodeReranking` prompt.
- Formats: `"[{i+1}] {node.name}: {node.summary}"`.

### 6.2 Context Expansion

**File:** `src/query/chunkExpander.js`

`expandChunksWithContext(chunks, { windowBefore=1, windowAfter=1, maxContextLength=2000 })`:

For each chunk:
1. `ChunkRepo.getSequenceInfo(chunkId)` → `{ id, document_id, chunk_index }`.
2. `ChunkRepo.getNeighborsBefore(docId, chunkIndex, windowBefore)` → ascending ordered.
3. `ChunkRepo.getNeighborsAfter(docId, chunkIndex, windowAfter)`.
4. Attach `context_before`, `main_content`, `context_after` to expanded chunk object.
5. Set `has_context = true` if any neighbors found.

**SQL for neighbors:**
```sql
-- Before (then reversed in JS to ascending order):
SELECT id, content_clean, chunk_index FROM chunks
WHERE document_id = ? AND chunk_index < ? AND chunk_index >= ? AND status = 'active'
ORDER BY chunk_index DESC LIMIT ?

-- After:
SELECT id, content_clean, chunk_index FROM chunks
WHERE document_id = ? AND chunk_index > ? AND chunk_index <= ? AND status = 'active'
ORDER BY chunk_index ASC LIMIT ?
```

`buildExpandedContext(expandedChunks, { includeNeighbors=true, maxTotalLength=7000 })`:

Format for each chunk:
```
[Source: {doc_title}]
[Previous context]
{context_before}
---
[Main content]
{main_content}
---
[Following context]
{context_after}
```

- Chunks separated by `\n\n---\n\n`.
- Total output hard-truncated at `maxTotalLength` chars.
- If `includeNeighbors=false`: only `[Main content]` section output.

### 6.3 Snippet Generation

**File:** `src/utils/snippetGenerator.js`

`generateSnippetsForChunks(chunks, query, { maxLength=150 })`:
- For each chunk: split content into sentences.
- Score each sentence by count of query terms matched (case-insensitive).
- Best sentence = highest matched term count = the snippet.
- `snippetScore = matchedTerms / totalQueryTerms`.
- HTML: wrap each matched term in `<mark>{term}</mark>`.
- Truncate to `maxLength` chars at sentence or word boundary.

### 6.4 Citation Generation

**File:** `src/query/citationGenerator.js`

`generateAnswerWithCitations(query, context, chunks, { lang, temperature=0.3, maxSources })`:

**Step 1 — Build numbered source list:**
```
Sources:
[1] {chunk.doc_title} (ID: {chunk.id}): {chunk.content.slice(0, 200)}
[2] ...
[N] ...
```

**Step 2 — Build prompt** (see §8.12).

**Step 3 — Call LLM:**
```js
callLLM({ prompt, temperature })
```

**Step 4 — Parse citations:**
```js
// Find all [n] references in response:
const citationRegex = /\[(\d+)\]/g;
```

**Step 5 — Format HTML:**
```js
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
// Then replace [n] with:
// <cite data-citation="${num}" data-chunk-id="${safeChunkId}">[${num}]</cite>
// safeChunkId = String(chunkId).replace(/[^a-zA-Z0-9_-]/g, '')
```

**Return value:**
```json
{
  "answer": "Warranty is 90 days [1].",
  "answer_html": "Warranty is 90 days <cite data-citation='1' data-chunk-id='42'>[1]</cite>.",
  "citations": [{ "num": 1, "chunk_id": "42", "text": "...", "doc_title": "..." }],
  "sources": [{ "id": "42", "doc_title": "...", "preview": "..." }]
}
```

### 6.5 Confidence Scoring

**File:** `src/query/confidenceScorer.js`

`calculateConfidence({ chunks, nodes, query, answer, queryType })`:

**6 factors:**

| Factor | Calculation | Max |
|---|---|---|
| `source_coverage` | fraction of unique query terms (stopwords removed) found in all chunk content × 0.9 | 0.9 |
| `source_agreement` | pairwise key-phrase overlap across chunks: `0.3 + (agreePairs/totalPairs) × 0.5` | 0.8 |
| `authority_score` | avg `(5 - authRank) / 5` per chunk: policy→0.80, sop→0.60, training→0.40, personal→0.20 | 1.0 |
| `answer_grounding` | fraction of answer terms found in chunk content × 0.8 | 0.8 |
| `retrieval_quality` | chunks≥10→+0.25, ≥5→+0.20, ≥3→+0.15, ≥1→+0.08; nodes≥3→+0.15, ≥2→+0.10, ≥1→+0.05; avg rerank score×0.25; low variance bonus max +0.15 | 0.8 |
| `query_coverage` | fraction of query aspects (CJK noun groups + English nouns) found in chunks × 0.85 | 0.85 |

**Weights per query type (`simple_lookup` baseline):**
```js
baseWeights = {
  source_coverage: 1.5, source_agreement: 1.2, authority_score: 1.0,
  answer_grounding: 1.3, retrieval_quality: 1.0, query_coverage: 1.2
}
// comparison:     source_agreement: 0.8, query_coverage: 1.5
// recommendation: authority_score: 1.5, source_coverage: 1.2
// reasoning:      source_agreement: 1.5, answer_grounding: 1.8
// aggregation:    source_coverage: 1.8, retrieval_quality: 1.3
```

**Aggregation:**
```js
overallScore = weightedSum / totalWeight;
overallScore = overallScore * 0.92;          // mild linear scaling
if (chunks.length < 3) overallScore *= 0.85;
if (nodes.length <= 1) overallScore *= 0.90;
overallScore = clamp(overallScore, 0.05, 0.95);
// Guard: if NaN → 0.1
```

**Levels:** `score >= 0.75 → high`, `>= 0.55 → medium`, `>= 0.35 → low`, else `very_low`.

---

## 7. LLM Integration

### 7.1 callLLM() Implementation

**File:** `src/utils/llm.js`

```js
const llmConfig = {
  provider: process.env.LLM_PROVIDER || 'openai',
  openai: {
    apiKey:         process.env.OPENAI_API_KEY,
    model:          process.env.OPENAI_MODEL           || 'gpt-5-nano',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-large'
  },
  gemini: {
    apiKey:         process.env.GEMINI_API_KEY,
    model:          process.env.GEMINI_MODEL           || 'gemini-2.0-flash',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
  }
};
```

`callLLM({ prompt, temperature=0.2, maxOutputTokens=null, taskName='llm_call' })`:

1. Lazy client init on first call (never at module load time).
2. **OpenAI path:**
   - Detect temperature-incompatible models: `/^o\d|^o-/i` (o1, o3, o-mini, etc.)
   - Temperature-compatible: include `temperature` in request params.
   - Incompatible: omit `temperature`.
   - Extra params always included: `reasoning_effort: 'minimal'`, `verbosity: 'low'`.
   - Call: `client.chat.completions.create({ model, messages: [{role:'user', content:prompt}], temperature?, max_completion_tokens? })`
   - Returns `response.choices[0].message.content`.
3. **Gemini path:**
   - Call: `ai.models.generateContent({ model, contents: [{role:'user', parts:[{text:prompt}]}], config: {temperature, maxOutputTokens} })`
   - Returns `response.text`.
4. Records token usage via `tokenTracker.js` (per dataset, per `taskName`).
5. Returns string text. Throws if empty response.

### 7.2 Language Detection

**File:** `src/utils/langDetect.js`

`detectChineseScript(text)` returns `'zh-TW'`, `'zh-CN'`, or `'en'`:
1. Count CJK chars with `/[\u4e00-\u9fff\u3400-\u4dbf]/g`.
2. `cjkRatio = cjkChars.length / totalNonSpaceChars`.
3. If `cjkRatio <= 0.3` → `'en'`.
4. Count Traditional-specific chars against `TRAD_CHAR_SET` (70+ chars: 學,語,國,體,來,發,開,...).
5. `tradRatio = tradCount / cjkChars.length`.
6. If `tradRatio > 0.03` → `'zh-TW'`, else → `'zh-CN'`.

`getLangInstruction(lang)` — prepended to every prompt before calling LLM:
- `zh-TW`: `【語言規則】本文件為繁體中文。所有 JSON 欄位的「值」...必須嚴格使用繁體中文...`
- `zh-CN`: `【语言规则】本文档为简体中文。所有 JSON 字段的"值"...必须严格使用简体中文...`
- `en`:    `【Language Rule】This document is in English. All JSON field values must be in English only.`

`getPrompt(promptKey, lang, ...args)`:
1. Look up `PROMPTS[promptKey]`.
2. Map both `zh-TW` and `zh-CN` to the `'zh'` template key.
3. Call `promptSet[langKey](...args)` → body string.
4. Return `getLangInstruction(lang) + body`.

`getDatasetLang()` reads the `lang` column from `dataset_config` table in active DB.
`getEffectiveLang(text)`: if dataset lang is `'auto'`, detect from text; otherwise use dataset lang.

---

## 8. All LLM Prompts (Verbatim)

All prompts live in `PROMPTS` object in `src/utils/langDetect.js`.
Language adherence instruction is **always prepended** (see §7.2).
Chinese (`zh`) and English (`en`) variants exist for every prompt.

### 8.1 KP Extraction (`kpExtraction`)

**English:**
```
You are a knowledge base assistant. Extract all atomic Knowledge Points (KPs) from the document text.

Document title: {docTitle}
Text:
"""
{textSegment}
"""

Rules:
1. Each KP must be a complete, self-contained statement understandable without surrounding context.
2. Granularity: exactly one fact, rule, definition, procedure step, or example per KP.
3. Preserve exact numbers, conditions, and qualifiers from the source.
4. source_excerpt is a verbatim quote from the original text (max 200 chars).
5. topic_hint and subtopic_hint: short topic labels (2-5 words) representing the knowledge domain.
6. kp_type must be one of: fact | rule | definition | procedure | example | context

Return a JSON array only (no markdown, no explanation):
[{"statement":"...","kp_type":"...","topic_hint":"...","subtopic_hint":"...","tags":[...],"confidence":0.9,"source_excerpt":"..."}]
```

**Chinese (zh):**
```
你是知识库构建助手。从以下文档中提取所有原子知识点（KP）。

文档标题：{docTitle}
文本：
"""
{textSegment}
"""

规则：
1. 每个知识点必须独立完整，无需上下文即可理解。
2. 粒度要细：一条事实、规则、定义、步骤或示例对应一个知识点。
3. 保留原文中的数字、条件和限定词。
4. source_excerpt为原文逐字摘录（最多200字）。
5. topic_hint和subtopic_hint为简短主题标签（3-8字），代表知识域。
6. kp_type必须为以下之一：fact | rule | definition | procedure | example | context

仅返回JSON数组（无markdown，无说明）：
[{"statement":"...","kp_type":"...","topic_hint":"...","subtopic_hint":"...","tags":[...],"confidence":0.9,"source_excerpt":"..."}]
```

---

### 8.2 Metadata Extraction (`metadataExtraction`)

**English:**
```
Analyze this document and extract metadata. Return ONLY valid JSON.

Document title: {docTitle}
Content:
{content}

Extract and return JSON with these fields:
{
  "keywords": ["top 10 important keywords/phrases"],
  "entities": {
    "products": ["product names mentioned"],
    "organizations": ["company/org names"],
    "people": ["person names"],
    "locations": ["place names"],
    "dates": ["important dates"]
  },
  "chunk_type": "one of: policy, procedure, faq, guide, reference, announcement, report, other",
  "topics": ["main topics covered (max 5)"],
  "summary": "one sentence summary",
  "language": "en",
  "authority_level": "one of: policy (official rules), sop (standard procedures), training (educational), personal (informal)"
}
```

---

### 8.3 Node Suggestion (`nodeSuggestion`)

**English:**
```
You are a knowledge organization assistant. Given a text chunk and a list of tree nodes, determine the best node to place this chunk under.

Text chunk (first 500 chars):
{chunkPreview}

Keywords: {keywords}

Available nodes:
{nodeList}

{noExisting ? "No existing nodes match well. Suggest a new node." : ""}

Return JSON only:
{
  "selected_index": <1-based index of best node, or 0 if none fit>,
  "confidence": <0-1 confidence score>,
  "reasoning": "<brief explanation>",
  "suggested_new_node": {
    "node_id": "<suggested.node.id>",
    "name": "<Node Name>",
    "parent_id": "<suggested parent node_id or null>"
  }  // only if selected_index is 0
}
```

---

### 8.4 Document Structure (`documentStructure`)

**English:**
```
Analyze this document and suggest a hierarchical structure for organizing its content.

Document Title: {docTitle}

Content samples:
{chunkSummaries}

Based on the content, suggest a tree structure with:
1. A main document node
2. 2-5 topic/section nodes that group related content
3. Brief descriptions for each node

IMPORTANT: name, summary, and keywords values must be in the same language as the document content.

Return raw JSON only (no markdown code blocks):
{
  "document_node": {
    "name": "Main topic name (match document language)",
    "summary": "Brief 1-2 sentence summary of document"
  },
  "sections": [
    {
      "name": "Section name (match document language)",
      "summary": "What this section covers",
      "keywords": ["relevant", "keywords"],
      "chunk_indices": [0, 1, 2]
    }
  ]
}
```

---

### 8.5 Query Classification (`queryClassification`)

**English:**
```
You are a query classifier for an enterprise knowledge base system.

Examples of query classification:

1. "What is the price of Product A?" → simple_lookup
   Reason: Direct fact retrieval about a single entity

2. "Which has better value, Product A or Product B?" → comparison
   Reason: Comparing two entities on specific criteria

3. "I need to process large amounts of data, which product do you recommend?" → recommendation
   Reason: Seeking suggestion based on requirements

4. "Why does Product A performance degrade in high temperature?" → reasoning
   Reason: Requires understanding cause-effect relationships

5. "What product lines do we have?" → aggregation
   Reason: Summarizing information across multiple entities

Now classify this query:
"{query}"

Return JSON only:
{
  "query_type": "simple_lookup|comparison|recommendation|reasoning|aggregation",
  "confidence": 0.0-1.0,
  "entities": ["list of entities/products mentioned"],
  "criteria": ["list of comparison/evaluation criteria if applicable"],
  "reasoning": "brief explanation of classification"
}
```

---

### 8.6 Reranking (`reranking`)

**English:**
```
You are a relevance scorer. Given a query and text passages, score each passage's relevance to the query from 0-10.

Query: "{query}"

Passages:
{passages}

Return ONLY a JSON array of scores in order, like: [8, 3, 9, 5, ...]
Each score should reflect how well the passage answers or relates to the query:
- 9-10: Directly answers the query with specific information
- 7-8: Highly relevant, contains key information
- 5-6: Somewhat relevant, partial information
- 3-4: Tangentially related
- 0-2: Not relevant

JSON scores:
```

---

### 8.7 Node Reranking (`nodeReranking`)

**English:**
```
Score each knowledge base node's relevance to the query (0-10).

Query: "{query}"

Nodes:
{nodeTexts}

Return ONLY a JSON array of scores: [score1, score2, ...]
- 9-10: Exact match for query topic
- 7-8: Highly relevant category/topic
- 5-6: Related but not primary topic
- 0-4: Not relevant

JSON:
```

---

### 8.8 Entity & Fact Extraction (`entityFactExtraction`)

**English:**
```
Analyze this text and extract ALL entities and facts. Be comprehensive.

TEXT TO ANALYZE:
"""
{content}
"""
{existingHint}

INSTRUCTIONS:
1. Extract EVERY named entity: products, services, features, concepts, people, organizations, locations, processes, technical terms
2. Extract EVERY factual statement: definitions, properties, relationships, procedures, specifications, comparisons
3. Entity names must match the source text exactly (preserve Traditional/Simplified Chinese as-is)
4. Each fact must be a complete, self-contained statement

OUTPUT FORMAT (valid JSON only, no markdown):
{"entities":[{"name":"EntityName","type":"product|concept|person|organization|location|process|feature|service","description":"one-line description","aliases":[]}],"facts":[{"content":"Complete factual statement","type":"attribute|relationship|definition|procedure|specification","confidence":0.9,"entities":["EntityName"]}]}

IMPORTANT: Return ONLY valid JSON. No explanation, no markdown code blocks.
```

---

### 8.9 Alias Generation (`aliasGeneration`)

**English:**
```
Given the following node information from a knowledge base, generate {maxAliases} alternative names/aliases that users might use to search for this content. Include:
- Synonyms and related terms
- Abbreviated versions
- Translations (if the original is Chinese, include English; if English, include Chinese)
- Common misspellings or variations
- Related phrases people might search for

{context}

Return ONLY a JSON array of strings, no explanation:
["alias1", "alias2", "alias3", ...]
```

---

### 8.10 Conflict Detection (`conflictDetection`)

**English:**
```
Compare these two knowledge chunks and determine if they contain conflicting information.

Chunk A (ID: {chunkA.id}, Source: {chunkA.doc_title}):
{chunkA.content.slice(0, 1000)}

Chunk B (ID: {chunkB.id}, Source: {chunkB.doc_title}):
{chunkB.content.slice(0, 1000)}

Analyze for:
1. Contradictory facts or numbers
2. Conflicting rules or policies
3. Inconsistent procedures
4. Differing scope conditions

Return JSON only:
{
  "has_conflict": true/false,
  "conflict_type": "numeric|policy|procedure|scope|factual|none",
  "severity": "high|medium|low|none",
  "explanation": "brief explanation of the conflict",
  "recommendation": "which chunk to prefer and why (consider authority, recency, scope)"
}
```

---

### 8.11 Answer Generation (`callLLMAnswer`)

**System prompt (English):**
```
You are an enterprise knowledge base Q&A assistant. You must answer strictly based on the provided context.
Rules:
1) Do not use information outside the context; if you don't know, say so and explain what information is missing.
2) You must specify applicable scope/conditions.
3) If there are conflicts in the context, point them out with reasoning (authority/time/scope).
4) Output strict JSON.
```

**User prompt (English):**
```
[Question]
{query}

[Restricted Node]
{nodeId} {nodeName}

[Context Chunks]
{context}

[Output JSON Schema]
{
  "final_answer":"string",
  "conditions":["string"],
  "citations":[{"chunk_id":"string","why":"string"}],
  "conflicts":[{"chunk_ids":["a","b"],"note":"string"}],
  "missing_info":["string"]
}
```

**Context format** (`formatChunksAsContext`):
```
[Chunk {id}] Source: {doc_title} | Authority: {auth} | Type: {kp_type}
{content}

---

[Chunk {id}] Sources: {doc1}, {doc2} [2 docs] | Authority: {auth} | Type: {kp_type}
{content}
```

Note: `Source:` (singular) when 1 source doc; `Sources:` + count when multiple.
Type field only shown when kp_type ≠ `"legacy_chunk"`.

---

### 8.12 Citation Answer Prompt

```
Answer the following question using ONLY the provided sources. Include inline citations in [n] format.

Question: {query}

Sources:
[1] {doc_title} (ID: {chunk_id}): {content.slice(0, 200)}
[2] ...
[N] ...

Instructions:
- Use ONLY the provided sources
- Add [n] after each claim (e.g., "The price is $50 [1].")
- If a claim spans multiple sources, use [1][2]
- If you cannot answer from the sources, say so clearly
- Keep the answer concise and factual
```

### 8.13 KP Normalization (internal, not in PROMPTS object)

**File:** `src/ingest/kpDecisionEngine.js` — `normalizeWithLLM()`

```
Two knowledge statements express the same fact but use different phrasing.
Rewrite them as a single canonical statement that is precise, complete, and neutral.

Statement A: "{kpContent.slice(0,400)}"
Statement B: "{existingContent.slice(0,400)}"

Return JSON only: {"canonical": "...", "confidence": 0.0-1.0}
```

---

## 9. Database Schema & SQL Queries

### 9.1 Core Tables

```sql
-- Nodes: the topic tree
CREATE TABLE nodes (
  node_id        TEXT PRIMARY KEY,
  parent_node_id TEXT REFERENCES nodes(node_id),
  name           TEXT NOT NULL,
  summary        TEXT,
  level          INTEGER DEFAULT 0,
  embedding      BLOB,            -- Float32Array × 3072
  updated_at     TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);

-- Chunks: individual knowledge points
CREATE TABLE chunks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id               TEXT REFERENCES nodes(node_id),
  document_id           INTEGER REFERENCES documents(id),
  doc_title             TEXT,
  content_clean         TEXT,            -- searchable content (statement + excerpt)
  chunk_type            TEXT,            -- metadata type
  kp_type               TEXT,            -- fact|rule|definition|procedure|example|context|legacy_chunk
  keywords_json         TEXT DEFAULT '[]',
  fields_json           TEXT DEFAULT '{}',
  scope_json            TEXT DEFAULT '{}',
  authority_level       TEXT DEFAULT 'sop',  -- policy|sop|training|personal
  source_excerpt        TEXT,            -- verbatim quote from original
  source_documents_json TEXT DEFAULT '[]',  -- [{doc_id, doc_title, excerpt}]
  chunk_index           INTEGER DEFAULT 0,
  status                TEXT DEFAULT 'active',     -- 'active' or 'superseded'
  superseded_by         INTEGER REFERENCES chunks(id),
  embedding             BLOB,            -- Float32Array × 3072
  uploaded_at           TEXT DEFAULT (datetime('now'))
);

-- Documents: uploaded files
CREATE TABLE documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT,
  file_path     TEXT,
  status        TEXT DEFAULT 'processing',
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Pending decisions: borderline KP actions awaiting review
CREATE TABLE pending_decisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  action            TEXT,    -- 'merge_suggestion' or 'replace_suggestion'
  incoming_chunk_id INTEGER,
  target_chunk_id   INTEGER,
  node_id           TEXT,
  confidence        REAL,
  reason            TEXT,
  similarity_score  REAL,
  incoming_preview  TEXT,
  target_preview    TEXT,
  status            TEXT DEFAULT 'pending',  -- 'pending', 'approved', 'rejected'
  created_at        TEXT DEFAULT (datetime('now'))
);

-- Node aliases: alternative search names
CREATE TABLE node_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id    TEXT REFERENCES nodes(node_id),
  alias      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Dataset config (language override per dataset)
CREATE TABLE dataset_config (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
-- key='lang', value='auto'|'en'|'zh-CN'|'zh-TW'
```

### 9.2 ChunkRepo — All SQL

**Node-scoped reads** (all filter `status = 'active' AND superseded_by IS NULL`):

```sql
-- getForNode: ordered by authority then recency
SELECT * FROM chunks
WHERE node_id = ? AND status = 'active' AND superseded_by IS NULL
ORDER BY authority_level ASC, uploaded_at DESC

-- getForNodeLimited
SELECT * FROM chunks
WHERE node_id = ? AND status = 'active' AND superseded_by IS NULL
ORDER BY authority_level ASC, uploaded_at DESC LIMIT ?

-- getForNodeWithNodeName (includes node name)
SELECT c.*, n.name as node_name FROM chunks c
JOIN nodes n ON n.node_id = c.node_id
WHERE c.node_id = ? AND c.status = 'active' AND c.superseded_by IS NULL
ORDER BY c.authority_level ASC, c.uploaded_at DESC LIMIT ?

-- getForNodeFull (includes node name + level)
SELECT c.*, n.name as node_name, n.level as node_level
FROM chunks c JOIN nodes n ON c.node_id = n.node_id
WHERE c.node_id = ? AND c.status = 'active' AND c.superseded_by IS NULL
ORDER BY c.authority_level ASC, c.uploaded_at DESC LIMIT ?

-- getForNodeFullByIndex (ordered by chunk_index, not upload time)
SELECT c.*, n.name as node_name, n.level as node_level
FROM chunks c JOIN nodes n ON c.node_id = n.node_id
WHERE c.node_id = ? AND c.status = 'active' AND c.superseded_by IS NULL
ORDER BY c.authority_level ASC, c.chunk_index ASC LIMIT ?

-- getActiveForNode (ordered by upload time only)
SELECT * FROM chunks
WHERE node_id = ? AND status = 'active' AND superseded_by IS NULL
ORDER BY uploaded_at DESC
```

**Single-chunk reads:**
```sql
-- getById
SELECT * FROM chunks WHERE id = ?

-- getSequenceInfo
SELECT id, document_id, chunk_index FROM chunks WHERE id = ?

-- getByIds (active only, variable placeholders)
SELECT * FROM chunks WHERE id IN (?,?,...) AND status = 'active'
```

**Context-window neighbors:**
```sql
-- getNeighborsBefore (result reversed in JS to ascending order)
SELECT id, content_clean, chunk_index FROM chunks
WHERE document_id = ? AND chunk_index < ? AND chunk_index >= ? AND status = 'active'
ORDER BY chunk_index DESC LIMIT ?

-- getNeighborsAfter
SELECT id, content_clean, chunk_index FROM chunks
WHERE document_id = ? AND chunk_index > ? AND chunk_index <= ? AND status = 'active'
ORDER BY chunk_index ASC LIMIT ?
```

**Search reads:**
```sql
-- bm25Search (FTS5)
SELECT c.*, -bm25(chunks_fts) as score
FROM chunks_fts
JOIN chunks c ON c.id = CAST(chunks_fts.chunk_id AS INTEGER)
WHERE chunks_fts MATCH ? AND c.status = 'active'
ORDER BY bm25(chunks_fts) ASC LIMIT ?

-- simpleContentSearch (LIKE, terms = string array)
SELECT c.* FROM chunks c
WHERE c.status = 'active' AND (c.content_clean LIKE ? OR c.content_clean LIKE ? ...)
ORDER BY c.uploaded_at DESC LIMIT ?

-- searchByDocTitle
SELECT c.*,
  CASE WHEN c.doc_title = ?        THEN 1.0
       WHEN c.doc_title LIKE ?     THEN 0.8
       ELSE 0.5 END as title_score
FROM chunks c
WHERE c.status = 'active'
  AND (c.doc_title = ? OR c.doc_title LIKE ? OR c.doc_title LIKE ?)
ORDER BY title_score DESC, c.chunk_index ASC LIMIT ?
-- params: [term, '%'+term+'%', term, term+'%', '%'+term+'%', limit]

-- getByDocumentName (JOIN to documents table)
SELECT c.* FROM chunks c
JOIN documents d ON c.document_id = d.id
WHERE c.status = 'active'
  AND (d.original_name = ? OR d.original_name LIKE ? OR c.doc_title = ? OR c.doc_title LIKE ?)
ORDER BY c.chunk_index ASC LIMIT ?

-- findSimilarInNode (KP dedup, pre-sanitized safeQ)
SELECT c.id, c.content_clean, c.authority_level, c.source_documents_json,
       -bm25(chunks_fts) AS bm25_score
FROM chunks_fts
JOIN chunks c ON c.id = CAST(chunks_fts.chunk_id AS INTEGER)
WHERE chunks_fts MATCH ? AND c.node_id = ? AND c.status = 'active' [AND c.id != ?]
ORDER BY bm25(chunks_fts) ASC LIMIT ?
```

**Writes:**
```sql
-- insert (legacy chunk, no KP columns)
INSERT INTO chunks (
  doc_title, content_clean, chunk_type, keywords_json, fields_json,
  scope_json, authority_level, node_id, document_id, chunk_index,
  uploaded_at, status
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'active')

-- insertKP (Knowledge Point with extra columns)
INSERT INTO chunks (
  doc_title, content_clean, chunk_type, kp_type, keywords_json, fields_json,
  scope_json, authority_level, source_excerpt, source_documents_json,
  node_id, document_id, chunk_index, uploaded_at, status
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),'active')

-- insertFts (add to FTS5 index)
INSERT INTO chunks_fts (chunk_id, content) VALUES (?, ?)

-- supersede (mark old chunk as replaced)
UPDATE chunks SET superseded_by = ?, status = 'superseded' WHERE id = ?

-- updateSourceDocuments (append doc reference to merged KP)
UPDATE chunks SET source_documents_json = ? WHERE id = ?
```

### 9.3 FTS5 Tables

```sql
-- Chunk full-text search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);

-- Node full-text search
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  node_id UNINDEXED,
  content,     -- '{name} {summary}' when inserted
  tokenize = 'unicode61'
);
```

FTS5 BM25 behavior:
- `bm25(chunks_fts)` returns negative float (more negative = more relevant).
- `ORDER BY bm25(chunks_fts) ASC` = best first.
- Score column: `SELECT -bm25(...) as score` gives positive-is-better.

---

## 10. Multi-Dataset Architecture

**Files:** `src/db/db.js`, `src/db/activeDb.js`, `src/db/registry.js`, `src/db/datasetManager.js`

### Request Scoping Flow

```
1. Client sends: GET /ask  Header: X-Dataset-ID: <uuid>
2. server.js middleware:
   a. Read X-Dataset-ID header
   b. datasetManager.getConnection(uuid) → SQLite connection
   c. runWithDb(conn, () => next())
      → AsyncLocalStorage stores conn for this request/async chain
3. Any module doing db.prepare(...)
   → Proxy.get(prop) → getActiveDb() → als.getStore() → conn
   → conn.prepare(...)
```

### Proxy Guard

```js
// db.js Proxy
export const db = new Proxy({}, {
  get(_, prop) {
    // Prevent Proxy from being mistakenly awaited (makes it non-thenable)
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    return getActiveDb()[prop];
  }
});
```

### Registry

`data/registry.db` stores: `id`, `name`, `uuid`, `created_at` for each dataset.
Accessed via direct connection — never goes through the Proxy.

### Dataset Operations

| Operation | Implementation |
|---|---|
| Create | `initDatasetDb(conn)` runs all `CREATE TABLE` statements |
| Duplicate | `conn.backup(destPath)` (better-sqlite3 online backup API) |
| Export | Same as duplicate — copy to user-specified path |
| Delete | `conn.close()`, remove from pool, `fs.unlink(dbPath)` |
| Rename | Update `name` in registry.db |

---

## 11. Key Constants & Thresholds Reference

| Constant | Value | File | Purpose |
|---|---|---|---|
| `SEGMENT_SIZE` | 5000 | knowledgeExtractor.js | Chars per LLM KP extraction call |
| `SEGMENT_OVERLAP` | 500 | knowledgeExtractor.js | Overlap between adjacent segments |
| `DEDUP_THRESHOLD` | 0.90 | knowledgeExtractor.js | Cross-segment Dice dedup cutoff |
| `KP_EXTRACTION_TEMPERATURE` | 0.1 | knowledgeExtractor.js | Low temp for consistent KP output |
| `IGNORE_CONF_THRESHOLD` | 0.35 | kpDecisionEngine.js | Min KP confidence to store |
| `IGNORE_MIN_LENGTH` | 15 chars | kpDecisionEngine.js | Min KP character length |
| `MERGE_AUTO_THRESHOLD` | 0.90 | kpDecisionEngine.js | Dice similarity → auto-merge |
| `MERGE_QUEUE_THRESHOLD` | 0.70 | kpDecisionEngine.js | Dice similarity → queue for review |
| `REPLACE_AUTO_CONF` | 0.85 | kpDecisionEngine.js | Confidence needed for auto-replace |
| `NORMALIZE_LLM_CONF` | 0.70 | kpDecisionEngine.js | LLM normalization min confidence |
| `NORMALIZE_DICE_MIN` | 0.40 | kpDecisionEngine.js | Dice threshold to attempt LLM normalize |
| `TOPIC_MATCH_THRESHOLD` | 0.40 | nodeMapper.js | Dice to reuse existing topic node |
| `SUBTOPIC_MERGE_THRESHOLD` | 0.60 | nodeMapper.js | Below this → create subtopic level |
| `TOPIC_LLM_CONFIRM_LOW` | 0.35 | nodeMapper.js | Dice in [0.35, 0.40) → LLM confirm |
| `NODE_MERGE_THRESHOLD` | 0.75 | nodeMerger.js | Sibling Dice similarity for merge |
| `MAX_EXPECTED_BM25` | 15.0 | nodeScoring.js | Absolute BM25 cap (no dynamic norm) |
| `GOOD_THRESHOLD` | 0.70 | nodeScoring.js | Confident node match score |
| `LOW_THRESHOLD` | 0.55 | nodeScoring.js | Borderline node match score |
| `GAP_THRESHOLD` | 0.08 | nodeScoring.js | Gap between #1 and #2 for clear winner |
| `AGGREGATION_TOP_N` | 8 | qa.js | Max nodes for aggregation queries |
| `maxChunks` | 20 | qa.js | Default context chunks |
| `contextWindow` | 2 | qa.js | Neighbor chunks per side |
| `rerankerThreshold` | 0.3 | qa.js | Min normalized reranker score |
| `temperature` | 0.3 | qa.js | LLM answer temperature |
| `beamWidth` | 3 | qa.js → hierarchicalRetrieval | Nodes per depth level in beam |
| `ancestorLevels` | 2 | qa.js | Ancestor levels to enrich |
| `siblingNodesPerSeed` | 3 | qa.js | Siblings per seed node |
| `descendantDepth` | 2 | qa.js | Descendant expansion depth |
| `childScoreBlend` | 0.72/0.28 | hierarchicalRetrieval.js | Child vs parent score blend |
| `depthPenalty` | 0.96^depth | hierarchicalRetrieval.js | Beam score decay per level |
| `structuralDecay` | 0.88^hops | hierarchicalRetrieval.js | Chunk score decay per hop |
| `depthDecay` | 0.95^depth | hierarchicalRetrieval.js | Chunk score decay per tree level |
| `ancestorDecay` | 0.82^level | hierarchicalRetrieval.js | Ancestor chunk score multiplier |
| `siblingDecay` | 0.78 | hierarchicalRetrieval.js | Sibling chunk score multiplier |
| `minSiblingScore` | 0.15 | hierarchicalRetrieval.js | Min node score to expand siblings |
| `RRF_k` | 60 | strategies/utils.js | RRF constant (Cormack & Clarke) |
| `vectorThreshold` | 0.25 | recallNodes.js | Min cosine similarity |
| `bm25Weight` | 0.4 | recallNodes.js | BM25 weight in weighted fusion |
| `vectorWeight` | 0.6 | recallNodes.js | Vector weight in weighted fusion |
| `maxQueryVariants` | 4 | recallNodes.js | Max query variants for BM25 |
| `maxVectorVariants` | 2 | recallNodes.js | Max variants for vector search |
| `EMBEDDING_DIMENSION` | 3072 | embedder.js | Float32 vector length |
| `CACHE_MAX_SIZE` | 1000 | embedder.js | In-memory LRU cache entries |
| `RATE_LIMIT_DELAY_MS` | 100 | embedder.js | ms between embedding batches |
| `MAX_INPUT_LENGTH` | 2048 | embedder.js | Max chars before truncation |
| `confidence:high` | >= 0.75 | confidenceScorer.js | High confidence threshold |
| `confidence:medium` | >= 0.55 | confidenceScorer.js | Medium confidence threshold |
| `confidence:low` | >= 0.35 | confidenceScorer.js | Low confidence threshold |

---

*End of document. All values verified directly from source code as of 2026-02-26.*
