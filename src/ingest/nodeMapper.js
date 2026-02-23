import { safeJson, logAudit, runTransaction } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { bm25RecallNodes, searchNodesByName } from "../kg/recallNodes.js";
import { GoogleGenAI } from "@google/genai";
import { ingestLogger as logger } from "../utils/logger.js";
import { detectLanguage, getPrompt, isChineseLang } from "../utils/langDetect.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { wordDiceSimilarity } from "./knowledgeExtractor.js";

/**
 * Map chunks to appropriate tree nodes
 */

/**
 * Find best matching node for a chunk using BM25 + keywords
 * @param {object} chunk - Chunk with content and keywords
 * @returns {object|null} Best matching node or null
 */
export function findBestNodeMatch(chunk) {
  const { content, keywords = [] } = chunk;

  // Build search query from content and keywords
  const searchTerms = [
    ...keywords.slice(0, 5),
    ...(content.slice(0, 200).split(/\s+/).slice(0, 10))
  ].join(" ");

  // Use BM25 to find candidates
  const candidates = bm25RecallNodes(searchTerms, 10);

  if (candidates.length === 0) {
    return null;
  }

  // Score candidates based on keyword overlap
  const scored = candidates.map(c => {
    let score = c.bm25;

    // Bonus for keyword matches in node name/summary
    const nodeText = `${c.node.name} ${c.node.node_summary}`.toLowerCase();
    for (const kw of keywords) {
      if (nodeText.includes(kw.toLowerCase())) {
        score += 0.5;
      }
    }

    return { ...c, finalScore: score };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Only return if confidence is reasonable
  if (scored[0].finalScore > 0) {
    return {
      node: scored[0].node,
      score: scored[0].finalScore,
      alternatives: scored.slice(1, 4).map(s => ({
        node: s.node,
        score: s.finalScore
      }))
    };
  }

  return null;
}

/**
 * Use LLM to suggest node mapping for ambiguous cases
 * @param {object} chunk - Chunk to map
 * @param {Array} candidates - Candidate nodes
 * @returns {Promise<object>} LLM suggestion
 */
export async function suggestNodeWithLLM(chunk, candidates) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY required for LLM node suggestion");
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Detect language from chunk content
  const lang = detectLanguage(chunk.content || '');

  const nodeList = candidates.map((c, i) =>
    `${i + 1}. ${c.node.node_id} - ${c.node.name}: ${c.node.node_summary || (isChineseLang(lang) ? "(无摘要)" : "(no summary)")}`
  ).join("\n");

  const chunkPreview = chunk.content.slice(0, 500);
  const keywords = (chunk.keywords || []).join(", ");
  const noExisting = candidates.length === 0;

  // Use bilingual prompt based on content language
  const prompt = getPrompt('nodeSuggestion', lang, chunkPreview, keywords, nodeList, noExisting);

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    return JSON.parse(jsonMatch[1] || text);
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.error("LLM node suggestion failed:", err.message);
    return {
      selected_index: candidates.length > 0 ? 1 : 0,
      confidence: 0.3,
      reasoning: isChineseLang(lang) ? "LLM调用失败,使用后备方案" : "LLM call failed, using fallback"
    };
  }
}

/**
 * Create a new node in the tree
 * @param {object} nodeData - Node data
 * @returns {object} Created node
 */
export function createNode(nodeData) {
  const { node_id, name, parent_id = null, level = 1, summary = "", scope = {} } = nodeData;

  // Validate parent exists if specified
  if (parent_id && !NodeRepo.existsById(parent_id)) {
    throw new Error(`Parent node not found: ${parent_id}`);
  }

  // Calculate level from parent
  let calculatedLevel = level;
  if (parent_id) {
    const parentLevel = NodeRepo.getLevel(parent_id);
    calculatedLevel = (Number(parentLevel) || 0) + 1;
  }

  return runTransaction(() => {
    NodeRepo.insert({
      node_id,
      name,
      parent_id,
      level: calculatedLevel,
      node_summary: summary,
      scope_json: JSON.stringify(scope)
    });

    NodeRepo.insertFtsText(node_id, `${name} ${summary}`);

    logAudit("create", "nodes", node_id, null, { node_id, name, parent_id, level: calculatedLevel });

    return {
      node_id,
      name,
      parent_id,
      level: calculatedLevel,
      node_summary: summary,
      scope_json: scope
    };
  });
}

/**
 * Map a chunk to a node (create chunk record)
 * @param {object} chunk - Chunk data
 * @param {string} nodeId - Target node ID
 * @param {number} documentId - Source document ID
 * @returns {number} Created chunk ID
 */
export function assignChunkToNode(chunk, nodeId, documentId) {
  const {
    content,
    index = 0,
    doc_title = "",
    chunk_type = "other",
    keywords = [],
    fields = {},
    scope = {},
    authority_level = "sop"
  } = chunk;

  return runTransaction(() => {
    const result = ChunkRepo.insert({
      doc_title,
      content,
      chunk_type,
      keywords,
      fields,
      scope,
      authority_level,
      nodeId,
      documentId,
      index
    });

    const chunkId = result.lastInsertRowid;

    ChunkRepo.insertFts(chunkId, content);
    NodeRepo.touch(nodeId);

    logAudit("create", "chunks", chunkId, null, { node_id: nodeId, doc_title, chunk_index: index });

    return Number(chunkId);
  });
}

/**
 * Get all root nodes (no parent)
 */
export function getRootNodes() {
  return NodeRepo.findRoots().map(r => ({
    node_id: r.node_id,
    name: r.name,
    level: r.level,
    node_summary: r.node_summary,
    scope_json: safeJson(r.scope_json, {})
  }));
}

/**
 * Get children of a node
 */
export function getChildNodes(parentId) {
  return NodeRepo.findByParent(parentId).map(r => ({
    node_id: r.node_id,
    name: r.name,
    parent_id: r.parent_id,
    level: r.level,
    node_summary: r.node_summary,
    scope_json: safeJson(r.scope_json, {})
  }));
}

/**
 * Get full tree structure
 */
export function getTreeStructure() {
  const allNodes = NodeRepo.getAllSortedByLevel();

  const nodeMap = new Map();
  const roots = [];

  // First pass: create node objects
  for (const r of allNodes) {
    nodeMap.set(r.node_id, {
      node_id: r.node_id,
      name: r.name,
      parent_id: r.parent_id,
      level: r.level,
      node_summary: r.node_summary,
      scope_json: safeJson(r.scope_json, {}),
      children: []
    });
  }

  // Second pass: build tree
  for (const node of nodeMap.values()) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Generate a unique node ID from text
 * @param {string} text - Text to generate ID from
 * @returns {string} Node ID
 */
function generateNodeId(text) {
  // Clean and normalize text
  const clean = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "_")  // Keep alphanumeric and Chinese chars
    .replace(/^_+|_+$/g, "")               // Trim underscores
    .slice(0, 50);                          // Limit length

  // Add timestamp suffix to ensure uniqueness
  const suffix = Date.now().toString(36).slice(-4);
  return `${clean}_${suffix}`;
}

/**
 * Use LLM to analyze document structure and suggest hierarchy
 * @param {string} docTitle - Document title
 * @param {Array} chunks - All chunks from document
 * @param {string} lang - Language code detected by caller
 * @returns {Promise<object>} Suggested hierarchy
 */
async function analyzeDocumentStructure(docTitle, chunks, lang) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Build a summary of chunk contents for analysis
  const chunkLabel = isChineseLang(lang) ? '片段' : 'Chunk';
  const keywordsLabel = isChineseLang(lang) ? '关键词' : 'Keywords';
  const chunkSummaries = chunks.slice(0, 10).map((c, i) => {
    const preview = c.content.slice(0, 200).replace(/\n/g, " ");
    const keywords = c.keywords?.slice(0, 5).join(", ") || "";
    return `${chunkLabel} ${i + 1}: ${preview}... [${keywordsLabel}: ${keywords}]`;
  }).join("\n\n");

  // Use bilingual prompt based on document language
  const prompt = getPrompt('documentStructure', lang, docTitle, chunkSummaries);

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";

    // Robust JSON extraction: try markdown code block first, then bare JSON object
    let jsonStr = text.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    } else {
      // Find the outermost JSON object, ignoring surrounding text
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }
    return JSON.parse(jsonStr);
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.warn("Document structure analysis failed:", err.message);
    return null;
  }
}

/**
 * Create document hierarchy - document node with section children
 * @param {string} docTitle - Document title
 * @param {Array} chunks - Document chunks
 * @param {object} structure - LLM suggested structure (optional)
 * @param {string} lang - Language code ('zh-TW', 'zh-CN', or 'en')
 * @returns {object} Created hierarchy with document node and section nodes
 */
function createDocumentHierarchy(docTitle, chunks, structure = null, lang = 'en') {
  ensureRootNode();

  const cleanTitle = docTitle.replace(/\.(docx?|pdf|txt|md|xlsx?)$/i, "").trim();
  const docNodeId = generateNodeId(cleanTitle);

  // Create document-level node
  let docSummary = "";
  if (structure?.document_node?.summary) {
    docSummary = structure.document_node.summary;
  } else {
    // Generate summary from first chunk
    const firstContent = chunks[0]?.content || "";
    docSummary = firstContent.slice(0, 200).replace(/\n/g, " ").trim();
    if (firstContent.length > 200) docSummary += "...";
  }

  const docNode = createNode({
    node_id: docNodeId,
    name: structure?.document_node?.name || cleanTitle,
    parent_id: "root",
    summary: docSummary,
    scope: {}
  });

  logger.info(`Created document node: ${docNode.node_id} (${docNode.name})`);

  const sectionNodes = [];
  const chunkToSection = new Map(); // Map chunk index to section node

  if (structure?.sections?.length > 0) {
    // Create section nodes based on LLM analysis
    for (const section of structure.sections) {
      const sectionNodeId = generateNodeId(section.name);
      const sectionNode = createNode({
        node_id: sectionNodeId,
        name: section.name,
        parent_id: docNode.node_id,
        summary: section.summary || "",
        scope: {}
      });
      sectionNodes.push(sectionNode);

      // Map chunks to this section
      if (section.chunk_indices?.length > 0) {
        for (const idx of section.chunk_indices) {
          chunkToSection.set(idx, sectionNode);
        }
      }

      logger.info(`Created section node: ${sectionNode.node_id} (${sectionNode.name})`);
    }
  }

  // If no sections or not all chunks mapped, create a language-appropriate fallback section
  const unmappedChunks = chunks.filter((_, i) => !chunkToSection.has(i));
  if (unmappedChunks.length > 0 && sectionNodes.length === 0) {
    // Create default sections based on chunk count
    if (chunks.length <= 3) {
      // Few chunks - put directly under document node
      for (let i = 0; i < chunks.length; i++) {
        chunkToSection.set(i, docNode);
      }
    } else {
      // Multiple chunks - create a localized content section
      const contentName = lang === 'zh-TW' ? '內容' : isChineseLang(lang) ? '内容' : 'Content';
      const contentSummary = lang === 'zh-TW'
        ? `來自「${cleanTitle}」的主要內容`
        : isChineseLang(lang)
          ? `来自「${cleanTitle}」的主要内容`
          : `Main content from ${cleanTitle}`;
      const contentNode = createNode({
        node_id: generateNodeId("content"),
        name: contentName,
        parent_id: docNode.node_id,
        summary: contentSummary,
        scope: {}
      });
      sectionNodes.push(contentNode);

      for (let i = 0; i < chunks.length; i++) {
        if (!chunkToSection.has(i)) {
          chunkToSection.set(i, contentNode);
        }
      }
    }
  }

  return {
    documentNode: docNode,
    sectionNodes,
    chunkToSection
  };
}

/**
 * Generate node data from chunk metadata (fallback for single chunk)
 * @param {object} chunk - Chunk with metadata
 * @param {string} parentId - Parent node ID
 * @returns {object} Node data for creation
 */
function generateNodeFromChunk(chunk, parentId = "root") {
  const { doc_title, keywords = [], content } = chunk;

  // Determine node name from doc_title or keywords
  let nodeName = doc_title;

  if (!nodeName || nodeName.trim().length === 0) {
    // Use first keyword or first words of content
    if (keywords.length > 0) {
      nodeName = keywords.slice(0, 3).join(" ");
    } else if (content) {
      // Extract first meaningful phrase
      const firstLine = content.split(/[\n.。]/)[0].trim();
      nodeName = firstLine.slice(0, 50) || "Unnamed Document";
    } else {
      nodeName = "Unnamed Document";
    }
  }

  // Remove file extension from name if present
  nodeName = nodeName.replace(/\.(docx?|pdf|txt|md|xlsx?)$/i, "").trim();

  const nodeId = generateNodeId(nodeName);

  // Generate meaningful summary from content
  let summary = "";
  if (content) {
    summary = content.slice(0, 300).replace(/\n/g, " ").trim();
    if (content.length > 300) summary += "...";
  } else if (keywords.length > 0) {
    summary = `Topics: ${keywords.join(", ")}`;
  }

  logger.info(`Generating new node: ${nodeId} (${nodeName})`);

  return {
    node_id: nodeId,
    name: nodeName,
    parent_id: parentId,
    summary,
    scope: chunk.scope || {}
  };
}

/**
 * Update node summaries based on the chunks assigned to them
 * @param {Array} nodes - Nodes to update
 * @param {Array} chunks - All chunks
 * @param {Array} mappings - Chunk to node mappings
 * @param {string} lang - Language code ('zh-TW', 'zh-CN', or 'en')
 */
function updateNodeSummaries(nodes, chunks, mappings, lang = 'en') {
  // Group chunks by node
  const chunksByNode = new Map();
  for (const mapping of mappings) {
    if (!chunksByNode.has(mapping.nodeId)) {
      chunksByNode.set(mapping.nodeId, []);
    }
    const chunk = chunks.find(c => c.index === mapping.chunkIndex);
    if (chunk) {
      chunksByNode.set(mapping.nodeId, [...chunksByNode.get(mapping.nodeId), chunk]);
    }
  }

  // Update each node's summary based on its chunks
  for (const node of nodes) {
    const nodeChunks = chunksByNode.get(node.node_id) || [];
    if (nodeChunks.length === 0) continue;

    // Collect all keywords from chunks
    const allKeywords = new Set();
    for (const chunk of nodeChunks) {
      if (chunk.keywords) {
        chunk.keywords.forEach(k => allKeywords.add(k));
      }
    }

    // Build a better summary from chunk content
    let summary = "";
    if (nodeChunks.length === 1) {
      // Single chunk - use its content as summary
      const content = nodeChunks[0].content || "";
      summary = content.slice(0, 500).replace(/\n/g, " ").trim();
      if (content.length > 500) summary += "...";
    } else {
      // Multiple chunks - create overview with localized label
      const firstChunkPreview = nodeChunks[0].content?.slice(0, 200).replace(/\n/g, " ").trim() || "";
      const containsLabel = lang === 'zh-TW'
        ? `包含 ${nodeChunks.length} 個部分。`
        : isChineseLang(lang)
          ? `包含 ${nodeChunks.length} 个部分。`
          : `Contains ${nodeChunks.length} sections.`;
      summary = `${containsLabel} ${firstChunkPreview}`;
      if (firstChunkPreview.length >= 200) summary += "...";
    }

    // Add keywords if available
    if (allKeywords.size > 0) {
      const keywordStr = Array.from(allKeywords).slice(0, 10).join(", ");
      const topicsLabel = lang === 'zh-TW'
        ? '\n\n主要主題：'
        : isChineseLang(lang)
          ? '\n\n主要主题：'
          : '\n\nKey topics: ';
      summary += `${topicsLabel}${keywordStr}`;
    }

    // Update node in database
    try {
      NodeRepo.updateSummaryAndFts(node.node_id, summary, node.name);
    } catch (err) {
      logger.warn(`Failed to update summary for node ${node.node_id}: ${err.message}`);
    }
  }
}

/**
 * Ensure a root node exists, create one if not
 * @returns {object} Root node
 */
function ensureRootNode() {
  const root = NodeRepo.findAnyRoot();
  if (root) return root;

  logger.info("No root node found, creating default root node");
  return NodeRepo.insertRoot();
}

// ── KP topical hierarchy helpers ──────────────────────────────────────────────

const TOPIC_MATCH_THRESHOLD = 0.55;
const DEDUP_THRESHOLD       = 0.85;
// wordDiceSimilarity imported from knowledgeExtractor.js

/**
 * Find or create a topical node under a given parent.
 * Uses BM25 search + Dice similarity to reuse existing nodes when possible.
 * Returns { ...nodeObject, _created: boolean }.
 */
async function findOrCreateTopicNode(topicName, parentId, options = {}) {
  const { useLLM = true } = options;

  if (!topicName || topicName.trim().length === 0) {
    return { ...ensureRootNode(), _created: false };
  }

  // Search for existing nodes with similar name
  try {
    const candidates = searchNodesByName(topicName, 10);

    // Filter to same parent and score each by name similarity
    const sameParent = candidates.filter(c => {
      const node = c.node || c;
      return node.parent_id === parentId;
    });

    let bestMatch = null;
    let bestScore = 0;

    for (const c of sameParent) {
      const node = c.node || c;
      const score = wordDiceSimilarity(topicName.toLowerCase(), (node.name || "").toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestMatch = node;
      }
    }

    if (bestScore >= TOPIC_MATCH_THRESHOLD) {
      logger.debug(`Topic node reused: "${bestMatch.name}" (score=${bestScore.toFixed(2)}) for "${topicName}"`);
      return { ...bestMatch, _created: false };
    }

    // Borderline match — ask LLM
    if (useLLM && bestScore >= 0.35 && bestMatch) {
      try {
        const suggestion = await suggestNodeWithLLM(
          { content: topicName, keywords: [topicName] },
          [{ node: bestMatch }]
        );
        if (suggestion.confidence >= 0.65 && suggestion.selected_index === 1) {
          logger.debug(`LLM confirmed topic node reuse: "${bestMatch.name}" for "${topicName}"`);
          return { ...bestMatch, _created: false };
        }
      } catch (_) { /* non-fatal */ }
    }
  } catch (err) {
    logger.warn(`Topic node search failed for "${topicName}": ${err.message}`);
  }

  // Create new topical node
  const parentLevel = parentId ? (NodeRepo.getLevel(parentId) ?? 0) : 0;
  const node = createNode({
    node_id:   generateNodeId(topicName),
    name:      topicName,
    parent_id: parentId,
    level:     Number(parentLevel) + 1,
    summary:   ""
  });
  logger.info(`Created topical node: ${node.node_id} (${node.name}) under ${parentId || "root"}`);
  return { ...node, _created: true };
}

/**
 * Group KPs into a 2–3 level topical hierarchy and return a map of
 * kp.index → nodeId for every KP, plus a list of newly created nodes.
 */
async function buildTopicalHierarchy(kps, docTitle, documentId, options = {}) {
  const { useLLM = true } = options;

  ensureRootNode();

  const nodeMap  = new Map();    // kp.index → nodeId
  const newNodes = [];

  // Group by topic_hint
  const byTopic = new Map();
  for (const kp of kps) {
    const topic = (kp.topic_hint || "General").trim();
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(kp);
  }

  for (const [topicName, topicKPs] of byTopic) {
    const domainNode = await findOrCreateTopicNode(topicName, "root", { useLLM });
    if (domainNode._created) newNodes.push(domainNode);

    // Decide whether to add a subtopic level
    const bySubtopic = new Map();
    for (const kp of topicKPs) {
      const sub = (kp.subtopic_hint || "").trim();
      const key = sub || "__none__";
      if (!bySubtopic.has(key)) bySubtopic.set(key, []);
      bySubtopic.get(key).push(kp);
    }

    const uniqueSubs = [...bySubtopic.keys()].filter(k => k !== "__none__");

    // Use a subtopic level only when there are ≥2 distinct, dissimilar subtopics
    let useSubtopic = false;
    if (uniqueSubs.length >= 2) {
      const [s1, s2] = uniqueSubs;
      useSubtopic = wordDiceSimilarity(s1, s2) < 0.6;
    }

    if (useSubtopic) {
      for (const [subKey, subKPs] of bySubtopic) {
        let targetNode = domainNode;
        if (subKey !== "__none__") {
          targetNode = await findOrCreateTopicNode(subKey, domainNode.node_id, { useLLM });
          if (targetNode._created) newNodes.push(targetNode);
        }
        for (const kp of subKPs) nodeMap.set(kp.index, targetNode.node_id);
      }
    } else {
      for (const kp of topicKPs) nodeMap.set(kp.index, domainNode.node_id);
    }
  }

  // Strip internal _created flag before returning
  const cleanNodes = newNodes.map(({ _created: _, ...rest }) => rest);
  return { nodeMap, newNodes: cleanNodes };
}

/**
 * Check for a near-duplicate KP in the same node and either merge source
 * tracking or signal that a new row should be inserted.
 *
 * @returns {number|null} existing chunkId to update, or null → insert new row
 */
async function deduplicateKP(kp, nodeId, sourceDocInfo, options = {}) {
  const { useLLM = true } = options;

  try {
    const candidates = ChunkRepo.findSimilarInNode(nodeId, kp.content, 5);

    for (const candidate of candidates) {
      const sim = wordDiceSimilarity(kp.content, candidate.content_clean || "");

      if (sim >= DEDUP_THRESHOLD) {
        // Definite duplicate — merge source tracking
        const existing = safeJson(candidate.source_documents_json, []);
        const alreadyHasDoc = existing.some(d => d.doc_id === sourceDocInfo.doc_id);
        if (!alreadyHasDoc) {
          const merged = JSON.stringify([...existing, sourceDocInfo]);
          ChunkRepo.updateSourceDocuments(candidate.id, merged);
        }
        logger.debug(`KP deduplicated: "${kp.content.slice(0, 60)}…" merged into chunk ${candidate.id}`);
        return candidate.id;
      }

      if (useLLM && sim >= 0.65) {
        // Borderline — ask LLM with a direct yes/no prompt
        try {
          const apiKey = process.env.GEMINI_API_KEY;
          if (apiKey) {
            const ai = new GoogleGenAI({ apiKey });
            const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
            const prompt = `Are these two knowledge statements expressing the same fact? Answer with JSON only.
A: "${kp.content.slice(0, 300)}"
B: "${(candidate.content_clean || "").slice(0, 300)}"
Return: {"same_fact": true|false, "confidence": 0.0-1.0}`;

            const resp = await ai.models.generateContent({ model, contents: prompt,
              config: { temperature: 0.1, maxOutputTokens: 50 } });
            const text = (resp.text || "{}").replace(/```(?:json)?|```/g, "").trim();
            const parsed = JSON.parse(text);
            if (parsed.same_fact === true && (parsed.confidence ?? 0) >= 0.75) {
              const existing = safeJson(candidate.source_documents_json, []);
              const alreadyHasDoc = existing.some(d => d.doc_id === sourceDocInfo.doc_id);
              if (!alreadyHasDoc) {
                ChunkRepo.updateSourceDocuments(candidate.id, JSON.stringify([...existing, sourceDocInfo]));
              }
              logger.debug(`KP borderline merge confirmed by LLM: chunk ${candidate.id}`);
              return candidate.id;
            }
          }
        } catch (_) { /* non-fatal */ }
      }
    }
  } catch (err) {
    logger.warn(`KP deduplication check failed: ${err.message}`);
  }

  return null; // insert new row
}

/**
 * Insert a KP into the DB and update the FTS index.
 * @returns {number} new chunk ID
 */
function assignKPToNode(kp, nodeId, documentId) {
  return runTransaction(() => {
    const result = ChunkRepo.insertKP({
      doc_title:            kp.doc_title,
      content:              kp.content,
      chunk_type:           kp.chunk_type || kp.kp_type || "fact",
      kp_type:              kp.kp_type || "fact",
      keywords:             kp.keywords || [],
      fields:               kp.fields || {},
      scope:                kp.scope || {},
      authority_level:      kp.authority_level || "sop",
      source_excerpt:       kp.source_excerpt || "",
      source_documents_json: kp.source_documents_json || "[]",
      nodeId,
      documentId,
      index: kp.index
    });

    const chunkId = result.lastInsertRowid;
    ChunkRepo.insertFts(chunkId, kp.content);
    NodeRepo.touch(nodeId);
    logAudit("create", "chunks", chunkId, null, { node_id: nodeId, doc_title: kp.doc_title, kp_type: kp.kp_type });

    return Number(chunkId);
  });
}

/**
 * Auto-map multiple chunks to nodes
 * @param {Array} chunks - Chunks to map
 * @param {number} documentId - Document ID
 * @param {object} options - Mapping options
 * @returns {Promise<object>} Mapping results
 */
export async function autoMapChunks(chunks, documentId, options = {}) {
  const { useLLM = true, createNewNodes = true } = options;

  const results = {
    mapped: [],
    unmapped: [],
    newNodes: []
  };

  // Ensure at least a root node exists
  ensureRootNode();

  if (chunks.length === 0) {
    return results;
  }

  // ── KP topical mapping path ──────────────────────────────────────────────────
  // Detected by the presence of a topic_hint field set by knowledgeExtractor.
  const isKPMode = chunks.some(c => c.topic_hint !== undefined);

  if (isKPMode) {
    const docTitle = chunks[0]?.doc_title || "Untitled";
    logger.info(`KP mapping mode: ${chunks.length} KPs from "${docTitle}"`);

    const { nodeMap, newNodes } = await buildTopicalHierarchy(chunks, docTitle, documentId, { useLLM });
    results.newNodes.push(...newNodes);

    for (const kp of chunks) {
      const targetNodeId = nodeMap.get(kp.index) || "root";
      const sourceDocInfo = { doc_id: documentId, doc_title: docTitle, excerpt: kp.source_excerpt || "" };

      const existingId = await deduplicateKP(kp, targetNodeId, sourceDocInfo, { useLLM });
      if (existingId) {
        results.mapped.push({ chunkIndex: kp.index, chunkId: existingId, nodeId: targetNodeId, deduplicated: true });
      } else {
        const chunkId = assignKPToNode(kp, targetNodeId, documentId);
        results.mapped.push({ chunkIndex: kp.index, chunkId, nodeId: targetNodeId });
      }
    }

    // Generate aliases for new nodes
    if (useLLM && results.newNodes.length > 0) {
      for (const node of results.newNodes) {
        try {
          await generateAndSaveAliases(node.node_id, { includeChunks: true, maxAliases: 8 });
        } catch (err) {
          logger.warn(`Failed to generate aliases for KP node ${node.node_id}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return results;
  }

  // Get document title from first chunk
  const docTitle = chunks[0]?.doc_title || "Untitled Document";

  // Detect language once from first chunk content — passed to all sub-functions
  // so they can use language-appropriate strings and prompts.
  const lang = detectLanguage(chunks[0]?.content || '');

  // Strategy: Create a document hierarchy for new documents
  if (createNewNodes && chunks.length > 0) {
    // First, check if there are existing nodes that match well
    const firstChunkMatch = findBestNodeMatch(chunks[0]);
    const hasGoodExistingMatch = firstChunkMatch && firstChunkMatch.score > 0.5;

    if (!hasGoodExistingMatch) {
      // No good existing match - create new document hierarchy
      logger.info(`Creating document hierarchy for: ${docTitle} (lang: ${lang})`);

      // Analyze document structure with LLM if enabled
      let structure = null;
      if (useLLM) {
        structure = await analyzeDocumentStructure(docTitle, chunks, lang);
      }

      // Create the hierarchy with language context
      const hierarchy = createDocumentHierarchy(docTitle, chunks, structure, lang);
      results.newNodes.push(hierarchy.documentNode, ...hierarchy.sectionNodes);

      // Map chunks to their respective nodes
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const targetNode = hierarchy.chunkToSection.get(i) || hierarchy.documentNode;

        const chunkId = assignChunkToNode(chunk, targetNode.node_id, documentId);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: targetNode.node_id,
          nodeName: targetNode.name,
          score: 1.0,
          newNode: true
        });
      }

      // Update node summaries based on assigned chunks
      updateNodeSummaries(results.newNodes, chunks, results.mapped, lang);

      return results;
    }
  }

  // Fallback: Map chunks individually (existing behavior for matching to existing nodes)
  for (const chunk of chunks) {
    // Find best match
    const match = findBestNodeMatch(chunk);

    if (match && match.score > 0.3) {
      // Good match found
      const chunkId = assignChunkToNode(chunk, match.node.node_id, documentId);
      results.mapped.push({
        chunkIndex: chunk.index,
        chunkId,
        nodeId: match.node.node_id,
        nodeName: match.node.name,
        score: match.score
      });
    } else if (useLLM) {
      // Try LLM suggestion
      const candidates = match?.alternatives || [];
      const suggestion = await suggestNodeWithLLM(chunk, candidates);

      if (suggestion.selected_index > 0 && candidates[suggestion.selected_index - 1]) {
        const selectedNode = candidates[suggestion.selected_index - 1].node;
        const chunkId = assignChunkToNode(chunk, selectedNode.node_id, documentId);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: selectedNode.node_id,
          nodeName: selectedNode.name,
          score: suggestion.confidence,
          llmAssisted: true
        });
      } else if (createNewNodes) {
        // Create new node from LLM suggestion or generate from chunk
        try {
          let newNodeData = suggestion.suggested_new_node;

          // If LLM didn't suggest a node, create one from chunk metadata
          if (!newNodeData || !newNodeData.node_id) {
            newNodeData = generateNodeFromChunk(chunk);
          }

          const newNode = createNode(newNodeData);
          const chunkId = assignChunkToNode(chunk, newNode.node_id, documentId);
          results.newNodes.push(newNode);
          results.mapped.push({
            chunkIndex: chunk.index,
            chunkId,
            nodeId: newNode.node_id,
            nodeName: newNode.name,
            score: suggestion.confidence || 0.5,
            newNode: true
          });
        } catch (err) {
          logger.error("Failed to create new node:", err.message);
          // Fallback: assign to root node
          const rootNode = ensureRootNode();
          const chunkId = assignChunkToNode(chunk, rootNode.node_id, documentId);
          results.mapped.push({
            chunkIndex: chunk.index,
            chunkId,
            nodeId: rootNode.node_id,
            nodeName: rootNode.name,
            score: 0.3,
            fallbackToRoot: true
          });
        }
      } else {
        results.unmapped.push({
          chunkIndex: chunk.index,
          reason: "No suitable node found",
          suggestion: suggestion.suggested_new_node
        });
      }
    } else if (createNewNodes) {
      // No LLM, but createNewNodes is enabled - create from chunk metadata
      try {
        const newNodeData = generateNodeFromChunk(chunk);
        const newNode = createNode(newNodeData);
        const chunkId = assignChunkToNode(chunk, newNode.node_id, documentId);
        results.newNodes.push(newNode);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: newNode.node_id,
          nodeName: newNode.name,
          score: 0.5,
          newNode: true
        });
      } catch (err) {
        logger.error("Failed to create node from chunk:", err.message);
        // Fallback: assign to root node
        const rootNode = ensureRootNode();
        const chunkId = assignChunkToNode(chunk, rootNode.node_id, documentId);
        results.mapped.push({
          chunkIndex: chunk.index,
          chunkId,
          nodeId: rootNode.node_id,
          nodeName: rootNode.name,
          score: 0.3,
          fallbackToRoot: true
        });
      }
    } else {
      results.unmapped.push({
        chunkIndex: chunk.index,
        reason: "No suitable node found"
      });
    }
  }

  return results;
}

/**
 * Generate aliases for a node using LLM
 * @param {string} nodeId - Node ID
 * @param {object} options - Options
 * @returns {Promise<string[]>} Generated aliases
 */
export async function generateNodeAliases(nodeId, options = {}) {
  const { includeChunks = true, maxAliases = 10 } = options;

  // Get the node
  const node = NodeRepo.findById(nodeId);
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }

  // Gather context from node and optionally its chunks
  let context = `Node name: ${node.name}`;
  if (node.node_summary) {
    context += `\nSummary: ${node.node_summary}`;
  }

  if (includeChunks) {
    const chunks = ChunkRepo.getWithKeywords(nodeId, 5);

    if (chunks.length > 0) {
      const keywords = new Set();
      let contentPreview = "";

      for (const chunk of chunks) {
        // Collect keywords
        const chunkKeywords = safeJson(chunk.keywords_json, []);
        chunkKeywords.forEach(k => keywords.add(k));

        // Add content preview
        if (contentPreview.length < 500) {
          contentPreview += (chunk.content_clean || "").slice(0, 200) + " ";
        }
      }

      if (keywords.size > 0) {
        context += `\nKeywords: ${[...keywords].slice(0, 20).join(", ")}`;
      }
      context += `\nContent preview: ${contentPreview.trim().slice(0, 500)}`;
    }
  }

  // Use LLM to generate aliases
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Fallback: generate simple aliases from node name
    return generateSimpleAliases(node.name);
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  // Detect language from context
  const lang = detectLanguage(context);

  // Use bilingual prompt based on content language
  const prompt = getPrompt('aliasGeneration', lang, context, maxAliases);

  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    const text = resp?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "[]";
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    const aliases = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    // Filter and clean aliases
    const validAliases = aliases
      .filter(a => typeof a === "string" && a.length > 0 && a.length < 100)
      .filter(a => a.toLowerCase() !== node.name.toLowerCase())
      .slice(0, maxAliases);

    logger.info(`Generated ${validAliases.length} aliases for node ${nodeId}`);
    return validAliases;
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.error(`Failed to generate aliases for ${nodeId}:`, err.message);
    return generateSimpleAliases(node.name);
  }
}

/**
 * Generate simple aliases from node name (fallback without LLM)
 * @param {string} nodeName - Node name
 * @returns {string[]} Simple aliases
 */
function generateSimpleAliases(nodeName) {
  const aliases = [];

  // Add lowercase version
  if (nodeName !== nodeName.toLowerCase()) {
    aliases.push(nodeName.toLowerCase());
  }

  // Split by common separators and create variations
  const parts = nodeName.split(/[-_\s]+/);
  if (parts.length > 1) {
    // Join without spaces
    aliases.push(parts.join(""));
    // Join with different separators
    aliases.push(parts.join("-"));
    aliases.push(parts.join("_"));
  }

  // Remove common prefixes/suffixes
  const withoutDoc = nodeName.replace(/^(doc|document|file)[-_\s]*/i, "");
  if (withoutDoc !== nodeName && withoutDoc.length > 2) {
    aliases.push(withoutDoc);
  }

  return [...new Set(aliases)].slice(0, 5);
}

/**
 * Update node aliases in database
 * @param {string} nodeId - Node ID
 * @param {string[]} aliases - Aliases to set
 * @returns {boolean} Success
 */
export function updateNodeAliases(nodeId, aliases) {
  try {
    if (!NodeRepo.existsById(nodeId)) return false;

    const existingAliasesJson = NodeRepo.getAliasesJson(nodeId);
    const existingAliases = safeJson(existingAliasesJson, []);
    const mergedAliases = [...new Set([...existingAliases, ...aliases])];

    const nodeData = NodeRepo.getNameAndSummary(nodeId);
    const ftsText = nodeData
      ? `${nodeData.name} ${nodeData.node_summary || ""} ${mergedAliases.join(" ")}`
      : mergedAliases.join(" ");

    NodeRepo.updateAliasesAndFts(nodeId, JSON.stringify(mergedAliases), ftsText);

    logger.info(`Updated aliases for node ${nodeId}: ${mergedAliases.length} total`);
    return true;
  } catch (err) {
    logger.error(`Failed to update aliases for ${nodeId}:`, err.message);
    return false;
  }
}

/**
 * Generate and save aliases for a node
 * @param {string} nodeId - Node ID
 * @param {object} options - Options
 * @returns {Promise<string[]>} Generated aliases
 */
export async function generateAndSaveAliases(nodeId, options = {}) {
  const aliases = await generateNodeAliases(nodeId, options);
  if (aliases.length > 0) {
    updateNodeAliases(nodeId, aliases);
  }
  return aliases;
}

/**
 * Generate aliases for all nodes missing aliases
 * @param {object} options - Options
 * @returns {Promise<object>} Results
 */
export async function generateAliasesForAllNodes(options = {}) {
  const { limit = 50, onProgress = null } = options;

  // Find nodes without aliases
  const nodes = NodeRepo.findWithoutAliases(limit);

  const results = {
    processed: 0,
    success: 0,
    failed: 0,
    aliases_generated: 0
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    try {
      const aliases = await generateAndSaveAliases(node.node_id, options);
      results.success++;
      results.aliases_generated += aliases.length;
    } catch (err) {
      logger.error(`Failed to generate aliases for ${node.node_id}:`, err.message);
      results.failed++;
    }

    results.processed++;

    if (onProgress) {
      onProgress(results.processed, nodes.length);
    }

    // Rate limiting - wait a bit between LLM calls
    if (i < nodes.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  logger.info(`Alias generation complete: ${results.success}/${results.processed} nodes, ${results.aliases_generated} aliases`);
  return results;
}
