// ── Shared utilities ──────────────────────────────────────────────────────────
import { state, API_BASE, _tabDirty } from './state.js';

// ── Function registry (cross-module calls without circular imports) ──────────
const _registry = {};
export function registerFn(name, fn) { _registry[name] = fn; }
export function callFn(name, ...args) { return _registry[name]?.(...args); }

// ── Tab dirty helpers ────────────────────────────────────────────────────────

/** Mark one or more tabs as needing a refresh on next visit. */
export function markTabsDirty(...tabs) {
  for (const t of tabs) { if (t in _tabDirty) _tabDirty[t] = true; }
}

/** Mark all tabs dirty (e.g. on dataset switch). */
export function markAllTabsDirty() {
  for (const k of Object.keys(_tabDirty)) _tabDirty[k] = true;
}

// Toast Notifications
export function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toast-message');

  if (state.toastTimer) clearTimeout(state.toastTimer);

  toast.className = 'toast';
  if (type === 'error') toast.classList.add('error');
  if (type === 'success') toast.classList.add('success');

  // Add dismiss button for errors; allow HTML in message for undo buttons etc.
  const dismissBtn = type === 'error' ? ' <button class="toast-dismiss" onclick="this.closest(\'.toast\').classList.add(\'hidden\')">&times;</button>' : '';
  toastMessage.innerHTML = escapeHtml(message) + dismissBtn;
  toast.classList.remove('hidden');
  toast.classList.remove('hiding');

  const duration = type === 'error' ? 8000 : 3000;
  state.toastTimer = setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => {
      toast.classList.add('hidden');
      toast.classList.remove('hiding');
    }, 250);
  }, duration);
}

/**
 * Show a toast whose message may contain trusted HTML (e.g. undo buttons).
 * Use only when the HTML is built by our own code, never with user input.
 */
export function showHtmlToast(html, type = 'info') {
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toast-message');

  if (state.toastTimer) clearTimeout(state.toastTimer);

  toast.className = 'toast';
  if (type === 'error') toast.classList.add('error');
  if (type === 'success') toast.classList.add('success');

  toastMessage.innerHTML = html;
  toast.classList.remove('hidden');
  toast.classList.remove('hiding');

  const duration = type === 'error' ? 8000 : 5000;
  state.toastTimer = setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => {
      toast.classList.add('hidden');
      toast.classList.remove('hiding');
    }, 250);
  }, duration);
}

// API Helper — with AbortController deduplication
const _activeControllers = new Map();

export async function api(endpoint, options = {}) {
  // Cancel previous request to same endpoint if still in flight (dedup)
  const dedupe = options.dedupe !== false;
  const dedupeKey = dedupe ? (options.method === 'POST' ? `${endpoint}:POST` : endpoint) : null;

  if (dedupe && dedupeKey) {
    _activeControllers.get(dedupeKey)?.abort();
    const controller = new AbortController();
    _activeControllers.set(dedupeKey, controller);
    options.signal = controller.signal;
  }

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      signal: options.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Dataset-ID': state.currentDatasetId,
        ...options.headers
      },
      ...options
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`${endpoint} returned non-JSON (${response.status} ${contentType})`);
    }

    const data = await response.json();

    if (!response.ok) {
      const msg = data.error && typeof data.error === 'object' ? data.error.message : (data.error || 'API request failed');
      throw new Error(msg);
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') return null; // silently ignore aborted requests
    console.error(`API Error [${endpoint}]:`, error);
    throw error;
  } finally {
    if (dedupe && dedupeKey) {
      _activeControllers.delete(dedupeKey);
    }
  }
}

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Auto-resize textarea
export function autoResizeTextarea(el) {
  el.style.height = 'auto';
  const maxHeight = 180;
  el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
}

// Simple markdown rendering for answers
export function renderMarkdown(text) {
  if (!text) return '';
  // If text already contains HTML tags, return as-is
  if (/<[a-z][\s\S]*>/i.test(text)) return text;

  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^## (.+)$/gm, '<h4>$1</h4>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  // Clean up extra <br> inside elements
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/<\/ul><br>/g, '</ul>');
  html = html.replace(/<\/pre><br>/g, '</pre>');
  html = html.replace(/<\/h4><br>/g, '</h4>');
  html = html.replace(/<\/h5><br>/g, '</h5>');

  return html;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Better Empty States ──────────────────────────────────────────────────────

export function renderEmptyState(icon, title, description, actionHtml = '') {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-title">${title}</div>
      <div class="empty-state-desc">${description}</div>
      ${actionHtml ? `<div class="empty-state-action">${actionHtml}</div>` : ''}
    </div>
  `;
}

// Focus trap for modal dialogs (accessibility)
export function trapFocus(modal) {
  const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  first.focus();
  modal.addEventListener('keydown', function handler(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });
}

// Copy to clipboard with fallback for non-HTTPS / older browsers
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback using textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); return true; }
    catch { return false; }
    finally { document.body.removeChild(ta); }
  }
}

// Custom confirm modal (replaces native confirm())
export function showConfirmModal({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-message');
    const confirmBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    const inputWrap = document.getElementById('confirm-modal-input-wrap');
    const inputEl = document.getElementById('confirm-modal-input');

    titleEl.textContent = title || 'Confirm';
    msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    inputWrap.classList.add('hidden');
    inputEl.value = '';

    overlay.classList.remove('hidden');

    function cleanup(result) {
      overlay.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
    }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKey);
    cancelBtn.focus();
  });
}

// Custom prompt modal (replaces native prompt())
export function showPromptModal({ title, message, placeholder = '', defaultValue = '', confirmText = 'OK', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-message');
    const confirmBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    const inputWrap = document.getElementById('confirm-modal-input-wrap');
    const inputEl = document.getElementById('confirm-modal-input');

    titleEl.textContent = title || 'Input';
    msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    confirmBtn.className = 'btn btn-primary';
    inputWrap.classList.remove('hidden');
    inputEl.value = defaultValue;
    inputEl.placeholder = placeholder;

    overlay.classList.remove('hidden');

    function cleanup(result) {
      overlay.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      inputEl.removeEventListener('keydown', onInputKey);
      overlay.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onConfirm() { cleanup(inputEl.value); }
    function onCancel() { cleanup(null); }
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
    }
    function onInputKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    inputEl.addEventListener('keydown', onInputKey);
    overlay.addEventListener('keydown', onKey);
    setTimeout(() => inputEl.focus(), 50);
  });
}

// Mobile sidebar close
export function closeMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar?.classList.remove('open');
  backdrop?.classList.remove('visible');
}
