/**
 * Benchmark harness — tracks node-first retrieval quality metrics.
 *
 * Usage:
 *   node tests/benchmark.mjs [--dataset <id>] [--queries <file.json>] [--all]
 *
 * Outputs JSON report to tests/benchmark-results.json with:
 *   - Per-query: retrieval_path, confidence, timing, answer assertions
 *   - Summary: fallback rate, rescue rate, latency, provenance
 *   - Ingest metrics: node count, General %, quality scores
 *   - Metadata: git commit, config snapshot, timestamp
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BENCHMARK_URL || 'http://localhost:3000';
const BENCHMARK_VERSION = 2;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson(urlPath, options = {}) {
  const url = `${BASE}${urlPath}`;
  const { headers: extraHeaders, ...restOptions } = options;
  const resp = await fetch(url, {
    ...restOptions,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} — ${url}`);
  return resp.json();
}

async function getAllDatasets() {
  const data = await fetchJson('/datasets');
  const datasets = data.datasets || data;
  if (!datasets?.length) throw new Error('No datasets found. Ingest a document first.');
  return datasets;
}

async function askQuery(query, datasetId) {
  const start = Date.now();
  const data = await fetchJson('/ask', {
    method: 'POST',
    headers: { 'X-Dataset-ID': datasetId },
    body: JSON.stringify({ query, trace: true })
  });
  const clientTotalMs = Date.now() - start;
  return { ...data, _clientTotalMs: clientTotalMs };
}

function getGitCommit() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return 'unknown'; }
}

function loadQuerySet(queryFile) {
  const defaultPath = path.join(__dirname, 'query-sets', 'default.json');
  const filePath = queryFile || defaultPath;
  if (!existsSync(filePath)) throw new Error(`Query set not found: ${filePath}`);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// ── Metric extraction ────────────────────────────────────────────────────────

function extractMetrics(result, querySpec) {
  const trace = result.trace?.steps || [];
  const timing = result.timing || {};

  // Use explicit server-side fields when available, fall back to trace parsing
  const usedFallback = result.fallback_used ?? !!result.message;
  const rescueUsed = result.rescue_used ?? false;
  const retrieval_path = result.retrieval_path
    ?? (usedFallback ? 'node_first_plus_fallback'
      : rescueUsed ? 'node_first_plus_rescue'
      : 'node_first_only');

  // Strategy (from trace, for display only)
  const strategyStep = trace.find(s => s.name === 'Strategy');
  const isNodeFirst = strategyStep?.description?.includes('node-first');

  // Quality check
  const qualityCheck = trace.find(s => s.name === 'Quality Check');
  const wasWeak = qualityCheck?.description?.includes('WEAK');

  // Rescue details from trace (for rescue attempt tracking)
  const rescueStep = trace.find(s => s.name === 'Rescue Expansion');
  const rescueAttempted = !!rescueStep;

  // Confidence
  const confidence = result.confidence ?? null;
  const retrieval_confidence = result.retrieval_confidence ?? null;
  const answer_groundedness = result.answer_groundedness ?? null;

  // Source counts
  const sources = result.retrieval_sources || {};

  // Answer text
  const answer = result.llm_response?.final_answer || result.data?.final_answer || '';

  // Answer assertion (expect_any)
  let answerPass = null;
  let answerMatchedFragment = null;
  if (querySpec?.expect_any?.length > 0) {
    const answerLower = answer.toLowerCase();
    for (const frag of querySpec.expect_any) {
      if (answerLower.includes(frag.toLowerCase())) {
        answerPass = true;
        answerMatchedFragment = frag;
        break;
      }
    }
    if (answerPass === null) answerPass = false;
  }

  return {
    retrieval_path,
    isNodeFirst,
    wasWeak,
    rescueAttempted,
    rescueUsed,
    usedFallback,
    confidence,
    retrieval_confidence,
    answer_groundedness,
    hierarchicalCount: sources.hierarchical || 0,
    directCount: sources.direct || 0,
    chunks_used: result.chunks_used || 0,
    retrieval_ms: timing.retrieval_ms ?? null,
    llm_ms: timing.llm_ms ?? null,
    total_ms: timing.total_ms ?? result._clientTotalMs ?? 0,
    answerPass,
    answerMatchedFragment,
    answerPreview: answer.slice(0, 120)
  };
}

// ── Dataset info ─────────────────────────────────────────────────────────────

async function getDatasetInfo(datasetId) {
  const info = { dataset_id: datasetId };
  try {
    const datasets = await getAllDatasets();
    const ds = datasets.find(d => d.id === datasetId);
    if (ds) info.dataset_name = ds.name;
  } catch {}

  // Try to get config (retrieval_strategy, tree_routing_mode)
  try {
    const schema = await fetchJson('/schema/settings', { headers: { 'X-Dataset-ID': datasetId } });
    info.retrieval_strategy = schema.retrieval_strategy || 'node_first';
    info.tree_routing_mode = schema.tree_routing_mode || 'keyword';
  } catch {
    info.retrieval_strategy = 'unknown';
    info.tree_routing_mode = 'unknown';
  }

  return info;
}

// ── Run benchmark for one dataset ────────────────────────────────────────────

async function runBenchmark(datasetId, queries) {
  const dsInfo = await getDatasetInfo(datasetId);
  console.log(`\nDataset: ${dsInfo.dataset_name || datasetId} (${datasetId})`);
  console.log(`  Strategy: ${dsInfo.retrieval_strategy}, Routing: ${dsInfo.tree_routing_mode}`);
  console.log(`  Queries: ${queries.length}\n`);

  const results = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    process.stdout.write(`  [${i + 1}/${queries.length}] ${q.query.slice(0, 55).padEnd(55)}  `);
    try {
      const result = await askQuery(q.query, datasetId);
      const metrics = extractMetrics(result, q);
      results.push({ query: q.query, type: q.type || 'unknown', ...metrics });

      const pathLabel = { node_first_only: 'NF', node_first_plus_rescue: 'RESCUE', node_first_plus_fallback: 'FALLBACK' };
      const passLabel = metrics.answerPass === true ? 'PASS' : metrics.answerPass === false ? 'FAIL' : '----';
      const retMs = metrics.retrieval_ms !== null ? `ret=${metrics.retrieval_ms}ms` : '';
      process.stdout.write(`${pathLabel[metrics.retrieval_path] || '??'}  conf=${(metrics.confidence ?? 0).toFixed(2)}  ${retMs}  ${passLabel}\n`);
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      results.push({ query: q.query, type: q.type || 'unknown', error: err.message });
    }
  }

  // Summary
  const valid = results.filter(r => !r.error);
  const total = valid.length;
  if (total === 0) return { dsInfo, results, summary: null };

  const fallbacks = valid.filter(r => r.usedFallback).length;
  const rescueAttempts = valid.filter(r => r.rescueAttempted).length;
  const rescueSuccesses = valid.filter(r => r.rescueUsed).length;
  const nodeFirstOnly = valid.filter(r => r.retrieval_path === 'node_first_only').length;
  const assertable = valid.filter(r => r.answerPass !== null);
  const passed = assertable.filter(r => r.answerPass).length;

  const avgConf = (valid.reduce((s, r) => s + (r.confidence ?? 0), 0) / total);
  const avgTotalMs = Math.round(valid.reduce((s, r) => s + r.total_ms, 0) / total);
  const retrieval_ms_values = valid.filter(r => r.retrieval_ms !== null).map(r => r.retrieval_ms);
  const avgRetrievalMs = retrieval_ms_values.length > 0
    ? Math.round(retrieval_ms_values.reduce((s, v) => s + v, 0) / retrieval_ms_values.length)
    : null;

  // Retrieval path distribution
  const pathCounts = {};
  for (const r of valid) pathCounts[r.retrieval_path] = (pathCounts[r.retrieval_path] || 0) + 1;

  const summary = {
    total_queries: total,
    fallback_rate: `${fallbacks}/${total} (${(fallbacks / total * 100).toFixed(1)}%)`,
    rescue_attempts: rescueAttempts,
    rescue_successes: rescueSuccesses,
    node_first_only: `${nodeFirstOnly}/${total} (${(nodeFirstOnly / total * 100).toFixed(1)}%)`,
    answer_pass_rate: assertable.length > 0 ? `${passed}/${assertable.length} (${(passed / assertable.length * 100).toFixed(1)}%)` : 'N/A',
    avg_confidence: Number(avgConf.toFixed(3)),
    avg_total_ms: avgTotalMs,
    avg_retrieval_ms: avgRetrievalMs,
    retrieval_path_distribution: pathCounts
  };

  // Print summary
  console.log('\n  ' + '-'.repeat(50));
  console.log(`  Fallback rate:       ${summary.fallback_rate}`);
  console.log(`  Node-first-only:     ${summary.node_first_only}`);
  console.log(`  Answer pass rate:    ${summary.answer_pass_rate}`);
  console.log(`  Avg confidence:      ${summary.avg_confidence}`);
  console.log(`  Avg total latency:   ${summary.avg_total_ms}ms`);
  if (summary.avg_retrieval_ms !== null) {
    console.log(`  Avg retrieval only:  ${summary.avg_retrieval_ms}ms`);
  }
  console.log(`  Path distribution:   ${JSON.stringify(summary.retrieval_path_distribution)}`);

  return { dsInfo, results, summary };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let datasetId = null;
  let queryFile = null;
  let runAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dataset' && args[i + 1]) datasetId = args[++i];
    if (args[i] === '--queries' && args[i + 1]) queryFile = args[++i];
    if (args[i] === '--all') runAll = true;
  }

  const queries = loadQuerySet(queryFile);
  const gitCommit = getGitCommit();

  console.log('=' .repeat(60));
  console.log('BENCHMARK RUN');
  console.log('=' .repeat(60));
  console.log(`Git commit: ${gitCommit}`);
  console.log(`Timestamp:  ${new Date().toISOString()}`);

  // Determine datasets to run
  let datasetIds = [];
  if (runAll) {
    const datasets = await getAllDatasets();
    datasetIds = datasets.map(d => d.id);
    console.log(`Datasets:   ${datasetIds.length} (--all mode)`);
  } else if (datasetId) {
    datasetIds = [datasetId];
  } else {
    const datasets = await getAllDatasets();
    datasetIds = [datasets[0].id];
  }

  // Run benchmarks
  const allRuns = [];
  for (const dsId of datasetIds) {
    const run = await runBenchmark(dsId, queries);
    allRuns.push(run);
  }

  // Write JSON report
  const report = {
    benchmark_version: BENCHMARK_VERSION,
    git_commit: gitCommit,
    timestamp: new Date().toISOString(),
    datasets: allRuns.map(r => ({
      ...r.dsInfo,
      summary: r.summary,
      queries: r.results
    }))
  };

  const reportPath = path.join(__dirname, 'benchmark-results.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to: ${reportPath}`);

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('OVERALL');
  console.log('='.repeat(60));

  const allValid = allRuns.flatMap(r => r.results.filter(q => !q.error));
  const totalQueries = allValid.length;
  const totalFallbacks = allValid.filter(r => r.usedFallback).length;
  const totalNodeFirstOnly = allValid.filter(r => r.retrieval_path === 'node_first_only').length;
  const allAssertable = allValid.filter(r => r.answerPass !== null);
  const totalPassed = allAssertable.filter(r => r.answerPass).length;

  console.log(`Total queries:     ${totalQueries} across ${allRuns.length} dataset(s)`);
  console.log(`Fallback rate:     ${totalFallbacks}/${totalQueries} (${totalQueries > 0 ? (totalFallbacks / totalQueries * 100).toFixed(1) : 0}%)`);
  console.log(`Node-first-only:   ${totalNodeFirstOnly}/${totalQueries}`);
  console.log(`Answer pass rate:  ${totalPassed}/${allAssertable.length}`);

  // Exit code
  if (totalQueries > 0 && totalFallbacks / totalQueries > 0.5) {
    console.log(`\nWARNING: Fallback rate above 50%.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
