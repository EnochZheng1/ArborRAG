/**
 * CLI test runner — mirrors the browser-based accuracy/multidoc/coverage test suite.
 * Usage:  node test-runner.mjs [--focus <id1,id2,...>]
 */

import { readFileSync } from 'fs';

const BASE = 'http://localhost:3000';
const DATASET_NAME = `[Test Run ${Date.now()}]`;

// ── Documents ─────────────────────────────────────────────────────────────────

const ACCURACY_TEST_DOCUMENT = `QUANTUM LABS, INC.
EMPLOYEE HANDBOOK — VERSION 3.0

COMPANY OVERVIEW

Quantum Labs, Inc. was founded in 2019 by Dr. James Harrington and Sarah Chen in
San Francisco, California. Our headquarters are located at 42 Innovation Drive,
San Francisco, CA 94105. Sarah Chen serves as Chief Executive Officer (CEO), while
Dr. James Harrington serves as Chief Technology Officer (CTO).

Quantum Labs develops enterprise software solutions focused on security and
productivity. Our three flagship products are:
- QuantumVault: An enterprise password manager with zero-knowledge encryption
- QuantumFlow: A workflow automation platform for teams of all sizes
- QuantumScan: An automated security vulnerability scanner

EMPLOYMENT POLICIES

1. Probationary Period
All new employees are subject to a 90-day probationary period starting from their
first day of employment. During this period, either party may terminate employment
with 7 days notice. Remote work is not available during the probationary period.

2. Vacation Policy
Employees in their first year of service receive 15 days of paid vacation annually.
After completing 3 consecutive years of service, vacation entitlement increases to
20 days per year. Unused vacation days may be carried over up to a maximum of 5
days per calendar year.

3. Health Insurance
Quantum Labs covers 85% of employee health insurance premiums for the standard
plan. Employees choosing enhanced coverage plans are responsible for the additional
premium difference. Dependents may be added during the annual enrollment window
each November.

4. Remote Work Policy
Employees may work remotely up to 3 days per week, subject to manager approval.
Core collaboration hours are 10:00 AM to 3:00 PM Pacific Time, during which all
employees must be available regardless of work location.

5. Performance Reviews
Performance reviews are conducted twice per year: in June and in December. Each
review includes a self-assessment, a peer review from two colleagues, and a formal
evaluation by the direct manager.

TECHNICAL SUPPORT SLA

Quantum Labs' internal IT team guarantees the following service level agreements:
- Critical issues (system outage): 4-hour response time
- High priority (significant impact): 8-hour response time
- Medium priority (partial impact): 24-hour response time
- Low priority (minor impact): 72-hour response time

IT support requests should be submitted to support@quantumlabs.example.com

CONTACT INFORMATION

HR Department: hr@quantumlabs.example.com
CEO: sarah.chen@quantumlabs.example.com
CTO: james.harrington@quantumlabs.example.com
Office Phone: +1 (415) 555-0142
Emergency Hotline: +1 (415) 555-0199

PRODUCT DETAILS

QuantumVault
QuantumVault is Quantum Labs' flagship password management solution. It uses
zero-knowledge architecture, ensuring that only the user can access their stored
credentials. QuantumVault supports integration with over 200 third-party
applications and provides multi-factor authentication (MFA) support. Enterprise
pricing starts at $8 per user per month.

QuantumFlow
QuantumFlow automates repetitive business workflows using a drag-and-drop interface
requiring no coding experience. It integrates with popular tools including Slack,
Jira, GitHub, and Microsoft 365. QuantumFlow processes over 50 million workflow
executions per month across all customers. Enterprise pricing starts at $12 per
user per month.

QuantumScan
QuantumScan performs automated security scans of web applications and cloud
infrastructure. Scans are conducted weekly by default, with the option for daily
scans on critical systems. QuantumScan has detected over 2 million security
vulnerabilities since its launch in 2021. Enterprise pricing starts at $500 per
month per domain.
`;

const SECOND_TEST_DOCUMENT = `TECHSERVE IT SOLUTIONS
SERVICE CATALOG — Q1 2024

COMPANY OVERVIEW

TechServe IT Solutions was established in 2015 by Michael Torres and Jennifer Park
in Austin, Texas. Our registered address is 800 Tech Boulevard, Austin, TX 78701.
Jennifer Park serves as Chief Executive Officer (CEO), while Michael Torres serves
as Chief Operating Officer (COO).

TechServe provides managed IT services and cloud solutions. Our three core service
offerings are:
- CloudGuard: A managed firewall and network security service
- DataBridge: A real-time data synchronization and migration platform
- HelpDesk Pro: An AI-powered IT support ticketing system

SERVICE LEVEL AGREEMENTS

TechServe guarantees the following response times for all managed services:
- P1 (Critical outage): 1-hour response time, 99.99% uptime guaranteed
- P2 (High impact): 4-hour response time, 99.9% uptime guaranteed
- P3 (Medium impact): 12-hour response time, 99.5% uptime guaranteed
- P4 (Low impact): 48-hour response time, 99.0% uptime guaranteed

PRODUCT DETAILS

CloudGuard
CloudGuard provides enterprise-grade firewall management, intrusion detection, and
24/7 network monitoring for on-premise and cloud environments. It supports up to
10,000 simultaneous connections. Pricing starts at $200 per month per site.

DataBridge
DataBridge synchronizes data in real time across databases, cloud storage, and SaaS
applications. It supports over 150 pre-built data connectors. DataBridge handles
peak throughput of 1 million records per minute. Pricing starts at $300 per month.

HelpDesk Pro
HelpDesk Pro uses machine learning to auto-classify, route, and resolve IT support
tickets. It automatically resolves 40% of incoming tickets without human intervention.
Average ticket resolution time is 22 minutes. Pricing is $15 per agent per month.

SUPPORT CONTACTS

Support email: support@techserve.example.com
Sales inquiries: sales@techserve.example.com
Main office phone: +1 (512) 555-0280
Emergency hotline: +1 (512) 555-0300
`;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function api(method, path, body, datasetId) {
  const url = `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (datasetId) headers['X-Dataset-ID'] = datasetId;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function uploadFile(content, filename, datasetId) {
  const blob = new Blob([content], { type: 'text/plain' });
  const fd = new FormData();
  fd.append('file', new File([blob], filename, { type: 'text/plain' }));
  fd.append('useLLM', 'true');
  fd.append('detectConflicts', 'false');
  const res = await fetch(`${BASE}/upload`, {
    method: 'POST',
    body: fd,
    headers: { 'X-Dataset-ID': datasetId }
  });
  return res.json();
}

async function pollJob(jobId, datasetId) {
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);
  while (true) {
    const job = await api('GET', `/ingest/jobs/${jobId}`, null, datasetId);
    if (TERMINAL.has(job.status)) return job;
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function checkAnswer(d, needle) {
  if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
  const answer = d.llm_response?.final_answer ?? d.data?.final_answer ?? '';
  // Strip citation markers [1], [2], etc. before matching to avoid false positives
  // (e.g., needle "4" matching citation "[4]")
  // Also normalize hyphens to spaces for flexible matching ("4-hour" ↔ "4 hour")
  const cleanAnswer = answer.replace(/\[\d+\]/g, '').replace(/-/g, ' ');
  const cleanNeedle = needle.replace(/-/g, ' ');
  const passed = cleanAnswer.toLowerCase().includes(cleanNeedle.toLowerCase());
  const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
  return { passed, detail: `conf:${(d.confidence ?? 0).toFixed(2)} | ${snippet}${answer.length > 150 ? '…' : ''}` };
}

function call(method, path, body, datasetId) {
  return api(method, path, body, datasetId);
}

// ── Test runner ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const focusArg = args.indexOf('--focus');
const focusIds = focusArg >= 0 ? new Set(args[focusArg + 1].split(',')) : null;

let datasetId = null;
const accuracyState = { ingested: false, chunkCount: 0 };
const multidocState = { ingested: false, chunkCount: 0 };

const results = [];
let passed = 0, failed = 0;

function log(id, ok, detail) {
  const icon = ok ? '✓' : '✗';
  const color = ok ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  console.log(`  ${color}${icon}${reset} ${id.padEnd(40)} ${detail}`);
  results.push({ id, ok, detail });
  if (ok) passed++; else failed++;
}

async function run() {
  console.log('\n── Creating test dataset ──────────────────────────────────────────');
  const ds = await fetch(`${BASE}/datasets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DATASET_NAME, description: 'CLI test run' })
  }).then(r => r.json());
  datasetId = ds.id ?? ds.dataset?.id;
  if (!datasetId) { console.error('Failed to create dataset', ds); process.exit(1); }
  console.log(`  Dataset: ${datasetId} (${DATASET_NAME})`);

  const c = (method, path, body) => call(method, path, body, datasetId);

  // ── Accuracy ingest ─────────────────────────────────────────────────────────
  console.log('\n── Ingesting Quantum Labs document ────────────────────────────────');
  const up1 = await uploadFile(ACCURACY_TEST_DOCUMENT, 'quantum-labs-handbook.txt', datasetId);
  const jobId1 = up1.job?.id ?? up1.jobs?.[0]?.id;
  if (!jobId1) { console.error('No job ID', up1); process.exit(1); }
  process.stdout.write('  Waiting for ingestion');
  const job1 = await pollJob(jobId1, datasetId);
  console.log(` → ${job1.status} (${job1.result?.stats?.chunkCount ?? 0} chunks)`);
  if (job1.status !== 'completed') { console.error('Ingestion failed', job1.error_message); process.exit(1); }
  accuracyState.ingested = true;
  accuracyState.chunkCount = job1.result?.stats?.chunkCount ?? 0;
  await c('POST', '/embeddings/sync');

  // ── Accuracy tests ──────────────────────────────────────────────────────────
  console.log('\n── Accuracy — Factual Retrieval ───────────────────────────────────');

  async function accTest(id, query, needle) {
    if (focusIds && !focusIds.has(id)) return;
    const d = await c('POST', '/ask', { query });
    log(id, checkAnswer(d, needle).passed, checkAnswer(d, needle).detail);
  }

  await accTest('accuracy_health_coverage_pct', 'What percentage of health insurance premiums does Quantum Labs cover for employees?', '85');
  await accTest('accuracy_probation_length', 'What is the probationary period duration for new Quantum Labs employees?', '90');
  await accTest('accuracy_critical_sla', 'What is the SLA response time for critical IT issues at Quantum Labs?', '4 hour');
  await accTest('accuracy_high_sla', 'What is the response time SLA for high-priority IT issues at Quantum Labs?', '8 hour');
  await accTest('accuracy_medium_sla', 'What is the response time for medium priority IT support at Quantum Labs?', '24 hour');
  await accTest('accuracy_probation_notice', 'How many days notice is required to terminate employment during the probation period at Quantum Labs?', '7');
  await accTest('accuracy_vacation_3yr', 'How many vacation days do Quantum Labs employees get after 3 years of service?', '20');
  await accTest('accuracy_founded_year', 'When was Quantum Labs founded?', '2019');
  await accTest('accuracy_ceo_name', 'Who is the CEO of Quantum Labs?', 'Sarah Chen');
  await accTest('accuracy_vacation_first_year', 'How many vacation days do first year Quantum Labs employees receive?', '15');
  await accTest('accuracy_remote_work_days', 'How many days per week can Quantum Labs employees work from home?', '3');

  // all_sla_levels - custom check
  if (!focusIds || focusIds.has('accuracy_all_sla_levels')) {
    const d = await c('POST', '/ask', { query: 'What are all the IT support SLA response times at Quantum Labs?' });
    if (d.action === 'no_results') {
      log('accuracy_all_sla_levels', false, 'no_results');
    } else {
      const rawAnswer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '');
      const answer = rawAnswer.replace(/\[\d+\]/g, '').replace(/-/g, ' ').toLowerCase();
      const tiers = { '4': answer.includes('4 hour'), '8': answer.includes('8 hour'), '24': answer.includes('24 hour'), '72': answer.includes('72 hour') };
      const count = Object.values(tiers).filter(Boolean).length;
      const found = Object.entries(tiers).filter(([, v]) => v).map(([k]) => k + 'h').join(', ') || 'none';
      log('accuracy_all_sla_levels', count >= 3, `SLA values found: ${found} (${count}/4 tiers)`);
    }
  }

  // coverage_snippets_generated
  if (!focusIds || focusIds.has('coverage_snippets_generated')) {
    const d = await c('POST', '/ask', { query: 'What is the health insurance coverage at Quantum Labs?' });
    if (d.action === 'no_results') {
      log('coverage_snippets_generated', false, 'no_results');
    } else {
      const snippets = d.snippets ?? [];
      log('coverage_snippets_generated', snippets.length > 0,
        snippets.length > 0 ? `${snippets.length} snippet(s) — first: "${(snippets[0].text ?? '').substring(0, 80)}"` : 'no snippets in response');
    }
  }

  // ── Multidoc ingest ─────────────────────────────────────────────────────────
  if (!focusIds || focusIds.has('multidoc_isolation_quantum_ceo')) {
    console.log('\n── Ingesting TechServe document ───────────────────────────────────');
    const up2 = await uploadFile(SECOND_TEST_DOCUMENT, 'techserve-catalog.txt', datasetId);
    const jobId2 = up2.job?.id ?? up2.jobs?.[0]?.id;
    process.stdout.write('  Waiting for ingestion');
    const job2 = await pollJob(jobId2, datasetId);
    console.log(` → ${job2.status} (${job2.result?.stats?.chunkCount ?? 0} chunks)`);
    multidocState.ingested = true;
    multidocState.chunkCount = job2.result?.stats?.chunkCount ?? 0;

    // multidoc_isolation_quantum_ceo
    console.log('\n── Multi-Document Isolation ───────────────────────────────────────');
    const d = await c('POST', '/ask', { query: 'Who is the CEO of Quantum Labs?' });
    if (d.action === 'no_results') {
      log('multidoc_isolation_quantum_ceo', false, 'no_results');
    } else {
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const hasSarah = answer.includes('sarah');
      const hasJennifer = answer.includes('jennifer');
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      log('multidoc_isolation_quantum_ceo', hasSarah, `Sarah:${hasSarah} Jennifer(bleed):${hasJennifer} | conf:${(d.confidence ?? 0).toFixed(2)} | ${snippet}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n── Results ────────────────────────────────────────────────────────');
  console.log(`  Passed: \x1b[32m${passed}\x1b[0m  Failed: \x1b[31m${failed}\x1b[0m  Total: ${passed + failed}`);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  console.log('\n── Cleaning up ────────────────────────────────────────────────────');
  await fetch(`${BASE}/datasets/${datasetId}`, { method: 'DELETE' });
  console.log('  Dataset deleted.\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
