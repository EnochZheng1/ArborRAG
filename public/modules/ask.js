// ── Ask Tab ──────────────────────────────────────────────────────────────────
import { state, HISTORY_KEY, FAVORITES_KEY, MAX_HISTORY } from './state.js';
import { api, escapeHtml, showToast, autoResizeTextarea, renderMarkdown, copyToClipboard } from './utils.js';
import { t } from './i18n.js';

// ── Query History Management ─────────────────────────────────────────────────

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

function getQueryFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveQueryFavorites(favs) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
}

function toggleFavorite(query) {
  const favs = getQueryFavorites();
  const idx = favs.findIndex(f => f.query === query);
  if (idx >= 0) {
    favs.splice(idx, 1);
  } else {
    favs.unshift({ query, savedAt: Date.now() });
  }
  saveQueryFavorites(favs);
  renderQueryHistory();
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

function renderQueryHistory() {
  const historyList = document.getElementById('history-list');
  if (!historyList) return;

  const history = getQueryHistory();
  const favs = getQueryFavorites();
  const favSet = new Set(favs.map(f => f.query));

  let html = '';

  // Favorites section
  if (favs.length > 0) {
    html += `<div class="history-section-label">Favorites</div>`;
    html += favs.map(f => {
      const truncated = f.query.length > 60 ? f.query.slice(0, 60) + '...' : f.query;
      return `
        <div class="history-item" data-query="${encodeURIComponent(f.query)}">
          <span class="history-fav-btn active" data-fav-query="${encodeURIComponent(f.query)}">&#9733;</span>
          <span class="history-query">${escapeHtml(truncated)}</span>
        </div>
      `;
    }).join('');
  }

  // Recent queries section
  if (history.length > 0) {
    if (favs.length > 0) html += `<div class="history-section-label">Recent</div>`;
    html += history.map(item => {
      const timeAgo = formatTimeAgo(item.timestamp);
      const truncatedQuery = item.query.length > 60 ? item.query.slice(0, 60) + '...' : item.query;
      const isFav = favSet.has(item.query);
      return `
        <div class="history-item" data-query="${encodeURIComponent(item.query)}">
          <span class="history-fav-btn${isFav ? ' active' : ''}" data-fav-query="${encodeURIComponent(item.query)}">&#9733;</span>
          <span class="history-query">${escapeHtml(truncatedQuery)}</span>
          <span class="history-type">${item.queryType.replace('_', ' ')}</span>
          <span class="history-time">${timeAgo}</span>
        </div>
      `;
    }).join('');
  }

  if (!html) {
    historyList.innerHTML = `<div class="history-empty">${t('no_history')}</div>`;
    return;
  }

  historyList.innerHTML = html;

  // Attach favorite toggle events (stop propagation so clicking star doesn't trigger query)
  historyList.querySelectorAll('.history-fav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(decodeURIComponent(btn.dataset.favQuery));
    });
  });
}

// ── Suggestions ──────────────────────────────────────────────────────────────

function handleQueryInput(e) {
  const value = e.target.value.trim();

  if (state.suggestionTimeout) {
    clearTimeout(state.suggestionTimeout);
  }

  if (value.length < 1) {
    hideSuggestions();
    return;
  }

  state.suggestionTimeout = setTimeout(() => {
    fetchSuggestions(value);
  }, 200);
}

async function fetchSuggestions(prefix) {
  try {
    const result = await api(`/suggestions?q=${encodeURIComponent(prefix)}&limit=8`, { dedupe: true });
    if (result?.suggestions?.length > 0) {
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

  list.innerHTML = suggestions.map(s => `<li class="suggestion-item suggestion-${s.type}" data-text="${s.text.replace(/"/g, '&quot;')}">${s.text}${s.type !== 'node' ? `<span class="suggestion-type">${s.type}</span>` : ''}</li>`).join('');

  container.classList.remove('hidden');
}

function hideSuggestions() {
  document.getElementById('suggestions-container')?.classList.add('hidden');
}

// ── Feedback ─────────────────────────────────────────────────────────────────

async function handleFeedback(rating) {
  if (!state.currentQueryResult) return;

  const query = document.getElementById('query-input').value.trim();
  const nodeIds = state.currentQueryResult.top?.map(t => t.node?.node_id).filter(Boolean) || [];
  const chunkIds = state.currentQueryResult.snippets?.map(s => s.chunkId).filter(Boolean) || [];

  try {
    await api('/feedback', {
      method: 'POST',
      body: JSON.stringify({
        query,
        queryType: state.currentQueryResult.query_type,
        answer: state.currentQueryResult.llm_response?.final_answer,
        rating,
        nodeIds,
        chunkIds,
        confidenceAtAnswer: state.currentQueryResult.confidence
          ?? state.currentQueryResult.confidence_details?.score
          ?? null
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

// ── Ask handler ──────────────────────────────────────────────────────────────

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
    if (!result) return; // request aborted

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

// ── Display helpers ──────────────────────────────────────────────────────────

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

function humanizeTraceKey(keyPath) {
  return String(keyPath || 'value')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\[(\d+)\]/g, ' $1')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function renderAskExecutionSummary(result) {
  if (!result || typeof result !== 'object') return '';

  const confidence = Number(result.confidence);
  const confidenceText = Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : 'n/a';
  const rc = Number(result.retrieval_confidence);
  const ag = Number(result.answer_groundedness);
  const retrievalConfText = Number.isFinite(rc) ? `${Math.round(rc * 100)}%` : 'n/a';
  const groundednessText = Number.isFinite(ag) ? `${Math.round(ag * 100)}%` : 'n/a';
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

  // Routing mode indicator
  const routingModeLabels = { keyword: 'Keyword', vector: 'Vector', llm: 'LLM' };
  const routingMode = result.routing_mode || 'keyword';
  const routingLabel = routingModeLabels[routingMode] || routingMode;

  const metricItems = [
    { label: 'Type', value: formatQueryTypeLabel(result.query_type || 'simple_lookup') },
    { label: 'Routing', value: routingLabel },
    { label: 'Retrieval', value: retrievalConfText },
    { label: 'Grounding', value: groundednessText },
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

// ── Trace rendering ──────────────────────────────────────────────────────────

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

function buildTraversalSteps(exploredNodes) {
  if (!Array.isArray(exploredNodes) || exploredNodes.length === 0) return [];

  const byDepth = new Map();
  for (const e of exploredNodes) {
    if (!byDepth.has(e.depth)) byDepth.set(e.depth, []);
    byDepth.get(e.depth).push(e);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const steps = [];

  for (const depth of depths) {
    const nodesAtDepth = byDepth.get(depth);
    const byParent = new Map();
    for (const n of nodesAtDepth) {
      const pid = n.parent_id || '__root__';
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(n);
    }

    for (const [parentId, children] of byParent) {
      let parentName = 'Knowledge Tree';
      if (parentId !== '__root__') {
        for (const d of depths) {
          if (d >= depth) break;
          const found = byDepth.get(d)?.find(n => n.node_id === parentId);
          if (found) { parentName = found.name; break; }
        }
      }
      children.sort((a, b) => (b.selected ? 1 : 0) - (a.selected ? 1 : 0) || b.score - a.score);
      const display = children.slice(0, 12);
      const overflow = children.length - display.length;
      steps.push({ depth, parentId, parentName, children: display, overflow });
    }
  }
  return steps;
}

function renderTraversalAnimation(container, exploredNodes, { animate = null } = {}) {
  const steps = buildTraversalSteps(exploredNodes);
  if (steps.length === 0) {
    container.innerHTML = '<p class="trace-empty">No traversal data</p>';
    return;
  }

  const shouldAnimate = animate !== null ? animate : (localStorage.getItem('tv_animate') !== 'false');

  container.innerHTML = '';
  const STEP_DELAY = 1200;
  const CHILD_STAGGER = 80;

  const stepEls = [];
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    const frame = document.createElement('div');
    frame.className = shouldAnimate ? 'tv-step' : 'tv-step tv-step--visible tv-step--no-anim';

    const header = document.createElement('div');
    header.className = 'tv-step-header';
    header.innerHTML = `<span class="tv-step-depth">Depth ${step.depth}</span>`
      + `<span class="tv-step-parent">${escapeHtml(step.parentName)}</span>`
      + `<span class="tv-step-arrow">\u2192</span>`
      + `<span class="tv-step-count">${step.children.length}${step.overflow > 0 ? '+' + step.overflow : ''} nodes</span>`;
    frame.appendChild(header);

    const list = document.createElement('div');
    list.className = 'tv-step-children';
    for (let ci = 0; ci < step.children.length; ci++) {
      const c = step.children[ci];
      const pill = document.createElement('div');
      const scoreCls = c.score >= 0.5 ? 'tv-pill--high' : c.score >= 0.25 ? 'tv-pill--med' : 'tv-pill--low';
      const selectedCls = c.selected ? 'tv-pill--selected' : 'tv-pill--pruned';
      pill.className = `tv-pill ${scoreCls} ${selectedCls}`;
      if (shouldAnimate) {
        pill.style.animationDelay = `${ci * CHILD_STAGGER}ms`;
      } else {
        pill.classList.add('tv-pill--no-anim');
      }
      pill.innerHTML = `<span class="tv-pill-name">${escapeHtml(c.name.length > 24 ? c.name.slice(0, 22) + '\u2026' : c.name)}</span>`
        + `<span class="tv-pill-score">${c.score.toFixed(2)}</span>`;
      list.appendChild(pill);
    }
    if (step.overflow > 0) {
      const more = document.createElement('div');
      more.className = 'tv-pill tv-pill--overflow';
      if (!shouldAnimate) more.classList.add('tv-pill--no-anim');
      more.textContent = `+${step.overflow} more`;
      list.appendChild(more);
    }
    frame.appendChild(list);
    container.appendChild(frame);
    stepEls.push(frame);
  }

  if (shouldAnimate) {
    stepEls.forEach((el, i) => {
      setTimeout(() => el.classList.add('tv-step--visible'), i * STEP_DELAY);
    });
  }
}

function renderTreeSvg(root) {
  const NODE_W = 140, NODE_H = 32, COL_W = 170, MARGIN = 12, ROW_GAP = 8;

  function countLeaves(node) {
    if (node.children.length === 0) return 1;
    return node.children.reduce((s, c) => s + countLeaves(c), 0);
  }

  function assignPositions(node, depth, yStart, yEnd) {
    const x = depth * COL_W + MARGIN;
    const y = (yStart + yEnd) / 2;
    node._x = x; node._y = y; node._depth = depth;
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

  const showRoot = root.children.length > 1;
  const leafCount = countLeaves(root);
  const svgHeight = Math.max(60, leafCount * (NODE_H + ROW_GAP));
  const maxDepth = (function gmd(n, d) { return n.children.length === 0 ? d : Math.max(...n.children.map(c => gmd(c, d + 1))); })(root, 0);
  const svgWidth = (showRoot ? maxDepth + 1 : maxDepth) * COL_W + NODE_W + MARGIN * 2;

  if (showRoot) { assignPositions(root, 0, 0, svgHeight); }
  else {
    let yOff = 0;
    const totalLeaves = countLeaves(root);
    for (const child of root.children) {
      const childLeaves = countLeaves(child);
      const childHeight = svgHeight * (childLeaves / totalLeaves);
      assignPositions(child, 0, yOff, yOff + childHeight);
      yOff += childHeight;
    }
  }

  const nodes = [], edges = [];
  (function collect(node) {
    if (node === root && !showRoot) { node.children.forEach(collect); return; }
    nodes.push(node);
    for (const child of node.children) { edges.push({ parent: node, child }); collect(child); }
  })(root);

  let svg = '';
  for (const { parent, child } of edges) {
    const x1 = parent._x + NODE_W, y1 = parent._y, x2 = child._x, y2 = child._y;
    svg += `<path class="tv-edge" d="M${x1},${y1} C${x1 + (x2 - x1) * 0.5},${y1} ${x2 - (x2 - x1) * 0.5},${y2} ${x2},${y2}"/>`;
  }
  for (const node of nodes) {
    const s = node.score || 0;
    const cls = s >= 0.5 ? 'tv-node--high' : s >= 0.25 ? 'tv-node--med' : 'tv-node--low';
    const label = node.name.length > 17 ? node.name.slice(0, 15) + '\u2026' : node.name;
    const scoreText = node.depth >= 0 && s > 0 ? s.toFixed(2) : '';
    const ny = node._y - NODE_H / 2;
    svg += `<g class="tv-node ${cls}" transform="translate(${node._x},${ny})">
      <rect width="${NODE_W}" height="${NODE_H}" rx="5"/>
      <text class="tv-label" x="${NODE_W / 2}" y="13" text-anchor="middle" dominant-baseline="auto">${escapeHtml(label)}</text>
      ${scoreText ? `<text class="tv-score" x="${NODE_W - 4}" y="${NODE_H - 4}" text-anchor="end">${scoreText}</text>` : ''}
    </g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="display:block">${svg}</svg>`;
}

function renderQueryVizPanel(trace) {
  if (!trace || !trace.steps) return '';

  const treeStep = trace.steps.find(s => s.name === 'Hierarchy: Top-Down Navigation');
  const classifyStep = trace.steps.find(s => s.name === 'Query Classification');
  const completeStep = trace.steps.find(s => s.name === 'Hierarchical Retrieval Complete');

  const queryType = classifyStep && classifyStep.result && classifyStep.result.type
    ? classifyStep.result.type
    : (classifyStep && classifyStep.result && typeof classifyStep.result === 'string'
      ? classifyStep.result : null);
  const typePill = queryType
    ? `<span class="query-viz-pill query-viz-pill--type">${escapeHtml(queryType)}</span>`
    : '';

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

  let hasExplored = false;
  let treeHtml = '';
  if (treeStep && treeStep.result) {
    const explored = treeStep.result.explored_nodes;
    const allNodes = treeStep.result.all_nodes;

    if (Array.isArray(explored) && explored.length > 0) {
      hasExplored = true;
      treeHtml = `<div class="tv-traversal-container" id="tv-traversal-target"></div>`;
    } else if (Array.isArray(allNodes) && allNodes.length > 0) {
      const treeData = buildTreeFromPaths(allNodes);
      if (treeData) {
        treeHtml = `<div class="query-viz-tree">${renderTreeSvg(treeData)}</div>`;
      }
    }
  }

  const animOn = localStorage.getItem('tv_animate') !== 'false';
  const controlsHtml = hasExplored ? `<div class="tv-footer">
    <div class="tv-legend">
      <span class="tv-legend-item"><span class="tv-legend-dot tv-legend-dot--selected"></span> Selected</span>
      <span class="tv-legend-item"><span class="tv-legend-dot tv-legend-dot--pruned"></span> Pruned</span>
    </div>
    <div class="tv-controls">
      <button class="tv-control-btn" id="tv-replay-btn" title="Replay animation"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
      <button class="tv-control-btn${animOn ? ' active' : ''}" id="tv-anim-toggle" title="Toggle animation"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9V3z"/><line x1="19" y1="5" x2="19" y2="19"/></svg>${animOn ? '' : '<span class="tv-control-off-line"></span>'}</button>
    </div>
  </div>` : (treeHtml ? `<div class="tv-legend">
    <span class="tv-legend-item"><span class="tv-legend-dot tv-legend-dot--selected"></span> Selected</span>
    <span class="tv-legend-item"><span class="tv-legend-dot tv-legend-dot--pruned"></span> Pruned</span>
  </div>` : '');

  if (!typePill && !sourceHtml && !treeHtml) return '';

  if (hasExplored) {
    renderQueryVizPanel._pendingExplored = treeStep.result.explored_nodes;
  }

  return `<div class="query-viz-panel">
    <div class="query-viz-header">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93A10 10 0 0 0 2 12h2a8 8 0 0 1 13.66-5.66l-2.12 2.12A5 5 0 0 0 7 12H5a7 7 0 0 1 11.95-5"/></svg>
      <span class="query-viz-title">Tree Traversal</span>
      ${typePill}${sourceHtml}
    </div>
    ${treeHtml}
    ${controlsHtml}
  </div>`;
}
renderQueryVizPanel._pendingExplored = null;

function renderTrace(trace) {
  if (!trace || !trace.steps || trace.steps.length === 0) {
    return '<p class="trace-empty">No trace information available</p>';
  }

  const totalMs = trace.total_duration_ms || 0;
  const maxStepMs = Math.max(...trace.steps.map(s => s.duration_ms || 0), 1);
  const stepCount = trace.steps.length;
  const successCount = trace.steps.filter(s => s.status === 'success').length;
  const firstTimestamp = trace.steps[0]?.timestamp || Date.now();

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

  const vizHtml = renderQueryVizPanel(trace);

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

// ── Display Ask Result ───────────────────────────────────────────────────────

function displayAskResult(result, showTrace = false) {
  // Store for feedback
  state.currentQueryResult = result;

  const resultDiv = document.getElementById('ask-result');
  const queryText = document.getElementById('query-input').value.trim();

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

  typeBadge.textContent = formatQueryTypeLabel(result.query_type || 'simple_lookup');

  const showConfidence = document.getElementById('opt-show-confidence')?.checked ?? true;
  const minAnswerConfidence = parseFloat(document.getElementById('opt-min-answer-confidence')?.value || '0.3');

  const confidence = result.confidence || result.data?.confidence || 0;
  const confidenceLevel = result.confidence_details?.level || 'unknown';

  if (showConfidence && confidence > 0) {
    confidenceBadge.textContent = `${Math.round(confidence * 100)}% confidence`;
    confidenceBadge.className = `confidence-badge confidence-${confidenceLevel}`;
    confidenceBadge.style.display = '';
    if (result.confidence_details?.explanation?.summary) {
      const parts = [result.confidence_details.explanation.summary];
      if (Number.isFinite(result.retrieval_confidence))
        parts.push(`Retrieval: ${Math.round(result.retrieval_confidence * 100)}%`);
      if (Number.isFinite(result.answer_groundedness))
        parts.push(`Groundedness: ${Math.round(result.answer_groundedness * 100)}%`);
      confidenceBadge.title = parts.join(' | ');
    }
  } else {
    confidenceBadge.style.display = 'none';
  }

  resultDiv.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.classList.remove('selected');
    btn.disabled = false;
  });

  if (confidence < minAnswerConfidence && confidence > 0) {
    const warning = document.createElement('div');
    warning.className = 'low-confidence-warning';
    warning.innerHTML = `<svg class="warning-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>${t('low_confidence_warning')}</span>`;
    contentDiv.parentNode.insertBefore(warning, contentDiv);
  }

  let contentHtml = '';
  let plainAnswer = '';
  const executionSummaryHtml = renderAskExecutionSummary(result);

  if (result.error) {
    contentHtml = `${executionSummaryHtml}<p class="error">${escapeHtml(result.error)}</p>`;
  } else if (result.llm_response) {
    const llm = result.llm_response;
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
    contentHtml = `${executionSummaryHtml}<p>${renderMarkdown(result.message)}</p>
      <p class="ask-hint">Try rephrasing your question, or check if the relevant documents have been ingested in the Ingest tab.</p>`;
  }

  contentDiv.innerHTML = contentHtml;

  // Attach copy button handler
  const copyBtn = document.getElementById('copy-answer-btn');
  if (copyBtn && plainAnswer) {
    copyBtn.addEventListener('click', () => {
      copyToClipboard(plainAnswer).then(() => {
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><polyline points="20 6 9 17 4 12"/></svg> Copied';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
        }, 2000);
      });
    });
  }

  // Trace
  if (showTrace && result.trace) {
    traceDiv.classList.remove('hidden');
    traceDiv.innerHTML = renderTrace(result.trace);
    const traceToggle = traceDiv.querySelector('.trace-toggle-btn');
    const traceBody = traceDiv.querySelector('.trace-body');
    if (traceToggle && traceBody) {
      traceToggle.addEventListener('click', () => {
        traceToggle.classList.toggle('expanded');
        traceBody.classList.toggle('expanded');
      });
    }
    traceDiv.querySelectorAll('.trace-step-header').forEach(header => {
      header.addEventListener('click', () => {
        // Find the details div — may not be the immediate sibling if a duration bar exists
        const step = header.closest('.trace-step');
        const details = step?.querySelector('.trace-step-details');
        if (details) {
          details.classList.toggle('expanded');
          header.classList.toggle('expanded');
        }
      });
    });
    // Trigger traversal animation if explored_nodes data is pending
    if (renderQueryVizPanel._pendingExplored) {
      const target = traceDiv.querySelector('#tv-traversal-target');
      if (target) {
        renderTraversalAnimation(target, renderQueryVizPanel._pendingExplored);
      }
      const explored = renderQueryVizPanel._pendingExplored;
      const replayBtn = traceDiv.querySelector('#tv-replay-btn');
      const animToggle = traceDiv.querySelector('#tv-anim-toggle');
      if (replayBtn && target) {
        replayBtn.addEventListener('click', () => {
          renderTraversalAnimation(target, explored, { animate: true });
        });
      }
      if (animToggle) {
        animToggle.addEventListener('click', () => {
          const wasOn = localStorage.getItem('tv_animate') !== 'false';
          const nowOn = !wasOn;
          localStorage.setItem('tv_animate', nowOn ? 'true' : 'false');
          animToggle.classList.toggle('active', nowOn);
          const offLine = animToggle.querySelector('.tv-control-off-line');
          if (nowOn && offLine) offLine.remove();
          if (!nowOn && !animToggle.querySelector('.tv-control-off-line')) {
            const line = document.createElement('span');
            line.className = 'tv-control-off-line';
            animToggle.appendChild(line);
          }
          if (target) renderTraversalAnimation(target, explored, { animate: nowOn });
        });
      }
      renderQueryVizPanel._pendingExplored = null;
    }
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
            <span class="citation-title">${escapeHtml(c.title)}</span>
            ${c.node_name ? `<span class="citation-node">(${escapeHtml(c.node_name)})</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } else {
    citationsDiv.classList.add('hidden');
    citationsDiv.innerHTML = '';
  }

  // Facts
  let factsHtml = '';
  const facts = result.facts || [];
  if (facts.length > 0) {
    factsHtml = `
      <div class="result-facts">
        <h4>${t('extracted_facts')}</h4>
        ${facts.map(f => `
          <div class="fact-item">
            <span class="fact-type">${escapeHtml(f.type || 'fact')}</span>
            <span class="fact-content">${escapeHtml(f.content)}</span>
            ${f.entities?.length ? `<span class="fact-entities">${escapeHtml(f.entities.join(', '))}</span>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // Snippets
  let snippetsHtml = '';
  const snippets = result.snippets || [];
  if (snippets.length > 0) {
    snippetsHtml = `
      <div class="result-snippets">
        <h4>${t('relevant_excerpts')}</h4>
        ${snippets.map(s => `
          <div class="snippet-item">
            <div class="snippet-source">${escapeHtml(s.source || 'Unknown source')}</div>
            <div class="snippet-text">${s.html || escapeHtml(s.text)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Sources
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
        ${escapeHtml(q.question)}
      </button>
    `).join('');
  } else {
    relatedDiv.classList.add('hidden');
    relatedList.innerHTML = '';
  }

  resultDiv.classList.remove('hidden');

  const chatMessages = document.getElementById('chat-messages');
  if (chatMessages) {
    requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initAsk() {
  const askBtn = document.getElementById('ask-btn');
  const queryInput = document.getElementById('query-input');

  askBtn.addEventListener('click', handleAsk);
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
    if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  queryInput.addEventListener('input', (e) => {
    autoResizeTextarea(queryInput);
    handleQueryInput(e);
  });

  setTimeout(() => queryInput.focus(), 100);
  queryInput.addEventListener('focus', () => {
    if (queryInput.value.length >= 1) {
      fetchSuggestions(queryInput.value);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.chat-input-wrapper')) {
      hideSuggestions();
    }
  });

  document.querySelectorAll('.feedback-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFeedback(btn.dataset.rating));
  });

  document.getElementById('ask-result')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.related-question-btn');
    if (!btn) return;
    const question = decodeURIComponent(btn.dataset.question);
    const input = document.getElementById('query-input');
    input.value = question;
    input.focus();
    input.setSelectionRange(question.length, question.length);
  });

  document.getElementById('suggestions-list')?.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) {
      document.getElementById('query-input').value = li.dataset.text || li.textContent.trim();
      hideSuggestions();
      handleAsk();
    }
  });

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

export function initQueryHistory() {
  renderQueryHistory();

  document.getElementById('clear-history-btn')?.addEventListener('click', () => {
    clearHistory();
    showToast('History cleared', 'success');
  });

  document.getElementById('history-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (item) {
      const query = decodeURIComponent(item.dataset.query);
      document.getElementById('query-input').value = query;
      handleAsk();
    }
  });
}

// Export handleAsk for cross-module calls
export { handleAsk };
