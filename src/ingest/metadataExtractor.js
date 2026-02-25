import { callLLM, llmConfig } from "../utils/llm.js";
import { getPrompt } from "../utils/langDetect.js";
import { getEffectiveLang } from "../utils/datasetLang.js";
import { rethrowIfRateLimit } from "../utils/rateLimitError.js";
import { ingestLogger as logger } from "../utils/logger.js";

/**
 * Extract metadata from text using TF-IDF and LLM
 */

// Simple TF-IDF implementation for keyword extraction
class TFIDF {
  constructor() {
    this.documents = [];
    this.vocabulary = new Map();
    this.idf = new Map();
  }

  // Tokenize text (handles both English and Chinese)
  tokenize(text) {
    // Remove punctuation and split
    const cleaned = text.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s]/g, " ");

    // Split English words and Chinese characters
    const tokens = [];

    // English words (2+ chars)
    const englishWords = cleaned.match(/[a-z]{2,}/g) || [];
    tokens.push(...englishWords);

    // Chinese characters/words (treat each char as token for simplicity)
    const chineseChars = cleaned.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const segment of chineseChars) {
      // Use 2-char sliding window for Chinese
      for (let i = 0; i < segment.length - 1; i++) {
        tokens.push(segment.slice(i, i + 2));
      }
      if (segment.length === 1) {
        tokens.push(segment);
      }
    }

    return tokens;
  }

  // Calculate term frequency
  termFrequency(tokens) {
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    // Normalize by document length
    for (const [token, count] of tf) {
      tf.set(token, count / tokens.length);
    }
    return tf;
  }

  // Add document to corpus
  addDocument(text) {
    const tokens = this.tokenize(text);
    const tf = this.termFrequency(tokens);

    this.documents.push({ text, tokens, tf });

    // Update vocabulary
    const seen = new Set();
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        this.vocabulary.set(token, (this.vocabulary.get(token) || 0) + 1);
      }
    }
  }

  // Calculate IDF for all terms
  calculateIDF() {
    const N = this.documents.length;
    for (const [term, docCount] of this.vocabulary) {
      this.idf.set(term, Math.log(N / docCount) + 1);
    }
  }

  // Get top keywords for a document
  getKeywords(docIndex, topK = 10) {
    if (this.idf.size === 0) {
      this.calculateIDF();
    }

    const doc = this.documents[docIndex];
    if (!doc) return [];

    const tfidf = [];
    for (const [term, tf] of doc.tf) {
      const idf = this.idf.get(term) || 1;
      tfidf.push({ term, score: tf * idf });
    }

    return tfidf
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(item => item.term);
  }
}

// Stopwords (English and Chinese)
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "must", "shall", "can", "to", "of", "in", "for", "on", "with",
  "at", "by", "from", "as", "into", "through", "during", "before", "after",
  "above", "below", "between", "under", "again", "further", "then", "once",
  "here", "there", "when", "where", "why", "how", "all", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "and", "but", "if", "or", "because",
  "while", "although", "this", "that", "these", "those", "it", "its",
  // Chinese common stopwords
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一",
  "这", "中", "大", "上", "为", "个", "以", "说", "也", "着", "要", "会",
  "来", "他", "时", "能", "到", "很", "下", "自", "之", "年", "过", "发",
  "与", "及", "等", "但", "对", "把", "而", "或", "其", "你", "她", "它"
]);

/**
 * Extract keywords using TF-IDF
 * @param {string} text - Text to extract keywords from
 * @param {number} topK - Number of keywords to extract
 * @returns {string[]} Keywords
 */
export function extractKeywords(text, topK = 10) {
  const tfidf = new TFIDF();

  // Split into paragraphs and treat each as a "document" for better IDF
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 50);

  if (paragraphs.length < 3) {
    // Not enough paragraphs, use sliding window
    const windowSize = 500;
    const step = 250;
    for (let i = 0; i < text.length; i += step) {
      const window = text.slice(i, i + windowSize);
      if (window.length > 100) {
        tfidf.addDocument(window);
      }
    }
  } else {
    for (const para of paragraphs) {
      tfidf.addDocument(para);
    }
  }

  // Add the full text as the last document
  tfidf.addDocument(text);

  // Get keywords from the full text (last document)
  const keywords = tfidf.getKeywords(tfidf.documents.length - 1, topK * 2);

  // Filter out stopwords and short terms
  return keywords
    .filter(kw => !STOPWORDS.has(kw) && kw.length >= 2)
    .slice(0, topK);
}

/**
 * Extract entities using pattern matching
 * @param {string} text - Text to extract entities from
 * @returns {object} Extracted entities
 */
export function extractEntitiesBasic(text) {
  const entities = {
    products: [],
    regions: [],
    dates: [],
    numbers: [],
    emails: [],
    urls: []
  };

  // Email pattern
  const emails = text.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
  entities.emails = [...new Set(emails)];

  // URL pattern
  const urls = text.match(/https?:\/\/[^\s]+/g) || [];
  entities.urls = [...new Set(urls)];

  // Date patterns (various formats)
  const datePatterns = [
    /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?/g,  // 2024-01-15, 2024年1月15日
    /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/g,           // 01/15/2024
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi
  ];

  for (const pattern of datePatterns) {
    const matches = text.match(pattern) || [];
    entities.dates.push(...matches);
  }
  entities.dates = [...new Set(entities.dates)];

  // Numbers with units
  const numberPatterns = text.match(/\d+(?:\.\d+)?(?:\s*(?:元|美元|USD|CNY|%|万|亿|千|百|个|件|台|次|人|年|月|日|天|小时|分钟|秒))?/g) || [];
  entities.numbers = [...new Set(numberPatterns)].slice(0, 20);

  return entities;
}

/**
 * Use LLM to extract structured metadata
 * @param {string} text - Text to analyze
 * @param {string} docTitle - Document title (optional)
 * @returns {Promise<object>} Extracted metadata
 */
export async function extractMetadataWithLLM(text, docTitle = "") {
  // Detect language first
  const lang = getEffectiveLang(text);

  if (!llmConfig[llmConfig.provider]?.apiKey) {
    logger.debug("LLM API key not set, using basic extraction only");
    return {
      keywords: extractKeywords(text),
      entities: extractEntitiesBasic(text),
      chunk_type: detectChunkType(text),
      authority_level: detectAuthorityLevel(text, docTitle),
      language: lang
    };
  }

  // Truncate text if too long
  const maxLen = 4000;
  const truncatedText = text.length > maxLen
    ? text.slice(0, maxLen) + "\n...[truncated]"
    : text;

  // Use bilingual prompt based on document language
  const prompt = getPrompt('metadataExtraction', lang, docTitle, truncatedText);

  try {
    const respText = await callLLM({ prompt, taskName: 'metadata_extraction' }) ?? "{}";

    // Extract JSON from response
    const jsonMatch = respText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, respText];
    const jsonStr = jsonMatch[1] || respText;

    const result = JSON.parse(jsonStr);
    // Ensure language is set correctly
    result.language = lang;
    return result;
  } catch (err) {
    rethrowIfRateLimit(err);
    logger.warn(`LLM metadata extraction failed: ${err.message}`);
    // Fallback to basic extraction
    return {
      keywords: extractKeywords(text),
      entities: extractEntitiesBasic(text),
      chunk_type: detectChunkType(text),
      authority_level: detectAuthorityLevel(text, docTitle),
      language: lang
    };
  }
}

/**
 * Detect document/chunk type based on content patterns
 */
export function detectChunkType(text) {
  const lower = text.toLowerCase();

  // Check for common patterns
  if (/(?:policy|政策|规定|条例|制度)/.test(text)) return "policy";
  if (/(?:step|步骤|流程|操作指南|how to)/i.test(text)) return "procedure";
  if (/(?:q:|a:|问:|答:|faq|常见问题)/i.test(text)) return "faq";
  if (/(?:guide|指南|教程|tutorial)/i.test(text)) return "guide";
  if (/(?:announcement|通知|公告|notice)/i.test(text)) return "announcement";
  if (/(?:report|报告|分析|analysis)/i.test(text)) return "report";
  if (/(?:reference|参考|说明书|specification)/i.test(text)) return "reference";

  return "other";
}

/**
 * Detect authority level based on content and title
 */
export function detectAuthorityLevel(text, docTitle = "") {
  const combined = (docTitle + " " + text).toLowerCase();

  if (/(?:policy|政策|规定|条例|official|正式|mandatory|必须)/i.test(combined)) {
    return "policy";
  }
  if (/(?:sop|标准操作|procedure|流程|standard)/i.test(combined)) {
    return "sop";
  }
  if (/(?:training|培训|教程|tutorial|guide|指南)/i.test(combined)) {
    return "training";
  }

  return "sop"; // Default
}

// Re-export detectLanguage from langDetect for backwards compatibility
export { detectLanguage } from "../utils/langDetect.js";

/**
 * Extract scope information from text
 */
export function extractScope(text, docTitle = "") {
  const combined = docTitle + " " + text;
  const scope = {};

  // Product patterns
  const productPatterns = [
    /产品[：:]\s*([^\n,]+)/,
    /product[：:]\s*([^\n,]+)/i,
    /适用于\s*([^\n,]+?)(?:产品|系列)/
  ];

  for (const pattern of productPatterns) {
    const match = combined.match(pattern);
    if (match) {
      scope.product = match[1].trim();
      break;
    }
  }

  // Region patterns
  const regionPatterns = [
    /地区[：:]\s*([^\n,]+)/,
    /region[：:]\s*([^\n,]+)/i,
    /适用地区[：:]\s*([^\n,]+)/
  ];

  for (const pattern of regionPatterns) {
    const match = combined.match(pattern);
    if (match) {
      scope.region = match[1].trim();
      break;
    }
  }

  // Business unit patterns
  const buPatterns = [
    /部门[：:]\s*([^\n,]+)/,
    /business\s*unit[：:]\s*([^\n,]+)/i,
    /适用部门[：:]\s*([^\n,]+)/
  ];

  for (const pattern of buPatterns) {
    const match = combined.match(pattern);
    if (match) {
      scope.business_unit = match[1].trim();
      break;
    }
  }

  return scope;
}
