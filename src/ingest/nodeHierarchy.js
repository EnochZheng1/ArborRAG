import { runTransaction, logAudit } from "../db/db.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { callLLM, llmConfig } from "../utils/llm.js";
import { ingestLogger as logger } from "../utils/logger.js";
import { getPrompt, isChineseLang } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";

/**
 * Generate a unique node ID from text
 * @param {string} text - Text to generate ID from
 * @returns {string} Node ID
 */
export function generateNodeId(text) {
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
 * Internal helper: create a node record.
 * Mirrors createNode in nodeMapper.js but kept local to avoid a circular import
 * (nodeHierarchy is imported by nodeMapper, so nodeHierarchy cannot statically
 * import from nodeMapper).
 */
function _createNode(nodeData) {
  const { node_id, name, parent_id = null, level = 1, summary = "", scope = {} } = nodeData;

  if (parent_id && !NodeRepo.existsById(parent_id)) {
    throw new Error(`Parent node not found: ${parent_id}`);
  }

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
 * Use LLM to analyze document structure and suggest hierarchy
 * @param {string} docTitle - Document title
 * @param {Array} chunks - All chunks from document
 * @param {string} lang - Language code detected by caller
 * @returns {Promise<object>} Suggested hierarchy
 */
export async function analyzeDocumentStructure(docTitle, chunks, lang) {
  if (!llmConfig[llmConfig.provider]?.apiKey) {
    return null;
  }

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
    const text = await callLLM({ prompt, temperature: 0.1, taskName: 'document_structure' }) ?? "{}";

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
export function createDocumentHierarchy(docTitle, chunks, structure = null, lang = 'en') {
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

  const docNode = _createNode({
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
      const sectionNode = _createNode({
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
      const contentNode = _createNode({
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
export function generateNodeFromChunk(chunk, parentId = "root") {
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
export function updateNodeSummaries(nodes, chunks, mappings, lang = 'en') {
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
export function ensureRootNode() {
  const root = NodeRepo.findAnyRoot();
  if (root) return root;

  logger.info("No root node found, creating default root node");
  return NodeRepo.insertRoot();
}
