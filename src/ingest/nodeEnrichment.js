/**
 * Shared node enrichment helpers.
 *
 * Used by both the ingestion pipeline (stages.js) and the reprocess API.
 * Operates on explicit node IDs — no ingest context required.
 */

import { ChunkRepo } from "../db/repositories/ChunkRepo.js";
import { NodeRepo } from "../db/repositories/NodeRepo.js";
import { safeJson } from "../db/db.js";
import { ingestLogger as logger } from "../utils/logger.js";

// ── Acronym false-positives ──────────────────────────────────────────────────
const ACRONYM_STOP = new Set([
  'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'HAS', 'HIS', 'HOW', 'ITS', 'MAY', 'NEW',
  'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'DID', 'GET', 'HIM', 'LET', 'SAY',
  'SHE', 'TOO', 'USE', 'THIS', 'THAT', 'WITH', 'HAVE', 'FROM', 'THEY',
  'BEEN', 'SAID', 'EACH', 'THAN', 'THEM', 'THEN', 'WHEN', 'WILL', 'INTO',
  'TEXT', 'NULL', 'TRUE', 'ALSO', 'JUST', 'ONLY', 'VERY', 'EVEN', 'MOST',
  'II', 'III', 'IV'
]);

// ── Content-frequency stopwords ──────────────────────────────────────────────
const CONTENT_STOP = new Set([
  'the','a','an','to','of','for','in','on','at','by','with','from','and','or',
  'is','are','was','were','be','been','being','do','does','did','has','have','had',
  'will','shall','should','would','could','may','might','must','can','not','no',
  'this','that','these','those','it','its','he','she','they','we','you','his','her',
  'their','our','your','all','each','every','any','some','such','than','then','so',
  'if','but','as','up','out','about','into','over','after','before','between','under',
  'during','through','above','below','also','more','most','other','only','very',
  'just','well','back','even','still','already','use','used','using','per',
  'new','first','one','two','three','see','set','get','make','know','may','must',
  'based','include','includes','required','following','case','cases','within','upon',
  'however','therefore','need','needs','note','ensure','refer','via','unless'
]);

/**
 * Extract structured keywords from a node's chunks and merge into node keywords.
 * Regex extraction (proper nouns, acronyms, numbers, temperature) + content-frequency.
 * Rebuilds FTS after merging.
 *
 * @param {string} nodeId
 * @returns {{ added: number }} count of new keywords added
 */
export function enrichNodeKeywords(nodeId) {
  const chunks = ChunkRepo.getForNodeLimited(nodeId, 10);
  if (chunks.length === 0) return { added: 0 };

  const allText = chunks.map(c => c.content_clean || c.content || '').join('\n');
  const freq = new Map();

  const addKw = (kw) => {
    const trimmed = kw.trim();
    if (trimmed.length < 2 || trimmed.length > 60) return;
    const key = trimmed.toLowerCase();
    freq.set(key, (freq.get(key) || 0) + 1);
  };

  // Multi-word proper nouns
  for (const m of allText.matchAll(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g)) addKw(m[0]);

  // Acronyms (filter stopwords)
  for (const m of allText.matchAll(/\b[A-Z]{2,6}\b/g)) {
    if (!ACRONYM_STOP.has(m[0])) addKw(m[0]);
  }

  // Numeric thresholds
  for (const m of allText.matchAll(/\b\d+(?:\.\d+)?\s*(?:%|(?:days?|hours?|months?|years?|weeks?|USD|RMB|yuan|dollars?)\b)/gi)) addKw(m[0]);

  // CJK quantities
  for (const m of allText.matchAll(/\d+\s*[天月年小时周个]+/g)) addKw(m[0]);

  // Temperature
  for (const m of allText.matchAll(/\d+(?:\.\d+)?\s*°[CF]/g)) addKw(m[0]);
  for (const m of allText.matchAll(/\b\d+(?:\.\d+)?\s*degrees?\b/gi)) addKw(m[0]);

  // Content-frequency pass
  const chunkWordSets = chunks.map(c => {
    const words = (c.content_clean || '').toLowerCase().match(/[a-z]{4,}/g) || [];
    return new Set(words);
  });
  const wordChunkCount = new Map();
  for (const wordSet of chunkWordSets) {
    for (const word of wordSet) {
      if (!CONTENT_STOP.has(word)) {
        wordChunkCount.set(word, (wordChunkCount.get(word) || 0) + 1);
      }
    }
  }
  const minChunkFreq = Math.max(3, Math.ceil(chunkWordSets.length * 0.25));
  const freqDerived = [];
  for (const [word, count] of wordChunkCount) {
    if (count >= minChunkFreq && word.length >= 4) {
      freqDerived.push({ word, count });
    }
  }
  freqDerived.sort((a, b) => b.count - a.count);
  for (const { word } of freqDerived.slice(0, 10)) addKw(word);

  if (freq.size === 0) return { added: 0 };

  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const keywords = sorted.map(([kw]) => kw);

  const before = safeJson(NodeRepo.findById(nodeId)?.keywords_json, []).length;
  NodeRepo.mergeKeywords(nodeId, keywords);
  NodeRepo.rebuildFts(nodeId);
  const after = safeJson(NodeRepo.findById(nodeId)?.keywords_json, []).length;

  return { added: after - before };
}

/**
 * Compute and store heuristic quality score for a node.
 *
 * @param {string} nodeId
 * @returns {number|null} computed quality score, or null if node not found
 */
export function computeNodeQuality(nodeId) {
  const node = NodeRepo.findById(nodeId);
  if (!node) return null;

  let quality = 0.0;
  const summary = (node.node_summary || '').trim();
  if (summary.length > 20) quality += 0.25;

  const chunkCount = ChunkRepo.getForNodeLimited(nodeId, 4).length;
  if (chunkCount >= 3) quality += 0.25;

  const aliases = safeJson(node.aliases_json, []);
  if (aliases.length >= 3) quality += 0.20;

  const keywords = safeJson(node.keywords_json, []);
  if (keywords.length >= 3) quality += 0.15;

  const desc = (node.node_description || '').trim();
  if (desc.length > 0) quality += 0.15;

  if (node.name === 'General' || node.name.startsWith('General —')) {
    quality *= 0.7;
  }

  quality = Math.min(quality, 1.0);
  NodeRepo.updateQualityScore(nodeId, quality);
  return quality;
}
