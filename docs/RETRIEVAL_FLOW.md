# TreeKB Retrieval 详细流程

本文档聚焦 `kg-mvp` 的查询检索链路（`/ask`），描述从请求进入到召回、重排、上下文构建、答案生成的真实执行路径与关键阈值。

## 1. 入口与模式

查询入口在 `src/routes/query.js`：

- `POST /ask`：主入口，走 `ask()` 智能路由。
- `POST /ask/simple`：兼容入口，跳过查询分类，直接走 `simple_lookup` 路径。

主函数：`src/kg/qa.js -> ask({ query, queryScope, options })`。

## 2. ask() 顶层编排

`ask()` 的执行顺序：

1. 参数校验：`query` 必须是非空字符串。
2. 记录查询历史：`recordQuery(query, { queryType: "pending" })`。
3. 查询分解（可选）：`decomposeQuery(query)`。
4. 查询分类（可选）：`classifyQuery(query)`，或 `forceQueryType` 强制覆盖。
5. 按类型路由到 handler：
   - `simple_lookup` -> `handleSimpleLookup`
   - `comparison` -> `handleComparisonQuery`
   - `recommendation` -> `handleRecommendationQuery`
   - `reasoning` -> `handleReasoningQuery`
   - `aggregation` -> `handleAggregationQuery`

说明：

- `decomposeQuery()` 当前主要用于 trace，不参与主检索编排决策（没有把子查询结果并回主流程）。

## 3. /ask 可配置项（默认值）

`ask()` 支持的主要参数（`options`）：

- `useClassification=true`
- `useHybridSearch=true`
- `useDecomposition=true`
- `useReranking=true`
- `useCitations=true`
- `includeRelatedQuestions=true`
- `trace=false`
- `forceQueryType=null`
- `topK=10`
- `maxChunks=20`
- `minConfidence=0.0`
- `hybridAlpha=0.5`
- `rerankerThreshold=0.2`
- `contextWindow=2`
- `temperature=0.3`

边界收敛：

- `topK` 1~50
- `maxChunks` 1~100
- `minConfidence` 0~1
- `hybridAlpha` 0~1
- `rerankerThreshold` 0~1
- `contextWindow` 0~5
- `temperature` 0~1

注意：

- 在当前 `simple_lookup` 主链路中，`topK/minConfidence/hybridAlpha/useHybridSearch` 没有直接参与排序或过滤（会回传在 `retrieval_options`，但不改变主检索核心逻辑）。
- `useHybridSearch` 主要影响 `aggregation` 路径（是否用 `hierarchicalRecallNodes`）。

## 4. Simple Lookup 主检索链路（核心）

`handleSimpleLookup()` 是当前最完整、最关键的检索实现。可以拆成 9 步。

### 4.1 Step A: 构建 Retrieval Query Variants

调用 `buildRetrievalQueryVariants(query, { maxVariants: 6, useExpansion: true, useAliasPivot: true })`：

- 原始 query（权重最高）。
- 标准化 query（去掉特殊引号等）。
- LLM 扩展词（`expandQuery`）。
- 别名 pivot（`searchByAliases`，再引入节点名/节点别名）。

每个变体都有 `text/weight/lang/sources`。

### 4.2 Step B: 直接 chunk 检索（先做）

对前 5 个 query variants 做四路直接检索，并汇总到 `directChunkMap`：

1. 文档标题检索：`searchChunksByDocTitle`
2. BM25 chunk 检索：`bm25RecallChunks`
3. LIKE 内容检索：`simpleContentSearch`
4. 关键词标签检索：`keywordTagSearch`

分数处理：

- BM25 使用绝对归一化：`normalized = min(1, bm25 / 15.0)`（`MAX_EXPECTED_BM25=15.0`）。
- 各路得分再乘 query variant 权重。
- 同一 chunk 保留最高 `relevance_score`，累积命中 source。

### 4.3 Step C: 层级树检索（hierarchicalRetrieve）

调用 `hierarchicalRetrieve(query, {...})` 参数：

- `beamWidth=3`
- `maxDepth=5`
- `includeAncestors=true`
- `includeSiblings=true`
- `includeDescendants=true`
- `ancestorLevels=2`
- `siblingNodesPerSeed=3`
- `descendantDepth=2`
- `descendantNodesPerSeed=5`

输出：

- `hierarchicalChunks`
- `hierarchicalNodes`
- `treePaths`
- `sources`（tree_navigation / ancestor_enrichment / sibling_expansion / descendant_exploration）

### 4.4 Step D: Chunk Selection 策略（关键）

策略是“层级优先 + 受控补充”，不是简单 merge：

1. 如果有 `hierarchicalChunks`：
   - 先全部作为主集合（`retrieval_source=hierarchical`）。
2. 若层级结果偏少（`SUPPLEMENT_THRESHOLD=8`）：
   - 用 `directChunks` 做补充。
   - 同文档优先：先加 `supplement_same_doc`。
   - 跨文档只在总量仍很薄（<4）时才加：`supplement_cross_doc`。
3. 若层级结果不少，但 direct 中存在“标题匹配 query 且层级未覆盖的跨文档 chunk”：
   - 允许加入 `query_matched_doc`，避免错过目标文档。
4. 如果层级完全失败：
   - 直接回退全局 direct：`retrieval_source=direct`。

这个策略的目标是同时避免：

- 纯 merge 导致跨文档污染。
- 纯 strict hierarchical 导致遗漏具体事实。

### 4.5 Step E: 初排 + 截断

- 按 `hierarchical_score`（若有）或 `relevance_score` 排序。
- 取前 `maxChunks`。
- 若存在 `hierarchicalNodes`，其首个节点作为 `chosenNode`。

### 4.6 Step F: 反馈增益 + LLM 重排

1. 反馈增益：`applyFeedbackBoost(chunks)`。
2. LLM 重排：`rerankerChunks(query, chunks, { topK: maxChunks, minScore: rerankerThreshold })`。

重排细节：

- 仅在 chunk 数 > 3 且有 LLM key 时触发。
- 重排候选上限 40 条。
- LLM 输出 0-10 分，过滤条件为 `score >= minScore * 10`。
- `reranker` 结果有 5 分钟缓存。

### 4.7 Step G: 邻域上下文扩展

调用 `expandChunksWithContext(chunks, {...})`：

- `windowBefore=contextWindow`
- `windowAfter=contextWindow`
- `maxContextLength=400`（每侧约 200 字）

再调用 `buildExpandedContext(expandedChunks, { includeNeighbors: true, maxTotalLength: 12000 })` 形成最终 chunk 上下文。

### 4.8 Step H: 实体事实补充

调用 `getFactsForQuestion(query, { maxFacts: 10, maxEvidence: 5 })`：

- 从 entity/fact 图谱检索事实。
- 将事实文本追加到上下文末尾 `[Extracted Facts]`。

### 4.9 Step I: 答案生成与后处理

1. 生成答案：
   - `useCitations=true`：`generateAnswerWithCitations(...)`
   - 否则 `callLLMAnswer(...)`
2. 置信度：`calculateConfidence({ chunks, nodes, query, answer, queryType })`
3. 相关问题：`generateRelatedQuestions(...)`
4. 返回结果：
   - `llm_response`
   - `citations`
   - `confidence/confidence_details`
   - `facts/tree_paths/retrieval_sources/retrieval_options`
   - 必要时附加 fallback 提示消息

## 5. Aggregation 检索链路

`handleAggregationQuery()` 与 simple_lookup 不同点：

1. 节点召回：
   - `useHybridSearch=true` -> `hierarchicalRecallNodes(query, 30, { useHierarchy: true, useAliases: true })`
   - 否则 `bm25RecallNodes(query, 30)`
2. 使用节点上限：`AGGREGATION_TOP_N=20`。
3. 对前 N 节点拉全量 chunk。
4. 追加文档标题检索结果（处理“某文档里有什么”类问题）。
5. 再做 `enhancedRetrieval(query, { useEntities/useFacts/useHierarchy })` 补充。
6. 若仍为空，最后回退 `simpleContentSearch`。
7. 将最多 40 条 chunk 组 context，调用 `callLLMAnswer` 生成聚合回答。

## 6. Reasoning / Recommendation / Comparison 差异

### 6.1 Reasoning

`handleReasoningQuery()`：

- 先调用 `enhancedRetrieval(..., useMultiHop=true, queryType="reasoning")` 获取多跳补充上下文。
- 再调用 `reason()` 推理器。
- 返回推理步骤、关键事实、限制项等。

### 6.2 Recommendation

`handleRecommendationQuery()`：

- 先走 `generateRecommendation`。
- 推荐结果为空时回退 `handleSimpleLookup`。

### 6.3 Comparison

`handleComparisonQuery()`：

- 有足够实体时调用 `generateComparison`。
- 实体不足时回退 `handleSimpleLookup`。

## 7. 底层召回模块（recallNodes）

`hybridRecallNodes()` 的多源召回顺序：

1. BM25 节点召回（多 query variants）。
2. 向量节点召回（前若干 variants）。
3. 可选 chunk 反推节点：
   - BM25 chunks -> nodes
   - 文档标题 -> nodes
   - 向量 chunks -> nodes
4. 名称 + 别名匹配。
5. 融合：
   - 默认 `RRF`（`k=60`）
   - 或加权融合（`bm25Weight=0.4`, `vectorWeight=0.6`）。

关键默认参数：

- `vectorThreshold=0.25`
- `maxQueryVariants=4`
- `maxVectorVariants=2`
- `includeChunkSearch=true`

## 8. 层级检索算法（hierarchicalRetrieve）

核心逻辑：

1. Top-down beam search（`navigateTreeTopDown`）：
   - 根层不按 beamWidth 截断。
   - 深层按 `beamWidth * 2` 保留。
   - 子节点分数融合：`child*0.72 + parent*0.28`，并乘 `depthDecay=0.96^depth`。
2. 从相关节点取 chunk。
3. 祖先补充：`ancestorDecay=0.82`。
4. 兄弟扩展：`siblingDecay=0.78`。
5. 后代探索（受限深度与数量）。
6. 层级评分（`applyHierarchicalScoring`）：
   - 结构衰减：`structuralDecayBase=0.88`
   - 邻近性加成：`proximityBoost=0.22`
   - 关系类型加权（direct/child/ancestor/sibling）
   - 节点深度衰减与 authority 调整
7. 最终排序并截断到 `maxChunks`。

## 9. 向量检索前置条件

向量召回依赖 embedding 已生成：

- 生成入口：`/embeddings/sync`（不是 ingest 自动执行）。
- `vectorRecallNodes/vectorRecallChunks` 先生成 query embedding，再做余弦相似度。

关键 embedding 参数：

- 向量维度：`3072`
- 批量上限：`100`
- 单文本截断：`2048` 字符
- 最小请求间隔：`100ms`
- 内存缓存：`1000` 条

## 10. 检索安全与稳健性

### 10.1 FTS 安全

- 所有 BM25 query 先经 `extractSearchTerms + escapeFtsQuery` 处理。
- 过滤 FTS 操作符注入风险，仅保留词项并用引号拼接 `OR`。

### 10.2 失败回退

- 向量失败：回落到 BM25/内容检索。
- LLM 重排失败：保留原排序。
- 引用生成失败：返回降级结果。
- 层级定位失败：回退全局 direct chunk 检索。

## 11. Trace 观测点（推荐开启）

`options.trace=true` 时，响应包含 `trace.steps`，可看到：

- Query 分类/路由
- Query variants
- Direct chunk search 各源命中
- Hierarchical 各阶段（导航/祖先/兄弟/后代/评分）
- Chunk selection 决策
- Re-ranking / Context Expansion / Fact Retrieval
- LLM 生成 / Confidence / Related Questions

这对调试“为什么命中错文档”“为什么答案漏信息”非常关键。

## 12. 常见调参建议（按现状）

1. 召回太少：优先增大 `maxChunks`，其次降低 `rerankerThreshold`。
2. 跨文档串答：检查层级是否命中正确节点，必要时提高文档标题约束或加强节点命名。
3. 数字事实漏召回：确认 `keywordTagSearch` 与实体事实表是否有对应标签/事实。
4. 向量无效：先检查是否执行过 `/embeddings/sync`。
