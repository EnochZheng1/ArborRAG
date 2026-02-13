/**
 * Language Detection and Bilingual Prompt Utilities
 *
 * Provides centralized language detection and prompt templates
 * for both Chinese (zh) and English (en) content.
 */

/**
 * Detect primary language of text
 * @param {string} text - Text to analyze
 * @returns {"zh" | "en"} Detected language code
 */
export function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'en';

  // Count Chinese characters
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;

  if (totalChars === 0) return 'en';

  // If more than 30% Chinese characters, treat as Chinese
  return chineseChars / totalChars > 0.3 ? 'zh' : 'en';
}

/**
 * Get bilingual prompt based on detected language
 * Prompts are in the same language as the content for better LLM understanding
 */
export const PROMPTS = {
  // Metadata extraction prompt
  metadataExtraction: {
    zh: (docTitle, content) => `分析以下文档并提取元数据。仅返回有效JSON。

文档标题: ${docTitle || "(未知)"}
内容:
${content}

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
}`,
    en: (docTitle, content) => `Analyze this document and extract metadata. Return ONLY valid JSON.

Document title: ${docTitle || "(Unknown)"}
Content:
${content}

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

  // Node mapping suggestion prompt
  nodeSuggestion: {
    zh: (chunkPreview, keywords, nodeList, noExisting) => `你是一个知识组织助手。给定一段文本和树节点列表，确定最佳的节点来放置这段内容。

文本片段(前500字符):
${chunkPreview}

关键词: ${keywords}

可用节点:
${nodeList}

${noExisting ? "没有匹配良好的现有节点。请建议一个新节点。" : ""}

仅返回JSON:
{
  "selected_index": <最佳节点的1-based索引, 如果都不合适则为0>,
  "confidence": <0-1的置信度分数>,
  "reasoning": "<分类原因的简要说明>",
  "suggested_new_node": {
    "node_id": "<建议的节点ID>",
    "name": "<节点名称>",
    "parent_id": "<建议的父节点ID或null>"
  } // 仅当selected_index为0时需要
}`,
    en: (chunkPreview, keywords, nodeList, noExisting) => `You are a knowledge organization assistant. Given a text chunk and a list of tree nodes, determine the best node to place this chunk under.

Text chunk (first 500 chars):
${chunkPreview}

Keywords: ${keywords}

Available nodes:
${nodeList}

${noExisting ? "No existing nodes match well. Suggest a new node." : ""}

Return JSON only:
{
  "selected_index": <1-based index of best node, or 0 if none fit>,
  "confidence": <0-1 confidence score>,
  "reasoning": "<brief explanation>",
  "suggested_new_node": {
    "node_id": "<suggested.node.id>",
    "name": "<Node Name>",
    "parent_id": "<suggested parent node_id or null>"
  } // only if selected_index is 0
}`
  },

  // Document structure analysis prompt
  documentStructure: {
    zh: (docTitle, chunkSummaries) => `分析此文档并建议用于组织其内容的层级结构。

文档标题: ${docTitle}

内容示例:
${chunkSummaries}

根据内容,建议一个树形结构,包含:
1. 一个主文档节点
2. 2-5个将相关内容分组的主题/章节节点
3. 每个节点的简短描述

仅返回JSON:
{
  "document_node": {
    "name": "主要主题名称",
    "summary": "文档的1-2句摘要"
  },
  "sections": [
    {
      "name": "章节名称",
      "summary": "本章节涵盖的内容",
      "keywords": ["相关", "关键词"],
      "chunk_indices": [0, 1, 2]
    }
  ]
}`,
    en: (docTitle, chunkSummaries) => `Analyze this document and suggest a hierarchical structure for organizing its content.

Document Title: ${docTitle}

Content samples:
${chunkSummaries}

Based on the content, suggest a tree structure with:
1. A main document node
2. 2-5 topic/section nodes that group related content
3. Brief descriptions for each node

Return JSON only:
{
  "document_node": {
    "name": "Main topic name",
    "summary": "Brief 1-2 sentence summary of document"
  },
  "sections": [
    {
      "name": "Section name",
      "summary": "What this section covers",
      "keywords": ["relevant", "keywords"],
      "chunk_indices": [0, 1, 2]
    }
  ]
}`
  },

  // Conflict detection prompt
  conflictDetection: {
    zh: (chunkA, chunkB) => `比较这两个知识片段,判断它们是否包含冲突的信息。

片段A (ID: ${chunkA.id}, 来源: ${chunkA.doc_title || "未知"}):
${chunkA.content.slice(0, 1000)}

片段B (ID: ${chunkB.id}, 来源: ${chunkB.doc_title || "未知"}):
${chunkB.content.slice(0, 1000)}

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
}`,
    en: (chunkA, chunkB) => `Compare these two knowledge chunks and determine if they contain conflicting information.

Chunk A (ID: ${chunkA.id}, Source: ${chunkA.doc_title || "unknown"}):
${chunkA.content.slice(0, 1000)}

Chunk B (ID: ${chunkB.id}, Source: ${chunkB.doc_title || "unknown"}):
${chunkB.content.slice(0, 1000)}

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

  // Query classification prompt
  queryClassification: {
    zh: (query) => `你是企业知识库系统的查询分类器。

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
"${query}"

仅返回JSON:
{
  "query_type": "simple_lookup|comparison|recommendation|reasoning|aggregation",
  "confidence": 0.0-1.0,
  "entities": ["提到的实体/产品列表"],
  "criteria": ["如适用，比较/评估标准列表"],
  "reasoning": "分类的简要说明"
}`,
    en: (query) => `You are a query classifier for an enterprise knowledge base system.

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
"${query}"

Return JSON only:
{
  "query_type": "simple_lookup|comparison|recommendation|reasoning|aggregation",
  "confidence": 0.0-1.0,
  "entities": ["list of entities/products mentioned"],
  "criteria": ["list of comparison/evaluation criteria if applicable"],
  "reasoning": "brief explanation of classification"
}`
  },

  // Re-ranking prompt
  reranking: {
    zh: (query, passages) => `你是一个相关性评分器。给定一个查询和文本段落,为每个段落对查询的相关性评分(0-10)。

查询: "${query}"

段落:
${passages}

仅返回JSON数组形式的分数,如: [8, 3, 9, 5, ...]
每个分数应反映段落回答或关联查询的程度:
- 9-10: 直接回答查询,包含具体信息
- 7-8: 高度相关,包含关键信息
- 5-6: 有些相关,部分信息
- 3-4: 间接相关
- 0-2: 不相关

JSON分数:`,
    en: (query, passages) => `You are a relevance scorer. Given a query and text passages, score each passage's relevance to the query from 0-10.

Query: "${query}"

Passages:
${passages}

Return ONLY a JSON array of scores in order, like: [8, 3, 9, 5, ...]
Each score should reflect how well the passage answers or relates to the query:
- 9-10: Directly answers the query with specific information
- 7-8: Highly relevant, contains key information
- 5-6: Somewhat relevant, partial information
- 3-4: Tangentially related
- 0-2: Not relevant

JSON scores:`
  },

  // Entity and fact extraction prompt
  entityFactExtraction: {
    zh: (content, existingHint) => `分析以下文本并提取所有实体和事实。请全面提取。

待分析文本:
"""
${content}
"""
${existingHint}

说明:
1. 提取每一个命名实体: 产品、服务、功能、概念、人物、组织、地点、流程、技术术语
2. 提取每一个事实陈述: 定义、属性、关系、流程、规格、比较
3. 对于中文文本,按原样提取中文实体名称
4. 每个事实必须是完整的、独立的陈述

输出格式(仅有效JSON,无markdown):
{"entities":[{"name":"实体名称","type":"product|concept|person|organization|location|process|feature|service","description":"一行描述","aliases":[]}],"facts":[{"content":"完整的事实陈述","type":"attribute|relationship|definition|procedure|specification","confidence":0.9,"entities":["实体名称"]}]}

重要: 仅返回有效JSON。不要解释,不要markdown代码块。`,
    en: (content, existingHint) => `Analyze this text and extract ALL entities and facts. Be comprehensive.

TEXT TO ANALYZE:
"""
${content}
"""
${existingHint}

INSTRUCTIONS:
1. Extract EVERY named entity: products, services, features, concepts, people, organizations, locations, processes, technical terms
2. Extract EVERY factual statement: definitions, properties, relationships, procedures, specifications, comparisons
3. For Chinese text, extract Chinese entity names as-is
4. Each fact must be a complete, self-contained statement

OUTPUT FORMAT (valid JSON only, no markdown):
{"entities":[{"name":"EntityName","type":"product|concept|person|organization|location|process|feature|service","description":"one-line description","aliases":[]}],"facts":[{"content":"Complete factual statement","type":"attribute|relationship|definition|procedure|specification","confidence":0.9,"entities":["EntityName"]}]}

IMPORTANT: Return ONLY valid JSON. No explanation, no markdown code blocks.`
  },

  // Node re-ranking prompt
  nodeReranking: {
    zh: (query, nodeTexts) => `为每个知识库节点对查询的相关性评分(0-10)。

查询: "${query}"

节点:
${nodeTexts}

仅返回JSON数组形式的分数: [分数1, 分数2, ...]
- 9-10: 与查询主题完全匹配
- 7-8: 高度相关的类别/主题
- 5-6: 相关但非主要主题
- 0-4: 不相关

JSON:`,
    en: (query, nodeTexts) => `Score each knowledge base node's relevance to the query (0-10).

Query: "${query}"

Nodes:
${nodeTexts}

Return ONLY a JSON array of scores: [score1, score2, ...]
- 9-10: Exact match for query topic
- 7-8: Highly relevant category/topic
- 5-6: Related but not primary topic
- 0-4: Not relevant

JSON:`
  },

  // Alias generation prompt
  aliasGeneration: {
    zh: (context, maxAliases) => `给定以下来自知识库的节点信息,生成${maxAliases}个用户可能用于搜索此内容的替代名称/别名。包括:
- 同义词和相关术语
- 缩写版本
- 翻译(如果原文是中文,包含英文;如果是英文,包含中文)
- 常见拼写错误或变体
- 人们可能搜索的相关短语

${context}

仅返回JSON字符串数组,不要解释:
["别名1", "别名2", "别名3", ...]`,
    en: (context, maxAliases) => `Given the following node information from a knowledge base, generate ${maxAliases} alternative names/aliases that users might use to search for this content. Include:
- Synonyms and related terms
- Abbreviated versions
- Translations (if the original is Chinese, include English; if English, include Chinese)
- Common misspellings or variations
- Related phrases people might search for

${context}

Return ONLY a JSON array of strings, no explanation:
["alias1", "alias2", "alias3", ...]`
  }
};

/**
 * Get a prompt in the appropriate language
 * @param {string} promptKey - Key from PROMPTS object
 * @param {string} lang - Language code ('zh' or 'en')
 * @param  {...any} args - Arguments to pass to prompt function
 * @returns {string} Generated prompt
 */
export function getPrompt(promptKey, lang, ...args) {
  const promptSet = PROMPTS[promptKey];
  if (!promptSet) {
    throw new Error(`Unknown prompt key: ${promptKey}`);
  }

  const langKey = lang === 'zh' ? 'zh' : 'en';
  const promptFn = promptSet[langKey];

  if (typeof promptFn === 'function') {
    return promptFn(...args);
  }

  return promptFn;
}

/**
 * Auto-detect language and get appropriate prompt
 * @param {string} promptKey - Key from PROMPTS object
 * @param {string} content - Content to detect language from
 * @param  {...any} args - Arguments to pass to prompt function
 * @returns {{ prompt: string, lang: string }} Prompt and detected language
 */
export function getAutoPrompt(promptKey, content, ...args) {
  const lang = detectLanguage(content);
  const prompt = getPrompt(promptKey, lang, ...args);
  return { prompt, lang };
}

export default {
  detectLanguage,
  getPrompt,
  getAutoPrompt,
  PROMPTS
};
