'use strict';

/**
 * Progress panel: renders the agent's todo list (structured items from
 * lib/agentLoop.js) as a checklist with live status and a progress bar.
 *
 * Item shape (from agentLoop): { id, title, path?, status: pending|in_progress|done|failed, error?, evidence? }
 */
const { h, clear, shortPath } = require('./dom');
const { icon } = require('./icons');

const STATUS_META = {
  pending: { icon: 'circle', label: 'Pending' },
  in_progress: { icon: 'loader', label: 'In progress' },
  done: { icon: 'checkCircle', label: 'Done' },
  failed: { icon: 'xCircle', label: 'Failed' },
};

function normalizeStatus(status) {
  return STATUS_META[status] ? status : 'pending';
}

/** Count items per status. */
function summarizeTodos(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const out = { total: list.length, done: 0, failed: 0, in_progress: 0, pending: 0 };
  for (const item of list) out[normalizeStatus(item.status)] += 1;
  out.percent = out.total ? Math.round((out.done / out.total) * 100) : 0;
  return out;
}

/**
 * Render the checklist into `container` (replaces its content).
 * @returns summary object from summarizeTodos
 */
function renderTodoPanel(container, items, { onSelectPath } = {}) {
  clear(container);
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const summary = summarizeTodos(list);

  if (!list.length) {
    container.appendChild(h('div', { class: 'panel-empty' },
      h('span', { class: 'panel-empty-icon' }, icon('listChecks', { size: 18 })),
      h('div', { class: 'panel-empty-title', text: 'No tasks yet' }),
      h('div', { class: 'panel-empty-text', text: 'When the agent starts working, each step appears here with live status.' })));
    return summary;
  }

  const label = summary.failed
    ? `${summary.done} of ${summary.total} done · ${summary.failed} failed`
    : `${summary.done} of ${summary.total} done`;
  container.appendChild(h('div', { class: 'progress-summary' },
    h('div', { class: 'progress-summary-row' },
      h('span', { class: 'progress-summary-label', text: label }),
      h('span', { class: 'progress-summary-pct', text: `${summary.percent}%` })),
    h('div', {
      class: 'progress-bar',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': String(summary.total),
      'aria-valuenow': String(summary.done),
      'aria-label': 'Task progress',
    }, h('span', { class: 'progress-bar-fill', style: { width: `${summary.percent}%` } }))));

  const ol = h('ol', { class: 'todo-list' });
  list.forEach((item, idx) => {
    const status = normalizeStatus(item.status);
    const meta = STATUS_META[status];
    const li = h('li', { class: ['todo-item', `status-${status}`], dataset: { status } },
      h('span', { class: 'todo-icon', title: meta.label, 'aria-label': meta.label, role: 'img' },
        icon(meta.icon, { size: 15, className: status === 'in_progress' ? 'spin' : '' })),
      h('div', { class: 'todo-text' },
        h('div', { class: 'todo-title', text: item.title || `Step ${item.id ?? idx + 1}` }),
        item.path ? h('button', {
          type: 'button',
          class: 'todo-path',
          title: item.path,
          text: shortPath(item.path, 3),
          onClick: () => { if (onSelectPath) onSelectPath(item.path, item); },
        }) : null,
        item.error && status === 'failed' ? h('div', { class: 'todo-error', text: String(item.error).slice(0, 240) }) : null));
    ol.appendChild(li);
  });
  container.appendChild(ol);
  return summary;
}

module.exports = { renderTodoPanel, summarizeTodos };
