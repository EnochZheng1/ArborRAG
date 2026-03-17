// TreeKB Frontend Application — ES Module Entry Point
// All feature code lives in public/modules/. This file orchestrates initialization.

import { state, THEME_KEY, _tabDirty } from './modules/state.js';
import { closeMobileSidebar, callFn, markTabsDirty } from './modules/utils.js';
import { initLanguage } from './modules/i18n.js';
import { initWebSocket, initVisibilityHandler } from './modules/websocket.js';
import { initAsk, initQueryHistory } from './modules/ask.js';
import { initTree, initGraphView, initMobileSidebar, initTreeSearch, initTreeContentSearch } from './modules/tree.js';
import { initIngest } from './modules/ingest.js';
import { initDatasets } from './modules/datasets.js';
import {
  initDecisions, initTests, initSettings, initPrompts,
  initSchemaPanel
} from './modules/settings.js';
import { initManageTab } from './modules/manage.js';

// ── Theme Management ─────────────────────────────────────────────────────────

function initTheme() {
  const savedTheme = localStorage.getItem(THEME_KEY);
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');

  setTheme(theme);

  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem(THEME_KEY)) {
      setTheme(e.matches ? 'dark' : 'light');
    }
  });
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

// ── Tab Navigation ───────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;

      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
      document.getElementById(`tab-${tabId}`).classList.add('active');

      // Close mobile sidebar
      closeMobileSidebar();

      // Only re-fetch data if the tab is dirty (data changed since last visit).
      // Ingest tab also refreshes when there are active jobs (to show progress).
      const dirty = _tabDirty[tabId];
      const needsRefresh = dirty || (tabId === 'ingest' && state._hasActiveJobs);

      if (needsRefresh) {
        _tabDirty[tabId] = false;
        if (tabId === 'tree')      { callFn('loadTree'); }
        if (tabId === 'ingest')    { callFn('loadSchemaSettings'); callFn('loadDocuments'); }
        if (tabId === 'decisions') callFn('loadDecisions');
        if (tabId === 'tests')     callFn('loadTests');
        if (tabId === 'datasets')  callFn('loadDatasets');
        if (tabId === 'settings')  { Promise.all([callFn('loadSettings'), callFn('loadPrompts'), callFn('loadStats')]).catch(console.error); }
      }
    });
  });
}

// ── Tree sub-navigation ──────────────────────────────────────────────────────

function initTreeNav() {
  document.getElementById('tree-nav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-btn');
    if (!btn) return;
    const sectionId = btn.dataset.section;
    document.querySelectorAll('#tree-nav .settings-nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('#tab-tree > .settings-section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId)?.classList.add('active');

    // Toggle tree header actions visibility
    const treeActions = document.getElementById('tree-nodes-actions');
    if (treeActions) treeActions.style.display = sectionId === 'tree-section-nodes' ? '' : 'none';

    // Load schema data when switching to schema section
    if (sectionId === 'tree-section-schema') initSchemaPanel();
  });
}

// ── Initialize ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initDatasets();
  initTabs();
  initTreeNav();
  initLanguage();
  initAsk();
  initTree();
  initIngest();
  initDecisions();
  initTests();
  initSettings();
  initPrompts();
  initManageTab();
  initQueryHistory();
  initGraphView();
  initMobileSidebar();
  initTreeSearch();
  initTreeContentSearch();
  initVisibilityHandler();
  initWebSocket();

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Close any visible modal overlay
      document.querySelectorAll('.modal:not(.hidden)').forEach(modal => {
        modal.classList.add('hidden');
      });
      // Close node detail panel
      const detail = document.getElementById('node-detail');
      if (detail && !detail.classList.contains('hidden')) {
        detail.classList.add('hidden');
      }
      // Close settings panel if visible
      const settingsPanel = document.getElementById('advanced-options');
      if (settingsPanel && !settingsPanel.classList.contains('hidden')) {
        settingsPanel.classList.add('hidden');
      }
    }

    // Cmd/Ctrl+K — Quick search (focus query input)
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const queryInput = document.getElementById('query-input');
      if (queryInput) {
        // Switch to Ask tab and focus
        document.querySelector('[data-tab="ask"]')?.click();
        setTimeout(() => queryInput.focus(), 50);
      }
    }

    // Cmd/Ctrl+Enter — Submit current form
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const activeEl = document.activeElement;
      const form = activeEl?.closest('form');
      if (form) {
        e.preventDefault();
        form.requestSubmit();
      }
    }
  });

  // Signal that modules loaded successfully (used by fallback diagnostic)
  window._treekbReady = true;
});
