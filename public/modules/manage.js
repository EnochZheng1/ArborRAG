// ── Manage Tab ───────────────────────────────────────────────────────────────
import { state } from './state.js';
import { api, escapeHtml, showToast } from './utils.js';

// ── Manage Tab ─────────────────────────────────────────────────────────────
window._manageSessionId = null;

function initManageTab() {
  const input = document.getElementById('manage-input');
  const sendBtn = document.getElementById('manage-send-btn');
  if (!input || !sendBtn) return;

  sendBtn.addEventListener('click', handleManageMessage);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleManageMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // History button
  document.getElementById('manage-history-btn')?.addEventListener('click', toggleManageHistory);
  const closeBtn = document.getElementById('manage-history-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('manage-history-panel')?.classList.add('hidden');
    });
  }

  // Example cards in manage welcome — click to fill input
  document.querySelectorAll('#tab-manage .manage-example[data-example]').forEach(el => {
    el.addEventListener('click', () => {
      input.value = el.dataset.example;
      input.focus();
    });
  });
}

async function handleManageMessage() {
  const input = document.getElementById('manage-input');
  const message = input.value.trim();
  if (!message) return;

  const sendBtn = document.getElementById('manage-send-btn');
  const resultDiv = document.getElementById('manage-result');
  const spinner = sendBtn.querySelector('.loading-spinner');

  sendBtn.disabled = true;
  spinner.classList.remove('hidden');
  input.value = '';

  const manageWelcome = document.getElementById('manage-welcome');
  if (manageWelcome) manageWelcome.style.display = 'none';

  const existing = resultDiv.innerHTML;
  resultDiv.innerHTML = existing + `
    <div class="user-query-bubble">
      <div class="bubble">${escapeHtml(message)}</div>
    </div>
    <div class="typing-indicator" id="manage-typing">
      <div class="typing-dots"><span></span><span></span><span></span></div>
      <span>Processing...</span>
    </div>
  `;

  const chatMessages = document.getElementById('manage-chat-messages');
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const result = await api('/manage/chat', {
      method: 'POST',
      body: JSON.stringify({ message, sessionId: window._manageSessionId })
    });

    window._manageSessionId = result.sessionId || window._manageSessionId;

    const typing = document.getElementById('manage-typing');
    if (typing) typing.remove();

    displayManageResult(result, resultDiv);
  } catch (error) {
    const typing = document.getElementById('manage-typing');
    if (typing) typing.remove();
    resultDiv.innerHTML += `
      <div class="manage-assistant-bubble">
        <div class="bubble bubble-error">Error: ${escapeHtml(error.message)}</div>
      </div>
    `;
  } finally {
    sendBtn.disabled = false;
    spinner.classList.add('hidden');
    input.focus();
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function displayManageResult(result, container) {
  const response = result.response || 'No response';

  const intentColors = {
    ADD: 'var(--success)', EDIT: 'var(--warning)', DELETE: 'var(--danger)',
    UNDO: 'var(--secondary)', HISTORY: 'var(--secondary)', QUERY: 'var(--primary)',
    CANCEL: 'var(--text-light)', CLARIFY: 'var(--text-light)', ERROR: 'var(--danger)'
  };
  const badgeColor = intentColors[result.intent] || 'var(--text-secondary)';

  let html = '<div class="manage-assistant-bubble">';
  if (result.intent) {
    html += `<span class="manage-intent-badge" style="background:${badgeColor}">${result.intent}</span>`;
  }

  const formatted = response.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  html += `<div class="bubble">${formatted}</div>`;

  if (result.pendingAction) {
    html += `<div class="confirmation-card">
      <div class="confirm-actions">
        <button class="btn btn-sm btn-success" onclick="sendManageConfirm()">Confirm</button>
        <button class="btn btn-sm" onclick="sendManageCancel()">Cancel</button>
      </div>
    </div>`;
  }

  if (result.changes && result.changes.length && result.intent !== 'HISTORY') {
    for (const ch of result.changes) {
      const badge = ch.type === 'add' ? 'Added' : ch.type === 'edit' ? 'Edited' : ch.type === 'delete' ? 'Deleted' : ch.type;
      const pathStr = (ch.nodePath || []).join(' > ');
      html += `<div class="manage-change-summary">`;
      html += `<span class="action-badge action-badge-${ch.type}">${badge}</span>`;
      if (pathStr) html += ` <span class="node-breadcrumb">${escapeHtml(pathStr)}</span>`;
      html += `</div>`;
    }
  }

  if (result.intent === 'HISTORY' && result.changes) {
    html += renderManageHistoryInline(result.changes);
  }

  html += '</div>';
  container.innerHTML += html;
}

function renderManageHistoryInline(changes) {
  if (!changes.length) return '<div class="manage-no-history">No changes recorded.</div>';
  let html = '<div class="manage-history-inline">';
  for (const ch of changes) {
    const actionLabel = ch.action.replace('chatbot_', '').toUpperCase();
    const badgeClass = ch.action.includes('add') ? 'add' : ch.action.includes('edit') ? 'edit' : ch.action.includes('delete') ? 'delete' : 'undo';
    const time = ch.created_at ? new Date(ch.created_at + 'Z').toLocaleString() : '';
    html += `<div class="manage-history-item">
      <span class="action-badge action-badge-${badgeClass}">${actionLabel}</span>
      <span class="manage-history-desc">${escapeHtml(ch.description || '')}</span>
      <span class="manage-history-time">${time}</span>
      ${ch.revertable ? `<button class="btn btn-xs btn-danger" onclick="sendManageRevert(${ch.id})">Revert</button>` : ''}
    </div>`;
  }
  html += '</div>';
  return html;
}

function sendManageConfirm() {
  document.getElementById('manage-input').value = '__confirm__';
  handleManageMessage();
}

function sendManageCancel() {
  document.getElementById('manage-input').value = '__cancel__';
  handleManageMessage();
}

async function sendManageRevert(auditId) {
  try {
    const result = await api('/manage/revert/' + auditId, { method: 'POST' });
    showToast(result.description || (result.success ? 'Reverted' : 'Failed'), result.success ? 'success' : 'error');
    const panel = document.getElementById('manage-history-panel');
    if (panel && !panel.classList.contains('hidden')) loadManageHistory();
  } catch (err) {
    showToast('Revert failed: ' + err.message, 'error');
  }
}

async function toggleManageHistory() {
  const panel = document.getElementById('manage-history-panel');
  if (!panel) return;
  if (panel.classList.contains('hidden')) {
    panel.classList.remove('hidden');
    await loadManageHistory();
  } else {
    panel.classList.add('hidden');
  }
}

async function loadManageHistory() {
  const list = document.getElementById('manage-history-list');
  if (!list) return;
  list.innerHTML = '<div class="loading-text">Loading...</div>';
  try {
    const data = await api('/manage/history?limit=30');
    const changes = data.changes || [];
    if (!changes.length) {
      list.innerHTML = '<div class="manage-no-history">No chatbot changes yet.</div>';
      return;
    }
    list.innerHTML = changes.map(ch => {
      const actionLabel = ch.action.replace('chatbot_', '').toUpperCase();
      const badgeClass = ch.action.includes('add') ? 'add' : ch.action.includes('edit') ? 'edit' : ch.action.includes('delete') ? 'delete' : 'undo';
      const time = ch.created_at ? new Date(ch.created_at + 'Z').toLocaleString() : '';
      return `<div class="manage-history-item">
        <div class="manage-history-item-top">
          <span class="action-badge action-badge-${badgeClass}">${actionLabel}</span>
          <span class="manage-history-time">${time}</span>
        </div>
        <div class="manage-history-desc">${escapeHtml(ch.description || '')}</div>
        ${ch.revertable ? `<button class="btn btn-xs btn-danger" onclick="sendManageRevert(${ch.id})">Revert</button>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="manage-no-history">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────
export { initManageTab };

// ── Window bindings for inline onclick handlers ──────────────────────────────
window.sendManageConfirm = sendManageConfirm;
window.sendManageCancel = sendManageCancel;
window.sendManageRevert = sendManageRevert;
