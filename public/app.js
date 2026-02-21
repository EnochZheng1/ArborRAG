// TreeKB Frontend Application

const API_BASE = '';

// ── WebSocket (real-time job progress) ───────────────────────────────────────
let _ws = null;
const _wsQueue = [];

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
    _wsQueue.splice(0).forEach(msg => _ws.send(msg));
  });

  _ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'job_progress') {
        // Ignore progress events for other datasets (user may have switched while job ran)
        if (msg.datasetId && msg.datasetId !== currentDatasetId) return;
        _handleJobProgress(msg);
      }
    } catch { /* ignore */ }
  });

  _ws.addEventListener('close', () => {
    _ws = null;
    setTimeout(initWebSocket, 4000);
  });

  _ws.addEventListener('error', () => { /* close will fire */ });
}

function _handleJobProgress({ jobId, step, progress, message, status }) {
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rate_limited']);

  // Update live progress strip inside the job card
  const progressEl = document.getElementById(`job-progress-${jobId}`);
  if (progressEl) {
    if (TERMINAL.has(status)) {
      progressEl.innerHTML = '';
    } else {
      const pct = Math.max(0, Math.min(100, progress || 0));
      const stepLabel = (step || '').replace(/_/g, ' ');
      progressEl.innerHTML = `
        <div class="job-progress-bar"><div class="job-progress-fill" style="width:${pct}%"></div></div>
        <p class="job-stage-msg">${escapeHtml(stepLabel)}${message ? ' — ' + escapeHtml(message) : ''}</p>
      `;
    }
  }

  if (TERMINAL.has(status)) {
    // Trigger an immediate poll to get the full final job state
    const entry = _uploadJobPollers.get(String(jobId));
    if (entry) {
      clearTimeout(entry.timer);
      entry.pollFn();
    }
    _wsSend({ type: 'unwatch', jobId: String(jobId) });
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
    detect_conflicts: 'Detect conflicts',
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
    conflicts_title: 'Conflicts',
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
    keep_a: 'Keep Chunk A',
    keep_b: 'Keep Chunk B',
    keep_both: 'Keep Both',
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
    conflict_explainer_title: 'What is a conflict?',
    conflict_explainer_body: 'A conflict means two chunks under the same node contain incompatible facts or requirements. Review both chunks and keep the one you trust.',
    conflict_reason: 'Why this is flagged',
    conflict_recommendation: 'Recommendation',
    conflict_type_numeric_contradiction: 'Numeric contradiction',
    conflict_type_statement_contradiction: 'Statement contradiction',
    conflict_type_semantic_conflict: 'Semantic conflict',
    conflict_type_factual_conflict: 'Factual conflict',
    total_conflicts: 'Total Conflicts',
    unresolved: 'Unresolved',
    resolved: 'Resolved',
    no_unresolved_conflicts: 'No unresolved conflicts',
    conflict_node_label: 'Node',
    conflict_chunk_a: 'Chunk A',
    conflict_chunk_b: 'Chunk B',
    unknown: 'Unknown',
    no_content: 'No content',
    conflict_reason_default: 'Potentially incompatible information detected between these two chunks.',
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
    conflicts_title: '冲突管理',
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
    keep_a: '保留分块 A',
    keep_b: '保留分块 B',
    keep_both: '保留两者',
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
    conflict_explainer_title: '什么是冲突？',
    conflict_explainer_body: '冲突意味着同一节点下的两段内容存在事实或要求不一致。请对比两段内容，保留你信任的版本。',
    conflict_reason: '标记原因',
    conflict_recommendation: '处理建议',
    conflict_type_numeric_contradiction: '数值冲突',
    conflict_type_statement_contradiction: '陈述冲突',
    conflict_type_semantic_conflict: '语义冲突',
    conflict_type_factual_conflict: '事实冲突',
    total_conflicts: '总冲突数',
    unresolved: '未解决',
    resolved: '已解决',
    no_unresolved_conflicts: '当前没有未解决的冲突',
    conflict_node_label: '节点',
    conflict_chunk_a: '分块 A',
    conflict_chunk_b: '分块 B',
    unknown: '未知',
    no_content: '无内容',
    conflict_reason_default: '系统检测到这两段内容可能互相不一致。',
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
let documentsPollTimer = null;
let currentQueryResult = null; // Store current result for feedback
let suggestionTimeout = null;
let graphSimulation = null; // D3 force simulation
let currentGraphView = 'list'; // 'list' or 'graph'

// Dataset state
let currentDatasetId = 'default';
let currentDatasetName = 'Default';
let allDatasets = [];
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
  initConflicts();
  initStats();
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
      if (tabId === 'tree') loadTree();
      if (tabId === 'documents') loadDocuments();
      if (tabId === 'conflicts') loadConflicts();
      if (tabId === 'stats') loadStats();
      if (tabId === 'datasets') loadDatasets();
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
    } else if (result.data.answer) {
      plainAnswer = result.data.answer;
      contentHtml = `${executionSummaryHtml}<div class="answer-text">${renderMarkdown(result.data.answer)}</div>
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

  // Toggle button
  let html = `
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
      loadNodeDetail(nodeId);

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

    nameEl.textContent = node.node?.name || node.name;

    const n = node.node || node;
    const chunks = chunksData.chunks || [];
    const entities = entitiesData.entities || [];
    const facts = entitiesData.facts || [];

    // Format summary with proper line breaks
    const summaryHtml = (n.node_summary || '(none)')
      .replace(/\n/g, '<br>')
      .replace(/Key topics:/g, '<strong>Key topics:</strong>');

    let html = `
      <div class="node-meta">
        <dl>
          <dt>ID</dt>
          <dd><code>${n.node_id}</code></dd>
          <dt>Level</dt>
          <dd>${n.level}</dd>
          <dt>Parent</dt>
          <dd>${n.parent_id || '(root)'}</dd>
        </dl>
      </div>

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

    // Show chunks
    if (chunks.length > 0) {
      html += `
        <div class="node-chunks">
          <h4>📄 Content (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})</h4>
          <div class="chunks-list">
      `;

      for (const chunk of chunks) {
        const fullContent = (chunk.content_clean || chunk.content || '').trim();
        const keywords = chunk.keywords_json ?
          (typeof chunk.keywords_json === 'string' ? JSON.parse(chunk.keywords_json) : chunk.keywords_json) : [];

        html += `
          <div class="chunk-item">
            <div class="chunk-header">
              <span class="chunk-type">${chunk.chunk_type || 'content'}</span>
              <span class="chunk-source">${chunk.doc_title || 'Unknown source'}</span>
            </div>
            <p class="chunk-preview">${fullContent.replace(/\n/g, '<br>')}</p>
            ${keywords.length ? `<div class="chunk-keywords">${keywords.map(k => `<span class="keyword-tag">${k}</span>`).join('')}</div>` : ''}
          </div>
        `;
      }

      html += '</div></div>';
    } else if (entities.length === 0 && facts.length === 0) {
      html += '<p class="no-chunks">No content in this node</p>';
    }

    contentEl.innerHTML = html;

    // Wire up child node items to navigate on click
    contentEl.querySelectorAll('.node-child-item').forEach(item => {
      item.addEventListener('click', () => {
        const childId = item.dataset.nodeId;
        // Highlight the corresponding tree node if visible
        document.querySelectorAll('.tree-node-item').forEach(n => n.classList.remove('selected'));
        const treeItem = document.querySelector(`.tree-node-item[data-node-id="${childId}"]`);
        if (treeItem) treeItem.classList.add('selected');
        loadNodeDetail(childId);
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

function populateNodeSelects() {
  const selects = [
    document.getElementById('new-node-parent'),
    document.getElementById('target-node')
  ];

  selects.forEach(select => {
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">-- ' + (select.id === 'target-node' ? 'Auto-detect' : 'No Parent (Root)') + ' --</option>';

    allNodes.forEach(node => {
      const option = document.createElement('option');
      option.value = node.node_id;
      const level = Number.isFinite(node.level) && node.level > 0 ? node.level : 1;
      option.textContent = `${'  '.repeat(level - 1)}${node.name}`;
      select.appendChild(option);
    });

    select.value = currentValue;
  });
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

  const targetNodeId = document.getElementById('target-node').value;
  const useLLM = document.getElementById('upload-use-llm').checked;
  const detectConflicts = document.getElementById('upload-detect-conflicts').checked;

  try {
    const formData = new FormData();

    if (selectedFiles.length === 1) {
      formData.append('file', selectedFiles[0]);
      if (targetNodeId) formData.append('targetNodeId', targetNodeId);
      formData.append('useLLM', useLLM);
      formData.append('detectConflicts', detectConflicts);

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
      if (targetNodeId) formData.append('targetNodeId', targetNodeId);
      formData.append('useLLM', useLLM);
      formData.append('detectConflicts', detectConflicts);

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
    loadDocuments();
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

  return `
    <div style="padding: 12px; background: var(--bg-main); border-radius: 8px; margin-top: 12px;">
      <strong>${filename}</strong>
      <span class="status-badge status-${statusClass}">${statusText}</span>
      ${job?.id ? `<span style="margin-left: 8px; color: var(--text-secondary); font-size: 12px;">Job #${job.id}</span>` : ''}
      ${isQueued ? `<p style="margin-top: 8px; color: var(--text-secondary); font-size: 13px;">⏳ Background processing in progress…</p>` : ''}
      ${job?.id && isQueued ? `<div class="job-live-progress" id="job-progress-${job.id}"></div>` : ''}
      ${chunkCount ? `<p style="margin-top: 8px; color: var(--text-secondary); font-size: 13px;">${chunkCount} chunks created</p>` : ''}
      ${job?.document_id ? `<p style="margin-top: 6px; color: var(--text-secondary); font-size: 12px;">Document #${job.document_id}</p>` : ''}
      ${result?.errors?.length ? `<p style="margin-top: 6px; color: var(--danger); font-size: 13px;">${result.errors.join(', ')}</p>` : ''}
      ${job?.error_message && !isQueued ? `<p style="margin-top: 6px; color: var(--danger); font-size: 13px;">${job.error_message}</p>` : ''}
      ${isRateLimited ? `<p style="margin-top: 6px; color: var(--warning, #f59e0b); font-size: 13px;">Paused — API rate limit hit. Go to the Documents tab to resume.</p>` : ''}
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

      // Update just this card in the result div
      const resultDiv = document.getElementById('upload-result');
      if (resultDiv) {
        const cards = resultDiv.querySelectorAll('[data-job-id]');
        for (const card of cards) {
          if (String(card.dataset.jobId) === String(jobId)) {
            card.outerHTML = `<div data-job-id="${jobId}">${_renderUploadJobRow(allResults[resultIndex], job)}</div>`;
            break;
          }
        }
      }

      if (TERMINAL.has(job.status)) {
        _stopUploadJobPoller(jobId);
        _wsSend({ type: 'unwatch', jobId: String(jobId) });
        // Refresh the Documents tab list in the background
        if (job.status === 'completed') loadDocuments();
        if (job.status === 'rate_limited') loadRateLimitedJobs();
        return;
      }
    } catch {
      // Network hiccup — keep polling
    }

    const entry = _uploadJobPollers.get(jobId);
    if (entry) {
      entry.timer = setTimeout(poll, 2000);
    }
  }

  // Store pollFn so the WS handler can trigger an immediate poll
  _uploadJobPollers.set(jobId, { timer: setTimeout(poll, 2000), pollFn: poll });
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
  document.getElementById('refresh-docs-btn').addEventListener('click', loadDocuments);
  document.getElementById('doc-status-filter').addEventListener('change', loadDocuments);
}

async function loadRateLimitedJobs() {
  const banner = document.getElementById('rate-limited-banner');
  if (!banner) return;
  try {
    const data = await api('/ingest/jobs?status=rate_limited&limit=50');
    const jobs = data.jobs || [];
    if (jobs.length === 0) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <div class="rate-limit-banner-header">
        <span class="rate-limit-icon">⏸</span>
        <strong>${jobs.length} job${jobs.length > 1 ? 's' : ''} paused — API rate limit (429)</strong>
        <span class="rate-limit-hint">Resume after your Gemini quota resets (usually within a minute or an hour).</span>
      </div>
      <div class="rate-limit-jobs">
        ${jobs.map(job => `
          <div class="rate-limit-job">
            <span class="rate-limit-job-name">${job.original_name || job.file_path}</span>
            <span class="rate-limit-job-err">${job.error_message ? job.error_message.replace(/^Rate limit hit \(429\) — resume when quota resets: /, '') : ''}</span>
            <button class="btn btn-sm btn-warning resume-job-btn" data-job-id="${job.id}">Resume</button>
          </div>
        `).join('')}
      </div>
    `;
  } catch {
    banner.classList.add('hidden');
  }
}

window.resumeRateLimitedJob = async function(jobId) {
  try {
    await api(`/ingest/jobs/${jobId}/retry`, { method: 'POST' });
    showToast('Job resumed — processing will restart shortly.', 'success');
    loadRateLimitedJobs();
    loadDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

async function loadDocuments() {
  loadRateLimitedJobs();
  const tbody = document.getElementById('documents-tbody');
  if (documentsPollTimer) {
    clearTimeout(documentsPollTimer);
    documentsPollTimer = null;
  }

  // Keep skeleton rows visible initially
  const status = document.getElementById('doc-status-filter').value;

  try {
    const data = await api(`/documents${status ? `?status=${status}` : ''}`);

    if (!data.documents || data.documents.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8">${renderEmptyState(
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        'No documents yet',
        'Upload your first document to populate the knowledge base.'
      )}</td></tr>`;
      return;
    }

    tbody.innerHTML = data.documents.map(doc => `
      <tr>
        <td>${doc.id}</td>
        <td>${doc.original_name || doc.filename}</td>
        <td>${doc.file_type || '-'}</td>
        <td><span class="status-badge status-${doc.status}">${doc.status}</span></td>
        <td>${formatDocumentStep(doc)}</td>
        <td>${Math.max(0, doc.chunk_count || 0)}</td>
        <td>${doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : '-'}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteDocument(${doc.id})">${t('delete')}</button>
        </td>
      </tr>
    `).join('');

    const hasInProgress = data.documents.some(doc => doc.status === 'processing');
    const docsTabActive = document.getElementById('tab-documents')?.classList.contains('active');
    if (hasInProgress && docsTabActive) {
      documentsPollTimer = setTimeout(() => {
        loadDocuments();
      }, 1500);
    }
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading-text error">${error.message}</td></tr>`;
  }
}

function formatDocumentStep(doc) {
  const message = doc.processing_message || doc.processing_step || '-';
  const progress = Number.isFinite(doc.processing_progress) ? doc.processing_progress : null;

  if (doc.status === 'processing' && progress !== null) {
    return `${message} (${progress}%)`;
  }
  return message;
}

document.getElementById('tab-documents')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.resume-job-btn');
  if (btn) resumeRateLimitedJob(Number(btn.dataset.jobId));
});

window.deleteDocument = async function(id) {
  if (!confirm(t('confirm_delete'))) return;

  try {
    await api(`/documents/${id}`, { method: 'DELETE' });
    showToast(t('success'), 'success');
    loadDocuments();
  } catch (error) {
    showToast(error.message, 'error');
  }
};

// Conflicts Tab
function initConflicts() {
  document.getElementById('refresh-conflicts-btn').addEventListener('click', loadConflicts);
}

function getConflictTypeLabel(conflictType) {
  if (!conflictType) return t('unknown');

  const normalized = String(conflictType).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const key = `conflict_type_${normalized}`;
  return i18n[currentLang][key] || conflictType;
}

function formatConflictReason(conflict) {
  const reason = conflict?.reason || {};
  const recommendation = typeof reason.recommendation === 'string'
    ? reason.recommendation.trim()
    : '';

  if (typeof reason.explanation === 'string' && reason.explanation.trim()) {
    return {
      explanation: reason.explanation.trim(),
      recommendation
    };
  }

  if (conflict?.conflict_type === 'numeric_contradiction') {
    const contextA = reason.chunk_a_context || t('conflict_chunk_a');
    const contextB = reason.chunk_b_context || t('conflict_chunk_b');
    const valueA = reason.chunk_a_value ?? '?';
    const valueB = reason.chunk_b_value ?? '?';

    return {
      explanation: `${t('conflict_type_numeric_contradiction')}: ${contextA} (${valueA}) vs ${contextB} (${valueB})`,
      recommendation
    };
  }

  if (conflict?.conflict_type === 'statement_contradiction' && reason.pattern_found) {
    return {
      explanation: reason.pattern_found,
      recommendation
    };
  }

  return {
    explanation: t('conflict_reason_default'),
    recommendation
  };
}

async function loadConflicts() {
  const statsDiv = document.getElementById('conflict-stats');
  const listDiv = document.getElementById('conflict-list');

  // Keep skeleton visible initially

  try {
    const data = await api('/conflicts');

    // Stats
    statsDiv.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${data.stats?.total || 0}</div>
        <div class="stat-label">${t('total_conflicts')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.stats?.unresolved || 0}</div>
        <div class="stat-label">${t('unresolved')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${data.stats?.resolved || 0}</div>
        <div class="stat-label">${t('resolved')}</div>
      </div>
    `;

    // List
    if (!data.conflicts || data.conflicts.length === 0) {
      listDiv.innerHTML = renderEmptyState(
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        t('no_unresolved_conflicts'),
        ''
      );
      return;
    }

    listDiv.innerHTML = data.conflicts.map(c => {
      const reason = formatConflictReason(c);
      const typeLabel = escapeHtml(getConflictTypeLabel(c.conflict_type));
      const nodeName = escapeHtml(c.node_name || t('unknown'));
      const chunkAContent = escapeHtml(c.chunk_a?.content || t('no_content'));
      const chunkBContent = escapeHtml(c.chunk_b?.content || t('no_content'));
      const reasonText = escapeHtml(reason.explanation || t('conflict_reason_default'));
      const recommendationText = reason.recommendation ? escapeHtml(reason.recommendation) : '';
      const chunkAId = c.chunk_a?.id ?? '-';
      const chunkBId = c.chunk_b?.id ?? '-';
      const keepAId = c.chunk_a?.id ?? 'null';
      const keepBId = c.chunk_b?.id ?? 'null';

      return `
        <div class="conflict-card">
          <div class="conflict-header">
            <span class="conflict-type">${typeLabel}</span>
            <span>${t('conflict_node_label')}: ${nodeName}</span>
          </div>
          <div class="conflict-body">
            <div class="conflict-reason">
              <h5>${t('conflict_reason')}</h5>
              <p>${reasonText}</p>
              ${recommendationText ? `<p class="conflict-recommendation"><strong>${t('conflict_recommendation')}:</strong> ${recommendationText}</p>` : ''}
            </div>
            <div class="conflict-chunk">
              <h5>${t('conflict_chunk_a')} (ID: ${chunkAId})</h5>
              <p>${chunkAContent}</p>
            </div>
            <div class="conflict-chunk">
              <h5>${t('conflict_chunk_b')} (ID: ${chunkBId})</h5>
              <p>${chunkBContent}</p>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-primary btn-sm" onclick="resolveConflict(${c.id}, ${keepAId}, ${keepBId})">${t('keep_a')}</button>
              <button class="btn btn-primary btn-sm" onclick="resolveConflict(${c.id}, ${keepBId}, ${keepAId})">${t('keep_b')}</button>
              <button class="btn btn-secondary btn-sm" onclick="keepBothChunks(${c.id})">${t('keep_both')}</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    listDiv.innerHTML = `<p class="loading-text error">${escapeHtml(error.message)}</p>`;
  }
}

window.resolveConflict = async function(conflictId, keepId, archiveId) {
  try {
    await api(`/conflicts/${conflictId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        resolution: 'manual',
        keepChunkId: keepId,
        archiveChunkId: archiveId,
        notes: 'Resolved via UI'
      })
    });

    showToast(t('success'), 'success');
    loadConflicts();
  } catch (error) {
    showToast(error.message, 'error');
  }
};

window.keepBothChunks = async function(conflictId) {
  try {
    await api(`/conflicts/${conflictId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        resolution: 'keep_both',
        notes: 'Kept both chunks via UI'
      })
    });

    showToast(t('success'), 'success');
    loadConflicts();
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
        <h3>⚠️ Conflicts</h3>
        <div class="stats-grid">
          <div class="stats-item">
            <div class="value">${data.conflicts?.total || 0}</div>
            <div class="label">Total</div>
          </div>
          <div class="stats-item">
            <div class="value">${data.conflicts?.unresolved || 0}</div>
            <div class="label">Unresolved</div>
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
    else if (activeTab === 'conflicts') loadConflicts();
    else if (activeTab === 'stats') loadStats();
    else if (activeTab === 'datasets') loadDatasets();
  }
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

    // Fetch stats for each dataset in parallel
    const statsResults = await Promise.allSettled(
      allDatasets.map(d => fetch(`/datasets/${d.id}/stats`).then(r => r.json()))
    );

    list.innerHTML = allDatasets.map((d, i) => {
      const stats = statsResults[i].status === 'fulfilled' ? statsResults[i].value : {};
      return renderDatasetCard(d, stats);
    }).join('');

    // Wire up card action buttons via delegation
    list.addEventListener('click', handleDatasetCardAction);
  } catch (err) {
    list.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
  }
}

function renderDatasetCard(dataset, stats = {}) {
  const isActive = dataset.id === currentDatasetId;
  const nodeCount = stats.node_count ?? '—';
  const docCount = stats.document_count ?? '—';
  const createdDate = dataset.created_at ? new Date(dataset.created_at).toLocaleDateString() : '';

  return `
    <div class="dataset-card" data-dataset-id="${escapeHtml(dataset.id)}">
      <div class="dataset-card-header">
        <div class="dataset-card-title">
          <h3 class="dataset-name">${escapeHtml(dataset.name)}</h3>
          ${isActive ? `<span class="dataset-active-badge">${t('dataset_active')}</span>` : ''}
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
  const name = nameInput?.value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }

  try {
    const result = await api('/datasets', {
      method: 'POST',
      body: JSON.stringify({ name, description: descInput?.value.trim() || '' })
    });
    document.getElementById('dataset-create-form').classList.add('hidden');
    nameInput.value = '';
    if (descInput) descInput.value = '';
    showToast(t('dataset_created'), 'success');
    loadDatasets();
  } catch (err) { showToast(err.message, 'error'); }
}
