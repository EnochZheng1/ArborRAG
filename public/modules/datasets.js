// ── Datasets Tab ─────────────────────────────────────────────────────────────
import { state, DATASET_KEY, _tabDirty } from './state.js';
import { api, escapeHtml, showToast, markAllTabsDirty, registerFn, callFn, showConfirmModal, showPromptModal } from './utils.js';
import { t } from './i18n.js';

// Shared state accessed via state.xxx (state.currentDatasetId, state.currentDatasetName, state.allDatasets, state.selectedDatasetIds)

// Datasets Tab
// ============================================

async function initDatasets() {
  // Restore saved dataset from localStorage
  const saved = localStorage.getItem(DATASET_KEY);

  try {
    const data = await fetch('/datasets').then(r => r.json());
    state.allDatasets = data.datasets || [];

    // Populate sidebar dropdown
    renderDatasetDropdown();

    // Restore saved selection
    if (saved && state.allDatasets.find(d => d.id === saved)) {
      switchDataset(saved, state.allDatasets.find(d => d.id === saved).name, false);
    } else if (state.allDatasets.length > 0) {
      switchDataset(state.allDatasets[0].id, state.allDatasets[0].name, false);
    }
  } catch (err) {
    console.error('Failed to load datasets:', err);
  }

  // Wire up sidebar select
  document.getElementById('dataset-select')?.addEventListener('change', (e) => {
    const id = e.target.value;
    const dataset = state.allDatasets.find(d => d.id === id);
    if (dataset) switchDataset(id, dataset.name, true);
  });

  // New dataset button
  document.getElementById('new-dataset-btn')?.addEventListener('click', () => {
    document.getElementById('dataset-create-form').classList.remove('hidden');
    document.getElementById('new-dataset-name')?.focus();
  });

  document.getElementById('cancel-create-dataset')?.addEventListener('click', () => {
    document.getElementById('dataset-create-form').classList.add('hidden');
    document.getElementById('new-dataset-name').value = '';
    document.getElementById('new-dataset-desc').value = '';
  });

  document.getElementById('confirm-create-dataset')?.addEventListener('click', handleCreateDataset);

  document.getElementById('dataset-batch-delete-btn')?.addEventListener('click', handleBatchDelete);
  document.getElementById('dataset-select-all')?.addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.dataset-checkbox:not(:disabled)');
    checkboxes.forEach(cb => {
      cb.checked = e.target.checked;
      const id = cb.dataset.datasetId;
      if (e.target.checked) state.selectedDatasetIds.add(id);
      else state.selectedDatasetIds.delete(id);
      cb.closest('.dataset-card').classList.toggle('dataset-card--selected', cb.checked);
    });
    updateBatchToolbar();
  });
}

function renderDatasetDropdown() {
  const select = document.getElementById('dataset-select');
  if (!select) return;

  select.innerHTML = state.allDatasets.map(d =>
    `<option value="${escapeHtml(d.id)}" ${d.id === state.currentDatasetId ? 'selected' : ''}>${escapeHtml(d.name)}</option>`
  ).join('');
}

function switchDataset(id, name, reload = true) {
  state.currentDatasetId = id;
  state.currentDatasetName = name;
  localStorage.setItem(DATASET_KEY, id);

  // Update sidebar dropdown
  const select = document.getElementById('dataset-select');
  if (select) select.value = id;

  // All tabs need fresh data from the new dataset
  markAllTabsDirty();

  if (reload) {
    // Reload active tab data with new dataset context
    const activeTab = document.querySelector('.nav-btn.active')?.dataset.tab;
    _tabDirty[activeTab] = false; // loading now, so mark clean
    if (activeTab === 'tree') callFn('loadTree');
    else if (activeTab === 'ask') {
      const welcome = document.getElementById('chat-welcome');
      const result = document.getElementById('ask-result');
      if (welcome) welcome.style.display = '';
      if (result) { result.classList.add('hidden'); result.innerHTML = ''; }
    }
    else if (activeTab === 'manage') {
      const manageWelcome = document.getElementById('manage-welcome');
      const manageResult = document.getElementById('manage-result');
      if (manageWelcome) manageWelcome.style.display = '';
      if (manageResult) manageResult.innerHTML = '';
      window._manageSessionId = null;
    }
    else if (activeTab === 'ingest') { callFn('loadSchemaSettings'); callFn('loadDocuments'); }
    else if (activeTab === 'decisions') callFn('loadDecisions');
    else if (activeTab === 'tests') callFn('loadTests');
    else if (activeTab === 'settings') { callFn('loadSettings'); callFn('loadPrompts'); callFn('loadStats'); callFn('loadSchemaSettingsInline'); }
    else if (activeTab === 'datasets') loadDatasets();
  }
}

function updateBatchToolbar() {
  const toolbar = document.getElementById('dataset-batch-toolbar');
  if (!toolbar) return;
  const count = state.selectedDatasetIds.size;
  toolbar.classList.toggle('hidden', count === 0);
  document.getElementById('dataset-batch-count').textContent =
    `${count} dataset${count !== 1 ? 's' : ''} selected`;
  const selectAll = document.getElementById('dataset-select-all');
  if (!selectAll) return;
  const selectableBoxes = document.querySelectorAll('.dataset-checkbox:not(:disabled)');
  const selectableCount = selectableBoxes.length;
  selectAll.checked = count > 0 && count === selectableCount;
  selectAll.indeterminate = count > 0 && count < selectableCount;
}

async function handleBatchDelete() {
  const ids = [...state.selectedDatasetIds];
  if (ids.length === 0) return;

  const ok = await showConfirmModal({ title: 'Delete Datasets', message: `Permanently delete ${ids.length} dataset${ids.length !== 1 ? 's' : ''}? This action cannot be undone.`, confirmText: 'Delete All', danger: true });
  if (!ok) return;

  let deleted = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await api(`/datasets/${id}?confirm=yes`, { method: 'DELETE' });
      deleted++;
    } catch (_err) {
      failed++;
    }
  }

  state.selectedDatasetIds.clear();
  showToast(
    failed > 0
      ? `Deleted ${deleted} dataset${deleted !== 1 ? 's' : ''}; ${failed} failed`
      : `Deleted ${deleted} dataset${deleted !== 1 ? 's' : ''}`,
    failed > 0 ? 'error' : 'success'
  );
  loadDatasets();
}

async function loadDatasets() {
  const list = document.getElementById('datasets-list');
  if (!list) return;

  list.innerHTML = '<div class="loading-text">Loading datasets...</div>';

  try {
    const data = await fetch('/datasets').then(r => r.json());
    state.allDatasets = data.datasets || [];
    renderDatasetDropdown();

    if (state.allDatasets.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-title">${t('no_datasets')}</div></div>`;
      return;
    }

    // Fetch stats AND language config for each dataset in parallel
    const [statsResults, langResults] = await Promise.all([
      Promise.allSettled(state.allDatasets.map(d => fetch(`/datasets/${d.id}/stats`).then(r => r.json()))),
      Promise.allSettled(state.allDatasets.map(d => fetch(`/datasets/${d.id}/config/language`).then(r => r.json())))
    ]);

    list.innerHTML = state.allDatasets.map((d, i) => {
      const stats = statsResults[i].status === 'fulfilled' ? statsResults[i].value : {};
      const langInfo = langResults[i].status === 'fulfilled' ? langResults[i].value : { language: 'auto', locked: false };
      return renderDatasetCard(d, stats, langInfo);
    }).join('');

    // Reset selection on reload
    state.selectedDatasetIds.clear();
    updateBatchToolbar();

    // Wire dataset checkboxes
    list.querySelectorAll('.dataset-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.datasetId;
        if (cb.checked) state.selectedDatasetIds.add(id);
        else state.selectedDatasetIds.delete(id);
        cb.closest('.dataset-card').classList.toggle('dataset-card--selected', cb.checked);
        updateBatchToolbar();
      });
    });

    // Wire up card action buttons via delegation
    list.addEventListener('click', handleDatasetCardAction);
  } catch (err) {
    list.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
  }
}

const LANG_LABELS = { 'auto': 'Auto', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'en': 'English' };

function renderDatasetCard(dataset, stats = {}, langInfo = { language: 'auto', locked: false }) {
  const isActive = dataset.id === state.currentDatasetId;
  const nodeCount = stats.node_count ?? '—';
  const docCount = stats.document_count ?? '—';
  const createdDate = dataset.created_at ? new Date(dataset.created_at).toLocaleDateString() : '';
  const langLabel = LANG_LABELS[langInfo.language] || langInfo.language;
  const langBadge = `<span class="lang-badge ${langInfo.locked ? 'lang-badge--locked' : 'lang-badge--auto'}">${escapeHtml(langLabel)}</span>`;

  return `
    <div class="dataset-card" data-dataset-id="${escapeHtml(dataset.id)}">
      <div class="dataset-card-header">
        <div class="dataset-card-title">
          <label class="dataset-card-check" onclick="event.stopPropagation()">
            <input type="checkbox" class="dataset-checkbox"
              data-dataset-id="${escapeHtml(dataset.id)}"
              ${isActive ? 'disabled title="Switch away from this dataset to include it in batch operations"' : ''}>
          </label>
          <h3 class="dataset-name">${escapeHtml(dataset.name)}</h3>
          ${isActive ? `<span class="dataset-active-badge">${t('dataset_active')}</span>` : ''}
          ${langBadge}
        </div>
        ${dataset.description ? `<div class="dataset-description">${escapeHtml(dataset.description)}</div>` : ''}
        <div class="dataset-meta">
          ${createdDate ? `<span>${createdDate}</span> · ` : ''}
          <span>${nodeCount} ${t('dataset_nodes')} · ${docCount} ${t('dataset_docs')}</span>
        </div>
      </div>
      <div class="dataset-card-actions">
        ${!isActive ? `<button class="btn btn-primary btn-small" data-action="switch">${t('dataset_switch')}</button>` : ''}
        <button class="btn btn-secondary btn-small" data-action="rename">${t('dataset_rename')}</button>
        <button class="btn btn-secondary btn-small" data-action="duplicate">${t('dataset_duplicate')}</button>
        <button class="btn btn-secondary btn-small" data-action="export">${t('dataset_export')}</button>
        <button class="btn btn-danger btn-small" data-action="delete">${t('dataset_delete')}</button>
      </div>
      <div class="dataset-rename-form hidden" data-rename-form>
        <input type="text" class="dataset-rename-input" value="${escapeHtml(dataset.name)}" placeholder="${t('dataset_name_placeholder')}">
        <input type="text" class="dataset-desc-input" value="${escapeHtml(dataset.description || '')}" placeholder="${t('dataset_desc_placeholder')}">
        <div class="form-actions">
          <button class="btn btn-secondary btn-small" data-action="cancel-rename">${t('cancel')}</button>
          <button class="btn btn-primary btn-small" data-action="save-rename">${t('save')}</button>
        </div>
      </div>
    </div>
  `;
}

async function handleDatasetCardAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const card = btn.closest('.dataset-card');
  if (!card) return;

  const datasetId = card.dataset.datasetId;
  const action = btn.dataset.action;

  if (action === 'switch') {
    const dataset = state.allDatasets.find(d => d.id === datasetId);
    if (dataset) {
      switchDataset(datasetId, dataset.name, true);
      loadDatasets();
    }
  } else if (action === 'rename') {
    card.querySelector('[data-rename-form]').classList.remove('hidden');
    card.querySelector('.dataset-rename-input')?.focus();
  } else if (action === 'cancel-rename') {
    card.querySelector('[data-rename-form]').classList.add('hidden');
  } else if (action === 'save-rename') {
    const newName = card.querySelector('.dataset-rename-input')?.value.trim();
    const newDesc = card.querySelector('.dataset-desc-input')?.value.trim();
    if (!newName) { showToast('Name is required', 'error'); return; }
    try {
      await api(`/datasets/${datasetId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: newName, description: newDesc })
      });
      if (datasetId === state.currentDatasetId) state.currentDatasetName = newName;
      showToast(t('dataset_renamed'), 'success');
      loadDatasets();
    } catch (err) { showToast(err.message, 'error'); }
  } else if (action === 'duplicate') {
    const dataset = state.allDatasets.find(d => d.id === datasetId);
    const suggestedName = dataset ? `${dataset.name} (copy)` : 'Copy';
    try {
      await api(`/datasets/${datasetId}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ name: suggestedName })
      });
      showToast(t('dataset_duplicated'), 'success');
      loadDatasets();
    } catch (err) { showToast(err.message, 'error'); }
  } else if (action === 'export') {
    window.location.href = `/datasets/${datasetId}/export`;
  } else if (action === 'delete') {
    const ok = await showConfirmModal({ title: 'Delete Dataset', message: 'Permanently delete this dataset and all its data? This action cannot be undone.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api(`/datasets/${datasetId}?confirm=yes`, { method: 'DELETE' });
      showToast(t('dataset_deleted'), 'success');
      // If we deleted the active dataset, switch to first remaining
      if (datasetId === state.currentDatasetId) {
        const remaining = state.allDatasets.filter(d => d.id !== datasetId);
        if (remaining.length > 0) switchDataset(remaining[0].id, remaining[0].name, true);
      }
      loadDatasets();
    } catch (err) { showToast(err.message, 'error'); }
  }
}

async function handleCreateDataset() {
  const nameInput = document.getElementById('new-dataset-name');
  const descInput = document.getElementById('new-dataset-desc');
  const langSelect = document.getElementById('new-dataset-lang');
  const name = nameInput?.value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }

  try {
    const result = await api('/datasets', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: descInput?.value.trim() || '',
        language: langSelect?.value || 'auto'
      })
    });
    document.getElementById('dataset-create-form').classList.add('hidden');
    nameInput.value = '';
    if (descInput) descInput.value = '';
    if (langSelect) langSelect.value = 'auto';
    showToast(t('dataset_created'), 'success');
    loadDatasets();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Exports ──────────────────────────────────────────────────────────────────
export { initDatasets, loadDatasets, switchDataset, renderDatasetDropdown };
registerFn('loadDatasets', loadDatasets);
registerFn('switchDataset', switchDataset);
