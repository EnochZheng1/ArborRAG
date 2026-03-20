// ── Decisions + Tests + Settings + Prompts + Schema ──────────────────────────
import { state, API_BASE, _tabDirty } from './state.js';
import { api, escapeHtml, showToast, registerFn, callFn, copyToClipboard, showConfirmModal, showPromptModal } from './utils.js';
import { t } from './i18n.js';

// Module-level state
let testResults = {};
let allTests = [];
let isRunning = false;
let accuracyState = { jobId: null, docId: null, chunkCount: 0, ingested: false };
let multidocState = { jobId: null, docId: null, chunkCount: 0, ingested: false };
let _settingsOriginalProvider = null;
let _promptsData = [];
let _schemaPanelInitialized = false;
let _interviewState = {
  active: false,
  sessionId: null,
  phase: 'idle',
  messages: [],
  questionNumber: 0,
  generatedSchema: null
};
const PROVIDER_DEFAULTS = {
  openai: { model: 'gpt-4o-mini', embeddingModel: 'text-embedding-3-large' },
  gemini: { model: 'gemini-2.0-flash', embeddingModel: 'gemini-embedding-001' },
};

// ── Decisions Tab ─────────────────────────────────────────────────────────────

function initDecisions() {
  document.getElementById('refresh-decisions-btn')?.addEventListener('click', loadDecisions);
  document.getElementById('decisions-status-filter')?.addEventListener('change', loadDecisions);
  document.getElementById('decisions-action-filter')?.addEventListener('change', loadDecisions);
  document.getElementById('bulk-reject-btn')?.addEventListener('click', bulkRejectFiltered);
}

async function loadDecisions() {
  const list = document.getElementById('decisions-list');
  const statsDiv = document.getElementById('decisions-stats');
  if (!list) return;

  const statusFilter = document.getElementById('decisions-status-filter')?.value || 'pending';
  const actionFilter = document.getElementById('decisions-action-filter')?.value || '';

  try {
    list.innerHTML = '<p class="empty-state">Loading…</p>';

    const actionParam = actionFilter ? `&action=${encodeURIComponent(actionFilter)}` : '';
    const [{ decisions }, stats] = await Promise.all([
      api(`/decisions?status=${encodeURIComponent(statusFilter)}&limit=100${actionParam}`),
      api('/decisions/stats')
    ]);

    // Render stats row
    if (statsDiv) {
      const actionLabels = {
        value_conflict: 'Conflicts',
        replace_suggestion: 'Replacements',
        merge_suggestion: 'Merges',
        node_merge_suggestion: 'Node Merges'
      };
      const actionPills = (stats.by_action || [])
        .map(a => `<span class="decision-stat-pill decision-stat-action">${a.count} ${actionLabels[a.action] || a.action}</span>`)
        .join('');
      statsDiv.innerHTML = `
        <span class="decision-stat-pill decision-stat-pending">${stats.pending} pending</span>
        <span class="decision-stat-pill decision-stat-accepted">${stats.accepted} accepted</span>
        <span class="decision-stat-pill decision-stat-rejected">${stats.rejected} rejected</span>
        <span class="decision-stat-pill decision-stat-auto">${stats.auto_resolved} auto-resolved</span>
        ${actionPills}
      `;

      // Show bulk-reject button when viewing pending decisions with an action filter
      const bulkBtn = document.getElementById('bulk-reject-btn');
      if (bulkBtn) {
        const actionLabels = { value_conflict: 'Conflicts', replace_suggestion: 'Replacements', merge_suggestion: 'Merges', node_merge_suggestion: 'Node Merges' };
        if (statusFilter === 'pending' && actionFilter) {
          const count = (stats.by_action || []).find(a => a.action === actionFilter)?.count || 0;
          bulkBtn.style.display = count > 0 ? '' : 'none';
          bulkBtn.textContent = `Reject All ${actionLabels[actionFilter] || actionFilter} (${count})`;
        } else if (statusFilter === 'pending' && stats.pending > 0) {
          bulkBtn.style.display = '';
          bulkBtn.textContent = `Reject All Pending (${stats.pending})`;
        } else {
          bulkBtn.style.display = 'none';
        }
      }
    }

    if (!decisions.length) {
      list.innerHTML = `<p class="empty-state">No ${statusFilter === 'pending' ? 'pending ' : ''}decisions found.</p>`;
      return;
    }

    list.innerHTML = decisions.map(d => renderDecisionCard(d)).join('');

    list.querySelectorAll('[data-accept]').forEach(btn => {
      btn.addEventListener('click', () => applyDecision(btn.dataset.accept, 'accept'));
    });
    list.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', () => applyDecision(btn.dataset.reject, 'reject'));
    });
    list.querySelectorAll('[data-conflict-resolve]').forEach(btn => {
      btn.addEventListener('click', () => resolveConflict(btn.dataset.conflictResolve, btn.dataset.resolution));
    });
  } catch (err) {
    list.innerHTML = `<p class="empty-state error">${escapeHtml(err.message)}</p>`;
  }
}

function highlightValues(text) {
  return escapeHtml(text)
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(%|percent|days?|hours?|months?|years?|minutes?|weeks?)\b/gi, '<mark>$&</mark>')
    .replace(/([$¥€£])\s?([\d,]+(?:\.\d+)?)/g, '<mark>$&</mark>')
    .replace(/\b(\d{4}-\d{2}(?:-\d{2})?)\b/g, '<mark>$&</mark>');
}

function buildDiffSummary(incoming, existing) {
  // Extract values from both texts and show what differs
  const valRe = /\b(\d+(?:[.,]\d+)?)\s*(%|percent|days?|hours?|months?|years?|minutes?|weeks?)\b|[$¥€£]\s?[\d,]+(?:\.\d+)?|\b\d{4}-\d{2}(?:-\d{2})?\b/gi;
  const inVals = [...(incoming.matchAll(valRe))].map(m => m[0].trim());
  const exVals = [...(existing.matchAll(valRe))].map(m => m[0].trim());
  if (!inVals.length && !exVals.length) return '';
  const inSet = new Set(inVals.map(v => v.toLowerCase()));
  const exSet = new Set(exVals.map(v => v.toLowerCase()));
  const onlyIn = inVals.filter(v => !exSet.has(v.toLowerCase()));
  const onlyEx = exVals.filter(v => !inSet.has(v.toLowerCase()));
  if (!onlyIn.length && !onlyEx.length) return '';
  const parts = [];
  if (onlyIn.length) parts.push(`<span class="diff-incoming">${onlyIn.map(v => escapeHtml(v)).join(', ')}</span>`);
  if (onlyEx.length) parts.push(`<span class="diff-existing">${onlyEx.map(v => escapeHtml(v)).join(', ')}</span>`);
  return parts.join(' vs ');
}

function renderDecisionCard(d) {
  const actionClass = {
    merge_suggestion:      'decision-merge',
    replace_suggestion:    'decision-replace',
    node_merge_suggestion: 'decision-node-merge',
    value_conflict:        'decision-conflict'
  }[d.action] || '';

  const actionLabel = {
    merge_suggestion:      'Merge',
    replace_suggestion:    'Replace',
    node_merge_suggestion: 'Node Merge',
    value_conflict:        'Conflict'
  }[d.action] || d.action;

  const simStr = d.similarity_score != null ? `Similarity: ${(d.similarity_score * 100).toFixed(0)}%` : '';
  const confStr = d.confidence != null ? `Confidence: ${(d.confidence * 100).toFixed(0)}%` : '';
  const isPending = d.status === 'pending';
  const isConflict = d.action === 'value_conflict';

  return `
    <div class="decision-card ${actionClass}">
      <div class="decision-card-header">
        <span class="decision-action">${escapeHtml(actionLabel)}</span>
        <span class="decision-status decision-status-${d.status}">${escapeHtml(d.status)}</span>
        <span class="decision-meta">${[simStr, confStr].filter(Boolean).join(' · ')}</span>
      </div>
      ${d.reason ? `<p class="decision-reason">${escapeHtml(d.reason)}</p>` : ''}
      ${d.incoming_preview ? `
        <div class="kp-preview-block">
          <span class="kp-preview-label">Incoming</span>
          <div class="kp-preview">${isConflict ? highlightValues(d.incoming_preview) : escapeHtml(d.incoming_preview)}</div>
        </div>` : ''}
      ${d.target_preview ? `
        <div class="kp-preview-block">
          <span class="kp-preview-label">Existing</span>
          <div class="kp-preview">${isConflict ? highlightValues(d.target_preview) : escapeHtml(d.target_preview)}</div>
        </div>` : ''}
      ${isConflict && d.incoming_preview && d.target_preview ? `
        <div class="decision-diff-summary">${buildDiffSummary(d.incoming_preview, d.target_preview)}</div>` : ''}
      ${isPending && d.action === 'value_conflict' ? `
        <div class="decision-actions">
          <button class="btn btn-primary btn-small" data-conflict-resolve="${d.id}" data-resolution="keep_incoming">Keep Incoming</button>
          <button class="btn btn-primary btn-small" data-conflict-resolve="${d.id}" data-resolution="keep_existing">Keep Existing</button>
          <button class="btn btn-secondary btn-small" data-conflict-resolve="${d.id}" data-resolution="keep_both">Keep Both</button>
        </div>` : isPending ? `
        <div class="decision-actions">
          <button class="btn btn-primary btn-small" data-accept="${d.id}">Accept</button>
          <button class="btn btn-secondary btn-small" data-reject="${d.id}">Reject</button>
        </div>` : ''}
    </div>
  `;
}

async function applyDecision(id, action) {
  try {
    await api(`/decisions/${id}/${action}`, { method: 'POST' });
    showToast(`Decision ${action}ed`, 'success');
    loadDecisions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function resolveConflict(id, resolution) {
  try {
    await api(`/decisions/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify({ resolution })
    });
    showToast(`Conflict resolved: ${resolution.replace(/_/g, ' ')}`, 'success');
    loadDecisions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function bulkRejectFiltered() {
  const actionFilter = document.getElementById('decisions-action-filter')?.value || '';
  const label = actionFilter || 'all pending';
  const ok = await showConfirmModal({ title: 'Bulk Reject', message: `Reject ${label} decisions? This cannot be undone.`, confirmText: 'Reject All', danger: true });
  if (!ok) return;
  try {
    if (actionFilter) {
      const result = await api('/decisions/bulk-reject', {
        method: 'POST',
        body: JSON.stringify({ action: actionFilter })
      });
      showToast(`Rejected ${result.rejected} decisions`, 'success');
    } else {
      // Reject all pending — call bulk-reject for each action type with pending decisions
      const stats = await api('/decisions/stats');
      let total = 0;
      for (const { action } of (stats.by_action || [])) {
        const result = await api('/decisions/bulk-reject', {
          method: 'POST',
          body: JSON.stringify({ action })
        });
        total += result.rejected || 0;
      }
      showToast(`Rejected ${total} decisions`, 'success');
    }
    loadDecisions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Tests Tab ─────────────────────────────────────────────────────────────────

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

// [dup] let testResults  = {};  // id → { status: 'pending'|'running'|'passed'|'failed', detail: string }
// [dup] let allTests     = [];  // merged builtin + custom (each has a .run function)
// [dup] let isRunning    = false;
// Shared state for accuracy tests — populated by accuracy_ingest, read by downstream tests
// [dup] let accuracyState = { jobId: null, docId: null, chunkCount: 0, ingested: false };
// Shared state for multi-document tests — populated by multidoc_ingest, read by downstream tests
// [dup] let multidocState = { jobId: null, docId: null, chunkCount: 0, ingested: false };

// ── Init ─────────────────────────────────────────────────────────────────────

function initTests() {
  document.getElementById('run-all-tests-btn')?.addEventListener('click', () => runTests('all'));
  document.getElementById('run-selected-tests-btn')?.addEventListener('click', () => runTests('selected'));
  document.getElementById('clear-test-results-btn')?.addEventListener('click', clearTestResults);
  document.getElementById('show-add-test-btn')?.addEventListener('click', () => {
    document.getElementById('test-add-form')?.classList.remove('hidden');
  });
  document.getElementById('cancel-test-btn')?.addEventListener('click', () => {
    document.getElementById('test-add-form')?.classList.add('hidden');
    clearAddForm();
  });
  document.getElementById('save-test-btn')?.addEventListener('click', saveCustomTest);
  document.getElementById('tc-assertion-type')?.addEventListener('change', updateAssertionValueVisibility);
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

    renderTestList();
  } catch (err) {
    container.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
  }
}

function renderTestList() {
  const container = document.getElementById('tests-container');
  if (!container) return;

  // Group by category
  const groups = {};
  for (const t of allTests) {
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
    const expanded = prevExpanded[slug] ?? true; // default open
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

  updateSummary();
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
  document.getElementById('run-all-tests-btn').disabled = true;
  document.getElementById('run-selected-tests-btn').disabled = true;

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

  try {
    // Mark all as running
    for (const id of ids) {
      testResults[id] = { status: 'running', detail: '' };
      updateCard(id);
    }
    updateSummary();

    // Execute each test sequentially
    for (const id of ids) {
      const test = allTests.find(t => t.id === id);
      if (!test) { testResults[id] = { status: 'failed', detail: 'Test not found' }; updateCard(id); continue; }
      try {
        const result = await test.run(apiCallWrapper);
        testResults[id] = { status: result.passed ? 'passed' : 'failed', detail: result.detail ?? '' };
      } catch (err) {
        testResults[id] = { status: 'failed', detail: err.message };
      }
      updateCard(id);
      updateSummary();
    }

    const passed = ids.filter(id => testResults[id]?.status === 'passed').length;
    const failed = ids.filter(id => testResults[id]?.status === 'failed').length;
    showToast(`Tests complete: ${passed} passed, ${failed} failed`, failed > 0 ? 'error' : 'success');

    renderTestReport(ids);
  } finally {
    // ── Post-run cleanup (ALWAYS runs, even if tests throw) ─────────────────
    isRunning = false;
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

function updateSummary() {
  const total   = allTests.length;
  const passed  = Object.values(testResults).filter(r => r.status === 'passed').length;
  const failed  = Object.values(testResults).filter(r => r.status === 'failed').length;
  const pending = Object.values(testResults).filter(r => r.status === 'pending').length;
  const done    = passed + failed;

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const el = (id) => document.getElementById(id);
  if (el('tc-total'))   el('tc-total').textContent   = `${total} tests`;
  if (el('tc-passed'))  el('tc-passed').textContent  = `✓ ${passed}`;
  if (el('tc-failed'))  el('tc-failed').textContent  = `✗ ${failed}`;
  if (el('tc-pending')) el('tc-pending').textContent = `● ${pending} pending`;
  if (el('test-progress-fill')) el('test-progress-fill').style.width = `${pct}%`;
}

function clearTestResults() {
  for (const key of Object.keys(testResults)) {
    testResults[key] = { status: 'pending', detail: '' };
  }
  const reportEl = document.getElementById('test-report');
  if (reportEl) { reportEl.className = 'hidden'; reportEl.innerHTML = ''; }
  const dlBtn = document.getElementById('download-report-btn');
  if (dlBtn) dlBtn.style.display = 'none';
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
    document.getElementById('test-add-form')?.classList.add('hidden');
    clearAddForm();
    showToast('Test case saved', 'success');
    testResults = {};  // reset so new test starts as pending
    await loadTests();
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

// ── Settings Tab ──────────────────────────────────────────────────────────────

// [dup] const PROVIDER_DEFAULTS = {
// [dup]   openai: { model: 'gpt-4o-mini',       embeddingModel: 'text-embedding-3-large' },
// [dup]   gemini: { model: 'gemini-2.0-flash',  embeddingModel: 'gemini-embedding-001'   },
// [dup] };
// [dup] 
// [dup] let _settingsOriginalProvider = null;

function initSettings() {
  const providerSel = document.getElementById('settings-provider');
  if (!providerSel) return;

  providerSel.addEventListener('change', () => {
    const p = providerSel.value;
    document.getElementById('settings-model').value = PROVIDER_DEFAULTS[p]?.model ?? '';
    document.getElementById('settings-embed-model').value = PROVIDER_DEFAULTS[p]?.embeddingModel ?? '';
    const warning = document.getElementById('settings-embed-warning');
    if (warning) {
      warning.classList.toggle('hidden', p === _settingsOriginalProvider);
    }
  });

  document.getElementById('settings-save-btn')?.addEventListener('click', saveSettings);

  // Stats section (moved from Stats tab)
  document.getElementById('sync-embeddings-btn')?.addEventListener('click', () => callFn('syncEmbeddings'));
  document.getElementById('sync-aliases-btn')?.addEventListener('click', () => callFn('syncAliases'));

  // Settings sub-navigation
  document.getElementById('settings-nav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-btn');
    if (!btn) return;
    const sectionId = btn.dataset.section;
    document.querySelectorAll('#settings-nav .settings-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('#tab-settings > .settings-section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId)?.classList.add('active');
  });
}

async function loadSettings() {
  try {
    const data = await api('/settings/llm');
    const providerSel = document.getElementById('settings-provider');
    if (!providerSel) return;

    providerSel.value = data.provider;
    _settingsOriginalProvider = data.provider;
    document.getElementById('settings-model').value = data.model ?? '';
    document.getElementById('settings-embed-model').value = data.embeddingModel ?? '';

    // API status badges
    const statusEl = document.getElementById('settings-api-status');
    if (statusEl) {
      const badge = (label, ok) =>
        `<span class="api-status-badge api-status-badge--${ok ? 'ok' : 'missing'}">${label}: ${ok ? '✓ configured' : '✗ not configured'}</span>`;
      statusEl.innerHTML = badge('OpenAI', data.openaiConfigured) + badge('Gemini', data.geminiConfigured);
    }

    // Hide embed warning on load
    document.getElementById('settings-embed-warning')?.classList.add('hidden');
  } catch (err) {
    showToast('Failed to load settings: ' + err.message, 'error');
  }
}

async function saveSettings() {
  const provider = document.getElementById('settings-provider')?.value;
  const model = document.getElementById('settings-model')?.value.trim();
  const embeddingModel = document.getElementById('settings-embed-model')?.value.trim();

  try {
    const data = await api('/settings/llm', {
      method: 'POST',
      body: JSON.stringify({ provider, model, embeddingModel }),
    });
    _settingsOriginalProvider = data.provider;
    document.getElementById('settings-embed-warning')?.classList.add('hidden');
    showToast('Settings saved', 'success');

    // Refresh status badges
    const statusEl = document.getElementById('settings-api-status');
    if (statusEl) {
      const badge = (label, ok) =>
        `<span class="api-status-badge api-status-badge--${ok ? 'ok' : 'missing'}">${label}: ${ok ? '✓ configured' : '✗ not configured'}</span>`;
      statusEl.innerHTML = badge('OpenAI', data.openaiConfigured) + badge('Gemini', data.geminiConfigured);
    }
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// ── Prompt Settings ───────────────────────────────────────────────────────────

// [dup] let _promptsData = [];

function initPrompts() {
  document.getElementById('prompts-reset-all-btn')?.addEventListener('click', resetAllPrompts);
  document.getElementById('prompt-category-filter')?.addEventListener('change', renderPromptsList);
  document.getElementById('prompt-custom-only')?.addEventListener('change', renderPromptsList);
  document.getElementById('prompt-search')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.prompt-card').forEach(card => {
      const name = card.querySelector('.prompt-card-name')?.textContent.toLowerCase() || '';
      const desc = card.querySelector('.prompt-description')?.textContent.toLowerCase() || '';
      card.style.display = (name.includes(q) || desc.includes(q)) ? '' : 'none';
    });
  });
}

async function loadPrompts() {
  try {
    const data = await api('/prompts');
    if (!data) return;
    _promptsData = data.prompts || [];
    renderPromptsList();
  } catch (err) {
    console.warn('Failed to load prompts:', err.message);
  }
}

function renderPromptsList() {
  const container = document.getElementById('prompts-list');
  if (!container) return;

  const categoryFilter = document.getElementById('prompt-category-filter')?.value || 'all';
  const customOnly = document.getElementById('prompt-custom-only')?.checked || false;

  let filtered = _promptsData;
  if (categoryFilter !== 'all') {
    filtered = filtered.filter(p => p.category === categoryFilter);
  }
  if (customOnly) {
    filtered = filtered.filter(p => p.is_custom);
  }

  if (filtered.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;padding:8px;">No prompts match the filter.</p>';
    return;
  }

  container.innerHTML = filtered.map(p => {
    const varsHtml = p.variables.map(v => `<code>{{${v}}}</code>`).join(', ');
    return `<div class="prompt-card${p.is_custom ? ' is-custom' : ''}" data-prompt-key="${p.key}">
      <div class="prompt-card-header" onclick="togglePromptCard(this)">
        <span class="prompt-card-arrow">&#9654;</span>
        <span class="prompt-card-name">${escapeHtml(p.label)}</span>
        ${p.is_custom ? '<span class="prompt-card-badge custom">Custom</span>' : ''}
        <span class="prompt-card-badge category">${p.category}</span>
      </div>
      <div class="prompt-card-body">
        <div class="prompt-description">${escapeHtml(p.description)}</div>
        <div class="prompt-variables">Variables: ${varsHtml}</div>
        <textarea class="prompt-editor" rows="10">${escapeHtml(p.current_text)}</textarea>
        <div class="prompt-card-actions">
          <button class="btn btn-sm" onclick="resetSinglePrompt('${p.key}')">Reset to Default</button>
          <button class="btn btn-sm btn-primary" onclick="saveSinglePrompt('${p.key}')">Save</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function togglePromptCard(headerEl) {
  const card = headerEl.closest('.prompt-card');
  if (card) card.classList.toggle('expanded');
}

async function saveSinglePrompt(key) {
  const card = document.querySelector(`.prompt-card[data-prompt-key="${key}"]`);
  if (!card) return;
  const text = card.querySelector('.prompt-editor')?.value;
  if (!text?.trim()) return showToast('Prompt text cannot be empty', 'error');

  try {
    await api(`/prompts/${key}`, { method: 'PUT', body: JSON.stringify({ text }) });
    showToast('Prompt saved', 'success');
    await loadPrompts();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function resetSinglePrompt(key) {
  try {
    await api(`/prompts/${key}`, { method: 'DELETE' });
    showToast('Prompt reset to default', 'success');
    await loadPrompts();
  } catch (err) {
    showToast('Reset failed: ' + err.message, 'error');
  }
}

async function resetAllPrompts() {
  const ok = await showConfirmModal({ title: 'Reset All Prompts', message: 'Reset ALL prompts to defaults? Custom prompts for this dataset will be lost.', confirmText: 'Reset All', danger: true });
  if (!ok) return;
  try {
    await api('/prompts/reset', { method: 'POST' });
    showToast('All prompts reset to defaults', 'success');
    await loadPrompts();
  } catch (err) {
    showToast('Reset failed: ' + err.message, 'error');
  }
}

// ── Schema Panel ──────────────────────────────────────────────────────────────

// [dup] let _schemaPanelInitialized = false;

function initSchemaPanel() {
  if (_schemaPanelInitialized) {
    // Already wired — just refresh data
    loadSchemaSettingsInline();
    loadSchemaTemplates();
    loadSchemaNodes();
    return;
  }
  _schemaPanelInitialized = true;

  // Import JSON
  document.getElementById('schema-import-btn')?.addEventListener('click', () => {
    document.getElementById('schema-import-file').click();
  });
  document.getElementById('schema-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleSchemaImport(file);
    e.target.value = '';
  });

  // Export JSON
  document.getElementById('schema-export-btn')?.addEventListener('click', handleSchemaExport);

  // Save as Template
  document.getElementById('schema-save-template-btn')?.addEventListener('click', () => {
    document.getElementById('template-name').value = '';
    document.getElementById('template-description').value = '';
    document.getElementById('save-template-modal').classList.remove('hidden');
  });
  document.getElementById('close-save-template-modal')?.addEventListener('click', () => {
    document.getElementById('save-template-modal').classList.add('hidden');
  });
  document.getElementById('cancel-save-template')?.addEventListener('click', () => {
    document.getElementById('save-template-modal').classList.add('hidden');
  });
  document.getElementById('confirm-save-template')?.addEventListener('click', async () => {
    const name = document.getElementById('template-name').value.trim();
    const description = document.getElementById('template-description').value.trim();
    if (!name) { showToast('Template name is required', 'error'); return; }
    try {
      await api('/schema/templates', { method: 'POST', body: JSON.stringify({ name, description }) });
      showToast('Template saved', 'success');
      document.getElementById('save-template-modal').classList.add('hidden');
      loadSchemaTemplates();
    } catch (err) {
      showToast(err.message || 'Save failed', 'error');
    }
  });

  // Schema settings toggle buttons
  document.getElementById('mapping-mode-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#mapping-mode-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const strictness = document.getElementById('strictness-group');
    if (strictness) strictness.style.display = btn.dataset.value === 'guided' ? '' : 'none';
  });
  document.getElementById('mapping-strictness-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#mapping-strictness-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
  document.getElementById('tree-routing-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#tree-routing-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
  document.getElementById('save-schema-settings')?.addEventListener('click', saveSchemaSettings);

  // Schema-mode-badge navigates to schema sub-tab
  document.getElementById('schema-mode-badge')?.addEventListener('click', openSchemaSettings);

  // Back buttons
  document.getElementById('schema-interview-back-btn')?.addEventListener('click', cancelSchemaInterview);
  document.getElementById('schema-review-back-btn')?.addEventListener('click', cancelSchemaInterview);

  loadSchemaSettingsInline();
  loadSchemaTemplates();
  loadSchemaNodes();
  initSchemaInterview();
}

async function loadSchemaSettings() {
  try {
    const s = await api('/schema/settings');
    if (!s) return;
    state.currentMappingMode = s.mapping_mode || 'free';

    const badge = document.getElementById('schema-mode-badge');
    if (badge) {
      if (s.mapping_mode === 'guided') {
        badge.textContent = `Guided (${s.mapping_strictness})`;
        badge.classList.remove('hidden');
        badge.classList.add('badge-guided');
        badge.classList.remove('badge-free');
      } else {
        badge.textContent = 'Free';
        badge.classList.remove('hidden');
        badge.classList.remove('badge-guided');
        badge.classList.add('badge-free');
      }
    }

    // Show/hide guided-mode controls on upload form
    const schemaOnlyRow   = document.getElementById('schema-nodes-only-row');
    const schemaBranchRow = document.getElementById('schema-branch-row');
    if (schemaOnlyRow)   schemaOnlyRow.style.display   = s.mapping_mode === 'guided' ? '' : 'none';
    if (schemaBranchRow) schemaBranchRow.style.display  = s.mapping_mode === 'guided' ? '' : 'none';

    // Populate schema branch select when in guided mode
    if (s.mapping_mode === 'guided') callFn('populateSchemaBranchSelect');

    return s;
  } catch (_) {
    return { mapping_mode: 'free', mapping_strictness: 'soft' };
  }
}

async function loadSchemaSettingsInline() {
  const s = await loadSchemaSettings();
  if (!s) return; // api aborted or failed
  // Set toggle state in the inline settings card
  document.querySelectorAll('#mapping-mode-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === s.mapping_mode);
  });
  document.querySelectorAll('#mapping-strictness-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === s.mapping_strictness);
  });
  document.querySelectorAll('#tree-routing-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (s.tree_routing_mode || 'keyword'));
  });
  document.querySelectorAll('#entity-extraction-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (s.entity_extraction_enabled || 'false'));
  });
  const strictness = document.getElementById('strictness-group');
  if (strictness) strictness.style.display = s.mapping_mode === 'guided' ? '' : 'none';

  // Check embedding coverage for vector routing hint
  const hint = document.getElementById('vector-coverage-hint');
  if (hint) {
    try {
      const cov = await api('/embeddings/coverage');
      if (!cov) return;
      const pct = cov?.nodes?.total > 0 ? (cov.nodes.embedded / cov.nodes.total) : 0;
      hint.style.display = pct < 0.5 ? '' : 'none';
    } catch (_) { hint.style.display = 'none'; }
  }
}

async function loadSchemaNodes() {
  const container = document.getElementById('schema-nodes-tree');
  if (!container) return;
  try {
    const data = await api('/schema');
    if (!data) return;
    if (!data.nodes?.length) {
      container.innerHTML = '<p class="schema-empty">No schema nodes defined.<br>Import a JSON schema or flag existing nodes.</p>';
      return;
    }
    container.innerHTML = renderSchemaNodeTree(data.tree || []);
  } catch (err) {
    container.innerHTML = `<p class="empty-state">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function renderSchemaNodeTree(nodes, depth = 0) {
  return nodes.map(node => {
    const kws = (() => { try { return JSON.parse(node.keywords_json || '[]'); } catch(_){return[];} })();
    const children = node.children?.length
      ? `<div class="schema-node-children">${renderSchemaNodeTree(node.children, depth + 1)}</div>`
      : '';
    return `
      <div class="schema-node-item depth-${Math.min(depth, 3)}">
        <div class="schema-node-content">
          <span class="schema-node-name">${escapeHtml(node.name)}</span>
          ${node.node_description ? `<span class="schema-node-desc">${escapeHtml(node.node_description)}</span>` : ''}
          ${kws.length ? `<div class="keyword-chips">${kws.slice(0, 5).map(k => `<span class="keyword-chip">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
        </div>
        ${children}
      </div>
    `;
  }).join('');
}

async function loadSchemaTemplates() {
  const container = document.getElementById('schema-templates-list');
  if (!container) return;
  try {
    const templates = await api('/schema/templates');
    if (!templates) return;
    if (!templates.length) {
      container.innerHTML = '<p class="schema-empty">No templates yet.</p>';
      return;
    }
    container.innerHTML = templates.map(t => `
      <div class="schema-template-item">
        <span class="template-name" title="${escapeHtml(t.description || '')}">${escapeHtml(t.name)}</span>
        <div class="template-actions">
          <button class="btn btn-small btn-primary" onclick="applySchemaTemplate('${t.id}')">Apply</button>
          <button class="btn btn-small btn-danger" onclick="deleteSchemaTemplate('${t.id}', '${escapeHtml(t.name).replace(/'/g, '&#39;')}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p class="empty-state">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function handleSchemaImport(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const nodes = Array.isArray(data) ? data : (data.nodes || data.tree || []);
    if (!nodes.length) { showToast('No nodes found in file', 'error'); return; }

    const shouldReplace = await showConfirmModal({ title: 'Import Schema', message: 'Replace existing schema nodes? Choose "Replace" to clear and rebuild, or "Cancel" to merge with existing nodes.', confirmText: 'Replace', cancelText: 'Merge', danger: true });
    const mode = shouldReplace ? 'replace' : 'merge';

    const result = await api('/schema/import', {
      method: 'POST',
      body: JSON.stringify({ nodes, mode })
    });
    showToast(`Schema imported: ${result.created} created, ${result.updated} updated`, 'success');
    loadSchemaNodes();
    callFn('loadTree');
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  }
}

async function handleSchemaExport() {
  try {
    const resp = await fetch(`${API_BASE}/schema/export`, {
      headers: { 'X-Dataset-ID': state.currentDatasetId }
    });
    if (!resp.ok) throw new Error('Export failed');
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `schema-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}

async function applySchemaTemplate(id) {
  const ok = await showConfirmModal({ title: 'Apply Template', message: 'Apply this template to the current dataset? It will set mapping mode to Guided.', confirmText: 'Apply' });
  if (!ok) return;
  try {
    const result = await api(`/schema/templates/${id}/apply`, { method: 'POST', body: JSON.stringify({ mode: 'merge' }) });
    if (!result) return;
    showToast(`Template "${result.template_name}" applied — mode set to Guided`, 'success');
    loadSchemaSettingsInline();
    loadSchemaNodes();
    callFn('loadTree');
  } catch (err) {
    showToast('Apply failed: ' + err.message, 'error');
  }
}

async function deleteSchemaTemplate(id, name) {
  const ok = await showConfirmModal({ title: 'Delete Template', message: `Delete template "${name}"?`, confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/schema/templates/${id}`, { method: 'DELETE' });
    showToast('Template deleted', 'success');
    loadSchemaTemplates();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

function openSchemaSettings() {
  // Navigate to Tree tab → Schema sub-tab
  document.querySelector('.nav-btn[data-tab="tree"]').click();
  setTimeout(() => {
    document.querySelector('#tree-nav .settings-nav-btn[data-section="tree-section-schema"]')?.click();
  }, 100);
}

async function saveSchemaSettings() {
  const mode       = document.querySelector('#mapping-mode-toggle .toggle-btn.active')?.dataset.value || 'free';
  const strictness = document.querySelector('#mapping-strictness-toggle .toggle-btn.active')?.dataset.value || 'soft';
  const routing    = document.querySelector('#tree-routing-toggle .toggle-btn.active')?.dataset.value || 'keyword';
  const entityExt  = document.querySelector('#entity-extraction-toggle .toggle-btn.active')?.dataset.value || 'false';
  try {
    await api('/schema/settings', {
      method: 'PATCH',
      body: JSON.stringify({ mapping_mode: mode, mapping_strictness: strictness, tree_routing_mode: routing, entity_extraction_enabled: entityExt })
    });
    showToast('Schema settings saved', 'success');
    loadSchemaSettingsInline();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// ── Schema Interview (AI Generate) ─────────────────────────────────────────

// [dup] let _interviewState = {
// [dup]   active: false,
// [dup]   sessionId: null,
// [dup]   phase: 'idle',        // idle | interviewing | generating | reviewing
// [dup]   messages: [],
// [dup]   questionNumber: 0,
// [dup]   generatedSchema: null
// [dup] };

function initSchemaInterview() {
  document.getElementById('schema-interview-btn')?.addEventListener('click', startSchemaInterview);
  document.getElementById('schema-interview-send-btn')?.addEventListener('click', sendInterviewAnswer);
  document.getElementById('schema-interview-generate-btn')?.addEventListener('click', () => sendInterviewAnswer(true));
  document.getElementById('schema-review-refine-btn')?.addEventListener('click', toggleRefineInput);
  document.getElementById('schema-refine-send-btn')?.addEventListener('click', sendRefineRequest);
  document.getElementById('schema-review-apply-btn')?.addEventListener('click', applyInterviewSchema);
  document.getElementById('schema-review-save-btn')?.addEventListener('click', saveInterviewAsTemplate);
  document.getElementById('schema-review-cancel-btn')?.addEventListener('click', cancelSchemaInterview);

  const input = document.getElementById('schema-interview-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendInterviewAnswer();
      }
    });
  }
  const refineInput = document.getElementById('schema-refine-input');
  if (refineInput) {
    refineInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendRefineRequest();
      }
    });
  }
}

async function startSchemaInterview() {
  showInterviewUI();

  // Hide "Generate Now" until enough questions answered
  const genBtn = document.getElementById('schema-interview-generate-btn');
  if (genBtn) genBtn.style.display = 'none';

  const messagesDiv = document.getElementById('schema-interview-messages');
  messagesDiv.innerHTML = '';
  _interviewState = { active: true, sessionId: null, phase: 'interviewing', messages: [], questionNumber: 0, generatedSchema: null };

  // Show loading
  appendInterviewMessage('ai', 'Starting interview...', true);

  try {
    const result = await api('/schema/interview/start', { method: 'POST', body: '{}' });
    if (!result) return;
    _interviewState.sessionId = result.sessionId;
    _interviewState.questionNumber = result.questionNumber || 1;

    // Remove loading, show first question
    messagesDiv.innerHTML = '';
    if (result.existingDataSummary) {
      appendInterviewMessage('system', `Existing data: ${result.existingDataSummary}`);
    }
    appendInterviewMessage('ai', result.question);
    updateInterviewProgress();
  } catch (err) {
    messagesDiv.innerHTML = '';
    appendInterviewMessage('ai', `Error: ${err.message}`);
  }
}

async function sendInterviewAnswer(skipToGenerate = false) {
  const input = document.getElementById('schema-interview-input');
  const answer = input.value.trim();
  if (!answer && !skipToGenerate) return;

  const sendBtn = document.getElementById('schema-interview-send-btn');
  const genBtn = document.getElementById('schema-interview-generate-btn');
  sendBtn.disabled = true;
  genBtn.disabled = true;
  input.value = '';

  if (answer) appendInterviewMessage('user', answer);
  appendInterviewMessage('ai', skipToGenerate ? 'Generating schema...' : 'Thinking...', true);

  try {
    const result = await api('/schema/interview/answer', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: _interviewState.sessionId,
        answer: answer || undefined,
        skipToGenerate: skipToGenerate || undefined
      })
    });

    // Remove loading indicator
    removeInterviewLoading();

    if (result.phase === 'reviewing') {
      // Schema generated — switch to review mode
      _interviewState.phase = 'reviewing';
      _interviewState.generatedSchema = result.schema;
      showReviewUI(result.schema, result.summary);
      return;
    }

    // Next question
    _interviewState.questionNumber = result.questionNumber || (_interviewState.questionNumber + 1);
    appendInterviewMessage('ai', result.question);
    updateInterviewProgress();
  } catch (err) {
    removeInterviewLoading();
    appendInterviewMessage('ai', `Error: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
    genBtn.disabled = false;
    input.focus();
  }
}

async function sendRefineRequest() {
  const input = document.getElementById('schema-refine-input');
  const instructions = input.value.trim();
  if (!instructions) return;

  const btn = document.getElementById('schema-refine-send-btn');
  btn.disabled = true;
  btn.textContent = 'Refining...';
  input.value = '';

  try {
    const result = await api('/schema/interview/refine', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: _interviewState.sessionId,
        instructions
      })
    });

    _interviewState.generatedSchema = result.schema;
    showReviewUI(result.schema, result.summary);
    showToast('Schema refined', 'success');
  } catch (err) {
    showToast('Refine failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refine';
  }
}

async function applyInterviewSchema() {
  const ok = await showConfirmModal({ title: 'Apply Schema', message: 'Apply this schema? It will replace existing schema nodes and switch to Guided mode.', confirmText: 'Apply Schema', danger: true });
  if (!ok) return;

  const btn = document.getElementById('schema-review-apply-btn');
  btn.disabled = true;
  btn.textContent = 'Applying...';

  try {
    const result = await api('/schema/interview/apply', {
      method: 'POST',
      body: JSON.stringify({ sessionId: _interviewState.sessionId })
    });

    showToast(`Schema applied: ${result.created} created, ${result.updated} updated — Guided mode`, 'success');
    cancelSchemaInterview();
    loadSchemaSettingsInline();
    loadSchemaNodes();
    callFn('loadTree');
  } catch (err) {
    showToast('Apply failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply Schema';
  }
}

async function saveInterviewAsTemplate() {
  const name = await showPromptModal({ title: 'Save as Template', message: 'Enter a name for the template:', placeholder: 'Template name', confirmText: 'Save' });
  if (!name?.trim()) return;

  try {
    const result = await api('/schema/interview/apply', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: _interviewState.sessionId,
        saveAsTemplate: true,
        templateName: name.trim()
      })
    });

    showToast(`Schema applied & template saved — ${result.created} created`, 'success');
    cancelSchemaInterview();
    loadSchemaSettingsInline();
    loadSchemaNodes();
    loadSchemaTemplates();
    callFn('loadTree');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

function cancelSchemaInterview() {
  _interviewState = { active: false, sessionId: null, phase: 'idle', messages: [], questionNumber: 0, generatedSchema: null };
  showSchemaOverview();
}

// ── Interview UI helpers ───────────────────────────────────────────────────

function showSchemaOverview() {
  document.getElementById('schema-overview')?.classList.remove('hidden');
  document.getElementById('schema-interview-view')?.classList.add('hidden');
  document.getElementById('schema-review-view')?.classList.add('hidden');
}

function showInterviewUI() {
  document.getElementById('schema-overview')?.classList.add('hidden');
  document.getElementById('schema-interview-view')?.classList.remove('hidden');
  document.getElementById('schema-review-view')?.classList.add('hidden');
}

function showReviewUI(schema, summary) {
  document.getElementById('schema-overview')?.classList.add('hidden');
  document.getElementById('schema-interview-view')?.classList.add('hidden');
  document.getElementById('schema-review-view')?.classList.remove('hidden');

  document.getElementById('schema-review-summary').textContent = summary || '';
  document.getElementById('schema-review-tree').innerHTML = renderInterviewSchemaTree(schema);
  document.getElementById('schema-review-refine')?.classList.add('hidden');
}

function toggleRefineInput() {
  const refineDiv = document.getElementById('schema-review-refine');
  refineDiv.classList.toggle('hidden');
  if (!refineDiv.classList.contains('hidden')) {
    document.getElementById('schema-refine-input')?.focus();
  }
}

function appendInterviewMessage(role, content, isLoading = false) {
  const container = document.getElementById('schema-interview-messages');
  if (!container) return;

  if (role === 'system') {
    container.innerHTML += `<div class="interview-system-msg">${escapeHtml(content)}</div>`;
  } else if (role === 'user') {
    container.innerHTML += `<div class="user-query-bubble"><div class="bubble">${escapeHtml(content)}</div></div>`;
  } else {
    if (isLoading) {
      container.innerHTML += `
        <div class="manage-assistant-bubble interview-loading">
          <div class="typing-indicator">
            <div class="typing-dots"><span></span><span></span><span></span></div>
            <span>${escapeHtml(content)}</span>
          </div>
        </div>`;
    } else {
      container.innerHTML += `<div class="manage-assistant-bubble"><div class="bubble">${escapeHtml(content)}</div></div>`;
    }
  }

  container.scrollTop = container.scrollHeight;
}

function removeInterviewLoading() {
  const loading = document.querySelector('.interview-loading');
  if (loading) loading.remove();
}

function updateInterviewProgress() {
  const el = document.getElementById('schema-interview-progress');
  if (el) {
    el.textContent = `Question ${_interviewState.questionNumber} of ~8`;
  }
  // Show Generate Now button after at least 2 answers
  const genBtn = document.getElementById('schema-interview-generate-btn');
  if (genBtn) {
    genBtn.style.display = _interviewState.questionNumber >= 2 ? '' : 'none';
  }
}

function renderInterviewSchemaTree(nodes, depth = 0) {
  if (!Array.isArray(nodes) || !nodes.length) return '<p class="schema-empty">No nodes generated.</p>';
  return nodes.map(node => {
    const kws = (node.keywords || []).slice(0, 5);
    const children = node.children?.length
      ? `<div class="schema-node-children">${renderInterviewSchemaTree(node.children, depth + 1)}</div>`
      : '';
    return `
      <div class="schema-node-item depth-${Math.min(depth, 3)}">
        <div class="schema-node-content">
          <span class="schema-node-name">${escapeHtml(node.name)}</span>
          ${node.description ? `<span class="schema-node-desc">${escapeHtml(node.description)}</span>` : ''}
          ${kws.length ? `<div class="keyword-chips">${kws.map(k => `<span class="keyword-chip">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
        </div>
        ${children}
      </div>
    `;
  }).join('');
}

// ── Exports ──────────────────────────────────────────────────────────────────
export {
  initDecisions, loadDecisions,
  initTests, loadTests,
  initSettings, loadSettings,
  initPrompts, loadPrompts,
  initSchemaPanel, loadSchemaSettings, loadSchemaSettingsInline, loadSchemaNodes, loadSchemaTemplates,
  saveSchemaSettings, initSchemaInterview
};
registerFn('loadDecisions', loadDecisions);
registerFn('loadSchemaNodes', loadSchemaNodes);
registerFn('loadSchemaSettings', loadSchemaSettings);
registerFn('loadSchemaSettingsInline', loadSchemaSettingsInline);
registerFn('initSchemaPanel', initSchemaPanel);
registerFn('loadSchemaTemplates', loadSchemaTemplates);
registerFn('loadPrompts', loadPrompts);
registerFn('loadSettings', loadSettings);
registerFn('loadTests', loadTests);

// ── Window bindings for inline onclick handlers ──────────────────────────────
window.togglePromptCard = togglePromptCard;
window.saveSinglePrompt = saveSinglePrompt;
window.resetSinglePrompt = resetSinglePrompt;
window.applySchemaTemplate = applySchemaTemplate;
window.deleteSchemaTemplate = deleteSchemaTemplate;
