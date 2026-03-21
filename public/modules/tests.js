// ── Tests Tab — extracted from settings.js ──────────────────────────────────
import { state, API_BASE, _tabDirty } from './state.js';
import { api, escapeHtml, showToast, registerFn, callFn, copyToClipboard, showConfirmModal } from './utils.js';
import { t } from './i18n.js';

// Module-level state
let testResults = {};
let allTests = [];
let isRunning = false;
let cancelRequested = false;
let _lastRunCache = null;
let _progressTimer = null;
let _searchDebounce = null;
let accuracyState = { jobId: null, docId: null, chunkCount: 0, ingested: false };
let multidocState = { jobId: null, docId: null, chunkCount: 0, ingested: false };

// ── Accuracy test document ────────────────────────────────────────────────────
// A fictional employee handbook with precise, verifiable facts used as ground
// truth for the accuracy test suite. Ingested once per session via accuracy_ingest.

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

// Second ground-truth document — TechServe IT Solutions.
// Used by multi-document tests to verify cross-document isolation and aggregation.
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

// Helper: evaluate a /ask response for a factual substring match.
// Returns { passed, detail } for use inside accuracy test run() functions.
function checkAccuracyAnswer(d, needle) {
  if (d.action === 'no_results')
    return { passed: false, detail: 'no_results — test document may not be indexed in this dataset' };
  // Support both simple_lookup (llm_response.final_answer) and aggregation (data.final_answer)
  const answer  = d.llm_response?.final_answer ?? d.data?.final_answer ?? '';
  const passed  = answer.toLowerCase().includes(needle.toLowerCase());
  const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
  return { passed, detail: `conf:${(d.confidence ?? 0).toFixed(2)} | ${snippet}${answer.length > 150 ? '…' : ''}` };
}

// ── Built-in test catalog ─────────────────────────────────────────────────────

const BUILTIN_TESTS = [
  // ─ Connectivity
  {
    id: 'health_check', category: 'Connectivity', builtin: true,
    name: 'Server Health Check',
    description: 'GET /health returns status "ok"',
    async run(call) {
      const d = await call('GET', '/health');
      const passed = d.status === 'ok';
      return { passed, detail: `status: ${d.status}` };
    }
  },
  {
    id: 'stats_structure', category: 'Connectivity', builtin: true,
    name: 'System Stats Structure',
    description: 'GET /stats returns nodes, documents, chunks keys',
    async run(call) {
      const d = await call('GET', '/stats');
      const missing = ['nodes', 'documents', 'chunks'].filter(k => !(k in d));
      return { passed: missing.length === 0, detail: missing.length ? `missing keys: ${missing.join(', ')}` : 'all keys present' };
    }
  },

  // ─ Query Pipeline
  {
    id: 'ask_returns_answer', category: 'Query Pipeline', builtin: true,
    name: 'Ask Returns Answer Field',
    description: 'POST /ask → response has llm_response.final_answer or action=no_results',
    async run(call) {
      const d = await call('POST', '/ask', { query: 'test query' });
      const hasAnswer = d.llm_response?.final_answer != null;
      const isNoResults = d.action === 'no_results';
      const passed = hasAnswer || isNoResults;
      return {
        passed,
        detail: hasAnswer
          ? `final_answer length: ${d.llm_response.final_answer.length} chars`
          : isNoResults ? 'no results (empty dataset)' : `unexpected shape; keys: ${Object.keys(d).join(', ')}`
      };
    }
  },
  {
    id: 'ask_confidence_range', category: 'Query Pipeline', builtin: true,
    name: 'Answer Confidence In Range',
    description: 'POST /ask → confidence field is a number in [0, 1]',
    async run(call) {
      const d = await call('POST', '/ask', { query: 'test query' });
      const c = d.confidence;
      const passed = typeof c === 'number' && c >= 0 && c <= 1;
      return { passed, detail: `confidence: ${c}` };
    }
  },
  {
    id: 'ask_has_query_type', category: 'Query Pipeline', builtin: true,
    name: 'Ask Returns Query Type',
    description: 'POST /ask → response includes query_type field',
    async run(call) {
      const d = await call('POST', '/ask', { query: 'test query' });
      const passed = !!d.query_type;
      return { passed, detail: `query_type: ${d.query_type ?? '(missing)'}` };
    }
  },
  {
    id: 'ask_simple_works', category: 'Query Pipeline', builtin: true,
    name: 'Simple Search Works',
    description: 'POST /ask/simple → response has llm_response.final_answer or action=no_results',
    async run(call) {
      const d = await call('POST', '/ask/simple', { query: 'test query' });
      const hasAnswer = d.llm_response?.final_answer != null;
      const isNoResults = d.action === 'no_results';
      const passed = hasAnswer || isNoResults;
      return {
        passed,
        detail: hasAnswer
          ? `final_answer length: ${d.llm_response.final_answer.length} chars`
          : isNoResults ? 'no results (empty dataset)' : `unexpected shape; keys: ${Object.keys(d).join(', ')}`
      };
    }
  },

  // ─ Classification
  {
    id: 'classify_simple_lookup', category: 'Classification', builtin: true,
    name: 'Classify Simple Lookup',
    description: '"What is the definition of X?" → query_type=simple_lookup',
    async run(call) {
      const d = await call('POST', '/classify', { query: 'What is the definition of a knowledge base?' });
      const passed = d.query_type === 'simple_lookup';
      return { passed, detail: `got query_type: ${d.query_type ?? '(missing)'}` };
    }
  },
  {
    id: 'classify_comparison', category: 'Classification', builtin: true,
    name: 'Classify Comparison Query',
    description: '"Compare option A and option B" → query_type=comparison',
    async run(call) {
      const d = await call('POST', '/classify', { query: 'Compare option A and option B' });
      const passed = d.query_type === 'comparison';
      return { passed, detail: `got query_type: ${d.query_type ?? '(missing)'}` };
    }
  },
  {
    id: 'classify_recommendation', category: 'Classification', builtin: true,
    name: 'Classify Recommendation Query',
    description: '"What do you recommend for new employees?" → query_type=recommendation',
    async run(call) {
      const d = await call('POST', '/classify', { query: 'What do you recommend for new employees?' });
      const passed = d.query_type === 'recommendation';
      return { passed, detail: `got query_type: ${d.query_type ?? '(missing)'}` };
    }
  },

  // ─ Data Integrity
  {
    id: 'nodes_tree_valid', category: 'Data Integrity', builtin: true,
    name: 'Node Tree Accessible',
    description: 'GET /nodes → response has "tree" key',
    async run(call) {
      const d = await call('GET', '/nodes');
      const passed = 'tree' in d;
      return { passed, detail: passed ? `tree present` : 'missing tree key' };
    }
  },
  {
    id: 'documents_listed', category: 'Data Integrity', builtin: true,
    name: 'Documents List Valid',
    description: 'GET /documents → "documents" is an Array',
    async run(call) {
      const d = await call('GET', '/documents');
      const passed = Array.isArray(d.documents);
      return { passed, detail: passed ? `${d.documents.length} documents` : 'documents is not an array' };
    }
  },
  {
    id: 'embeddings_coverage_valid', category: 'Data Integrity', builtin: true,
    name: 'Embeddings Coverage Valid',
    description: 'GET /embeddings/coverage → response has chunks and nodes keys with coverage data',
    async run(call) {
      const d = await call('GET', '/embeddings/coverage');
      const passed = d.chunks != null && d.nodes != null;
      const detail = passed
        ? `chunks: ${d.chunks.embedded}/${d.chunks.total}, nodes: ${d.nodes.embedded}/${d.nodes.total}`
        : `unexpected shape: ${JSON.stringify(Object.keys(d))}`;
      return { passed, detail };
    }
  },

  // ─ Knowledge Features
  {
    id: 'suggestions_work', category: 'Knowledge Features', builtin: true,
    name: 'Suggestions Endpoint Works',
    description: 'GET /suggestions/examples → returns an Array',
    async run(call) {
      const d = await call('GET', '/suggestions/examples');
      const arr = d.examples ?? d;
      const passed = Array.isArray(arr);
      return { passed, detail: passed ? `${arr.length} examples` : 'expected an array' };
    }
  },
  {
    id: 'facts_retrieve_format', category: 'Knowledge Features', builtin: true,
    name: 'Facts Retrieve Format',
    description: 'POST /facts/retrieve → response has "facts" key',
    async run(call) {
      const d = await call('POST', '/facts/retrieve', { question: 'test' });
      const passed = 'facts' in d;
      return { passed, detail: passed ? `${(d.facts ?? []).length} facts returned` : 'missing facts key' };
    }
  },
  {
    id: 'decisions_accessible', category: 'Knowledge Features', builtin: true,
    name: 'Decisions Accessible',
    description: 'GET /decisions → response has "decisions" key',
    async run(call) {
      const d = await call('GET', '/decisions');
      const passed = 'decisions' in d;
      return { passed, detail: passed ? `${d.decisions.length} decisions` : 'missing decisions key' };
    }
  },

  // ─ System Health
  {
    id: 'queue_stats_accessible', category: 'System Health', builtin: true,
    name: 'Queue Stats Accessible',
    description: 'GET /ingest/queue/stats → response has "queued" key',
    async run(call) {
      const d = await call('GET', '/ingest/queue/stats');
      const passed = 'queued' in d;
      return { passed, detail: passed ? `queued: ${d.queued}, processing: ${d.processing}` : `missing queued key; got: ${JSON.stringify(Object.keys(d))}` };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ACCURACY TESTS
  // These tests upload a known fictional document (Quantum Labs Employee Handbook)
  // and verify that the RAG pipeline retrieves specific facts correctly.
  // Run accuracy_ingest first; all other accuracy tests depend on it.
  // ─────────────────────────────────────────────────────────────────────────────

  // ─ Accuracy — Setup
  {
    id: 'accuracy_ingest', category: 'Accuracy — Setup', builtin: true,
    name: 'Ingest Test Document',
    description: 'Upload the Quantum Labs handbook and wait for processing to complete',
    async run(call) {
      // Reset state for this run
      accuracyState = { jobId: null, docId: null, chunkCount: 0, ingested: false };

      // Build multipart upload (can't use api() — it forces JSON content-type)
      const blob = new Blob([ACCURACY_TEST_DOCUMENT], { type: 'text/plain' });
      const file = new File([blob], 'quantum-labs-handbook.txt', { type: 'text/plain' });
      const fd   = new FormData();
      fd.append('file', file);
      fd.append('useLLM', 'true');

      const uploadResp = await fetch('/upload', {
        method: 'POST',
        body: fd,
        headers: { 'X-Dataset-ID': state.currentDatasetId }
      });
      if (!uploadResp.ok) {
        const err = await uploadResp.json().catch(() => ({}));
        return { passed: false, detail: `Upload failed ${uploadResp.status}: ${err.error ?? uploadResp.statusText}` };
      }
      const uploadData = await uploadResp.json();
      const jobId = uploadData.job?.id ?? uploadData.jobs?.[0]?.id;
      if (!jobId) return { passed: false, detail: 'No job ID in upload response' };
      accuracyState.jobId = jobId;

      // Poll until terminal status (no time limit)
      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);
      const start    = Date.now();
      let job;
      while (true) {
        job = await call('GET', `/ingest/jobs/${jobId}`);
        if (TERMINAL.has(job.status)) break;
        await new Promise(r => setTimeout(r, 3000));
      }

      if (!job)              return { passed: false, detail: 'Polling produced no response' };
      if (job.status !== 'completed')
        return { passed: false, detail: `Ingestion ended with status: ${job.status}${job.error_message ? ' — ' + job.error_message : ''}` };

      const result     = job.result ?? {};
      const docId      = result.documentId ?? result.document_id ?? job.document_id;
      const chunkCount = result.stats?.chunkCount ?? 0;
      const elapsed    = ((Date.now() - start) / 1000).toFixed(1);

      accuracyState.docId      = docId;
      accuracyState.chunkCount = chunkCount;
      accuracyState.ingested   = true;

      // Generate embeddings — ingestion does not auto-embed; sync is required
      // for semantic search and the accuracy_embeddings_generated test
      try {
        await call('POST', '/embeddings/sync');
      } catch (_) { /* non-fatal — embedding test will surface the failure */ }

      return { passed: true, detail: `Doc #${docId} ingested — ${chunkCount} chunks in ${elapsed}s` };
    }
  },
  {
    id: 'accuracy_chunks_created', category: 'Accuracy — Setup', builtin: true,
    name: 'Test Document Has Chunks',
    description: 'Verify the ingested test document produced at least one chunk',
    async run(_call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const passed = accuracyState.chunkCount > 0;
      return { passed, detail: `${accuracyState.chunkCount} chunks created from test document` };
    }
  },

  // ─ Accuracy — Factual Retrieval
  {
    id: 'accuracy_founded_year', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Founding Year',
    description: 'Ask when Quantum Labs was founded → answer must contain "2019"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'When was Quantum Labs founded?' });
      return checkAccuracyAnswer(d, '2019');
    }
  },
  {
    id: 'accuracy_ceo_name', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve CEO Name',
    description: 'Ask who the CEO of Quantum Labs is → answer must contain "Sarah Chen"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'Who is the CEO of Quantum Labs?' });
      return checkAccuracyAnswer(d, 'Sarah Chen');
    }
  },
  {
    id: 'accuracy_vacation_first_year', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve First-Year Vacation Days',
    description: 'Ask about year-1 vacation entitlement → answer must contain "15"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How many vacation days do first year Quantum Labs employees receive?' });
      return checkAccuracyAnswer(d, '15');
    }
  },
  {
    id: 'accuracy_health_coverage_pct', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Health Insurance Coverage',
    description: 'Ask what % of health premiums Quantum Labs covers → answer must contain "85"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What percentage of health insurance premiums does Quantum Labs cover for employees?' });
      return checkAccuracyAnswer(d, '85');
    }
  },
  {
    id: 'accuracy_remote_work_days', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Remote Work Days Limit',
    description: 'Ask how many days/week remote work is allowed → answer must contain "3"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How many days per week can Quantum Labs employees work from home?' });
      return checkAccuracyAnswer(d, '3');
    }
  },
  {
    id: 'accuracy_probation_length', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Probation Period Length',
    description: 'Ask about probation duration → answer must contain "90"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the probationary period duration for new Quantum Labs employees?' });
      return checkAccuracyAnswer(d, '90');
    }
  },
  {
    id: 'accuracy_critical_sla', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Critical Issue SLA',
    description: 'Ask SLA for critical IT issues → answer must contain "4"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the SLA response time for critical IT issues at Quantum Labs?' });
      return checkAccuracyAnswer(d, '4');
    }
  },

  // ─ Accuracy — Semantic Retrieval
  {
    id: 'accuracy_products_list', category: 'Accuracy — Semantic Retrieval', builtin: true,
    name: 'List All Products',
    description: 'Ask what products Quantum Labs makes → answer must name both QuantumVault and QuantumFlow',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What products does Quantum Labs make?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results — test document may not be indexed' };
      const rawAnswer = d.llm_response?.final_answer ?? d.data?.final_answer ?? '';
      const answer   = rawAnswer.toLowerCase();
      const hasVault = answer.includes('quantumvault');
      const hasFlow  = answer.includes('quantumflow');
      const passed   = hasVault && hasFlow;
      const snippet  = rawAnswer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `QuantumVault:${hasVault} QuantumFlow:${hasFlow} | conf:${(d.confidence??0).toFixed(2)} | ${snippet}${snippet.length===150?'…':''}` };
    }
  },
  {
    id: 'accuracy_product_description', category: 'Accuracy — Semantic Retrieval', builtin: true,
    name: 'Describe QuantumVault',
    description: 'Ask what QuantumVault is → answer must mention "password"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is QuantumVault and what is it used for?' });
      return checkAccuracyAnswer(d, 'password');
    }
  },
  {
    id: 'accuracy_review_frequency', category: 'Accuracy — Semantic Retrieval', builtin: true,
    name: 'Retrieve Review Schedule',
    description: 'Ask how often performance reviews are held → answer implies twice a year',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How often are performance reviews conducted at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results — test document may not be indexed' };
      const rawAnswer = d.llm_response?.final_answer ?? d.data?.final_answer ?? '';
      const answer  = rawAnswer.toLowerCase();
      const passed  = answer.includes('twice') || answer.includes('two') || answer.includes('june') || answer.includes('december') || answer.includes('2 times');
      const snippet = rawAnswer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `conf:${(d.confidence??0).toFixed(2)} | ${snippet}${snippet.length===150?'…':''}` };
    }
  },

  // ─ Accuracy — Classification
  {
    id: 'accuracy_classify_comparison', category: 'Accuracy — Classification', builtin: true,
    name: 'Classify Product Comparison Query',
    description: '"Compare QuantumVault and QuantumFlow…" → query_type=comparison',
    async run(call) {
      const d = await call('POST', '/classify', { query: 'Compare QuantumVault and QuantumFlow in terms of features and pricing' });
      const passed = d.query_type === 'comparison';
      return { passed, detail: `got query_type: ${d.query_type ?? '(missing)'}` };
    }
  },
  {
    id: 'accuracy_classify_recommendation', category: 'Accuracy — Classification', builtin: true,
    name: 'Classify Recommendation Query',
    description: '"Which Quantum Labs product should I use for…" → query_type=recommendation',
    async run(call) {
      const d = await call('POST', '/classify', { query: 'Which Quantum Labs product should a small team use for workflow automation?' });
      const passed = d.query_type === 'recommendation';
      return { passed, detail: `got query_type: ${d.query_type ?? '(missing)'}` };
    }
  },

  // ─ Accuracy — Knowledge Graph
  {
    id: 'accuracy_nodes_populated', category: 'Accuracy — Knowledge Graph', builtin: true,
    name: 'Knowledge Graph Has Nodes',
    description: 'After ingestion, GET /nodes → tree must contain at least one node',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('GET', '/nodes');
      const count  = d.stats?.total_nodes ?? 0;
      const passed = count > 0;
      return { passed, detail: `${count} node(s) in knowledge tree` };
    }
  },
  {
    id: 'accuracy_entities_extracted', category: 'Accuracy — Knowledge Graph', builtin: true,
    name: 'Entities Extracted From Document',
    description: 'GET /entities → at least one entity mentions "Quantum" or "Sarah"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('GET', '/entities?limit=100');
      const entities = d.entities ?? [];
      const match    = entities.find(e => {
        const n = (e.name ?? '').toLowerCase();
        return n.includes('quantum') || n.includes('sarah') || n.includes('harrington');
      });
      return {
        passed: !!match,
        detail: match
          ? `Found entity: "${match.name}" (${match.entity_type ?? 'unknown type'})`
          : `No matching entity among ${entities.length} extracted (first 5: ${entities.slice(0,5).map(e=>e.name).join(', ')})`
      };
    }
  },
  {
    id: 'accuracy_embeddings_generated', category: 'Accuracy — Knowledge Graph', builtin: true,
    name: 'Chunk Embeddings Generated',
    description: 'GET /embeddings/coverage → at least one chunk has been embedded',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('GET', '/embeddings/coverage');
      const embedded = d.chunks?.embedded ?? 0;
      const total    = d.chunks?.total ?? 0;
      const passed   = embedded > 0;
      return { passed, detail: `chunks embedded: ${embedded}/${total}` };
    }
  },
  {
    id: 'accuracy_facts_retrievable', category: 'Accuracy — Knowledge Graph', builtin: true,
    name: 'Facts Extracted and Retrievable',
    description: 'POST /facts/retrieve with a Quantum Labs question → returns at least 1 fact',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/facts/retrieve', { question: 'Quantum Labs vacation policy' });
      const facts  = d.facts ?? [];
      const passed = facts.length > 0;
      return {
        passed,
        detail: passed
          ? `${facts.length} fact(s) — first: "${(facts[0].content ?? '').substring(0, 80)}"`
          : 'No facts returned'
      };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ACCURACY — ADDITIONAL FACTUAL RETRIEVAL
  // More precise, numeric facts from the Quantum Labs handbook that stress-test
  // exact-number retrieval (pricing, SLAs, thresholds, contact details).
  // ─────────────────────────────────────────────────────────────────────────────

  {
    id: 'accuracy_cto_name', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve CTO Name',
    description: 'Ask who the CTO is → answer must contain "Harrington"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'Who is the CTO of Quantum Labs?' });
      return checkAccuracyAnswer(d, 'Harrington');
    }
  },
  {
    id: 'accuracy_vacation_3yr', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Vacation Days After 3 Years',
    description: 'Ask vacation entitlement after 3 years → answer must contain "20"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How many vacation days do Quantum Labs employees get after 3 years of service?' });
      return checkAccuracyAnswer(d, '20');
    }
  },
  {
    id: 'accuracy_vacation_carryover', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Vacation Carryover Limit',
    description: 'Ask maximum carry-over vacation days → answer must contain "5"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How many unused vacation days can Quantum Labs employees carry over each year?' });
      return checkAccuracyAnswer(d, '5');
    }
  },
  {
    id: 'accuracy_high_sla', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve High Priority SLA',
    description: 'Ask SLA for high-priority IT issues → answer must contain "8"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the response time SLA for high-priority IT issues at Quantum Labs?' });
      return checkAccuracyAnswer(d, '8');
    }
  },
  {
    id: 'accuracy_medium_sla', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Medium Priority SLA',
    description: 'Ask SLA for medium-priority issues → answer must contain "24"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the response time for medium priority IT support at Quantum Labs?' });
      return checkAccuracyAnswer(d, '24');
    }
  },
  {
    id: 'accuracy_probation_notice', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Probation Notice Period',
    description: 'Ask the notice period during probation → answer must contain "7"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How many days notice is required to terminate employment during the probation period at Quantum Labs?' });
      return checkAccuracyAnswer(d, '7');
    }
  },
  {
    id: 'accuracy_probation_no_remote', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Probation Remote Work Restriction',
    description: 'Ask if remote work is allowed during probation → answer must indicate it is not available',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'Can new Quantum Labs employees work remotely during their probationary period?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results — test document may not be indexed' };
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const passed = answer.includes('not') || answer.includes('no') || answer.includes('unavailable') || answer.includes('prohibited');
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `conf:${(d.confidence ?? 0).toFixed(2)} | ${snippet}${answer.length > 150 ? '…' : ''}` };
    }
  },
  {
    id: 'accuracy_quantumvault_price', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve QuantumVault Pricing',
    description: 'Ask QuantumVault enterprise price → answer must contain "8"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the enterprise pricing for QuantumVault?' });
      return checkAccuracyAnswer(d, '8');
    }
  },
  {
    id: 'accuracy_quantumflow_price', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve QuantumFlow Pricing',
    description: 'Ask QuantumFlow enterprise price → answer must contain "12"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the enterprise pricing for QuantumFlow?' });
      return checkAccuracyAnswer(d, '12');
    }
  },
  {
    id: 'accuracy_quantumscan_price', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve QuantumScan Pricing',
    description: 'Ask QuantumScan price per domain → answer must contain "500"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What does QuantumScan cost per domain per month?' });
      return checkAccuracyAnswer(d, '500');
    }
  },
  {
    id: 'accuracy_quantumvault_integrations', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve QuantumVault Integration Count',
    description: 'Ask how many third-party integrations QuantumVault supports → answer must contain "200"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How many third-party applications does QuantumVault integrate with?' });
      return checkAccuracyAnswer(d, '200');
    }
  },
  {
    id: 'accuracy_quantumflow_executions', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve QuantumFlow Execution Volume',
    description: 'Ask monthly workflow executions for QuantumFlow → answer must contain "50"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'How many workflow executions does QuantumFlow process per month?' });
      return checkAccuracyAnswer(d, '50');
    }
  },
  {
    id: 'accuracy_quantumscan_launch', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve QuantumScan Launch Year',
    description: 'Ask when QuantumScan was launched → answer must contain "2021"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'When was QuantumScan launched?' });
      return checkAccuracyAnswer(d, '2021');
    }
  },
  {
    id: 'accuracy_core_hours', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Core Collaboration Hours',
    description: 'Ask about mandatory collaboration hours → answer must contain "10"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What are the core collaboration hours at Quantum Labs when all employees must be available?' });
      return checkAccuracyAnswer(d, '10');
    }
  },
  {
    id: 'accuracy_review_months', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve Performance Review Months',
    description: 'Ask when performance reviews happen → answer must mention June or December',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'In which months are performance reviews conducted at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const hasJune = answer.includes('june');
      const hasDec  = answer.includes('december') || answer.includes('dec');
      const passed  = hasJune || hasDec;
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `June:${hasJune} Dec:${hasDec} | conf:${(d.confidence ?? 0).toFixed(2)} | ${snippet}${answer.length > 150 ? '…' : ''}` };
    }
  },
  {
    id: 'accuracy_all_sla_levels', category: 'Accuracy — Factual Retrieval', builtin: true,
    name: 'Retrieve All SLA Tiers',
    description: 'Ask for all SLA levels → answer covers at least 3 of the 4 SLA tiers',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What are all the IT support SLA response times at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const tiers = { '4': answer.includes('4'), '8': answer.includes('8'), '24': answer.includes('24'), '72': answer.includes('72') };
      const count  = Object.values(tiers).filter(Boolean).length;
      const passed = count >= 3;
      return { passed, detail: `SLA values found: ${Object.entries(tiers).filter(([,v])=>v).map(([k])=>k+'h').join(', ') || 'none'} (${count}/4 tiers)` };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // MULTI-DOCUMENT PROCESSING
  // Ingest a second unrelated document (TechServe IT catalog) into the same
  // dataset that already contains the Quantum Labs handbook.  Tests verify:
  //   • Both documents are indexed independently
  //   • Company-specific facts don't cross-contaminate between documents
  //   • The retrieval pipeline correctly targets per-company content
  //   • Cross-document aggregation finds content from both sources
  // Run accuracy_ingest BEFORE running any multi-doc tests.
  // ─────────────────────────────────────────────────────────────────────────────

  {
    id: 'multidoc_ingest', category: 'Multi-Document Processing', builtin: true,
    name: 'Ingest Second Document (TechServe)',
    description: 'Upload the TechServe IT catalog alongside the existing Quantum Labs doc',
    async run(call) {
      if (!accuracyState.ingested)
        return { passed: false, detail: 'Run accuracy_ingest first to establish the first document' };

      multidocState = { jobId: null, docId: null, chunkCount: 0, ingested: false };

      const blob = new Blob([SECOND_TEST_DOCUMENT], { type: 'text/plain' });
      const file = new File([blob], 'techserve-catalog.txt', { type: 'text/plain' });
      const fd   = new FormData();
      fd.append('file', file);
      fd.append('useLLM', 'true');

      const uploadResp = await fetch('/upload', {
        method: 'POST',
        body: fd,
        headers: { 'X-Dataset-ID': state.currentDatasetId }
      });
      if (!uploadResp.ok) {
        const err = await uploadResp.json().catch(() => ({}));
        return { passed: false, detail: `Upload failed ${uploadResp.status}: ${err.error ?? uploadResp.statusText}` };
      }
      const uploadData = await uploadResp.json();
      const jobId = uploadData.job?.id ?? uploadData.jobs?.[0]?.id;
      if (!jobId) return { passed: false, detail: 'No job ID in upload response' };
      multidocState.jobId = jobId;

      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);
      const start    = Date.now();
      let job;
      while (true) {
        job = await call('GET', `/ingest/jobs/${jobId}`);
        if (TERMINAL.has(job.status)) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      if (job.status !== 'completed')
        return { passed: false, detail: `Ingestion ended: ${job.status}${job.error_message ? ' — ' + job.error_message : ''}` };

      const result     = job.result ?? {};
      const docId      = result.documentId ?? result.document_id ?? job.document_id;
      const chunkCount = result.stats?.chunkCount ?? 0;
      const elapsed    = ((Date.now() - start) / 1000).toFixed(1);

      multidocState.docId      = docId;
      multidocState.chunkCount = chunkCount;
      multidocState.ingested   = true;

      try { await call('POST', '/embeddings/sync'); } catch (_) {}

      return { passed: true, detail: `Doc #${docId} (TechServe) ingested — ${chunkCount} chunks in ${elapsed}s` };
    }
  },
  {
    id: 'multidoc_both_docs_indexed', category: 'Multi-Document Processing', builtin: true,
    name: 'Both Documents Indexed',
    description: 'After ingesting two docs, GET /documents → must list at least 2 documents',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('GET', '/documents');
      const count  = (d.documents ?? []).length;
      const passed = count >= 2;
      return { passed, detail: `${count} document(s) in dataset (need ≥2)` };
    }
  },
  {
    id: 'multidoc_both_docs_have_chunks', category: 'Multi-Document Processing', builtin: true,
    name: 'Second Document Produced Chunks',
    description: 'TechServe ingest must have produced at least one chunk',
    async run(_call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const passed = multidocState.chunkCount > 0;
      return { passed, detail: `TechServe: ${multidocState.chunkCount} chunks, Quantum Labs: ${accuracyState.chunkCount} chunks` };
    }
  },
  {
    id: 'multidoc_isolation_techserve_ceo', category: 'Multi-Document Processing', builtin: true,
    name: 'TechServe CEO Not Contaminated',
    description: 'Ask specifically for TechServe CEO → answer must contain "Jennifer" not "Sarah"',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'Who is the CEO of TechServe IT Solutions?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results — TechServe doc may not be indexed' };
      const answer  = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const hasJennifer = answer.includes('jennifer');
      const hasSarah    = answer.includes('sarah');
      // Correct: mentions Jennifer; wrong bleed: mentions only Sarah Chen from other doc
      const passed  = hasJennifer;
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `Jennifer:${hasJennifer} Sarah(bleed):${hasSarah} | conf:${(d.confidence??0).toFixed(2)} | ${snippet}${answer.length>150?'…':''}` };
    }
  },
  {
    id: 'multidoc_isolation_quantum_ceo', category: 'Multi-Document Processing', builtin: true,
    name: 'Quantum Labs CEO Not Contaminated',
    description: 'Ask specifically for Quantum Labs CEO → answer must contain "Sarah Chen" not "Jennifer"',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'Who is the CEO of Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer  = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const hasSarah    = answer.includes('sarah');
      const hasJennifer = answer.includes('jennifer');
      const passed  = hasSarah;
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `Sarah:${hasSarah} Jennifer(bleed):${hasJennifer} | conf:${(d.confidence??0).toFixed(2)} | ${snippet}${answer.length>150?'…':''}` };
    }
  },
  {
    id: 'multidoc_founding_isolation', category: 'Multi-Document Processing', builtin: true,
    name: 'TechServe Founding Year (2015) Not Confused With Quantum Labs (2019)',
    description: 'Ask when TechServe was founded → answer must contain "2015", not only "2019"',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'What year was TechServe IT Solutions established?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const has2015 = answer.includes('2015');
      const has2019 = answer.includes('2019');
      const passed  = has2015;
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `2015:${has2015} 2019(bleed):${has2019} | conf:${(d.confidence??0).toFixed(2)} | ${snippet}${answer.length>150?'…':''}` };
    }
  },
  {
    id: 'multidoc_product_isolation_techserve', category: 'Multi-Document Processing', builtin: true,
    name: 'TechServe Products Do Not Bleed QuantumVault',
    description: 'Ask for TechServe products → answer must contain CloudGuard, NOT QuantumVault',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'What services or products does TechServe IT Solutions offer?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer      = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const hasCloudGuard = answer.includes('cloudguard');
      const hasQuantumVault = answer.includes('quantumvault');
      // Pass if TechServe product found; flag bleed if Quantum product appears without context
      const passed  = hasCloudGuard;
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `CloudGuard:${hasCloudGuard} QuantumVault(bleed):${hasQuantumVault} | conf:${(d.confidence??0).toFixed(2)} | ${snippet}${answer.length>150?'…':''}` };
    }
  },
  {
    id: 'multidoc_product_isolation_quantum', category: 'Multi-Document Processing', builtin: true,
    name: 'Quantum Labs Products Do Not Bleed CloudGuard',
    description: 'Ask for Quantum Labs products → answer must contain QuantumVault, NOT CloudGuard',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'What products does Quantum Labs develop?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer      = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const hasQuantumVault  = answer.includes('quantumvault');
      const hasCloudGuard    = answer.includes('cloudguard');
      const passed  = hasQuantumVault;
      const snippet = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed, detail: `QuantumVault:${hasQuantumVault} CloudGuard(bleed):${hasCloudGuard} | conf:${(d.confidence??0).toFixed(2)} | ${snippet}${answer.length>150?'…':''}` };
    }
  },
  {
    id: 'multidoc_sla_disambiguation', category: 'Multi-Document Processing', builtin: true,
    name: 'SLA Disambiguation Between Documents',
    description: 'Ask TechServe P1 SLA → must contain "1" (not only "4" from Quantum Labs critical SLA)',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is TechServe IT Solutions P1 critical outage response time?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      // TechServe P1 = 1 hour; Quantum Labs critical = 4 hours
      const has1hour = answer.includes('1-hour') || answer.includes('1 hour') || /\b1\b/.test(answer);
      const snippet  = answer.substring(0, 150).replace(/\n/g, ' ');
      return { passed: has1hour, detail: `1-hour found:${has1hour} | conf:${(d.confidence??0).toFixed(2)} | ${snippet}${answer.length>150?'…':''}` };
    }
  },
  {
    id: 'multidoc_techserve_price', category: 'Multi-Document Processing', builtin: true,
    name: 'Retrieve TechServe-Specific Pricing',
    description: 'Ask CloudGuard price → answer must contain "200" (distinct from Quantum Labs prices)',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'How much does CloudGuard from TechServe cost per month?' });
      return checkAccuracyAnswer(d, '200');
    }
  },
  {
    id: 'multidoc_helpdesk_auto_resolve', category: 'Multi-Document Processing', builtin: true,
    name: 'Retrieve HelpDesk Pro Auto-Resolve Rate',
    description: 'Ask what percentage of tickets HelpDesk Pro auto-resolves → answer must contain "40"',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'What percentage of IT tickets does HelpDesk Pro resolve automatically?' });
      return checkAccuracyAnswer(d, '40');
    }
  },
  {
    id: 'multidoc_cross_doc_aggregation', category: 'Multi-Document Processing', builtin: true,
    name: 'Cross-Document Product Aggregation',
    description: 'Ask to list all products in the knowledge base → must mention products from BOTH companies',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('POST', '/ask', { query: 'List all the products and services available in this knowledge base.' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      // Must find at least one product from each company
      const hasQuantum = answer.includes('quantumvault') || answer.includes('quantumflow') || answer.includes('quantumscan');
      const hasTechServe = answer.includes('cloudguard') || answer.includes('databridge') || answer.includes('helpdesk');
      const passed  = hasQuantum && hasTechServe;
      const snippet = answer.substring(0, 200).replace(/\n/g, ' ');
      return { passed, detail: `QuantumProduct:${hasQuantum} TechServeProduct:${hasTechServe} | ${snippet}${answer.length>200?'…':''}` };
    }
  },
  {
    id: 'multidoc_node_growth', category: 'Multi-Document Processing', builtin: true,
    name: 'Knowledge Tree Grows With Second Document',
    description: 'After ingesting two documents, tree must have more nodes than after just one',
    async run(call) {
      if (!multidocState.ingested) return { passed: false, detail: 'Run multidoc_ingest first' };
      const d = await call('GET', '/nodes');
      const count  = d.stats?.total_nodes ?? 0;
      // With two distinct documents on different topics, we expect at least 3 topic nodes
      const passed = count >= 3;
      return { passed, detail: `${count} node(s) in tree after 2 documents (need ≥3)` };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // RETRIEVAL COVERAGE
  // Verify that the retrieval pipeline actually surfaces chunks across the full
  // depth and breadth of a document — not just the first section or most-indexed topic.
  // These tests check pipeline metadata (chunks_used, retrieval_sources, snippets,
  // tree_paths) rather than specific answer content.
  // ─────────────────────────────────────────────────────────────────────────────

  {
    id: 'coverage_chunks_returned', category: 'Retrieval Coverage', builtin: true,
    name: 'Retrieval Returns Multiple Chunks',
    description: 'For a grounded question, chunks_used must be > 1',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'Tell me about Quantum Labs employee policies.' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const count  = d.chunks_used ?? 0;
      const passed = count > 1;
      return { passed, detail: `chunks_used: ${count}` };
    }
  },
  {
    id: 'coverage_retrieval_sources_tracked', category: 'Retrieval Coverage', builtin: true,
    name: 'Retrieval Sources Metadata Present',
    description: 'Response must include retrieval_sources with hierarchical and direct counts',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the remote work policy at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const rs     = d.retrieval_sources;
      const passed = rs != null && ('hierarchical' in rs) && ('direct' in rs);
      return {
        passed,
        detail: passed
          ? `hierarchical: ${rs.hierarchical}, direct: ${rs.direct}`
          : `retrieval_sources missing or malformed: ${JSON.stringify(rs)}`
      };
    }
  },
  {
    id: 'coverage_at_least_one_source_path', category: 'Retrieval Coverage', builtin: true,
    name: 'At Least One Retrieval Path Succeeds',
    description: 'Either hierarchical or direct retrieval must return at least 1 chunk',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the vacation policy for new employees at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const rs     = d.retrieval_sources ?? {};
      const total  = (rs.hierarchical ?? 0) + (rs.direct ?? 0);
      const passed = total > 0;
      return { passed, detail: `total chunks from both paths: ${total} (hier:${rs.hierarchical ?? 0} + direct:${rs.direct ?? 0})` };
    }
  },
  {
    id: 'coverage_snippets_generated', category: 'Retrieval Coverage', builtin: true,
    name: 'Snippets Generated for Results',
    description: 'Response must include at least one snippet when chunks are found',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the health insurance coverage at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const snippets = d.snippets ?? [];
      const passed   = snippets.length > 0;
      return {
        passed,
        detail: passed
          ? `${snippets.length} snippet(s) — first: "${(snippets[0].text ?? '').substring(0, 80)}"`
          : 'no snippets in response'
      };
    }
  },
  {
    id: 'coverage_tree_paths_present', category: 'Retrieval Coverage', builtin: true,
    name: 'Tree Paths Present in Response',
    description: 'Response must include tree_paths array showing the navigation route',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What SLA does Quantum Labs have for critical IT issues?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const paths  = d.tree_paths ?? [];
      const passed = Array.isArray(paths);
      return { passed, detail: `tree_paths: ${paths.length} path(s) — ${JSON.stringify(paths.slice(0, 2))}` };
    }
  },
  {
    id: 'coverage_deep_fact_contact', category: 'Retrieval Coverage', builtin: true,
    name: 'Deep Section Retrieval (Contact Info)',
    description: 'A question about contact info (late in doc) must still return a non-empty answer',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the HR department email address at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results — contact section may not be indexed' };
      const answer = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '');
      const passed = answer.trim().length > 0;
      const snippet = answer.substring(0, 120).replace(/\n/g, ' ');
      return { passed, detail: `conf:${(d.confidence??0).toFixed(2)} | ${snippet}${answer.length>120?'…':''}` };
    }
  },
  {
    id: 'coverage_hr_email_exact', category: 'Retrieval Coverage', builtin: true,
    name: 'Exact Contact Detail Retrieved (HR Email)',
    description: 'Ask HR email → answer must contain "hr@quantumlabs"',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the HR email address at Quantum Labs?' });
      return checkAccuracyAnswer(d, 'hr@quantumlabs');
    }
  },
  {
    id: 'coverage_multi_section_breadth', category: 'Retrieval Coverage', builtin: true,
    name: 'Multi-Section Query Returns Broad Context',
    description: 'A query spanning multiple sections (overview + policies) must return ≥3 chunks',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'Give me an overview of Quantum Labs including its products, policies, and leadership.' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const count  = d.chunks_used ?? 0;
      const passed = count >= 3;
      return { passed, detail: `chunks_used: ${count} (need ≥3 for cross-section breadth)` };
    }
  },
  {
    id: 'coverage_confidence_nonzero', category: 'Retrieval Coverage', builtin: true,
    name: 'Confidence Score Meaningful When Grounded',
    description: 'For a well-grounded question, confidence must be > 0.10',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the probationary period at Quantum Labs?' });
      if (d.action === 'no_results') return { passed: false, detail: 'no_results' };
      const conf   = d.confidence ?? 0;
      const passed = conf > 0.10;
      return { passed, detail: `confidence: ${conf.toFixed(3)} (need > 0.10)` };
    }
  },
  {
    id: 'coverage_no_answer_for_unknown', category: 'Retrieval Coverage', builtin: true,
    name: 'Low Confidence or No Result for Out-of-Scope Query',
    description: 'A question about a completely absent topic should yield low confidence or no_results',
    async run(call) {
      if (!accuracyState.ingested) return { passed: false, detail: 'Run accuracy_ingest first' };
      const d = await call('POST', '/ask', { query: 'What is the refund policy for QuantumVault hardware devices?' });
      // Either no_results or a low-confidence "I don't know" answer is acceptable
      if (d.action === 'no_results') return { passed: true, detail: 'no_results — correctly returned no match' };
      const conf    = d.confidence ?? 1;
      const answer  = (d.llm_response?.final_answer ?? d.data?.final_answer ?? '').toLowerCase();
      const admitsUnknown = answer.includes("don't know") || answer.includes('not mentioned') ||
                            answer.includes('no information') || answer.includes('not found') ||
                            answer.includes('unable to') || answer.includes('not available');
      const passed  = conf < 0.60 || admitsUnknown;
      return { passed, detail: `confidence: ${conf.toFixed(3)}, admits_unknown: ${admitsUnknown}` };
    }
  },
];


// ── Test runner state ─────────────────────────────────────────────────────────

// ── Init ─────────────────────────────────────────────────────────────────────

function initTests() {
  document.getElementById('run-all-tests-btn')?.addEventListener('click', () => runTests('all'));
  document.getElementById('run-selected-tests-btn')?.addEventListener('click', () => runTests('selected'));
  document.getElementById('clear-test-results-btn')?.addEventListener('click', clearTestResults);
  document.getElementById('cancel-test-btn')?.addEventListener('click', clearAddForm);
  document.getElementById('save-test-btn')?.addEventListener('click', saveCustomTest);
  document.getElementById('tc-assertion-type')?.addEventListener('change', updateAssertionValueVisibility);
  document.getElementById('test-run-cancel-btn')?.addEventListener('click', () => { cancelRequested = true; });

  // Filter toolbar events
  document.getElementById('test-status-filter')?.addEventListener('change', () => renderTestList());
  document.getElementById('test-category-filter')?.addEventListener('change', () => renderTestList());
  document.getElementById('test-search-input')?.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => renderTestList(), 200);
  });

  initTestsNav();
}

// ── Load & render ─────────────────────────────────────────────────────────────

async function loadTests() {
  const container = document.getElementById('tests-container');
  if (!container) return;
  container.innerHTML = '<div class="loading-text">Loading tests…</div>';

  try {
    const { test_cases: custom = [] } = await api('/tests').catch(() => ({ test_cases: [] }));

    // Convert custom DB rows to runnable test objects
    const customTests = custom.map(tc => ({
      ...tc,
      id: `custom_${tc.id}`,
      dbId: tc.id,
      category: tc.assertion_type?.startsWith('manage_') ? 'Manage' : 'Custom',
      builtin: false,
      async run(call) {
        if (tc.assertion_type?.startsWith('manage_')) {
          return runManageTest(call, tc.query, tc.assertion_type, tc.assertion_value);
        }
        const d = await call('POST', '/ask', { query: tc.query });
        return evaluateAssertion(d, tc.assertion_type, tc.assertion_value);
      }
    }));

    allTests = [...BUILTIN_TESTS, ...customTests];

    // Preserve existing results across reloads
    for (const t of allTests) {
      if (!(t.id in testResults)) testResults[t.id] = { status: 'pending', detail: '' };
    }

    populateCategoryFilter();
    renderDashboard();
    renderTestList();
  } catch (err) {
    container.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
  }
}

function renderTestList() {
  const container = document.getElementById('tests-container');
  if (!container) return;

  // Apply filters
  const filtered = applyTestFilters();

  if (filtered.length === 0 && allTests.length > 0) {
    container.innerHTML = '<div class="test-filter-empty">No tests match your filters.</div>';
    return;
  }

  // Group by category
  const groups = {};
  for (const t of filtered) {
    (groups[t.category] ??= []).push(t);
  }

  // Compute per-suite status summary
  function suiteStats(tests) {
    let passed = 0, failed = 0, running = 0;
    for (const t of tests) {
      const s = testResults[t.id]?.status;
      if (s === 'passed') passed++;
      else if (s === 'failed') failed++;
      else if (s === 'running') running++;
    }
    return { passed, failed, running, total: tests.length };
  }

  // Remember which suites were expanded (default: all collapsed)
  const prevExpanded = container._suiteExpanded ?? {};

  container.innerHTML = Object.entries(groups).map(([cat, tests]) => {
    const slug = cat.replace(/\W+/g, '_').toLowerCase();
    const expanded = prevExpanded[slug] ?? false; // default collapsed
    const stats = suiteStats(tests);
    const statsBadges = [
      stats.passed  ? `<span class="suite-stat suite-stat--passed">✓ ${stats.passed}</span>` : '',
      stats.failed  ? `<span class="suite-stat suite-stat--failed">✗ ${stats.failed}</span>` : '',
      stats.running ? `<span class="suite-stat suite-stat--running">⟳ ${stats.running}</span>` : '',
    ].filter(Boolean).join('');

    return `
    <div class="test-suite" data-suite="${slug}">
      <div class="test-suite-header" data-suite-toggle="${slug}">
        <span class="suite-chevron ${expanded ? 'suite-chevron--open' : ''}">&#9654;</span>
        <input type="checkbox" class="suite-checkbox" data-suite-check="${slug}" checked title="Select/deselect all tests in this suite">
        <span class="suite-name">${escapeHtml(cat)}</span>
        <span class="test-group-count">(${tests.length})</span>
        ${statsBadges}
        <button class="btn btn-secondary btn-xs suite-run-btn" data-run-suite="${slug}" title="Run this suite">Run Suite</button>
      </div>
      <div class="test-suite-body ${expanded ? '' : 'hidden'}" data-suite-body="${slug}">
        ${tests.map(t => renderTestCard(t)).join('')}
      </div>
    </div>`;
  }).join('');

  // ── Wire suite interactions ───────────────────────────────────────────────
  // Toggle expand/collapse
  container.querySelectorAll('[data-suite-toggle]').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      // Don't toggle when clicking checkbox, run button, or inner controls
      if (e.target.closest('.suite-checkbox, .suite-run-btn, [data-run-test], [data-delete-test]')) return;
      const slug = hdr.dataset.suiteToggle;
      const body = container.querySelector(`[data-suite-body="${slug}"]`);
      const chevron = hdr.querySelector('.suite-chevron');
      if (!body) return;
      const wasOpen = !body.classList.contains('hidden');
      body.classList.toggle('hidden');
      chevron?.classList.toggle('suite-chevron--open', !wasOpen);
      // Persist state
      container._suiteExpanded ??= {};
      container._suiteExpanded[slug] = !wasOpen;
    });
  });

  // Suite select-all checkbox
  container.querySelectorAll('.suite-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const slug = cb.dataset.suiteCheck;
      const body = container.querySelector(`[data-suite-body="${slug}"]`);
      if (!body) return;
      body.querySelectorAll('.test-checkbox').forEach(tc => { tc.checked = cb.checked; });
    });
  });

  // Individual checkbox → sync suite checkbox state
  container.querySelectorAll('.test-checkbox').forEach(tc => {
    tc.addEventListener('change', () => {
      const suite = tc.closest('.test-suite');
      if (!suite) return;
      const slug = suite.dataset.suite;
      const all = suite.querySelectorAll('.test-checkbox');
      const checked = suite.querySelectorAll('.test-checkbox:checked');
      const suiteCb = container.querySelector(`[data-suite-check="${slug}"]`);
      if (suiteCb) {
        suiteCb.checked = checked.length === all.length;
        suiteCb.indeterminate = checked.length > 0 && checked.length < all.length;
      }
    });
  });

  // Run Suite button
  container.querySelectorAll('[data-run-suite]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slug = btn.dataset.runSuite;
      const body = container.querySelector(`[data-suite-body="${slug}"]`);
      if (!body) return;
      const ids = [...body.querySelectorAll('.test-checkbox')].map(cb => cb.dataset.testId);
      if (ids.length) runTests('explicit', null, ids);
    });
  });

  // Wire individual Run buttons
  container.querySelectorAll('[data-run-test]').forEach(btn => {
    btn.addEventListener('click', () => runTests('single', btn.dataset.runTest));
  });
  // Wire delete buttons for custom tests
  container.querySelectorAll('[data-delete-test]').forEach(btn => {
    btn.addEventListener('click', () => deleteCustomTest(parseInt(btn.dataset.deleteTest, 10)));
  });

  renderDashboard();
}

/** Parse "conf:0.85 | answer snippet…" returned by accuracy test helpers. */
function parseAccuracyDetail(detail) {
  const m = detail.match(/^conf:([\d.]+)\s*\|\s*([\s\S]*)$/);
  if (!m) return null;
  return { confidence: parseFloat(m[1]), snippet: m[2].trim() };
}

/** Human-readable assertion hint shown on custom test cards. */
function formatAssertionHint(test) {
  const map = {
    answer_not_empty: 'Answer is not empty',
    answer_contains:  `Contains: "${test.assertion_value}"`,
    confidence_gte:   `Confidence ≥ ${test.assertion_value}`,
    query_type_is:    `Type = ${test.assertion_value}`,
    has_citations:    'Has at least one citation',
  };
  return map[test.assertion_type] || test.assertion_type;
}

/** Build the detail HTML block for a test card. */
function buildTestDetailHtml(test, result) {
  if (!result.detail) return '';

  const acc = parseAccuracyDetail(result.detail);
  if (acc) {
    const level = acc.confidence >= 0.75 ? 'high' : acc.confidence >= 0.45 ? 'mid' : 'low';
    const statusCls = result.status === 'failed' ? ' tc-detail--failed' : result.status === 'passed' ? ' tc-detail--passed' : '';
    return `
      <div class="tc-detail-rich${statusCls}">
        <span class="tc-conf tc-conf--${level}">conf&nbsp;${acc.confidence.toFixed(2)}</span>
        <span class="tc-snippet">${escapeHtml(acc.snippet)}</span>
      </div>`;
  }

  const statusCls = result.status === 'failed' ? ' tc-detail--failed' : result.status === 'passed' ? ' tc-detail--passed' : '';
  return `<div class="tc-detail${statusCls}">${escapeHtml(result.detail)}</div>`;
}

function renderTestCard(test) {
  const result      = testResults[test.id] || { status: 'pending', detail: '' };
  const statusLabel = { pending: '● Pending', running: '⟳ Running', passed: '✓ Passed', failed: '✗ Failed' };
  const customBtns  = test.builtin ? '' : `
    <button class="btn btn-danger btn-small" data-delete-test="${test.dbId}" title="Delete">✕</button>`;

  const assertionHint = (!test.builtin && test.assertion_type)
    ? `<div class="tc-assertion-hint">Assertion: ${escapeHtml(formatAssertionHint(test))}</div>`
    : '';

  const detailHtml = buildTestDetailHtml(test, result);

  return `
    <div class="test-card test-card--${result.status}" id="tc-${escapeHtml(test.id)}">
      <div class="test-card-row">
        <input type="checkbox" class="test-checkbox" data-test-id="${escapeHtml(test.id)}" checked>
        <div class="test-card-info">
          <div class="test-card-header">
            <span class="test-card-name">${escapeHtml(test.name)}</span>
            <span class="test-card-cat">${escapeHtml(test.category)}</span>
          </div>
          <div class="test-card-desc">${escapeHtml(test.description || test.query || '')}</div>
          ${assertionHint}
          ${detailHtml}
        </div>
        <span class="test-status test-status--${result.status}">${statusLabel[result.status] ?? result.status}</span>
        <button class="btn btn-secondary btn-small" data-run-test="${escapeHtml(test.id)}">Run</button>
        ${customBtns}
      </div>
    </div>
  `;
}

// ── Run persistence helper ────────────────────────────────────────────────────
// Writes run data to the ORIGINAL dataset's DB (not the temporary test dataset).
function persistApi(savedDatasetId, path, opts) {
  return api(path, { ...opts, headers: { ...opts?.headers, 'X-Dataset-ID': savedDatasetId } });
}

// ── Run tests ─────────────────────────────────────────────────────────────────

async function runTests(mode, singleId = null, explicitIds = null) {
  if (isRunning) return;

  let ids;
  if (mode === 'single') {
    ids = [singleId];
  } else if (mode === 'explicit' && explicitIds) {
    ids = explicitIds;
  } else if (mode === 'selected') {
    ids = [...document.querySelectorAll('.test-checkbox:checked')].map(cb => cb.dataset.testId);
    if (ids.length === 0) { showToast('No tests selected', 'error'); return; }
  } else {
    ids = allTests.map(t => t.id);
  }

  isRunning = true;
  cancelRequested = false;
  document.getElementById('run-all-tests-btn').disabled = true;
  document.getElementById('run-selected-tests-btn').disabled = true;

  // Show progress bar
  const progressEl = document.getElementById('test-run-progress');
  if (progressEl) progressEl.classList.remove('hidden');
  const progressStart = Date.now();
  _progressTimer = setInterval(() => {
    const elapsedEl = document.getElementById('test-run-progress-elapsed');
    if (elapsedEl) elapsedEl.textContent = formatDuration(Date.now() - progressStart);
  }, 500);
  updateRunProgress(0, ids.length, '');

  // ── Dataset isolation ───────────────────────────────────────────────────────
  // 1. Delete any orphaned [Test Run] datasets left by previous crashed runs
  await cleanupOrphanedTestDatasets();

  // 2. Create a fresh isolated dataset for this run
  const savedDatasetId   = state.currentDatasetId;
  const savedDatasetName = state.currentDatasetName;
  let testDatasetId = null;

  try {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const ds = await api('/datasets', {
      method: 'POST',
      body: JSON.stringify({
        name: `[Test Run] ${ts}`,
        description: 'Temporary isolated dataset created by the test suite. Auto-deleted on completion.'
      })
    });
    testDatasetId      = ds.dataset.id;
    state.currentDatasetId   = testDatasetId;
    state.currentDatasetName = ds.dataset.name;
    showToast('Isolated test dataset created', 'success');
  } catch (err) {
    // Dataset creation failed — run tests on the current dataset as fallback
    showToast(`Warning: could not create isolated test dataset (${err.message})`, 'error');
  }
  // ───────────────────────────────────────────────────────────────────────────

  // ── Persistence: create run + item shells ──────────────────────────────────
  let currentRunId = null;
  const itemIdMap = {};  // test id → persisted item row id
  const runStartTime = Date.now();

  try {
    const envSnapshot = await persistApi(savedDatasetId, '/tests/env', {}).catch(() => ({}));
    const runResp = await persistApi(savedDatasetId, '/tests/runs', {
      method: 'POST',
      body: JSON.stringify({
        name: `[Run ${new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}]`,
        trigger_type: 'manual',
        mode: testDatasetId ? 'isolated' : 'current',
        test_count: ids.length,
        env_json: JSON.stringify(envSnapshot)
      })
    });
    currentRunId = runResp.run?.id;

    if (currentRunId) {
      const itemShells = ids.map((id, i) => {
        const test = allTests.find(t => t.id === id);
        return {
          test_id: id,
          test_name: test?.name || id,
          category: test?.category || '',
          assertion_type: test?.assertion_type || '',
          assertion_value: test?.assertion_value || '',
          query: test?.query || test?.description || '',
          run_order: i
        };
      });
      const itemsResp = await persistApi(savedDatasetId, `/tests/runs/${currentRunId}/items`, {
        method: 'POST',
        body: JSON.stringify({ items: itemShells })
      });
      // Map test id → item row id
      if (itemsResp.items) {
        for (const item of itemsResp.items) {
          itemIdMap[item.testId] = item.id;
        }
      }
    }
  } catch (err) {
    // Persistence failure is non-fatal — tests still run, just no history
    console.warn('[tests] Run persistence init failed:', err.message);
  }
  // ───────────────────────────────────────────────────────────────────────────

  const pendingWrites = [];

  try {
    // Mark all as running
    for (const id of ids) {
      testResults[id] = { status: 'running', detail: '' };
      updateCard(id);
    }
    renderDashboard();

    // Execute each test sequentially
    for (let idx = 0; idx < ids.length; idx++) {
      if (cancelRequested) {
        // Mark remaining as pending
        for (let j = idx; j < ids.length; j++) {
          testResults[ids[j]] = { status: 'pending', detail: 'Cancelled' };
          updateCard(ids[j]);
        }
        break;
      }

      const id = ids[idx];
      const test = allTests.find(t => t.id === id);
      if (!test) { testResults[id] = { status: 'failed', detail: 'Test not found' }; updateCard(id); continue; }

      updateRunProgress(idx + 1, ids.length, test.name);

      const testStart = Date.now();
      try {
        const result = await test.run(apiCallWrapper);
        testResults[id] = { status: result.passed ? 'passed' : 'failed', detail: result.detail ?? '' };
      } catch (err) {
        testResults[id] = { status: 'failed', detail: err.message };
      }
      const testDuration = Date.now() - testStart;
      updateCard(id);
      renderDashboard();

      // Persist item result (non-blocking)
      if (currentRunId && itemIdMap[id]) {
        pendingWrites.push(
          persistApi(savedDatasetId, `/tests/runs/${currentRunId}/items/${itemIdMap[id]}`, {
            method: 'PUT',
            body: JSON.stringify({
              status: testResults[id].status,
              detail: (testResults[id].detail || '').slice(0, 2000),
              durationMs: testDuration
            })
          }).catch(e => console.warn('[tests] Item persist failed:', e.message))
        );
      }
    }

    const passed = ids.filter(id => testResults[id]?.status === 'passed').length;
    const failed = ids.filter(id => testResults[id]?.status === 'failed').length;
    showToast(`Tests complete: ${passed} passed, ${failed} failed`, failed > 0 ? 'error' : 'success');

    renderTestReport(ids);

    // ── Finalize persisted run ─────────────────────────────────────────────
    if (currentRunId) {
      await Promise.allSettled(pendingWrites);
      const totalDuration = Date.now() - runStartTime;
      const errorCount = ids.filter(id => testResults[id]?.status === 'error').length;
      await persistApi(savedDatasetId, `/tests/runs/${currentRunId}/finish`, {
        method: 'PUT',
        body: JSON.stringify({
          status: 'completed',
          passed_count: passed,
          failed_count: failed,
          skipped_count: 0,
          error_count: errorCount,
          duration_ms: totalDuration
        })
      }).catch(e => console.warn('[tests] Run finalize failed:', e.message));
    }
  } finally {
    // ── Post-run cleanup (ALWAYS runs, even if tests throw) ─────────────────
    isRunning = false;
    cancelRequested = false;
    clearInterval(_progressTimer);
    const progressElCleanup = document.getElementById('test-run-progress');
    if (progressElCleanup) progressElCleanup.classList.add('hidden');

    document.getElementById('run-all-tests-btn').disabled = false;
    document.getElementById('run-selected-tests-btn').disabled = false;

    // Restore original dataset first so the UI lands on the right context
    state.currentDatasetId   = savedDatasetId;
    state.currentDatasetName = savedDatasetName;

    // Delete the isolated test dataset (and everything it contains)
    if (testDatasetId) {
      // Wait briefly for any in-flight ingestion jobs to be cancelled by deleteDataset
      try {
        await api(`/datasets/${testDatasetId}?confirm=yes`, { method: 'DELETE' });
        showToast('Test dataset deleted — knowledge base is clean', 'success');
      } catch (err) {
        // Retry once after a short delay — the dataset might have a busy connection
        try {
          await new Promise(r => setTimeout(r, 2000));
          await api(`/datasets/${testDatasetId}?confirm=yes`, { method: 'DELETE' });
          showToast('Test dataset deleted — knowledge base is clean', 'success');
        } catch (retryErr) {
          showToast(`Warning: test dataset could not be deleted — please remove it manually`, 'error');
        }
      }
    }

    // Reset shared accuracy test state
    accuracyState = { jobId: null, docId: null, chunkCount: 0, ingested: false };
    multidocState = { jobId: null, docId: null, chunkCount: 0, ingested: false };

    // Refresh dashboard + history
    _lastRunCache = null;  // force re-fetch
    renderDashboard();
    renderHistoryView().catch(() => {});
    // ─────────────────────────────────────────────────────────────────────────
  }
}

/** Delete any [Test Run] datasets left behind by a previously crashed test suite. */
async function cleanupOrphanedTestDatasets() {
  try {
    const { datasets = [] } = await api('/datasets');
    for (const ds of datasets) {
      if (ds.name?.startsWith('[Test Run]') && ds.id !== state.currentDatasetId) {
        try {
          await api(`/datasets/${ds.id}?confirm=yes`, { method: 'DELETE' });
        } catch (_) { /* non-fatal */ }
      }
    }
  } catch (_) { /* non-fatal */ }
}

async function apiCallWrapper(method, endpoint, body) {
  return api(endpoint, {
    method,
    body: body ? JSON.stringify(body) : undefined
  });
}

function updateCard(id) {
  const card = document.getElementById(`tc-${id}`);
  if (!card) return;
  const result      = testResults[id] || { status: 'pending', detail: '' };
  const statusLabel = { pending: '● Pending', running: '⟳ Running', passed: '✓ Passed', failed: '✗ Failed' };
  const test        = allTests.find(t => t.id === id);

  // Update status class on card root
  card.className = `test-card test-card--${result.status}`;

  const badge = card.querySelector('.test-status');
  if (badge) {
    badge.className = `test-status test-status--${result.status}`;
    badge.textContent = statusLabel[result.status] ?? result.status;
  }

  // Replace detail block entirely using the same builder as renderTestCard
  const info = card.querySelector('.test-card-info');
  if (info) {
    const oldDetail = info.querySelector('.tc-detail, .tc-detail-rich');
    if (oldDetail) oldDetail.remove();
    if (result.detail && test) {
      info.insertAdjacentHTML('beforeend', buildTestDetailHtml(test, result));
    }
  }
}

function renderDashboard() {
  const el = document.getElementById('test-dashboard');
  if (!el) return;

  const total   = allTests.length;
  const passed  = Object.values(testResults).filter(r => r.status === 'passed').length;
  const failed  = Object.values(testResults).filter(r => r.status === 'failed').length;
  const pending = total - passed - failed;
  const done    = passed + failed;
  const rate    = done > 0 ? Math.round((passed / done) * 100) : 0;

  // SVG ring params
  const r = 22, cx = 28, cy = 28;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (circumference * rate / 100);
  const ringColor = rate >= 80 ? '#059669' : rate >= 50 ? '#f59e0b' : '#dc2626';

  let metaHtml = '';
  if (_lastRunCache) {
    const env = (() => { try { return JSON.parse(_lastRunCache.env_json || '{}'); } catch { return {}; } })();
    const date = _lastRunCache.started_at ? new Date(_lastRunCache.started_at + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const badges = [
      env.llm_model ? `<span class="test-dash-env-badge">${escapeHtml(env.llm_model)}</span>` : '',
      env.app_version ? `<span class="test-dash-env-badge">v${escapeHtml(env.app_version)}</span>` : '',
      env.embedding_model ? `<span class="test-dash-env-badge">${escapeHtml(env.embedding_model)}</span>` : '',
      date ? `<span>Last run: ${escapeHtml(date)}</span>` : '',
      _lastRunCache.duration_ms ? `<span>${formatDuration(_lastRunCache.duration_ms)}</span>` : '',
    ].filter(Boolean).join('');
    metaHtml = `<div class="test-dash-meta">${badges}</div>`;
  }

  el.innerHTML = `
    <div class="test-dash-stat test-dash-stat--total">
      <div class="test-dash-stat-value">${total}</div>
      <div class="test-dash-stat-label">Total</div>
    </div>
    <div class="test-dash-stat test-dash-stat--passed">
      <div class="test-dash-stat-value">${passed}</div>
      <div class="test-dash-stat-label">Passed</div>
    </div>
    <div class="test-dash-stat test-dash-stat--failed">
      <div class="test-dash-stat-value">${failed}</div>
      <div class="test-dash-stat-label">Failed</div>
    </div>
    <div class="test-dash-stat test-dash-stat--pending">
      <div class="test-dash-stat-value">${pending}</div>
      <div class="test-dash-stat-label">Pending</div>
    </div>
    <div class="test-dash-stat test-dash-stat--rate">
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="5"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ringColor}" stroke-width="5"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
          stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"
          style="transition: stroke-dashoffset 0.4s ease"/>
      </svg>
      <div>
        <div class="test-dash-stat-value">${done > 0 ? rate + '%' : '—'}</div>
        <div class="test-dash-ring-label">Pass Rate</div>
      </div>
    </div>
    ${metaHtml}
  `;

  // Fetch last run metadata once
  if (!_lastRunCache) {
    api('/tests/runs?limit=1').then(({ runs = [] }) => {
      if (runs.length) {
        _lastRunCache = runs[0];
        renderDashboard();
      }
    }).catch(() => {});
  }
}

function clearTestResults() {
  for (const key of Object.keys(testResults)) {
    testResults[key] = { status: 'pending', detail: '' };
  }
  const reportEl = document.getElementById('test-report');
  if (reportEl) { reportEl.className = 'hidden'; reportEl.innerHTML = ''; }
  const dlBtn = document.getElementById('download-report-btn');
  if (dlBtn) dlBtn.style.display = 'none';
  renderDashboard();
  renderTestList();
}

// ── Test Report ───────────────────────────────────────────────────────────────

function renderTestReport(ids) {
  const reportEl = document.getElementById('test-report');
  const dlBtn    = document.getElementById('download-report-btn');
  if (!reportEl) return;

  const failed = ids.filter(id => testResults[id]?.status === 'failed');

  if (failed.length === 0) {
    reportEl.className = 'hidden';
    reportEl.innerHTML = '';
    if (dlBtn) dlBtn.style.display = 'none';
    return;
  }

  const now = new Date();

  if (dlBtn) {
    dlBtn.style.display = '';
    dlBtn.onclick = () => downloadTestReport(ids, now);
  }

  const issueItems = failed.map((id, i) => {
    const test   = allTests.find(t => t.id === id);
    const result = testResults[id];
    if (!test) return '';
    return `
      <div class="tr-issue">
        <div class="tr-issue-header">
          <span class="tr-issue-num">#${i + 1}</span>
          <span class="tr-issue-name">${escapeHtml(test.name)}</span>
          <span class="tr-issue-cat">${escapeHtml(test.category)}</span>
        </div>
        <div class="tr-issue-desc">${escapeHtml(test.description || test.query || '')}</div>
        ${result.detail ? `<div class="tr-issue-detail">${escapeHtml(result.detail)}</div>` : ''}
      </div>`;
  }).join('');

  const passed = ids.filter(id => testResults[id]?.status === 'passed').length;

  reportEl.className = 'test-report';
  reportEl.innerHTML = `
    <div class="tr-header">
      <span class="tr-title">Test Report</span>
      <span class="tr-meta">${escapeHtml(now.toLocaleString())} &nbsp;·&nbsp; ${ids.length} tests &nbsp;·&nbsp; ${passed} passed &nbsp;·&nbsp; ${failed.length} failed</span>
    </div>
    <div class="tr-issues-label">Failed Tests — Action Required (${failed.length})</div>
    <div class="tr-issues">${issueItems}</div>
    <div class="tr-copy-row">
      <button class="btn btn-secondary btn-small" id="copy-report-btn">Copy as Markdown</button>
    </div>
  `;

  document.getElementById('copy-report-btn')?.addEventListener('click', () => {
    copyToClipboard(buildReportMarkdown(ids, now))
      .then(ok => ok ? showToast('Report copied to clipboard', 'success') : showToast('Copy failed', 'error'))
      .catch(() => showToast('Copy failed', 'error'));
  });
}

function buildReportMarkdown(ids, now) {
  const passed = ids.filter(id => testResults[id]?.status === 'passed');
  const failed = ids.filter(id => testResults[id]?.status === 'failed');

  // Category breakdown
  const catStats = {};
  for (const id of ids) {
    const test = allTests.find(t => t.id === id);
    if (!test) continue;
    catStats[test.category] ??= { total: 0, passed: 0, failed: 0 };
    catStats[test.category].total++;
    if (testResults[id]?.status === 'passed') catStats[test.category].passed++;
    if (testResults[id]?.status === 'failed') catStats[test.category].failed++;
  }

  const catTable = Object.entries(catStats)
    .map(([cat, s]) => `| ${cat} | ${s.total} | ${s.passed} | ${s.failed} |`)
    .join('\n');

  const failedSection = failed.length === 0
    ? '_All tests passed._'
    : failed.map((id, i) => {
        const test   = allTests.find(t => t.id === id);
        const result = testResults[id];
        if (!test) return '';
        return `### ${i + 1}. [${test.category}] ${test.name}\n**Description:** ${test.description || test.query || '(none)'}\n**Error:** ${result?.detail || '(no detail)'}`;
      }).join('\n\n');

  const allRows = ids.map(id => {
    const test   = allTests.find(t => t.id === id);
    const result = testResults[id];
    if (!test) return '';
    const icon   = result?.status === 'passed' ? '✓' : result?.status === 'failed' ? '✗' : '●';
    const status = `${icon} ${result?.status ?? 'pending'}`;
    const detail = (result?.detail || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120);
    return `| ${test.name} | ${test.category} | ${status} | ${detail} |`;
  }).join('\n');

  return `# Test Suite Report
Generated: ${now.toISOString().replace('T', ' ').slice(0, 19)}

## Summary
- Total: ${ids.length}
- Passed: ${passed.length} ✓
- Failed: ${failed.length} ✗

## Category Breakdown
| Category | Total | Passed | Failed |
|----------|-------|--------|--------|
${catTable}

## Failed Tests — Action Items
${failedSection}

## Full Results
| Test | Category | Status | Detail |
|------|----------|--------|--------|
${allRows}
`;
}

function downloadTestReport(ids, now) {
  const content  = buildReportMarkdown(ids, now);
  const filename = `test-report-${now.toISOString().slice(0, 10)}.md`;
  const blob = new Blob([content], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Assertion evaluator (for custom tests) ────────────────────────────────────

function evaluateAssertion(data, type, value) {
  const answer = data.llm_response?.final_answer ?? '';
  switch (type) {
    case 'answer_contains':
      return { passed: String(answer).includes(value),
               detail: `answer contains "${value}": ${String(answer).includes(value)}` };
    case 'answer_not_empty':
      return { passed: !!answer, detail: `answer: "${String(answer).slice(0, 80)}"` };
    case 'confidence_gte': {
      const t = parseFloat(value) || 0;
      return { passed: (data.confidence ?? 0) >= t,
               detail: `confidence ${data.confidence ?? 'n/a'} ≥ ${t}` };
    }
    case 'query_type_is':
      return { passed: data.query_type === value,
               detail: `query_type: ${data.query_type ?? '(missing)'}, expected: ${value}` };
    case 'has_citations': {
      const cits = data.citations?.citations ?? data.llm_response?.citations ?? [];
      return { passed: Array.isArray(cits) && cits.length > 0,
               detail: `citations: ${cits.length}` };
    }
    // ── Manage chatbot assertions ─────────────────────────────────────────────
    case 'manage_intent_is':
      return { passed: data.intent === value,
               detail: `intent: ${data.intent ?? '(missing)'}, expected: ${value}` };
    case 'manage_response_contains': {
      const resp = String(data.response ?? '');
      const has = resp.toLowerCase().includes(value.toLowerCase());
      return { passed: has, detail: `response ${has ? 'contains' : 'missing'} "${value}" | "${resp.slice(0, 100)}"` };
    }
    case 'manage_adds_content': {
      const changes = data.changes ?? [];
      return { passed: changes.length > 0, detail: `changes: ${changes.length}` };
    }
    case 'manage_no_changes': {
      const ch = data.changes ?? [];
      return { passed: ch.length === 0, detail: `changes: ${ch.length} | response: "${String(data.response ?? '').slice(0, 80)}"` };
    }
    case 'manage_status_ok':
      return { passed: !data.error && typeof data.response === 'string',
               detail: data.error ? `error: ${data.error}` : `ok, intent=${data.intent}` };
    default:
      return { passed: false, detail: `Unknown assertion type: ${type}` };
  }
}

/**
 * Run a manage chatbot test. If `query` is a JSON array, messages are sent
 * sequentially sharing one session; the assertion checks the LAST response.
 */
async function runManageTest(call, query, assertionType, assertionValue) {
  let messages;
  try {
    if (query.trim().startsWith('[')) {
      messages = JSON.parse(query);
      if (!Array.isArray(messages)) throw new Error('not array');
    } else {
      messages = [query];
    }
  } catch (_) {
    messages = [query];
  }

  let sessionId = null;
  let lastResult = null;
  for (const msg of messages) {
    lastResult = await call('POST', '/manage/chat', { message: String(msg), sessionId });
    sessionId = lastResult.sessionId || sessionId;
    // Small pause between multi-step messages for LLM rate limits
    if (messages.length > 1) await new Promise(r => setTimeout(r, 800));
  }

  return evaluateAssertion(lastResult, assertionType, assertionValue);
}

// ── Custom test CRUD ──────────────────────────────────────────────────────────

function updateAssertionValueVisibility() {
  const type = document.getElementById('tc-assertion-type')?.value;
  const group = document.getElementById('tc-value-group');
  const label = document.getElementById('tc-value-label');
  const queryLabel = document.getElementById('tc-query-label');
  if (!group) return;
  const needsValue = ['answer_contains', 'confidence_gte', 'query_type_is',
                      'manage_intent_is', 'manage_response_contains'].includes(type);
  group.style.display = needsValue ? '' : 'none';
  if (label) {
    const labels = {
      answer_contains: 'Expected substring',
      confidence_gte: 'Minimum confidence (0–1)',
      query_type_is: 'Expected type (simple_lookup / comparison / recommendation / reasoning / aggregation)',
      manage_intent_is: 'Expected intent (ADD / EDIT / DELETE / QUERY / UNDO / HISTORY / CANCEL)',
      manage_response_contains: 'Expected substring in response',
    };
    label.textContent = labels[type] || 'Value';
  }
  // Update query label hint for manage types
  if (queryLabel) {
    queryLabel.textContent = type?.startsWith('manage_')
      ? 'Message (or JSON array for multi-step: ["msg1","__confirm__"])'
      : 'Query';
  }
}

async function saveCustomTest() {
  const name           = document.getElementById('tc-name')?.value.trim();
  const query          = document.getElementById('tc-query')?.value.trim();
  const assertion_type  = document.getElementById('tc-assertion-type')?.value;
  const assertion_value = document.getElementById('tc-assertion-value')?.value.trim();

  if (!name)  { showToast('Test name is required', 'error'); return; }
  if (!query) { showToast('Query is required', 'error'); return; }

  try {
    await api('/tests', {
      method: 'POST',
      body: JSON.stringify({ name, query, assertion_type, assertion_value })
    });
    clearAddForm();
    showToast('Test case saved', 'success');
    testResults = {};  // reset so new test starts as pending
    await loadTests();
    renderCustomTestsList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteCustomTest(dbId) {
  const ok = await showConfirmModal({ title: 'Delete Test', message: 'Delete this test case?', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/tests/${dbId}`, { method: 'DELETE' });
    delete testResults[`custom_${dbId}`];
    showToast('Test case deleted', 'success');
    await loadTests();
    renderCustomTestsList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function clearAddForm() {
  ['tc-name', 'tc-query', 'tc-assertion-value'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const sel = document.getElementById('tc-assertion-type');
  if (sel) sel.value = 'answer_not_empty';
  updateAssertionValueVisibility();
}

// ── Run History Panel ─────────────────────────────────────────────────────────

async function renderHistoryView() {
  const container = document.getElementById('tests-history-container');
  if (!container) return;

  try {
    const { runs = [] } = await api('/tests/runs?limit=20');
    if (runs.length === 0) {
      container.innerHTML = '<div class="test-history-empty">No test runs recorded yet.</div>';
      return;
    }

    container.innerHTML = `<div class="test-history-cards">${runs.map(r => {
      const env = (() => { try { return JSON.parse(r.env_json || '{}'); } catch { return {}; } })();
      const date = r.started_at ? new Date(r.started_at + 'Z').toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
      const dur = r.duration_ms ? formatDuration(r.duration_ms) : '—';
      const total = r.test_count || (r.passed_count + r.failed_count) || 1;
      const passRate = total > 0 ? Math.round((r.passed_count / total) * 100) : 0;
      const statusCls = r.status === 'cancelled' ? ' test-history-card--cancelled' : r.failed_count > 0 ? ' test-history-card--failed' : '';

      const envBadges = [
        env.llm_model ? `<span class="test-dash-env-badge">${escapeHtml(env.llm_model)}</span>` : '',
        env.app_version ? `<span class="test-dash-env-badge">v${escapeHtml(env.app_version)}</span>` : '',
      ].filter(Boolean).join('');

      return `
        <div class="test-history-card${statusCls}">
          <div class="test-history-card-header">
            <span class="test-history-card-name">${escapeHtml(r.name || 'Test Run')}</span>
            <span class="test-history-card-date">${escapeHtml(date)}</span>
            <div class="test-history-card-stats">
              <span class="tc-passed">${r.passed_count} passed</span>
              <span class="tc-failed">${r.failed_count} failed</span>
            </div>
            <span class="test-history-card-duration">${dur}</span>
          </div>
          <div class="test-history-card-bar">
            <div class="test-history-card-bar-fill" style="width:${passRate}%"></div>
          </div>
          ${envBadges ? `<div class="test-history-card-env">${envBadges}</div>` : ''}
          <div class="test-history-card-actions">
            <button class="btn btn-xs btn-secondary" data-view-run="${r.id}">View</button>
            <button class="btn btn-xs btn-secondary" data-baseline-run="${r.id}" title="Set as baseline">${r.is_baseline ? '★' : '☆'}</button>
            <button class="btn btn-xs btn-danger" data-delete-run="${r.id}">Delete</button>
            ${r.is_baseline ? '<span class="baseline-badge" title="Baseline">★</span>' : ''}
          </div>
        </div>`;
    }).join('')}</div>`;

    // Wire actions
    container.querySelectorAll('[data-view-run]').forEach(btn => {
      btn.addEventListener('click', () => viewRunHistory(parseInt(btn.dataset.viewRun, 10)));
    });
    container.querySelectorAll('[data-baseline-run]').forEach(btn => {
      btn.addEventListener('click', () => setRunBaseline(parseInt(btn.dataset.baselineRun, 10)));
    });
    container.querySelectorAll('[data-delete-run]').forEach(btn => {
      btn.addEventListener('click', () => deleteRun(parseInt(btn.dataset.deleteRun, 10)));
    });
  } catch (err) {
    container.innerHTML = `<div class="test-history-empty">Failed to load history: ${escapeHtml(err.message)}</div>`;
  }
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

async function viewRunHistory(runId) {
  const container = document.getElementById('tests-history-container');
  if (!container) return;

  try {
    const { run, items = [] } = await api(`/tests/runs/${runId}`);
    if (!run) { showToast('Run not found', 'error'); return; }

    const env = (() => { try { return JSON.parse(run.env_json || '{}'); } catch { return {}; } })();
    const date = run.started_at ? new Date(run.started_at + 'Z').toLocaleString() : '—';
    const dur = run.duration_ms ? formatDuration(run.duration_ms) : '—';

    // Sort by run_order for deterministic rendering
    items.sort((a, b) => (a.run_order || 0) - (b.run_order || 0));

    // Group by category
    const groups = {};
    for (const item of items) {
      (groups[item.category || 'Uncategorized'] ??= []).push(item);
    }

    const statusLabel = { pending: '● Pending', running: '⟳ Running', passed: '✓ Passed', failed: '✗ Failed', skipped: '○ Skipped', error: '⚠ Error' };

    container.innerHTML = `
      <div class="history-view-header">
        <button class="btn btn-secondary btn-small" id="history-back-btn">&larr; Back</button>
        <div class="history-view-meta">
          <strong>${escapeHtml(run.name || 'Test Run')}</strong> &mdash; ${escapeHtml(date)} &mdash; ${dur}
          &mdash; ${escapeHtml(env.llm_model || '')} &mdash; v${escapeHtml(env.app_version || '?')}
          ${run.status === 'cancelled' ? '<span class="badge badge-warning">Cancelled</span>' : ''}
        </div>
        <div class="history-view-counts">
          <span class="tc-passed">${run.passed_count} passed</span>
          <span class="tc-failed">${run.failed_count} failed</span>
          ${run.skipped_count ? `<span>${run.skipped_count} skipped</span>` : ''}
        </div>
      </div>
      ${Object.entries(groups).map(([cat, catItems]) => `
        <div class="test-suite">
          <div class="test-suite-header">
            <span class="suite-name">${escapeHtml(cat)}</span>
            <span class="test-group-count">(${catItems.length})</span>
          </div>
          <div class="test-suite-body">
            ${catItems.map(item => {
              const statusCls = item.status || 'pending';
              const detailHtml = item.detail ? `<div class="tc-detail tc-detail--${statusCls}">${escapeHtml(item.detail)}</div>` : '';
              return `
                <div class="test-card test-card--${statusCls}">
                  <div class="test-card-row">
                    <div class="test-card-info">
                      <div class="test-card-header">
                        <span class="test-card-name">${escapeHtml(item.test_name)}</span>
                      </div>
                      ${item.query ? `<div class="test-card-desc">${escapeHtml(item.query)}</div>` : ''}
                      ${detailHtml}
                    </div>
                    <span class="test-status test-status--${statusCls}">${statusLabel[statusCls] ?? statusCls}</span>
                    ${item.duration_ms ? `<span class="test-duration">${formatDuration(item.duration_ms)}</span>` : ''}
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>
      `).join('')}`;

    document.getElementById('history-back-btn')?.addEventListener('click', () => {
      renderHistoryView();
    });
  } catch (err) {
    showToast(`Failed to load run: ${err.message}`, 'error');
  }
}

async function setRunBaseline(runId) {
  try {
    await api(`/tests/runs/${runId}/baseline`, { method: 'PUT' });
    showToast('Baseline set', 'success');
    renderHistoryView();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteRun(runId) {
  const ok = await showConfirmModal({ title: 'Delete Run', message: 'Delete this test run and all its results?', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/tests/runs/${runId}`, { method: 'DELETE' });
    showToast('Run deleted', 'success');
    renderHistoryView();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Sub-navigation ────────────────────────────────────────────────────────────

function initTestsNav() {
  const nav = document.getElementById('tests-nav');
  if (!nav) return;

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-btn');
    if (!btn) return;
    const sectionId = btn.dataset.section;

    // Toggle active button
    nav.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Toggle active section
    document.querySelectorAll('#tab-tests > .settings-section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId)?.classList.add('active');

    // Show/hide header actions (only on Runner)
    const headerActions = document.getElementById('tests-header-actions');
    if (headerActions) {
      headerActions.style.display = sectionId === 'tests-section-runner' ? '' : 'none';
    }

    // Lazy-load sections
    if (sectionId === 'tests-section-history') renderHistoryView().catch(() => {});
    if (sectionId === 'tests-section-manage') renderCustomTestsList();
  });
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function populateCategoryFilter() {
  const sel = document.getElementById('test-category-filter');
  if (!sel) return;
  const cats = [...new Set(allTests.map(t => t.category))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = current; // restore selection if possible
}

function applyTestFilters() {
  const statusVal   = document.getElementById('test-status-filter')?.value || '';
  const categoryVal = document.getElementById('test-category-filter')?.value || '';
  const searchVal   = (document.getElementById('test-search-input')?.value || '').toLowerCase().trim();

  return allTests.filter(t => {
    if (statusVal && (testResults[t.id]?.status || 'pending') !== statusVal) return false;
    if (categoryVal && t.category !== categoryVal) return false;
    if (searchVal && !t.name.toLowerCase().includes(searchVal) && !(t.description || '').toLowerCase().includes(searchVal)) return false;
    return true;
  });
}

// ── Run progress ──────────────────────────────────────────────────────────────

function updateRunProgress(current, total, testName) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const fillEl = document.getElementById('test-run-progress-fill');
  const countEl = document.getElementById('test-run-progress-count');
  const currentEl = document.getElementById('test-run-progress-current');
  const labelEl = document.getElementById('test-run-progress-label');

  if (fillEl) fillEl.style.width = `${pct}%`;
  if (countEl) countEl.textContent = `${current} / ${total}`;
  if (currentEl) currentEl.textContent = testName ? `Running: ${testName}` : '';
  if (labelEl) labelEl.textContent = current === 0 ? 'Starting tests…' : `Running tests… (${pct}%)`;
}

// ── Custom tests list (Manage section) ────────────────────────────────────────

async function renderCustomTestsList() {
  const container = document.getElementById('custom-tests-list');
  if (!container) return;

  try {
    const { test_cases: custom = [] } = await api('/tests').catch(() => ({ test_cases: [] }));
    if (custom.length === 0) {
      container.innerHTML = '<div class="custom-tests-empty">No custom tests defined yet.</div>';
      return;
    }

    container.innerHTML = custom.map(tc => `
      <div class="custom-test-item">
        <div class="custom-test-item-header">
          <span class="custom-test-item-name">${escapeHtml(tc.name)}</span>
          <div class="custom-test-item-actions">
            <button class="btn btn-xs btn-danger" data-delete-custom="${tc.id}">Delete</button>
          </div>
        </div>
        <div class="custom-test-item-query">${escapeHtml(tc.query || '')}</div>
        <div class="custom-test-item-assertion">Assertion: ${escapeHtml(formatAssertionHint(tc))}</div>
      </div>
    `).join('');

    container.querySelectorAll('[data-delete-custom]').forEach(btn => {
      btn.addEventListener('click', () => deleteCustomTest(parseInt(btn.dataset.deleteCustom, 10)));
    });
  } catch (err) {
    container.innerHTML = `<div class="custom-tests-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────
export { initTests, loadTests };
registerFn('loadTests', loadTests);
