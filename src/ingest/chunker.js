/**
 * Semantic chunking with configurable size and overlap
 */

// Default configuration
const DEFAULT_CONFIG = {
  maxChunkSize: 500,      // Target max tokens (approximate as ~4 chars/token)
  minChunkSize: 100,      // Minimum chunk size
  overlap: 50,            // Overlap tokens between chunks
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

  const chunks = [];
  let chunkIndex = 0;

  // First, try to split by sections
  const sections = splitIntoSections(text);

  for (const section of sections) {
    const sectionChunks = chunkSection(section.content, {
      maxChars,
      minChars,
      overlapChars,
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
function chunkSection(text, { maxChars, minChars, overlapChars, preserveParagraphs, preserveSentences }) {
  const chunks = [];

  if (text.length <= maxChars) {
    return [{ content: text, startOffset: 0, endOffset: text.length }];
  }

  // Split by paragraphs first if enabled
  let units = preserveParagraphs ? splitIntoParagraphs(text) : [text];

  // If paragraphs are too large, split into sentences
  const processedUnits = [];
  for (const unit of units) {
    if (unit.length > maxChars && preserveSentences) {
      processedUnits.push(...splitIntoSentences(unit));
    } else {
      processedUnits.push(unit);
    }
  }

  // Build chunks from units
  let currentChunk = "";
  let currentStart = 0;
  let offset = 0;

  for (let i = 0; i < processedUnits.length; i++) {
    const unit = processedUnits[i];
    const separator = currentChunk ? "\n\n" : "";

    if (currentChunk.length + separator.length + unit.length <= maxChars) {
      currentChunk += separator + unit;
    } else {
      // Save current chunk if it's big enough
      if (currentChunk.length >= minChars) {
        chunks.push({
          content: currentChunk,
          startOffset: currentStart,
          endOffset: offset
        });

        // Start new chunk with overlap
        if (overlapChars > 0 && currentChunk.length > overlapChars) {
          const overlapText = currentChunk.slice(-overlapChars);
          currentChunk = overlapText + "\n\n" + unit;
          currentStart = offset - overlapChars;
        } else {
          currentChunk = unit;
          currentStart = offset;
        }
      } else {
        // Chunk too small, force add the unit
        currentChunk += separator + unit;
      }
    }

    offset += unit.length + (i < processedUnits.length - 1 ? 2 : 0);
  }

  // Don't forget the last chunk
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
