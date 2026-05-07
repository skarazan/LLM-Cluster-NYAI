'use strict';

/**
 * Build an approval card DOM node (no jQuery/framework).
 * Reuses existing .bubble, .bubble-body, .bubble-meta CSS.
 *
 * @param {object} opts
 *   - toolName {string}
 *   - args {object}
 *   - risk {string} "read"|"write"|"shell"
 *   - onApprove {function}
 *   - onApproveRemember {function}
 *   - onReject {function}
 *   - canRemember {boolean} — false for delete_file, run_shell, etc.
 * @returns {HTMLElement}
 */
function buildApprovalCard({ toolName, args, risk, onApprove, onApproveRemember, onReject, canRemember = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble approval';

  // Header
  const icon  = risk === 'shell' ? '⚡' : risk === 'write' ? '✏️' : '📄';
  const label = risk === 'shell' ? 'run a command'
              : risk === 'write' ? 'modify the filesystem'
              : 'read files';

  const header = document.createElement('div');
  header.className = 'approval-header';
  header.innerHTML = `<span class="approval-icon">${icon}</span><span>AI wants to <strong>${label}</strong></span>`;
  wrap.appendChild(header);

  // Tool name + key args
  const meta = document.createElement('div');
  meta.className = 'bubble-meta approval-meta';
  meta.textContent = `${toolName}(${summariseArgs(toolName, args)})`;
  wrap.appendChild(meta);

  // Diff / preview block
  const preview = buildPreview(toolName, args);
  if (preview) {
    const pre = document.createElement('pre');
    pre.className = 'approval-preview';
    pre.textContent = preview;
    wrap.appendChild(pre);
  }

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'approval-actions';

  const btnApprove = document.createElement('button');
  btnApprove.className = 'approval-btn approve';
  btnApprove.textContent = 'Approve';
  btnApprove.addEventListener('click', () => { lockCard(wrap); onApprove(); });

  const btnReject = document.createElement('button');
  btnReject.className = 'approval-btn reject';
  btnReject.textContent = 'Reject';
  btnReject.addEventListener('click', () => { lockCard(wrap); onReject(); });

  actions.appendChild(btnApprove);

  if (canRemember) {
    const btnRemember = document.createElement('button');
    btnRemember.className = 'approval-btn remember';
    btnRemember.textContent = 'Approve + remember';
    btnRemember.addEventListener('click', () => { lockCard(wrap); onApproveRemember(); });
    actions.appendChild(btnRemember);
  }

  actions.appendChild(btnReject);
  wrap.appendChild(actions);

  return wrap;
}

function lockCard(wrap) {
  wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
}

function summariseArgs(toolName, args) {
  if (toolName === 'read_file')  return `"${args.path}"`;
  if (toolName === 'list_dir')   return `"${args.path}"`;
  if (toolName === 'glob')       return `"${args.pattern}"`;
  if (toolName === 'grep')       return `"${args.pattern}"${args.path ? `, "${args.path}"` : ''}`;
  if (toolName === 'write_file') return `"${args.path}"`;
  if (toolName === 'edit_file')  return `"${args.path}"`;
  if (toolName === 'create_dir') return `"${args.path}"`;
  if (toolName === 'delete_file') return `"${args.path}"`;
  if (toolName === 'run_shell')  return `${args.cmd}${args.args ? ' ' + args.args.join(' ') : ''}`;
  return JSON.stringify(args).slice(0, 80);
}

function buildPreview(toolName, args) {
  if (toolName === 'edit_file') {
    const old = (args.old_string || '').split('\n').map(l => `- ${l}`).join('\n');
    const neu = (args.new_string || '').split('\n').map(l => `+ ${l}`).join('\n');
    return `${old}\n${neu}`;
  }
  if (toolName === 'write_file') {
    const lines = (args.content || '').split('\n');
    const preview = lines.slice(0, 8).map(l => `+ ${l}`).join('\n');
    return lines.length > 8 ? preview + `\n+ … (${lines.length} lines total)` : preview;
  }
  if (toolName === 'run_shell') {
    return `$ ${args.cmd}${args.args ? ' ' + args.args.join(' ') : ''}`;
  }
  return null;
}

module.exports = { buildApprovalCard };
