/**
 * Semantic chunking with configurable size and overlap
 */

// Default configuration
const DEFAULT_CONFIG = {
  maxChunkSize: 800,      // Target max tokens (approximate as ~4 chars/token)
  minChunkSize: 150,      // Minimum chunk size
  overlap: 150,           // Overlap tokens between chunks — larger overlap reduces info loss at boundaries
  softLimitFactor: 1.15,  // Allow chunks up to 15% over maxChunkSize to avoid mid-thought cuts
  preserveParagraphs: true,
  preserveSentences: true
};

// Approximate token count (rough estimate: 4 chars per token for English, 2 for Chinese)
function estimateTokens(text) {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

// Split text into paragraphs
function splitIntoParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

// Split text into sentences (handles both English and Chinese)
function splitIntoSentences(text) {
  // Match sentence endings: . ! ? or Chinese equivalents
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) || [text];
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

// Detect whether a text block looks like a list (most lines are list items)
const LIST_ITEM_RE = /^[ \t]*[-*•+][ \t]|^[ \t]*\d+[.)]\s/m;
function isListBlock(text) {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;
  const listLines = lines.filter(l => LIST_ITEM_RE.test(l));
  return listLines.length / lines.length > 0.5;
}

// Detect whether a paragraph looks like a header or label
// (short, ends with ':' or '：', starts with '#', or is all-caps)
function isLikelyHeader(text) {
  const t = text.trim();
  return (
    t.length < 120 &&
    (t.endsWith(':') || t.endsWith('：') || t.startsWith('#') || /^[A-Z][A-Z\s,.\-–—]{5,}$/.test(t))
  );
}

/**
 * Pre-group paragraphs to keep semantically related units together.
 *  - Glues header/label paragraphs to the following paragraph
 *  - Glues intro sentences to immediately following list blocks
 */
function preGroupParagraphs(paragraphs) {
  const groups = [];
  let i = 0;

  while (i < paragraphs.length) {
    const current = paragraphs[i];

    // A header/label paragraph — attach it to the next paragraph so it is
    // never left alone in a chunk without the content it introduces.
    if (isLikelyHeader(current) && i + 1 < paragraphs.length) {
      groups.push(current + '\n\n' + paragraphs[i + 1]);
      i += 2;
      continue;
    }

    // A short intro paragraph immediately before a list block — attach them.
    if (current.length < 250 && i + 1 < paragraphs.length && isListBlock(paragraphs[i + 1])) {
      let combined = current + '\n\n' + paragraphs[i + 1];
      i += 2;
      // Absorb any additional consecutive list blocks that follow
      while (i < paragraphs.length && isListBlock(paragraphs[i])) {
        combined += '\n\n' + paragraphs[i];
        i++;
      }
      groups.push(combined);
      continue;
    }

    groups.push(current);
    i++;
  }

  return groups;
}

/**
 * Produce overlap text by taking the last complete paragraph(s) that fit
 * within overlapChars, rather than a raw character-tail (which can start
 * mid-sentence).
 */
function getOverlapText(text, overlapChars) {
  if (!text || overlapChars <= 0) return '';
  if (text.length <= overlapChars) return text;

  const paras = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  let overlap = '';
  // Work backwards: include as many complete paragraphs as fit
  for (let i = paras.length - 1; i >= 0; i--) {
    const candidate = paras.slice(i).join('\n\n');
    if (candidate.length <= overlapChars) {
      overlap = candidate;
    } else {
      break;
    }
  }

  if (overlap) return overlap;

  // Fall back: character slice, but try to start at a sentence boundary
  const sliced = text.slice(-overlapChars);
  const sentenceStart = sliced.search(/(?<=[.!?。！？]\s)[A-Z\u4e00-\u9fa5]/);
  if (sentenceStart > 0 && sentenceStart < overlapChars * 0.6) {
    return sliced.slice(sentenceStart);
  }
  return sliced;
}

// Split text into sections (by headers)
function splitIntoSections(text) {
  // Match markdown headers or numbered sections
  const sectionRegex = /^(?:#{1,6}\s+.+|(?:\d+\.)+\s+.+|\*{2,}.+\*{2,})$/gm;
  const sections = [];
  let lastIndex = 0;
  let match;

  const matches = [...text.matchAll(sectionRegex)];

  for (let i = 0; i < matches.length; i++) {
    match = matches[i];
    if (match.index > lastIndex) {
      sections.push({
        header: i === 0 ? null : matches[i - 1]?.[0],
        content: text.slice(lastIndex, match.index).trim()
      });
    }
    lastIndex = match.index;
  }

  // Add remaining content
  if (lastIndex < text.length) {
    sections.push({
      header: matches[matches.length - 1]?.[0] || null,
      content: text.slice(lastIndex).trim()
    });
  }

  return sections.filter(s => s.content.length > 0);
}

/**
 * Main chunking function
 * @param {string} text - Text to chunk
 * @param {object} config - Chunking configuration
 * @returns {Array<{content: string, index: number, metadata: object}>}
 */
export function chunkText(text, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const maxChars = cfg.maxChunkSize * 4; // Approximate chars
  const minChars = cfg.minChunkSize * 4;
  const overlapChars = cfg.overlap * 4;
  const softLimit = maxChars * (cfg.softLimitFactor || 1.15);

  const chunks = [];
  let chunkIndex = 0;

  // First, try to split by sections
  const sections = splitIntoSections(text);

  for (const section of sections) {
    const sectionChunks = chunkSection(section.content, {
      maxChars,
      minChars,
      overlapChars,
      softLimit,
      preserveParagraphs: cfg.preserveParagraphs,
      preserveSentences: cfg.preserveSentences
    });

    for (const chunk of sectionChunks) {
      chunks.push({
        content: chunk.content,
        index: chunkIndex++,
        metadata: {
          sectionHeader: section.header,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          estimatedTokens: estimateTokens(chunk.content)
        }
      });
    }
  }

  // If no sections found, chunk the entire text
  if (chunks.length === 0) {
    const textChunks = chunkSection(text, {
      maxChars,
      minChars,
      overlapChars,
      softLimit,
      preserveParagraphs: cfg.preserveParagraphs,
      preserveSentences: cfg.preserveSentences
    });

    for (const chunk of textChunks) {
      chunks.push({
        content: chunk.content,
        index: chunkIndex++,
        metadata: {
          sectionHeader: null,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          estimatedTokens: estimateTokens(chunk.content)
        }
      });
    }
  }

  return chunks;
}

// Chunk a single section
function chunkSection(text, { maxChars, minChars, overlapChars, softLimit, preserveParagraphs, preserveSentences }) {
  const chunks = [];
  const effectiveSoftLimit = softLimit || maxChars * 1.15;

  if (text.length <= effectiveSoftLimit) {
    return [{ content: text, startOffset: 0, endOffset: text.length }];
  }

  // Split by paragraphs first if enabled, then pre-group related paragraphs
  let units;
  if (preserveParagraphs) {
    const rawParagraphs = splitIntoParagraphs(text);
    units = preGroupParagraphs(rawParagraphs);
  } else {
    units = [text];
  }

  // If any grouped unit is still too large, split into sentences
  const processedUnits = [];
  for (const unit of units) {
    if (unit.length > maxChars && preserveSentences) {
      // Try splitting into sentences; if a sentence itself is huge, keep it whole
      const sentences = splitIntoSentences(unit);
      processedUnits.push(...sentences);
    } else {
      processedUnits.push(unit);
    }
  }

  // Build chunks from units using a soft size limit
  let currentChunk = "";
  let currentStart = 0;
  let offset = 0;

  for (let i = 0; i < processedUnits.length; i++) {
    const unit = processedUnits[i];
    const separator = currentChunk ? "\n\n" : "";
    const projectedSize = currentChunk.length + separator.length + unit.length;

    if (projectedSize <= maxChars) {
      // Normal case: unit fits within the hard limit
      currentChunk += separator + unit;
    } else if (projectedSize <= effectiveSoftLimit && unit.length < maxChars * 0.25) {
      // Soft limit: allow slightly oversized chunks to avoid orphaning a small
      // trailing unit (e.g., the last sentence of a paragraph).
      currentChunk += separator + unit;
    } else {
      // Must split here — save current chunk if it meets the minimum size
      if (currentChunk.length >= minChars) {
        chunks.push({
          content: currentChunk,
          startOffset: currentStart,
          endOffset: offset
        });

        // Start new chunk with paragraph-aware overlap
        if (overlapChars > 0) {
          const overlapText = getOverlapText(currentChunk, overlapChars);
          if (overlapText) {
            currentChunk = overlapText + "\n\n" + unit;
            currentStart = offset - overlapText.length;
          } else {
            currentChunk = unit;
            currentStart = offset;
          }
        } else {
          currentChunk = unit;
          currentStart = offset;
        }
      } else {
        // Current chunk is too small to save alone — absorb the unit even if oversized
        currentChunk += separator + unit;
      }
    }

    offset += unit.length + (i < processedUnits.length - 1 ? 2 : 0);
  }

  // Save the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk,
      startOffset: currentStart,
      endOffset: offset
    });
  }

  return chunks;
}

/**
 * Chunk with sliding window (alternative approach)
 * @param {string} text - Text to chunk
 * @param {number} windowSize - Window size in chars
 * @param {number} stepSize - Step size in chars
 * @returns {Array<{content: string, index: number}>}
 */
export function slidingWindowChunk(text, windowSize = 2000, stepSize = 1500) {
  const chunks = [];
  let index = 0;

  for (let i = 0; i < text.length; i += stepSize) {
    const chunk = text.slice(i, i + windowSize);
    if (chunk.length > 0) {
      chunks.push({
        content: chunk,
        index: index++,
        metadata: {
          startOffset: i,
          endOffset: Math.min(i + windowSize, text.length),
          estimatedTokens: estimateTokens(chunk)
        }
      });
    }
  }

  return chunks;
}

/**
 * Get chunking statistics
 * @param {Array} chunks - Array of chunks
 * @returns {object} Statistics
 */
export function getChunkStats(chunks) {
  if (!chunks.length) {
    return { count: 0, avgTokens: 0, minTokens: 0, maxTokens: 0, totalTokens: 0 };
  }

  const tokenCounts = chunks.map(c =>
    c.metadata?.estimatedTokens || estimateTokens(c.content)
  );

  return {
    count: chunks.length,
    avgTokens: Math.round(tokenCounts.reduce((a, b) => a + b, 0) / chunks.length),
    minTokens: Math.min(...tokenCounts),
    maxTokens: Math.max(...tokenCounts),
    totalTokens: tokenCounts.reduce((a, b) => a + b, 0)
  };
}
