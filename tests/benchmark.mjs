/**
 * Benchmark harness — tracks node-first retrieval quality metrics.
 * Runs against a live server with an existing ingested dataset.
 *
 * Usage:
 *   node tests/benchmark.mjs [--dataset <id>] [--queries <file.json>]
 *
 * Default: uses the first dataset found, runs built-in test queries.
 *
 * Outputs:
 *   - Fallback rate (% of queries triggering direct search)
 *   - Rescue success rate (% of weak results rescued without full fallback)
 *   - Retrieval-only latency (ms)
 *   - Total latency (ms)
 *   - Node-first-only pass rate (queries where node-first was sufficient)
 *   - Top chunk provenance (% from hierarchical vs direct vs rescue)
 *   - General-node chunk percentage
 *   - Duplicate node count proxy
 */

const BASE = process.env.BENCHMARK_URL || 'http://localhost:3000';

// ── Built-in test queries (override with --queries <file.json>) ──────────

const DEFAULT_QUERIES = [
  // Fact-based
  { query: 'How many vacation days do employees get?', expect_type: 'simple_lookup' },
  { query: 'What is the probationary period?', expect_type: 'simple_lookup' },
  { query: 'What percentage of health insurance does the company cover?', expect_type: 'simple_lookup' },
  { query: 'How many days notice during probation?', expect_type: 'simple_lookup' },
  { query: 'What are the core collaboration hours?', expect_type: 'simple_lookup' },
  // Entity-scoped
  { query: 'Who is the CEO?', expect_type: 'simple_lookup' },
  { query: 'What products does the company offer?', expect_type: 'simple_lookup' },
  // Numeric
  { query: 'How many vacation days after 3 years?', expect_type: 'simple_lookup' },
  { query: 'What is the maximum carry-over days?', expect_type: 'simple_lookup' },
  // Broad
  { query: 'What are all the employee benefits?', expect_type: 'aggregation' },
  { query: 'Explain the remote work policy', expect_type: 'simple_lookup' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(path, options = {}) {
  const url = `${BASE}${path}`;
  const { headers: extraHeaders, ...restOptions } = options;
  const resp = await fetch(url, {
    ...restOptions,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} — ${url}`);
  return resp.json();
}

async function getFirstDataset() {
  const data = await fetchJson('/datasets');
  const datasets = data.datasets || data;
  if (!datasets?.length) throw new Error('No datasets found. Ingest a document first.');
  return datasets[0].id;
}

async function askQuery(query, datasetId) {
  const start = Date.now();
  const data = await fetchJson('/ask', {
    method: 'POST',
    headers: { 'X-Dataset-ID': datasetId },
    body: JSON.stringify({ query, trace: true })
  });
  const totalMs = Date.now() - start;
  return { ...data, _totalMs: totalMs };
}

async function getTreeStats(datasetId) {
  try {
    const data = await fetchJson('/tree', { headers: { 'X-Dataset-ID': datasetId } });
    return data;
  } catch {
    return null;
  }
}

async function getChunkStats(datasetId) {
  try {
    const data = await fetchJson('/stats', { headers: { 'X-Dataset-ID': datasetId } });
    return data;
  } catch {
    return null;
  }
}

// ── Metric extractors ────────────────────────────────────────────────────────

function extractMetrics(result) {
  const trace = result.trace?.steps || [];
  const meta = result.metadata || {};

  // Find the strategy step
  const strategyStep = trace.find(s => s.name === 'Strategy');
  const isNodeFirst = strategyStep?.description?.includes('node-first');

  // Find quality check
  const qualityCheck = trace.find(s => s.name === 'Quality Check');
  const wasWeak = qualityCheck?.description?.includes('WEAK');

  // Find rescue
  const rescueStep = trace.find(s => s.name === 'Rescue Expansion');
  const rescueAttempted = !!rescueStep;
  const rescueSucceeded = rescueStep?.description?.includes('skipping direct fallback');

  // Find direct fallback
  const fallbackStep = trace.find(s => s.name === 'Direct Chunk Fallback');
  const usedFallback = !!fallbackStep;

  // Retrieval source counts
  const sources = meta.retrieval_sources || {};

  // Confidence
  const confidence = result.confidence ?? null;

  // Top chunk provenance
  const chunks = result._debug?.chunks || [];
  const topChunkSource = chunks[0]?.retrieval_source?.[0] || 'unknown';

  return {
    isNodeFirst,
    wasWeak,
    rescueAttempted,
    rescueSucceeded,
    usedFallback,
    hierarchicalCount: sources.hierarchical || 0,
    directCount: sources.direct || 0,
    confidence,
    topChunkSource,
    totalMs: result._totalMs || 0,
    hasAnswer: !!(result.answer || result.llm_response?.final_answer || result.data?.final_answer)
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let datasetId = null;
  let queryFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dataset' && args[i + 1]) datasetId = args[++i];
    if (args[i] === '--queries' && args[i + 1]) queryFile = args[++i];
  }

  // Resolve dataset
  if (!datasetId) {
    try {
      datasetId = await getFirstDataset();
    } catch (err) {
      console.error('Could not find a dataset:', err.message);
      process.exit(1);
    }
  }
  console.log(`Dataset: ${datasetId}`);

  // Load queries
  let queries = DEFAULT_QUERIES;
  if (queryFile) {
    const { readFileSync } = await import('fs');
    queries = JSON.parse(readFileSync(queryFile, 'utf-8'));
  }
  console.log(`Queries: ${queries.length}\n`);

  // Run queries
  const results = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    process.stdout.write(`  [${i + 1}/${queries.length}] ${q.query.slice(0, 60)}...`);
    try {
      const result = await askQuery(q.query, datasetId);
      const metrics = extractMetrics(result);
      results.push({ query: q.query, ...metrics });
      const status = metrics.usedFallback ? 'FALLBACK' : metrics.rescueSucceeded ? 'RESCUE' : 'NODE-FIRST';
      process.stdout.write(` ${status} ${metrics.totalMs}ms conf=${(metrics.confidence ?? 0).toFixed(2)}\n`);
    } catch (err) {
      process.stdout.write(` ERROR: ${err.message}\n`);
      results.push({ query: q.query, error: err.message });
    }
  }

  // Compute summary
  const valid = results.filter(r => !r.error);
  const total = valid.length;
  if (total === 0) {
    console.log('\nNo successful queries. Check server connectivity.');
    process.exit(1);
  }

  const fallbacks = valid.filter(r => r.usedFallback).length;
  const rescueAttempts = valid.filter(r => r.rescueAttempted).length;
  const rescueSuccesses = valid.filter(r => r.rescueSucceeded).length;
  const nodeFirstOnly = valid.filter(r => !r.usedFallback && !r.rescueAttempted).length;
  const avgTotalMs = Math.round(valid.reduce((s, r) => s + r.totalMs, 0) / total);
  const avgConfidence = (valid.reduce((s, r) => s + (r.confidence ?? 0), 0) / total).toFixed(3);

  // Top chunk provenance
  const provenance = {};
  for (const r of valid) {
    provenance[r.topChunkSource] = (provenance[r.topChunkSource] || 0) + 1;
  }

  console.log('\n' + '='.repeat(60));
  console.log('BENCHMARK RESULTS');
  console.log('='.repeat(60));
  console.log(`Queries run:           ${total}`);
  console.log(`Fallback rate:         ${fallbacks}/${total} (${(fallbacks / total * 100).toFixed(1)}%)`);
  console.log(`Rescue attempts:       ${rescueAttempts}/${total}`);
  console.log(`Rescue success rate:   ${rescueSuccesses}/${Math.max(rescueAttempts, 1)} (${rescueAttempts > 0 ? (rescueSuccesses / rescueAttempts * 100).toFixed(1) : 'N/A'}%)`);
  console.log(`Node-first-only:       ${nodeFirstOnly}/${total} (${(nodeFirstOnly / total * 100).toFixed(1)}%)`);
  console.log(`Avg total latency:     ${avgTotalMs}ms`);
  console.log(`Avg confidence:        ${avgConfidence}`);
  console.log(`Top chunk provenance:  ${JSON.stringify(provenance)}`);

  // Tree stats
  try {
    const tree = await getTreeStats(datasetId);
    if (tree) {
      const nodes = tree.nodes || tree.tree || [];
      const allNodes = Array.isArray(nodes) ? nodes : [];
      console.log(`\nTree stats:`);
      console.log(`  Total nodes:         ${allNodes.length || tree.total_nodes || '?'}`);
    }
  } catch {}

  // DB stats
  try {
    const stats = await getChunkStats(datasetId);
    if (stats) {
      console.log(`\nIngestion stats:`);
      if (stats.total_chunks) console.log(`  Total chunks:        ${stats.total_chunks}`);
      if (stats.total_nodes) console.log(`  Total nodes:         ${stats.total_nodes}`);
    }
  } catch {}

  console.log('\n' + '='.repeat(60));

  // Return exit code based on fallback rate
  const fallbackPct = fallbacks / total * 100;
  if (fallbackPct > 50) {
    console.log(`WARNING: Fallback rate ${fallbackPct.toFixed(1)}% is above 50% target.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
