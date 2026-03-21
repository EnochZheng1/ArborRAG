// ── Decisions + Settings + Prompts + Schema ──────────────────────────────────
import { state, API_BASE, _tabDirty } from './state.js';
import { api, escapeHtml, showToast, registerFn, callFn, copyToClipboard, showConfirmModal, showPromptModal } from './utils.js';
import { t } from './i18n.js';

// Module-level state
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
  document.getElementById('retrieval-strategy-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#retrieval-strategy-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
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
  document.querySelectorAll('#retrieval-strategy-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (s.retrieval_strategy || 'node_first'));
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
  const strategy   = document.querySelector('#retrieval-strategy-toggle .toggle-btn.active')?.dataset.value || 'node_first';
  try {
    await api('/schema/settings', {
      method: 'PATCH',
      body: JSON.stringify({ mapping_mode: mode, mapping_strictness: strictness, tree_routing_mode: routing, entity_extraction_enabled: entityExt, retrieval_strategy: strategy })
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

// ── Window bindings for inline onclick handlers ──────────────────────────────
window.togglePromptCard = togglePromptCard;
window.saveSinglePrompt = saveSinglePrompt;
window.resetSinglePrompt = resetSinglePrompt;
window.applySchemaTemplate = applySchemaTemplate;
window.deleteSchemaTemplate = deleteSchemaTemplate;
