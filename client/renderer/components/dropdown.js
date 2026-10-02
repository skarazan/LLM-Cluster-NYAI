'use strict';

/**
 * Enhanced <select> — a custom listbox that looks identical on Windows, macOS
 * and Linux (native <select> popups are drawn by the OS on macOS and by
 * Chromium elsewhere, so they never match).
 *
 * The native <select> stays in the DOM (hidden) and remains the single source of
 * truth: read `select.value`, listen for its `change` event, and add options in
 * HTML (optgroups become section headers). Optional per-option data attributes:
 *   data-description="..."   second line in the menu
 *   data-icon="lock"         icon name from icons.js
 *   data-tone="warning"      tints the trigger when that option is selected
 *   data-short="..."         shorter trigger label
 */
const { h, clear } = require('./dom');
const { icon } = require('./icons');
const { createPopover } = require('./ui');

let uid = 0;

function readOptions(select) {
  const out = [];
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      for (const opt of child.children) out.push(optionData(opt, child.label));
    } else if (child.tagName === 'OPTION') {
      out.push(optionData(child, ''));
    }
  }
  return out;
}

function optionData(opt, group) {
  return {
    value: opt.value,
    label: opt.textContent.trim(),
    short: opt.dataset.short || '',
    description: opt.dataset.description || '',
    icon: opt.dataset.icon || '',
    tone: opt.dataset.tone || '',
    group,
    disabled: opt.disabled,
  };
}

/**
 * @param {HTMLSelectElement} select
 * @param {object} [opts] { ariaLabel, icon, className, menuClass, align: 'start'|'end',
 *                          placement: 'auto'|'top'|'bottom', hideLabelBelow }
 */
function enhanceSelect(select, opts = {}) {
  const doc = select.ownerDocument;
  const id = `dd-${++uid}`;
  select.classList.add('native-select-hidden');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const labelEl = h('span', { class: 'select-label' });
  const iconSlot = h('span', { class: 'select-icon' });
  const trigger = h('button', {
    type: 'button',
    class: ['select-trigger', opts.className],
    id: `${select.id || id}-trigger`,
    'aria-haspopup': 'listbox',
    'aria-controls': `${id}-menu`,
    'aria-label': opts.ariaLabel || select.getAttribute('aria-label') || '',
    title: opts.title || '',
  }, iconSlot, labelEl, icon('chevronDown', { size: 14, className: 'select-chevron' }));

  const menu = h('div', {
    class: ['menu', opts.menuClass],
    id: `${id}-menu`,
    role: 'listbox',
    tabIndex: -1,
    'aria-label': opts.ariaLabel || '',
  });
  const root = doc.getElementById('popover-root') || doc.body;
  root.appendChild(menu);
  select.insertAdjacentElement('afterend', trigger);

  const popover = createPopover({
    anchor: trigger,
    panel: menu,
    placement: opts.placement || 'auto',
    align: opts.align || 'start',
    onOpen: () => {
      const active = menu.querySelector('.menu-item[aria-selected="true"]') || menu.querySelector('.menu-item');
      if (active) { active.focus(); active.scrollIntoView({ block: 'nearest' }); }
    },
  });

  function current() {
    return readOptions(select).find(o => o.value === select.value) || readOptions(select)[0];
  }

  function refresh() {
    const cur = current();
    if (!cur) return;
    labelEl.textContent = cur.short || cur.label;
    trigger.title = opts.title || (cur.description ? `${cur.label} — ${cur.description}` : cur.label);
    clear(iconSlot);
    const iconName = cur.icon || opts.icon;
    if (iconName) iconSlot.appendChild(icon(iconName, { size: 14 }));
    iconSlot.hidden = !iconName;
    trigger.dataset.tone = cur.tone || '';
    trigger.dataset.value = cur.value;
    renderMenu();
  }

  function renderMenu() {
    clear(menu);
    let lastGroup = null;
    for (const o of readOptions(select)) {
      if (o.group && o.group !== lastGroup) {
        menu.appendChild(h('div', { class: 'menu-group-label', role: 'presentation', text: o.group }));
        lastGroup = o.group;
      }
      const selected = o.value === select.value;
      menu.appendChild(h('div', {
        class: ['menu-item', o.tone ? `tone-${o.tone}` : ''],
        role: 'option',
        tabIndex: -1,
        'aria-selected': selected ? 'true' : 'false',
        'aria-disabled': o.disabled ? 'true' : null,
        dataset: { value: o.value },
        onClick: () => { if (!o.disabled) choose(o.value); },
      },
      o.icon ? h('span', { class: 'menu-item-icon' }, icon(o.icon, { size: 15 })) : null,
      h('span', { class: 'menu-item-text' },
        h('span', { class: 'menu-item-label', text: o.label }),
        o.description ? h('span', { class: 'menu-item-desc', text: o.description }) : null),
      h('span', { class: 'menu-item-check' }, selected ? icon('check', { size: 14 }) : null)));
    }
  }

  function choose(value, { silent = false, focus = true } = {}) {
    const changed = select.value !== value;
    select.value = value;
    refresh();
    popover.close();
    if (focus) trigger.focus();
    if (changed && !silent) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function items() {
    return [...menu.querySelectorAll('.menu-item:not([aria-disabled="true"])')];
  }

  trigger.addEventListener('click', () => popover.toggle());
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      popover.open();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const idx = list.indexOf(doc.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (list[(idx + 1) % list.length] || list[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (list[(idx - 1 + list.length) % list.length] || list[0]).focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (idx >= 0) choose(list[idx].dataset.value);
    } else if (e.key === 'Tab') {
      popover.close();
    }
  });
  select.addEventListener('change', refresh);

  refresh();
  return {
    trigger,
    menu,
    refresh,
    open: popover.open,
    close: popover.close,
    isOpen: popover.isOpen,
    setValue: (v, o) => choose(v, { silent: true, focus: false, ...(o || {}) }),
    setDisabled: (disabled) => { trigger.disabled = Boolean(disabled); if (disabled) popover.close(); },
  };
}

module.exports = { enhanceSelect, readOptions };
