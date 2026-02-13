/**
 * Snippet Generation Utility
 *
 * Extracts relevant snippets from content and highlights matching terms
 */

/**
 * Tokenize text into words (supports Chinese and English)
 * @param {string} text - Text to tokenize
 * @returns {string[]} Array of tokens
 */
function tokenize(text) {
  if (!text) return [];

  // Split on whitespace and punctuation, keeping Chinese characters together
  // This regex splits on spaces, punctuation, but keeps Chinese character sequences
  const tokens = text
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(t => t.length > 0);

  // Also extract individual Chinese characters for matching
  const chineseChars = text.match(/[\u4e00-\u9fa5]+/g) || [];

  return [...new Set([...tokens, ...chineseChars])];
}

/**
 * Calculate relevance score for a text window
 * @param {string} window - Text window
 * @param {string[]} queryTerms - Query terms to match
 * @returns {number} Relevance score
 */
function scoreWindow(window, queryTerms) {
  const windowLower = window.toLowerCase();
  let score = 0;
  let matchedTerms = 0;

  for (const term of queryTerms) {
    if (windowLower.includes(term.toLowerCase())) {
      matchedTerms++;
      // Count occurrences
      const regex = new RegExp(escapeRegex(term), 'gi');
      const matches = windowLower.match(regex);
      score += matches ? matches.length : 0;
    }
  }

  // Bonus for matching multiple different terms
  score += matchedTerms * 2;

  return score;
}

/**
 * Escape special regex characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the best snippet window in content
 * @param {string} content - Full content
 * @param {string[]} queryTerms - Query terms
 * @param {number} windowSize - Desired snippet length
 * @returns {{start: number, end: number, score: number}}
 */
function findBestWindow(content, queryTerms, windowSize = 200) {
  if (!content || content.length <= windowSize) {
    return { start: 0, end: content?.length || 0, score: 0 };
  }

  let bestWindow = { start: 0, end: windowSize, score: 0 };

  // Find positions of all query term matches
  const matchPositions = [];
  for (const term of queryTerms) {
    const regex = new RegExp(escapeRegex(term), 'gi');
    let match;
    while ((match = regex.exec(content)) !== null) {
      matchPositions.push({
        pos: match.index,
        term: term,
        length: term.length
      });
    }
  }

  if (matchPositions.length === 0) {
    // No matches, return beginning
    return { start: 0, end: Math.min(windowSize, content.length), score: 0 };
  }

  // Sort by position
  matchPositions.sort((a, b) => a.pos - b.pos);

  // Slide window to find best position
  const step = Math.max(20, Math.floor(windowSize / 10));

  for (let start = 0; start < content.length - windowSize / 2; start += step) {
    const end = Math.min(start + windowSize, content.length);
    const window = content.slice(start, end);
    const score = scoreWindow(window, queryTerms);

    if (score > bestWindow.score) {
      bestWindow = { start, end, score };
    }
  }

  // Also check windows centered on each match
  for (const match of matchPositions) {
    const start = Math.max(0, match.pos - Math.floor(windowSize / 3));
    const end = Math.min(content.length, start + windowSize);
    const window = content.slice(start, end);
    const score = scoreWindow(window, queryTerms);

    if (score > bestWindow.score) {
      bestWindow = { start, end, score };
    }
  }

  return bestWindow;
}

/**
 * Adjust window to sentence/word boundaries
 * @param {string} content - Full content
 * @param {number} start - Window start
 * @param {number} end - Window end
 * @returns {{start: number, end: number}}
 */
function adjustToBoundaries(content, start, end) {
  // Adjust start to word/sentence boundary
  if (start > 0) {
    // Look for sentence boundary
    const sentenceStart = content.lastIndexOf('。', start);
    const sentenceStart2 = content.lastIndexOf('. ', start);
    const newlineStart = content.lastIndexOf('\n', start);

    const boundary = Math.max(sentenceStart, sentenceStart2, newlineStart);
    if (boundary > start - 50 && boundary > 0) {
      start = boundary + 1;
    } else {
      // At least adjust to word boundary
      const spacePos = content.lastIndexOf(' ', start);
      if (spacePos > start - 20 && spacePos > 0) {
        start = spacePos + 1;
      }
    }
  }

  // Adjust end to word/sentence boundary
  if (end < content.length) {
    // Look for sentence boundary
    const sentenceEnd = content.indexOf('。', end);
    const sentenceEnd2 = content.indexOf('. ', end);
    const newlineEnd = content.indexOf('\n', end);

    const boundaries = [sentenceEnd, sentenceEnd2, newlineEnd].filter(b => b > 0);
    const boundary = boundaries.length > 0 ? Math.min(...boundaries) : -1;

    if (boundary > 0 && boundary < end + 50) {
      end = boundary + 1;
    } else {
      // At least adjust to word boundary
      const spacePos = content.indexOf(' ', end);
      if (spacePos > 0 && spacePos < end + 20) {
        end = spacePos;
      }
    }
  }

  return { start: Math.max(0, start), end: Math.min(content.length, end) };
}

/**
 * Generate a snippet from content with highlighted terms
 * @param {string} content - Full content
 * @param {string} query - Search query
 * @param {object} options - Options
 * @returns {object} Snippet with metadata
 */
export function generateSnippet(content, query, options = {}) {
  const {
    maxLength = 200,
    highlightTag = 'mark',
    addEllipsis = true,
    minScore = 0
  } = options;

  if (!content || !query) {
    return {
      text: content?.slice(0, maxLength) || '',
      html: content?.slice(0, maxLength) || '',
      score: 0,
      matchCount: 0
    };
  }

  // Clean content
  const cleanContent = content.replace(/\s+/g, ' ').trim();

  // Extract query terms
  const queryTerms = tokenize(query).filter(t => t.length >= 2);

  if (queryTerms.length === 0) {
    const snippet = cleanContent.slice(0, maxLength);
    return {
      text: snippet + (cleanContent.length > maxLength ? '...' : ''),
      html: snippet + (cleanContent.length > maxLength ? '...' : ''),
      score: 0,
      matchCount: 0
    };
  }

  // Find best window
  const window = findBestWindow(cleanContent, queryTerms, maxLength);

  if (window.score < minScore) {
    // No good match, return beginning
    const snippet = cleanContent.slice(0, maxLength);
    return {
      text: snippet + (cleanContent.length > maxLength ? '...' : ''),
      html: snippet + (cleanContent.length > maxLength ? '...' : ''),
      score: 0,
      matchCount: 0
    };
  }

  // Adjust to boundaries
  const adjusted = adjustToBoundaries(cleanContent, window.start, window.end);

  // Extract snippet
  let snippetText = cleanContent.slice(adjusted.start, adjusted.end);

  // Add ellipsis
  const prefixEllipsis = addEllipsis && adjusted.start > 0 ? '...' : '';
  const suffixEllipsis = addEllipsis && adjusted.end < cleanContent.length ? '...' : '';

  snippetText = prefixEllipsis + snippetText.trim() + suffixEllipsis;

  // Create highlighted version
  let snippetHtml = snippetText;
  let matchCount = 0;

  for (const term of queryTerms) {
    const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
    const before = snippetHtml;
    snippetHtml = snippetHtml.replace(regex, `<${highlightTag}>$1</${highlightTag}>`);
    if (snippetHtml !== before) {
      matchCount++;
    }
  }

  return {
    text: snippetText,
    html: snippetHtml,
    score: window.score,
    matchCount,
    queryTerms
  };
}

/**
 * Generate snippets for multiple chunks
 * @param {Array} chunks - Chunks with content
 * @param {string} query - Search query
 * @param {object} options - Options
 * @returns {Array} Chunks with snippets added
 */
export function generateSnippetsForChunks(chunks, query, options = {}) {
  return chunks.map(chunk => {
    const content = chunk.content || chunk.content_clean || '';
    const snippet = generateSnippet(content, query, options);

    return {
      ...chunk,
      snippet: snippet.text,
      snippetHtml: snippet.html,
      snippetScore: snippet.score,
      matchCount: snippet.matchCount
    };
  });
}

/**
 * Generate a summary snippet for a node based on its chunks
 * @param {Array} chunks - Chunks belonging to node
 * @param {string} query - Search query
 * @param {object} options - Options
 * @returns {object} Best snippet from chunks
 */
export function generateNodeSnippet(chunks, query, options = {}) {
  if (!chunks || chunks.length === 0) {
    return { text: '', html: '', score: 0 };
  }

  // Generate snippets for all chunks
  const snippets = chunks.map(chunk => {
    const content = chunk.content || chunk.content_clean || '';
    return {
      ...generateSnippet(content, query, options),
      chunkId: chunk.id,
      docTitle: chunk.doc_title
    };
  });

  // Return the best one
  snippets.sort((a, b) => b.score - a.score);
  return snippets[0];
}

/**
 * Highlight terms in any text
 * @param {string} text - Text to highlight
 * @param {string[]} terms - Terms to highlight
 * @param {string} tag - HTML tag to use
 * @returns {string} Highlighted HTML
 */
export function highlightTerms(text, terms, tag = 'mark') {
  if (!text || !terms || terms.length === 0) return text;

  let result = text;
  for (const term of terms) {
    if (term.length < 2) continue;
    const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
    result = result.replace(regex, `<${tag}>$1</${tag}>`);
  }

  return result;
}

/**
 * Extract key sentences containing query terms
 * @param {string} content - Full content
 * @param {string} query - Search query
 * @param {number} maxSentences - Maximum sentences to return
 * @returns {string[]} Key sentences
 */
export function extractKeySentences(content, query, maxSentences = 3) {
  if (!content || !query) return [];

  // Split into sentences
  const sentences = content.split(/[。.!?！？\n]+/).filter(s => s.trim().length > 10);

  if (sentences.length === 0) return [];

  const queryTerms = tokenize(query).filter(t => t.length >= 2);

  // Score each sentence
  const scored = sentences.map(sentence => ({
    sentence: sentence.trim(),
    score: scoreWindow(sentence, queryTerms)
  }));

  // Sort by score and return top sentences
  scored.sort((a, b) => b.score - a.score);

  return scored
    .slice(0, maxSentences)
    .filter(s => s.score > 0)
    .map(s => s.sentence);
}
