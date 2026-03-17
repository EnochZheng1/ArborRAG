/**
 * Confidence Calibration Module
 *
 * Provides nuanced confidence scoring based on multiple factors
 * Uses conservative estimates - it's better to underestimate confidence
 */

/**
 * Calculate calibrated confidence score
 * @param {object} context - Retrieval and answer context
 * @returns {object} Confidence details
 */
export function calculateConfidence(context) {
  const {
    chunks = [],
    nodes = [],
    query = '',
    answer = '',
    sources = [],
    queryType = 'simple_lookup'
  } = context;

  // If no chunks, confidence is very low
  if (!chunks || chunks.length === 0) {
    return {
      score: 0.1,
      level: 'very_low',
      factors: {},
      explanation: generateExplanation({}, 'very_low')
    };
  }

  const factors = {
    source_coverage: calculateSourceCoverage(chunks, query),
    source_agreement: calculateSourceAgreement(chunks),
    authority_score: calculateAuthorityScore(chunks),
    answer_grounding: calculateAnswerGrounding(answer, chunks),
    retrieval_quality: calculateRetrievalQuality(chunks, nodes),
    query_coverage: calculateQueryCoverage(query, chunks)
  };

  // Weights for different query types
  const weights = getWeightsForQueryType(queryType);

  // Calculate weighted score
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [factor, score] of Object.entries(factors)) {
    const weight = weights[factor] || 1;
    weightedSum += score * weight;
    totalWeight += weight;
  }

  let overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Apply mild linear scaling instead of sqrt dampening.
  // sqrt() was compressing ALL scores into a 0.5–0.7 band, making confidence
  // meaningless (a perfect answer scored only 0.07 higher than a poor one).
  // Linear scaling preserves the relative differences between good and bad answers.
  overallScore = overallScore * 0.92;

  // Query specificity adjustment (R8): specific fact queries with corroboration
  // deserve a slight boost; vague queries with few sources deserve a slight penalty.
  const isSpecificQuery = /^(?:what|who|when|where|which|how\s+(?:much|many|often|long))\s+(?:is|are|was|were|does|do|did|will)\b/i.test(query);
  const isVagueQuery = /^(?:tell\s+me\s+about|explain|describe|discuss|summarize|overview)/i.test(query);

  if (isSpecificQuery && chunks.length >= 2) {
    overallScore = Math.min(1.0, overallScore * 1.08); // Slight boost for fact queries with corroboration
  }
  if (isVagueQuery && chunks.length < 4) {
    overallScore *= 0.92; // Slight penalty for vague queries with few sources
  }

  // Recency factor (R9): blend source freshness into the score.
  // Newer sources are more likely to be current and accurate.
  const recencyFactor = calculateRecencyFactor(chunks);
  overallScore = overallScore * 0.85 + recencyFactor * 0.15;

  // Additional penalties
  // Penalty for few chunks
  if (chunks.length < 3) {
    overallScore *= 0.85;
  }
  // Penalty for single node
  if (nodes.length <= 1) {
    overallScore *= 0.9;
  }

  // Clamp to reasonable range — guard against NaN propagating into JSON as null
  overallScore = Number.isFinite(overallScore)
    ? Math.max(0.05, Math.min(0.95, overallScore))
    : 0.1;

  // Determine confidence level (with stricter thresholds)
  const level = getConfidenceLevel(overallScore);

  return {
    score: Math.round(overallScore * 100) / 100,
    level,
    factors,
    explanation: generateExplanation(factors, level)
  };
}

/**
 * Calculate how well sources cover the query
 */
function calculateSourceCoverage(chunks, query) {
  if (!chunks || chunks.length === 0) return 0;
  if (!query) return 0.2;

  // Extract query terms
  const queryTerms = extractTerms(query);
  if (queryTerms.length === 0) return 0.2;

  // Check how many terms appear in chunks
  const allContent = chunks
    .map(c => (c.content || c.content_clean || '').toLowerCase())
    .join(' ');

  let matchedTerms = 0;
  for (const term of queryTerms) {
    if (allContent.includes(term.toLowerCase())) {
      matchedTerms++;
    }
  }

  const coverage = matchedTerms / queryTerms.length;
  // Apply slight dampening - partial matches are common
  return coverage * 0.9;
}

/**
 * Calculate agreement between sources
 */
function calculateSourceAgreement(chunks) {
  // Single source = we can't verify, be conservative
  if (!chunks || chunks.length < 2) return 0.4;

  // Extract key facts from each chunk
  const chunkFacts = chunks.map(c => {
    const content = c.content || c.content_clean || '';
    return extractKeyPhrases(content);
  });

  // Check overlap between chunks
  let agreementCount = 0;
  let comparisonCount = 0;

  for (let i = 0; i < chunkFacts.length - 1; i++) {
    for (let j = i + 1; j < chunkFacts.length; j++) {
      comparisonCount++;
      const overlap = calculateOverlap(chunkFacts[i], chunkFacts[j]);
      if (overlap > 0.15) agreementCount++;
    }
  }

  if (comparisonCount === 0) return 0.3;

  // Higher agreement = higher confidence, but cap it
  const agreementRatio = agreementCount / comparisonCount;
  return 0.3 + agreementRatio * 0.5; // Max 0.8
}

/**
 * Calculate authority score based on source authority levels
 */
function calculateAuthorityScore(chunks) {
  if (!chunks || chunks.length === 0) return 0.2;

  let totalAuthority = 0;
  let count = 0;

  // authority_level is stored as TEXT ('policy','sop','training','personal').
  // Map to numeric scale 1=highest authority, 5=lowest.
  const AUTH_STRING_MAP = { policy: 1, sop: 2, training: 3, personal: 4 };

  for (const chunk of chunks) {
    const rawAuth = chunk.authority_level ?? chunk.chunk?.authority_level ?? 'sop';
    const strKey = String(rawAuth).toLowerCase();
    // Prefer string map; fall back to numeric parse; default to 2 (sop-level)
    const authority = AUTH_STRING_MAP[strKey]
      ?? (Number.isFinite(Number(rawAuth)) ? Number(rawAuth) : 2);
    // Authority levels: 1=highest, 5=lowest; 1 → score 0.80, 2 → 0.60, 3 → 0.40, 4 → 0.20
    const normalizedAuthority = (5 - authority) / 5;
    totalAuthority += normalizedAuthority;
    count++;
  }

  return count > 0 ? totalAuthority / count : 0.2;
}

/**
 * Calculate how well the answer is grounded in sources.
 * Combines term-level grounding with value-level alignment (numbers, dates,
 * percentages). If the answer quotes specific values not present in any source
 * chunk, confidence drops significantly.
 */
function calculateAnswerGrounding(answer, chunks) {
  if (!answer || !chunks || chunks.length === 0) return 0.2;

  const answerTerms = extractTerms(answer);
  if (answerTerms.length === 0) return 0.3;

  const allContent = chunks
    .map(c => (c.content || c.content_clean || '').toLowerCase())
    .join(' ');

  // Factor A: term-level grounding (0–0.5)
  let groundedTerms = 0;
  for (const term of answerTerms) {
    if (allContent.includes(term.toLowerCase())) {
      groundedTerms++;
    }
  }
  const termGrounding = (groundedTerms / answerTerms.length) * 0.5;

  // Factor B: value-level alignment (0–0.5)
  // Extract specific values (numbers with units, percentages, dates) from answer
  const answerValues = [];
  for (const m of answer.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(%|percent|days?|hours?|months?|years?|minutes?|weeks?)\b/gi)) {
    answerValues.push(m[0].toLowerCase().replace(/\s+/g, ' ').trim());
  }
  for (const m of answer.matchAll(/[$¥€£]\s?[\d,]+(?:\.\d+)?/g)) {
    answerValues.push(m[0].replace(/\s/g, ''));
  }
  for (const m of answer.matchAll(/\b\d{4}-\d{2}(?:-\d{2})?\b/g)) {
    answerValues.push(m[0]);
  }

  let valueGrounding;
  if (answerValues.length === 0) {
    // No specific values in answer — neutral (don't penalize qualitative answers)
    valueGrounding = 0.35;
  } else {
    // Check how many answer values appear in source content
    let foundValues = 0;
    for (const val of answerValues) {
      if (allContent.includes(val.toLowerCase())) foundValues++;
    }
    const ratio = foundValues / answerValues.length;
    // If answer quotes values not in sources, that's a hallucination signal
    valueGrounding = ratio * 0.5;
  }

  return Math.min(0.85, termGrounding + valueGrounding);
}

/**
 * Calculate retrieval quality
 */
function calculateRetrievalQuality(chunks, nodes) {
  let score = 0;

  // Factor 1: Number of chunks (more is generally better, up to a point)
  const chunkCount = chunks?.length || 0;
  if (chunkCount >= 10) score += 0.25;
  else if (chunkCount >= 5) score += 0.2;
  else if (chunkCount >= 3) score += 0.15;
  else if (chunkCount >= 1) score += 0.08;

  // Factor 2: Number of distinct nodes
  const nodeCount = nodes?.length || 0;
  if (nodeCount >= 3) score += 0.15;
  else if (nodeCount >= 2) score += 0.1;
  else if (nodeCount >= 1) score += 0.05;

  // Factor 3: Average retrieval score (don't use 0.5 default)
  if (chunks && chunks.length > 0) {
    const scoresWithValues = chunks
      .map(c => c.score || c.rerank_score)
      .filter(s => s !== undefined && s !== null);

    if (scoresWithValues.length > 0) {
      const avgScore = scoresWithValues.reduce((sum, s) => sum + s, 0) / scoresWithValues.length;
      // Normalize - retrieval scores are often 0-1 but can vary
      const normalizedAvg = Math.min(1, avgScore);
      score += normalizedAvg * 0.25;
    }
  }

  // Factor 4: Score consistency (low variance is good)
  if (chunks && chunks.length > 1) {
    const scores = chunks
      .map(c => c.score || c.rerank_score)
      .filter(s => s !== undefined && s !== null);

    if (scores.length > 1) {
      const variance = calculateVariance(scores);
      // Low variance (< 0.1) is good
      const consistencyBonus = Math.max(0, 0.15 - variance);
      score += consistencyBonus;
    }
  }

  return Math.min(0.8, score); // Cap at 0.8
}

/**
 * Calculate query coverage (how completely the query is addressed)
 */
function calculateQueryCoverage(query, chunks) {
  if (!query || !chunks || chunks.length === 0) return 0;

  // Detect question aspects
  const aspects = detectQueryAspects(query);

  if (aspects.length === 0) return 0.4;

  const allContent = chunks
    .map(c => (c.content || c.content_clean || '').toLowerCase())
    .join(' ');

  let coveredAspects = 0;
  for (const aspect of aspects) {
    if (allContent.includes(aspect.toLowerCase())) {
      coveredAspects++;
    }
  }

  const coverage = coveredAspects / aspects.length;
  return coverage * 0.85; // Slight dampening
}

/**
 * Get weights for different query types
 */
function getWeightsForQueryType(queryType) {
  const baseWeights = {
    source_coverage: 1.5,
    source_agreement: 1.2,
    authority_score: 1.0,
    answer_grounding: 1.3,
    retrieval_quality: 1.0,
    query_coverage: 1.2
  };

  switch (queryType) {
    case 'comparison':
      return { ...baseWeights, source_agreement: 0.8, query_coverage: 1.5 };
    case 'recommendation':
      return { ...baseWeights, authority_score: 1.5, source_coverage: 1.2 };
    case 'reasoning':
      return { ...baseWeights, source_agreement: 1.5, answer_grounding: 1.8 };
    case 'aggregation':
      return { ...baseWeights, source_coverage: 1.8, retrieval_quality: 1.3 };
    default:
      return baseWeights;
  }
}

/**
 * Get confidence level label (stricter thresholds)
 */
function getConfidenceLevel(score) {
  if (score >= 0.75) return 'high';
  if (score >= 0.55) return 'medium';
  if (score >= 0.35) return 'low';
  return 'very_low';
}

/**
 * Generate explanation for confidence score
 */
function generateExplanation(factors, level) {
  const issues = [];
  const strengths = [];

  if (factors.source_coverage !== undefined) {
    if (factors.source_coverage < 0.4) {
      issues.push('Limited source coverage for query terms');
    } else if (factors.source_coverage > 0.7) {
      strengths.push('Good coverage of query terms');
    }
  }

  if (factors.source_agreement !== undefined) {
    if (factors.source_agreement < 0.4) {
      issues.push('Single source or limited corroboration');
    } else if (factors.source_agreement > 0.6) {
      strengths.push('Multiple sources agree');
    }
  }

  if (factors.authority_score !== undefined) {
    if (factors.authority_score < 0.4) {
      issues.push('Sources have lower authority levels');
    } else if (factors.authority_score > 0.6) {
      strengths.push('High authority sources');
    }
  }

  if (factors.answer_grounding !== undefined) {
    if (factors.answer_grounding < 0.4) {
      issues.push('Answer may include information not fully supported by sources');
    }
  }

  if (factors.retrieval_quality !== undefined) {
    if (factors.retrieval_quality < 0.3) {
      issues.push('Limited relevant content found');
    }
  }

  return {
    issues,
    strengths,
    summary: level === 'high'
      ? 'Answer is well-supported by multiple reliable sources'
      : level === 'medium'
        ? 'Answer is reasonably supported but verify important details'
        : level === 'low'
          ? 'Limited sources found - answer may be incomplete'
          : 'Very few relevant sources - treat answer with caution'
  };
}

/**
 * Calculate recency factor based on chunk upload dates.
 * Newer sources are more likely to be current and accurate.
 * Decays to 0.75 over 2 years; defaults to 1 year old if no date available.
 */
function calculateRecencyFactor(chunks) {
  const now = Date.now();
  const avgAge = chunks.reduce((sum, c) => {
    const uploadedAt = c.uploaded_at ? new Date(c.uploaded_at).getTime() : (now - 365 * 86400000);
    return sum + (now - uploadedAt);
  }, 0) / (chunks.length || 1);
  const daysOld = avgAge / 86400000;
  return Math.max(0.75, 1 - (daysOld / 730)); // Decay to 0.75 over 2 years
}

// Helper functions

function extractTerms(text) {
  if (!text) return [];
  // Extract meaningful terms (2+ chars, not common words)
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'just', 'don', 'now', '的', '是', '在', '了', '和', '与', '或', '但', '如果', '那么', '这', '那', '什么', '怎么', '为什么', '哪', '谁', '多少', '吗', '呢', '吧', '啊', '哦', '嗯']);

  const words = text.toLowerCase().match(/[\u4e00-\u9fa5]+|[a-z]{2,}/gi) || [];
  return words.filter(w => !stopWords.has(w) && w.length >= 2);
}

function extractKeyPhrases(text) {
  if (!text) return [];
  // Extract noun phrases and key terms
  const phrases = text.match(/[\u4e00-\u9fa5]{2,8}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|[a-z]{4,}/gi) || [];
  return [...new Set(phrases.map(p => p.toLowerCase()))].slice(0, 20);
}

function calculateOverlap(set1, set2) {
  if (!set1 || !set2 || set1.length === 0 || set2.length === 0) return 0;
  const s1 = new Set(set1);
  const s2 = new Set(set2);
  let intersection = 0;
  for (const item of s1) {
    if (s2.has(item)) intersection++;
  }
  return intersection / Math.min(s1.size, s2.size);
}

function calculateVariance(numbers) {
  if (!numbers || numbers.length < 2) return 0;
  const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  const squaredDiffs = numbers.map(n => Math.pow(n - mean, 2));
  return squaredDiffs.reduce((a, b) => a + b, 0) / numbers.length;
}

function detectQueryAspects(query) {
  // Extract key nouns and concepts from query
  const aspects = [];

  // Chinese patterns
  const chineseNouns = query.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  aspects.push(...chineseNouns.filter(n => n.length >= 2));

  // English patterns
  const englishNouns = query.match(/[A-Z][a-z]+|[a-z]{4,}/g) || [];
  aspects.push(...englishNouns);

  return [...new Set(aspects)].slice(0, 10);
}

/**
 * Quick confidence estimate (for use during retrieval)
 * @param {Array} chunks - Retrieved chunks
 * @returns {number} Quick confidence score 0-1
 */
export function quickConfidence(chunks) {
  if (!chunks || chunks.length === 0) return 0.05;

  let score = 0;

  // Chunk count factor (conservative)
  score += Math.min(0.2, chunks.length * 0.03);

  // Average retrieval score
  const scoresWithValues = chunks
    .map(c => c.score)
    .filter(s => s !== undefined && s !== null);

  if (scoresWithValues.length > 0) {
    const avgScore = scoresWithValues.reduce((sum, s) => sum + s, 0) / scoresWithValues.length;
    score += Math.min(avgScore, 1) * 0.35;
  }

  // Authority factor
  const avgAuthority = chunks.reduce((sum, c) => {
    const auth = c.authority_level || 3;
    return sum + (5 - auth) / 5;
  }, 0) / chunks.length;
  score += avgAuthority * 0.25;

  // Apply dampening
  return Math.min(0.85, Math.sqrt(score) * 0.8);
}
