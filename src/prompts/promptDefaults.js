/**
 * Prompt Defaults Catalog
 *
 * Central registry of all LLM prompt templates with metadata.
 * Each prompt has a unique key, label, category, description,
 * list of available {{variables}}, and the default template text.
 *
 * Stored overrides in dataset_config use key = "prompt:<promptKey>".
 */

// ── Ingestion prompts ─────────────────────────────────────────────────────────

const INGESTION = "ingestion";
const QUERY = "query";
const ROUTING = "routing";
const MANAGE = "manage";

export const PROMPT_CATALOG = {

  // ── KP Extraction ──────────────────────────────────────────────────────────

  kpExtraction_en: {
    label: "KP Extraction (English)",
    category: INGESTION,
    description: "Extracts atomic Knowledge Points from document text",
    variables: ["docTitle", "textSegment"],
    default: `You are a knowledge base assistant. Extract all atomic Knowledge Points (KPs) from the document text.

Document title: {{docTitle}}
Text:
"""
{{textSegment}}
"""

Rules:
1. Each KP must be a complete, self-contained statement understandable without surrounding context.
2. Granularity: exactly one fact, rule, definition, procedure step, or example per KP.
3. Preserve exact numbers, conditions, and qualifiers from the source.
4. source_excerpt is a verbatim quote from the original text (max 200 chars).
5. topic_hint and subtopic_hint: short topic labels (2-5 words) representing the SPECIFIC subject area of each KP.
   - topic_hint should reflect the actual subject (e.g., "Mars Geology", "Employee Benefits", "Network Security"), NOT generic labels like "General", "Information", "Content", or "Document".
   - Different KPs covering different subjects MUST use different topic_hints.
   - subtopic_hint should be a narrower sub-category within the topic_hint (e.g., topic_hint="Mars Geology", subtopic_hint="Volcanic Activity").
6. kp_type must be one of: fact | rule | definition | procedure | example | context

Return a JSON array only (no markdown, no explanation):
[{"statement":"...","kp_type":"...","topic_hint":"...","subtopic_hint":"...","tags":[...],"confidence":0.9,"source_excerpt":"..."}]`
  },

  kpExtraction_zh: {
    label: "KP Extraction (Chinese)",
    category: INGESTION,
    description: "从文档文本中提取原子知识点",
    variables: ["docTitle", "textSegment"],
    default: `你是知识库构建助手。从以下文档中提取所有原子知识点（KP）。

文档标题：{{docTitle}}
文本：
"""
{{textSegment}}
"""

规则：
1. 每个知识点必须独立完整，无需上下文即可理解。
2. 粒度要细：一条事实、规则、定义、步骤或示例对应一个知识点。
3. 保留原文中的数字、条件和限定词。
4. source_excerpt为原文逐字摘录（最多200字）。
5. topic_hint和subtopic_hint为简短主题标签（3-8字），代表每个知识点的具体主题领域。
   - topic_hint应反映具体主题（如"火星地质"、"员工福利"、"网络安全"），不要使用"一般"、"信息"、"内容"、"文档"等通用标签。
   - 不同主题的知识点必须使用不同的topic_hint。
   - subtopic_hint应为topic_hint的更细分类别（如topic_hint="火星地质"，subtopic_hint="火山活动"）。
6. kp_type必须为以下之一：fact | rule | definition | procedure | example | context

仅返回JSON数组（无markdown，无说明）：
[{"statement":"...","kp_type":"...","topic_hint":"...","subtopic_hint":"...","tags":[...],"confidence":0.9,"source_excerpt":"..."}]`
  },

  // ── Metadata Extraction ────────────────────────────────────────────────────

  metadataExtraction_en: {
    label: "Metadata Extraction (English)",
    category: INGESTION,
    description: "Extracts keywords, entities, topics, and summary from document content",
    variables: ["docTitle", "content"],
    default: `Analyze this document and extract metadata. Return ONLY valid JSON.

Document title: {{docTitle}}
Content:
{{content}}

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
}`
  },

  metadataExtraction_zh: {
    label: "Metadata Extraction (Chinese)",
    category: INGESTION,
    description: "从文档内容中提取关键词、实体、主题和摘要",
    variables: ["docTitle", "content"],
    default: `分析以下文档并提取元数据。仅返回有效JSON。

文档标题: {{docTitle}}
内容:
{{content}}

提取并返回以下字段的JSON:
{
  "keywords": ["最重要的10个关键词/短语"],
  "entities": {
    "products": ["提到的产品名称"],
    "organizations": ["公司/组织名称"],
    "people": ["人名"],
    "locations": ["地点名称"],
    "dates": ["重要日期"]
  },
  "chunk_type": "policy(政策)|procedure(流程)|faq(常见问题)|guide(指南)|reference(参考)|announcement(公告)|report(报告)|other(其他) 之一",
  "topics": ["涵盖的主要主题(最多5个)"],
  "summary": "一句话摘要",
  "language": "zh",
  "authority_level": "policy(官方规则)|sop(标准流程)|training(培训)|personal(非正式) 之一"
}`
  },

  // ── Node Suggestion ────────────────────────────────────────────────────────

  nodeSuggestion_en: {
    label: "Node Suggestion (English)",
    category: INGESTION,
    description: "Determines best node placement for a text chunk in the knowledge tree",
    variables: ["chunkPreview", "keywords", "nodeList", "noExistingText"],
    default: `You are a knowledge organization assistant. Given a text chunk and a list of tree nodes, determine the best node to place this chunk under.

Text chunk (first 500 chars):
{{chunkPreview}}

Keywords: {{keywords}}

Available nodes:
{{nodeList}}

{{noExistingText}}

Return JSON only:
{
  "selected_index": <1-based index of best node, or 0 if none fit>,
  "confidence": <0-1 confidence score>,
  "reasoning": "<brief explanation>",
  "suggested_new_node": {
    "node_id": "<suggested.node.id>",
    "name": "<Node Name>",
    "parent_id": "<suggested parent node_id or null>"
  }
}`
  },

  nodeSuggestion_zh: {
    label: "Node Suggestion (Chinese)",
    category: INGESTION,
    description: "确定文本块在知识树中的最佳节点放置位置",
    variables: ["chunkPreview", "keywords", "nodeList", "noExistingText"],
    default: `你是一个知识组织助手。给定一段文本和树节点列表，确定最佳的节点来放置这段内容。

文本片段(前500字符):
{{chunkPreview}}

关键词: {{keywords}}

可用节点:
{{nodeList}}

{{noExistingText}}

重要：name 字段的值必须与文本内容使用相同的语言（繁体/简体中文）。

仅返回原始JSON（不要使用markdown代码块）:
{
  "selected_index": <最佳节点的1-based索引, 如果都不合适则为0>,
  "confidence": <0-1的置信度分数>,
  "reasoning": "<分类原因的简要说明>",
  "suggested_new_node": {
    "node_id": "<建议的节点ID>",
    "name": "<节点名称（与文本语言一致）>",
    "parent_id": "<建议的父节点ID或null>"
  }
}`
  },

  // ── Document Structure ─────────────────────────────────────────────────────

  documentStructure_en: {
    label: "Document Structure (English)",
    category: INGESTION,
    description: "Analyzes document to suggest a hierarchical node structure",
    variables: ["docTitle", "chunkSummaries"],
    default: `Analyze this document and suggest a hierarchical structure for organizing its content.

Document Title: {{docTitle}}

Content samples:
{{chunkSummaries}}

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
}`
  },

  documentStructure_zh: {
    label: "Document Structure (Chinese)",
    category: INGESTION,
    description: "分析文档并建议层级节点结构",
    variables: ["docTitle", "chunkSummaries"],
    default: `分析此文档并建议用于组织其内容的层级结构。

文档标题: {{docTitle}}

内容示例:
{{chunkSummaries}}

根据内容,建议一个树形结构,包含:
1. 一个主文档节点
2. 2-5个将相关内容分组的主题/章节节点
3. 每个节点的简短描述

重要：name、summary、keywords 字段的值必须与文档内容使用完全相同的文字形式（繁体中文用繁体，简体中文用简体）。

仅返回原始JSON（不要使用markdown代码块）:
{
  "document_node": {
    "name": "主要主题名称（与文档语言一致）",
    "summary": "文档的1-2句摘要（与文档语言一致）"
  },
  "sections": [
    {
      "name": "章节名称（与文档语言一致）",
      "summary": "本章节涵盖的内容（与文档语言一致）",
      "keywords": ["相关", "关键词"],
      "chunk_indices": [0, 1, 2]
    }
  ]
}`
  },

  // ── Conflict Detection ─────────────────────────────────────────────────────

  conflictDetection_en: {
    label: "Conflict Detection (English)",
    category: INGESTION,
    description: "Compares two knowledge chunks for contradictory information",
    variables: ["chunkAId", "chunkASource", "chunkAContent", "chunkBId", "chunkBSource", "chunkBContent"],
    default: `Compare these two knowledge chunks and determine if they contain conflicting information.

Chunk A (ID: {{chunkAId}}, Source: {{chunkASource}}):
{{chunkAContent}}

Chunk B (ID: {{chunkBId}}, Source: {{chunkBSource}}):
{{chunkBContent}}

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
}`
  },

  conflictDetection_zh: {
    label: "Conflict Detection (Chinese)",
    category: INGESTION,
    description: "比较两个知识片段中是否包含冲突信息",
    variables: ["chunkAId", "chunkASource", "chunkAContent", "chunkBId", "chunkBSource", "chunkBContent"],
    default: `比较这两个知识片段,判断它们是否包含冲突的信息。

片段A (ID: {{chunkAId}}, 来源: {{chunkASource}}):
{{chunkAContent}}

片段B (ID: {{chunkBId}}, 来源: {{chunkBSource}}):
{{chunkBContent}}

分析以下方面:
1. 矛盾的事实或数字
2. 冲突的规则或政策
3. 不一致的流程
4. 不同的适用范围条件

仅返回JSON:
{
  "has_conflict": true/false,
  "conflict_type": "numeric(数字)|policy(政策)|procedure(流程)|scope(范围)|factual(事实)|none(无)",
  "severity": "high(高)|medium(中)|low(低)|none(无)",
  "explanation": "冲突的简要说明",
  "recommendation": "建议保留哪个片段及原因(考虑权威性、时效性、范围)"
}`
  },

  // ── Entity/Fact Extraction ─────────────────────────────────────────────────

  entityFactExtraction_en: {
    label: "Entity & Fact Extraction (English)",
    category: INGESTION,
    description: "Extracts named entities and factual statements from text",
    variables: ["content", "existingHint"],
    default: `Analyze this text and extract ALL entities and facts. Be comprehensive.

TEXT TO ANALYZE:
"""
{{content}}
"""
{{existingHint}}

INSTRUCTIONS:
1. Extract EVERY named entity: products, services, features, concepts, people, organizations, locations, processes, technical terms
2. Extract EVERY factual statement: definitions, properties, relationships, procedures, specifications, comparisons
3. Entity names must match the source text exactly (preserve Traditional/Simplified Chinese as-is)
4. Each fact must be a complete, self-contained statement

OUTPUT FORMAT (valid JSON only, no markdown):
{"entities":[{"name":"EntityName","type":"product|concept|person|organization|location|process|feature|service","description":"one-line description","aliases":[]}],"facts":[{"content":"Complete factual statement","type":"attribute|relationship|definition|procedure|specification","confidence":0.9,"entities":["EntityName"]}]}

IMPORTANT: Return ONLY valid JSON. No explanation, no markdown code blocks.`
  },

  entityFactExtraction_zh: {
    label: "Entity & Fact Extraction (Chinese)",
    category: INGESTION,
    description: "从文本中提取命名实体和事实陈述",
    variables: ["content", "existingHint"],
    default: `分析以下文本并提取所有实体和事实。请全面提取。

待分析文本:
"""
{{content}}
"""
{{existingHint}}

说明:
1. 提取每一个命名实体: 产品、服务、功能、概念、人物、组织、地点、流程、技术术语
2. 提取每一个事实陈述: 定义、属性、关系、流程、规格、比较
3. 实体名称必须与原文保持完全一致的文字（包括繁简体）
4. 每个事实必须是完整的、独立的陈述

输出格式(仅有效JSON,无markdown):
{"entities":[{"name":"实体名称","type":"product|concept|person|organization|location|process|feature|service","description":"一行描述","aliases":[]}],"facts":[{"content":"完整的事实陈述","type":"attribute|relationship|definition|procedure|specification","confidence":0.9,"entities":["实体名称"]}]}

重要: 仅返回有效JSON。不要解释,不要markdown代码块。`
  },

  // ── Alias Generation ───────────────────────────────────────────────────────

  aliasGeneration_en: {
    label: "Alias Generation (English)",
    category: INGESTION,
    description: "Generates alternative names/aliases for node search",
    variables: ["context", "maxAliases"],
    default: `Given the following node information from a knowledge base, generate {{maxAliases}} alternative names/aliases that users might use to search for this content. Include:
- Synonyms and related terms
- Abbreviated versions
- Translations (if the original is Chinese, include English; if English, include Chinese)
- Common misspellings or variations
- Related phrases people might search for

{{context}}

Return ONLY a JSON array of strings, no explanation:
["alias1", "alias2", "alias3", ...]`
  },

  aliasGeneration_zh: {
    label: "Alias Generation (Chinese)",
    category: INGESTION,
    description: "为节点搜索生成替代名称/别名",
    variables: ["context", "maxAliases"],
    default: `给定以下来自知识库的节点信息,生成{{maxAliases}}个用户可能用于搜索此内容的替代名称/别名。包括:
- 同义词和相关术语
- 缩写版本
- 翻译(如果原文是中文,包含英文;如果是英文,包含中文)
- 常见拼写错误或变体
- 人们可能搜索的相关短语

{{context}}

仅返回JSON字符串数组,不要解释:
["别名1", "别名2", "别名3", ...]`
  },

  // ── KP Normalization ───────────────────────────────────────────────────────

  kpNormalization: {
    label: "KP Normalization",
    category: INGESTION,
    description: "Merges two similar knowledge statements into one canonical statement",
    variables: ["statementA", "statementB"],
    default: `Two knowledge statements are about the same topic. Merge them into one canonical statement.

Rules:
1. Preserve ALL specific numbers, percentages, durations, and dates from BOTH statements (e.g., "90 days", "85%", "7 hours").
2. When one statement is more specific than the other, keep the more specific phrasing.
3. The result must be factually precise and complete.

Statement A: "{{statementA}}"
Statement B: "{{statementB}}"

Return JSON only: {"canonical": "...", "confidence": 0.0-1.0}`
  },

  // ── Guided Mapping ─────────────────────────────────────────────────────────

  guidedMapping: {
    label: "Guided Schema Mapping",
    category: INGESTION,
    description: "Maps topics to pre-defined schema nodes in guided mode",
    variables: ["schemaLines", "topicLines", "topicIndices"],
    default: `You are organizing a knowledge graph with a fixed schema. Map each topic to the most appropriate schema node, or NONE if no node fits.

SCHEMA NODES:
{{schemaLines}}

TOPICS TO MAP:
{{topicLines}}

Reply with ONLY a numbered list using the exact schema node name from above or NONE:
{{topicIndices}}`
  },

  // ── Topic Canonicalization ─────────────────────────────────────────────────

  topicCanonicalization: {
    label: "Topic Canonicalization",
    category: INGESTION,
    description: "Checks if a new topic is semantically equivalent to an existing node",
    variables: ["topic", "candidateList"],
    default: `You are organizing a knowledge graph. A new document has a topic category.

New topic: "{{topic}}"

Candidate existing nodes in the graph (with summaries, keywords, and aliases when available):
{{candidateList}}

Is the new topic semantically equivalent to any candidate (same concept, possibly different phrasing)?
Consider the summaries, keywords, and aliases — not just the node name.
- If YES: respond with EXACTLY the matching candidate name from the list (copy it verbatim, just the name in quotes)
- If NO: respond with EXACTLY "{{topic}}"

Respond with ONLY the chosen name, nothing else.`
  },

  // ── Query Classification ───────────────────────────────────────────────────

  queryClassification_en: {
    label: "Query Classification (English)",
    category: QUERY,
    description: "Classifies queries into types: simple_lookup, comparison, recommendation, reasoning, aggregation",
    variables: ["query"],
    default: `You are a query classifier for an enterprise knowledge base system.

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
"{{query}}"

Return JSON only:
{
  "query_type": "simple_lookup|comparison|recommendation|reasoning|aggregation",
  "confidence": 0.0-1.0,
  "entities": ["list of entities/products mentioned"],
  "criteria": ["list of comparison/evaluation criteria if applicable"],
  "reasoning": "brief explanation of classification"
}`
  },

  queryClassification_zh: {
    label: "Query Classification (Chinese)",
    category: QUERY,
    description: "将查询分类为不同类型",
    variables: ["query"],
    default: `你是企业知识库系统的查询分类器。

查询分类示例:

1. "产品A的价格是多少？" → simple_lookup
   原因: 单一实体的直接事实检索

2. "产品A和产品B哪个性价比更高？" → comparison
   原因: 按特定标准比较两个实体

3. "我需要处理大量数据，推荐用哪个产品？" → recommendation
   原因: 根据需求寻求建议

4. "为什么产品A在高温环境下性能会下降？" → reasoning
   原因: 需要理解因果关系

5. "我们有哪些产品线？" → aggregation
   原因: 汇总多个实体的信息

现在分类此查询:
"{{query}}"

仅返回JSON:
{
  "query_type": "simple_lookup|comparison|recommendation|reasoning|aggregation",
  "confidence": 0.0-1.0,
  "entities": ["提到的实体/产品列表"],
  "criteria": ["如适用，比较/评估标准列表"],
  "reasoning": "分类的简要说明"
}`
  },

  // ── Reranking ──────────────────────────────────────────────────────────────

  reranking_en: {
    label: "Passage Reranking (English)",
    category: QUERY,
    description: "Scores passage relevance to query (0-10 scale) for reranking",
    variables: ["query", "passages"],
    default: `You are a relevance scorer. Given a query and text passages, score each passage's relevance to the query from 0-10.

Query: "{{query}}"

Passages:
{{passages}}

Return ONLY a JSON array of scores in order, like: [8, 3, 9, 5, ...]
Each score should reflect how well the passage answers or relates to the query:
- 9-10: Directly answers the query with specific information
- 7-8: Highly relevant, contains key information
- 5-6: Somewhat relevant, partial information
- 3-4: Tangentially related
- 0-2: Not relevant

JSON scores:`
  },

  reranking_zh: {
    label: "Passage Reranking (Chinese)",
    category: QUERY,
    description: "为段落与查询的相关性评分（0-10）",
    variables: ["query", "passages"],
    default: `你是一个相关性评分器。给定一个查询和文本段落,为每个段落对查询的相关性评分(0-10)。

查询: "{{query}}"

段落:
{{passages}}

仅返回JSON数组形式的分数,如: [8, 3, 9, 5, ...]
每个分数应反映段落回答或关联查询的程度:
- 9-10: 直接回答查询,包含具体信息
- 7-8: 高度相关,包含关键信息
- 5-6: 有些相关,部分信息
- 3-4: 间接相关
- 0-2: 不相关

JSON分数:`
  },

  // ── Node Reranking ─────────────────────────────────────────────────────────

  nodeReranking_en: {
    label: "Node Reranking (English)",
    category: QUERY,
    description: "Scores knowledge base nodes for relevance (0-10 scale)",
    variables: ["query", "nodeTexts"],
    default: `Score each knowledge base node's relevance to the query (0-10).

Query: "{{query}}"

Nodes:
{{nodeTexts}}

Return ONLY a JSON array of scores: [score1, score2, ...]
- 9-10: Exact match for query topic
- 7-8: Highly relevant category/topic
- 5-6: Related but not primary topic
- 0-4: Not relevant

JSON:`
  },

  nodeReranking_zh: {
    label: "Node Reranking (Chinese)",
    category: QUERY,
    description: "为知识库节点与查询的相关性评分",
    variables: ["query", "nodeTexts"],
    default: `为每个知识库节点对查询的相关性评分(0-10)。

查询: "{{query}}"

节点:
{{nodeTexts}}

仅返回JSON数组形式的分数: [分数1, 分数2, ...]
- 9-10: 与查询主题完全匹配
- 7-8: 高度相关的类别/主题
- 5-6: 相关但非主要主题
- 0-4: 不相关

JSON:`
  },

  // ── Answer Generation ──────────────────────────────────────────────────────

  answerGeneration_en: {
    label: "Answer Generation (English)",
    category: QUERY,
    description: "Generates answer with inline citations from source chunks",
    variables: ["query", "sourceList"],
    default: `Answer the question using the provided sources. Add [n] citations after each factual claim.

Question: {{query}}

Sources:
{{sourceList}}

Rules:
- Read ALL sources before answering — the relevant information may be in any source.
- Extract and quote specific numbers, dates, and names exactly as written.
- Add [1], [2] etc. after each claim to indicate the source.
- Answer directly and concisely.

Answer:`
  },

  answerGeneration_zh: {
    label: "Answer Generation (Chinese)",
    category: QUERY,
    description: "根据来源生成带引用标注的回答",
    variables: ["query", "sourceList"],
    default: `根据以下来源回答问题。在每个事实性陈述后添加[n]引用。

问题: {{query}}

来源:
{{sourceList}}

规则:
- 回答前请阅读所有来源——相关信息可能在任何一个来源中。
- 准确引用数字、日期和名称。
- 在每个陈述后添加[1]、[2]等引用编号。
- 简洁直接地回答。

回答:`
  },

  // ── Answer Retry ───────────────────────────────────────────────────────────

  answerRetry_en: {
    label: "Answer Retry (English)",
    category: QUERY,
    description: "Retry prompt when first answer falsely claims info is not found",
    variables: ["query", "sourceList"],
    default: `Re-read ALL sources carefully and answer the question. Do NOT say information is missing — extract any relevant facts, numbers, or descriptions present in the sources.

Question: {{query}}

Sources:
{{sourceList}}

Answer directly:`
  },

  answerRetry_zh: {
    label: "Answer Retry (Chinese)",
    category: QUERY,
    description: "当首次回答错误声称信息不存在时的重试提示",
    variables: ["query", "sourceList"],
    default: `请仔细重新阅读以下所有来源，然后回答问题。

问题: {{query}}

来源:
{{sourceList}}

重要：请不要说信息不存在，而是从来源中提取任何相关的事实、数字或描述。直接回答：`
  },

  // ── Add Citations ──────────────────────────────────────────────────────────

  addCitations: {
    label: "Add Citations (Post-hoc)",
    category: QUERY,
    description: "Adds citation markers to an existing answer based on sources",
    variables: ["answer", "sourceList"],
    default: `Add citation numbers to this answer based on which sources support each statement.

Answer to annotate:
{{answer}}

Sources:
{{sourceList}}

Add [n] citations after statements that are supported by source n. Only cite sources that actually support the statement.
Return the annotated answer only:`
  },

  // ── Query Decomposition ────────────────────────────────────────────────────

  queryDecomposition: {
    label: "Query Decomposition",
    category: QUERY,
    description: "Breaks complex queries into simpler sub-queries for better retrieval",
    variables: ["query", "maxSubQueries"],
    default: `Analyze this query and determine if it should be broken into simpler sub-queries for better information retrieval.

Query: "{{query}}"

If the query is complex (asks multiple things, requires comparing, or needs multi-step reasoning), decompose it.
If simple (single topic, direct question), keep it as-is.

Return JSON:
{
  "isComplex": true/false,
  "strategy": "direct" | "parallel" | "sequential" | "comparison",
  "subQueries": [
    {"query": "sub-query text", "type": "main|supporting|comparison", "priority": 1-3}
  ],
  "mergeStrategy": "combine" | "compare" | "aggregate"
}

Rules:
- Maximum {{maxSubQueries}} sub-queries
- Each sub-query should be self-contained
- "parallel" = retrieve all independently, merge results
- "sequential" = later queries may depend on earlier results
- "comparison" = retrieve info for each entity separately

JSON only:`
  },

  // ── LLM Reranking ─────────────────────────────────────────────────────────

  llmReranking: {
    label: "LLM Chunk Reranking",
    category: QUERY,
    description: "LLM scores snippet relevance to query (0-10) for reranking chunks",
    variables: ["query", "snippets"],
    default: `Rate each snippet's relevance to the question on a scale of 0–10. Reply with ONLY a numbered list like:
1. 7
2. 3
...

Question: {{query}}

Snippets:
{{snippets}}

Ratings (0-10):`
  },

  // ── Reasoning ──────────────────────────────────────────────────────────────

  reasoning: {
    label: "Multi-hop Reasoning",
    category: QUERY,
    description: "Reasons through context to answer complex questions step-by-step",
    variables: ["query", "context"],
    default: `You are a knowledge base reasoning assistant. Answer the user's question by reasoning through the provided context.

User Question: "{{query}}"

Context:
{{context}}

Instructions:
1. Analyze the question and identify what information is needed
2. Trace through the context to find relevant facts
3. Connect facts to form a logical chain of reasoning
4. Provide a clear, well-reasoned answer
5. Cite specific sources when possible

Return JSON:
{
  "reasoning_steps": [
    {"step": 1, "thought": "First, I look at...", "finding": "..."},
    {"step": 2, "thought": "Then, I connect...", "finding": "..."}
  ],
  "answer": "The final answer based on reasoning",
  "confidence": 0.0-1.0,
  "key_facts": ["list of key facts used"],
  "assumptions": ["any assumptions made"],
  "limitations": ["what the context doesn't cover"]
}`
  },

  // ── Reasoning Synthesis ────────────────────────────────────────────────────

  reasoningSynthesis: {
    label: "Reasoning Synthesis",
    category: QUERY,
    description: "Synthesizes answers from multiple sub-query results",
    variables: ["query", "subResults"],
    default: `You are a reasoning assistant. Synthesize an answer to the main question using the results from sub-queries.

Main Question: "{{query}}"

Sub-query Results:
{{subResults}}

Synthesize a comprehensive answer that combines insights from all sub-queries.

Return JSON:
{
  "synthesis_steps": [
    {"sub_query": "...", "key_insight": "..."}
  ],
  "final_answer": "Comprehensive answer",
  "confidence": 0.0-1.0
}`
  },

  // ── Reasoning Decomposition ────────────────────────────────────────────────

  reasoningDecomposition: {
    label: "Reasoning Decomposition",
    category: QUERY,
    description: "Decomposes complex questions into simpler sub-questions for chain-of-thought",
    variables: ["query"],
    default: `Decompose this complex question into 2-4 simpler sub-questions that can be answered independently.

Question: "{{query}}"

Return JSON array of sub-questions:
["sub-question 1", "sub-question 2", ...]`
  },

  // ── Comparison ─────────────────────────────────────────────────────────────

  comparison: {
    label: "Comparison Analysis",
    category: QUERY,
    description: "Generates structured comparison between entities",
    variables: ["query", "aspects", "context"],
    default: `You are a comparison analyst. Generate a detailed comparison based on the provided information.

User Query: "{{query}}"

{{aspects}}

Context:
{{context}}

Generate a structured comparison. Return JSON:
{
  "aspects": ["list of comparison aspects used"],
  "table": {
    "headers": ["Aspect", "Entity1", "Entity2", ...],
    "rows": [
      ["aspect_name", "entity1_value", "entity2_value", ...]
    ]
  },
  "summary": "Overall comparison summary",
  "recommendation": "Which option might be better and why (if applicable)",
  "key_differences": ["list of key differences"],
  "key_similarities": ["list of key similarities"]
}`
  },

  // ── Recommendation ─────────────────────────────────────────────────────────

  recommendation: {
    label: "Recommendation",
    category: QUERY,
    description: "Generates recommendations based on criteria and context",
    variables: ["query", "criteria", "userContext", "context"],
    default: `You are a recommendation assistant. Based on the user's query and available options, provide recommendations.

User Query: "{{query}}"

{{criteria}}

{{userContext}}

Available Options:
{{context}}

Generate recommendations. Return JSON:
{
  "recommendations": [
    {
      "name": "option name",
      "rank": 1,
      "match_score": 0.0-1.0,
      "why_recommended": "explanation",
      "pros": ["advantages"],
      "cons": ["disadvantages"]
    }
  ],
  "top_recommendation": "name of best option",
  "reasoning": "overall reasoning for recommendations",
  "alternatives": ["other options to consider"],
  "considerations": ["things to keep in mind"]
}`
  },

  // ── Related Questions ──────────────────────────────────────────────────────

  relatedQuestions: {
    label: "Related Questions",
    category: QUERY,
    description: "Generates follow-up questions based on Q&A context",
    variables: ["query", "answer", "contentPreview"],
    default: `Based on this Q&A, suggest 3 natural follow-up questions a user might ask.

Original Question: "{{query}}"
{{answer}}
Related Content: "{{contentPreview}}"

Generate questions that:
1. Dig deeper into the topic
2. Explore related aspects
3. Clarify or expand on the answer

Return JSON array with both English and Chinese versions:
[
  {"en": "English question?", "zh": "中文问题？", "type": "deeper|related|clarify"}
]

JSON only:`
  },

  // ── LLM Tree Routing ──────────────────────────────────────────────────────

  llmTreeRouting: {
    label: "LLM Tree Routing",
    category: ROUTING,
    description: "Rates node relevance (0-10) for semantic tree navigation",
    variables: ["query", "nodeList"],
    default: `Rate each node's relevance (0-10) to the query. Consider semantic meaning, not just keywords.

Query: "{{query}}"

Nodes:
{{nodeList}}

Return JSON array: [{"node_id":"...","relevance":0-10}]
Only include nodes with relevance > 0. No explanation needed.`
  },

  // ── Schema Interview ──────────────────────────────────────────────────────

  schemaInterview_question: {
    label: "Schema Interview — Next Question",
    category: ROUTING,
    description: "Generates the next adaptive interview question for AI schema generation",
    variables: ["interviewContext", "answers", "existingTree", "existingStats", "questionCount", "minQuestions", "maxQuestions"],
    default: `You are interviewing a user to design a knowledge base schema (tree structure for organizing information).

Interview so far:
{{answers}}

Current understanding:
{{interviewContext}}

Existing tree structure:
{{existingTree}}

Existing data stats: {{existingStats}}

Question number: {{questionCount}} (min {{minQuestions}}, max {{maxQuestions}}).

Generate the next most useful question to understand their knowledge domain better. Focus on areas not yet covered:
- If domain is unclear: ask about the subject area
- If categories are unclear: ask about main topics/categories
- If depth is unclear: ask about how detailed the organization should be
- If query patterns are unclear: ask what users will search for
- If language is unclear: ask about content language
- If entity types are unclear: ask about key concepts/entities

Also extract structured information from the user's previous answers.

Return JSON only:
{
  "nextQuestion": "Your question here?",
  "contextUpdate": {
    "domain": "extracted domain (or empty to keep current)",
    "subdomains": ["extracted subdomains"],
    "queryPatterns": ["how users will search"],
    "depthPreference": "shallow|medium|deep",
    "language": "en|zh|auto",
    "entityTypes": ["types of entities mentioned"],
    "additionalNotes": "any other relevant info"
  },
  "shouldStop": false,
  "confidence": 0.0-1.0
}

Set shouldStop=true only when confidence >= 0.85 AND you have enough context to generate a good schema.
Only include non-empty fields in contextUpdate. JSON only:`
  },

  schemaInterview_generate: {
    label: "Schema Interview — Generate Schema",
    category: ROUTING,
    description: "Generates a complete schema tree from accumulated interview context",
    variables: ["interviewContext", "answers", "existingTree", "existingStats"],
    default: `You are a knowledge base architect. Based on the interview below, design an optimal tree structure for organizing information.

Interview answers:
{{answers}}

Accumulated context:
{{interviewContext}}

Existing tree structure:
{{existingTree}}

Existing data stats: {{existingStats}}

Design a schema tree. Rules:
1. Top-level nodes = main knowledge categories
2. Each node needs: name, description (1-sentence purpose), aliases (2-3 search terms), keywords (3-5 indexing terms)
3. Max 4 levels of depth
4. Node names MUST match the content language (if Chinese domain → Chinese node names)
5. Make categories mutually exclusive but collectively exhaustive for the domain
6. Leaf nodes should be specific enough that documents can be clearly assigned

Return ONLY a JSON array of top-level nodes with nested children:
[
  {
    "name": "Category Name",
    "description": "What this category covers",
    "aliases": ["alt name 1", "alt name 2"],
    "keywords": ["keyword1", "keyword2", "keyword3"],
    "children": [...]
  }
]

JSON array:`
  },

  // ── Aggregation Enumeration ──────────────────────────────────────────────

  aggregation_enumeration_en: {
    label: "Aggregation Enumeration (English)",
    category: QUERY,
    description: "Answers enumeration queries using structured tree data (count + items list)",
    variables: ["query", "count", "parent_name", "items_list", "supporting_chunks"],
    default: `Answer the user's question using the structured data below.

Question: {{query}}

The knowledge base has exactly {{count}} items under "{{parent_name}}":

{{items_list}}

Supporting details:
{{supporting_chunks}}

Rules:
- State the exact count ({{count}}) as a hard fact — do not guess or approximate.
- List each item by name with a brief description from the data above.
- If the user asked "how many", lead with the count.
- If the user asked "list all", list every item.
- Be concise and cite the item names exactly as shown.

Answer:`
  },

  aggregation_enumeration_zh: {
    label: "Aggregation Enumeration (Chinese)",
    category: QUERY,
    description: "使用结构化树数据回答枚举查询（数量+列表）",
    variables: ["query", "count", "parent_name", "items_list", "supporting_chunks"],
    default: `根据以下结构化数据回答用户的问题。

问题：{{query}}

知识库中"{{parent_name}}"下共有 {{count}} 个项目：

{{items_list}}

补充细节：
{{supporting_chunks}}

规则：
- 明确说明准确数量（{{count}}），不要猜测或近似。
- 按名称列出每个项目，附简短描述。
- 如果用户问"有多少"，先说数量。
- 如果用户问"列出所有"，列出每个项目。
- 简洁回答，准确引用项目名称。

回答：`
  },

  // ── Manage (Chatbot) ────────────────────────────────────────────────────────

  manageIntent: {
    label: "Manage Intent Classification",
    category: MANAGE,
    description: "Classifies user message as ADD/EDIT/DELETE/QUERY and extracts structured data for knowledge management",
    variables: ["message", "recentMessages", "focusNode", "treeStructure", "pendingAction"],
    default: `You are a knowledge management assistant. Classify the user's intent and extract structured data.

The user is managing a knowledge base. They can:
- ADD new information (stating facts, providing data)
- EDIT existing information (changing values, updating facts)
- DELETE information (removing facts, deleting entries)
- QUERY (asking questions about the knowledge base)

Session context:
{{recentMessages}}
Current focus node: {{focusNode}}
Pending action: {{pendingAction}}

Tree structure (top levels):
{{treeStructure}}

User message: "{{message}}"

Return JSON only:
{
  "intent": "ADD|EDIT|DELETE|QUERY",
  "confidence": 0.0-1.0,
  "content": "the knowledge statement (for ADD: the full fact to store; for EDIT: the updated statement)",
  "topic_hint": "suggested topic category for tree placement (2-5 words)",
  "subtopic_hint": "optional subtopic (2-5 words or empty string)",
  "target_description": "what existing content to find (for EDIT/DELETE searches)",
  "old_value": "the specific value to change FROM (for EDIT, or empty)",
  "new_value": "the specific value to change TO (for EDIT, or empty)",
  "reasoning": "brief 1-sentence explanation"
}`
  }
};

/** Get all prompt keys */
export function getAllPromptKeys() {
  return Object.keys(PROMPT_CATALOG);
}

/** Get prompt metadata (without default text) */
export function getPromptMeta(key) {
  const entry = PROMPT_CATALOG[key];
  if (!entry) return null;
  return { key, label: entry.label, category: entry.category, description: entry.description, variables: entry.variables };
}

/** Get default text for a prompt */
export function getPromptDefault(key) {
  return PROMPT_CATALOG[key]?.default ?? null;
}
