// ── WebSocket (real-time job progress) ───────────────────────────────────────
import { state, _tabDirty, STEP_TO_STAGE, PIPELINE_STAGES } from './state.js';
import { markTabsDirty, callFn, escapeHtml } from './utils.js';

export function _wsSend(msg) {
  const raw = JSON.stringify(msg);
  if (state._ws && state._ws.readyState === WebSocket.OPEN) {
    state._ws.send(raw);
  } else {
    state._wsQueue.push(raw);
  }
}

function _updateWsIndicator(status) {
  const el = document.getElementById('ws-status');
  if (!el) return;
  el.className = 'ws-status ws-' + status;
  el.title = status === 'connected' ? 'Live connection' :
             status === 'reconnecting' ? 'Reconnecting...' : 'Disconnected';

  // Update reconnection banner
  const banner = document.getElementById('ws-banner');
  const bannerMsg = document.getElementById('ws-banner-msg');
  const bannerBtn = document.getElementById('ws-banner-reconnect');
  if (!banner) return;

  if (status === 'connected') {
    banner.classList.add('hidden');
  } else if (status === 'reconnecting') {
    bannerMsg.textContent = 'Connection lost. Reconnecting...';
    bannerBtn.classList.add('hidden');
    banner.classList.remove('hidden');
  } else if (status === 'disconnected') {
    bannerMsg.textContent = 'Connection lost.';
    bannerBtn.classList.remove('hidden');
    banner.classList.remove('hidden');
  }
}

/** Render the 7-step stage tracker row. */
export function _renderStageTracker(activeStageIdx) {
  return `<div class="job-stage-tracker">` +
    PIPELINE_STAGES.map((s, i) => {
      const cls = i < activeStageIdx ? 'done' : i === activeStageIdx ? 'active' : 'pending';
      return `<div class="stage-step ${cls}"><div class="stage-dot"></div><span class="stage-label">${s.label}</span></div>`;
    }).join('') +
  `</div>`;
}

function _handleJobProgress({ jobId, step, progress, message, status }) {
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);

  // Update live progress in the unified Documents table row (if visible)
  const progressEl = document.getElementById(`job-progress-${jobId}`);
  if (progressEl) {
    if (TERMINAL.has(status)) {
      // Row will be refreshed by the poll timer; clear the progress bar now
      progressEl.innerHTML = '';
    } else {
      const pct = Math.max(0, Math.min(100, progress || 0));
      progressEl.innerHTML = `
        <div class="doc-progress-bar"><div class="doc-progress-fill" style="width:${pct}%"></div></div>
        <span class="doc-progress-msg">${message ? escapeHtml(message) : ''} ${pct > 0 ? `(${pct}%)` : ''}</span>
      `;
    }
  }

  // Also update the upload result card (for the current-session upload area)
  const uploadCard = document.querySelector(`[data-job-id="${jobId}"] .job-live-progress`);
  if (uploadCard) {
    if (TERMINAL.has(status)) {
      uploadCard.innerHTML = '';
    } else {
      const pct = Math.max(0, Math.min(100, progress || 0));
      const stageIdx = STEP_TO_STAGE[step] ?? 0;
      uploadCard.innerHTML = `
        <div class="job-progress-bar"><div class="job-progress-fill" style="width:${pct}%"></div></div>
        ${_renderStageTracker(stageIdx)}
        ${message ? `<p class="job-stage-msg">${escapeHtml(message)}</p>` : ''}
      `;
    }
  }

  if (TERMINAL.has(status)) {
    // Trigger an immediate poll to get the full final job state (upload card)
    const entry = state._uploadJobPollers.get(String(jobId));
    if (entry) {
      clearTimeout(entry.timer);
      entry.pollFn();
    }
    _wsSend({ type: 'unwatch', jobId: String(jobId) });
    // Refresh the unified table so the row moves to its final state
    callFn('loadUnifiedView')?.catch(console.error);
  }
}

// ── WS-driven reload (replaces 2s polling for the Documents tab) ──────────────

// Debounce: if multiple queue_update events arrive within 150ms, only reload once.
function _scheduleUnifiedReload() {
  if (document.hidden) return; // tab not visible — skip, visibilitychange will reload on return
  if (state._reloadDebounce) clearTimeout(state._reloadDebounce);
  state._reloadDebounce = setTimeout(() => {
    state._reloadDebounce = null;
    const docsTabActive = document.getElementById('tab-ingest')?.classList.contains('active');
    if (docsTabActive) {
      _tabDirty.ingest = false; // loading now — clear the dirty flag
      callFn('loadUnifiedView')?.catch(console.error);
    }
  }, 150);
}

export function initWebSocket() {
  // Wire the reconnect button (safe to call multiple times — only attaches once)
  const reconnectBtn = document.getElementById('ws-banner-reconnect');
  if (reconnectBtn && !reconnectBtn._wired) {
    reconnectBtn._wired = true;
    reconnectBtn.addEventListener('click', () => {
      state._wsRetries = 0; // reset retry counter
      initWebSocket();
    });
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state._ws = new WebSocket(`${proto}//${location.host}`);

  state._ws.addEventListener('open', () => {
    state._wsRetries = 0; // reset backoff on successful connection
    state._wsQueue.splice(0).forEach(msg => state._ws.send(msg));
    _updateWsIndicator('connected');
  });

  state._ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'job_progress') {
        // Ignore progress events for other datasets (user may have switched while job ran)
        if (msg.datasetId && msg.datasetId !== state.currentDatasetId) return;
        _handleJobProgress(msg);
      } else if (msg.type === 'queue_update') {
        // A job was enqueued or finished — refresh the Documents view immediately
        // instead of waiting for the next polling cycle.
        markTabsDirty('ingest', 'tree', 'settings');
        _scheduleUnifiedReload();
      }
    } catch { /* ignore */ }
  });

  state._ws.addEventListener('close', () => {
    state._ws = null;
    if (state._wsRetries >= state._WS_MAX_RETRIES) {
      _updateWsIndicator('disconnected');
      return; // give up after max retries
    }
    _updateWsIndicator('reconnecting');
    const delay = Math.min(state._WS_BASE_DELAY_MS * Math.pow(2, state._wsRetries), 30000);
    state._wsRetries++;
    setTimeout(initWebSocket, delay);
  });

  state._ws.addEventListener('error', () => { /* close will fire next */ });
}

// Pause all polling when tab is hidden; resume with an immediate reload when visible again.
export function initVisibilityHandler() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Tab became visible — refresh immediately so we catch anything we missed
      const docsTabActive = document.getElementById('tab-ingest')?.classList.contains('active');
      if (docsTabActive) callFn('loadUnifiedView')?.catch(console.error);
    } else {
      // Tab hidden — cancel any pending poll to avoid wasted requests
      if (state._unifiedPollTimer) { clearTimeout(state._unifiedPollTimer); state._unifiedPollTimer = null; }
    }
  });
}
