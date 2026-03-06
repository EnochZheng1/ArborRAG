// TreeKB Frontend Application

const API_BASE = '';

// ── WebSocket (real-time job progress) ───────────────────────────────────────
let _ws = null;
const _wsQueue = [];
let _wsRetries = 0;
const _WS_MAX_RETRIES = 10;
const _WS_BASE_DELAY_MS = 1000;

function _wsSend(msg) {
  const raw = JSON.stringify(msg);
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(raw);
  } else {
    _wsQueue.push(raw);
  }
}

function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _ws = new WebSocket(`${proto}//${location.host}`);

  _ws.addEventListener('open', () => {
    _wsRetries = 0; // reset backoff on successful connection
    _wsQueue.splice(0).forEach(msg => _ws.send(msg));
  });

  _ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'job_progress') {
        // Ignore progress events for other datasets (user may have switched while job ran)
        if (msg.datasetId && msg.datasetId !== currentDatasetId) return;
        _handleJobProgress(msg);
      } else if (msg.type === 'queue_update') {
        // A job was enqueued or finished — refresh the Documents view immediately
        // instead of waiting for the next polling cycle.
        _scheduleUnifiedReload();
      }
    } catch { /* ignore */ }
  });

  _ws.addEventListener('close', () => {
    _ws = null;
    if (_wsRetries >= _WS_MAX_RETRIES) return; // give up after max retries
    const delay = Math.min(_WS_BASE_DELAY_MS * Math.pow(2, _wsRetries), 30000);
    _wsRetries++;
    setTimeout(initWebSocket, delay);
  });

  _ws.addEventListener('error', () => { /* close will fire next */ });
}

// ── WS-driven reload (replaces 2s polling for the Documents tab) ──────────────

// Debounce: if multiple queue_update events arrive within 150ms, only reload once.
let _reloadDebounce = null;
function _scheduleUnifiedReload() {
  if (document.hidden) return; // tab not visible — skip, visibilitychange will reload on return
  if (_reloadDebounce) clearTimeout(_reloadDebounce);
  _reloadDebounce = setTimeout(() => {
    _reloadDebounce = null;
    const docsTabActive = document.getElementById('tab-documents')?.classList.contains('active');
    if (docsTabActive) loadUnifiedView().catch(console.error);
  }, 150);
}

// Pause all polling when tab is hidden; resume with an immediate reload when visible again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    // Tab became visible — refresh immediately so we catch anything we missed
    const docsTabActive = document.getElementById('tab-documents')?.classList.contains('active');
    if (docsTabActive) loadUnifiedView().catch(console.error);
  } else {
    // Tab hidden — cancel any pending poll to avoid wasted requests
    if (_unifiedPollTimer) { clearTimeout(_unifiedPollTimer); _unifiedPollTimer = null; }
  }
});

// ── Pipeline stage definitions for the progress tracker ──────────────────────
const PIPELINE_STAGES = [
  { key: 'parse',              label: 'Parse' },
  { key: 'register',          label: 'Register' },
  { key: 'kp_extraction',     label: 'Extract KPs' },
  { key: 'mapping_chunks',    label: 'Map to Tree' },
  { key: 'entity_extraction', label: 'Entities' },
  { key: 'finalizing',        label: 'Finalize' },
];
// Maps every pipeline step name → PIPELINE_STAGES index (0-5).
// Terminal steps (completed/failed) are handled before _renderStageTracker is
// called, so they don't need entries here.
const STEP_TO_STAGE = {
  parse: 0, register: 1,
  kp_extraction: 2,
  mapping_chunks: 3, generating_aliases: 3,
  entity_extraction: 4,
  finalizing: 5,
};

/** Render the 6-step stage tracker row. */
function _renderStageTracker(activeStageIdx) {
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
    const entry = _uploadJobPollers.get(String(jobId));
    if (entry) {
      clearTimeout(entry.timer);
      entry.pollFn();
    }
    _wsSend({ type: 'unwatch', jobId: String(jobId) });
    // Refresh the unified table so the row moves to its final state
    loadUnifiedView().catch(console.error);
  }
}

// i18n translations
const i18n = {
  en: {
    ask_title: 'Ask a Question',
    ask_subtitle: 'Query the knowledge base with natural language',
    smart_routing: 'Smart Routing',
    hybrid_search: 'Hybrid Search',
    ask_btn: 'Ask',
    tree_title: 'Knowledge Tree',
    refresh: 'Refresh',
    add_node: '+ Add Node',
    loading: 'Loading...',
    upload_title: 'Upload Documents',
    upload_subtitle: 'Add documents to the knowledge base',
    drop_files: 'Drop files here or click to browse',
    supported_formats: 'Supported: PDF, DOCX, XLSX, HTML, TXT, MD, CSV, JSON',
    target_node: 'Target Node (optional)',
    use_llm_extraction: 'Use LLM for metadata extraction',
    selected_files: 'Selected Files',
    upload_btn: 'Upload & Process',
    documents_title: 'Documents',
    filename: 'Filename',
    type: 'Type',
    status: 'Status',
    processing_step: 'Current Step',
    chunks: 'Chunks',
    uploaded: 'Uploaded',
    actions: 'Actions',
    stats_title: 'System Statistics',
    sync_embeddings: 'Sync Embeddings',
    node_id: 'Node ID',
    node_name: 'Name',
    parent_node: 'Parent Node (optional)',
    summary: 'Summary',
    cancel: 'Cancel',
    create: 'Create',
    delete: 'Delete',
    resolve: 'Resolve',
    no_results: 'No results found',
    error: 'An error occurred',
    success: 'Operation successful',
    confirm_delete: 'Are you sure you want to delete this?',
    empty_tree: 'Empty Tree',
    empty_tree_warning: '⚠️ WARNING: This will permanently delete ALL nodes, chunks, and embeddings. All documents will be marked as deleted. This action CANNOT be undone!\n\nType "DELETE" to confirm:',
    empty_tree_success: 'Tree emptied successfully',
    empty_tree_cancelled: 'Operation cancelled',
    show_trace: 'Show Trace',
    smart_routing_tooltip: 'Classifies query type (comparison, recommendation, reasoning) and routes to specialized handler',
    hybrid_search_tooltip: 'Combines BM25 keyword matching with semantic vector search using RRF fusion',
    show_trace_tooltip: 'Shows step-by-step processing: classification, node recall, ranking, and LLM generation',
    sync_aliases: 'Sync Aliases',
    sync_aliases_tooltip: 'Generate search aliases (synonyms, translations) for nodes that don\'t have them',
    relevant_excerpts: 'Relevant Excerpts',
    related_questions: 'Related Questions',
    feedback_thanks: 'Thanks for your feedback!',
    sources_cited: 'Sources',
    extracted_facts: 'Key Facts',
    extract_entities: 'Extract Entities',
    extract_entities_tooltip: 'Extract entities and facts from documents that haven\'t been processed yet',
    entities: 'Entities',
    facts: 'Facts',
    mentions: 'mentions',
    also_known_as: 'Also known as',
    from_source: 'From',
    token_usage: 'Token Usage',
    total_tokens: 'Total Tokens',
    input_tokens: 'Input',
    output_tokens: 'Output',
    est_cost: 'Est. Cost',
    today: 'Today',
    by_operation: 'By Operation',
    advanced_options: 'Advanced Options',
    show_confidence: 'Show Confidence',
    show_confidence_desc: 'Display confidence score in results',
    show_confidence_help: 'Toggle whether to show the confidence percentage badge on answers.',
    min_answer_confidence: 'Min Answer Confidence',
    min_answer_confidence_desc: 'Warn if answer confidence is below this',
    min_answer_confidence_help: 'If the answer confidence is below this threshold, a warning will be shown indicating the answer may be unreliable.',
    low_confidence_warning: 'Low confidence answer. The system is not very certain about this response.',
    top_k: 'Top K Nodes',
    top_k_desc: 'Number of candidate nodes to retrieve',
    top_k_help: 'Higher values find more potential matches but may include less relevant results. Lower values are faster and more focused.',
    max_chunks: 'Max Chunks',
    max_chunks_desc: 'Maximum text chunks to include in context',
    max_chunks_help: 'More chunks provide more context for the answer but increase processing time and token usage.',
    min_confidence: 'Min Confidence',
    min_confidence_desc: 'Minimum similarity score for vector search',
    min_confidence_help: 'Higher values only keep highly similar results. Set to 0 to include all matches. Useful for filtering out weak matches.',
    hybrid_alpha: 'Hybrid Alpha',
    hybrid_alpha_desc: 'Balance: 0=keyword, 1=semantic',
    hybrid_alpha_help: '0 = Pure keyword (BM25) search. 1 = Pure semantic (vector) search. 0.5 = Balanced mix of both approaches.',
    reranker_threshold: 'Reranker Threshold',
    reranker_threshold_desc: 'Min score to keep after LLM re-ranking',
    reranker_threshold_help: 'After initial retrieval, chunks are re-ranked by relevance. This filters out chunks below the threshold.',
    context_window: 'Context Window',
    context_window_desc: 'Adjacent chunks to include for context',
    context_window_help: 'Include N chunks before and after each match. Higher values provide more surrounding context but use more tokens.',
    temperature: 'Temperature',
    temperature_desc: 'LLM creativity: 0=precise, 1=creative',
    temperature_help: 'Lower = more deterministic, factual answers. Higher = more creative, varied responses. Use low for factual Q&A.',
    query_type: 'Query Type',
    query_type_desc: 'Auto-detect or manually select how to process your query',
    query_type_help: 'Auto uses AI to detect query type. Manual selection overrides AI classification and routes directly to the chosen handler.',
    query_type_auto: 'Auto (Recommended)',
    query_type_simple: 'Simple Lookup - Direct fact retrieval',
    query_type_comparison: 'Comparison - Compare entities',
    query_type_recommendation: 'Recommendation - Suggest options',
    query_type_reasoning: 'Reasoning - Multi-hop analysis',
    query_type_aggregation: 'Aggregation - Summarize content',
    query_history: 'Recent Queries',
    clear: 'Clear',
    no_history: 'No recent queries',
    filter_nodes: 'Filter nodes...',
    list_view: 'List View',
    graph_view: 'Graph View',
    theme_light: 'Light Mode',
    theme_dark: 'Dark Mode',
    unknown: 'Unknown',
    no_content: 'No content',
    datasets_title: 'Datasets',
    new_dataset: '+ New Dataset',
    dataset_active: 'Active',
    dataset_switch: 'Switch',
    dataset_rename: 'Rename',
    dataset_duplicate: 'Duplicate',
    dataset_export: 'Export',
    dataset_delete: 'Delete',
    dataset_name_label: 'Name',
    dataset_desc_label: 'Description',
    dataset_name_placeholder: 'Dataset name',
    dataset_desc_placeholder: 'Description (optional)',
    confirm_delete_dataset: 'Delete this dataset and all its data? This cannot be undone. Type DELETE to confirm:',
    no_datasets: 'No datasets found',
    dataset_created: 'Dataset created',
    dataset_renamed: 'Dataset renamed',
    dataset_deleted: 'Dataset deleted',
    dataset_duplicated: 'Dataset duplicated',
    dataset_nodes: 'nodes',
    dataset_docs: 'docs',
    save: 'Save',
    dataset_switcher_label: 'Dataset'
  },
  zh: {
    ask_title: '提问',
    ask_subtitle: '使用自然语言查询知识库',
    smart_routing: '智能路由',
    hybrid_search: '混合搜索',
    ask_btn: '提问',
    tree_title: '知识树',
    refresh: '刷新',
    add_node: '+ 添加节点',
    loading: '加载中...',
    upload_title: '上传文档',
    upload_subtitle: '将文档添加到知识库',
    drop_files: '拖拽文件到这里或点击选择',
    supported_formats: '支持格式：PDF、DOCX、XLSX、HTML、TXT、MD、CSV、JSON',
    target_node: '目标节点（可选）',
    use_llm_extraction: '使用 LLM 提取元数据',
    detect_conflicts: '检测冲突',
    selected_files: '已选文件',
    upload_btn: '上传并处理',
    documents_title: '文档管理',
    filename: '文件名',
    type: '类型',
    status: '状态',
    processing_step: '当前步骤',
    chunks: '分块数',
    uploaded: '上传时间',
    actions: '操作',
    stats_title: '系统统计',
    sync_embeddings: '同步嵌入向量',
    node_id: '节点 ID',
    node_name: '名称',
    parent_node: '父节点（可选）',
    summary: '摘要',
    cancel: '取消',
    create: '创建',
    delete: '删除',
    resolve: '解决',
    no_results: '未找到结果',
    error: '发生错误',
    success: '操作成功',
    confirm_delete: '确定要删除吗？',
    empty_tree: '清空知识树',
    empty_tree_warning: '⚠️ 警告：此操作将永久删除所有节点、分块和嵌入向量。所有文档将被标记为已删除。此操作不可撤销！\n\n输入 "DELETE" 确认：',
    empty_tree_success: '知识树已清空',
    empty_tree_cancelled: '操作已取消',
    show_trace: '显示追踪',
    smart_routing_tooltip: '对查询进行分类（比较、推荐、推理等）并路由到专门的处理程序',
    hybrid_search_tooltip: '结合 BM25 关键词匹配和语义向量搜索，使用 RRF 融合算法',
    show_trace_tooltip: '显示逐步处理过程：分类、节点召回、排序和 LLM 生成',
    sync_aliases: '同步别名',
    sync_aliases_tooltip: '为没有别名的节点生成搜索别名（同义词、翻译等）',
    relevant_excerpts: '相关摘录',
    related_questions: '相关问题',
    feedback_thanks: '感谢您的反馈！',
    sources_cited: '引用来源',
    extracted_facts: '关键事实',
    extract_entities: '提取实体',
    extract_entities_tooltip: '从尚未处理的文档中提取实体和事实',
    entities: '实体',
    facts: '事实',
    mentions: '次提及',
    also_known_as: '又名',
    from_source: '来源',
    token_usage: '令牌使用',
    total_tokens: '总令牌数',
    input_tokens: '输入',
    output_tokens: '输出',
    est_cost: '预估成本',
    today: '今日',
    by_operation: '按操作',
    advanced_options: '高级选项',
    show_confidence: '显示置信度',
    show_confidence_desc: '在结果中显示置信度分数',
    show_confidence_help: '切换是否在答案上显示置信度百分比标签。',
    min_answer_confidence: '最低答案置信度',
    min_answer_confidence_desc: '答案置信度低于此值时显示警告',
    min_answer_confidence_help: '如果答案置信度低于此阈值，将显示警告提示答案可能不可靠。',
    low_confidence_warning: '低置信度答案。系统对此回答不太确定。',
    top_k: '返回节点数',
    top_k_desc: '要检索的候选节点数量',
    top_k_help: '更高的值会找到更多潜在匹配，但可能包含不太相关的结果。较低的值更快且更精准。',
    max_chunks: '最大分块数',
    max_chunks_desc: '上下文中包含的最大文本块数',
    max_chunks_help: '更多的块提供更多上下文信息，但会增加处理时间和令牌消耗。',
    min_confidence: '最低置信度',
    min_confidence_desc: '向量搜索的最低相似度分数',
    min_confidence_help: '较高的值只保留高度相似的结果。设为0包含所有匹配。用于过滤弱匹配。',
    hybrid_alpha: '混合权重',
    hybrid_alpha_desc: '平衡：0=关键词，1=语义',
    hybrid_alpha_help: '0 = 纯关键词(BM25)搜索。1 = 纯语义(向量)搜索。0.5 = 两种方法的平衡组合。',
    reranker_threshold: '重排序阈值',
    reranker_threshold_desc: 'LLM 重排后保留的最低分数',
    reranker_threshold_help: '初始检索后，文本块按相关性重新排序。此值过滤掉低于阈值的块。',
    context_window: '上下文窗口',
    context_window_desc: '包含的相邻文本块数',
    context_window_help: '包含每个匹配前后的N个块。较高的值提供更多上下文但消耗更多令牌。',
    temperature: '温度',
    temperature_desc: 'LLM创造性：0=精确，1=创意',
    temperature_help: '较低 = 更确定性、事实性的答案。较高 = 更有创意、多样的回答。建议使用低值进行事实问答。',
    query_type: '查询类型',
    query_type_desc: '自动检测或手动选择查询处理方式',
    query_type_help: '自动模式使用AI检测查询类型。手动选择将覆盖AI分类，直接路由到选定的处理程序。',
    query_type_auto: '自动（推荐）',
    query_type_simple: '简单查询 - 直接事实检索',
    query_type_comparison: '比较查询 - 比较实体',
    query_type_recommendation: '推荐查询 - 建议选项',
    query_type_reasoning: '推理查询 - 多跳分析',
    query_type_aggregation: '聚合查询 - 汇总内容',
    query_history: '最近查询',
    clear: '清除',
    no_history: '暂无查询记录',
    filter_nodes: '筛选节点...',
    list_view: '列表视图',
    graph_view: '图形视图',
    theme_light: '浅色模式',
    theme_dark: '深色模式',
    unknown: '未知',
    no_content: '无内容',
    datasets_title: '数据集',
    new_dataset: '+ 新建数据集',
    dataset_active: '当前',
    dataset_switch: '切换',
    dataset_rename: '重命名',
    dataset_duplicate: '复制',
    dataset_export: '导出',
    dataset_delete: '删除',
    dataset_name_label: '名称',
    dataset_desc_label: '描述',
    dataset_name_placeholder: '数据集名称',
    dataset_desc_placeholder: '描述（可选）',
    confirm_delete_dataset: '删除此数据集及其所有数据？此操作无法撤销。输入 DELETE 确认：',
    no_datasets: '未找到数据集',
    dataset_created: '数据集已创建',
    dataset_renamed: '数据集已重命名',
    dataset_deleted: '数据集已删除',
    dataset_duplicated: '数据集已复制',
    dataset_nodes: '个节点',
    dataset_docs: '个文档',
    save: '保存',
    dataset_switcher_label: '数据集'
  }
};

let currentLang = 'en';
let allNodes = [];
let currentMappingMode = 'free';
let documentsPollTimer = null; // legacy, superseded by _unifiedPollTimer
let currentQueryResult = null; // Store current result for feedback
let suggestionTimeout = null;
let graphSimulation = null; // D3 force simulation
let currentGraphView = 'list'; // 'list' or 'graph'

// Dataset state
let currentDatasetId = 'default';
let currentDatasetName = 'Default';
let allDatasets = [];
let selectedDatasetIds = new Set();
const DATASET_KEY = 'treekb_dataset_id';

// Query History Management
const HISTORY_KEY = 'treekb_query_history';
const MAX_HISTORY = 20;

function getQueryHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveQueryHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

function addToHistory(query, queryType, confidence) {
  const history = getQueryHistory();
  // Remove duplicate if exists
  const filtered = history.filter(h => h.query !== query);
  filtered.unshift({
    query,
    queryType: queryType || 'simple_lookup',
    confidence: confidence || 0,
    timestamp: Date.now()
  });
  saveQueryHistory(filtered);
  renderQueryHistory();
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderQueryHistory();
}

function renderQueryHistory() {
  const historyList = document.getElementById('history-list');
  if (!historyList) return;

  const history = getQueryHistory();

  if (history.length === 0) {
    historyList.innerHTML = `<div class="history-empty">${t('no_history')}</div>`;
    return;
  }

  historyList.innerHTML = history.map(item => {
    const timeAgo = formatTimeAgo(item.timestamp);
    const truncatedQuery = item.query.length > 60 ? item.query.slice(0, 60) + '...' : item.query;
    return `
      <div class="history-item" data-query="${encodeURIComponent(item.query)}">
        <span class="history-query">${escapeHtml(truncatedQuery)}</span>
        <span class="history-type">${item.queryType.replace('_', ' ')}</span>
        <span class="history-time">${timeAgo}</span>
      </div>
    `;
  }).join('');
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Auto-resize textarea
function autoResizeTextarea(el) {
  el.style.height = 'auto';
  const maxHeight = 180;
  el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
}

// Simple markdown rendering for answers
function renderMarkdown(text) {
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

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initDatasets();
  initTabs();
  initLanguage();
  initAsk();
  initTree();
  initUpload();
  initDocuments();
  initDecisions();
  initTests();
  initStats();
  initSettings();
  initQueryHistory();
  initGraphView();
  initMobileSidebar();
  initTreeSearch();
  initWebSocket();
});

// Theme Management
const THEME_KEY = 'treekb_theme';

function initTheme() {
  // Check saved preference or system preference
  const savedTheme = localStorage.getItem(THEME_KEY);
  const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');

  setTheme(theme);

  // Theme toggle button
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  // Listen for system theme changes
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

// Tab Navigation
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

      // Load data for specific tabs
      if (tabId === 'tree') { loadTree(); initSchemaPanel(); }
      if (tabId === 'upload') loadSchemaSettings();
      if (tabId === 'documents') loadDocuments();
      if (tabId === 'decisions') loadDecisions();
      if (tabId === 'tests') loadTests();
      if (tabId === 'stats') loadStats();
      if (tabId === 'datasets') loadDatasets();
      if (tabId === 'settings') loadSettings();
    });
  });
}

// Language
function initLanguage() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentLang = btn.dataset.lang;
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateTranslations();
    });
  });

  // Apply translations on initial load
  updateTranslations();
}

function updateTranslations() {
  // Translate text content
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (i18n[currentLang][key]) {
      el.textContent = i18n[currentLang][key];
    }
  });

  // Translate title/tooltip attributes
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    if (i18n[currentLang][key]) {
      el.title = i18n[currentLang][key];
    }
  });

  // Translate placeholder attributes
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (i18n[currentLang][key]) {
      el.placeholder = i18n[currentLang][key];
    }
  });
}

function t(key) {
  return i18n[currentLang][key] || key;
}

// Toast Notifications
let toastTimer = null;
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toast-message');

  if (toastTimer) clearTimeout(toastTimer);

  toast.className = 'toast';
  if (type === 'error') toast.classList.add('error');
  if (type === 'success') toast.classList.add('success');

  toastMessage.textContent = message;
  toast.classList.remove('hidden');
  toast.classList.remove('hiding');

  toastTimer = setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => {
      toast.classList.add('hidden');
      toast.classList.remove('hiding');
    }, 250);
  }, 3000);
}

// API Helper
async function api(endpoint, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Dataset-ID': currentDatasetId,
        ...options.headers
      },
      ...options
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'API request failed');
    }

    return data;
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

// Ask Tab
function initAsk() {
  const askBtn = document.getElementById('ask-btn');
  const queryInput = document.getElementById('query-input');

  askBtn.addEventListener('click', handleAsk);
  queryInput.addEventListener('keydown', (e) => {
    // Enter to send, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
    // Hide suggestions on Escape
    if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  // Auto-resize textarea
  queryInput.addEventListener('input', (e) => {
    autoResizeTextarea(queryInput);
    handleQueryInput(e);
  });

  // Focus input on load
  setTimeout(() => queryInput.focus(), 100);
  queryInput.addEventListener('focus', () => {
    if (queryInput.value.length >= 1) {
      fetchSuggestions(queryInput.value);
    }
  });

  // Hide suggestions on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.chat-input-wrapper')) {
      hideSuggestions();
    }
  });

  // Feedback buttons
  document.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFeedback(btn.dataset.rating));
  });

  // Related questions — delegate to #ask-result (stable ancestor) because
  // #related-questions-list is injected dynamically via innerHTML and does not
  // exist when this init code runs.
  document.getElementById('ask-result')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.related-question-btn');
    if (!btn) return;
    const question = decodeURIComponent(btn.dataset.question);
    const input = document.getElementById('query-input');
    input.value = question;
    input.focus();
    input.setSelectionRange(question.length, question.length);
  });

  // Suggestions list (delegate)
  document.getElementById('suggestions-list')?.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) {
      document.getElementById('query-input').value = li.textContent;
      hideSuggestions();
      handleAsk();
    }
  });

  // Advanced options toggle (gear icon)
  const toggleAdvancedBtn = document.getElementById('toggle-advanced-options');
  const advancedOptions = document.getElementById('advanced-options');
  const closeAdvancedBtn = document.getElementById('close-advanced-options');

  toggleAdvancedBtn?.addEventListener('click', () => {
    advancedOptions.classList.toggle('hidden');
    toggleAdvancedBtn.classList.toggle('active', !advancedOptions.classList.contains('hidden'));
  });

  closeAdvancedBtn?.addEventListener('click', () => {
    advancedOptions.classList.add('hidden');
    toggleAdvancedBtn?.classList.remove('active');
  });

  // Slider value updates
  const sliderConfigs = [
    { id: 'opt-min-answer-confidence', decimals: 2 },
    { id: 'opt-top-k', decimals: 0 },
    { id: 'opt-max-chunks', decimals: 0 },
    { id: 'opt-min-confidence', decimals: 2 },
    { id: 'opt-hybrid-alpha', decimals: 1 },
    { id: 'opt-reranker-threshold', decimals: 2 },
    { id: 'opt-context-window', decimals: 0 },
    { id: 'opt-temperature', decimals: 1 }
  ];

  sliderConfigs.forEach(({ id, decimals }) => {
    const slider = document.getElementById(id);
    const valueDisplay = document.getElementById(`${id}-value`);
    if (slider && valueDisplay) {
      slider.addEventListener('input', () => {
        valueDisplay.textContent = parseFloat(slider.value).toFixed(decimals);
      });
    }
  });
}

function handleQueryInput(e) {
  const value = e.target.value.trim();

  if (suggestionTimeout) {
    clearTimeout(suggestionTimeout);
  }

  if (value.length < 1) {
    hideSuggestions();
    return;
  }

  suggestionTimeout = setTimeout(() => {
    fetchSuggestions(value);
  }, 200);
}

async function fetchSuggestions(prefix) {
  try {
    const result = await api(`/suggestions?q=${encodeURIComponent(prefix)}&limit=8`);
    if (result.suggestions?.length > 0) {
      showSuggestions(result.suggestions);
    } else {
      hideSuggestions();
    }
  } catch (err) {
    // Silently fail
  }
}

function showSuggestions(suggestions) {
  const container = document.getElementById('suggestions-container');
  const list = document.getElementById('suggestions-list');

  list.innerHTML = suggestions.map(s => `
    <li class="suggestion-item suggestion-${s.type}">
      ${s.text}
      ${s.type !== 'node' ? `<span class="suggestion-type">${s.type}</span>` : ''}
    </li>
  `).join('');

  container.classList.remove('hidden');
}

function hideSuggestions() {
  document.getElementById('suggestions-container')?.classList.add('hidden');
}

async function handleFeedback(rating) {
  if (!currentQueryResult) return;

  const query = document.getElementById('query-input').value.trim();
  const nodeIds = currentQueryResult.top?.map(t => t.node?.node_id).filter(Boolean) || [];
  const chunkIds = currentQueryResult.snippets?.map(s => s.chunkId).filter(Boolean) || [];

  try {
    await api('/feedback', {
      method: 'POST',
      body: JSON.stringify({
        query,
        queryType: currentQueryResult.query_type,
        answer: currentQueryResult.llm_response?.final_answer,
        rating,
        nodeIds,
        chunkIds
      })
    });

    // Update UI
    document.querySelectorAll('.feedback-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.rating === rating);
      btn.disabled = true;
    });

    showToast(t('feedback_thanks'), 'success');
  } catch (err) {
    showToast('Failed to submit feedback', 'error');
  }
}

async function handleAsk() {
  const query = document.getElementById('query-input').value.trim();
  if (!query) return;

  const askBtn = document.getElementById('ask-btn');
  const resultDiv = document.getElementById('ask-result');
  const spinner = askBtn.querySelector('.loading-spinner');

  askBtn.disabled = true;
  spinner.classList.remove('hidden');

  // Hide welcome screen
  const chatWelcome = document.getElementById('chat-welcome');
  if (chatWelcome) chatWelcome.style.display = 'none';

  // Show user query bubble and typing indicator
  resultDiv.classList.remove('hidden');
  resultDiv.innerHTML = `
    <div class="user-query-bubble">
      <div class="bubble">${escapeHtml(query)}</div>
    </div>
    <div class="typing-indicator">
      <div class="typing-dots"><span></span><span></span><span></span></div>
      <span>${t('loading')}</span>
    </div>
  `;

  // Scroll chat to bottom
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const useClassification = document.getElementById('use-classification').checked;
    const useHybridSearch = document.getElementById('use-hybrid').checked;
    const showTrace = document.getElementById('show-trace').checked;

    // Get manual query type selection
    const queryTypeSelect = document.getElementById('opt-query-type');
    const selectedQueryType = queryTypeSelect ? queryTypeSelect.value : 'auto';

    // Collect retrieval options
    const getSliderValue = (id, parser = parseFloat) => {
      const el = document.getElementById(id);
      return el ? parser(el.value) : undefined;
    };

    const options = {
      useClassification: selectedQueryType === 'auto' ? useClassification : false,
      forceQueryType: selectedQueryType !== 'auto' ? selectedQueryType : null,
      useHybridSearch,
      trace: showTrace,
      topK: getSliderValue('opt-top-k', parseInt),
      maxChunks: getSliderValue('opt-max-chunks', parseInt),
      minConfidence: getSliderValue('opt-min-confidence'),
      hybridAlpha: getSliderValue('opt-hybrid-alpha'),
      rerankerThreshold: getSliderValue('opt-reranker-threshold'),
      contextWindow: getSliderValue('opt-context-window', parseInt),
      temperature: getSliderValue('opt-temperature')
    };

    const result = await api('/ask', {
      method: 'POST',
      body: JSON.stringify({ query, options })
    });

    // Save to history
    addToHistory(query, result.query_type, result.confidence);

    displayAskResult(result, showTrace);
  } catch (error) {
    showToast(error.message, 'error');
    resultDiv.classList.add('hidden');
  } finally {
    askBtn.disabled = false;
    spinner.classList.add('hidden');
    // Focus back to input for next question
    document.getElementById('query-input')?.focus();
  }
}

function formatQueryTypeLabel(queryType) {
  const queryTypeMap = {
    simple_lookup: 'query_type_simple',
    comparison: 'query_type_comparison',
    recommendation: 'query_type_recommendation',
    reasoning: 'query_type_reasoning',
    aggregation: 'query_type_aggregation'
  };

  const fallback = String(queryType || 'simple_lookup')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  const key = queryTypeMap[queryType];
  if (!key) return fallback;

  const localized = t(key);
  if (typeof localized !== 'string' || !localized.trim()) return fallback;

  return localized.split(' - ')[0].trim();
}

function formatSummaryNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return numeric.toLocaleString();
}

function renderAskExecutionSummary(result) {
  if (!result || typeof result !== 'object') return '';

  const confidence = Number(result.confidence);
  const confidenceText = Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : 'n/a';
  const chunksUsed = Number(result.chunks_used);
  const sourceCount = Array.isArray(result.sources)
    ? result.sources.length
    : Array.isArray(result.top)
      ? result.top.length
      : 0;
  const citationsCount = Array.isArray(result.citations?.citations)
    ? result.citations.citations.length
    : Array.isArray(result.llm_response?.citations)
      ? result.llm_response.citations.length
      : 0;
  const snippetsCount = Array.isArray(result.snippets) ? result.snippets.length : 0;
  const totalMs = Number(result.trace?.total_duration_ms);

  const metricItems = [
    { label: 'Type', value: formatQueryTypeLabel(result.query_type || 'simple_lookup') },
    { label: 'Confidence', value: confidenceText },
    { label: 'Chunks', value: formatSummaryNumber(chunksUsed) },
    { label: 'Sources', value: formatSummaryNumber(sourceCount) },
    { label: 'Citations', value: formatSummaryNumber(citationsCount) },
    { label: 'Snippets', value: formatSummaryNumber(snippetsCount) }
  ];

  if (Number.isFinite(totalMs) && totalMs > 0) {
    metricItems.push({ label: 'Latency', value: `${Math.round(totalMs)}ms` });
  }

  const metricHtml = metricItems.map(item => `
    <div class="ask-summary-metric">
      <span class="ask-summary-label">${escapeHtml(item.label)}</span>
      <span class="ask-summary-value">${escapeHtml(item.value)}</span>
    </div>
  `).join('');

  const retrievalSources = result.retrieval_sources && typeof result.retrieval_sources === 'object'
    ? Object.entries(result.retrieval_sources).filter(([, count]) => Number(count) > 0)
    : [];

  const retrievalHtml = retrievalSources.length > 0
    ? `<div class="ask-summary-source-row">${
        retrievalSources
          .map(([name, count]) => `<span class="ask-summary-source-pill">${escapeHtml(humanizeTraceKey(name))}: ${formatSummaryNumber(count)}</span>`)
          .join('')
      }</div>`
    : '';

  const pathValue = Array.isArray(result.tree_paths) && result.tree_paths.length > 0 ? result.tree_paths[0] : null;
  const pathHtml = pathValue
    ? `<div class="ask-summary-path"><span class="ask-summary-path-label">Top Path</span><code>${escapeHtml(pathValue)}</code></div>`
    : '';

  return `
    <div class="ask-summary-card">
      <div class="ask-summary-header">
        <span>Execution Summary</span>
      </div>
      <div class="ask-summary-grid">${metricHtml}</div>
      ${retrievalHtml}
      ${pathHtml}
    </div>
  `;
}

function displayAskResult(result, showTrace = false) {
  // Store for feedback
  currentQueryResult = result;

  const resultDiv = document.getElementById('ask-result');
  const queryText = document.getElementById('query-input').value.trim();

  // Build the result HTML with user bubble at top
  resultDiv.innerHTML = `
    <div class="user-query-bubble">
      <div class="bubble">${escapeHtml(queryText)}</div>
    </div>
    <div class="result-header">
      <span class="query-type-badge" id="query-type-badge"></span>
      <span class="confidence-badge" id="confidence-badge"></span>
      <div class="feedback-buttons" id="feedback-buttons">
        <button class="feedback-btn" data-rating="up" title="Helpful"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg></button>
        <button class="feedback-btn" data-rating="down" title="Not helpful"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg></button>
      </div>
    </div>
    <div class="result-content" id="result-content"></div>
    <div class="result-trace hidden" id="result-trace"></div>
    <div class="result-citations hidden" id="result-citations"></div>
    <div class="result-sources" id="result-sources"></div>
    <div class="related-questions hidden" id="related-questions">
      <h4 data-i18n="related_questions">${t('related_questions')}</h4>
      <div class="related-questions-list" id="related-questions-list"></div>
    </div>
  `;

  // Re-attach feedback button listeners
  resultDiv.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFeedback(btn.dataset.rating));
  });

  const typeBadge = document.getElementById('query-type-badge');
  const confidenceBadge = document.getElementById('confidence-badge');
  const traceDiv = document.getElementById('result-trace');
  const contentDiv = document.getElementById('result-content');
  const citationsDiv = document.getElementById('result-citations');
  const sourcesDiv = document.getElementById('result-sources');
  const relatedDiv = document.getElementById('related-questions');
  const relatedList = document.getElementById('related-questions-list');

  // Query type
  typeBadge.textContent = formatQueryTypeLabel(result.query_type || 'simple_lookup');

  // Confidence settings
  const showConfidence = document.getElementById('opt-show-confidence')?.checked ?? true;
  const minAnswerConfidence = parseFloat(document.getElementById('opt-min-answer-confidence')?.value || '0.3');

  // Confidence with details
  const confidence = result.confidence || result.data?.confidence || 0;
  const confidenceLevel = result.confidence_details?.level || 'unknown';

  if (showConfidence) {
    confidenceBadge.textContent = `${Math.round(confidence * 100)}% confidence`;
    confidenceBadge.className = `confidence-badge confidence-${confidenceLevel}`;
    confidenceBadge.style.display = '';
    if (result.confidence_details?.explanation?.summary) {
      confidenceBadge.title = result.confidence_details.explanation.summary;
    }
  } else {
    confidenceBadge.style.display = 'none';
  }

  // Reset feedback buttons
  resultDiv.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.classList.remove('selected');
    btn.disabled = false;
  });

  // Low confidence warning
  if (confidence < minAnswerConfidence && confidence > 0) {
    const warning = document.createElement('div');
    warning.className = 'low-confidence-warning';
    warning.innerHTML = `<svg class="warning-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>${t('low_confidence_warning')}</span>`;
    contentDiv.parentNode.insertBefore(warning, contentDiv);
  }

  // Content - check for HTML answer with citations
  let contentHtml = '';
  let plainAnswer = '';
  const executionSummaryHtml = renderAskExecutionSummary(result);

  if (result.error) {
    contentHtml = `${executionSummaryHtml}<p class="error">${escapeHtml(result.error)}</p>`;
  } else if (result.llm_response) {
    const llm = result.llm_response;
    // Use HTML answer if available (has inline citations), otherwise render markdown
    const answerContent = llm.final_answer_html || renderMarkdown(llm.final_answer) || 'No answer available';
    plainAnswer = llm.final_answer || '';
    contentHtml = `
      ${executionSummaryHtml}
      <div class="answer-text">${answerContent}</div>
      ${llm.conditions?.length ? `<h4>Conditions</h4><ul>${llm.conditions.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
      ${llm.missing_info?.length ? `<h4>Missing Information</h4><ul>${llm.missing_info.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>` : ''}
      <div class="answer-actions">
        <button class="copy-answer-btn" id="copy-answer-btn" title="Copy answer"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>
      </div>
    `;
  } else if (result.data) {
    if (result.query_type === 'comparison' && result.data.table) {
      contentHtml = `${executionSummaryHtml}${renderComparisonTable(result.data)}`;
    } else if (result.query_type === 'recommendation' && result.data.recommendations) {
      contentHtml = `${executionSummaryHtml}${renderRecommendations(result.data)}`;
    } else if (result.data.answer || result.data.final_answer) {
      const answer = result.data.final_answer || result.data.answer;
      plainAnswer = answer;
      const conditionsHtml = result.data.conditions?.length
        ? `<h4>Conditions</h4><ul>${result.data.conditions.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
        : '';
      const missingHtml = result.data.missing_info?.length
        ? `<h4>Missing Information</h4><ul>${result.data.missing_info.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`
        : '';
      contentHtml = `${executionSummaryHtml}<div class="answer-text">${renderMarkdown(answer)}</div>
        ${conditionsHtml}${missingHtml}
        <div class="answer-actions">
          <button class="copy-answer-btn" id="copy-answer-btn" title="Copy answer"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button>
        </div>`;
    } else {
      contentHtml = `${executionSummaryHtml}<pre>${JSON.stringify(result.data, null, 2)}</pre>`;
    }
  } else if (result.message) {
    contentHtml = `${executionSummaryHtml}<p>${renderMarkdown(result.message)}</p>`;
  }

  contentDiv.innerHTML = contentHtml;

  // Attach copy button handler
  const copyBtn = document.getElementById('copy-answer-btn');
  if (copyBtn && plainAnswer) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(plainAnswer).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg> Copied';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
        }, 2000);
      });
    });
  }

  // Trace - rendered after content, collapsible
  if (showTrace && result.trace) {
    traceDiv.classList.remove('hidden');
    traceDiv.innerHTML = renderTrace(result.trace);
    // Attach trace toggle
    const traceToggle = traceDiv.querySelector('.trace-toggle-btn');
    const traceBody = traceDiv.querySelector('.trace-body');
    if (traceToggle && traceBody) {
      traceToggle.addEventListener('click', () => {
        traceToggle.classList.toggle('expanded');
        traceBody.classList.toggle('expanded');
      });
    }
    // Attach step toggles
    traceDiv.querySelectorAll('.trace-step-header').forEach(header => {
      header.addEventListener('click', () => {
        const details = header.nextElementSibling;
        if (details && details.classList.contains('trace-step-details')) {
          details.classList.toggle('expanded');
          header.classList.toggle('expanded');
        }
      });
    });
  } else {
    traceDiv.classList.add('hidden');
    traceDiv.innerHTML = '';
  }

  // Citations
  if (result.citations?.citations?.length > 0) {
    citationsDiv.classList.remove('hidden');
    citationsDiv.innerHTML = `
      <h4>${t('sources_cited')}</h4>
      <div class="citations-list">
        ${result.citations.citations.map(c => `
          <div class="citation-item" data-chunk-id="${c.chunk_id}">
            <span class="citation-number">[${c.number}]</span>
            <span class="citation-title">${c.title}</span>
            ${c.node_name ? `<span class="citation-node">(${c.node_name})</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } else {
    citationsDiv.classList.add('hidden');
    citationsDiv.innerHTML = '';
  }

  // Facts - show extracted facts
  let factsHtml = '';
  const facts = result.facts || [];
  if (facts.length > 0) {
    factsHtml = `
      <div class="result-facts">
        <h4>${t('extracted_facts')}</h4>
        ${facts.map(f => `
          <div class="fact-item">
            <span class="fact-type">${f.type || 'fact'}</span>
            <span class="fact-content">${f.content}</span>
            ${f.entities?.length ? `<span class="fact-entities">${f.entities.join(', ')}</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // Snippets - show highlighted matching text
  let snippetsHtml = '';
  const snippets = result.snippets || [];
  if (snippets.length > 0) {
    snippetsHtml = `
      <div class="result-snippets">
        <h4>${t('relevant_excerpts')}</h4>
        ${snippets.map(s => `
          <div class="snippet-item">
            <div class="snippet-source">${s.source || 'Unknown source'}</div>
            <div class="snippet-text">${s.html || s.text}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Sources - display as cards
  const sources = result.sources || result.top?.map(t => t.node) || [];
  let sourcesHtml = '';
  if (sources.length > 0) {
    sourcesHtml = `
      <div class="source-cards">
        ${sources.map(s => {
          const name = s.name || s.node_id || s;
          const id = s.node_id || '';
          return `
            <div class="source-card">
              <svg class="source-card-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="source-card-name">${escapeHtml(typeof name === 'string' ? name : String(name))}</span>
              ${id ? `<span class="source-card-id">${escapeHtml(id)}</span>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  sourcesDiv.innerHTML = factsHtml + snippetsHtml + sourcesHtml;

  // Related questions
  if (result.related_questions?.length > 0) {
    relatedDiv.classList.remove('hidden');
    relatedList.innerHTML = result.related_questions.map(q => `
      <button class="related-question-btn" data-question="${encodeURIComponent(q.question)}">
        ${q.question}
      </button>
    `).join('');
  } else {
    relatedDiv.classList.add('hidden');
    relatedList.innerHTML = '';
  }

  resultDiv.classList.remove('hidden');

  // Scroll chat to bottom after result
  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
  }
}

function renderComparisonTable(data) {
  if (!data.table) return '<p>No comparison data available</p>';

  const { headers, rows } = data.table;

  let html = '<table class="data-table"><thead><tr>';
  headers.forEach(h => html += `<th>${h}</th>`);
  html += '</tr></thead><tbody>';

  rows.forEach(row => {
    html += '<tr>';
    row.forEach(cell => html += `<td>${cell}</td>`);
    html += '</tr>';
  });

  html += '</tbody></table>';

  if (data.summary) {
    html += `<h4 style="margin-top: 16px">Summary</h4><p>${data.summary}</p>`;
  }

  return html;
}

function renderRecommendations(data) {
  const recs = data.recommendations || [];

  let html = '<div class="recommendations">';

  recs.forEach((rec, i) => {
    html += `
      <div class="recommendation-item" style="padding: 12px; background: var(--bg-main); border-radius: 8px; margin-bottom: 12px;">
        <h4>${i + 1}. ${rec.name}</h4>
        <p>${rec.why_recommended || ''}</p>
        ${rec.match_score ? `<span class="confidence-badge">${Math.round(rec.match_score * 100)}% match</span>` : ''}
      </div>
    `;
  });

  html += '</div>';

  if (data.reasoning) {
    html += `<h4 style="margin-top: 16px">Reasoning</h4><p>${data.reasoning}</p>`;
  }

  return html;
}

function humanizeTraceKey(keyPath) {
  return String(keyPath || 'value')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\[(\d+)\]/g, ' $1')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatTracePrimitive(value, maxLen = 220) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  let text = String(value);
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}...`;
  }
  return text;
}

function collectTraceResultRows(value, keyPrefix = '', depth = 0, rows = [], seen = new WeakSet(), limit = 36) {
  if (rows.length >= limit) return rows;

  const baseKey = keyPrefix || 'value';

  if (value === null || value === undefined || typeof value !== 'object') {
    rows.push({ key: baseKey, value: formatTracePrimitive(value) });
    return rows;
  }

  if (seen.has(value)) {
    rows.push({ key: baseKey, value: '[circular reference]' });
    return rows;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ key: baseKey, value: '[] (empty)' });
      return rows;
    }

    const scalarArray = value.every(item => item === null || item === undefined || typeof item !== 'object');
    if (scalarArray) {
      const preview = value.slice(0, 6).map(item => formatTracePrimitive(item, 60)).join(', ');
      const suffix = value.length > 6 ? ` (+${value.length - 6} more)` : '';
      rows.push({ key: baseKey, value: `[${preview}]${suffix}` });
      return rows;
    }

    rows.push({ key: baseKey, value: `${value.length} item(s)` });
    if (depth >= 2) return rows;

    const sampleCount = Math.min(2, value.length);
    for (let i = 0; i < sampleCount && rows.length < limit; i++) {
      collectTraceResultRows(value[i], `${baseKey}[${i}]`, depth + 1, rows, seen, limit);
    }
    return rows;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    rows.push({ key: baseKey, value: '{} (empty)' });
    return rows;
  }

  for (const [key, nestedValue] of entries) {
    if (rows.length >= limit) break;
    const nextKey = keyPrefix ? `${keyPrefix}.${key}` : key;

    if (nestedValue === null || nestedValue === undefined || typeof nestedValue !== 'object') {
      rows.push({ key: nextKey, value: formatTracePrimitive(nestedValue) });
      continue;
    }

    if (Array.isArray(nestedValue)) {
      if (nestedValue.length === 0) {
        rows.push({ key: nextKey, value: '[] (empty)' });
        continue;
      }

      const scalarArray = nestedValue.every(item => item === null || item === undefined || typeof item !== 'object');
      if (scalarArray) {
        const preview = nestedValue.slice(0, 6).map(item => formatTracePrimitive(item, 60)).join(', ');
        const suffix = nestedValue.length > 6 ? ` (+${nestedValue.length - 6} more)` : '';
        rows.push({ key: nextKey, value: `[${preview}]${suffix}` });
      } else if (depth >= 2) {
        rows.push({ key: nextKey, value: `${nestedValue.length} item(s)` });
      } else {
        rows.push({ key: nextKey, value: `${nestedValue.length} item(s)` });
        const sampleCount = Math.min(2, nestedValue.length);
        for (let i = 0; i < sampleCount && rows.length < limit; i++) {
          collectTraceResultRows(nestedValue[i], `${nextKey}[${i}]`, depth + 1, rows, seen, limit);
        }
      }
      continue;
    }

    if (depth >= 2) {
      rows.push({ key: nextKey, value: '{...}' });
      continue;
    }
    collectTraceResultRows(nestedValue, nextKey, depth + 1, rows, seen, limit);
  }

  return rows;
}

function renderTraceResultSummary(result) {
  if (result === null || result === undefined) {
    return '<div class="trace-result-empty">No payload</div>';
  }

  const rows = collectTraceResultRows(result, '', 0, [], new WeakSet(), 36);
  if (rows.length === 0) {
    return '<div class="trace-result-empty">No payload</div>';
  }

  const visibleRows = rows.slice(0, 20);
  const rowsHtml = visibleRows.map(row => `
    <div class="trace-result-row">
      <span class="trace-result-key">${escapeHtml(humanizeTraceKey(row.key))}</span>
      <span class="trace-result-value">${escapeHtml(row.value)}</span>
    </div>
  `).join('');

  const overflow = rows.length > visibleRows.length
    ? `<div class="trace-result-more">+${rows.length - visibleRows.length} more field(s) in raw payload</div>`
    : '';

  return `<div class="trace-result-grid">${rowsHtml}</div>${overflow}`;
}

function renderTraceRawPayload(result) {
  if (result === null || result === undefined) return '';

  let rawText = '';
  try {
    rawText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch {
    rawText = '[Unable to serialize payload]';
  }

  const maxChars = 12000;
  if (rawText.length > maxChars) {
    rawText = `${rawText.slice(0, maxChars)}\n... (truncated ${rawText.length - maxChars} chars)`;
  }

  return `
    <details class="trace-raw-payload">
      <summary>Raw Payload</summary>
      <pre class="trace-step-result">${escapeHtml(rawText)}</pre>
    </details>
  `;
}

function formatTraceMetric(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '');
  return numeric.toFixed(digits).replace(/\.?0+$/, '');
}

function summarizeTraceArray(items, formatter, limit = 3) {
  if (!Array.isArray(items) || items.length === 0) return '';

  const preview = items
    .slice(0, limit)
    .map(formatter)
    .filter(Boolean);

  if (preview.length === 0) return '';
  const remaining = items.length - preview.length;
  return remaining > 0 ? `${preview.join(' | ')} +${remaining}` : preview.join(' | ');
}

function pushTraceInsight(insights, label, value) {
  if (value === null || value === undefined) return;
  const text = String(value).trim();
  if (!text) return;
  insights.push({ label, value: text });
}

function buildTraceStepInsights(step) {
  const result = step?.result;
  if (!result || typeof result !== 'object') return [];

  const insights = [];

  if (result.query_type) {
    pushTraceInsight(insights, 'Query Type', formatQueryTypeLabel(result.query_type));
  }

  if (typeof result.confidence === 'number') {
    pushTraceInsight(insights, 'Confidence', `${Math.round(result.confidence * 100)}%`);
  }

  if (result.method) {
    pushTraceInsight(insights, 'Method', result.method);
  }

  if (Array.isArray(result.entities) && result.entities.length > 0) {
    pushTraceInsight(insights, 'Entities', summarizeTraceArray(result.entities, entity => entity));
  }

  if (Array.isArray(result.criteria) && result.criteria.length > 0) {
    pushTraceInsight(insights, 'Criteria', summarizeTraceArray(result.criteria, criterion => criterion));
  }

  if (Array.isArray(result.subQueries) && result.subQueries.length > 0) {
    pushTraceInsight(insights, 'Sub-Queries', summarizeTraceArray(result.subQueries, query => query));
  }

  if (Array.isArray(result.variants) && result.variants.length > 0) {
    const variantText = summarizeTraceArray(
      result.variants,
      variant => `${variant.text} (${formatTraceMetric(variant.weight ?? 1, 2)})`
    );
    pushTraceInsight(insights, 'Variants', variantText);
  }

  if (typeof result.variants_used === 'number') {
    pushTraceInsight(insights, 'Variants Used', result.variants_used);
  }

  if (typeof result.doc_title === 'number' || typeof result.bm25 === 'number' || typeof result.simple === 'number') {
    pushTraceInsight(
      insights,
      'Direct Hits',
      `title ${result.doc_title || 0}, bm25 ${result.bm25 || 0}, simple ${result.simple || 0}`
    );
  }

  if (Array.isArray(result.top_nodes) && result.top_nodes.length > 0) {
    const topNodesText = summarizeTraceArray(
      result.top_nodes,
      node => `${node.name || node.id || 'node'} (${formatTraceMetric(node.score ?? 0, 3)})`
    );
    pushTraceInsight(insights, 'Top Nodes', topNodesText);
  }

  if (Array.isArray(result.nodes) && result.nodes.length > 0) {
    const nodeText = summarizeTraceArray(
      result.nodes,
      node => `${node.name || node.id || 'node'} (+${node.chunks_added || 0})`
    );
    pushTraceInsight(insights, 'Node Coverage', nodeText);
  }

  if (Array.isArray(result.top_chunks) && result.top_chunks.length > 0) {
    const topChunkText = summarizeTraceArray(
      result.top_chunks,
      chunk => `${chunk.node || chunk.doc || chunk.id} (${formatTraceMetric(chunk.score ?? 0, 3)})`
    );
    pushTraceInsight(insights, 'Top Chunks', topChunkText);
  }

  if (Array.isArray(result.top_reranked) && result.top_reranked.length > 0) {
    const rerankedText = summarizeTraceArray(
      result.top_reranked,
      chunk => `${chunk.id} (${formatTraceMetric(chunk.score ?? chunk.rerank_score ?? 0, 3)})`
    );
    pushTraceInsight(insights, 'Reranked Top', rerankedText);
  }

  if (typeof result.added === 'number' || typeof result.total === 'number') {
    pushTraceInsight(insights, 'Enrichment', `${result.added || 0} added, ${result.total || 0} total`);
  }

  if (typeof result.from_hierarchical === 'number' || typeof result.from_direct === 'number') {
    pushTraceInsight(
      insights,
      'Chunk Merge',
      `hierarchical ${result.from_hierarchical || 0}, direct ${result.from_direct || 0}, total ${result.unique_total || 0}`
    );
  }

  if (Array.isArray(result.paths) && result.paths.length > 0) {
    const pathPreview = summarizeTraceArray(
      result.paths,
      path => Array.isArray(path) ? path.join(' > ') : path
    );
    pushTraceInsight(insights, 'Paths', pathPreview);
  }

  if (Array.isArray(result.sources) && result.sources.length > 0) {
    pushTraceInsight(insights, 'Sources', result.sources.join(', '));
  }

  if (result.factors && typeof result.factors === 'object') {
    const factorText = summarizeTraceArray(
      Object.entries(result.factors)
        .filter(([, value]) => typeof value === 'number')
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])),
      ([key, value]) => `${humanizeTraceKey(key)} ${formatTraceMetric(value, 2)}`,
      4
    );
    pushTraceInsight(insights, 'Confidence Factors', factorText);
  }

  return insights.slice(0, 8);
}

function renderTraceStepInsights(step) {
  const insights = buildTraceStepInsights(step);
  if (insights.length === 0) return '';

  const insightHtml = insights.map(item => `
    <div class="trace-insight-item">
      <span class="trace-insight-label">${escapeHtml(item.label)}</span>
      <span class="trace-insight-value">${escapeHtml(item.value)}</span>
    </div>
  `).join('');

  return `<div class="trace-step-insights">${insightHtml}</div>`;
}

function shouldExpandTraceStepByDefault(step, index, totalSteps) {
  if (!step) return false;
  if (step.status === 'error') return true;
  if (index === 0 || index === totalSteps - 1) return true;

  const stepName = String(step.name || '').toLowerCase();
  return stepName.includes('hierarchical retrieval complete') || stepName.includes('final chunk selection');
}

// ── Query Visualization ────────────────────────────────────────────────────

function buildTreeFromPaths(allNodes) {
  if (!Array.isArray(allNodes) || allNodes.length === 0) return null;
  const root = { name: 'Knowledge Tree', children: [], score: 0, depth: -1 };
  for (const node of allNodes) {
    const path = Array.isArray(node.path) && node.path.length > 0
      ? node.path
      : [node.name];
    let cur = root;
    for (let d = 0; d < path.length; d++) {
      const segName = path[d];
      let child = cur.children.find(c => c.name === segName);
      if (!child) {
        const match = allNodes.find(n => n.name === segName && n.depth === d);
        child = { name: segName, children: [], score: match ? match.score : 0, depth: d };
        cur.children.push(child);
      }
      cur = child;
    }
  }
  return root;
}

function renderTreeSvg(root) {
  const NODE_W = 140, NODE_H = 32, COL_W = 170, MARGIN = 12, ROW_GAP = 8;

  // Count leaves for height calculation
  function countLeaves(node) {
    if (node.children.length === 0) return 1;
    return node.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  // Assign layout positions: y is the vertical center of the node's allocated band
  function assignPositions(node, depth, yStart, yEnd) {
    const x = depth * COL_W + MARGIN;
    const y = (yStart + yEnd) / 2;
    node._x = x;
    node._y = y;
    node._depth = depth;

    if (node.children.length > 0) {
      const totalLeaves = countLeaves(node);
      let yOff = yStart;
      for (const child of node.children) {
        const childLeaves = countLeaves(child);
        const childHeight = (yEnd - yStart) * (childLeaves / totalLeaves);
        assignPositions(child, depth + 1, yOff, yOff + childHeight);
        yOff += childHeight;
      }
    }
  }

  // Decide whether to show virtual root
  const showRoot = root.children.length > 1;
  const topNodes = showRoot ? [root] : root.children;

  // Calculate canvas dimensions
  const leafCount = countLeaves(root);
  const svgHeight = Math.max(60, leafCount * (NODE_H + ROW_GAP));
  const maxDepth = (function getMaxDepth(n, d) {
    if (n.children.length === 0) return d;
    return Math.max(...n.children.map(c => getMaxDepth(c, d + 1)));
  })(root, 0);
  const svgWidth = (showRoot ? maxDepth + 1 : maxDepth) * COL_W + NODE_W + MARGIN * 2;

  // Assign positions
  if (showRoot) {
    assignPositions(root, 0, 0, svgHeight);
  } else {
    // Place children as if root is hidden — distribute vertically
    let yOff = 0;
    const totalLeaves = countLeaves(root);
    for (const child of root.children) {
      const childLeaves = countLeaves(child);
      const childHeight = svgHeight * (childLeaves / totalLeaves);
      assignPositions(child, 0, yOff, yOff + childHeight);
      yOff += childHeight;
    }
  }

  // Collect all nodes and edges
  const nodes = [];
  const edges = [];
  function collect(node) {
    if (node === root && !showRoot) {
      node.children.forEach(collect);
      return;
    }
    nodes.push(node);
    for (const child of node.children) {
      edges.push({ parent: node, child });
      collect(child);
    }
  }
  collect(root);

  // Render edges
  let svgContent = '';
  for (const { parent, child } of edges) {
    const x1 = parent._x + NODE_W;
    const y1 = parent._y;
    const x2 = child._x;
    const y2 = child._y;
    const cx1 = x1 + (x2 - x1) * 0.5;
    const cx2 = x2 - (x2 - x1) * 0.5;
    svgContent += `<path class="tv-edge" d="M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}"/>`;
  }

  // Render nodes
  for (const node of nodes) {
    const s = node.score || 0;
    const cls = s >= 0.5 ? 'tv-node--high' : s >= 0.25 ? 'tv-node--med' : 'tv-node--low';
    const label = node.name.length > 17 ? node.name.slice(0, 15) + '…' : node.name;
    const scoreText = node.depth >= 0 && s > 0 ? s.toFixed(2) : '';
    const nodeY = node._y - NODE_H / 2;
    svgContent += `<g class="tv-node ${cls}" transform="translate(${node._x},${nodeY})">
      <rect width="${NODE_W}" height="${NODE_H}" rx="5"/>
      <text class="tv-label" x="${NODE_W / 2}" y="13" text-anchor="middle" dominant-baseline="auto">${escapeHtml(label)}</text>
      ${scoreText ? `<text class="tv-score" x="${NODE_W - 4}" y="${NODE_H - 4}" text-anchor="end">${scoreText}</text>` : ''}
    </g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="display:block">${svgContent}</svg>`;
}

function renderQueryVizPanel(trace) {
  if (!trace || !trace.steps) return '';

  const treeStep = trace.steps.find(s => s.name === 'Hierarchy: Top-Down Navigation');
  const classifyStep = trace.steps.find(s => s.name === 'Query Classification');
  const completeStep = trace.steps.find(s => s.name === 'Hierarchical Retrieval Complete');

  // Classification pill
  const queryType = classifyStep && classifyStep.result && classifyStep.result.type
    ? classifyStep.result.type
    : (classifyStep && classifyStep.result && typeof classifyStep.result === 'string'
      ? classifyStep.result : null);
  const typePill = queryType
    ? `<span class="query-viz-pill query-viz-pill--type">${escapeHtml(queryType)}</span>`
    : '';

  // Retrieval source counts
  let sourceHtml = '';
  if (completeStep && completeStep.result) {
    const r = completeStep.result;
    const hier = r.hierarchical_chunks != null ? r.hierarchical_chunks : (r.from_hierarchy != null ? r.from_hierarchy : null);
    const direct = r.direct_chunks != null ? r.direct_chunks : (r.from_direct != null ? r.from_direct : null);
    const total = r.total_chunks != null ? r.total_chunks : null;
    if (hier != null) sourceHtml += `<span class="query-viz-pill">hierarchical&nbsp;${hier}</span>`;
    if (direct != null) sourceHtml += `<span class="query-viz-pill">direct&nbsp;${direct}</span>`;
    if (total != null) sourceHtml += `<span class="query-viz-pill query-viz-pill--total">total&nbsp;${total}</span>`;
  }

  // Tree SVG
  let treeHtml = '';
  if (treeStep && treeStep.result && Array.isArray(treeStep.result.all_nodes) && treeStep.result.all_nodes.length > 0) {
    const treeData = buildTreeFromPaths(treeStep.result.all_nodes);
    if (treeData) {
      treeHtml = `<div class="query-viz-tree">${renderTreeSvg(treeData)}</div>`;
    }
  }

  // Only render panel if we have something to show
  if (!typePill && !sourceHtml && !treeHtml) return '';

  return `<div class="query-viz-panel">
    <div class="query-viz-header">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93A10 10 0 0 0 2 12h2a8 8 0 0 1 13.66-5.66l-2.12 2.12A5 5 0 0 0 7 12H5a7 7 0 0 1 11.95-5"/></svg>
      <span class="query-viz-title">Query Trace</span>
      ${typePill}${sourceHtml}
    </div>
    ${treeHtml}
  </div>`;
}

function renderTrace(trace) {
  if (!trace || !trace.steps || trace.steps.length === 0) {
    return '<p class="trace-empty">No trace information available</p>';
  }

  const totalMs = trace.total_duration_ms || 0;
  const maxStepMs = Math.max(...trace.steps.map(s => s.duration_ms || 0), 1);
  const stepCount = trace.steps.length;
  const successCount = trace.steps.filter(s => s.status === 'success').length;
  const firstTimestamp = trace.steps[0]?.timestamp || Date.now();

  // Progress dots
  let progressHtml = '<div class="trace-progress">';
  trace.steps.forEach((step, i) => {
    const dotClass = step.status === 'success' ? 'success' :
                     step.status === 'error' ? 'error' :
                     step.status === 'skipped' ? 'skipped' : '';
    progressHtml += `<span class="trace-progress-dot ${dotClass}" title="${step.name}"></span>`;
    if (i < trace.steps.length - 1) {
      progressHtml += '<span class="trace-progress-line"></span>';
    }
  });
  progressHtml += '</div>';

  // Visualization panel (prepended before the toggle/step timeline)
  const vizHtml = renderQueryVizPanel(trace);

  // Toggle button
  let html = vizHtml + `
    <button class="trace-toggle-btn expanded" type="button">
      <span class="trace-toggle-left">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Processing Trace (${successCount}/${stepCount} steps${totalMs ? ` \u00B7 ${totalMs}ms` : ''})
      </span>
      <svg class="trace-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    ${progressHtml}
    <div class="trace-body expanded">
      <div class="trace-body-inner">
        <div class="trace-timeline">
  `;

  trace.steps.forEach((step, i) => {
    const statusClass = step.status === 'success' ? 'trace-success' :
                       step.status === 'error' ? 'trace-error' :
                       step.status === 'skipped' ? 'trace-skipped' : '';
    const metaStatusClass = step.status === 'error' ? 'error' :
                           step.status === 'skipped' ? 'skipped' : 'success';
    const isHierarchy = step.name && step.name.toLowerCase().startsWith('hierarchy');
    const hierarchyTag = isHierarchy ? '<span class="trace-step-tag">hierarchy</span>' : '';
    const duration = step.duration_ms ? `${step.duration_ms}ms` : '';
    const durationBarWidth = step.duration_ms ? Math.max(5, (step.duration_ms / maxStepMs) * 100) : 0;
    const relativeMs = step.timestamp ? Math.max(0, step.timestamp - firstTimestamp) : 0;
    const defaultExpanded = shouldExpandTraceStepByDefault(step, i, trace.steps.length);
    const expandedClass = defaultExpanded ? ' expanded' : '';
    const insightsHtml = renderTraceStepInsights(step);
    const resultSummaryHtml = renderTraceResultSummary(step.result);
    const rawPayloadHtml = renderTraceRawPayload(step.result);

    html += `
      <div class="trace-step ${statusClass}">
        <div class="trace-step-header${expandedClass}">
          <span class="trace-step-number">${i + 1}</span>
          <span class="trace-step-name">${escapeHtml(step.name)}</span>
          ${hierarchyTag}
          ${duration ? `<span class="trace-step-duration">${duration}</span>` : ''}
          <svg class="trace-step-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        ${durationBarWidth > 0 ? `<div class="trace-step-duration-bar" style="width: ${durationBarWidth}%"></div>` : ''}
        <div class="trace-step-details${expandedClass}">
          <div class="trace-step-details-inner">
            ${step.description ? `<p class="trace-step-description">${escapeHtml(step.description)}</p>` : ''}
            <div class="trace-step-meta">
              <span class="trace-meta-pill ${metaStatusClass}">${escapeHtml(step.status || 'success')}</span>
              <span class="trace-meta-pill">+${relativeMs}ms</span>
              ${duration ? `<span class="trace-meta-pill">step ${duration}</span>` : ''}
            </div>
            ${insightsHtml}
            ${resultSummaryHtml}
            ${rawPayloadHtml}
          </div>
        </div>
      </div>
    `;
  });

  html += '</div>';

  if (trace.total_duration_ms) {
    html += `<div class="trace-total">Total: <span class="trace-total-badge">${trace.total_duration_ms}ms</span></div>`;
  }

  html += '</div></div>';
  return html;
}

// Tree Tab
function initTree() {
  document.getElementById('refresh-tree-btn').addEventListener('click', loadTree);
  document.getElementById('add-node-btn').addEventListener('click', showAddNodeModal);
  document.getElementById('empty-tree-btn').addEventListener('click', handleEmptyTree);
  document.getElementById('close-node-detail').addEventListener('click', hideNodeDetail);
  document.getElementById('close-add-node-modal').addEventListener('click', hideAddNodeModal);
  document.getElementById('cancel-add-node').addEventListener('click', hideAddNodeModal);
  document.getElementById('add-node-form').addEventListener('submit', handleAddNode);
  document.getElementById('close-add-chunk-modal').addEventListener('click', hideAddChunkModal);
  document.getElementById('cancel-add-chunk').addEventListener('click', hideAddChunkModal);
  document.getElementById('add-chunk-form').addEventListener('submit', handleAddChunk);
}

async function handleEmptyTree() {
  const confirmation = prompt(t('empty_tree_warning'));

  if (confirmation !== 'DELETE') {
    showToast(t('empty_tree_cancelled'), 'info');
    return;
  }

  const emptyBtn = document.getElementById('empty-tree-btn');
  emptyBtn.disabled = true;

  try {
    const result = await api('/tree?confirm=yes', { method: 'DELETE' });
    showToast(`${t('empty_tree_success')}: ${result.deletedNodes} nodes, ${result.deletedChunks} chunks`, 'success');
    loadTree();
    loadDocuments();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    emptyBtn.disabled = false;
  }
}

async function loadTree() {
  const treeView = document.getElementById('tree-view');
  const skeleton = document.getElementById('skeleton-tree');

  // Show skeleton if it exists, otherwise show loading text
  if (skeleton) {
    skeleton.style.display = 'block';
  } else {
    treeView.innerHTML = `<p class="loading-text">${t('loading')}</p>`;
  }

  try {
    const data = await api('/nodes');
    allNodes = flattenTree(data.tree || []);

    if (!data.tree || data.tree.length === 0) {
      treeView.innerHTML = renderEmptyState(
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="14"/><circle cx="6" cy="19" r="3"/><line x1="12" y1="14" x2="6" y2="16"/><circle cx="18" cy="19" r="3"/><line x1="12" y1="14" x2="18" y2="16"/></svg>',
        'No nodes yet',
        'Create your first node to start building your knowledge tree.',
        '<button class="btn btn-primary" onclick="document.getElementById(\'add-node-btn\').click()">+ Add Node</button>'
      );
      return;
    }

    // Preserve search wrapper, replace tree content only
    const searchWrapper = document.getElementById('tree-search-wrapper');
    const searchHtml = searchWrapper ? searchWrapper.outerHTML : '';
    treeView.innerHTML = searchHtml + renderTree(data.tree);
    attachTreeEvents();
    populateNodeSelects();
    // Re-init search events
    initTreeSearch();

    // Update graph if currently in graph view
    if (currentGraphView === 'graph') {
      createGraph();
    }
  } catch (error) {
    treeView.innerHTML = `<p class="loading-text error">${error.message}</p>`;
  }
}

function flattenTree(nodes, result = []) {
  for (const node of nodes) {
    result.push(node);
    if (node.children?.length) {
      flattenTree(node.children, result);
    }
  }
  return result;
}

function renderTree(nodes, depth = 0) {
  if (!nodes?.length) return '';

  const listClass = depth === 0 ? 'tree-root' : 'tree-children';
  const expandedClass = depth === 1 ? ' expanded' : '';
  let html = `<ul class="${listClass}${expandedClass}">`;

  for (const node of nodes) {
    const hasChildren = node.children && node.children.length > 0;
    const childDepth = depth + 1;
    const childExpanded = childDepth === 1;
    const toggleSymbol = hasChildren
      ? (childExpanded ? '\u25BC' : '\u25B6')
      : '';

    html += `
      <li class="tree-branch">
        <div class="tree-node-item" data-node-id="${node.node_id}">
          <span class="tree-toggle">${toggleSymbol}</span>
          <span class="tree-icon">${hasChildren ? '📁' : '📄'}</span>
          <span class="tree-name">${node.name}</span>
        </div>
        ${hasChildren ? renderTree(node.children, depth + 1) : ''}
      </li>
    `;
  }

  html += '</ul>';
  return html;
}

function attachTreeEvents() {
  document.querySelectorAll('.tree-node-item').forEach(item => {
    item.addEventListener('click', () => {
      const nodeId = item.dataset.nodeId;
      const toggle = item.querySelector('.tree-toggle');
      const sibling = item.nextElementSibling;
      const children = sibling && sibling.classList.contains('tree-children')
        ? sibling
        : null;

      // Toggle expand/collapse
      if (children) {
        const isExpanded = children.classList.toggle('expanded');
        toggle.textContent = isExpanded ? '\u25BC' : '\u25B6';
      }

      // Show node detail
      loadNodeDetail(nodeId).catch(console.error);

      // Update selected state
      document.querySelectorAll('.tree-node-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
    });
  });
}

async function loadNodeDetail(nodeId) {
  const detailDiv = document.getElementById('node-detail');
  const nameEl = document.getElementById('node-detail-name');
  const contentEl = document.getElementById('node-detail-content');

  detailDiv.classList.remove('hidden');
  nameEl.textContent = 'Loading...';
  contentEl.innerHTML = '';

  try {
    // Fetch node info, chunks, and entities in parallel
    const [node, chunksData, entitiesData] = await Promise.all([
      api(`/nodes/${encodeURIComponent(nodeId)}?context=true`),
      api(`/chunks/${encodeURIComponent(nodeId)}`).catch(() => ({ chunks: [] })),
      api(`/nodes/${encodeURIComponent(nodeId)}/entities?debug=true`).catch(() => ({ entities: [], facts: [], debug: null }))
    ]);

    const nodeName = node.node?.name || node.name;
    nameEl.textContent = nodeName;
    // Add Content button alongside the name (insert into the header row)
    const detailHeader = detailDiv.querySelector('.node-detail-header');
    const existingAddBtn = detailHeader.querySelector('.add-content-btn');
    if (!existingAddBtn) {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary btn-sm add-content-btn';
      addBtn.textContent = '+ Add Content';
      addBtn.onclick = () => showAddChunkModal(nodeId);
      detailHeader.insertBefore(addBtn, detailHeader.querySelector('.close-btn'));
    } else {
      existingAddBtn.onclick = () => showAddChunkModal(nodeId);
    }

    const n = node.node || node;
    const chunks = chunksData.chunks || [];
    const entities = entitiesData.entities || [];
    const facts = entitiesData.facts || [];

    // Format summary with proper line breaks
    const summaryHtml = (n.node_summary || '(none)')
      .replace(/\n/g, '<br>')
      .replace(/Key topics:/g, '<strong>Key topics:</strong>');

    const isSchema   = n.is_schema_node === 1 || n.is_schema_node === true;
    const nodeKws    = (() => { try { return JSON.parse(n.keywords_json || '[]'); } catch(_){return [];} })();

    let html = `
      <div class="node-meta">
        <dl>
          <dt>ID</dt>
          <dd><code>${n.node_id}</code>${isSchema ? ' <span class="schema-badge" title="Schema node">&#128204;</span>' : ''}</dd>
          <dt>Level</dt>
          <dd>${n.level}</dd>
          <dt>Parent</dt>
          <dd>${n.parent_id || '(root)'}</dd>
        </dl>
      </div>

      <div class="node-description-section">
        <div class="node-desc-header">
          <h4>Description</h4>
          <button class="btn btn-ghost btn-xs node-desc-edit-btn" data-node-id="${n.node_id}">Edit</button>
        </div>
        <p class="node-desc-view">${n.node_description ? escapeHtml(n.node_description) : '<em class="muted">None</em>'}</p>
        <div class="node-desc-edit-form" style="display:none">
          <textarea class="node-desc-textarea" rows="3">${escapeHtml(n.node_description || '')}</textarea>
          <div class="node-desc-form-actions">
            <button class="btn btn-primary btn-xs node-desc-save" data-node-id="${n.node_id}">Save</button>
            <button class="btn btn-ghost btn-xs node-desc-cancel">Cancel</button>
          </div>
        </div>
      </div>

      <div class="node-schema-actions">
        ${isSchema
          ? `<button class="btn btn-ghost btn-sm node-schema-unflag" data-node-id="${n.node_id}" title="Remove schema node flag">Unmark Schema</button>
             <button class="btn btn-secondary btn-sm node-add-schema-child" data-node-id="${n.node_id}" title="Add a child schema node">+ Child Node</button>`
          : `<button class="btn btn-ghost btn-sm node-schema-flag" data-node-id="${n.node_id}" title="Mark this node as a schema node">📌 Mark as Schema</button>`
        }
      </div>
      <div class="node-add-child-form" data-node-id="${n.node_id}" style="display:none">
        <input class="node-add-child-name" type="text" placeholder="Child node name" />
        <input class="node-add-child-desc" type="text" placeholder="Description (optional)" />
        <div class="node-desc-form-actions">
          <button class="btn btn-primary btn-xs node-add-child-save" data-node-id="${n.node_id}">Add</button>
          <button class="btn btn-ghost btn-xs node-add-child-cancel">Cancel</button>
        </div>
      </div>

      ${nodeKws.length > 0 ? `<div class="node-keywords-section"><h4>Keywords</h4><div class="keyword-chips">${nodeKws.map(k => `<span class="keyword-chip">${escapeHtml(k)}</span>`).join('')}</div></div>` : ''}

      <div class="node-summary">
        <h4>Summary</h4>
        <p>${summaryHtml}</p>
      </div>
    `;

    // Show child nodes as a clickable list
    if (node.children?.length) {
      html += `
        <div class="node-children-section">
          <h4>📁 Child Nodes (${node.children.length})</h4>
          <ul class="node-children-list">
            ${node.children.map(child => `
              <li class="node-child-item" data-node-id="${child.node_id}" title="${child.node_summary || ''}">
                <span class="node-child-icon">${child.children?.length ? '📁' : '📄'}</span>
                <span class="node-child-name">${child.name}</span>
              </li>
            `).join('')}
          </ul>
        </div>
      `;
    }

    // Debug info from API
    const debugInfo = entitiesData.debug;

    // Show entities
    if (entities.length > 0) {
      html += `
        <div class="node-entities">
          <h4>🏷️ Entities (${entities.length})</h4>
          <div class="entities-list">
      `;

      for (const entity of entities) {
        const entityFacts = entity.facts || [];
        html += `
          <div class="entity-item">
            <div class="entity-header">
              <span class="entity-name">${entity.name}</span>
              <span class="entity-type">${entity.type || 'unknown'}</span>
              ${entity.mention_count > 1 ? `<span class="entity-mentions">${entity.mention_count} mentions</span>` : ''}
            </div>
            ${entity.description ? `<p class="entity-description">${entity.description}</p>` : ''}
            ${entity.aliases?.length ? `<div class="entity-aliases">Also: ${entity.aliases.join(', ')}</div>` : ''}
            ${entityFacts.length > 0 ? `
              <div class="entity-facts-mini">
                ${entityFacts.map(f => `<span class="fact-mini">${f.content}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        `;
      }

      html += '</div></div>';
    } else if (debugInfo) {
      // Show helpful message when no entities found
      const nodesWithEntitiesStr = debugInfo.nodes_with_entities?.length > 0
        ? debugInfo.nodes_with_entities.map(n => `${n.node_id} (${n.entity_count})`).join(', ')
        : 'none';

      html += `
        <div class="node-entities empty">
          <h4>🏷️ Entities</h4>
          <p class="no-entities">No entities found for this node.</p>
          <div class="debug-info">
            <small>
              <strong>This node:</strong> ${debugInfo.chunks_in_this_node} chunks, ${debugInfo.mentions_for_node_chunks || 0} mentions<br>
              <strong>Database totals:</strong> ${debugInfo.total_entities_in_db} entities, ${debugInfo.total_mentions_in_db} mentions<br>
              <strong>Nodes with entities:</strong> ${nodesWithEntitiesStr}
              ${debugInfo.total_entities_in_db === 0 ?
                '<br><br><strong>Tip:</strong> Go to Stats tab and click "Extract Entities" to process documents.' :
                debugInfo.entities_with_this_node_id === 0 && debugInfo.mentions_for_node_chunks === 0 ?
                '<br><br><strong>Note:</strong> Entities exist but are linked to other nodes. This node\'s chunks may not have been extracted yet.' : ''}
            </small>
          </div>
        </div>
      `;
    }

    // Show facts
    if (facts.length > 0) {
      html += `
        <div class="node-facts">
          <h4>Facts (${facts.length})</h4>
          <div class="facts-list">
      `;

      for (const fact of facts) {
        const confidenceClass = fact.confidence >= 0.8 ? 'high' : fact.confidence >= 0.5 ? 'medium' : 'low';
        html += `
          <div class="fact-item">
            <div class="fact-header">
              <span class="fact-type-badge">${fact.fact_type || 'fact'}</span>
              <span class="fact-confidence confidence-${confidenceClass}">${Math.round(fact.confidence * 100)}%</span>
            </div>
            <p class="fact-content">${fact.content}</p>
            ${fact.source_doc ? `<span class="fact-source">From: ${fact.source_doc}</span>` : ''}
          </div>
        `;
      }

      html += '</div></div>';
    } else if (debugInfo && debugInfo.total_facts_in_db > 0) {
      html += `
        <div class="node-facts empty">
          <h4>Facts</h4>
          <p class="no-facts">No facts found for this node (${debugInfo.total_facts_in_db} facts in database).</p>
        </div>
      `;
    }

    // Show chunks / KPs
    if (chunks.length > 0) {
      const hasKPs = chunks.some(c => c.kp_type && c.kp_type !== 'legacy_chunk');
      const sectionLabel = hasKPs
        ? `🧠 Knowledge Points (${chunks.length} KP${chunks.length > 1 ? 's' : ''})`
        : `📄 Content (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`;

      html += `
        <div class="node-chunks">
          <h4>${escapeHtml(sectionLabel)}</h4>
          <div class="chunks-list">
      `;

      for (const chunk of chunks) {
        const fullContent = (chunk.content_clean || chunk.content || '').trim();
        const keywords = chunk.keywords_json ?
          (typeof chunk.keywords_json === 'string' ? JSON.parse(chunk.keywords_json) : chunk.keywords_json) : [];
        const kpType = chunk.kp_type || chunk.chunk_type || 'content';
        let sourceDocs = [];
        try { sourceDocs = JSON.parse(chunk.source_documents_json || '[]'); } catch (_) {}
        const sourceCount = sourceDocs.length;
        const sourceTitle = sourceCount > 1
          ? sourceDocs.map(d => escapeHtml(d.doc_title || '')).join(', ')
          : escapeHtml(chunk.doc_title || 'Unknown source');

        const isManual = chunk.document_id == null;
        html += `
          <div class="chunk-item">
            <div class="chunk-header">
              <span class="kp-type-badge kp-type-${escapeHtml(kpType)}">${escapeHtml(kpType)}</span>
              <span class="chunk-source">${escapeHtml(chunk.doc_title || 'Unknown source')}</span>
              ${sourceCount > 1 ? `<span class="kp-source-count" title="${sourceTitle}">📄 ${sourceCount} sources</span>` : ''}
              ${isManual ? `<button class="btn-icon btn-danger-ghost" title="Delete" data-chunk-id="${chunk.id}" data-node-id="${escapeHtml(nodeId)}">✕</button>` : ''}
            </div>
            <p class="chunk-preview">${escapeHtml(fullContent).replace(/\n/g, '<br>')}</p>
            ${keywords.length ? `<div class="chunk-keywords">${keywords.map(k => `<span class="keyword-tag">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
          </div>
        `;
      }

      html += '</div></div>';
    } else if (entities.length === 0 && facts.length === 0) {
      html += '<p class="no-chunks">No content in this node</p>';
    }

    contentEl.innerHTML = html;

    // Wire up manual chunk delete buttons
    contentEl.querySelectorAll('.btn-danger-ghost[data-chunk-id]').forEach(btn => {
      btn.addEventListener('click', () => handleDeleteChunk(btn.dataset.chunkId, btn.dataset.nodeId));
    });

    // ── Schema node actions ────────────────────────────────────────────────────

    // Description inline edit
    const descEditBtn    = contentEl.querySelector('.node-desc-edit-btn');
    const descView       = contentEl.querySelector('.node-desc-view');
    const descEditForm   = contentEl.querySelector('.node-desc-edit-form');
    const descTextarea   = contentEl.querySelector('.node-desc-textarea');
    const descSaveBtn    = contentEl.querySelector('.node-desc-save');
    const descCancelBtn  = contentEl.querySelector('.node-desc-cancel');

    if (descEditBtn) {
      descEditBtn.addEventListener('click', () => {
        descView.style.display = 'none';
        descEditForm.style.display = 'block';
        descTextarea.focus();
      });
    }
    if (descCancelBtn) {
      descCancelBtn.addEventListener('click', () => {
        descEditForm.style.display = 'none';
        descView.style.display = '';
      });
    }
    if (descSaveBtn) {
      descSaveBtn.addEventListener('click', async () => {
        const nodeIdToUpdate = descSaveBtn.dataset.nodeId;
        const newDesc = descTextarea.value.trim();
        try {
          await api(`/schema/${encodeURIComponent(nodeIdToUpdate)}`, {
            method: 'PATCH',
            body: JSON.stringify({ node_description: newDesc })
          });
          descView.innerHTML = newDesc ? escapeHtml(newDesc) : '<em class="muted">None</em>';
          descEditForm.style.display = 'none';
          descView.style.display = '';
          showToast('Description saved', 'success');
        } catch (err) {
          showToast(err.message || 'Error saving description', 'error');
        }
      });
    }

    // Mark / unmark schema
    const flagBtn   = contentEl.querySelector('.node-schema-flag');
    const unflagBtn = contentEl.querySelector('.node-schema-unflag');

    if (flagBtn) {
      flagBtn.addEventListener('click', async () => {
        try {
          await api(`/schema/${encodeURIComponent(flagBtn.dataset.nodeId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ is_schema_node: true })
          });
          showToast('Marked as schema node', 'success');
          loadNodeDetail(nodeId);
          loadSchemaNodes();
        } catch (err) {
          showToast(err.message || 'Error updating node', 'error');
        }
      });
    }
    if (unflagBtn) {
      unflagBtn.addEventListener('click', async () => {
        if (!confirm('Remove schema flag from this node?')) return;
        try {
          await api(`/schema/${encodeURIComponent(unflagBtn.dataset.nodeId)}`, { method: 'DELETE' });
          showToast('Schema flag removed', 'success');
          loadNodeDetail(nodeId);
          loadSchemaNodes();
        } catch (err) {
          showToast(err.message || 'Error updating node', 'error');
        }
      });
    }

    // Add child schema node
    const addChildBtn    = contentEl.querySelector('.node-add-schema-child');
    const addChildForm   = contentEl.querySelector('.node-add-child-form');
    const addChildCancel = contentEl.querySelector('.node-add-child-cancel');
    const addChildSave   = contentEl.querySelector('.node-add-child-save');

    if (addChildBtn && addChildForm) {
      addChildBtn.addEventListener('click', () => {
        addChildForm.style.display = 'block';
        addChildForm.querySelector('.node-add-child-name').focus();
      });
    }
    if (addChildCancel) {
      addChildCancel.addEventListener('click', () => {
        addChildForm.style.display = 'none';
      });
    }
    if (addChildSave) {
      addChildSave.addEventListener('click', async () => {
        const parentNodeId = addChildSave.dataset.nodeId;
        const childName = addChildForm.querySelector('.node-add-child-name').value.trim();
        const childDesc = addChildForm.querySelector('.node-add-child-desc').value.trim();
        if (!childName) { showToast('Name is required', 'error'); return; }
        try {
          await api('/schema/nodes', {
            method: 'POST',
            body: JSON.stringify({ name: childName, description: childDesc, parent_id: parentNodeId })
          });
          showToast(`Child node "${childName}" created`, 'success');
          loadNodeDetail(nodeId);
          loadSchemaNodes();
          loadTree();
        } catch (err) {
          showToast(err.message || 'Error creating child node', 'error');
        }
      });
    }

    // Wire up child node items to navigate on click
    contentEl.querySelectorAll('.node-child-item').forEach(item => {
      item.addEventListener('click', () => {
        const childId = item.dataset.nodeId;
        // Highlight the corresponding tree node if visible
        document.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('selected'));
        const treeItem = document.querySelector(`.tree-node-item[data-node-id="${childId}"]`);
        if (treeItem) treeItem.classList.add('selected');
        loadNodeDetail(childId).catch(console.error);
      });
    });
  } catch (error) {
    contentEl.innerHTML = `<p class="error">${error.message}</p>`;
  }
}

function hideNodeDetail() {
  document.getElementById('node-detail').classList.add('hidden');
}

function showAddNodeModal() {
  document.getElementById('add-node-modal').classList.remove('hidden');
  populateNodeSelects();
}

function hideAddNodeModal() {
  document.getElementById('add-node-modal').classList.add('hidden');
  document.getElementById('add-node-form').reset();
}

let addChunkTargetNodeId = null;

function showAddChunkModal(nodeId) {
  addChunkTargetNodeId = nodeId;
  document.getElementById('add-chunk-modal').classList.remove('hidden');
}

function hideAddChunkModal() {
  addChunkTargetNodeId = null;
  document.getElementById('add-chunk-modal').classList.add('hidden');
  document.getElementById('add-chunk-form').reset();
}

async function handleAddChunk(e) {
  e.preventDefault();
  const content = document.getElementById('chunk-content').value.trim();
  const kp_type = document.getElementById('chunk-kp-type').value;
  const doc_title = document.getElementById('chunk-doc-title').value.trim() || 'Manual Entry';
  if (!content) return;
  try {
    await api(`/nodes/${addChunkTargetNodeId}/chunks`, {
      method: 'POST',
      body: JSON.stringify({ content, kp_type, doc_title })
    });
    showToast('Content added', 'success');
    hideAddChunkModal();
    loadNodeDetail(addChunkTargetNodeId);
  } catch (err) {
    showToast(err.message || 'Error adding content', 'error');
  }
}

async function handleDeleteChunk(chunkId, nodeId) {
  if (!confirm('Delete this content item?')) return;
  try {
    await api(`/chunks/${chunkId}`, { method: 'DELETE' });
    loadNodeDetail(nodeId);
  } catch (err) {
    showToast(err.message || 'Error deleting content', 'error');
  }
}

function populateNodeSelects() {
  const selects = [
    document.getElementById('new-node-parent'),
    document.getElementById('target-node')
  ];

  const schemaOnlyChecked = document.getElementById('schema-nodes-only')?.checked ?? false;

  selects.forEach(select => {
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">-- ' + (select.id === 'target-node' ? 'Auto-detect' : 'No Parent (Root)') + ' --</option>';

    const nodesToShow = (schemaOnlyChecked && select.id === 'target-node')
      ? allNodes.filter(n => n.is_schema_node === 1 || n.is_schema_node === true)
      : allNodes;

    nodesToShow.forEach(node => {
      const option = document.createElement('option');
      option.value = node.node_id;
      const level = Number.isFinite(node.level) && node.level > 0 ? node.level : 1;
      const schemaPrefix = (node.is_schema_node === 1 || node.is_schema_node === true) ? '📌 ' : '';
      option.textContent = `${'  '.repeat(level - 1)}${schemaPrefix}${node.name}`;
      select.appendChild(option);
    });

    select.value = currentValue;
  });
}

async function populateSchemaBranchSelect() {
  const select = document.getElementById('schema-branch');
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = '<option value="">-- All schema nodes --</option>';
  try {
    const data = await api('/schema');
    (data.nodes || []).forEach(node => {
      const option = document.createElement('option');
      option.value = node.node_id;
      const level = Number.isFinite(node.level) && node.level > 0 ? node.level : 1;
      option.textContent = `${'  '.repeat(level - 1)}${node.name}`;
      select.appendChild(option);
    });
    select.value = currentValue;
  } catch (_) {}
}

async function handleAddNode(e) {
  e.preventDefault();

  const nodeId = document.getElementById('new-node-id').value.trim();
  const name = document.getElementById('new-node-name').value.trim();
  const parentId = document.getElementById('new-node-parent').value || null;
  const summary = document.getElementById('new-node-summary').value.trim();

  try {
    await api('/nodes', {
      method: 'POST',
      body: JSON.stringify({ node_id: nodeId, name, parent_id: parentId, summary })
    });

    showToast(t('success'), 'success');
    hideAddNodeModal();
    loadTree();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Upload Tab
function initUpload() {
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

  // Schema nodes only filter — re-populate select when toggled
  const schemaOnlyChk = document.getElementById('schema-nodes-only');
  if (schemaOnlyChk) {
    schemaOnlyChk.addEventListener('change', populateNodeSelects);
  }
}

let selectedFiles = [];

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

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

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

      const response = await fetch('/upload', { method: 'POST', body: formData, headers: { 'X-Dataset-ID': currentDatasetId } });
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

      const response = await fetch('/upload/batch', { method: 'POST', body: formData, headers: { 'X-Dataset-ID': currentDatasetId } });
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
    loadDocuments().catch(console.error);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    uploadBtn.disabled = false;
    spinner.classList.add('hidden');
  }
}

// Tracks active polling timers keyed by job id → { timer, intervalMs }
const _uploadJobPollers = new Map();

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
  else if (jobStatus === 'queued') { statusText = 'queued'; statusClass = 'pending'; }
  else if (jobStatus === 'failed') { statusText = 'failed'; statusClass = 'failed'; }
  else if (jobStatus === 'cancelled') { statusText = 'cancelled'; statusClass = 'failed'; }
  else if (jobStatus === 'rate_limited') { statusText = 'rate limited'; statusClass = 'rate_limited'; }
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
      const job = await api(`/ingest/jobs/${jobId}`);

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
      const wsHealthy = _ws && _ws.readyState === WebSocket.OPEN;
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
}

// Documents Tab
function initDocuments() {
  document.getElementById('refresh-docs-btn').addEventListener('click',  loadUnifiedView);
  document.getElementById('doc-status-filter').addEventListener('change', loadUnifiedView);
  document.getElementById('retry-all-docs-btn')?.addEventListener('click',  retryAllJobs);
  document.getElementById('cancel-all-docs-btn')?.addEventListener('click', cancelAllJobs);
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
  if (!confirm('Cancel this job and permanently delete all extracted content from the dataset?')) return;
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
  if (!confirm('Cancel all queued, processing, and rate-limited jobs?')) return;
  try {
    const r = await api('/ingest/jobs/cancel-all', { method: 'POST' });
    showToast(`${r.cancelled} job${r.cancelled !== 1 ? 's' : ''} cancelled.`, 'info');
    loadUnifiedView();
  } catch (err) { showToast(err.message, 'error'); }
}

let _unifiedPollTimer = null;
// Map of jobId → name for active jobs seen in last poll (to detect completions)
let _prevActiveJobs = new Map();

async function loadUnifiedView() {
  const tbody = document.getElementById('documents-tbody');
  if (!tbody) return;

  if (_unifiedPollTimer) { clearTimeout(_unifiedPollTimer); _unifiedPollTimer = null; }

  const statusFilter = document.getElementById('doc-status-filter')?.value || '';

  try {
    const data = await api('/documents/unified');
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
    const hasQueued  = rows.some(r => r.status === 'queued' || r.status === 'processing' || r.status === 'rate_limited');
    const hasPaused  = rows.some(r => r.status === 'rate_limited' || r.status === 'failed');
    const retryBtn   = document.getElementById('retry-all-docs-btn');
    const cancelBtn  = document.getElementById('cancel-all-docs-btn');
    if (retryBtn)  retryBtn.style.display  = hasPaused ? '' : 'none';
    if (cancelBtn) cancelBtn.style.display = hasQueued  ? '' : 'none';

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8">${renderEmptyState(
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        'No documents yet',
        'Upload your first document to populate the knowledge base.'
      )}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(row => _renderUnifiedRow(row)).join('');

    // Register WebSocket watch for active processing jobs
    rows.filter(r => r.row_type === 'job' && r.status === 'processing' && r.job_id)
        .forEach(r => _wsSend({ type: 'watch', jobId: String(r.job_id) }));

    // Auto-refresh while jobs are queued or processing
    const hasActive = rows.some(r => r.status === 'queued' || r.status === 'processing');
    const docsTabActive = document.getElementById('tab-documents')?.classList.contains('active');
    if (hasActive && docsTabActive) {
      // 20s fallback poll — only a safety net; queue_update WS events handle most refreshes
    _unifiedPollTimer = setTimeout(() => loadUnifiedView().catch(console.error), 20000);
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
    progressCell = `
      <div class="doc-progress-wrap" id="job-progress-${row.job_id}">
        <div class="doc-progress-bar"><div class="doc-progress-fill" style="width:${pct}%"></div></div>
        <span class="doc-progress-msg">${msg}<span class="doc-progress-elapsed">${elapsedStr}</span></span>
      </div>`;
  } else if (row.status === 'queued') {
    const posLabel = row.queue_position != null ? `Position ${row.queue_position} in queue` : 'Waiting in queue…';
    progressCell = `<span class="muted">${posLabel}</span>`;
  } else if (row.status === 'rate_limited') {
    const err = row.error_message
      ? escapeHtml(row.error_message.replace(/^Rate limit hit \(429\) — resume when quota resets: /, ''))
      : 'API quota exceeded';
    progressCell = `<span class="text-warning" title="${err}">Rate limited</span>`;
  } else if (row.status === 'failed' && row.error_message) {
    progressCell = `<span class="text-danger" title="${escapeHtml(row.error_message)}">${escapeHtml(row.error_message.slice(0, 60))}${row.error_message.length > 60 ? '…' : ''}</span>`;
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

// Keep loadDocuments as an alias so any existing callers still work
const loadDocuments = loadUnifiedView;

document.getElementById('retry-all-docs-btn')?.addEventListener('click',  retryAllJobs);
document.getElementById('cancel-all-docs-btn')?.addEventListener('click', cancelAllJobs);

window.deleteDocument = async function(id) {
  if (!confirm(t('confirm_delete'))) return;
  try {
    await api(`/documents/${id}`, { method: 'DELETE' });
    showToast(t('success'), 'success');
    loadUnifiedView();
  } catch (error) {
    showToast(error.message, 'error');
  }
};

// Stats Tab
function initStats() {
  document.getElementById('refresh-stats-btn').addEventListener('click', loadStats);
  document.getElementById('sync-embeddings-btn').addEventListener('click', syncEmbeddings);
  document.getElementById('sync-aliases-btn').addEventListener('click', syncAliases);
  document.getElementById('extract-entities-btn').addEventListener('click', extractEntities);
}

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
        </div>
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
  } catch (error) {
    container.innerHTML = `<p class="loading-text error">${error.message}</p>`;
  }
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

async function extractEntities() {
  const btn = document.getElementById('extract-entities-btn');
  const spinner = btn.querySelector('.loading-spinner');

  btn.disabled = true;
  spinner.classList.remove('hidden');

  try {
    const result = await api('/extraction/bulk', {
      method: 'POST',
      body: JSON.stringify({ useLLM: true, batchSize: 5 })
    });

    const entities = result.total_entities || 0;
    const facts = result.total_facts || 0;
    const docs = result.documents_processed || 0;

    showToast(`Extracted ${entities} entities and ${facts} facts from ${docs} documents`, 'success');
    loadStats();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
}

// ============================================
// Query History
// ============================================

function initQueryHistory() {
  // Render initial history
  renderQueryHistory();

  // Clear history button
  document.getElementById('clear-history-btn')?.addEventListener('click', () => {
    clearHistory();
    showToast('History cleared', 'success');
  });

  // Click on history item to re-run query
  document.getElementById('history-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (item) {
      const query = decodeURIComponent(item.dataset.query);
      document.getElementById('query-input').value = query;
      handleAsk();
    }
  });
}

// ============================================
// D3.js Graph Visualization
// ============================================

function initGraphView() {
  // View toggle buttons
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      currentGraphView = view;

      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const treeView = document.getElementById('tree-view');
      const graphView = document.getElementById('graph-view');

      if (view === 'graph') {
        treeView.classList.add('hidden');
        graphView.classList.remove('hidden');
        renderGraph();
      } else {
        graphView.classList.add('hidden');
        treeView.classList.remove('hidden');
      }
    });
  });

  // Graph controls
  document.getElementById('graph-zoom-in')?.addEventListener('click', () => {
    zoomGraph(1.2);
  });

  document.getElementById('graph-zoom-out')?.addEventListener('click', () => {
    zoomGraph(0.8);
  });

  document.getElementById('graph-reset')?.addEventListener('click', () => {
    resetGraph();
  });
}

let graphZoom = null;
let graphSvg = null;
let graphG = null;

function renderGraph() {
  if (allNodes.length === 0) {
    // Need to load nodes first
    loadTree().then(() => {
      if (currentGraphView === 'graph') {
        createGraph();
      }
    });
  } else {
    createGraph();
  }
}

function createGraph() {
  const container = document.getElementById('graph-view');
  const svg = d3.select('#graph-svg');

  // Clear previous
  svg.selectAll('*').remove();

  const width = container.clientWidth || 800;
  const height = 600;

  svg.attr('width', width).attr('height', height);

  // Build nodes and links from tree structure
  const nodes = allNodes.map(n => ({
    id: n.node_id,
    name: n.name,
    level: n.level || 0,
    parent_id: n.parent_id,
    chunks: n.chunk_count || 0,
    summary: n.node_summary || ''
  }));

  const links = [];
  nodes.forEach(node => {
    if (node.parent_id) {
      links.push({
        source: node.parent_id,
        target: node.id
      });
    }
  });

  // Create zoom behavior
  graphZoom = d3.zoom()
    .scaleExtent([0.2, 4])
    .on('zoom', (event) => {
      graphG.attr('transform', event.transform);
    });

  svg.call(graphZoom);

  // Create main group
  graphG = svg.append('g');
  graphSvg = svg;

  // Create force simulation
  graphSimulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(80).strength(0.5))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(40));

  // Draw links
  const link = graphG.append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(links)
    .enter()
    .append('line')
    .attr('class', 'graph-link');

  // Draw nodes
  const node = graphG.append('g')
    .attr('class', 'nodes')
    .selectAll('g')
    .data(nodes)
    .enter()
    .append('g')
    .attr('class', d => `graph-node level-${Math.min(d.level, 3)}`)
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended));

  // Node circles
  node.append('circle')
    .attr('r', d => 20 + Math.min(d.chunks, 10) * 2);

  // Node labels
  node.append('text')
    .attr('dy', 4)
    .text(d => d.name.length > 12 ? d.name.slice(0, 12) + '...' : d.name);

  // Tooltip
  const tooltip = d3.select('body').append('div')
    .attr('class', 'graph-tooltip')
    .style('opacity', 0)
    .style('position', 'absolute');

  node.on('mouseover', (event, d) => {
    tooltip.transition().duration(200).style('opacity', 1);
    tooltip.html(`
      <div class="tooltip-title">${d.name}</div>
      <div class="tooltip-info">ID: ${d.id}</div>
      <div class="tooltip-info">Level: ${d.level}</div>
      <div class="tooltip-info">Chunks: ${d.chunks}</div>
      ${d.summary ? `<div class="tooltip-info">${d.summary.slice(0, 100)}...</div>` : ''}
    `)
    .style('left', (event.pageX + 10) + 'px')
    .style('top', (event.pageY - 10) + 'px');

    // Highlight connected links
    link.classed('highlighted', l => l.source.id === d.id || l.target.id === d.id);
  })
  .on('mouseout', () => {
    tooltip.transition().duration(500).style('opacity', 0);
    link.classed('highlighted', false);
  })
  .on('click', (event, d) => {
    // Show node detail
    loadNodeDetail(d.id);
    node.classed('selected', n => n.id === d.id);
  });

  // Update positions on tick
  graphSimulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // Add legend
  addGraphLegend(container);

  // Center the graph initially
  setTimeout(() => {
    const bounds = graphG.node().getBBox();
    const fullWidth = width;
    const fullHeight = height;
    const bWidth = bounds.width;
    const bHeight = bounds.height;
    const scale = 0.8 / Math.max(bWidth / fullWidth, bHeight / fullHeight);
    const tx = (fullWidth - scale * (bounds.x * 2 + bWidth)) / 2;
    const ty = (fullHeight - scale * (bounds.y * 2 + bHeight)) / 2;

    svg.transition().duration(500).call(
      graphZoom.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
  }, 1000);
}

function addGraphLegend(container) {
  // Remove existing legend
  container.querySelector('.graph-legend')?.remove();

  // Only show legend if there are nodes
  if (allNodes.length === 0) return;

  const legend = document.createElement('div');
  legend.className = 'graph-legend';
  legend.innerHTML = `
    <div class="legend-title">Node Levels</div>
    <div class="legend-item"><span class="legend-dot level-0"></span> Root</div>
    <div class="legend-item"><span class="legend-dot level-1"></span> Level 1</div>
    <div class="legend-item"><span class="legend-dot level-2"></span> Level 2</div>
    <div class="legend-item"><span class="legend-dot level-3"></span> Level 3+</div>
  `;
  container.appendChild(legend);
}

function dragstarted(event, d) {
  if (!event.active) graphSimulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragended(event, d) {
  if (!event.active) graphSimulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

function zoomGraph(factor) {
  if (!graphSvg || !graphZoom) return;
  graphSvg.transition().duration(300).call(
    graphZoom.scaleBy, factor
  );
}

function resetGraph() {
  if (!graphSvg || !graphZoom) return;
  graphSvg.transition().duration(500).call(
    graphZoom.transform,
    d3.zoomIdentity
  );
  // Re-render to reset positions
  createGraph();
}

// ============================================
// Mobile Sidebar
// ============================================

function initMobileSidebar() {
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');

  toggle?.addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open');
    backdrop.classList.toggle('visible');
  });

  backdrop?.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar?.classList.remove('open');
  backdrop?.classList.remove('visible');
}

// ============================================
// Tree Search / Filter
// ============================================

function initTreeSearch() {
  const input = document.getElementById('tree-search-input');
  if (!input) return;

  let debounceTimer = null;
  input.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      filterTree(input.value.trim().toLowerCase());
    }, 150);
  });
}

function filterTree(query) {
  const countEl = document.getElementById('tree-search-count');
  const treeItems = document.querySelectorAll('.tree-node-item');

  if (!query) {
    // Reset - show all
    treeItems.forEach(item => {
      item.classList.remove('search-hidden');
      item.closest('.tree-branch')?.classList.remove('search-hidden');
      // Restore original name (remove highlights)
      const nameEl = item.querySelector('.tree-name');
      if (nameEl && nameEl.dataset.originalName) {
        nameEl.textContent = nameEl.dataset.originalName;
      }
    });
    if (countEl) countEl.textContent = '';
    return;
  }

  let matchCount = 0;

  // First pass: find matches and mark them
  treeItems.forEach(item => {
    const nameEl = item.querySelector('.tree-name');
    if (!nameEl) return;

    // Store original name
    if (!nameEl.dataset.originalName) {
      nameEl.dataset.originalName = nameEl.textContent;
    }

    const name = nameEl.dataset.originalName.toLowerCase();
    const matches = name.includes(query);

    if (matches) {
      matchCount++;
      // Highlight match
      const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      nameEl.innerHTML = nameEl.dataset.originalName.replace(regex, '<mark>$1</mark>');

      // Show this item and all ancestors
      item.classList.remove('search-hidden');
      item.closest('.tree-branch')?.classList.remove('search-hidden');

      // Expand ancestor tree-children
      let parent = item.closest('.tree-branch')?.parentElement;
      while (parent) {
        if (parent.classList.contains('tree-children')) {
          parent.classList.add('expanded');
          parent.classList.remove('search-hidden');
        }
        if (parent.classList.contains('tree-branch')) {
          parent.classList.remove('search-hidden');
        }
        parent = parent.parentElement;
      }
    } else {
      nameEl.textContent = nameEl.dataset.originalName;
    }
  });

  // Second pass: hide non-matching items that don't have matching children
  treeItems.forEach(item => {
    const nameEl = item.querySelector('.tree-name');
    if (!nameEl) return;

    const name = (nameEl.dataset.originalName || nameEl.textContent).toLowerCase();
    if (!name.includes(query)) {
      // Check if any descendant matches
      const branch = item.closest('.tree-branch');
      const childMatches = branch?.querySelectorAll('.tree-name mark');
      if (!childMatches || childMatches.length === 0) {
        item.classList.add('search-hidden');
        branch?.classList.add('search-hidden');
      }
    }
  });

  if (countEl) {
    countEl.textContent = matchCount > 0 ? `${matchCount} node${matchCount !== 1 ? 's' : ''} found` : 'No matches';
  }
}

// ============================================
// Better Empty States
// ============================================

function renderEmptyState(icon, title, description, actionHtml = '') {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-title">${title}</div>
      <div class="empty-state-desc">${description}</div>
      ${actionHtml ? `<div class="empty-state-action">${actionHtml}</div>` : ''}
    </div>
  `;
}

// ============================================
// Datasets Tab
// ============================================

async function initDatasets() {
  // Restore saved dataset from localStorage
  const saved = localStorage.getItem(DATASET_KEY);

  try {
    const data = await fetch('/datasets').then(r => r.json());
    allDatasets = data.datasets || [];

    // Populate sidebar dropdown
    renderDatasetDropdown();

    // Restore saved selection
    if (saved && allDatasets.find(d => d.id === saved)) {
      switchDataset(saved, allDatasets.find(d => d.id === saved).name, false);
    } else if (allDatasets.length > 0) {
      switchDataset(allDatasets[0].id, allDatasets[0].name, false);
    }
  } catch (err) {
    console.error('Failed to load datasets:', err);
  }

  // Wire up sidebar select
  document.getElementById('dataset-select')?.addEventListener('change', (e) => {
    const id = e.target.value;
    const dataset = allDatasets.find(d => d.id === id);
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
      if (e.target.checked) selectedDatasetIds.add(id);
      else selectedDatasetIds.delete(id);
      cb.closest('.dataset-card').classList.toggle('dataset-card--selected', cb.checked);
    });
    updateBatchToolbar();
  });
}

function renderDatasetDropdown() {
  const select = document.getElementById('dataset-select');
  if (!select) return;

  select.innerHTML = allDatasets.map(d =>
    `<option value="${escapeHtml(d.id)}" ${d.id === currentDatasetId ? 'selected' : ''}>${escapeHtml(d.name)}</option>`
  ).join('');
}

function switchDataset(id, name, reload = true) {
  currentDatasetId = id;
  currentDatasetName = name;
  localStorage.setItem(DATASET_KEY, id);

  // Update sidebar dropdown
  const select = document.getElementById('dataset-select');
  if (select) select.value = id;

  if (reload) {
    // Reload active tab data with new dataset context
    const activeTab = document.querySelector('.nav-btn.active')?.dataset.tab;
    if (activeTab === 'tree') loadTree();
    else if (activeTab === 'ask') {
      // Clear the chat area when switching datasets
      const welcome = document.getElementById('chat-welcome');
      const result = document.getElementById('ask-result');
      if (welcome) welcome.style.display = '';
      if (result) result.classList.add('hidden');
    }
    else if (activeTab === 'documents') loadDocuments();
    else if (activeTab === 'decisions') loadDecisions();
    else if (activeTab === 'tests') loadTests();
    else if (activeTab === 'stats') loadStats();
    else if (activeTab === 'datasets') loadDatasets();
  }
}

function updateBatchToolbar() {
  const toolbar = document.getElementById('dataset-batch-toolbar');
  if (!toolbar) return;
  const count = selectedDatasetIds.size;
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
  const ids = [...selectedDatasetIds];
  if (ids.length === 0) return;

  const confirmation = prompt(
    `You are about to permanently delete ${ids.length} dataset${ids.length !== 1 ? 's' : ''}.\n\nType DELETE to confirm.`
  );
  if (confirmation !== 'DELETE') return;

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

  selectedDatasetIds.clear();
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
    allDatasets = data.datasets || [];
    renderDatasetDropdown();

    if (allDatasets.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-title">${t('no_datasets')}</div></div>`;
      return;
    }

    // Fetch stats AND language config for each dataset in parallel
    const [statsResults, langResults] = await Promise.all([
      Promise.allSettled(allDatasets.map(d => fetch(`/datasets/${d.id}/stats`).then(r => r.json()))),
      Promise.allSettled(allDatasets.map(d => fetch(`/datasets/${d.id}/config/language`).then(r => r.json())))
    ]);

    list.innerHTML = allDatasets.map((d, i) => {
      const stats = statsResults[i].status === 'fulfilled' ? statsResults[i].value : {};
      const langInfo = langResults[i].status === 'fulfilled' ? langResults[i].value : { language: 'auto', locked: false };
      return renderDatasetCard(d, stats, langInfo);
    }).join('');

    // Reset selection on reload
    selectedDatasetIds.clear();
    updateBatchToolbar();

    // Wire dataset checkboxes
    list.querySelectorAll('.dataset-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.datasetId;
        if (cb.checked) selectedDatasetIds.add(id);
        else selectedDatasetIds.delete(id);
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
  const isActive = dataset.id === currentDatasetId;
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
    const dataset = allDatasets.find(d => d.id === datasetId);
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
      if (datasetId === currentDatasetId) currentDatasetName = newName;
      showToast(t('dataset_renamed'), 'success');
      loadDatasets();
    } catch (err) { showToast(err.message, 'error'); }
  } else if (action === 'duplicate') {
    const dataset = allDatasets.find(d => d.id === datasetId);
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
    const confirmation = prompt(t('confirm_delete_dataset'));
    if (confirmation !== 'DELETE') return;
    try {
      await api(`/datasets/${datasetId}?confirm=yes`, { method: 'DELETE' });
      showToast(t('dataset_deleted'), 'success');
      // If we deleted the active dataset, switch to first remaining
      if (datasetId === currentDatasetId) {
        const remaining = allDatasets.filter(d => d.id !== datasetId);
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

// ── Decisions Tab ─────────────────────────────────────────────────────────────

function initDecisions() {
  document.getElementById('refresh-decisions-btn')?.addEventListener('click', loadDecisions);
  document.getElementById('decisions-status-filter')?.addEventListener('change', loadDecisions);
  document.getElementById('run-cleanup-btn')?.addEventListener('click', runCleanupJob);
}

async function loadDecisions() {
  const list = document.getElementById('decisions-list');
  const statsDiv = document.getElementById('decisions-stats');
  if (!list) return;

  const statusFilter = document.getElementById('decisions-status-filter')?.value || 'pending';

  try {
    list.innerHTML = '<p class="empty-state">Loading…</p>';

    const [{ decisions }, stats] = await Promise.all([
      api(`/decisions?status=${encodeURIComponent(statusFilter)}&limit=100`),
      api('/decisions/stats')
    ]);

    // Render stats row
    if (statsDiv) {
      statsDiv.innerHTML = `
        <span class="decision-stat-pill decision-stat-pending">${stats.pending} pending</span>
        <span class="decision-stat-pill decision-stat-accepted">${stats.accepted} accepted</span>
        <span class="decision-stat-pill decision-stat-rejected">${stats.rejected} rejected</span>
        <span class="decision-stat-pill decision-stat-auto">${stats.auto_resolved} auto-resolved</span>
      `;
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
  } catch (err) {
    list.innerHTML = `<p class="empty-state error">${escapeHtml(err.message)}</p>`;
  }
}

function renderDecisionCard(d) {
  const actionClass = {
    merge_suggestion:      'decision-merge',
    replace_suggestion:    'decision-replace',
    node_merge_suggestion: 'decision-node-merge'
  }[d.action] || '';

  const actionLabel = {
    merge_suggestion:      'Merge',
    replace_suggestion:    'Replace',
    node_merge_suggestion: 'Node Merge'
  }[d.action] || d.action;

  const simStr = d.similarity_score != null ? `Similarity: ${(d.similarity_score * 100).toFixed(0)}%` : '';
  const confStr = d.confidence != null ? `Confidence: ${(d.confidence * 100).toFixed(0)}%` : '';
  const isPending = d.status === 'pending';

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
          <div class="kp-preview">${escapeHtml(d.incoming_preview)}</div>
        </div>` : ''}
      ${d.target_preview ? `
        <div class="kp-preview-block">
          <span class="kp-preview-label">Existing</span>
          <div class="kp-preview">${escapeHtml(d.target_preview)}</div>
        </div>` : ''}
      ${isPending ? `
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

async function runCleanupJob() {
  const btn = document.getElementById('run-cleanup-btn');
  if (btn) btn.disabled = true;
  try {
    const result = await api('/decisions/cleanup', { method: 'POST', body: JSON.stringify({}) });
    showToast(result.message || 'Cleanup job started', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
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
        headers: { 'X-Dataset-ID': currentDatasetId }
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
        headers: { 'X-Dataset-ID': currentDatasetId }
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

let testResults  = {};  // id → { status: 'pending'|'running'|'passed'|'failed', detail: string }
let allTests     = [];  // merged builtin + custom (each has a .run function)
let isRunning    = false;
// Shared state for accuracy tests — populated by accuracy_ingest, read by downstream tests
let accuracyState = { jobId: null, docId: null, chunkCount: 0, ingested: false };
// Shared state for multi-document tests — populated by multidoc_ingest, read by downstream tests
let multidocState = { jobId: null, docId: null, chunkCount: 0, ingested: false };

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
      category: 'Custom',
      builtin: false,
      async run(call) {
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

  container.innerHTML = Object.entries(groups).map(([cat, tests]) => `
    <div class="test-group">
      <div class="test-group-header">${escapeHtml(cat)} <span class="test-group-count">(${tests.length})</span></div>
      ${tests.map(t => renderTestCard(t)).join('')}
    </div>
  `).join('');

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

// ── Run tests ─────────────────────────────────────────────────────────────────

async function runTests(mode, singleId = null) {
  if (isRunning) return;

  let ids;
  if (mode === 'single') {
    ids = [singleId];
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
  const savedDatasetId   = currentDatasetId;
  const savedDatasetName = currentDatasetName;
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
    currentDatasetId   = testDatasetId;
    currentDatasetName = ds.dataset.name;
    showToast('Isolated test dataset created', 'success');
  } catch (err) {
    // Dataset creation failed — run tests on the current dataset as fallback
    showToast(`Warning: could not create isolated test dataset (${err.message})`, 'error');
  }
  // ───────────────────────────────────────────────────────────────────────────

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

  isRunning = false;
  document.getElementById('run-all-tests-btn').disabled = false;
  document.getElementById('run-selected-tests-btn').disabled = false;

  const passed = ids.filter(id => testResults[id]?.status === 'passed').length;
  const failed = ids.filter(id => testResults[id]?.status === 'failed').length;
  showToast(`Tests complete: ${passed} passed, ${failed} failed`, failed > 0 ? 'error' : 'success');

  renderTestReport(ids);

  // ── Post-run cleanup ────────────────────────────────────────────────────────
  // Restore original dataset first so the UI lands on the right context
  currentDatasetId   = savedDatasetId;
  currentDatasetName = savedDatasetName;

  // Delete the isolated test dataset (and everything it contains)
  if (testDatasetId) {
    try {
      await api(`/datasets/${testDatasetId}?confirm=yes`, { method: 'DELETE' });
      showToast('Test dataset deleted — knowledge base is clean', 'success');
    } catch (err) {
      showToast(`Warning: test dataset ${testDatasetId} could not be deleted — please remove it manually`, 'error');
    }
  }

  // Reset shared accuracy test state
  accuracyState = { jobId: null, docId: null, chunkCount: 0, ingested: false };
  // ───────────────────────────────────────────────────────────────────────────
}

/** Delete any [Test Run] datasets left behind by a previously crashed test suite. */
async function cleanupOrphanedTestDatasets() {
  try {
    const { datasets = [] } = await api('/datasets');
    for (const ds of datasets) {
      if (ds.name?.startsWith('[Test Run]') && ds.id !== currentDatasetId) {
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
    navigator.clipboard.writeText(buildReportMarkdown(ids, now))
      .then(() => showToast('Report copied to clipboard', 'success'))
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
    default:
      return { passed: false, detail: `Unknown assertion type: ${type}` };
  }
}

// ── Custom test CRUD ──────────────────────────────────────────────────────────

function updateAssertionValueVisibility() {
  const type = document.getElementById('tc-assertion-type')?.value;
  const group = document.getElementById('tc-value-group');
  const label = document.getElementById('tc-value-label');
  if (!group) return;
  const needsValue = ['answer_contains', 'confidence_gte', 'query_type_is'].includes(type);
  group.style.display = needsValue ? '' : 'none';
  if (label) {
    const labels = { answer_contains: 'Expected substring', confidence_gte: 'Minimum confidence (0–1)', query_type_is: 'Expected type (simple_lookup / comparison / recommendation / reasoning / aggregation)' };
    label.textContent = labels[type] || 'Value';
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
  if (!confirm('Delete this test case?')) return;
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

const PROVIDER_DEFAULTS = {
  openai: { model: 'gpt-4o-mini',       embeddingModel: 'text-embedding-3-large' },
  gemini: { model: 'gemini-2.0-flash',  embeddingModel: 'gemini-embedding-001'   },
};

let _settingsOriginalProvider = null;

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

// ── Schema Panel ──────────────────────────────────────────────────────────────

let _schemaPanelInitialized = false;

function initSchemaPanel() {
  if (_schemaPanelInitialized) {
    // Already wired — just refresh data
    loadSchemaSettings();
    loadSchemaTemplates();
    loadSchemaNodes();
    return;
  }
  _schemaPanelInitialized = true;

  // Toggle panel body
  document.getElementById('schema-panel-toggle')?.addEventListener('click', (e) => {
    if (e.target.closest('button')) return; // button clicks handled separately
    const body    = document.getElementById('schema-panel-body');
    const chevron = document.getElementById('schema-panel-chevron');
    body.classList.toggle('hidden');
    chevron.innerHTML = body.classList.contains('hidden') ? '&#9654;' : '&#9660;';
    if (!body.classList.contains('hidden')) {
      loadSchemaTemplates();
      loadSchemaNodes();
    }
  });

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

  // Schema Settings modal
  document.getElementById('schema-settings-btn')?.addEventListener('click', openSchemaSettings);
  document.getElementById('schema-mode-badge')?.addEventListener('click', openSchemaSettings);
  document.getElementById('close-schema-settings-modal')?.addEventListener('click', () => {
    document.getElementById('schema-settings-modal').classList.add('hidden');
  });
  document.getElementById('cancel-schema-settings')?.addEventListener('click', () => {
    document.getElementById('schema-settings-modal').classList.add('hidden');
  });
  document.getElementById('save-schema-settings')?.addEventListener('click', saveSchemaSettings);

  // Toggle buttons in settings modal
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

  loadSchemaSettings();
  loadSchemaTemplates();
  loadSchemaNodes();
}

async function loadSchemaSettings() {
  try {
    const s = await api('/schema/settings');
    currentMappingMode = s.mapping_mode || 'free';

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
    if (s.mapping_mode === 'guided') populateSchemaBranchSelect();

    return s;
  } catch (_) {
    return { mapping_mode: 'free', mapping_strictness: 'soft' };
  }
}

async function loadSchemaNodes() {
  const container = document.getElementById('schema-nodes-tree');
  if (!container) return;
  try {
    const data = await api('/schema');
    if (!data.nodes?.length) {
      container.innerHTML = '<p class="empty-state">No schema nodes defined. Import a JSON schema or add nodes via the tree.</p>';
      return;
    }
    container.innerHTML = renderSchemaNodeTree(data.tree || []);
  } catch (err) {
    container.innerHTML = `<p class="empty-state">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function renderSchemaNodeTree(nodes, depth = 0) {
  return nodes.map(node => {
    const indent = depth * 16;
    const kws = (() => { try { return JSON.parse(node.keywords_json || '[]'); } catch(_){return[];} })();
    return `
      <div class="schema-node-item" style="padding-left:${indent}px">
        <span class="schema-node-name">${escapeHtml(node.name)}</span>
        ${node.node_description ? `<span class="schema-node-desc">${escapeHtml(node.node_description)}</span>` : ''}
        ${kws.length ? `<div class="keyword-chips">${kws.slice(0,6).map(k=>`<span class="keyword-chip">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
        ${(node.children||[]).length ? renderSchemaNodeTree(node.children, depth+1) : ''}
      </div>
    `;
  }).join('');
}

async function loadSchemaTemplates() {
  const container = document.getElementById('schema-templates-list');
  if (!container) return;
  try {
    const templates = await api('/schema/templates');
    if (!templates.length) {
      container.innerHTML = '<p class="empty-state">No global templates yet.</p>';
      return;
    }
    container.innerHTML = templates.map(t => `
      <div class="schema-template-item">
        <span class="template-name" title="${escapeHtml(t.description || '')}">${escapeHtml(t.name)}</span>
        <div class="template-actions">
          <button class="btn btn-small btn-primary" onclick="applySchemaTemplate('${t.id}')">Apply</button>
          <button class="btn btn-small btn-danger" onclick="deleteSchemaTemplate('${t.id}', '${escapeHtml(t.name)}')">Delete</button>
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

    const mode = confirm('Replace existing schema? (OK = replace, Cancel = merge)')
      ? 'replace' : 'merge';

    const result = await api('/schema/import', {
      method: 'POST',
      body: JSON.stringify({ nodes, mode })
    });
    showToast(`Schema imported: ${result.created} created, ${result.updated} updated`, 'success');
    loadSchemaNodes();
    loadTree();
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  }
}

async function handleSchemaExport() {
  try {
    const resp = await fetch(`${API_BASE}/schema/export`, {
      headers: { 'X-Dataset-ID': currentDatasetId }
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
  if (!confirm('Apply this template to the current dataset? It will set mapping mode to Guided.')) return;
  try {
    const result = await api(`/schema/templates/${id}/apply`, { method: 'POST', body: JSON.stringify({ mode: 'merge' }) });
    showToast(`Template "${result.template_name}" applied — mode set to Guided`, 'success');
    loadSchemaSettings();
    loadSchemaNodes();
    loadTree();
  } catch (err) {
    showToast('Apply failed: ' + err.message, 'error');
  }
}

async function deleteSchemaTemplate(id, name) {
  if (!confirm(`Delete template "${name}"?`)) return;
  try {
    await api(`/schema/templates/${id}`, { method: 'DELETE' });
    showToast('Template deleted', 'success');
    loadSchemaTemplates();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function openSchemaSettings() {
  const s = await loadSchemaSettings();
  // Set toggle state
  document.querySelectorAll('#mapping-mode-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === s.mapping_mode);
  });
  document.querySelectorAll('#mapping-strictness-toggle .toggle-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === s.mapping_strictness);
  });
  const strictness = document.getElementById('strictness-group');
  if (strictness) strictness.style.display = s.mapping_mode === 'guided' ? '' : 'none';
  document.getElementById('schema-settings-modal').classList.remove('hidden');
}

async function saveSchemaSettings() {
  const mode       = document.querySelector('#mapping-mode-toggle .toggle-btn.active')?.dataset.value || 'free';
  const strictness = document.querySelector('#mapping-strictness-toggle .toggle-btn.active')?.dataset.value || 'soft';
  try {
    await api('/schema/settings', {
      method: 'PATCH',
      body: JSON.stringify({ mapping_mode: mode, mapping_strictness: strictness })
    });
    showToast('Schema settings saved', 'success');
    document.getElementById('schema-settings-modal').classList.add('hidden');
    loadSchemaSettings();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}
