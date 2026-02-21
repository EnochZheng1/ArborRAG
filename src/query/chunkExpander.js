import { ChunkRepo } from "../db/repositories/ChunkRepo.js";

/**
 * Contextual Chunk Expansion Module
 *
 * Expands retrieved chunks by including neighboring chunks for better context
 */

/**
 * Expand chunks with their neighbors
 * @param {Array} chunks - Retrieved chunks
 * @param {object} options - Options
 * @returns {Array} Expanded chunks with context
 */
export function expandChunksWithContext(chunks, options = {}) {
  const {
    windowBefore = 1,  // Number of chunks to include before
    windowAfter = 1,   // Number of chunks to include after
    maxContextLength = 2000,  // Max chars for context (per side)
    deduplicateById = true
  } = options;

  if (!chunks || chunks.length === 0) return [];

  const expandedChunks = [];
  const seenIds = new Set();

  for (const chunk of chunks) {
    const chunkId = chunk.id || chunk.chunk?.id;
    const docId = chunk.document_id || chunk.doc_id || chunk.chunk?.document_id;

    if (!chunkId) {
      expandedChunks.push(chunk);
      continue;
    }

    if (deduplicateById && seenIds.has(chunkId)) {
      continue;
    }
    seenIds.add(chunkId);

    // Get chunk sequence info
    const chunkInfo = getChunkSequenceInfo(chunkId);

    if (!chunkInfo) {
      expandedChunks.push(chunk);
      continue;
    }

    // Get neighboring chunks
    const neighbors = getNeighborChunks(
      chunkInfo.document_id,
      chunkInfo.chunk_index,
      windowBefore,
      windowAfter
    );

    // Build context
    const beforeContext = neighbors.before
      .map(c => c.content_clean)
      .join('\n\n');

    const afterContext = neighbors.after
      .map(c => c.content_clean)
      .join('\n\n');

    // Mark neighbor IDs as seen
    for (const n of [...neighbors.before, ...neighbors.after]) {
      seenIds.add(n.id);
    }

    // Create expanded chunk
    const expandedChunk = {
      ...chunk,
      context_before: truncateContext(beforeContext, maxContextLength / 2),
      context_after: truncateContext(afterContext, maxContextLength / 2),
      neighbor_ids: {
        before: neighbors.before.map(c => c.id),
        after: neighbors.after.map(c => c.id)
      },
      has_context: neighbors.before.length > 0 || neighbors.after.length > 0
    };

    expandedChunks.push(expandedChunk);
  }

  return expandedChunks;
}

/**
 * Get chunk sequence information
 */
function getChunkSequenceInfo(chunkId) {
  try {
    return ChunkRepo.getSequenceInfo(chunkId);
  } catch {
    return null;
  }
}

/**
 * Get neighboring chunks from the same document
 */
function getNeighborChunks(docId, chunkIndex, windowBefore, windowAfter) {
  const result = { before: [], after: [] };

  if (!docId || chunkIndex === undefined || chunkIndex === null) {
    return result;
  }

  try {
    if (windowBefore > 0) {
      result.before = ChunkRepo.getNeighborsBefore(docId, chunkIndex, windowBefore);
    }
    if (windowAfter > 0) {
      result.after = ChunkRepo.getNeighborsAfter(docId, chunkIndex, windowAfter);
    }
  } catch (error) {
    console.error('Error getting neighbor chunks:', error.message);
  }

  return result;
}

/**
 * Truncate context to max length at sentence boundary
 */
function truncateContext(text, maxLength) {
  if (!text || text.length <= maxLength) return text;

  // Try to cut at sentence boundary
  const truncated = text.slice(0, maxLength);
  const lastSentence = Math.max(
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('!\n'),
    truncated.lastIndexOf('?\n')
  );

  if (lastSentence > maxLength * 0.5) {
    return truncated.slice(0, lastSentence + 1);
  }

  // Fall back to word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Format expanded chunk for LLM context
 * @param {object} chunk - Expanded chunk
 * @returns {string} Formatted context string
 */
export function formatExpandedChunk(chunk) {
  const parts = [];

  if (chunk.context_before) {
    parts.push(`[Previous context]\n${chunk.context_before}`);
  }

  const mainContent = chunk.content || chunk.content_clean || chunk.chunk?.content || '';
  parts.push(`[Main content]\n${mainContent}`);

  if (chunk.context_after) {
    parts.push(`[Following context]\n${chunk.context_after}`);
  }

  return parts.join('\n\n');
}

/**
 * Build context string from expanded chunks
 * @param {Array} expandedChunks - Expanded chunks
 * @param {object} options - Options
 * @returns {string} Combined context
 */
export function buildExpandedContext(expandedChunks, options = {}) {
  const { includeNeighbors = true, maxTotalLength = 8000 } = options;

  const parts = [];
  let totalLength = 0;

  for (const chunk of expandedChunks) {
    let chunkText;

    if (includeNeighbors && chunk.has_context) {
      chunkText = formatExpandedChunk(chunk);
    } else {
      chunkText = chunk.content || chunk.content_clean || chunk.chunk?.content || '';
    }

    // Add source info
    const source = chunk.doc_title || chunk.chunk?.doc_title || 'Unknown';
    const header = `[Source: ${source}]`;

    const fullChunk = `${header}\n${chunkText}`;

    if (totalLength + fullChunk.length > maxTotalLength) {
      // Truncate last chunk to fit
      const remaining = maxTotalLength - totalLength - header.length - 10;
      if (remaining > 200) {
        parts.push(`${header}\n${chunkText.slice(0, remaining)}...`);
      }
      break;
    }

    parts.push(fullChunk);
    totalLength += fullChunk.length;
  }

  return parts.join('\n\n---\n\n');
}
