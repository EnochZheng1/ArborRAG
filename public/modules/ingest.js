// ── Ingest Tab (upload + documents + stats) ─────────────────────────────────
import { state, _tabDirty, STEP_TO_STAGE } from './state.js';
import { api, escapeHtml, showToast, renderEmptyState, formatFileSize, markTabsDirty, registerFn, callFn, showConfirmModal } from './utils.js';
import { t } from './i18n.js';
import { _wsSend, _renderStageTracker } from './websocket.js';

// Module-level state
let selectedFiles = [];
let _unifiedPollTimer = null;
let _prevActiveJobs = new Map();

// Use the shared state Map so websocket.js can trigger immediate polls on terminal events
const _uploadJobPollers = state._uploadJobPollers;

// Stage tooltips for pipeline stages
const STAGE_TOOLTIPS = {
  'Parse': 'Reading and splitting the document into sections',
  'Register': 'Registering the document in the database',
  'Extract KPs': 'Extracting knowledge points with AI',
  'Map to Tree': 'Mapping knowledge points to the topic tree',
  'Entities': 'Extracting entities and relationships',
  'Embed': 'Generating vector embeddings for search',
  'Finalize': 'Cleaning up and finalizing ingestion',
};

/** Apply tooltip titles to stage labels rendered by the stage tracker. */
function _applyStageTooltips(container) {
  if (!container) return;
  container.querySelectorAll('.stage-label').forEach(label => {
    const tip = STAGE_TOOLTIPS[label.textContent.trim()];
    if (tip) label.title = tip;
  });
}

/** Format elapsed time since a given start timestamp for the upload progress area. */
function _formatUploadElapsed(startedAt) {
  if (!startedAt) return '';
  const normalized = String(startedAt).replace(' ', 'T') + 'Z';
  const elapsed = Math.floor((Date.now() - new Date(normalized).getTime()) / 1000);
  if (elapsed < 0) return '';
  if (elapsed < 60) return `${elapsed}s elapsed`;
  return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`;
}

// Ingest Tab (upload + documents combined)
function initIngest() {
  // Upload zone
  const uploadZone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const uploadBtn = document.getElementById('upload-btn');

  uploadZone.addEventListener('click', () => fileInput.click());

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
  });

  uploadBtn.addEventListener('click', handleUpload);

  const schemaOnlyChk = document.getElementById('schema-nodes-only');
  if (schemaOnlyChk) {
    schemaOnlyChk.addEventListener('change', populateNodeSelects);
  }

  // Ingest sub-navigation
  document.getElementById('ingest-nav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-btn');
    if (!btn) return;
    const sectionId = btn.dataset.section;
    document.querySelectorAll('#ingest-nav .settings-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('#tab-ingest .settings-section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId)?.classList.add('active');
    // Auto-load documents when switching to that section
    if (sectionId === 'ingest-section-documents') loadUnifiedView();
  });

  // Documents section
  document.getElementById('refresh-docs-btn').addEventListener('click', loadUnifiedView);
  document.getElementById('doc-status-filter').addEventListener('change', loadUnifiedView);
  document.getElementById('retry-all-docs-btn')?.addEventListener('click', retryAllJobs);
  document.getElementById('cancel-all-docs-btn')?.addEventListener('click', cancelAllJobs);
  document.getElementById('clear-completed-btn')?.addEventListener('click', clearCompletedJobs);
  document.getElementById('clear-failed-btn')?.addEventListener('click', clearFailedJobs);
}

// [dup] let selectedFiles = [];

function handleFiles(files) {
  selectedFiles = Array.from(files);

  const fileList = document.getElementById('file-list');
  const fileListItems = document.getElementById('file-list-items');

  if (selectedFiles.length > 0) {
    fileListItems.innerHTML = selectedFiles.map(f => `
      <li>
        <span class="file-name">${f.name}</span>
        <span class="file-size">${formatFileSize(f.size)}</span>
      </li>
    `).join('');
    fileList.classList.remove('hidden');
  } else {
    fileList.classList.add('hidden');
  }
}

// [dup-imported] function formatFileSize(bytes) {
// [dup-imported]   if (bytes < 1024) return bytes + ' B';
// [dup-imported]   if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
// [dup-imported]   return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
// [dup-imported] }

async function handleUpload() {
  if (selectedFiles.length === 0) return;

  const uploadBtn = document.getElementById('upload-btn');
  const spinner = uploadBtn.querySelector('.loading-spinner');
  const resultDiv = document.getElementById('upload-result');

  uploadBtn.disabled = true;
  spinner.classList.remove('hidden');
  resultDiv.classList.add('hidden');

  const targetNodeId       = document.getElementById('target-node').value;
  const targetSchemaNodeId = document.getElementById('schema-branch')?.value || '';
  const useLLM = document.getElementById('upload-use-llm').checked;

  try {
    const formData = new FormData();

    if (selectedFiles.length === 1) {
      formData.append('file', selectedFiles[0]);
      if (targetNodeId)       formData.append('targetNodeId', targetNodeId);
      if (targetSchemaNodeId) formData.append('targetSchemaNodeId', targetSchemaNodeId);
      formData.append('useLLM', useLLM);

      const response = await fetch('/upload', { method: 'POST', body: formData, headers: { 'X-Dataset-ID': state.currentDatasetId } });
      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || `Upload failed (${response.status})`); }
      const result = await response.json();
      if (result.queued) {
        displayUploadResult([{
          queued: true,
          filename: selectedFiles[0].name,
          job: result.job
        }]);
      } else {
        displayUploadResult([result]);
      }
    } else {
      selectedFiles.forEach(f => formData.append('files', f));
      if (targetNodeId)       formData.append('targetNodeId', targetNodeId);
      if (targetSchemaNodeId) formData.append('targetSchemaNodeId', targetSchemaNodeId);
      formData.append('useLLM', useLLM);

      const response = await fetch('/upload/batch', { method: 'POST', body: formData, headers: { 'X-Dataset-ID': state.currentDatasetId } });
      if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || `Batch upload failed (${response.status})`); }
      const result = await response.json();
      if (result.queued && Array.isArray(result.jobs)) {
        displayUploadResult(result.jobs.map(j => ({
          queued: true,
          filename: j.original_name || j.file_path || 'Uploaded file',
          job: j
        })));
      } else {
        displayUploadResult(result.documents || [result]);
      }
    }

    showToast(t('success'), 'success');
    selectedFiles = [];
    document.getElementById('file-list').classList.add('hidden');
    document.getElementById('file-input').value = '';
    markTabsDirty('ingest', 'tree', 'settings');
    loadDocuments().catch(console.error);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    uploadBtn.disabled = false;
    spinner.classList.add('hidden');
  }
}

// Tracks active polling timers keyed by job id → { timer, intervalMs }
// [dup] const _uploadJobPollers = new Map();

function _renderUploadJobRow(r, liveJob) {
  const job = liveJob || r.job || null;
  const jobStatus = job?.status || r.status;
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);
  const isTerminal = TERMINAL.has(jobStatus);
  const isQueued = !isTerminal && (r.queued || jobStatus === 'queued' || jobStatus === 'processing');
  const isSuccess = jobStatus === 'completed' || r.success === true;
  const isRateLimited = jobStatus === 'rate_limited';
  const isFailed = jobStatus === 'failed' || (isTerminal && !isSuccess && !isRateLimited);

  let statusText, statusClass;
  if (jobStatus === 'completed') { statusText = 'completed'; statusClass = 'processed'; }
  else if (jobStatus === 'processing') { statusText = 'processing'; statusClass = 'processing'; }
  else if (jobStatus === 'queued') {
    const pos = job?.queue_position;
    statusText = pos != null ? `queued (#${pos})` : 'queued';
    statusClass = 'pending';
  }
  else if (jobStatus === 'failed') { statusText = 'failed'; statusClass = 'failed'; }
  else if (jobStatus === 'cancelled') { statusText = 'cancelled'; statusClass = 'failed'; }
  else if (jobStatus === 'rate_limited') {
    const attempts = job?.attempt_count;
    statusText = attempts ? `rate limited (attempt ${attempts})` : 'rate limited';
    statusClass = 'rate_limited';
  }
  else if (r.success === true) { statusText = 'processed'; statusClass = 'processed'; }
  else if (r.success === false) { statusText = 'failed'; statusClass = 'failed'; }
  else { statusText = jobStatus || 'queued'; statusClass = 'pending'; }

  const filename = r.filename || job?.original_name || 'Uploaded file';
  const result = job?.result || null;
  const chunkCount = result?.stats?.chunkCount ?? r.stats?.chunkCount;

  // Initial stage tracker state shown immediately after upload (before first WS event)
  const initialTracker = isQueued && job?.id ? `
    <div class="job-live-progress" id="job-progress-${job.id}">
      <div class="job-progress-bar"><div class="job-progress-fill" style="width:${jobStatus === 'queued' ? 0 : 5}%"></div></div>
      ${_renderStageTracker(0)}
      <p class="job-stage-msg">${jobStatus === 'queued' ? 'Waiting in queue…' : 'Starting…'}</p>
    </div>` : '';

  return `
    <div class="upload-job-card">
      <div class="upload-job-card-header">
        <span class="upload-job-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
        <div class="upload-job-meta">
          <span class="status-badge status-${statusClass}">${statusText}</span>
          ${job?.id ? `<span class="upload-job-id">Job #${job.id}</span>` : ''}
        </div>
      </div>
      ${initialTracker}
      ${chunkCount ? `<p class="upload-job-detail">${chunkCount} knowledge points extracted</p>` : ''}
      ${job?.document_id ? `<p class="upload-job-detail muted">Document #${job.document_id}</p>` : ''}
      ${result?.errors?.length ? `<p class="upload-job-detail error">${escapeHtml(result.errors.join(', '))}</p>` : ''}
      ${job?.error_message && !isQueued ? `<p class="upload-job-detail error">${escapeHtml(job.error_message)}</p>` : ''}
      ${isRateLimited ? `<p class="upload-job-detail warning">Paused — API rate limit hit. Go to the Documents tab to resume.</p>` : ''}
    </div>
  `;
}

function _stopUploadJobPoller(jobId) {
  const entry = _uploadJobPollers.get(jobId);
  if (entry?.timer) clearTimeout(entry.timer);
  _uploadJobPollers.delete(jobId);
}

function _startUploadJobPoller(jobId, resultIndex, allResults) {
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);
  const MAX_POLLS = 150; // ~5 minutes at 2s intervals
  let pollCount = 0;

  async function poll() {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      _stopUploadJobPoller(jobId);
      return;
    }

    try {
      const job = await api(`/ingest/jobs/${jobId}`, { dedupe: false });
      if (!job) return; // request was aborted

      // Update just this card in the result div.
      // Save the live progress element's innerHTML before replacing the card so
      // the WS-managed tracker state is not reset to stage-0 on every poll cycle.
      const resultDiv = document.getElementById('upload-result');
      if (resultDiv) {
        const cards = resultDiv.querySelectorAll('[data-job-id]');
        for (const card of cards) {
          if (String(card.dataset.jobId) === String(jobId)) {
            const savedProgress = document.getElementById(`job-progress-${jobId}`)?.innerHTML ?? null;
            card.outerHTML = `<div data-job-id="${jobId}">${_renderUploadJobRow(allResults[resultIndex], job)}</div>`;
            // Restore the live WS progress state (only while still processing)
            if (savedProgress !== null && !TERMINAL.has(job.status)) {
              const el = document.getElementById(`job-progress-${jobId}`);
              if (el) el.innerHTML = savedProgress;
            }
            break;
          }
        }
      }

      if (TERMINAL.has(job.status)) {
        _stopUploadJobPoller(jobId);
        _wsSend({ type: 'unwatch', jobId: String(jobId) });
        // Refresh the unified Documents tab view in the background
        loadUnifiedView().catch(console.error);
        return;
      }
    } catch {
      // Network hiccup — keep polling
    }

    const entry = _uploadJobPollers.get(jobId);
    if (entry) {
      // When WebSocket is connected, poll infrequently — WS handles live progress.
      // When WS is down, fall back to 3s polling so the UI still updates.
      const wsHealthy = state._ws && state._ws.readyState === WebSocket.OPEN;
      entry.timer = setTimeout(poll, wsHealthy ? 15000 : 3000);
    }
  }

  // Store pollFn so the WS handler can trigger an immediate poll on terminal events
  _uploadJobPollers.set(jobId, { timer: setTimeout(poll, 3000), pollFn: poll });
}

function displayUploadResult(results) {
  // Stop any existing pollers
  for (const jobId of _uploadJobPollers.keys()) _stopUploadJobPoller(jobId);

  const resultDiv = document.getElementById('upload-result');
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);

  let html = '<h4>Upload Results</h4>';
  results.forEach((r, i) => {
    const job = r.job || null;
    const jobId = job?.id;
    html += `<div data-job-id="${jobId || ''}">${_renderUploadJobRow(r, null)}</div>`;

    // Start polling and subscribe via WS for queued/processing jobs
    if (jobId && !TERMINAL.has(job?.status)) {
      _startUploadJobPoller(jobId, i, results);
      _wsSend({ type: 'watch', jobId: String(jobId) });
    }
  });

  resultDiv.innerHTML = html;
  resultDiv.classList.remove('hidden');
  _applyStageTooltips(resultDiv);
}


async function clearCompletedJobs() {
  try {
    const r = await api('/ingest/jobs/completed', { method: 'DELETE' });
    showToast(`${r.deleted} completed job${r.deleted !== 1 ? 's' : ''} cleared.`, 'info');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
}

async function clearFailedJobs() {
  const ok = await showConfirmModal({ title: 'Clear Failed Jobs', message: 'Remove all failed job records? Document data will not be deleted.', confirmText: 'Clear', danger: true });
  if (!ok) return;
  try {
    const r = await api('/ingest/jobs/failed', { method: 'DELETE' });
    showToast(`${r.deleted} failed job${r.deleted !== 1 ? 's' : ''} cleared.`, 'info');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
}

window.retryJob = async function(jobId) {
  try {
    await api(`/ingest/jobs/${jobId}/retry`, { method: 'POST' });
    showToast('Job queued for retry.', 'success');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
};

window.cancelJob = async function(jobId) {
  try {
    await api(`/ingest/jobs/${jobId}/cancel`, { method: 'POST' });
    showToast('Job cancelled.', 'info');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
};

window.cancelAndDeleteJob = async function(jobId, docId) {
  const ok = await showConfirmModal({ title: 'Cancel & Delete', message: 'Cancel this job and permanently delete all extracted content from the dataset?', confirmText: 'Cancel & Delete', danger: true });
  if (!ok) return;
  try {
    // Cancel the job first (may already be cancelled — ignore error)
    try { await api(`/ingest/jobs/${jobId}/cancel`, { method: 'POST' }); } catch (_) {}
    // Then delete the document and all its data
    await api(`/documents/${docId}`, { method: 'DELETE' });
    showToast('Job cancelled and document data deleted.', 'info');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
};

async function retryAllJobs() {
  try {
    const r = await api('/ingest/jobs/retry-all', { method: 'POST' });
    showToast(`${r.retried} job${r.retried !== 1 ? 's' : ''} queued for retry.`, 'success');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
}

async function cancelAllJobs() {
  const ok = await showConfirmModal({ title: 'Cancel All Jobs', message: 'Cancel all queued, processing, and rate-limited jobs?', confirmText: 'Cancel All', danger: true });
  if (!ok) return;
  try {
    const r = await api('/ingest/jobs/cancel-all', { method: 'POST' });
    showToast(`${r.cancelled} job${r.cancelled !== 1 ? 's' : ''} cancelled.`, 'info');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
}

// [dup] let _unifiedPollTimer = null;
// Map of jobId → name for active jobs seen in last poll (to detect completions)
// [dup] let _prevActiveJobs = new Map();

async function loadUnifiedView() {
  const tbody = document.getElementById('documents-tbody');
  if (!tbody) return;

  if (_unifiedPollTimer) { clearTimeout(_unifiedPollTimer); _unifiedPollTimer = null; }

  const statusFilter = document.getElementById('doc-status-filter')?.value || '';

  try {
    const data = await api('/documents/unified', { dedupe: false });
    if (!data) return; // request was aborted
    let rows = data.rows || [];

    // Detect completed jobs (were active last poll, now gone from active list → completed/cancelled)
    const currentActiveJobs = new Map(
      rows.filter(r => r.row_type === 'job' && ['queued','processing','rate_limited'].includes(r.status) && r.job_id)
          .map(r => [r.job_id, r.name || `Job #${r.job_id}`])
    );
    if (_prevActiveJobs.size > 0) {
      for (const [jid, name] of _prevActiveJobs) {
        if (!currentActiveJobs.has(jid)) {
          // Job transitioned out of active state — find its terminal row if present
          const finalRow = rows.find(r => r.job_id === jid || (r.doc_id && rows.find(x => x.job_id === jid)?.doc_id === r.doc_id));
          const finalStatus = finalRow?.status;
          if (!finalStatus || finalStatus === 'completed' || finalStatus === 'processed') {
            showToast(`"${name}" finished processing`, 'success');
          } else if (finalStatus === 'failed') {
            showToast(`"${name}" failed. Check error for details.`, 'error');
          }
          // Silently ignore cancelled — user triggered it intentionally
        }
      }
    }
    _prevActiveJobs = currentActiveJobs;

    // Client-side filter
    if (statusFilter) {
      rows = rows.filter(r => {
        if (statusFilter === 'queued')       return r.status === 'queued';
        if (statusFilter === 'processing')   return r.status === 'processing';
        if (statusFilter === 'rate_limited') return r.status === 'rate_limited';
        if (statusFilter === 'processed')    return r.status === 'processed';
        if (statusFilter === 'failed')       return r.status === 'failed';
        return true;
      });
    }

    // Update bulk action button visibility
    const hasQueued     = rows.some(r => r.status === 'queued' || r.status === 'processing' || r.status === 'rate_limited');
    const hasPaused     = rows.some(r => r.status === 'rate_limited' || r.status === 'failed');
    const hasCompleted  = rows.some(r => r.row_type === 'job' && r.status === 'completed');
    const hasFailed     = rows.some(r => r.row_type === 'job' && r.status === 'failed');
    const retryBtn      = document.getElementById('retry-all-docs-btn');
    const cancelBtn     = document.getElementById('cancel-all-docs-btn');
    const clearCompBtn  = document.getElementById('clear-completed-btn');
    const clearFailBtn  = document.getElementById('clear-failed-btn');
    if (retryBtn)    retryBtn.style.display    = hasPaused    ? '' : 'none';
    if (cancelBtn)   cancelBtn.style.display   = hasQueued    ? '' : 'none';
    if (clearCompBtn) clearCompBtn.style.display = hasCompleted ? '' : 'none';
    if (clearFailBtn) clearFailBtn.style.display = hasFailed   ? '' : 'none';

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8">${renderEmptyState(
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        'No documents uploaded',
        'Drag & drop files here, or click Upload. Supported: PDF, DOCX, TXT, XLSX, HTML, Markdown (max 200MB).'
      )}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(row => _renderUnifiedRow(row)).join('');
    _applyStageTooltips(tbody);

    // Register WebSocket watch for active processing jobs
    rows.filter(r => r.row_type === 'job' && r.status === 'processing' && r.job_id)
        .forEach(r => _wsSend({ type: 'watch', jobId: String(r.job_id) }));

    // Auto-refresh while jobs are queued or processing
    const hasActive = rows.some(r => r.status === 'queued' || r.status === 'processing');
    _hasActiveJobs = hasActive;
    const docsTabActive = document.getElementById('tab-ingest')?.classList.contains('active');
    if (hasActive && docsTabActive) {
      // Adaptive polling: when WebSocket is connected, use long interval (safety net);
      // when disconnected, poll more aggressively to compensate.
      const wsConnected = state._ws && state._ws.readyState === WebSocket.OPEN;
      const pollInterval = wsConnected ? 60000 : 5000;
      _unifiedPollTimer = setTimeout(() => loadUnifiedView().catch(console.error), pollInterval);
    }
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading-text error">${escapeHtml(error.message)}</td></tr>`;
  }
}

function _renderUnifiedRow(row) {
  const isJob = row.row_type === 'job';
  const id    = isJob ? `J${row.job_id}` : `D${row.doc_id}`;
  const name  = escapeHtml(row.name || '');
  const type  = escapeHtml(row.file_type || '-');
  const time  = row.time ? _timeAgo(row.time) : '-';
  const kps   = row.chunk_count != null ? row.chunk_count : '-';

  // Status badge
  const statusClass = {
    queued:       'status-queued',
    processing:   'status-processing',
    rate_limited: 'status-rate_limited',
    processed:    'status-processed',
    failed:       'status-failed',
    pending:      'status-pending',
  }[row.status] || '';
  const statusLabel = {
    queued:       'queued',
    processing:   'processing',
    rate_limited: 'rate limited',
    processed:    'processed',
    failed:       'failed',
    pending:      'pending',
  }[row.status] || row.status;
  const badge = `<span class="status-badge ${statusClass}">${statusLabel}</span>`;

  // Progress / step cell
  let progressCell = '-';
  if (row.status === 'processing' && isJob && row.job_id) {
    const pct = row.processing_progress ?? 0;
    const msg = escapeHtml(row.processing_message || row.processing_step || 'Processing…');
    const elapsedStr = row.started_at ? ` · ${_elapsedSince(row.started_at)}` : '';
    const etaStr = (pct > 5 && row.started_at) ? ` · ETA ${_estimateEta(row.started_at, pct)}` : '';
    progressCell = `
      <div class="doc-progress-wrap" id="job-progress-${row.job_id}">
        <div class="doc-progress-bar"><div class="doc-progress-fill" style="width:${pct}%"></div></div>
        <span class="doc-progress-msg">${msg}<span class="doc-progress-elapsed">${elapsedStr}${etaStr}</span></span>
      </div>`;
  } else if (row.status === 'queued') {
    const posLabel = row.queue_position != null ? `Position ${row.queue_position} in queue` : 'Waiting in queue…';
    progressCell = `<span class="muted">${posLabel}</span>`;
  } else if (row.status === 'rate_limited') {
    const err = row.error_message
      ? escapeHtml(row.error_message.replace(/^Rate limit hit \(429\) — resume when quota resets: /, ''))
      : 'API quota exceeded';
    const attempts = row.attempt_count ? ` (attempt ${row.attempt_count})` : '';
    progressCell = `<span class="text-warning" title="${err}">Rate limited${attempts}</span>`;
  } else if (row.status === 'failed' && row.error_message) {
    const short = escapeHtml(row.error_message.slice(0, 60)) + (row.error_message.length > 60 ? '…' : '');
    const full = escapeHtml(row.error_message);
    progressCell = row.error_message.length > 60
      ? `<details class="error-detail"><summary class="text-danger">${short}</summary><pre class="error-detail-full">${full}</pre></details>`
      : `<span class="text-danger">${full}</span>`;
  } else if (row.processing_step || row.processing_message) {
    progressCell = escapeHtml(row.processing_message || row.processing_step);
  }

  // Actions
  const actions = [];
  if (row.status === 'queued') {
    actions.push(`<button class="btn btn-xs btn-secondary" onclick="cancelJob(${row.job_id})">Cancel</button>`);
    if (row.doc_id) actions.push(`<button class="btn btn-xs btn-danger" onclick="cancelAndDeleteJob(${row.job_id},${row.doc_id})">Cancel &amp; Delete</button>`);
  }
  if (row.status === 'processing') {
    actions.push(`<button class="btn btn-xs btn-secondary" onclick="cancelJob(${row.job_id})">Cancel</button>`);
    if (row.doc_id) actions.push(`<button class="btn btn-xs btn-danger" onclick="cancelAndDeleteJob(${row.job_id},${row.doc_id})">Cancel &amp; Delete</button>`);
  }
  if (row.status === 'rate_limited') {
    actions.push(`<button class="btn btn-xs btn-warning" onclick="retryJob(${row.job_id})">Retry</button>`);
    actions.push(`<button class="btn btn-xs btn-secondary" onclick="cancelJob(${row.job_id})">Cancel</button>`);
    if (row.doc_id) actions.push(`<button class="btn btn-xs btn-danger" onclick="cancelAndDeleteJob(${row.job_id},${row.doc_id})">Cancel &amp; Delete</button>`);
  }
  if (row.status === 'failed' && isJob) actions.push(`<button class="btn btn-xs btn-warning" onclick="retryJob(${row.job_id})">Retry</button>`);
  if (row.doc_id && (row.status === 'processed' || row.status === 'failed' || row.status === 'cancelled' || row.status === 'pending')) {
    actions.push(`<button class="btn btn-xs btn-danger" onclick="deleteDocument(${row.doc_id})">${t('delete')}</button>`);
  }

  const trClass = isJob && row.status !== 'processed' ? `doc-row doc-row--${row.status}` : 'doc-row';
  return `
    <tr class="${trClass}" data-job-id="${row.job_id || ''}" data-doc-id="${row.doc_id || ''}">
      <td class="muted">${id}</td>
      <td class="doc-name" title="${name}">${name}</td>
      <td>${type}</td>
      <td>${badge}</td>
      <td class="doc-progress-cell">${progressCell}</td>
      <td>${kps}</td>
      <td class="muted">${time}</td>
      <td><div class="row-actions">${actions.join('')}</div></td>
    </tr>`;
}

function _timeAgo(dateStr) {
  if (!dateStr) return '-';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000)   return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

function _elapsedSince(dateStr) {
  if (!dateStr) return '';
  // SQLite datetime is "YYYY-MM-DD HH:MM:SS" (UTC, no timezone marker).
  // Replace space with T and append Z so JS parses it as UTC, consistent with
  // how the server stores timestamps via datetime('now').
  const normalized = String(dateStr).replace(' ', 'T') + 'Z';
  const sec = Math.floor((Date.now() - new Date(normalized).getTime()) / 1000);
  if (sec < 0) return '';
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function _estimateEta(startedAt, progressPct) {
  if (!startedAt || progressPct <= 0) return '';
  const normalized = String(startedAt).replace(' ', 'T') + 'Z';
  const elapsedMs = Date.now() - new Date(normalized).getTime();
  if (elapsedMs <= 0) return '';
  const totalEstMs = (elapsedMs / progressPct) * 100;
  const remainMs = totalEstMs - elapsedMs;
  const sec = Math.max(0, Math.round(remainMs / 1000));
  if (sec < 60) return `~${sec}s`;
  if (sec < 3600) return `~${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `~${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// Keep loadDocuments as an alias so any existing callers still work
const loadDocuments = loadUnifiedView;

window.deleteDocument = async function(id) {
  const ok = await showConfirmModal({ title: 'Delete Document', message: 'Permanently delete this document and all its extracted content?', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/documents/${id}`, { method: 'DELETE' });
    showToast(t('success'), 'success');
    markTabsDirty('tree', 'settings');
    loadUnifiedView();
  } catch (error) {
    showToast(error.message, 'error');
  }
};


async function loadStats() {
  const container = document.getElementById('stats-container');
  // Keep skeleton visible initially, will be replaced with content

  try {
    // Fetch both regular stats and token stats in parallel
    const [data, tokenData] = await Promise.all([
      api('/stats'),
      api('/stats/tokens').catch(() => null)
    ]);

    // Format token numbers
    const formatTokens = (n) => {
      if (!n) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toString();
    };

    const formatCost = (c) => {
      if (!c) return '$0.00';
      return '$' + c.toFixed(4);
    };

    // Build token stats HTML
    let tokenStatsHtml = '';
    if (tokenData) {
      const totals = tokenData.totals || {};
      const today = tokenData.today || {};
      const byOperation = tokenData.by_operation || [];

      tokenStatsHtml = `
        <div class="stats-card">
          <h3>🪙 Token Usage</h3>
          <div class="stats-grid">
            <div class="stats-item">
              <div class="value">${formatTokens(totals.total_tokens)}</div>
              <div class="label">Total Tokens</div>
            </div>
            <div class="stats-item">
              <div class="value">${formatTokens(totals.input_tokens)}</div>
              <div class="label">Input</div>
            </div>
            <div class="stats-item">
              <div class="value">${formatTokens(totals.output_tokens)}</div>
              <div class="label">Output</div>
            </div>
            <div class="stats-item">
              <div class="value">${formatCost(totals.cost_estimate)}</div>
              <div class="label">Est. Cost</div>
            </div>
          </div>
          <div class="stats-subsection">
            <h4>Today</h4>
            <div class="stats-grid stats-grid-small">
              <div class="stats-item">
                <div class="value">${formatTokens(today.total_tokens)}</div>
                <div class="label">Tokens</div>
              </div>
              <div class="stats-item">
                <div class="value">${today.calls || 0}</div>
                <div class="label">Calls</div>
              </div>
              <div class="stats-item">
                <div class="value">${formatCost(today.cost_estimate)}</div>
                <div class="label">Cost</div>
              </div>
            </div>
          </div>
          ${byOperation.length > 0 ? `
            <div class="stats-subsection">
              <h4>By Operation</h4>
              <div class="operation-breakdown">
                ${byOperation.slice(0, 5).map(op => `
                  <div class="operation-row">
                    <span class="op-name">${op.operation}</span>
                    <span class="op-tokens">${formatTokens(op.total_tokens)}</span>
                    <span class="op-cost">${formatCost(op.cost)}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="stats-card">
        <h3>📊 Nodes</h3>
        <div class="stats-grid">
          <div class="stats-item">
            <div class="value">${data.nodes?.total_nodes || 0}</div>
            <div class="label">Total Nodes</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.nodes?.max_depth || 0}</div>
            <div class="label">Max Depth</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.nodes?.root_nodes || 0}</div>
            <div class="label">Root Nodes</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.nodes?.nodes_with_children || 0}</div>
            <div class="label">With Children</div>
          </div>
        </div>
      </div>

      <div class="stats-card">
        <h3>📄 Documents</h3>
        <div class="stats-grid">
          <div class="stats-item">
            <div class="value">${data.documents?.total || 0}</div>
            <div class="label">Total</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.documents?.processed || 0}</div>
            <div class="label">Processed</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.documents?.processing || 0}</div>
            <div class="label">Processing</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.documents?.pending || 0}</div>
            <div class="label">Pending</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.documents?.failed || 0}</div>
            <div class="label">Failed</div>
          </div>
        </div>
      </div>

      <div class="stats-card">
        <h3>📦 Chunks</h3>
        <div class="stats-grid">
          <div class="stats-item">
            <div class="value">${data.chunks?.active || 0}</div>
            <div class="label">Active Chunks</div>
          </div>
        </div>
      </div>

      <div class="stats-card">
        <h3>🧬 Embeddings</h3>
        <div class="stats-grid">
          <div class="stats-item">
            <div class="value">${data.embeddings?.nodes?.coverage || 'N/A'}</div>
            <div class="label">Node Coverage</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.embeddings?.chunks?.coverage || 'N/A'}</div>
            <div class="label">Chunk Coverage</div>
          </div>
          <div class="stats-item">
            <div class="value">${(data.embeddings?.nodes?.total || 0) - (data.embeddings?.nodes?.embedded || 0)}</div>
            <div class="label">Nodes Unembedded</div>
          </div>
          <div class="stats-item">
            <div class="value ${((data.embeddings?.chunks?.total || 0) - (data.embeddings?.chunks?.embedded || 0)) > 0 ? 'value-warning' : ''}">${(data.embeddings?.chunks?.total || 0) - (data.embeddings?.chunks?.embedded || 0)}</div>
            <div class="label">Chunks Unembedded</div>
          </div>
        </div>
        ${((data.embeddings?.chunks?.total || 0) - (data.embeddings?.chunks?.embedded || 0)) > 0 ? `
        <div class="stats-hint">Run <strong>Sync Embeddings</strong> to index unembedded chunks for semantic search.</div>
        ` : ''}
      </div>

      <div class="stats-card">
        <h3>🔍 Entity Extraction</h3>
        <div class="stats-grid">
          <div class="stats-item">
            <div class="value">${data.extraction?.entities || 0}</div>
            <div class="label">Entities</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.extraction?.facts || 0}</div>
            <div class="label">Facts</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.extraction?.documents_extracted || 0}</div>
            <div class="label">Docs Extracted</div>
          </div>
        </div>
      </div>

      ${tokenStatsHtml}
    `;

    // Update the always-visible embedding coverage bar
    _updateEmbeddingCoverageBar(data.embeddings);
  } catch (error) {
    container.innerHTML = `<p class="loading-text error">${error.message}</p>`;
  }
}

function _updateEmbeddingCoverageBar(embeddings) {
  const fill = document.getElementById('embedding-coverage-fill');
  const text = document.getElementById('embedding-coverage-text');
  if (!fill || !text) return;
  const totalNodes = embeddings?.nodes?.total || 0;
  const totalChunks = embeddings?.chunks?.total || 0;
  const embeddedNodes = embeddings?.nodes?.embedded || 0;
  const embeddedChunks = embeddings?.chunks?.embedded || 0;
  const total = totalNodes + totalChunks;
  const embedded = embeddedNodes + embeddedChunks;
  const pct = total > 0 ? Math.round((embedded / total) * 100) : 0;
  fill.style.width = pct + '%';
  fill.className = 'embedding-coverage-fill ' + (pct < 30 ? 'low' : pct < 70 ? 'mid' : 'high');
  text.textContent = total > 0 ? `${pct}% embedded` : 'No data';
  document.getElementById('embedding-coverage-bar').title = `Embeddings: ${embedded}/${total} (${pct}%)`;
}

async function syncEmbeddings() {
  const btn = document.getElementById('sync-embeddings-btn');
  const spinner = btn.querySelector('.loading-spinner');

  btn.disabled = true;
  spinner.classList.remove('hidden');

  try {
    const result = await api('/embeddings/sync', { method: 'POST' });
    showToast(`Synced ${result.nodes?.success || 0} nodes and ${result.chunks?.success || 0} chunks`, 'success');
    loadStats();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
}

async function syncAliases() {
  const btn = document.getElementById('sync-aliases-btn');
  const spinner = btn.querySelector('.loading-spinner');

  btn.disabled = true;
  spinner.classList.remove('hidden');

  try {
    const result = await api('/aliases/sync', {
      method: 'POST',
      body: JSON.stringify({ limit: 50 })
    });
    showToast(`Generated aliases for ${result.success || 0} nodes (${result.aliases_generated || 0} total aliases)`, 'success');
    loadStats();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
}


// ── Exports ──────────────────────────────────────────────────────────────────
export { initIngest, loadUnifiedView, loadDocuments, loadStats, syncEmbeddings, syncAliases };
registerFn('loadUnifiedView', loadUnifiedView);
registerFn('loadDocuments', loadUnifiedView);
registerFn('loadStats', loadStats);
