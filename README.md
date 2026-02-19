# TreeKB - Tree-based Knowledge Graph System

[English](#english) | [中文](#中文)

---

<a name="english"></a>
# English

A hierarchical knowledge management system that processes documents into a tree structure and provides intelligent retrieval with support for complex queries including comparisons, recommendations, and multi-hop reasoning.

## Features

- **Hierarchical Knowledge Organization**: Documents are organized into a tree structure for intuitive navigation and context-aware retrieval
- **Multi-Format Document Ingestion**: Support for PDF, DOCX, XLSX, HTML, TXT, Markdown, and CSV files
- **Hybrid Search**: Combines BM25 lexical search with vector semantic search using Reciprocal Rank Fusion (RRF)
- **Intelligent Query Routing**: Automatically classifies queries and routes them to specialized handlers
- **Complex Query Support**:
  - Simple lookups
  - Entity comparisons
  - Criteria-based recommendations
  - Multi-hop reasoning across the knowledge tree
- **Conflict Detection**: Identifies contradictions between knowledge chunks with LLM-powered analysis; resolve by keeping one, both, or archiving
- **Bilingual Support**: Automatic Chinese/English detection and response generation
- **Background Ingestion Queue**: Documents are processed asynchronously with automatic retries and job status tracking
- **Real-time Ingestion Progress**: WebSocket push delivers live stage-by-stage progress (chunking → metadata → mapping → conflicts → finalize) directly to the upload card — no waiting for polling
- **Multiple Datasets**: Create isolated knowledge bases; switch with the sidebar dropdown; import/export as `.db` files
- **Incremental Updates**: Add new documents without rebuilding the entire knowledge base
- **Web UI**: Built-in web interface for managing the knowledge base

## Web Interface

TreeKB includes a built-in web UI accessible at `http://localhost:3000` after starting the server.

### UI Features

| Tab | Description |
|-----|-------------|
| **Ask** | Natural language Q&A with smart query routing |
| **Tree** | Visual tree structure with node management |
| **Upload** | Drag-and-drop document upload |
| **Documents** | Document listing and management |
| **Conflicts** | Review and resolve content conflicts |
| **Stats** | System statistics and embedding sync |
| **Datasets** | Create, rename, duplicate, export, and delete datasets |

### Screenshots

The UI provides:
- 🌳 Interactive knowledge tree navigation
- 💬 Intelligent Q&A with query classification display
- 📤 Multi-file upload with progress tracking
- 📊 Real-time system statistics
- 🌐 Language switching (English/Chinese)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 API Layer (Express.js REST + WebSocket)          │
│                  src/routes/  ·  src/server.js                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Ingestion  │  │    Query     │  │      Retrieval       │  │
│  │   Pipeline   │  │   Handlers   │  │      Strategies      │  │
│  ├──────────────┤  ├──────────────┤  ├──────────────────────┤  │
│  │ File Parser  │  │ Classifier   │  │ BM25 (FTS5)          │  │
│  │ Chunker      │  │ Comparator   │  │ Vector Search        │  │
│  │ Metadata     │  │ Recommender  │  │ Hybrid (RRF)         │  │
│  │ Node Mapper  │  │ Reasoner     │  │ Graph Traversal      │  │
│  │ Conflict Det │  │ Query Planner│  │ Alias + Expansion    │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│              Storage Layer — per-dataset SQLite files            │
│    data/registry.db  +  data/datasets/<id>.db (FTS5 + vectors)  │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js 18+
- Google Gemini API key (for embeddings and LLM features)

## Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd kg-mvp
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in the root directory:
   ```env
   PORT=3000
   GEMINI_API_KEY=your_gemini_api_key_here
   GEMINI_MODEL=gemini-2.0-flash
   ```

4. **Initialize the database with seed data**
   ```bash
   npm run seed
   ```

5. **Start the server**
   ```bash
   npm start
   ```

   For development with hot-reload:
   ```bash
   npm run dev
   ```

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `PORT` | Server port | `3000` |
| `GEMINI_API_KEY` | Google Gemini API key | Required |
| `GEMINI_MODEL` | Gemini model for LLM | `gemini-2.0-flash` |
| `EMBEDDING_MODEL` | Model for embeddings | `gemini-embedding-exp-03-07` |
| `DISABLE_EMBEDDINGS` | Set to `true` to disable vector search | `false` |

## API Reference

### Q&A Endpoints

#### POST /ask
Main query endpoint with intelligent classification and routing.

**Request:**
```json
{
  "query": "Compare Product A and Product B",
  "queryScope": {
    "product": "optional-filter",
    "region": "optional-filter"
  },
  "options": {
    "useClassification": true,
    "useHybridSearch": true
  }
}
```

**Response:**
```json
{
  "query_type": "comparison",
  "success": true,
  "data": {
    "entities": ["Product A", "Product B"],
    "table": { "headers": [...], "rows": [...] },
    "summary": "...",
    "recommendation": "..."
  },
  "sources": [...]
}
```

#### POST /ask/simple
Simple BM25-based lookup without classification.

#### POST /classify
Classify a query without answering it.

### Document Management

#### POST /upload
Upload and process a single document.

**Request (multipart/form-data):**
- `file`: The document file
- `targetNodeId` (optional): Specific node to attach chunks to
- `useLLM` (optional): Use LLM for metadata extraction (default: true)
- `detectConflicts` (optional): Check for conflicts (default: true)

#### POST /upload/batch
Upload multiple documents at once (max 20 files).

#### GET /documents
List all uploaded documents.

#### GET /documents/:id
Get document details by ID.

#### DELETE /documents/:id
Delete a document and its chunks.

### Node Management

#### GET /nodes
Get the full tree structure.

#### GET /nodes/:id
Get a specific node. Add `?context=true` for parent/siblings/children.

#### GET /nodes/:id/children
Get direct children of a node.

#### POST /nodes
Create a new node.

**Request:**
```json
{
  "node_id": "product.new-category",
  "name": "New Category",
  "parent_id": "product",
  "summary": "Description of the new category"
}
```

#### PUT /nodes/:id
Update an existing node.

### Chunk Management

#### GET /chunks/:nodeId
Get all chunks for a specific node.

#### GET /chunks/detail/:id
Get a specific chunk by ID.

### Conflict Management

#### GET /conflicts
Get unresolved conflicts.

#### POST /conflicts/:id/resolve
Resolve a conflict.

### Embedding Management

#### POST /embeddings/sync
Generate embeddings for all nodes and chunks that don't have them.

#### GET /embeddings/coverage
Check embedding coverage statistics.

### System Endpoints

#### GET /health
Health check endpoint.

#### GET /stats
Get system statistics.

### Dataset Management

#### GET /datasets
List all datasets. `db_path` is omitted from the response.

#### POST /datasets
Create a new dataset.

**Request:**
```json
{ "name": "My Dataset", "description": "Optional description" }
```

#### PUT /datasets/:id
Rename a dataset and/or update its description.

#### DELETE /datasets/:id?confirm=yes
Delete a dataset. Requires `?confirm=yes`. Refuses if it is the only remaining dataset.

#### POST /datasets/:id/duplicate
Duplicate a dataset (online backup — safe while the source is in use).

**Request:** `{ "name": "Optional new name" }` (defaults to `"<source> (copy)"`)

#### GET /datasets/:id/export
Download the dataset as a portable `.db` file.

#### GET /datasets/:id/stats
Node, document, chunk, and embedding counts for a specific dataset.

### Ingestion Job Queue

#### GET /jobs
List ingestion jobs. Supports `?status=queued|processing|completed|failed|cancelled&limit=50&offset=0`.

#### GET /jobs/:id
Get a specific ingestion job.

#### POST /jobs/:id/retry
Retry a failed or cancelled job (the upload file must still exist on disk).

#### DELETE /jobs/:id
Cancel a queued job.

> **Dataset targeting**: All data-plane endpoints accept an `X-Dataset-ID` header to target a specific dataset. Defaults to the default dataset.

## Query Types

| Type | Description | Example |
|------|-------------|---------|
| `simple_lookup` | Direct fact retrieval | "What is the return policy?" |
| `comparison` | Compare 2+ entities | "Compare Product A vs Product B" |
| `recommendation` | Suggest based on criteria | "Which product is best for beginners?" |
| `reasoning` | Multi-hop reasoning | "Why does X affect Y?" |
| `aggregation` | Summarize across sources | "List all product categories" |

## Supported File Types

| Extension | Type |
|-----------|------|
| `.txt`, `.md` | Text/Markdown |
| `.pdf` | PDF |
| `.docx` | Word |
| `.xlsx`, `.xls` | Excel |
| `.html`, `.htm` | HTML |
| `.csv` | CSV |
| `.json` | JSON |

## Project Structure

```
kg-mvp/
├── data/
│   ├── registry.db          ← master dataset registry
│   ├── datasets/
│   │   ├── default.db       ← default knowledge base (migrated from kg.db on first run)
│   │   └── <uuid>.db        ← additional datasets
│   └── uploads/             ← temporary upload staging area
├── public/
│   ├── index.html
│   ├── app.js               ← single-page frontend (WS client + job progress)
│   └── styles.css
└── src/
    ├── server.js              # Express + WebSocket server (74 lines)
    ├── routes/                # Route modules (one file per concern)
    │   ├── datasets.js        #   GET/POST/PUT/DELETE /datasets + export/duplicate/stats
    │   ├── ingest.js          #   POST /upload, /upload/batch, GET/POST /ingest/jobs/*
    │   ├── query.js           #   POST /ask, /ask/simple, /classify, /suggestions, /feedback
    │   ├── documents.js       #   GET/DELETE /documents/:id
    │   ├── nodes.js           #   /nodes, /chunks, /aliases/sync
    │   ├── conflicts.js       #   GET/POST /conflicts
    │   ├── embeddings.js      #   /embeddings/sync, /embeddings/coverage
    │   ├── stats.js           #   /stats, /stats/tokens, /health, DELETE /tree
    │   └── entities.js        #   /entities, /facts, /extraction
    ├── db/
    │   ├── db.js              # Proxy-based active-DB router
    │   ├── activeDb.js        # AsyncLocalStorage request context
    │   ├── initDatasetDb.js   # Per-dataset schema initialisation
    │   ├── registry.js        # Dataset registry CRUD
    │   ├── datasetManager.js  # Connection pool + dataset lifecycle
    │   └── init.sql           # Schema definition
    ├── kg/
    │   ├── qa.js              # Main Q&A orchestration
    │   ├── recallNodes.js     # Hybrid retrieval orchestrator + re-exports
    │   ├── strategies/        # Retrieval strategy modules
    │   │   ├── bm25.js        #   BM25 keyword search (nodes + chunks)
    │   │   ├── vector.js      #   Vector similarity search
    │   │   ├── hierarchy.js   #   Ancestor/child enrichment + hierarchical chunks
    │   │   ├── aliases.js     #   Alias cache + alias-based recall
    │   │   ├── expansion.js   #   Query expansion + variant generation
    │   │   └── utils.js       #   Shared: RRF, CJK n-grams, FTS escaping
    │   ├── nodeScoring.js     # Multi-factor ranking
    │   ├── graphTraversal.js  # Tree navigation
    │   └── seedNodes.js       # Initial data seeding
    ├── ingest/
    │   ├── index.js           # Document management + pipeline re-export
    │   ├── pipeline/          # Ingestion pipeline
    │   │   ├── index.js       #   Runner: stage loop, rollback, WS progress emit
    │   │   └── stages.js      #   6 stage functions (parse→register→enrich→map→entities→finalize)
    │   ├── jobQueue.js        # Background ingestion queue with retries
    │   ├── fileParser.js      # Multi-format file parsing
    │   ├── chunker.js         # Text chunking
    │   ├── metadataExtractor.js # Keyword/entity extraction
    │   ├── nodeMapper.js      # Chunk-to-node assignment
    │   └── conflictDetector.js # Conflict detection
    ├── embedding/
    │   ├── embedder.js        # Gemini embedding generation
    │   ├── vectorStore.js     # Vector storage & search
    │   └── chunkEmbeddings.js # Embedding management
    ├── extraction/
    │   └── entityFactExtractor.js # Entity & fact extraction
    ├── query/
    │   ├── classifier.js      # Query classification
    │   ├── queryPlanner.js    # Complex query decomposition
    │   ├── multiNodeRetriever.js # Multi-entity retrieval
    │   ├── comparator.js      # Comparison handler
    │   ├── recommender.js     # Recommendation handler
    │   ├── reasoner.js        # Multi-hop reasoning
    │   └── feedback.js        # Thumbs-up/down feedback logging
    └── utils/
        ├── progressEmitter.js # WebSocket job-progress subscriptions + broadcast
        ├── logger.js
        └── tokenTracker.js
```

## Usage Examples

### Basic Q&A
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "What are the sales procedures?"}'
```

### Upload a Document
```bash
curl -X POST http://localhost:3000/upload \
  -F "file=@./documents/policy.pdf" \
  -F "targetNodeId=sales.rules"
```

### Compare Products
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "Compare Product A and Product B"}'
```

### Sync Embeddings
```bash
curl -X POST http://localhost:3000/embeddings/sync
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| API key error on startup | Add valid API key to `.env` file |
| "No matching nodes found" | Run `npm run seed` and upload documents |
| Slow queries | Run `POST /embeddings/sync` |
| File upload failures | Check file size (<50MB) and supported type |
| Job stuck in `processing` after restart | Server auto-recovers in-flight jobs on startup |

---

## Changelog

### v2.2.0 — 2026-02-19

**Real-time ingestion progress via WebSocket**
- Upload a document and watch a live progress bar advance through each pipeline stage (chunking → metadata extraction → node mapping → conflict detection → finalize) — updates push from the server over WebSocket with sub-second latency instead of waiting for 2-second HTTP polls
- Progress bar and stage label appear inside the job card immediately after upload; the card auto-refreshes with the final result when processing completes
- WebSocket connection opens on page load and auto-reconnects on disconnect; existing HTTP polling remains as a transparent fallback

**Modular server architecture**
- `src/server.js` reduced from 1 087 lines to 74 — all route logic extracted into `src/routes/` (9 files, one per concern: datasets, query, ingest, documents, nodes, conflicts, embeddings, stats, entities)
- Ingestion pipeline decomposed into `src/ingest/pipeline/stages.js` (6 named stage functions) + `src/ingest/pipeline/index.js` (runner with rollback and WS emit)
- Retrieval strategies split into `src/kg/strategies/` (bm25, vector, hierarchy, aliases, expansion, utils) — `recallNodes.js` becomes a thin orchestrator

---

### v2.1.0 — 2026-02-18

**Multi-dataset support**
- Create, rename, delete, duplicate, and export independent knowledge bases, each stored as a separate SQLite file
- Sidebar dropdown to switch the active dataset; all API calls are scoped to the selected dataset via `X-Dataset-ID` header
- Full Datasets management tab — CRUD UI with active badge, inline rename, export, duplicate, and delete
- On first startup, existing `data/kg.db` is automatically migrated to `data/datasets/default.db`; the original file is preserved

**Conflict resolution**
- New **Keep Both** option — accept both conflicting chunks without archiving either

**Bug fixes**
- Chinese filenames now display correctly in the Documents tab (fixed latin1→UTF-8 decoding through multer and the ingestion pipeline)
- Uploads now correctly target the selected dataset (fixed `AsyncLocalStorage` context loss through multer's async stream processing)
- Ingestion job status now correctly transitions to `completed` / `failed` after processing (fixed context loss in background job pump)
- Fixed `GET /` returning 404 when the dataset middleware was active (static files now served before dataset middleware)

---

### v2.0.0 — Background Ingestion Queue

- Asynchronous document ingestion queue with configurable concurrency and automatic retries
- Job status API (`/jobs`) — list, get, retry, and cancel ingestion jobs
- Queue statistics included in `/stats` response
- In-flight jobs from a crashed/restarted process are automatically re-queued on startup

---

### v1.3.0 — Multilingual Retrieval Improvements

- Improved BM25, hierarchy scoring, and retrieval for Chinese queries
- Conflict explanation UI improvements
- Hierarchy-aware scoring for non-English content

---

### v1.2.0 — Chinese Query Retrieval

- Improved tokenisation and BM25 matching for Chinese text
- Fact-based retrieval enhancements for CJK content

---

### v1.1.0 — Retrieval Improvements

- Multi-strategy retrieval pipeline (BM25 + vector + hierarchy + facts)
- Entity and fact extraction via Gemini
- Token usage tracking

---

### v1.0.0 — Initial Release

- Tree-based knowledge graph with document ingestion
- Semantic search with Gemini embeddings
- Chunk conflict detection and resolution UI
- English / Chinese UI localisation

---

<a name="中文"></a>
# 中文

TreeKB 是一个层级化知识管理系统，可将文档处理成树形结构，并提供智能检索功能，支持复杂查询，包括对比分析、推荐建议和多跳推理。

## 功能特性

- **层级化知识组织**：文档被组织成树形结构，便于直观导航和上下文感知检索
- **多格式文档导入**：支持 PDF、DOCX、XLSX、HTML、TXT、Markdown、CSV 和 JSON 文件
- **混合搜索**：结合 BM25 词法搜索和向量语义搜索，使用倒数排名融合（RRF）算法
- **智能查询路由**：自动分类查询并路由到专门的处理器
- **复杂查询支持**：
  - 简单查找
  - 实体对比
  - 基于条件的推荐
  - 跨知识树的多跳推理
- **冲突检测**：使用 LLM 驱动的分析识别知识片段之间的矛盾；可选择保留一方、保留双方或归档
- **双语支持**：自动检测中英文并生成相应语言的回答
- **后台导入队列**：异步处理文档，支持自动重试和任务状态追踪
- **实时导入进度**：通过 WebSocket 推送实时进度（分块 → 元数据 → 节点映射 → 冲突检测 → 完成），在上传卡片中即时显示进度条
- **多数据集**：创建相互隔离的知识库，通过侧边栏下拉切换，支持导入/导出 `.db` 文件
- **增量更新**：添加新文档无需重建整个知识库
- **Web 界面**：内置 Web 管理界面

## Web 界面

TreeKB 内置 Web 界面，启动服务器后访问 `http://localhost:3000`。

### 界面功能

| 标签页 | 说明 |
|--------|------|
| **提问** | 自然语言问答，支持智能查询路由 |
| **知识树** | 可视化树结构，支持节点管理 |
| **上传** | 拖拽上传文档 |
| **文档** | 文档列表和管理 |
| **冲突** | 查看和解决内容冲突 |
| **统计** | 系统统计和嵌入向量同步 |

### 功能特点

- 🌳 交互式知识树导航
- 💬 智能问答，显示查询分类
- 📤 多文件上传，实时进度
- 📊 实时系统统计
- 🌐 语言切换（中英文）

## 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         API 层                                   │
│                    (Express.js REST)                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   导入管道   │  │   查询处理   │  │      检索引擎        │  │
│  ├──────────────┤  ├──────────────┤  ├──────────────────────┤  │
│  │ 文件解析器   │  │ 分类器       │  │ BM25 (FTS5)          │  │
│  │ 分块器       │  │ 对比器       │  │ 向量搜索             │  │
│  │ 元数据提取   │  │ 推荐器       │  │ 混合搜索 (RRF)       │  │
│  │ 节点映射     │  │ 推理器       │  │ 图遍历               │  │
│  │ 冲突检测     │  │ 查询规划     │  │ 多因子排序           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                        存储层                                    │
│              (SQLite + FTS5 + 向量存储)                          │
└─────────────────────────────────────────────────────────────────┘
```

## 环境要求

- Node.js 18+
- Google Gemini API 密钥（用于向量嵌入和 LLM 功能）

## 安装步骤

1. **克隆仓库**
   ```bash
   git clone <repository-url>
   cd kg-mvp
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置环境变量**

   在根目录创建 `.env` 文件：
   ```env
   PORT=3000
   GEMINI_API_KEY=你的_gemini_api_密钥
   GEMINI_MODEL=gemini-2.0-flash
   ```

4. **初始化数据库**
   ```bash
   npm run seed
   ```

5. **启动服务器**
   ```bash
   npm start
   ```

   开发模式（热重载）：
   ```bash
   npm run dev
   ```

## 配置说明

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `PORT` | 服务器端口 | `3000` |
| `GEMINI_API_KEY` | Google Gemini API 密钥 | 必填 |
| `GEMINI_MODEL` | LLM 模型 | `gemini-2.0-flash` |
| `EMBEDDING_MODEL` | 嵌入向量模型 | `gemini-embedding-exp-03-07` |
| `DISABLE_EMBEDDINGS` | 设为 `true` 禁用向量搜索 | `false` |

## API 接口

### 问答接口

#### POST /ask
主查询接口，支持智能分类和路由。

**请求：**
```json
{
  "query": "对比产品A和产品B",
  "queryScope": {
    "product": "可选过滤条件",
    "region": "可选过滤条件"
  },
  "options": {
    "useClassification": true,
    "useHybridSearch": true
  }
}
```

**响应：**
```json
{
  "query_type": "comparison",
  "success": true,
  "data": {
    "entities": ["产品A", "产品B"],
    "table": { "headers": [...], "rows": [...] },
    "summary": "...",
    "recommendation": "..."
  },
  "sources": [...]
}
```

#### POST /ask/simple
简单的 BM25 查找，不进行分类。

#### POST /classify
仅对查询进行分类，不回答问题。

### 文档管理

#### POST /upload
上传并处理单个文档。

**请求（multipart/form-data）：**
- `file`：文档文件
- `targetNodeId`（可选）：指定挂载的节点
- `useLLM`（可选）：使用 LLM 提取元数据（默认：true）
- `detectConflicts`（可选）：检测冲突（默认：true）

#### POST /upload/batch
批量上传多个文档（最多20个）。

#### GET /documents
列出所有已上传的文档。

#### GET /documents/:id
获取文档详情。

#### DELETE /documents/:id
删除文档及其分块。

### 节点管理

#### GET /nodes
获取完整的树形结构。

#### GET /nodes/:id
获取指定节点。添加 `?context=true` 可获取父节点/兄弟节点/子节点。

#### GET /nodes/:id/children
获取节点的直接子节点。

#### POST /nodes
创建新节点。

**请求：**
```json
{
  "node_id": "product.new-category",
  "name": "新分类",
  "parent_id": "product",
  "summary": "新分类的描述"
}
```

#### PUT /nodes/:id
更新现有节点。

### 分块管理

#### GET /chunks/:nodeId
获取指定节点的所有分块。

#### GET /chunks/detail/:id
获取指定分块的详情。

### 冲突管理

#### GET /conflicts
获取未解决的冲突。

#### POST /conflicts/:id/resolve
解决冲突。

### 向量嵌入管理

#### POST /embeddings/sync
为所有缺少嵌入的节点和分块生成向量嵌入。

#### GET /embeddings/coverage
查看向量嵌入覆盖率统计。

### 系统接口

#### GET /health
健康检查。

#### GET /stats
获取系统统计信息。

## 查询类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `simple_lookup` | 直接事实检索 | "退货政策是什么？" |
| `comparison` | 对比多个实体 | "产品A和产品B有什么区别？" |
| `recommendation` | 基于条件推荐 | "哪个产品适合初学者？" |
| `reasoning` | 多跳推理 | "为什么X会影响Y？" |
| `aggregation` | 跨源汇总 | "列出所有产品类别" |

## 支持的文件类型

| 扩展名 | 类型 |
|--------|------|
| `.txt`, `.md` | 文本/Markdown |
| `.pdf` | PDF |
| `.docx` | Word 文档 |
| `.xlsx`, `.xls` | Excel 表格 |
| `.html`, `.htm` | HTML |
| `.csv` | CSV |
| `.json` | JSON |

## 项目结构

```
src/
├── server.js              # Express + WebSocket 服务器（74 行）
├── routes/                # 路由模块（按功能拆分）
│   ├── datasets.js        #   数据集 CRUD + 导出/复制/统计
│   ├── ingest.js          #   上传、批量上传、任务管理
│   ├── query.js           #   /ask, /ask/simple, /classify, 建议, 反馈
│   ├── documents.js       #   文档管理
│   ├── nodes.js           #   节点、分块、别名
│   ├── conflicts.js       #   冲突管理
│   ├── embeddings.js      #   向量同步和覆盖率
│   ├── stats.js           #   统计、健康检查、清空树
│   └── entities.js        #   实体和事实
├── db/
│   ├── db.js              # 代理式数据库路由
│   ├── activeDb.js        # AsyncLocalStorage 请求上下文
│   ├── initDatasetDb.js   # 数据集 Schema 初始化
│   ├── registry.js        # 数据集注册表 CRUD
│   ├── datasetManager.js  # 连接池 + 数据集生命周期
│   └── init.sql           # 数据库表结构
├── kg/
│   ├── qa.js              # 主问答流程
│   ├── recallNodes.js     # 混合检索协调器
│   ├── strategies/        # 检索策略模块
│   │   ├── bm25.js        #   BM25 关键词检索
│   │   ├── vector.js      #   向量相似度检索
│   │   ├── hierarchy.js   #   层级上下文扩展
│   │   ├── aliases.js     #   别名缓存与检索
│   │   ├── expansion.js   #   查询扩展与变体生成
│   │   └── utils.js       #   公共工具（RRF、CJK n-gram、FTS 转义）
│   ├── nodeScoring.js     # 多因子排序
│   ├── graphTraversal.js  # 树遍历
│   └── seedNodes.js       # 初始数据
├── ingest/
│   ├── index.js           # 文档管理 + 管道重导出
│   ├── pipeline/          # 导入管道
│   │   ├── index.js       #   运行器：阶段循环、回滚、WS 进度推送
│   │   └── stages.js      #   6 个阶段函数（解析→注册→分块→映射→实体→完成）
│   ├── jobQueue.js        # 后台导入队列，支持重试
│   ├── fileParser.js      # 多格式文件解析
│   ├── chunker.js         # 文本分块
│   ├── metadataExtractor.js # 关键词/实体提取
│   ├── nodeMapper.js      # 分块到节点映射
│   └── conflictDetector.js # 冲突检测
├── embedding/
│   ├── embedder.js        # Gemini 向量嵌入
│   ├── vectorStore.js     # 向量存储和搜索
│   └── chunkEmbeddings.js # 嵌入管理
├── extraction/
│   └── entityFactExtractor.js # 实体与事实提取
├── query/
│   ├── classifier.js      # 查询分类
│   ├── queryPlanner.js    # 复杂查询分解
│   ├── multiNodeRetriever.js # 多实体检索
│   ├── comparator.js      # 对比处理器
│   ├── recommender.js     # 推荐处理器
│   ├── reasoner.js        # 多跳推理
│   └── feedback.js        # 点赞/踩反馈记录
└── utils/
    ├── progressEmitter.js # WebSocket 任务进度订阅与广播
    ├── logger.js
    └── tokenTracker.js
```

## 使用示例

### 基本问答
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "销售流程是什么？"}'
```

### 上传文档
```bash
curl -X POST http://localhost:3000/upload \
  -F "file=@./documents/policy.pdf" \
  -F "targetNodeId=sales.rules"
```

### 产品对比
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "产品A和产品B有什么区别？"}'
```

### 获取推荐
```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "我需要处理大量数据，应该选择哪个产品？"}'
```

### 同步向量嵌入
```bash
curl -X POST http://localhost:3000/embeddings/sync
```

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| "GEMINI_API_KEY not set" | 在 `.env` 文件中添加有效的 API 密钥 |
| "No matching nodes found" | 运行 `npm run seed` 并上传文档 |
| 查询速度慢 | 运行 `POST /embeddings/sync` |
| 文件上传失败 | 检查文件大小（<50MB）和类型 |

## 许可证

ISC
