# TreeKB 文档处理详细流程

本文档描述 `kg-mvp` 当前代码中的真实文档处理链路，从上传请求到落库、冲突检测、实体事实抽取、失败回滚与重试。

## 1. 入口与触发方式

核心入口在 `src/routes/ingest.js`：

- `POST /upload`：单文件上传。
- `POST /upload/batch`：批量上传，最多 20 个文件。

请求参数（`multipart/form-data`）：

- `file` 或 `files`：上传文件。
- `targetNodeId`：可选，指定目标节点。
- `useLLM`：默认 `true`，控制是否启用 LLM（KP/冲突/实体等）。
- `detectConflicts`：默认 `true`，控制是否做冲突检测。
- `sync`：默认 `false`。`true` 为同步处理，`false` 为异步入队。

上传层约束：

- 文件大小上限：50MB。
- 支持扩展名：`.txt .md .pdf .docx .doc .xlsx .xls .html .htm .json .csv`。
- 上传文件保存目录：`uploads/`。

## 2. 同步与异步两条路径

### 2.1 同步路径 (`sync=true`)

1. 路由直接调用 `processDocument(filePath, processOptions)`。
2. 处理完成后立即返回结果。
3. 路由会尝试删除上传临时文件。

### 2.2 异步路径 (`sync=false`)

1. 路由调用 `enqueueIngestionJob(...)` 或 `enqueueIngestionJobs(...)`。
2. 返回 `202 Accepted` + job 信息。
3. 后台 `startIngestionQueue()` 自动消费队列并执行 `processDocument(...)`。

## 3. 异步队列状态机（ingestion_jobs）

队列实现：`src/ingest/jobQueue.js` + `src/db/repositories/JobRepo.js`。

状态：

- `queued`
- `processing`
- `completed`
- `failed`
- `cancelled`
- `rate_limited`

默认参数（可通过环境变量覆盖）：

- 并发：`INGEST_QUEUE_CONCURRENCY=1`（默认顺序执行，防止 rate-limit；设为 2+ 可恢复并行）
- 最大重试：`INGEST_QUEUE_MAX_ATTEMPTS=3`
- 重试间隔：`INGEST_QUEUE_RETRY_DELAY_MS=5000`

其他批处理大小（均默认为 1，顺序执行；可通过环境变量调大以恢复并行）：

- `INGEST_SEGMENT_BATCH=1`：KP 提取时的分段批次大小（原默认 4）
- `INGEST_KP_BATCH=1`：KP 决策引擎批次大小（原默认 8）
- `INGEST_BATCH_CONCURRENCY=1`：pipeline 中每批文档并发数（原默认 3）

状态流转：

1. `queued -> processing`：`claimNext()` 抢占任务并 `attempt_count + 1`。
2. 处理成功：`processing -> completed`。
3. 处理失败且可重试：`processing -> queued`（`available_at` 延后）。
4. 重试耗尽：`processing -> failed`。
5. 命中 429：`processing -> rate_limited`（暂停，等待人工重试）。
6. 仅 `queued` 可取消：`queued -> cancelled`。
7. `failed/cancelled/rate_limited` 可通过重试接口回到 `queued`。

特别说明：

- `RateLimitError` 不会立即失败，而是标记为 `rate_limited`。
- 成功、重复文档、最终失败后，队列可按配置清理上传文件（`INGEST_CLEANUP_ON_SUCCESS`）。

## 4. 单文档处理流水线（processDocument）

主流程在 `src/ingest/pipeline/index.js`，按固定 stage 顺序执行：

1. `parse`
2. `register`
3. `enrich`（KP 抽取）
4. `map`（映射到树）
5. `entities`（实体/事实抽取）
6. `finalize`

若文档在 `register` 判定为重复，会短路后续 stage。

---

### 4.1 Stage 1: parse（解析文件）

代码：`stageParseFile` + `parseFile`。

处理内容：

1. 校验文件存在、后缀支持。
2. 按类型抽取文本：
   - `txt/md`：直接读文本。
   - `pdf`：`pdf-parse`。
   - `doc/docx`：`mammoth`。
   - `xls/xlsx/csv`：`xlsx` 解析。
   - `html/htm`：`cheerio` 去脚本后提取正文。
   - `json`：结构化转文本。
3. 生成文件元信息：`filename/fileType/fileSize/modifiedAt`。
4. 若无可提取文本，直接抛错。

---

### 4.2 Stage 2: register（注册文档）

代码：`stageRegister`。

处理内容：

1. 对原文件二进制计算 `SHA-256`。
2. 在 `documents` 表按 `file_hash` 查重（忽略 `deleted/failed`）。
3. 非重复：插入文档记录（初始 `status='pending'`）。
4. 重复：写入结果错误 `duplicate hash`，并标记 `ctx.isDuplicate=true`。

---

### 4.3 Stage 3: enrich（知识点抽取，KP）

代码：`stageExtractKPs` + `extractKnowledgePoints`。

进度写入：

- `kp_extraction` 25%（开始）
- `kp_extraction` 65%（完成）

处理内容：

1. 识别权威等级（`policy/sop/training/personal`）。
2. 若开启 LLM：
   - **章节标题检测**：`detectSectionHeadings()` 识别文本中的标题结构（正则匹配全大写行、markdown `#`、编号章节）。支持 CJK 标题格式：`第X章/节`、`一、`/`（一）` 等。检测到的标题结构作为上下文传递给 KP 提取提示词。
   - 文本按 `5000` 字符分段，`500` 重叠，尽量按段落边界切分。
   - 每段调用 `kpExtraction` 提示词，`temperature=0.0, seed=42`（所有 ingestion LLM 调用均使用 temperature 0.0 + seed 42 以提高确定性）。
   - 每段之间延迟 `200ms`。批次大小由 `INGEST_SEGMENT_BATCH` 控制（默认 1，顺序执行）。
   - 单段失败则降级为段落切分兜底。
3. 若关闭 LLM 或无 Key：
   - 直接按空行切段（段长 >= 50）生成 `legacy_chunk`。
   - **段落兜底 chunk**：`extractParagraphFallbacks()` 按 `\n\n` 分割，合并短段，过滤 >= 80 字符，上限 15 条。`kp_type: "paragraph_context"`，`topic_hint: "General"`（根节点）。与已有 KP 去重阈值 0.85 Dice。
4. 归一化 KP：
   - `statement` 少于 10 字符丢弃。
   - `kp_type` 约束在 `fact/rule/definition/procedure/example/context`。
   - `content = "${statement}\n${sourceExcerpt}"`，将原文摘录拼接在 statement 后面，确保原文中的数字等细节始终可通过 FTS5 检索。
5. 跨分段去重：
   - 用 `wordDiceSimilarity`，阈值 `0.90`。
6. 重建连续 `index`。

---

### 4.4 Stage 4: map（映射到知识树 + 冲突检测 + 别名）

代码：`stageMapChunks` + `autoMapChunks`。

#### 分支 A：指定了 `targetNodeId`

1. 每个 chunk 直接插入该节点（不走自动节点决策）。
2. 若开启冲突检测，逐条调用 `processNewChunkConflicts`。
3. 按批次写进度（约 68% -> 95%/98%）。

#### 分支 B：未指定 `targetNodeId`（自动映射）

KP 模式下（存在 `topic_hint`）：

1. 规范化 topic（泛化词统一为 `General`）。
2. 主题 canonicalization（可选 LLM）：
   - `searchNodesByName(topic, 12)` 召回候选节点。
   - 让 LLM 决定是否映射到现有节点名。
3. `findOrCreateTopicNode`：
   - 在同父节点下全量扫描 sibling。
   - `Dice >= 0.35` 复用节点。
   - `Dice >= 0.25` 且开启 LLM 时，做一次确认复用。
   - 否则创建新节点。
4. 子主题层判定：
   - 对 `subtopic_hint` 两两算相似度均值。
   - 均值 `< 0.6` 才创建二级子主题节点。
5. 对每个 KP 执行决策引擎 `resolveKPAction`：
   - `IGNORE`：丢弃。
   - `MERGE`：合并来源文档到已存在 chunk。
   - `REPLACE`：新插入后 `supersede` 旧 chunk。
   - `NORMALIZE_THEN_STORE`：LLM 归一化后入库。
   - `STORE`：正常入库。
6. 新建节点后可生成别名（LLM，`maxAliases=8`）。

KP 决策阈值（关键）：

- 忽略低质量：`content<15` 或 `confidence<0.35`。
- 自动合并：`Dice >= 0.90`。
- 合并建议入待审：`0.70 <= Dice < 0.90`。
- 时间信号 + 权威等级 + 高置信触发替换：`confidence>=0.85`。
- LLM 归一化触发：`Dice >= 0.55` 且归一化置信 >= `0.70`。

#### 冲突检测（可选）

1. 新 chunk 与同节点已有 chunk 对比（默认最多 20 条）。
2. 优先 LLM 语义冲突判断，失败回退规则法。
3. 发现冲突后写入 `conflicts`，并更新节点 `conflict_score`。

---

### 4.5 Stage 5: entities（实体/事实抽取）

代码：`stageExtractEntities` + `processDocumentForExtraction`。

进度写入：

- `entity_extraction` 96%

处理内容：

1. 读取文档下 active chunks。
2. 按批处理：`batchSize=5`，批次间延迟 `500ms`（LLM 模式）。
3. 每 chunk 抽取：
   - LLM 输出 JSON（含自动修复/兜底）。
   - 或规则法 fallback。
4. 落库：
   - `entities` / `facts`
   - `entity_facts`
   - `entity_mentions`
   - `fact_evidence`
5. 本阶段失败不阻断主流程，仅记录 warning。

---

### 4.6 Stage 6: finalize（收尾）

代码：`stageFinalize`。

进度写入：

- `finalizing` 99%
- `completed` 100%

处理内容：

1. 更新 `documents.status='processed'`。
2. 写入 `chunk_count` 和 `processed_at`。

## 5. 进度追踪与前端可视化

后端在处理过程中把步骤写入 `documents.metadata_json.processing`：

- `step`
- `message`
- `progress`
- `status`
- `updated_at`
- `history`（保留最近 24 条）

同时如果是异步 job，会通过 WebSocket 推送：

```json
{
  "type": "job_progress",
  "jobId": 123,
  "datasetId": "xxx",
  "step": "kp_extraction",
  "progress": 65,
  "message": "Extracted 42 knowledge points.",
  "status": "processing",
  "ts": 1700000000000
}
```

前端通过 `watch/unwatch` 订阅 job 进度。

## 6. 失败回滚与幂等保障

当 pipeline 抛错时（`processDocument`）：

1. 进入 `rollbackFailedDocument(docId)` 事务。
2. 对共享知识点（`source_documents_json` 多来源）只移除当前文档来源，不删除 chunk。
3. 删除仅属于该文档的 chunk、冲突、embedding、FTS 索引。
4. 重算受影响节点的 `conflict_score`。
5. 文档标记为 `failed`。

429 特殊处理：

- `RateLimitError` 会被继续抛给队列层。
- 队列把 job 置为 `rate_limited`，保留文件，等待人工触发重试。

## 7. 文档处理涉及的核心表

- `documents`：文档记录、状态、处理进度元数据。
- `ingestion_jobs`：异步任务队列。
- `chunks` / `chunks_fts`：知识点与全文索引。
- `nodes` / `nodes_fts`：知识树节点与索引。
- `conflicts`：冲突记录。
- `entities` / `facts` / `entity_facts` / `entity_mentions` / `fact_evidence`：实体事实图谱。
- `embeddings`：向量缓存（按需同步，不在主入库链路自动生成）。

## 8. 运维常用接口（文档处理相关）

- `POST /upload`：上传单文件（同步/异步）。
- `POST /upload/batch`：上传批量文件（同步/异步）。
- `GET /ingest/jobs`：查看任务列表。
- `GET /ingest/jobs/:id`：查看单任务。
- `POST /ingest/jobs/:id/retry`：重试失败/限流/取消任务。
- `POST /ingest/jobs/:id/cancel`：取消排队中的任务。
- `GET /ingest/queue/stats`：队列统计。
- `GET /documents`：文档列表（含处理状态和进度字段）。
- `GET /documents/:id`：文档详情。
- `DELETE /documents/:id`：删除文档及关联知识数据。
