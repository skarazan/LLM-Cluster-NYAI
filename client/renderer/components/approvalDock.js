'use strict';

/**
 * Approval dock — the permission prompt that sits directly ABOVE the composer
 * (Claude Code style) instead of appearing as a question inside the model's
 * message stream.
 *
 *   const dock = getApprovalDock(document);
 *   const choice = await dock.requestTool({ toolName, args, risk, canRemember, transcript });
 *   // choice: 'once' | 'always' | 'deny'
 *   const decision = await dock.requestPlan({ planCard, transcript });
 *   // decision: 'approve' | 'reject' | 'edit:<new plan text>'
 *
 * Requests are queued FIFO; the header shows "1 of N". After a tool decision a
 * compact audit line (createDecisionRow) is appended to the transcript.
 * cancelAll() resolves everything as denied/rejected (used by Stop / New chat)
 * so an agent turn never hangs on an orphaned prompt.
 *
 * Keyboard: 1-3 pick an option, ↑/↓ move, Enter confirms, Esc denies.
 * Number keys are ignored while the user is typing in an input/textarea.
 */
const { h, clear } = require('./dom');
const { icon } = require('./icons');
const { kbd } = require('./ui');
const { describeToolRequest, buildPreview, renderPreviewInto, summariseArgs } = require('./approvalCard');
const { createDecisionRow } = require('./messages');

class ApprovalDock {
  constructor(root) {
    this.root = root;
    this.doc = root.ownerDocument;
    this.queue = [];
    this.selected = 0;
    this.mode = 'options'; // 'options' | 'editing' (plan edit)
    this.listeners = new Set();
    root.classList.add('approval-dock');
    root.hidden = true;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Permission request');
    root.addEventListener('keydown', (e) => this.onKey(e, true));
    this.doc.addEventListener('keydown', (e) => this.onKey(e, false));
  }

  /* ── public API ─────────────────────────────────────────────────────── */

  requestTool({ toolName, args = {}, risk = 'write', canRemember = true, transcript = null } = {}) {
    return this.enqueue({ kind: 'tool', toolName, args: args || {}, risk, canRemember, transcript });
  }

  requestPlan({ planCard, transcript = null } = {}) {
    return this.enqueue({ kind: 'plan', planCard, transcript });
  }

  get pending() { return this.queue.length; }

  isOpen() { return this.queue.length > 0; }

  /** Subscribe to open/close/queue changes. Returns an unsubscribe fn. */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve every pending request as denied/rejected and hide the dock. */
  cancelAll() {
    const pending = this.queue.splice(0);
    for (const req of pending) {
      if (req.kind === 'tool') {
        this.record(req, 'cancelled');
        req.resolve('deny');
      } else {
        if (req.planCard) {
          if (this.mode === 'editing') req.planCard.stopEditing({ commit: false });
          req.planCard.setStatus('cancelled');
        }
        req.resolve('reject');
      }
    }
    this.mode = 'options';
    this.selected = 0;
    this.render(false);
    this.emit();
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  enqueue(req) {
    return new Promise((resolve) => {
      req.resolve = resolve;
      this.queue.push(req);
      if (this.queue.length === 1) {
        this.selected = 0;
        this.mode = 'options';
        this.render(true);
      } else {
        this.renderQueueCount();
      }
      this.emit();
    });
  }

  emit() {
    const state = { open: this.isOpen(), pending: this.queue.length, kind: this.queue[0]?.kind || null };
    for (const fn of this.listeners) {
      try { fn(state); } catch {}
    }
  }

  options(req) {
    if (req.kind === 'tool') {
      const info = describeToolRequest(req.toolName, req.args, req.risk);
      return [
        { choice: 'once', label: 'Yes, allow once' },
        req.canRemember ? { choice: 'always', label: info.rememberLabel } : null,
        { choice: 'deny', label: 'No, deny this action', hint: 'Esc', danger: true },
      ].filter(Boolean);
    }
    if (this.mode === 'editing') {
      return [
        { choice: 'save', label: 'Save changes and execute', hint: 'Ctrl+Enter' },
        { choice: 'cancel-edit', label: 'Cancel editing', hint: 'Esc' },
      ];
    }
    return [
      { choice: 'approve', label: 'Yes, execute this plan' },
      { choice: 'edit', label: 'Edit the plan first' },
      { choice: 'reject', label: 'No, reject the plan', hint: 'Esc', danger: true },
    ];
  }

  escapeChoice(req) {
    if (req.kind === 'tool') return 'deny';
    return this.mode === 'editing' ? 'cancel-edit' : 'reject';
  }

  renderQueueCount() {
    const el = this.root.querySelector('.dock-queue');
    if (el) {
      el.textContent = this.queue.length > 1 ? `1 of ${this.queue.length}` : '';
      el.hidden = this.queue.length < 2;
    }
  }

  render(focus) {
    const root = this.root;
    const req = this.queue[0];
    clear(root);
    if (!req) {
      root.hidden = true;
      delete root.dataset.kind;
      delete root.dataset.tone;
      return;
    }
    root.hidden = false;
    root.dataset.kind = req.kind;

    let badgeIcon;
    let badgeText;
    let tone;
    let title;
    let target = '';
    let preview = null;
    let question;

    if (req.kind === 'tool') {
      const info = describeToolRequest(req.toolName, req.args, req.risk);
      badgeIcon = info.riskIcon;
      badgeText = info.riskLabel;
      tone = info.tone;
      title = info.title;
      target = info.target;
      preview = buildPreview(req.toolName, req.args);
      question = 'Allow the agent to do this?';
    } else {
      badgeIcon = 'clipboard';
      badgeText = 'Plan';
      tone = 'accent';
      title = this.mode === 'editing' ? 'Editing the proposed plan' : 'Review the proposed plan';
      question = this.mode === 'editing'
        ? 'Edit the plan in the conversation above, then save to start executing.'
        : 'The agent drafted the plan shown above. Execute it?';
    }
    root.dataset.tone = tone;

    const options = this.options(req);
    this.selected = Math.min(this.selected, options.length - 1);

    const header = h('div', { class: 'dock-header' },
      h('span', { class: ['badge', `badge-${tone}`, 'dock-badge'] }, icon(badgeIcon, { size: 12 }), h('span', { text: badgeText })),
      h('span', { class: 'dock-title', id: 'approval-dock-title', text: title }),
      h('span', { class: 'dock-queue', text: this.queue.length > 1 ? `1 of ${this.queue.length}` : '', hidden: this.queue.length < 2 }));

    const card = h('div', { class: 'dock-card', role: 'alertdialog', 'aria-labelledby': 'approval-dock-title', 'aria-describedby': 'approval-dock-question' }, header);

    if (req.kind === 'tool') {
      card.appendChild(h('div', { class: 'dock-target', title: `${req.toolName}(${summariseArgs(req.toolName, req.args)})` },
        h('code', { class: 'dock-tool', text: req.toolName }),
        target ? h('span', { class: 'dock-target-text', text: target }) : null));
      if (preview) card.appendChild(renderPreviewInto(h('pre', { class: 'dock-preview' }), preview));
    }

    const escVerb = req.kind === 'tool' ? 'deny' : this.mode === 'editing' ? 'cancel' : 'reject';
    card.appendChild(h('div', { class: 'dock-question-row' },
      h('span', { class: 'dock-question', id: 'approval-dock-question', text: question }),
      h('span', { class: 'dock-footnote', text: `↑↓ move · Enter confirm · Esc ${escVerb}` })));

    const list = h('div', { class: 'dock-options', role: 'group', 'aria-label': 'Choices' });
    options.forEach((opt, idx) => {
      const btn = h('button', {
        type: 'button',
        class: ['dock-option', idx === this.selected ? 'is-selected' : '', opt.danger ? 'is-danger' : ''],
        dataset: { choice: opt.choice, index: idx },
        'aria-keyshortcuts': String(idx + 1),
        onClick: () => this.choose(opt.choice),
        onMouseenter: () => this.select(idx, false),
        onFocus: () => this.select(idx, false),
      },
      h('span', { class: 'dock-option-caret' }, icon('chevronRight', { size: 14 })),
      kbd(String(idx + 1)),
      h('span', { class: 'dock-option-label', text: opt.label }),
      opt.hint ? h('span', { class: 'dock-option-hint' }, kbd(opt.hint)) : null);
      list.appendChild(btn);
    });
    card.appendChild(list);

    root.appendChild(card);
    if (req.kind === 'plan' && req.planCard?.el && this.mode !== 'editing') {
      try { req.planCard.el.scrollIntoView({ block: 'nearest' }); } catch {}
    }
    if (focus && !this.userIsTyping()) this.focus();
  }

  /** Move keyboard focus to the selected option (e.g. Shift+Tab from the composer). */
  focus() {
    const btn = this.root.querySelectorAll('.dock-option')[this.selected];
    if (btn) btn.focus({ preventScroll: true });
    return Boolean(btn);
  }

  /** True when the user has half-typed text in an input — never steal focus then. */
  userIsTyping() {
    const active = this.doc.activeElement;
    if (!active || this.root.contains(active)) return false;
    const editable = active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable;
    return Boolean(editable && (active.value || active.textContent || '').trim());
  }

  select(idx, focus = true) {
    const buttons = [...this.root.querySelectorAll('.dock-option')];
    if (!buttons.length) return;
    this.selected = (idx + buttons.length) % buttons.length;
    buttons.forEach((b, i) => b.classList.toggle('is-selected', i === this.selected));
    if (focus) buttons[this.selected].focus({ preventScroll: true });
  }

  choose(choice) {
    const req = this.queue[0];
    if (!req) return;
    if (req.kind === 'tool') {
      if (!['once', 'always', 'deny'].includes(choice)) return;
      if (choice === 'always' && !req.canRemember) return;
      this.queue.shift();
      this.record(req, choice);
      req.resolve(choice);
      this.advance();
      return;
    }

    const card = req.planCard;
    if (choice === 'edit') {
      this.mode = 'editing';
      this.selected = 0;
      if (card) card.startEditing();
      this.render(false);
      this.emit();
      return;
    }
    if (choice === 'cancel-edit') {
      if (card) card.stopEditing({ commit: false });
      this.mode = 'options';
      this.selected = 0;
      this.render(true);
      this.emit();
      return;
    }
    let result;
    if (choice === 'save') {
      const text = card ? card.getText() : '';
      if (card) { card.stopEditing({ commit: true }); card.setStatus('edited'); }
      result = `edit:${text}`;
    } else if (choice === 'approve') {
      if (card) card.setStatus('approved');
      result = 'approve';
    } else if (choice === 'reject') {
      if (card) card.setStatus('rejected');
      result = 'reject';
    } else {
      return;
    }
    this.queue.shift();
    req.resolve(result);
    this.advance();
  }

  advance() {
    this.mode = 'options';
    this.selected = 0;
    this.render(true);
    this.emit();
  }

  record(req, decision) {
    const transcript = req.transcript;
    if (!transcript || typeof transcript.appendChild !== 'function') return;
    const info = describeToolRequest(req.toolName, req.args, req.risk);
    transcript.appendChild(createDecisionRow({ decision, toolName: req.toolName, target: info.target }));
    transcript.scrollTop = transcript.scrollHeight;
  }

  onKey(e, fromDock) {
    const req = this.queue[0];
    if (!req || e.defaultPrevented) return;
    const active = this.doc.activeElement;
    if (!fromDock && this.root.contains(active)) return; // the dock listener already handled it

    // Plan editor lives in the transcript: support Esc / Ctrl+Enter there.
    if (req.kind === 'plan' && this.mode === 'editing' && req.planCard && active === req.planCard.editor) {
      if (e.key === 'Escape') { e.preventDefault(); this.choose('cancel-edit'); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.choose('save'); }
      return;
    }
    if (!fromDock) {
      const typing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
      if (typing) return; // never steal keystrokes from the composer
      if (active && active.closest && active.closest('.menu, .popover')) return;
    }

    const count = this.root.querySelectorAll('.dock-option').length;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.choose(this.escapeChoice(req));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.select(this.selected + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.select(this.selected - 1);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const btn = this.root.querySelectorAll('.dock-option')[this.selected];
      if (btn) this.choose(btn.dataset.choice);
    } else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const idx = Number(e.key) - 1;
      if (idx < count) {
        e.preventDefault();
        const btn = this.root.querySelectorAll('.dock-option')[idx];
        if (btn) this.choose(btn.dataset.choice);
      }
    }
  }
}

/** Singleton dock for a document, or null when the host has no #approval-dock. */
function getApprovalDock(doc = globalThis.document) {
  if (!doc || typeof doc.getElementById !== 'function') return null;
  const el = doc.getElementById('approval-dock');
  if (!el) return null;
  if (!el.__approvalDock) el.__approvalDock = new ApprovalDock(el);
  return el.__approvalDock;
}

module.exports = { ApprovalDock, getApprovalDock };
