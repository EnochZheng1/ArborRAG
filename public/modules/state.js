// ── Shared mutable state ────────────────────────────────────────────────────
// Every module that needs global state imports this object and reads/writes
// properties directly.  Because ES modules share the same object reference,
// mutations are visible everywhere without extra wiring.

export const API_BASE = '';

// ── Pipeline stage definitions for the progress tracker ──────────────────────
export const PIPELINE_STAGES = [
  { key: 'parse',              label: 'Parse' },
  { key: 'register',          label: 'Register' },
  { key: 'kp_extraction',     label: 'Extract KPs' },
  { key: 'mapping_chunks',    label: 'Map to Tree' },
  { key: 'entity_extraction', label: 'Entities' },
  { key: 'embedding_sync',    label: 'Embed' },
  { key: 'finalizing',        label: 'Finalize' },
];
// Maps every pipeline step name → PIPELINE_STAGES index (0-5).
// Terminal steps (completed/failed) are handled before _renderStageTracker is
// called, so they don't need entries here.
export const STEP_TO_STAGE = {
  parse: 0, register: 1,
  kp_extraction: 2,
  mapping_chunks: 3, generating_aliases: 3,
  entity_extraction: 4,
  embedding_sync: 5,
  finalizing: 6,
};

// ── Tab state caching ────────────────────────────────────────────────────────
// Tracks whether each tab's data is "dirty" (needs re-fetch on next visit).
// A tab starts dirty (never loaded). After a successful load, it becomes clean.
// External events (uploads, WS updates, dataset switch) mark relevant tabs dirty.
export const _tabDirty = {
  tree: true, ingest: true, decisions: true,
  tests: true, datasets: true, settings: true, ask: false, manage: false
};

// LocalStorage keys
export const THEME_KEY = 'treekb_theme';
export const HISTORY_KEY = 'treekb_query_history';
export const FAVORITES_KEY = 'treekb_query_favorites';
export const MAX_HISTORY = 20;
export const DATASET_KEY = 'treekb_dataset_id';

// Tree virtualization
export const TREE_RENDER_DEPTH = 2; // render root (0) + first expanded level (1) immediately

export const state = {
  currentLang: 'en',
  treeData: [],          // nested tree from /nodes for D3 hierarchy layout
  allNodes: [],
  currentMappingMode: 'free',
  documentsPollTimer: null, // legacy, superseded by _unifiedPollTimer
  currentQueryResult: null, // Store current result for feedback
  suggestionTimeout: null,
  graphSimulation: null, // D3 force simulation
  currentGraphView: 'list', // 'list' | 'graph' | 'tree'

  // Dataset state
  currentDatasetId: 'default',
  currentDatasetName: 'Default',
  allDatasets: [],
  selectedDatasetIds: new Set(),

  // Whether there are active (queued/processing) jobs — forces documents to refresh
  _hasActiveJobs: false,

  // Upload state
  selectedFiles: [],

  // Upload job polling
  _uploadJobPollers: new Map(),

  // Unified documents poll
  _unifiedPollTimer: null,
  // Map of jobId → name for active jobs seen in last poll (to detect completions)
  _prevActiveJobs: new Map(),

  // Add chunk target
  addChunkTargetNodeId: null,

  // Lazy children map for tree virtualization
  _lazyChildrenMap: new Map(),

  // Toast timer
  toastTimer: null,

  // WebSocket state
  _ws: null,
  _wsQueue: [],
  _wsRetries: 0,
  _WS_MAX_RETRIES: 10,
  _WS_BASE_DELAY_MS: 1000,
  _reloadDebounce: null,

  // Graph view state
  graphZoom: null,
  graphSvg: null,
  graphG: null,

  // Tree diagram state
  treeDiagramZoom: null,
  treeDiagramSvg: null,
  treeDiagramG: null,

  // Tests state
  testResults: {},
  allTests: [],
  isRunning: false,
  accuracyState: { jobId: null, docId: null, chunkCount: 0, ingested: false },
  multidocState: { jobId: null, docId: null, chunkCount: 0, ingested: false },

  // Settings state
  PROVIDER_DEFAULTS: {
    openai: { model: 'gpt-4o-mini',       embeddingModel: 'text-embedding-3-large' },
    gemini: { model: 'gemini-2.0-flash',  embeddingModel: 'gemini-embedding-001'   },
  },
  _settingsOriginalProvider: null,

  // Prompts state
  _promptsData: [],

  // Schema panel state
  _schemaPanelInitialized: false,

  // Schema interview state
  _interviewState: {
    active: false,
    sessionId: null,
    phase: 'idle',        // idle | interviewing | generating | reviewing
    messages: [],
    questionNumber: 0,
    generatedSchema: null
  },
};
