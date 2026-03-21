/**
 * DB-integrated tests — verify pipeline stages, schema migrations, and
 * repository read/write paths using an in-memory SQLite database.
 *
 * Run:  node --test tests/db-integration.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { setDefaultDb } from '../src/db/activeDb.js';
import { initDatasetDb } from '../src/db/initDatasetDb.js';
import { ChunkRepo } from '../src/db/repositories/ChunkRepo.js';
import { NodeRepo } from '../src/db/repositories/NodeRepo.js';
import { safeJson } from '../src/db/db.js';
import { stageEnrichNodeKeywords, stageComputeNodeQuality } from '../src/ingest/pipeline/stages.js';
import { getNode, getChildren } from '../src/kg/graphTraversal.js';
import { searchNodesByName } from '../src/kg/strategies/bm25.js';
import { rescueExpansion } from '../src/kg/hierarchicalRetrieval.js';
import { isNodeFirstResultWeak } from '../src/kg/queryHandlers.js';
import { calculateConfidence } from '../src/query/confidenceScorer.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

let conn;

before(() => {
  conn = new Database(':memory:');
  initDatasetDb(conn);
  setDefaultDb(conn);
});

after(() => {
  conn?.close();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Schema migration — new columns exist
// ═════════════════════════════════════════════════════════════════════════════

describe('schema migrations', () => {

  it('chunks table has assignment_confidence column', () => {
    const cols = conn.pragma('table_info(chunks)');
    const col = cols.find(c => c.name === 'assignment_confidence');
    assert.ok(col, 'assignment_confidence column should exist on chunks table');
    assert.equal(col.type, 'REAL', 'should be REAL type');
  });

  it('nodes table has quality_score column', () => {
    const cols = conn.pragma('table_info(nodes)');
    const col = cols.find(c => c.name === 'quality_score');
    assert.ok(col, 'quality_score column should exist on nodes table');
    assert.equal(col.type, 'REAL', 'should be REAL type');
  });

  it('assignment_confidence defaults to NULL', () => {
    conn.prepare(`INSERT INTO nodes (node_id, name, parent_id, level) VALUES ('test_ac_node', 'Test', NULL, 0)`).run();
    conn.prepare(`INSERT INTO chunks (content_clean, node_id, status) VALUES ('test content', 'test_ac_node', 'active')`).run();
    const row = conn.prepare('SELECT assignment_confidence FROM chunks ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.assignment_confidence, null, 'default should be NULL');
    // Cleanup
    conn.prepare("DELETE FROM chunks WHERE content_clean = 'test content'").run();
    conn.prepare("DELETE FROM nodes WHERE node_id = 'test_ac_node'").run();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. ChunkRepo — insertKP stores assignment_confidence
// ═════════════════════════════════════════════════════════════════════════════

describe('ChunkRepo.insertKP with assignment_confidence', () => {
  // ChunkRepo imported at top level

  before(() => {
    conn.prepare(`INSERT OR IGNORE INTO nodes (node_id, name, parent_id, level) VALUES ('repo_test_node', 'RepoTest', NULL, 0)`).run();
  });

  after(() => {
    conn.prepare("DELETE FROM chunks WHERE node_id = 'repo_test_node'").run();
    conn.prepare("DELETE FROM nodes WHERE node_id = 'repo_test_node'").run();
  });

  it('stores assignment_confidence when provided', () => {
    const result = ChunkRepo.insertKP({
      doc_title: 'Test Doc',
      content: 'Employees receive 15 days vacation.',
      chunk_type: 'fact',
      kp_type: 'fact',
      keywords: ['vacation'],
      fields: {},
      scope: {},
      authority_level: 'sop',
      source_excerpt: '',
      source_documents_json: '[]',
      nodeId: 'repo_test_node',
      documentId: null,
      index: 0,
      assignment_confidence: 0.75
    });
    const chunkId = Number(result.lastInsertRowid);
    const row = conn.prepare('SELECT assignment_confidence FROM chunks WHERE id = ?').get(chunkId);
    assert.equal(row.assignment_confidence, 0.75);
  });

  it('stores NULL when assignment_confidence not provided', () => {
    const result = ChunkRepo.insertKP({
      doc_title: 'Test Doc 2',
      content: 'Health insurance covers 85%.',
      chunk_type: 'fact',
      kp_type: 'fact',
      keywords: [],
      fields: {},
      scope: {},
      authority_level: 'sop',
      source_excerpt: '',
      source_documents_json: '[]',
      nodeId: 'repo_test_node',
      documentId: null,
      index: 1
    });
    const chunkId = Number(result.lastInsertRowid);
    const row = conn.prepare('SELECT assignment_confidence FROM chunks WHERE id = ?').get(chunkId);
    assert.equal(row.assignment_confidence, null);
  });

  it('getForNodeFull exposes assignment_confidence', () => {
    const chunks = ChunkRepo.getForNodeFull('repo_test_node', 10);
    assert.ok(chunks.length > 0, 'should have chunks');
    // At least one chunk should have 0.75
    const withConf = chunks.find(c => c.assignment_confidence === 0.75);
    assert.ok(withConf, 'getForNodeFull should return assignment_confidence');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. NodeRepo — updateQualityScore
// ═════════════════════════════════════════════════════════════════════════════

describe('NodeRepo.updateQualityScore', () => {
  // NodeRepo imported at top level

  before(() => {
    conn.prepare(`INSERT OR IGNORE INTO nodes (node_id, name, parent_id, level) VALUES ('qs_test', 'QualityTest', NULL, 0)`).run();
  });

  after(() => {
    conn.prepare("DELETE FROM nodes WHERE node_id = 'qs_test'").run();
  });

  it('stores and retrieves quality_score', () => {
    NodeRepo.updateQualityScore('qs_test', 0.85);
    const node = NodeRepo.findById('qs_test');
    assert.equal(node.quality_score, 0.85);
  });

  it('quality_score is NULL before being set', () => {
    conn.prepare(`INSERT INTO nodes (node_id, name, parent_id, level) VALUES ('qs_null', 'NullQuality', NULL, 0)`).run();
    const node = NodeRepo.findById('qs_null');
    assert.equal(node.quality_score, null);
    conn.prepare("DELETE FROM nodes WHERE node_id = 'qs_null'").run();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Pipeline stage wiring — stages exist and are in correct order
// ═════════════════════════════════════════════════════════════════════════════

describe('pipeline stage wiring', () => {

  it('STAGES array includes enrichKeywords and nodeQuality', () => {
    const indexPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/ingest/pipeline/index.js'
    );
    const source = readFileSync(indexPath, 'utf-8');

    // Check imports
    assert.ok(source.includes('stageEnrichNodeKeywords'), 'should import stageEnrichNodeKeywords');
    assert.ok(source.includes('stageComputeNodeQuality'), 'should import stageComputeNodeQuality');

    // Check STAGES array entries
    assert.ok(source.includes('"enrichKeywords"'), 'STAGES should include enrichKeywords stage');
    assert.ok(source.includes('"nodeQuality"'), 'STAGES should include nodeQuality stage');
  });

  it('enrichKeywords runs BEFORE reclassify in stage order', () => {
    const indexPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/ingest/pipeline/index.js'
    );
    const source = readFileSync(indexPath, 'utf-8');

    const enrichPos = source.indexOf('"enrichKeywords"');
    const qualityPos = source.indexOf('"nodeQuality"');
    const reclassifyPos = source.indexOf('"reclassify"');
    const canonicalizePos = source.indexOf('"canonicalize"');

    assert.ok(enrichPos < qualityPos, 'enrichKeywords should come before nodeQuality');
    assert.ok(qualityPos < reclassifyPos, 'nodeQuality should come before reclassify');
    assert.ok(reclassifyPos < canonicalizePos, 'reclassify should come before canonicalize');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. stageEnrichNodeKeywords — extracts keywords from chunks
// ═════════════════════════════════════════════════════════════════════════════

describe('stageEnrichNodeKeywords', () => {
  // stageEnrichNodeKeywords, NodeRepo, safeJson imported at top level

  before(() => {
    // Create a node with chunks containing extractable entities
    conn.prepare(`INSERT INTO nodes (node_id, name, parent_id, level, keywords_json) VALUES ('kw_node', 'Benefits', NULL, 0, '[]')`).run();
    // Rebuild FTS for node
    try { conn.prepare(`DELETE FROM nodes_fts WHERE node_id = 'kw_node'`).run(); } catch {}
    conn.prepare(`INSERT INTO nodes_fts (node_id, text) VALUES ('kw_node', 'Benefits')`).run();

    const chunks = [
      'Quantum Labs provides 15 days vacation and 85% health insurance coverage. The CEO Dr. James Harrington founded the company.',
      'Human Resources department manages PTO requests. SLA for HR tickets is 3 days. Employees get 20 days after 3 years of service.',
      'The CTO oversees QuantumVault security. Annual bonus is 500 USD for top performers. Remote Work Policy allows 3 days per week.'
    ];
    for (let i = 0; i < chunks.length; i++) {
      conn.prepare(`INSERT INTO chunks (content_clean, node_id, status, chunk_index) VALUES (?, 'kw_node', 'active', ?)`).run(chunks[i], i);
    }
  });

  after(() => {
    conn.prepare("DELETE FROM chunks WHERE node_id = 'kw_node'").run();
    conn.prepare("DELETE FROM nodes WHERE node_id = 'kw_node'").run();
    try { conn.prepare("DELETE FROM nodes_fts WHERE node_id = 'kw_node'").run(); } catch {}
  });

  it('extracts proper nouns, acronyms, and thresholds', async () => {
    const ctx = {
      documentId: 1,
      createdNodeIds: ['kw_node'],
      setStep: () => {}
    };

    await stageEnrichNodeKeywords(ctx);

    const node = NodeRepo.findById('kw_node');
    const keywords = safeJson(node.keywords_json, []);

    assert.ok(keywords.length > 0, `should have extracted keywords (got ${keywords.length})`);

    // Check for expected extractions
    const kwSet = new Set(keywords.map(k => k.toLowerCase()));
    assert.ok(kwSet.has('quantum labs') || kwSet.has('human resources') || kwSet.has('remote work'),
      `should extract multi-word proper nouns (got: ${keywords.join(', ')})`);
    assert.ok(kwSet.has('ceo') || kwSet.has('cto') || kwSet.has('pto') || kwSet.has('sla') || kwSet.has('hr'),
      `should extract acronyms (got: ${keywords.join(', ')})`);
    assert.ok(keywords.some(k => /\d/.test(k)),
      `should extract numeric thresholds (got: ${keywords.join(', ')})`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. stageComputeNodeQuality — writes quality_score
// ═════════════════════════════════════════════════════════════════════════════

describe('stageComputeNodeQuality', () => {
  // stageComputeNodeQuality, NodeRepo imported at top level

  before(() => {
    // Well-built node
    conn.prepare(`INSERT INTO nodes (node_id, name, parent_id, level, node_summary, aliases_json, keywords_json, node_description) VALUES ('q_good', 'Vacation Policy', NULL, 0, 'Covers paid time off, vacation days, carry-over limits and probation restrictions for all employees.', '["PTO","Leave","Time Off"]', '["vacation","days","carry-over"]', 'Employee vacation policies')`).run();
    for (let i = 0; i < 5; i++) {
      conn.prepare(`INSERT INTO chunks (content_clean, node_id, status) VALUES ('chunk ' || ?, 'q_good', 'active')`).run(i);
    }

    // Poor node
    conn.prepare(`INSERT INTO nodes (node_id, name, parent_id, level, node_summary, aliases_json, keywords_json) VALUES ('q_poor', 'Misc', NULL, 0, '', '[]', '[]')`).run();
    conn.prepare(`INSERT INTO chunks (content_clean, node_id, status) VALUES ('lonely chunk', 'q_poor', 'active')`).run();

    // General node
    conn.prepare(`INSERT INTO nodes (node_id, name, parent_id, level, node_summary, aliases_json, keywords_json) VALUES ('q_gen', 'General', NULL, 0, 'Contains miscellaneous information about the company and its policies.', '["default","misc","other"]', '["general","info","misc"]')`).run();
    for (let i = 0; i < 4; i++) {
      conn.prepare(`INSERT INTO chunks (content_clean, node_id, status) VALUES ('gen chunk ' || ?, 'q_gen', 'active')`).run(i);
    }
  });

  after(() => {
    for (const id of ['q_good', 'q_poor', 'q_gen']) {
      conn.prepare(`DELETE FROM chunks WHERE node_id = ?`).run(id);
      conn.prepare(`DELETE FROM nodes WHERE node_id = ?`).run(id);
    }
  });

  it('computes quality scores for new nodes', async () => {
    const ctx = {
      documentId: 1,
      createdNodeIds: ['q_good', 'q_poor', 'q_gen'],
      setStep: () => {}
    };

    await stageComputeNodeQuality(ctx);

    const good = NodeRepo.findById('q_good');
    const poor = NodeRepo.findById('q_poor');
    const gen = NodeRepo.findById('q_gen');

    assert.ok(good.quality_score !== null, 'good node should have quality_score');
    assert.ok(poor.quality_score !== null, 'poor node should have quality_score');
    assert.ok(gen.quality_score !== null, 'general node should have quality_score');

    assert.ok(good.quality_score > poor.quality_score,
      `good (${good.quality_score}) should outscore poor (${poor.quality_score})`);
    assert.ok(good.quality_score > gen.quality_score,
      `good (${good.quality_score}) should outscore General (${gen.quality_score})`);
    assert.ok(good.quality_score >= 0.8,
      `well-built node should score >=0.8 (got ${good.quality_score})`);
    assert.ok(poor.quality_score < 0.2,
      `poor node should score <0.2 (got ${poor.quality_score})`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Retrieval node objects include quality_score
// ═════════════════════════════════════════════════════════════════════════════

describe('retrieval node objects include quality_score', () => {

  before(() => {
    conn.prepare(`INSERT OR IGNORE INTO nodes (node_id, name, parent_id, level, quality_score, node_summary, aliases_json, keywords_json) VALUES ('ret_node', 'RetTest', NULL, 0, 0.72, 'Test summary', '[]', '[]')`).run();
    // FTS entry
    try { conn.prepare(`INSERT INTO nodes_fts (node_id, text) VALUES ('ret_node', 'RetTest Test summary')`).run(); } catch {}
  });

  after(() => {
    conn.prepare("DELETE FROM nodes WHERE node_id = 'ret_node'").run();
    try { conn.prepare("DELETE FROM nodes_fts WHERE node_id = 'ret_node'").run(); } catch {}
  });

  it('graphTraversal.getNode includes quality_score', () => {
    const node = getNode('ret_node');
    assert.ok(node, 'should find the node');
    assert.equal(node.quality_score, 0.72);
  });

  it('graphTraversal.getChildren includes quality_score', () => {
    conn.prepare(`INSERT INTO nodes (node_id, name, parent_id, level, quality_score) VALUES ('ret_child', 'Child', 'ret_node', 1, 0.55)`).run();
    const children = getChildren('ret_node');
    assert.ok(children.length > 0, 'should find children');
    assert.equal(children[0].quality_score, 0.55);
    conn.prepare("DELETE FROM nodes WHERE node_id = 'ret_child'").run();
  });

  it('bm25.searchNodesByName includes quality_score', () => {
    const results = searchNodesByName('RetTest', 5);
    const match = results.find(r => r.node_id === 'ret_node');
    assert.ok(match, 'should find node by name');
    assert.equal(match.quality_score, 0.72);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. rescueExpansion export verification
// ═════════════════════════════════════════════════════════════════════════════

describe('rescueExpansion', () => {
  it('is exported from hierarchicalRetrieval.js', () => {
    assert.equal(typeof rescueExpansion, 'function', 'rescueExpansion should be an exported function');
  });

  it('returns empty array when no seed nodes', async () => {
    const result = await rescueExpansion('test query', [], [], new Set());
    assert.deepEqual(result, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. isNodeFirstResultWeak behavioral tests (exported pure function)
// ═════════════════════════════════════════════════════════════════════════════

describe('isNodeFirstResultWeak (behavioral)', () => {

  it('is exported from queryHandlers.js', () => {
    assert.equal(typeof isNodeFirstResultWeak, 'function');
  });

  it('strong multi-node result is NOT weak', () => {
    const result = {
      chunks: [
        { id: 1, hierarchical_score: 0.8, doc_title: 'Employee Handbook', node_id: 'a' },
        { id: 2, hierarchical_score: 0.6, doc_title: 'Employee Handbook', node_id: 'b' },
        { id: 3, hierarchical_score: 0.5, doc_title: 'Employee Handbook', node_id: 'c' },
        { id: 4, hierarchical_score: 0.4, doc_title: 'Employee Handbook', node_id: 'd' }
      ],
      distinct_chunk_node_count: 4
    };
    assert.ok(!isNodeFirstResultWeak(result, 'how many vacation days do employees get'));
  });

  it('too few chunks triggers weak', () => {
    const result = {
      chunks: [{ id: 1, hierarchical_score: 0.9, node_id: 'a' }],
      distinct_chunk_node_count: 1
    };
    assert.ok(isNodeFirstResultWeak(result, 'test'));
  });

  it('single distinct node triggers weak', () => {
    const result = {
      chunks: [
        { id: 1, hierarchical_score: 0.9, node_id: 'a' },
        { id: 2, hierarchical_score: 0.8, node_id: 'a' },
        { id: 3, hierarchical_score: 0.7, node_id: 'a' }
      ],
      distinct_chunk_node_count: 1
    };
    assert.ok(isNodeFirstResultWeak(result, 'vacation'));
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
    assert.ok(isNodeFirstResultWeak(result, 'obscure query'));
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
    assert.ok(isNodeFirstResultWeak(result, 'quantum labs employee benefits'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. calculateConfidence behavioral tests
// ═════════════════════════════════════════════════════════════════════════════

describe('calculateConfidence (behavioral)', () => {

  it('is exported from confidenceScorer.js', () => {
    assert.equal(typeof calculateConfidence, 'function');
  });

  it('returns score, retrieval_confidence, and answer_groundedness', () => {
    const result = calculateConfidence({
      chunks: [
        { content_clean: 'Employees receive 15 days vacation.', authority_level: 'sop', node_id: 'a', relevance_score: 0.8 },
        { content_clean: 'After 3 years, vacation increases to 20 days.', authority_level: 'sop', node_id: 'a', relevance_score: 0.7 },
        { content_clean: 'Unused days may be carried over up to 5 days.', authority_level: 'sop', node_id: 'b', relevance_score: 0.6 }
      ],
      nodes: [{ node_id: 'a', name: 'Vacation' }],
      query: 'how many vacation days',
      answer: 'Employees receive 15 days of vacation. After 3 years, this increases to 20 days.',
      queryType: 'simple_lookup'
    });

    assert.ok('score' in result, 'should have score');
    assert.ok('retrieval_confidence' in result, 'should have retrieval_confidence');
    assert.ok('answer_groundedness' in result, 'should have answer_groundedness');
    assert.ok(result.score >= 0.05 && result.score <= 0.95, `score should be in [0.05, 0.95] (got ${result.score})`);
    assert.ok(result.retrieval_confidence >= 0.05, `retrieval_confidence should be >= 0.05 (got ${result.retrieval_confidence})`);
    assert.ok(result.answer_groundedness >= 0.05, `answer_groundedness should be >= 0.05 (got ${result.answer_groundedness})`);
  });

  it('fewer chunks produces lower retrieval confidence', () => {
    const makeChunks = (n) => Array.from({ length: n }, (_, i) => ({
      content_clean: `Chunk ${i} about vacation policy with 15 days.`,
      authority_level: 'sop',
      node_id: `node_${i % 3}`,
      relevance_score: 0.7
    }));

    const few = calculateConfidence({
      chunks: makeChunks(2),
      nodes: [{ node_id: 'node_0' }],
      query: 'vacation days',
      answer: 'Employees get 15 days vacation.',
      queryType: 'simple_lookup'
    });

    const many = calculateConfidence({
      chunks: makeChunks(8),
      nodes: [{ node_id: 'node_0' }, { node_id: 'node_1' }, { node_id: 'node_2' }],
      query: 'vacation days',
      answer: 'Employees get 15 days vacation.',
      queryType: 'simple_lookup'
    });

    assert.ok(many.retrieval_confidence >= few.retrieval_confidence,
      `more chunks (${many.retrieval_confidence}) should have >= retrieval conf than fewer (${few.retrieval_confidence})`);
  });

  it('answer with values not in sources gets lower groundedness', () => {
    const grounded = calculateConfidence({
      chunks: [
        { content_clean: 'Salary is $50,000 per year.', authority_level: 'sop', node_id: 'a', relevance_score: 0.8 }
      ],
      nodes: [{ node_id: 'a' }],
      query: 'what is the salary',
      answer: 'The salary is $50,000 per year.',
      queryType: 'simple_lookup'
    });

    const hallucinated = calculateConfidence({
      chunks: [
        { content_clean: 'Salary is $50,000 per year.', authority_level: 'sop', node_id: 'a', relevance_score: 0.8 }
      ],
      nodes: [{ node_id: 'a' }],
      query: 'what is the salary',
      answer: 'The salary is $75,000 per year with a $10,000 bonus and 25 vacation days.',
      queryType: 'simple_lookup'
    });

    assert.ok(grounded.answer_groundedness >= hallucinated.answer_groundedness,
      `grounded (${grounded.answer_groundedness}) should have >= groundedness than hallucinated (${hallucinated.answer_groundedness})`);
  });
});
