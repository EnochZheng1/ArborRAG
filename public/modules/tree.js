// ── Tree Tab + Graph Views + Search ──────────────────────────────────────────
import { state, TREE_RENDER_DEPTH } from './state.js';
import { api, escapeHtml, showToast, showHtmlToast, renderEmptyState, registerFn, callFn, markTabsDirty, closeMobileSidebar, showConfirmModal } from './utils.js';
import { t } from './i18n.js';

// Module-level state (not shared across modules)
let treeData = [];
let allNodes = [];
let currentGraphView = 'list';
let graphSimulation = null;
let graphZoom = null;
let graphSvg = null;
let graphG = null;
let treeDiagramZoom = null;
let treeDiagramSvg = null;
let treeDiagramG = null;
const _lazyChildrenMap = new Map();
let addChunkTargetNodeId = null;

// showNodeDetail alias used by tree content search
function showNodeDetail(nodeId) { loadNodeDetail(nodeId); }

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
  document.getElementById('tree-health-btn')?.addEventListener('click', toggleTreeHealth);
  initBatchOps();
}

async function toggleTreeHealth() {
  const panel = document.getElementById('tree-health-panel');
  if (!panel) return;
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const summary = document.getElementById('tree-health-summary');
  const issuesDiv = document.getElementById('tree-health-issues');
  summary.innerHTML = '<span class="loading-text">Loading health report...</span>';
  issuesDiv.innerHTML = '';
  try {
    const data = await api('/nodes/health');
    if (!data) return;
    const nodes = data.nodes || [];
    const issues = data.issues || [];
    const embedded = nodes.filter(n => n.has_embedding).length;
    const withSummary = nodes.filter(n => n.has_summary).length;
    const schema = nodes.filter(n => n.is_schema_node).length;
    const empty = issues.filter(i => i.issue === 'empty').length;
    const noEmbed = issues.filter(i => i.issue === 'no_embedding').length;
    summary.innerHTML = `
      <div class="health-stat"><span class="health-stat-val">${nodes.length}</span> nodes</div>
      <div class="health-stat"><span class="health-stat-val">${embedded}</span> embedded</div>
      <div class="health-stat"><span class="health-stat-val">${withSummary}</span> with summary</div>
      <div class="health-stat"><span class="health-stat-val">${schema}</span> schema</div>
      ${issues.length > 0 ? `<div class="health-stat health-stat-warn"><span class="health-stat-val">${issues.length}</span> issues</div>` : '<div class="health-stat health-stat-ok">No issues</div>'}
    `;
    if (issues.length > 0) {
      const issueLabels = { empty: 'Empty (no chunks, no children)', low_chunks: 'Low content (1 chunk)', no_embedding: 'Missing embedding' };
      issuesDiv.innerHTML = issues.slice(0, 50).map(i => `
        <div class="health-issue health-issue-${i.issue}">
          <span class="health-issue-name">${escapeHtml(i.name)}</span>
          <span class="health-issue-type">${issueLabels[i.issue] || i.issue}</span>
        </div>
      `).join('') + (issues.length > 50 ? `<div class="health-issue">...and ${issues.length - 50} more</div>` : '');
    }
  } catch (err) {
    summary.innerHTML = `<span class="loading-text error">${escapeHtml(err.message)}</span>`;
  }
}

function _updateBatchToolbar() {
  const toolbar = document.getElementById('tree-batch-toolbar');
  const checked = document.querySelectorAll('.tree-node-cb:checked');
  if (!toolbar) return;
  if (checked.length > 0) {
    toolbar.classList.remove('hidden');
    document.getElementById('batch-count').textContent = `${checked.length} selected`;
    // Populate reparent dropdown with nodes not in selection
    const sel = document.getElementById('batch-reparent-select');
    const selectedIds = new Set([...checked].map(cb => cb.dataset.nodeId));
    const opts = ['<option value="">Move to...</option>', '<option value="__root__">(Root level)</option>'];
    (allNodes || []).forEach(n => {
      if (!selectedIds.has(n.node_id)) opts.push(`<option value="${n.node_id}">${escapeHtml(n.name)}</option>`);
    });
    sel.innerHTML = opts.join('');
    document.getElementById('batch-reparent-btn').disabled = !sel.value;
    sel.onchange = () => { document.getElementById('batch-reparent-btn').disabled = !sel.value; };
  } else {
    toolbar.classList.add('hidden');
  }
}

function initBatchOps() {
  document.getElementById('batch-deselect-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.tree-node-cb:checked').forEach(cb => { cb.checked = false; });
    _updateBatchToolbar();
  });
  document.getElementById('batch-delete-btn')?.addEventListener('click', batchDeleteNodes);
  document.getElementById('batch-reparent-btn')?.addEventListener('click', batchReparentNodes);
}

async function batchDeleteNodes() {
  const checked = document.querySelectorAll('.tree-node-cb:checked');
  const ids = [...checked].map(cb => cb.dataset.nodeId);
  if (!ids.length) return;
  const ok = await showConfirmModal({ title: 'Batch Delete Nodes', message: `Delete ${ids.length} node(s)? Their chunks will be re-assigned to parent nodes.`, confirmText: 'Delete', danger: true });
  if (!ok) return;
  let deleted = 0;
  for (const id of ids) {
    try {
      await api(`/nodes/${id}`, { method: 'DELETE' });
      deleted++;
    } catch (err) {
      showToast(`Failed to delete node: ${err.message}`, 'error');
    }
  }
  showToast(`Deleted ${deleted} node(s)`, 'success');
  loadTree();
}

async function batchReparentNodes() {
  const checked = document.querySelectorAll('.tree-node-cb:checked');
  const ids = [...checked].map(cb => cb.dataset.nodeId);
  const newParent = document.getElementById('batch-reparent-select').value;
  if (!ids.length || !newParent) return;
  const parentId = newParent === '__root__' ? null : newParent;
  let moved = 0;
  for (const id of ids) {
    try {
      await api(`/nodes/${id}`, { method: 'PUT', body: JSON.stringify({ parent_id: parentId }) });
      moved++;
    } catch (err) {
      showToast(`Failed to move node: ${err.message}`, 'error');
    }
  }
  showToast(`Moved ${moved} node(s)`, 'success');
  loadTree();
}

async function handleEmptyTree() {
  const ok = await showConfirmModal({ title: 'Empty Tree', message: 'This will delete ALL nodes and their content. This action cannot be undone.', confirmText: 'Empty Tree', danger: true });

  if (!ok) {
    showToast(t('empty_tree_cancelled'), 'info');
    return;
  }

  const emptyBtn = document.getElementById('empty-tree-btn');
  emptyBtn.disabled = true;

  try {
    const result = await api('/tree?confirm=yes', { method: 'DELETE' });
    showToast(`${t('empty_tree_success')}: ${result.deletedNodes} nodes, ${result.deletedChunks} chunks`, 'success');
    loadTree();
    callFn('loadDocuments');
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
    if (!data) return; // request was aborted
    treeData = data.tree || [];
    allNodes = flattenTree(treeData);
    _lazyChildrenMap.clear();

    if (!data.tree || data.tree.length === 0) {
      treeView.innerHTML = renderEmptyState(
        '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="14"/><circle cx="6" cy="19" r="3"/><line x1="12" y1="14" x2="6" y2="16"/><circle cx="18" cy="19" r="3"/><line x1="12" y1="14" x2="18" y2="16"/></svg>',
        'No nodes yet',
        'Upload documents in the Ingest tab to auto-build your knowledge tree, or create nodes manually below.',
        '<button class="btn btn-primary" onclick="document.getElementById(\'add-node-btn\').click()">+ Add Root Node</button>'
      );
      return;
    }

    // Preserve search row + content results, replace tree content only
    const searchRow = document.querySelector('.tree-search-row');
    const contentResults = document.getElementById('tree-content-results');
    const searchHtml = (searchRow ? searchRow.outerHTML : '') + (contentResults ? contentResults.outerHTML : '');
    treeView.innerHTML = searchHtml + renderTree(data.tree);
    attachTreeEvents();
    populateNodeSelects();
    // Re-init search events
    initTreeSearch();
    initTreeContentSearch();

    // Update graph/tree-diagram if currently in that view
    if (currentGraphView === 'graph') createGraph();
    else if (currentGraphView === 'tree') createTreeDiagram();
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

// Tree virtualization: lazy child rendering
// Children beyond TREE_RENDER_DEPTH are stored in _lazyChildrenMap and rendered on expand.
// [dup] const TREE_RENDER_DEPTH = 2; // render root (0) + first expanded level (1) immediately
// [dup] const _lazyChildrenMap = new Map(); // node_id -> children array

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

    // Decide whether to render children or defer them
    let childHtml = '';
    let lazyAttr = '';
    if (hasChildren) {
      if (childDepth < TREE_RENDER_DEPTH) {
        // Within render depth — render children immediately
        childHtml = renderTree(node.children, childDepth);
      } else {
        // Beyond render depth — store for lazy rendering
        _lazyChildrenMap.set(node.node_id, node.children);
        lazyAttr = ' data-lazy="1"';
      }
    }

    html += `
      <li class="tree-branch"${lazyAttr} data-branch-id="${node.node_id}">
        <div class="tree-node-item" data-node-id="${node.node_id}" draggable="true">
          <input type="checkbox" class="tree-node-cb" data-node-id="${node.node_id}" onclick="event.stopPropagation(); _updateBatchToolbar();">
          <span class="tree-toggle">${toggleSymbol}</span>
          <span class="tree-icon">${hasChildren ? '📁' : '📄'}</span>
          <span class="tree-name">${escapeHtml(node.name)}</span>
        </div>
        ${childHtml}
      </li>
    `;
  }

  html += '</ul>';
  return html;
}

/** Render lazy children for a specific node and attach events. */
function _materializeLazyChildren(branchEl, nodeId) {
  const children = _lazyChildrenMap.get(nodeId);
  if (!children) return;
  _lazyChildrenMap.delete(nodeId);
  branchEl.removeAttribute('data-lazy');

  // Render children at TREE_RENDER_DEPTH so their own children are also lazy
  const childHtml = renderTree(children, TREE_RENDER_DEPTH);
  branchEl.insertAdjacentHTML('beforeend', childHtml);

  // Attach events to newly created items
  branchEl.querySelectorAll('.tree-node-item').forEach(item => {
    if (!item._eventsAttached) _attachSingleNodeEvents(item);
  });
}

/** Force-render ALL lazy children (used before search). */
function _materializeAllLazy() {
  // Repeatedly materialize until no lazy nodes remain (handles nested lazy)
  let safety = 0;
  while (_lazyChildrenMap.size > 0 && safety++ < 50) {
    const lazyBranches = document.querySelectorAll('.tree-branch[data-lazy]');
    if (lazyBranches.length === 0) break;
    lazyBranches.forEach(branch => {
      const nodeId = branch.dataset.branchId;
      if (nodeId) _materializeLazyChildren(branch, nodeId);
    });
  }
}

function _attachSingleNodeEvents(item) {
  if (item._eventsAttached) return;
  item._eventsAttached = true;

  item.addEventListener('click', (e) => {
    // Ignore clicks on checkbox
    if (e.target.classList.contains('tree-node-cb')) return;

    const nodeId = item.dataset.nodeId;
    const toggle = item.querySelector('.tree-toggle');
    const branch = item.closest('.tree-branch');

    // Materialize lazy children on first expand — show loading spinner
    if (branch?.hasAttribute('data-lazy')) {
      toggle.classList.add('loading');
      try {
        _materializeLazyChildren(branch, nodeId);
      } finally {
        toggle.classList.remove('loading');
      }
    }

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

  // Drag-and-drop reparenting
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', item.dataset.nodeId);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  });
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    item.classList.add('drop-target');
  });
  item.addEventListener('dragleave', () => {
    item.classList.remove('drop-target');
  });
  item.addEventListener('drop', async (e) => {
    e.preventDefault();
    item.classList.remove('drop-target');
    const draggedId = e.dataTransfer.getData('text/plain');
    const targetId = item.dataset.nodeId;
    if (draggedId === targetId) return;
    try {
      const result = await api(`/nodes/${draggedId}`, {
        method: 'PUT',
        body: JSON.stringify({ parent_id: targetId })
      });
      const auditId = result?.audit_id;
      if (auditId) {
        showHtmlToast(`Node moved. <button class="toast-undo-btn" onclick="window._undoTreeOp(${auditId})">Undo</button>`, 'success');
      } else {
        showToast('Node moved', 'success');
      }
      loadTree();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function attachTreeEvents() {
  document.querySelectorAll('.tree-node-item').forEach(item => _attachSingleNodeEvents(item));
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
    if (!node) return; // aborted

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

    // Delete node button (not for root)
    const existingDelBtn = detailHeader.querySelector('.delete-node-btn');
    if (nodeId !== 'root') {
      if (!existingDelBtn) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger btn-sm delete-node-btn';
        delBtn.textContent = 'Delete Node';
        delBtn.onclick = () => handleDeleteNode(nodeId);
        detailHeader.insertBefore(delBtn, detailHeader.querySelector('.close-btn'));
      } else {
        existingDelBtn.onclick = () => handleDeleteNode(nodeId);
      }
    } else if (existingDelBtn) {
      existingDelBtn.remove();
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
              <li class="node-child-item" data-node-id="${child.node_id}" title="${escapeHtml(child.node_summary || '')}">
                <span class="node-child-icon">${child.children?.length ? '📁' : '📄'}</span>
                <span class="node-child-name">${escapeHtml(child.name)}</span>
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
              <span class="entity-name">${escapeHtml(entity.name)}</span>
              <span class="entity-type">${escapeHtml(entity.type || 'unknown')}</span>
              ${entity.mention_count > 1 ? `<span class="entity-mentions">${entity.mention_count} mentions</span>` : ''}
            </div>
            ${entity.description ? `<p class="entity-description">${escapeHtml(entity.description)}</p>` : ''}
            ${entity.aliases?.length ? `<div class="entity-aliases">Also: ${escapeHtml(entity.aliases.join(', '))}</div>` : ''}
            ${entityFacts.length > 0 ? `
              <div class="entity-facts-mini">
                ${entityFacts.map(f => `<span class="fact-mini">${escapeHtml(f.content)}</span>`).join('')}
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
              ${debugInfo.entities_with_this_node_id === 0 && debugInfo.mentions_for_node_chunks === 0 && debugInfo.total_entities_in_db > 0 ?
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
              <span class="fact-type-badge">${escapeHtml(fact.fact_type || 'fact')}</span>
              <span class="fact-confidence confidence-${confidenceClass}">${Math.round(fact.confidence * 100)}%</span>
            </div>
            <p class="fact-content">${escapeHtml(fact.content)}</p>
            ${fact.source_doc ? `<span class="fact-source">From: ${escapeHtml(fact.source_doc)}</span>` : ''}
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
          callFn('loadSchemaNodes');
        } catch (err) {
          showToast(err.message || 'Error updating node', 'error');
        }
      });
    }
    if (unflagBtn) {
      unflagBtn.addEventListener('click', async () => {
        const ok = await showConfirmModal({ title: 'Remove Schema Flag', message: 'Remove schema flag from this node?', confirmText: 'Remove', danger: true });
        if (!ok) return;
        try {
          await api(`/schema/${encodeURIComponent(unflagBtn.dataset.nodeId)}`, { method: 'DELETE' });
          showToast('Schema flag removed', 'success');
          loadNodeDetail(nodeId);
          callFn('loadSchemaNodes');
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
          callFn('loadSchemaNodes');
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

// [dup] let addChunkTargetNodeId = null;

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
  const ok = await showConfirmModal({ title: 'Delete Content', message: 'Delete this content item? This cannot be undone.', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api(`/chunks/${chunkId}`, { method: 'DELETE' });
    loadNodeDetail(nodeId);
  } catch (err) {
    showToast(err.message || 'Error deleting content', 'error');
  }
}

async function handleDeleteNode(nodeId) {
  const ok = await showConfirmModal({ title: 'Delete Node', message: 'Delete this node? Its children will be re-parented and all chunks in this node will be permanently removed.', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    const result = await api(`/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
    // Node deletes are NOT undoable (data permanently removed), so never show Undo button
    showToast(`Deleted "${result?.name || 'node'}" (${result?.chunksDeleted || 0} chunks removed, ${result?.childrenReparented || 0} children re-parented)`, 'success');
    hideNodeDetail();
    loadTree();
  } catch (err) {
    showToast(err.message || 'Error deleting node', 'error');
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


// D3.js Graph Visualization
// ============================================

function initGraphView() {
  // View toggle buttons
  const viewBtns = document.querySelectorAll('.view-btn');
  viewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      try {
        const view = btn.dataset.view;
        currentGraphView = view;

        viewBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const treeView        = document.getElementById('tree-view');
        const graphView       = document.getElementById('graph-view');
        const treeDiagramView = document.getElementById('tree-diagram-view');

        // Hide all panels then show the selected one
        if (treeView)        treeView.classList.add('hidden');
        if (graphView)       graphView.classList.add('hidden');
        if (treeDiagramView) treeDiagramView.classList.add('hidden');

        if (view === 'graph') {
          if (graphView) graphView.classList.remove('hidden');
          renderGraph();
        } else if (view === 'tree') {
          if (treeDiagramView) treeDiagramView.classList.remove('hidden');
          renderTreeDiagram();
        } else {
          if (treeView) treeView.classList.remove('hidden');
        }
      } catch (err) {
        console.error('[ArborKB] View switch error:', err);
      }
    });
  });

  // Force-graph controls
  document.getElementById('graph-zoom-in')?.addEventListener('click',  () => zoomGraph(1.2));
  document.getElementById('graph-zoom-out')?.addEventListener('click', () => zoomGraph(0.8));
  document.getElementById('graph-reset')?.addEventListener('click',    () => resetGraph());

  // Tree-diagram controls
  document.getElementById('td-zoom-in')?.addEventListener('click',  () => zoomTreeDiagram(1.2));
  document.getElementById('td-zoom-out')?.addEventListener('click', () => zoomTreeDiagram(0.8));
  document.getElementById('td-reset')?.addEventListener('click',    () => resetTreeDiagram());
}

// [dup] let graphZoom = null;
// [dup] let graphSvg = null;
// [dup] let graphG = null;

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

  // Tooltip — remove any stale tooltip from previous render
  d3.select('body').selectAll('.graph-tooltip').remove();
  const tooltip = d3.select('body').append('div')
    .attr('class', 'graph-tooltip')
    .style('opacity', 0)
    .style('position', 'absolute');

  node.on('mouseover', (event, d) => {
    tooltip.transition().duration(200).style('opacity', 1);
    tooltip.html(`
      <div class="tooltip-title">${escapeHtml(d.name)}</div>
      <div class="tooltip-info">ID: ${d.id}</div>
      <div class="tooltip-info">Level: ${d.level}</div>
      <div class="tooltip-info">Chunks: ${d.chunks}</div>
      ${d.summary ? `<div class="tooltip-info">${escapeHtml(d.summary.slice(0, 100))}...</div>` : ''}
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
// Tree Diagram View (D3 hierarchical layout)
// ============================================

// [dup] let treeDiagramZoom = null;
// [dup] let treeDiagramSvg  = null;
// [dup] let treeDiagramG    = null;

function renderTreeDiagram() {
  if (treeData.length === 0) {
    loadTree().then(() => {
      if (currentGraphView === 'tree') createTreeDiagram();
    });
  } else {
    createTreeDiagram();
  }
}

function createTreeDiagram() {
  const container = document.getElementById('tree-diagram-view');
  if (!container) return;

  treeDiagramSvg = d3.select('#tree-diagram-svg');
  treeDiagramSvg.selectAll('*').remove();

  const width  = container.clientWidth  || 960;
  const height = Math.max(container.clientHeight || 600, 500);
  treeDiagramSvg.attr('width', width).attr('height', height);

  if (!treeData.length) {
    treeDiagramSvg.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle').attr('fill', 'var(--text-secondary)')
      .text('No nodes to display');
    return;
  }

  // Wrap multiple roots in a virtual root for d3.hierarchy
  const rootData = treeData.length === 1
    ? treeData[0]
    : { node_id: '__vroot__', name: '', level: -1, node_summary: '', children: treeData };

  const root = d3.hierarchy(rootData, d => d.children?.length ? d.children : null);

  // Fixed node spacing
  const NODE_W = 100;
  const NODE_H = 70;
  d3.tree().nodeSize([NODE_W, NODE_H])(root);

  // Compute bounding box
  let minX = Infinity, maxX = -Infinity;
  root.each(d => { if (d.x < minX) minX = d.x; if (d.x > maxX) maxX = d.x; });
  const treeW = maxX - minX + NODE_W;
  const treeH = (root.height + 1) * NODE_H;

  // Fit & centre initial transform
  const scale = Math.min((width - 60) / treeW, (height - 80) / treeH, 1.4);
  const tx = width / 2 - ((minX + maxX) / 2) * scale;
  const ty = 36;

  treeDiagramG = treeDiagramSvg.append('g');

  treeDiagramZoom = d3.zoom()
    .scaleExtent([0.05, 4])
    .on('zoom', ev => treeDiagramG.attr('transform', ev.transform));

  treeDiagramSvg.call(treeDiagramZoom);
  treeDiagramSvg.call(
    treeDiagramZoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(scale)
  );

  // Links — skip edges connected to the virtual root
  const realLinks = root.links().filter(l => l.source.data.node_id !== '__vroot__');
  treeDiagramG.selectAll('.td-link')
    .data(realLinks)
    .enter().append('path')
    .attr('class', 'td-link')
    .attr('d', d3.linkVertical().x(d => d.x).y(d => d.y));

  // Nodes — skip the virtual root
  const realNodes = root.descendants().filter(d => d.data.node_id !== '__vroot__');
  const chunkMap  = new Map(allNodes.map(n => [n.node_id, n.chunk_count || 0]));

  const nodeG = treeDiagramG.selectAll('.td-node')
    .data(realNodes)
    .enter().append('g')
    .attr('class', d => `td-node level-${Math.min(d.data.level ?? 0, 3)}`)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .style('cursor', 'pointer')
    .on('click', (_, d) => loadNodeDetail(d.data.node_id));

  nodeG.append('circle')
    .attr('r', d => 10 + Math.min(chunkMap.get(d.data.node_id) * 1.5, 10));

  nodeG.append('text')
    .attr('class', 'td-label')
    .attr('dy', d => 17 + Math.min(chunkMap.get(d.data.node_id) * 1.5, 10))
    .attr('text-anchor', 'middle')
    .text(d => {
      const n = d.data.name || '';
      return n.length > 18 ? n.slice(0, 17) + '…' : n;
    });

  // Tooltip
  const tooltip = d3.select('#tree-diagram-view .td-tooltip');
  nodeG
    .on('mouseover', (event, d) => {
      const chunks  = chunkMap.get(d.data.node_id) || 0;
      const summary = d.data.node_summary || '';
      tooltip.style('display', 'block').html(
        `<strong>${escapeHtml(d.data.name)}</strong><br>` +
        `ID: ${d.data.node_id}<br>` +
        `Level: ${d.data.level ?? d.depth} · Chunks: ${chunks}` +
        (summary ? `<br><em>${escapeHtml(summary.slice(0, 100))}${summary.length > 100 ? '…' : ''}</em>` : '')
      );
    })
    .on('mousemove', event => {
      const rect = container.getBoundingClientRect();
      tooltip
        .style('left', (event.clientX - rect.left + 14) + 'px')
        .style('top',  (event.clientY - rect.top  - 10) + 'px');
    })
    .on('mouseout', () => tooltip.style('display', 'none'));

  addGraphLegend(container);
}

function zoomTreeDiagram(factor) {
  if (!treeDiagramSvg || !treeDiagramZoom) return;
  treeDiagramSvg.transition().duration(300).call(treeDiagramZoom.scaleBy, factor);
}

function resetTreeDiagram() {
  if (!treeDiagramSvg) return;
  createTreeDiagram();
}

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

// [dup-imported] function closeMobileSidebar() {
// [dup-imported]   const sidebar = document.getElementById('sidebar');
// [dup-imported]   const backdrop = document.getElementById('sidebar-backdrop');
// [dup-imported]   sidebar?.classList.remove('open');
// [dup-imported]   backdrop?.classList.remove('visible');
// [dup-imported] }

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

  // Materialize all lazy children before filtering so all nodes are searchable
  if (query) _materializeAllLazy();

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
// Tree Content Search
// ============================================

function initTreeContentSearch() {
  const input = document.getElementById('tree-content-search-input');
  if (!input) return;
  let debounceTimer = null;
  input.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchTreeContent(input.value.trim()), 300);
  });
}

async function searchTreeContent(query) {
  const resultsDiv = document.getElementById('tree-content-results');
  if (!resultsDiv) return;
  if (!query || query.length < 2) {
    resultsDiv.classList.add('hidden');
    resultsDiv.innerHTML = '';
    return;
  }
  resultsDiv.classList.remove('hidden');
  resultsDiv.innerHTML = '<span class="loading-text">Searching...</span>';
  try {
    const data = await api(`/nodes/search?q=${encodeURIComponent(query)}&limit=30`);
    if (!data.results?.length) {
      resultsDiv.innerHTML = '<span class="empty-state">No content matches found.</span>';
      return;
    }
    resultsDiv.innerHTML = data.results.map(r => `
      <div class="content-search-group">
        <div class="content-search-node" data-node-id="${escapeHtml(r.node_id)}">${escapeHtml(r.node_name)} <span class="content-search-count">(${r.chunks.length})</span></div>
        ${r.chunks.slice(0, 3).map(c => `<div class="content-search-chunk">${escapeHtml(c.preview)}</div>`).join('')}
      </div>
    `).join('');
    resultsDiv.querySelectorAll('[data-node-id]').forEach(el => {
      el.addEventListener('click', () => {
        resultsDiv.classList.add('hidden');
        document.getElementById('tree-content-search-input').value = '';
        showNodeDetail(el.dataset.nodeId);
      });
    });
  } catch (err) {
    resultsDiv.innerHTML = `<span class="loading-text error">${escapeHtml(err.message)}</span>`;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────
export { initTree, loadTree, initGraphView, initMobileSidebar, initTreeSearch, initTreeContentSearch, populateNodeSelects, allNodes };
registerFn('loadTree', loadTree);
registerFn('populateNodeSelects', populateNodeSelects);
registerFn('populateSchemaBranchSelect', populateSchemaBranchSelect);

// ── Window bindings for inline onclick handlers ──────────────────────────────
window._updateBatchToolbar = _updateBatchToolbar;

// Expose graph rendering for the fallback inline script
window._renderGraphView = function(view) {
  currentGraphView = view;
  if (view === 'graph') renderGraph();
  else if (view === 'tree') renderTreeDiagram();
};

// Undo tree operation via audit log
window._undoTreeOp = async function(auditId) {
  try {
    const res = await api(`/manage/revert/${auditId}`, { method: 'POST' });
    if (!res) return;
    if (res.success) {
      showToast(res.description || 'Operation undone', 'success');
      loadTree();
    } else {
      showToast(res.description || 'Undo failed', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Undo failed', 'error');
  }
};
