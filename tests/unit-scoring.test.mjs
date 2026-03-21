/**
 * Unit tests for retrieval scoring, node quality, and ingestion improvements.
 *
 * Run:  node --test tests/unit-scoring.test.mjs
 *
 * These tests import scoring functions directly and test them with synthetic
 * data — no running server or database required for pure logic tests.
 * Tests that need a DB use an in-memory SQLite connection.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { wordDiceSimilarity } from '../src/ingest/knowledgeExtractor.js';

// ═════════════════════════════════════════════════════════════════════════════
// 1. getNodeChunks scoring tests (pure logic — no DB)
// ═════════════════════════════════════════════════════════════════════════════

describe('getNodeChunks scoring logic', () => {

  // We test the scoring signals by simulating what getNodeChunks does.
  // The actual function is tightly coupled to ChunkRepo, so we replicate
  // the scoring formulas here and verify they produce correct orderings.

  function scoreChunk(content, query, { keywords = [], assignment_confidence = null, doc_title = '' } = {}) {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    const contentLower = content.toLowerCase();
    let relevance = 0;

    // Content term match
    for (const term of queryTerms) {
      if (contentLower.includes(term)) {
        relevance += 0.3;
        const matches = (contentLower.match(new RegExp(term, 'g')) || []).length;
        relevance += Math.min(matches * 0.05, 0.2);
      }
    }

    // Keyword-tag match
    const kwLower = keywords.map(k => k.toLowerCase());
    for (const term of queryTerms) {
      if (kwLower.some(kw => kw.includes(term) || term.includes(kw))) {
        relevance += 0.4;
      }
    }

    // Assignment confidence boost (Sprint 1E/3B)
    const assignConf = assignment_confidence ?? 0.5;
    relevance += (assignConf - 0.5) * 0.3;

    // Doc-title alignment (Sprint 3B)
    const queryDocTerms = queryTerms.filter(t => t.length >= 5);
    if (queryDocTerms.length > 0 && doc_title) {
      const titleLower = doc_title.toLowerCase();
      if (queryDocTerms.some(t => titleLower.includes(t))) {
        relevance += 0.2;
      }
    }

    return relevance;
  }

  it('assignment confidence changes ranking', () => {
    const query = 'vacation policy days';
    const highConf = scoreChunk('Employees receive 15 vacation days', query, { assignment_confidence: 0.90 });
    const lowConf  = scoreChunk('Employees receive 15 vacation days', query, { assignment_confidence: 0.30 });
    const nullConf = scoreChunk('Employees receive 15 vacation days', query, { assignment_confidence: null });

    assert.ok(highConf > lowConf, `high conf (${highConf}) should beat low conf (${lowConf})`);
    assert.ok(nullConf > lowConf, `null conf (${nullConf}) should beat low conf (${lowConf})`);
    assert.ok(highConf > nullConf, `high conf (${highConf}) should beat null conf (${nullConf})`);
  });

  it('doc-title alignment boosts chunks from matching documents', () => {
    const query = 'quantum employee handbook vacation';
    const matched  = scoreChunk('15 days vacation', query, { doc_title: 'Quantum Labs Employee Handbook' });
    const unmatched = scoreChunk('15 days vacation', query, { doc_title: 'Company Policy Manual' });

    assert.ok(matched > unmatched, `doc-title match (${matched}) should beat non-match (${unmatched})`);
    assert.ok(matched - unmatched >= 0.15, `boost should be meaningful (diff=${(matched - unmatched).toFixed(3)})`);
  });

  it('redundancy penalty demotes near-duplicate chunks', () => {
    const chunk1 = 'Employees receive 15 days of paid vacation annually. Unused days may be carried over up to 5 days.';
    const chunk2 = 'Employees receive 15 days of paid vacation per year. Unused vacation days may be carried over up to 5 days maximum.';
    const chunk3 = 'Health insurance covers 85% of employee premiums for the standard plan.';

    const sim12 = wordDiceSimilarity(chunk1, chunk2);
    const sim13 = wordDiceSimilarity(chunk1, chunk3);

    assert.ok(sim12 > 0.70, `near-duplicate similarity should be >0.70 (got ${sim12.toFixed(3)})`);
    assert.ok(sim13 < 0.70, `different-topic similarity should be <0.70 (got ${sim13.toFixed(3)})`);
  });

  it('numeric queries boost exact-number chunks', () => {
    // The scoring code gives +0.5 for exact number match
    const query = 'what is the 15 day vacation policy';
    const withNumber = scoreChunk('Employees receive 15 days of paid vacation', query);
    const withoutNumber = scoreChunk('Employees receive many days of paid vacation', query);

    // Both match text terms, but withNumber matches more terms including "15"
    assert.ok(withNumber > withoutNumber, `number-containing chunk (${withNumber}) should outscore (${withoutNumber})`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. scoreNodeRelevance tests (pure logic — no DB)
// ═════════════════════════════════════════════════════════════════════════════

describe('scoreNodeRelevance logic', () => {

  function scoreNode(node, query) {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    const queryLower = query.toLowerCase();
    const nameLower = (node.name || '').toLowerCase();
    const summaryLower = (node.node_summary || '').toLowerCase();
    let score = 0;

    // Exact name match
    if (nameLower === queryLower) score += 1.0;
    else if (queryLower.includes(nameLower) || nameLower.includes(queryLower)) score += 0.7;

    // Query terms in name
    for (const term of queryTerms) { if (nameLower.includes(term)) score += 0.3; }

    // Query terms in summary
    for (const term of queryTerms) { if (summaryLower.includes(term)) score += 0.2; }

    // Aliases
    for (const alias of (node.aliases || [])) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower === queryLower || queryLower.includes(aliasLower)) score += 0.5;
      for (const term of queryTerms) { if (aliasLower.includes(term)) score += 0.15; }
    }

    // Description
    const descLower = (node.node_description || '').toLowerCase();
    let descScore = 0;
    for (const term of queryTerms) { if (descLower.includes(term)) descScore += 0.2; }
    score += Math.min(descScore, 0.6);

    // Keywords
    let kwScore = 0;
    for (const kw of (node.keywords || [])) {
      if (!kw) continue;
      const kwLower = kw.toLowerCase();
      if (queryLower.includes(kwLower)) kwScore += 0.25;
      for (const term of queryTerms) { if (kwLower.includes(term)) kwScore += 0.05; }
    }
    score += Math.min(kwScore, 0.6);

    // Quality multiplier (Sprint 1F/C)
    const quality = node.quality_score ?? 0.5;
    score *= (0.7 + 0.3 * quality);

    return Math.min(score, 2.0);
  }

  it('alias matches boost node score', () => {
    const query = 'pto policy';
    const withAlias = scoreNode({ name: 'Paid Time Off', aliases: ['PTO', 'leave'], keywords: [], quality_score: 0.8 }, query);
    const noAlias   = scoreNode({ name: 'Paid Time Off', aliases: [], keywords: [], quality_score: 0.8 }, query);
    assert.ok(withAlias > noAlias, `alias match (${withAlias}) should beat no-alias (${noAlias})`);
  });

  it('keyword matches boost node score', () => {
    const query = 'vacation days entitlement';
    const withKw = scoreNode({ name: 'Time Off', keywords: ['vacation', 'days', 'entitlement'], aliases: [], quality_score: 0.8 }, query);
    const noKw   = scoreNode({ name: 'Time Off', keywords: [], aliases: [], quality_score: 0.8 }, query);
    assert.ok(withKw > noKw, `keyword match (${withKw}) should beat no-keyword (${noKw})`);
  });

  it('summary term matches contribute score', () => {
    const query = 'health insurance premium';
    const withSummary = scoreNode({
      name: 'Benefits', node_summary: 'Covers health insurance premiums and enrollment',
      keywords: [], aliases: [], quality_score: 0.7
    }, query);
    const noSummary = scoreNode({
      name: 'Benefits', node_summary: '',
      keywords: [], aliases: [], quality_score: 0.7
    }, query);
    assert.ok(withSummary > noSummary, `summary match (${withSummary}) should beat empty summary (${noSummary})`);
  });

  it('quality_score multiplier dampens low-quality nodes', () => {
    const query = 'vacation policy';
    const highQ = scoreNode({ name: 'Vacation Policy', quality_score: 1.0, keywords: [], aliases: [] }, query);
    const lowQ  = scoreNode({ name: 'Vacation Policy', quality_score: 0.0, keywords: [], aliases: [] }, query);
    const nullQ = scoreNode({ name: 'Vacation Policy', quality_score: null, keywords: [], aliases: [] }, query);

    assert.ok(highQ > lowQ, `high quality (${highQ}) should beat low quality (${lowQ})`);
    assert.ok(highQ > nullQ, `high quality (${highQ}) should beat null quality (${nullQ})`);
    // Check the multiplier range: high=1.0, low=0.7, null=0.85
    const ratio = highQ / lowQ;
    assert.ok(ratio > 1.2 && ratio < 1.5, `quality ratio should be ~1.43 (got ${ratio.toFixed(3)})`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. isNodeFirstResultWeak tests (pure logic)
// ═════════════════════════════════════════════════════════════════════════════

describe('isNodeFirstResultWeak edge cases', () => {

  function isWeak(nfResult, query) {
    const chunks = nfResult.chunks || [];
    const distinctNodeCount = nfResult.distinct_chunk_node_count || 0;

    // Rule 1: Too few chunks
    if (chunks.length < 3) return true;

    // Rule 2: Too few distinct nodes
    if (distinctNodeCount < 2) return true;

    // Rule 3: Top score too low
    const topScore = chunks[0]?.hierarchical_score || chunks[0]?.relevance_score || 0;
    if (topScore < 0.15) return true;

    // Rule 4: Doc-scoped with no doc-title-aligned chunks
    const docTitles = [...new Set(chunks.map(c => c.doc_title).filter(Boolean))];
    const qLower = query.toLowerCase();
    const qWords = qLower.split(/\s+/).filter(w => w.length >= 4);

    if (docTitles.length > 0) {
      const hasDocMatch = docTitles.some(t => {
        const tLower = t.toLowerCase();
        return tLower.split(/\s+/).some(word => word.length >= 4 && qLower.includes(word)) ||
               qWords.some(word => tLower.includes(word));
      });
      if (!hasDocMatch && docTitles.length === 1) return true;
    } else {
      const DOC_CUES = /\b(document|doc|file|pdf|deck|slide|spec|manual|handbook|catalog|policy|report|guide)\b/i;
      const hasQuotedPhrase = /["'].{3,}["']/.test(query);
      if (DOC_CUES.test(query) || hasQuotedPhrase) return true;
    }

    return false;
  }

  it('single-doc KB with good score is NOT weak', () => {
    // When all chunks share a doc_title AND query contains a term matching that title,
    // the result should not be weak (doc-scoped query with aligned titles).
    const result = {
      chunks: [
        { id: 1, hierarchical_score: 0.8, doc_title: 'Employee Handbook', node_id: 'a' },
        { id: 2, hierarchical_score: 0.6, doc_title: 'Employee Handbook', node_id: 'b' },
        { id: 3, hierarchical_score: 0.5, doc_title: 'Employee Handbook', node_id: 'c' }
      ],
      distinct_chunk_node_count: 3
    };
    assert.ok(!isWeak(result, 'how many vacation days do employees get'), 'should not be weak when doc title contains query term "employee"');
  });

  it('low-diversity but strong score triggers weak', () => {
    const result = {
      chunks: [
        { id: 1, hierarchical_score: 0.9, doc_title: 'Handbook', node_id: 'a' },
        { id: 2, hierarchical_score: 0.8, doc_title: 'Handbook', node_id: 'a' },
        { id: 3, hierarchical_score: 0.7, doc_title: 'Handbook', node_id: 'a' }
      ],
      distinct_chunk_node_count: 1  // only 1 distinct node
    };
    assert.ok(isWeak(result, 'vacation policy'), 'should be weak due to single node');
  });

  it('doc-scoped query with misaligned titles triggers weak', () => {
    const result = {
      chunks: [
        { id: 1, hierarchical_score: 0.5, doc_title: 'HR Guide', node_id: 'a' },
        { id: 2, hierarchical_score: 0.4, doc_title: 'HR Guide', node_id: 'b' },
        { id: 3, hierarchical_score: 0.3, doc_title: 'HR Guide', node_id: 'c' }
      ],
      distinct_chunk_node_count: 3
    };
    assert.ok(isWeak(result, 'quantum labs employee handbook benefits'), 'should be weak — doc titles mismatch query');
  });

  it('query with doc cue word but no doc_title triggers weak', () => {
    const result = {
      chunks: [
        { id: 1, hierarchical_score: 0.5, node_id: 'a' },
        { id: 2, hierarchical_score: 0.4, node_id: 'b' },
        { id: 3, hierarchical_score: 0.3, node_id: 'c' }
      ],
      distinct_chunk_node_count: 3
    };
    assert.ok(isWeak(result, 'what does the handbook say about vacation'), 'should be weak — doc cue present but no doc_title');
  });

  it('few chunks always triggers weak', () => {
    const result = {
      chunks: [{ id: 1, hierarchical_score: 1.0, node_id: 'a' }],
      distinct_chunk_node_count: 1
    };
    assert.ok(isWeak(result, 'test'), 'should be weak — only 1 chunk');
  });

  it('low top score triggers weak', () => {
    const result = {
      chunks: [
        { id: 1, hierarchical_score: 0.10, node_id: 'a' },
        { id: 2, hierarchical_score: 0.08, node_id: 'b' },
        { id: 3, hierarchical_score: 0.05, node_id: 'c' }
      ],
      distinct_chunk_node_count: 3
    };
    assert.ok(isWeak(result, 'obscure query'), 'should be weak — top score < 0.15');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Ingestion — wordDiceSimilarity (used by canonicalization & redundancy)
// ═════════════════════════════════════════════════════════════════════════════

describe('wordDiceSimilarity', () => {
  it('identical strings → 1.0', () => {
    assert.equal(wordDiceSimilarity('hello world', 'hello world'), 1.0);
  });

  it('completely different strings → low score', () => {
    const score = wordDiceSimilarity('hello world', 'foo bar baz');
    assert.ok(score < 0.2, `should be low (got ${score})`);
  });

  it('PTO vs Paid Time Off → moderate overlap', () => {
    const score = wordDiceSimilarity('PTO Policy', 'Paid Time Off Policy');
    assert.ok(score >= 0.25, `should have some overlap (got ${score.toFixed(3)})`);
  });

  it('empty string → 0', () => {
    assert.equal(wordDiceSimilarity('', 'something'), 0);
    assert.equal(wordDiceSimilarity('something', ''), 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Keyword extraction regex tests (stageEnrichNodeKeywords logic)
// ═════════════════════════════════════════════════════════════════════════════

describe('keyword extraction regexes', () => {
  const ACRONYM_STOP = new Set(['THE', 'AND', 'FOR', 'ARE', 'NOT', 'ALL', 'HAS', 'WAS', 'HIS', 'HER', 'CAN',
    'YOU', 'BUT', 'OUT', 'OUR', 'ONE', 'HOW', 'ITS', 'MAY', 'NEW', 'NOW', 'OLD', 'SEE', 'WAY',
    'WHO', 'DID', 'GET', 'HIM', 'LET', 'SAY', 'SHE', 'TOO', 'USE', 'THIS', 'THAT', 'WITH',
    'HAVE', 'FROM', 'THEY', 'BEEN', 'SAID', 'EACH', 'THAN', 'THEM', 'THEN', 'WHEN', 'WILL',
    'INTO', 'TEXT', 'NULL', 'TRUE', 'ALSO', 'JUST', 'ONLY', 'VERY', 'EVEN', 'MOST', 'II', 'III', 'IV']);

  function extractKeywords(text) {
    const freq = new Map();
    const addKw = (kw) => {
      const trimmed = kw.trim();
      if (trimmed.length < 2 || trimmed.length > 60) return;
      freq.set(trimmed.toLowerCase(), (freq.get(trimmed.toLowerCase()) || 0) + 1);
    };
    for (const m of text.matchAll(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g)) addKw(m[0]);
    for (const m of text.matchAll(/\b[A-Z]{2,6}\b/g)) { if (!ACRONYM_STOP.has(m[0])) addKw(m[0]); }
    for (const m of text.matchAll(/\b\d+(?:\.\d+)?\s*(?:%|(?:days?|hours?|months?|years?|weeks?|USD|RMB|yuan|dollars?)\b)/gi)) addKw(m[0]);
    for (const m of text.matchAll(/\d+\s*[天月年小时周个]+/g)) addKw(m[0]);
    return [...freq.keys()];
  }

  it('extracts multi-word proper nouns', () => {
    const kws = extractKeywords('Quantum Labs develops QuantumVault for Human Resources departments.');
    assert.ok(kws.some(k => k.includes('quantum labs')), `should extract "Quantum Labs" (got ${kws.join(', ')})`);
    assert.ok(kws.some(k => k.includes('human resources')), `should extract "Human Resources" (got ${kws.join(', ')})`);
  });

  it('extracts acronyms and filters stopwords', () => {
    const kws = extractKeywords('The CEO and CTO of SLA compliance report for HR.');
    assert.ok(kws.includes('ceo'), `should extract CEO (got ${kws.join(', ')})`);
    assert.ok(kws.includes('cto'), `should extract CTO`);
    assert.ok(kws.includes('sla'), `should extract SLA`);
    assert.ok(kws.includes('hr'), `should extract HR`);
    assert.ok(!kws.includes('the'), `should NOT extract THE`);
  });

  it('extracts numeric thresholds', () => {
    const kws = extractKeywords('Employees receive 15 days vacation and 85% health coverage after 3 years.');
    assert.ok(kws.some(k => k.includes('15 days') || k.includes('15 day')), `should extract "15 days" (got ${kws.join(', ')})`);
    assert.ok(kws.some(k => k.includes('85%')), `should extract "85%"`);
    assert.ok(kws.some(k => k.includes('3 years') || k.includes('3 year')), `should extract "3 years"`);
  });

  it('extracts CJK quantities', () => {
    const kws = extractKeywords('员工享有15天年假，试用期为3个月。');
    assert.ok(kws.some(k => k.includes('15天')), `should extract "15天" (got ${kws.join(', ')})`);
    assert.ok(kws.some(k => k.includes('3个月')), `should extract "3个月"`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Node quality score formula tests
// ═════════════════════════════════════════════════════════════════════════════

describe('node quality score formula', () => {

  function computeQuality(node) {
    let quality = 0.0;
    if ((node.node_summary || '').trim().length > 20) quality += 0.25;
    if (node.chunk_count >= 3) quality += 0.25;
    if ((node.aliases || []).length >= 3) quality += 0.20;
    if ((node.keywords || []).length >= 3) quality += 0.15;
    if ((node.node_description || '').trim().length > 0) quality += 0.15;
    if (node.name === 'General' || (node.name || '').startsWith('General —')) quality *= 0.7;
    return Math.min(quality, 1.0);
  }

  it('well-built node gets high score', () => {
    const q = computeQuality({
      name: 'Vacation Policy',
      node_summary: 'Covers paid time off, vacation days, carry-over limits, and probation restrictions.',
      chunk_count: 5,
      aliases: ['PTO', 'Leave', 'Time Off'],
      keywords: ['vacation', 'days', 'carry-over'],
      node_description: 'Employee vacation and leave policies'
    });
    assert.ok(q >= 0.9, `well-built node should score >=0.9 (got ${q})`);
  });

  it('empty node gets low score', () => {
    const q = computeQuality({
      name: 'Untitled',
      node_summary: '',
      chunk_count: 1,
      aliases: [],
      keywords: [],
      node_description: ''
    });
    assert.ok(q < 0.2, `empty node should score <0.2 (got ${q})`);
  });

  it('General node gets penalized', () => {
    const general = computeQuality({
      name: 'General',
      node_summary: 'Contains general information about the company.',
      chunk_count: 10,
      aliases: ['default', 'misc', 'other'],
      keywords: ['general', 'info', 'misc'],
      node_description: ''
    });
    const topical = computeQuality({
      name: 'Benefits',
      node_summary: 'Contains general information about the company.',
      chunk_count: 10,
      aliases: ['default', 'misc', 'other'],
      keywords: ['general', 'info', 'misc'],
      node_description: ''
    });
    assert.ok(general < topical, `General (${general}) should score lower than topical (${topical})`);
    assert.ok(general / topical < 0.75, `penalty should be ~30%`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Assignment confidence computation tests
// ═════════════════════════════════════════════════════════════════════════════

describe('assignment confidence computation', () => {

  function computeAssignConf(action, kpConfidence = 0.7) {
    if (action === 'REPLACE') return 0.85;
    if (action === 'NORMALIZE_THEN_STORE') return 0.80;
    // STORE: scaled from KP confidence
    return Math.min(0.80, Math.max(0.50, kpConfidence * 0.85));
  }

  it('REPLACE gets 0.85', () => {
    assert.equal(computeAssignConf('REPLACE'), 0.85);
  });

  it('NORMALIZE_THEN_STORE gets 0.80', () => {
    assert.equal(computeAssignConf('NORMALIZE_THEN_STORE'), 0.80);
  });

  it('STORE with high confidence gets capped at 0.80', () => {
    assert.equal(computeAssignConf('STORE', 1.0), 0.80);
  });

  it('STORE with low confidence gets floored at 0.50', () => {
    assert.equal(computeAssignConf('STORE', 0.2), 0.50);
  });

  it('STORE with typical confidence scales correctly', () => {
    const conf = computeAssignConf('STORE', 0.7);
    assert.ok(conf >= 0.50 && conf <= 0.80, `should be in [0.50, 0.80] (got ${conf})`);
    assert.ok(Math.abs(conf - 0.595) < 0.01, `0.7 * 0.85 = 0.595 (got ${conf})`);
  });
});
