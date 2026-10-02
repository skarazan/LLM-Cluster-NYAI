'use strict';

/**
 * Permission-request helpers shared by the approval dock (approvalDock.js) and
 * the legacy inline card.
 *
 * The primary UX is the docked prompt above the composer (approvalDock.js).
 * buildApprovalCard() is kept as a fallback for hosts that have no
 * #approval-dock element (e.g. a future secondary window).
 */
const { h, shortPath } = require('./dom');
const { icon } = require('./icons');

const RISK_META = {
  read: { label: 'Read', icon: 'eye', tone: 'info' },
  write: { label: 'Edit', icon: 'pencil', tone: 'accent' },
  shell: { label: 'Command', icon: 'terminal', tone: 'warning' },
  delete: { label: 'Delete', icon: 'trash', tone: 'danger' },
};

function shellLine(args = {}) {
  return `${args.cmd || ''}${Array.isArray(args.args) && args.args.length ? ` ${args.args.join(' ')}` : ''}`.trim();
}

/** Short inline summary used in titles/tooltips: read_file("a/b.js"). */
function summariseArgs(toolName, args = {}) {
  if (toolName === 'read_file') return `"${args.path}"`;
  if (toolName === 'list_dir') return `"${args.path || '.'}"`;
  if (toolName === 'glob') return `"${args.pattern}"`;
  if (toolName === 'grep') return `"${args.pattern}"${args.path ? `, "${args.path}"` : ''}`;
  if (toolName === 'write_file') return `"${args.path}"`;
  if (toolName === 'append_file') return `"${args.path}"`;
  if (toolName === 'edit_file') return `"${args.path}"`;
  if (toolName === 'replace_file_range') return `"${args.path}", lines ${args.start_line}-${args.end_line}`;
  if (toolName === 'create_dir') return `"${args.path}"`;
  if (toolName === 'delete_file') return `"${args.path}"`;
  if (toolName === 'run_shell') return shellLine(args);
  return JSON.stringify(args || {}).slice(0, 80);
}

/** Diff-style preview text (lines prefixed with "+ ", "- ", "@@", "$"). */
function buildPreview(toolName, args = {}) {
  if (toolName === 'edit_file') {
    const old = String(args.old_string || '').split('\n').map(l => `- ${l}`).join('\n');
    const neu = String(args.new_string || '').split('\n').map(l => `+ ${l}`).join('\n');
    return `${old}\n${neu}`;
  }
  if (toolName === 'write_file' || toolName === 'append_file') {
    const lines = String(args.content || '').split('\n');
    const preview = lines.slice(0, 8).map(l => `+ ${l}`).join('\n');
    return lines.length > 8 ? `${preview}\n+ … (${lines.length} lines total)` : preview;
  }
  if (toolName === 'replace_file_range') {
    const lines = String(args.content || '').split('\n');
    const preview = lines.slice(0, 12).map(l => `+ ${l}`).join('\n');
    return `@@ ${args.start_line}-${args.end_line} @@\n${lines.length > 12 ? `${preview}\n+ … (${lines.length} lines total)` : preview}`;
  }
  if (toolName === 'run_shell') return `$ ${shellLine(args)}`;
  return null;
}

/** The key the agent loop stores in `remembered` for "always allow". */
function rememberTarget(args = {}) {
  return args.path || args.root || args.cwd || '';
}

/**
 * Human-readable description of a tool request for the permission prompt.
 * @returns {{ title, target, risk, riskLabel, riskIcon, tone, rememberLabel }}
 */
function describeToolRequest(toolName, args = {}, risk = 'write') {
  const a = args || {};
  let title;
  let target = a.path || '';
  switch (toolName) {
    case 'read_file': title = 'Read a file'; break;
    case 'read_many_files': title = `Read ${(a.paths || []).length} files`; target = (a.paths || []).map(p => shortPath(p)).join(', '); break;
    case 'file_state': title = 'Check file state'; target = a.path || (a.paths || []).map(p => shortPath(p)).join(', '); break;
    case 'inspect_project': title = 'Inspect the project structure'; target = ''; break;
    case 'list_dir': title = 'List a folder'; target = a.path || 'workspace root'; break;
    case 'glob': title = 'Find files by pattern'; target = a.pattern || ''; break;
    case 'grep': title = 'Search file contents'; target = `"${a.pattern || ''}"${a.path ? ` in ${a.path}` : ''}`; break;
    case 'write_file': title = 'Write a file'; break;
    case 'append_file': title = 'Append to a file'; break;
    case 'edit_file': title = 'Edit a file'; break;
    case 'replace_file_range': title = `Replace lines ${a.start_line}–${a.end_line}`; break;
    case 'create_dir': title = 'Create a folder'; break;
    case 'delete_file': title = 'Delete a file'; break;
    case 'run_shell': title = 'Run a shell command'; target = shellLine(a); break;
    default: title = `Use ${toolName}`; target = target || summariseArgs(toolName, a);
  }
  const riskKey = toolName === 'delete_file' ? 'delete' : (RISK_META[risk] ? risk : 'write');
  const meta = RISK_META[riskKey];
  const remember = rememberTarget(a);
  const rememberLabel = remember
    ? `Yes, and don't ask again for ${toolName} on ${shortPath(remember)} this session`
    : `Yes, and don't ask again for ${toolName} this session`;
  return { title, target, risk: riskKey, riskLabel: meta.label, riskIcon: meta.icon, tone: meta.tone, rememberLabel };
}

/** Render preview text into a <pre> with per-line diff classes (text nodes only). */
function renderPreviewInto(pre, previewText) {
  pre.textContent = '';
  for (const line of String(previewText || '').split('\n')) {
    let cls = 'diff-line';
    if (line.startsWith('+')) cls += ' diff-add';
    else if (line.startsWith('-')) cls += ' diff-del';
    else if (line.startsWith('@@')) cls += ' diff-hunk';
    else if (line.startsWith('$')) cls += ' diff-cmd';
    pre.appendChild(h('span', { class: cls, text: line }));
  }
  return pre;
}

/**
 * Legacy inline approval card (fallback only).
 * @param {object} opts { toolName, args, risk, onApprove, onApproveRemember, onReject, canRemember }
 */
function buildApprovalCard({ toolName, args, risk, onApprove, onApproveRemember, onReject, canRemember = true }) {
  const info = describeToolRequest(toolName, args, risk);
  const wrap = h('div', { class: ['bubble', 'approval', `risk-${info.risk}`] });
  wrap.appendChild(h('div', { class: 'approval-header' },
    h('span', { class: 'approval-icon' }, icon(info.riskIcon, { size: 15 })),
    h('span', { text: `Agent wants to: ${info.title}` })));
  wrap.appendChild(h('div', { class: 'bubble-meta approval-meta', text: `${toolName}(${summariseArgs(toolName, args)})` }));

  const preview = buildPreview(toolName, args);
  if (preview) wrap.appendChild(renderPreviewInto(h('pre', { class: 'approval-preview' }), preview));

  const lock = () => wrap.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const actions = h('div', { class: 'approval-actions' });
  actions.appendChild(h('button', { type: 'button', class: 'approval-btn approve', text: 'Approve', onClick: () => { lock(); onApprove(); } }));
  if (canRemember) {
    actions.appendChild(h('button', { type: 'button', class: 'approval-btn remember', text: 'Always Allow', onClick: () => { lock(); onApproveRemember(); } }));
  }
  actions.appendChild(h('button', { type: 'button', class: 'approval-btn reject', text: 'Reject', onClick: () => { lock(); onReject(); } }));
  wrap.appendChild(actions);
  return wrap;
}

module.exports = {
  buildApprovalCard,
  summariseArgs,
  buildPreview,
  describeToolRequest,
  renderPreviewInto,
  rememberTarget,
  RISK_META,
};
