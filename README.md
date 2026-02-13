# TreeKB - Tree-based Knowledge Graph System

[English](#english) | [中文](#中文)

---

<a name="english"></a>
# English

A hierarchical knowledge management system that processes documents into a tree structure and provides intelligent retrieval with support for complex queries including comparisons, recommendations, and multi-hop reasoning.

## Features

- **Hierarchical Knowledge Organization**: Documents are organized into a tree structure for intuitive navigation and context-aware retrieval
- **Multi-Format Document Ingestion**: Support for PDF, DOCX, XLSX, HTML, TXT, Markdown, CSV, and JSON files
- **Hybrid Search**: Combines BM25 lexical search with vector semantic search using Reciprocal Rank Fusion (RRF)
- **Intelligent Query Routing**: Automatically classifies queries and routes them to specialized handlers
- **Complex Query Support**:
  - Simple lookups
  - Entity comparisons
  - Criteria-based recommendations
  - Multi-hop reasoning across the knowledge tree
- **Conflict Detection**: Identifies contradictions between knowledge chunks with LLM-powered analysis
- **Bilingual Support**: Automatic Chinese/English detection and response generation
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
│                         API Layer                                │
│                      (Express.js REST)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Ingestion  │  │    Query     │  │      Retrieval       │  │
│  │   Pipeline   │  │   Handlers   │  │       Engine         │  │
│  ├──────────────┤  ├──────────────┤  ├──────────────────────┤  │
│  │ File Parser  │  │ Classifier   │  │ BM25 (FTS5)          │  │
│  │ Chunker      │  │ Comparator   │  │ Vector Search        │  │
│  │ Metadata     │  │ Recommender  │  │ Hybrid (RRF)         │  │
│  │ Node Mapper  │  │ Reasoner     │  │ Graph Traversal      │  │
│  │ Conflict Det │  │ Query Planner│  │ Multi-factor Ranking │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                      Storage Layer                               │
│              (SQLite + FTS5 + Vector Store)                      │
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
src/
├── server.js              # Express API server
├── db/
│   ├── db.js              # Database connection & utilities
│   └── init.sql           # Schema definition
├── kg/
│   ├── qa.js              # Main Q&A orchestration
│   ├── recallNodes.js     # Search (BM25, vector, hybrid)
│   ├── nodeScoring.js     # Multi-factor ranking
│   ├── graphTraversal.js  # Tree navigation
│   └── seedNodes.js       # Initial data seeding
├── ingest/
│   ├── index.js           # Pipeline entry point
│   ├── fileParser.js      # Multi-format file parsing
│   ├── chunker.js         # Text chunking
│   ├── metadataExtractor.js # Keyword/entity extraction
│   ├── nodeMapper.js      # Chunk-to-node assignment
│   └── conflictDetector.js # Conflict detection
├── embedding/
│   ├── embedder.js        # Gemini embedding generation
│   ├── vectorStore.js     # Vector storage & search
│   └── chunkEmbeddings.js # Embedding management
└── query/
    ├── classifier.js      # Query classification
    ├── queryPlanner.js    # Complex query decomposition
    ├── multiNodeRetriever.js # Multi-entity retrieval
    ├── comparator.js      # Comparison handler
    ├── recommender.js     # Recommendation handler
    └── reasoner.js        # Multi-hop reasoning
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
| "GEMINI_API_KEY not set" | Add valid API key to `.env` file |
| "No matching nodes found" | Run `npm run seed` and upload documents |
| Slow queries | Run `POST /embeddings/sync` |
| File upload failures | Check file size (<50MB) and type |

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
- **冲突检测**：使用 LLM 驱动的分析识别知识片段之间的矛盾
- **双语支持**：自动检测中英文并生成相应语言的回答
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
├── server.js              # Express API 服务器
├── db/
│   ├── db.js              # 数据库连接和工具
│   └── init.sql           # 数据库表结构
├── kg/
│   ├── qa.js              # 主问答流程
│   ├── recallNodes.js     # 搜索（BM25、向量、混合）
│   ├── nodeScoring.js     # 多因子排序
│   ├── graphTraversal.js  # 树遍历
│   └── seedNodes.js       # 初始数据
├── ingest/
│   ├── index.js           # 导入管道入口
│   ├── fileParser.js      # 多格式文件解析
│   ├── chunker.js         # 文本分块
│   ├── metadataExtractor.js # 关键词/实体提取
│   ├── nodeMapper.js      # 分块到节点映射
│   └── conflictDetector.js # 冲突检测
├── embedding/
│   ├── embedder.js        # Gemini 向量嵌入
│   ├── vectorStore.js     # 向量存储和搜索
│   └── chunkEmbeddings.js # 嵌入管理
└── query/
    ├── classifier.js      # 查询分类
    ├── queryPlanner.js    # 复杂查询分解
    ├── multiNodeRetriever.js # 多实体检索
    ├── comparator.js      # 对比处理器
    ├── recommender.js     # 推荐处理器
    └── reasoner.js        # 多跳推理
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
