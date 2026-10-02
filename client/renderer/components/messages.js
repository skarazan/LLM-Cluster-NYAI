'use strict';

/**
 * Transcript building blocks. Every element appended to #chat comes from here
 * (renderer.js and lib/agentLoop.js both use these factories) so the
 * conversation looks the same no matter which code path produced it.
 */
const { h, shortPath } = require('./dom');
const { icon } = require('./icons');
const { renderMarkdown } = require('./markdown');

const ROLE_ICONS = { error: 'alertCircle', notice: 'info' };

/**
 * Message bubble.
 * roles: user | assistant | error | notice
 * Assistant text is rendered as (safe) Markdown; everything else is plain text.
 */
function createMessage({ role = 'assistant', text = '', meta = '', onLink, onCopy } = {}) {
  const wrap = h('div', { class: ['bubble', role] });
  if (ROLE_ICONS[role]) wrap.appendChild(h('span', { class: 'bubble-icon' }, icon(ROLE_ICONS[role], { size: 16 })));

  const body = h('div', { class: 'bubble-body' });
  if (role === 'assistant') {
    body.classList.add('markdown');
    body.appendChild(renderMarkdown(String(text || ''), { onLink, onCopy }));
  } else {
    body.textContent = String(text || '');
  }
  wrap.appendChild(body);

  if (meta || (role === 'assistant' && text)) {
    const metaRow = h('div', { class: 'bubble-meta' });
    if (meta) metaRow.appendChild(h('span', { class: 'bubble-meta-text', text: meta }));
    if (role === 'assistant' && text) {
      const copyBtn = h('button', {
        type: 'button',
        class: 'bubble-action',
        title: 'Copy response',
        'aria-label': 'Copy response',
        onClick: () => {
          const fn = onCopy || ((t) => globalThis.navigator?.clipboard?.writeText(t));
          Promise.resolve(fn(String(text))).finally(() => {
            copyBtn.classList.add('is-done');
            setTimeout(() => copyBtn.classList.remove('is-done'), 1200);
          });
        },
      }, icon('copy', { size: 13 }), h('span', { text: 'Copy' }));
      metaRow.appendChild(copyBtn);
    }
    wrap.appendChild(metaRow);
  }
  return wrap;
}

/** Animated "Thinking…" placeholder (keeps the legacy .bubble.assistant.loading classes). */
function createTypingIndicator(label = 'Thinking') {
  return h('div', { class: 'bubble assistant loading', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'bubble-body' },
      h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('span', { class: 'typing-label', text: label })));
}

/** Collapsible reasoning block for <think>/<thinking>/<reasoning> output. */
function createThinkingBlock(text, { open = false } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const content = h('div', { class: ['thinking-content', open ? 'open' : ''], text: text || '' });
  const toggle = h('button', {
    type: 'button',
    class: ['thinking-toggle', open ? 'open' : ''],
    'aria-expanded': open ? 'true' : 'false',
  },
  icon('chevronRight', { size: 13, className: 'thinking-chevron' }),
  h('span', { class: 'thinking-label', text: 'Thought process' }),
  h('span', { class: 'thinking-meta', text: `${words} word${words === 1 ? '' : 's'}` }));
  toggle.addEventListener('click', () => {
    const isOpen = toggle.classList.toggle('open');
    content.classList.toggle('open', isOpen);
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });
  return h('div', { class: 'thinking-block' }, toggle, content);
}

function activityIconName(kind, status) {
  if (status === 'error') return 'alertCircle';
  if (kind === 'write') return 'filePlus';
  if (kind === 'edit') return 'pencil';
  if (kind === 'read') return 'file';
  if (kind === 'shell') return 'terminal';
  if (kind === 'dir') return 'folder';
  return 'activity';
}

function looksLikePath(s) {
  return /[\\/]/.test(String(s || '')) && !/\s{2,}/.test(String(s || ''));
}

/** Compact, clickable tool-activity line (details open in the side panel). */
function createActivityRow({ kind = 'info', status = 'info', title = 'Activity', subtitle = '', onSelect } = {}) {
  const isPath = subtitle && looksLikePath(subtitle);
  const sub = isPath ? shortPath(subtitle, 3) : subtitle;
  // Hide the subtitle when the title already names the same file ("Created src/app.js").
  const redundant = !sub || String(title || '').includes(isPath ? shortPath(subtitle, 2) : sub);
  const row = h('button', {
    type: 'button',
    class: ['activity-row', kind, status],
    title: subtitle || title,
  },
  h('span', { class: 'activity-icon' }, icon(activityIconName(kind, status), { size: 14 })),
  h('span', { class: 'activity-title', text: title || 'Activity' }),
  redundant ? null : h('span', { class: 'activity-subtitle', text: sub }),
  icon('chevronRight', { size: 13, className: 'activity-chevron' }));
  if (onSelect) row.addEventListener('click', () => onSelect(row));
  return row;
}

const DECISION_COPY = {
  once: { label: 'Allowed once', icon: 'check' },
  always: { label: 'Always allowed', icon: 'shieldCheck' },
  deny: { label: 'Denied', icon: 'x' },
  cancelled: { label: 'Cancelled', icon: 'x' },
};

/** Audit line left in the transcript after the user answers a permission request. */
function createDecisionRow({ decision = 'once', toolName = '', target = '' } = {}) {
  const copy = DECISION_COPY[decision] || DECISION_COPY.once;
  return h('div', { class: ['decision-row', `decision-${decision}`], role: 'note' },
    h('span', { class: 'decision-icon' }, icon(copy.icon, { size: 13 })),
    h('span', { class: 'decision-label', text: copy.label }),
    toolName ? h('code', { class: 'decision-tool', text: toolName }) : null,
    target ? h('span', { class: 'decision-target', title: target, text: looksLikePath(target) ? shortPath(target, 3) : target }) : null);
}

const PLAN_STATUS = {
  pending: { text: 'Awaiting approval', tone: 'accent' },
  editing: { text: 'Editing', tone: 'warning' },
  approved: { text: 'Approved', tone: 'success' },
  edited: { text: 'Edited & approved', tone: 'success' },
  rejected: { text: 'Rejected', tone: 'danger' },
  cancelled: { text: 'Cancelled', tone: 'neutral' },
};

/** Proposed-plan document shown in the transcript while the dock asks for a decision. */
function createPlanCard(planText, { onLink } = {}) {
  let text = String(planText || '');
  const status = h('span', { class: 'badge badge-accent plan-status' });
  const body = h('div', { class: 'plan-body markdown' });
  const editor = h('textarea', { class: 'plan-editor', spellcheck: false, 'aria-label': 'Edit plan' });
  editor.hidden = true;
  const el = h('div', { class: 'plan-card' },
    h('div', { class: 'plan-card-header' },
      h('span', { class: 'plan-card-icon' }, icon('clipboard', { size: 15 })),
      h('span', { class: 'plan-card-title', text: 'Proposed plan' }),
      status),
    body,
    editor);

  const renderBody = () => {
    body.textContent = '';
    body.appendChild(renderMarkdown(text, { onLink }));
  };
  const setStatus = (key) => {
    const s = PLAN_STATUS[key] || PLAN_STATUS.pending;
    status.textContent = s.text;
    status.className = `badge badge-${s.tone} plan-status`;
    el.dataset.status = key;
  };

  renderBody();
  setStatus('pending');
  return {
    el,
    editor,
    getText: () => (editor.hidden ? text : editor.value),
    startEditing() {
      editor.value = text;
      editor.hidden = false;
      body.hidden = true;
      el.classList.add('is-editing');
      setStatus('editing');
      editor.style.height = 'auto';
      editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 160), 420)}px`;
      editor.focus();
    },
    stopEditing({ commit = false } = {}) {
      if (commit) text = editor.value;
      editor.hidden = true;
      body.hidden = false;
      el.classList.remove('is-editing');
      renderBody();
      setStatus('pending');
    },
    setStatus,
  };
}

module.exports = {
  createMessage,
  createTypingIndicator,
  createThinkingBlock,
  createActivityRow,
  createDecisionRow,
  createPlanCard,
  activityIconName,
};
