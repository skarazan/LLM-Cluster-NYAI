'use strict';

/**
 * Small, framework-free UI kit shared by every view.
 * Each factory returns a plain HTMLElement styled by styles/components.css.
 * See UI_COMPONENTS.md for the visual spec of every variant.
 */
const { h } = require('./dom');
const { icon } = require('./icons');

/**
 * Button.
 * @param {object} o { label, icon, iconRight, variant: primary|secondary|ghost|danger|subtle,
 *                     size: sm|md, title, id, className, onClick, type }
 */
function button(o = {}) {
  const variant = o.variant || 'secondary';
  const size = o.size || 'md';
  return h('button', {
    type: o.type || 'button',
    id: o.id,
    class: ['btn', `btn-${variant}`, `btn-${size}`, o.className],
    title: o.title,
    'aria-label': o.ariaLabel,
    onClick: o.onClick,
  },
  o.icon ? icon(o.icon, { size: size === 'sm' ? 14 : 16 }) : null,
  o.label ? h('span', { class: 'btn-label', text: o.label }) : null,
  o.iconRight ? icon(o.iconRight, { size: 14, className: 'btn-icon-right' }) : null);
}

/** Square icon-only button. `label` is required for screen readers + tooltip. */
function iconButton(o = {}) {
  return h('button', {
    type: 'button',
    id: o.id,
    class: ['icon-btn', o.size === 'sm' ? 'icon-btn-sm' : '', o.className],
    title: o.title || o.label,
    'aria-label': o.label,
    onClick: o.onClick,
  }, icon(o.icon, { size: o.size === 'sm' ? 14 : 16 }));
}

/** Keyboard hint, e.g. kbd('Esc'). */
function kbd(text) {
  return h('kbd', { class: 'kbd', text });
}

/** Status / risk badge. tone: neutral|accent|success|warning|danger|info */
function badge({ text, tone = 'neutral', iconName } = {}) {
  return h('span', { class: ['badge', `badge-${tone}`] },
    iconName ? icon(iconName, { size: 12 }) : null,
    h('span', { text }));
}

/**
 * Position a floating element (position: fixed) next to an anchor, flipping
 * vertically when there is not enough room and clamping to the viewport.
 */
function positionFloating(floating, anchor, { placement = 'auto', align = 'start', offset = 6, margin = 8 } = {}) {
  const win = floating.ownerDocument.defaultView;
  const a = anchor.getBoundingClientRect();
  floating.style.position = 'fixed';
  floating.style.maxHeight = '';
  floating.style.left = '0px';
  floating.style.top = '0px';
  const f = floating.getBoundingClientRect();
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const spaceBelow = vh - a.bottom - margin - offset;
  const spaceAbove = a.top - margin - offset;
  let side = placement;
  if (placement === 'auto') side = spaceBelow >= Math.min(f.height, 280) || spaceBelow >= spaceAbove ? 'bottom' : 'top';
  const avail = Math.max(120, side === 'bottom' ? spaceBelow : spaceAbove);
  const height = Math.min(f.height, avail);
  if (f.height > avail) floating.style.maxHeight = `${avail}px`;
  let left = align === 'end' ? a.right - f.width : a.left;
  left = Math.max(margin, Math.min(left, vw - f.width - margin));
  const top = side === 'bottom' ? a.bottom + offset : a.top - offset - height;
  floating.style.left = `${Math.round(left)}px`;
  floating.style.top = `${Math.round(Math.max(margin, top))}px`;
  floating.dataset.side = side;
  return side;
}

/**
 * Controller for a popover panel anchored to a trigger button.
 * Handles outside clicks, Escape, focus return and viewport changes.
 */
function createPopover({ anchor, panel, placement = 'auto', align = 'start', onOpen, onClose }) {
  const doc = anchor.ownerDocument;
  const win = doc.defaultView;
  let open = false;

  const reposition = () => { if (open) positionFloating(panel, anchor, { placement, align }); };
  const onPointerDown = (e) => {
    if (!open) return;
    if (panel.contains(e.target) || anchor.contains(e.target)) return;
    close();
  };
  const onKey = (e) => {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus();
    }
  };

  function show() {
    if (open) return;
    open = true;
    panel.hidden = false;
    panel.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    reposition();
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('keydown', onKey, true);
    win.addEventListener('resize', reposition);
    if (onOpen) onOpen();
  }

  function close() {
    if (!open) return;
    open = false;
    panel.classList.remove('is-open');
    panel.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKey, true);
    win.removeEventListener('resize', reposition);
    if (onClose) onClose();
  }

  anchor.setAttribute('aria-expanded', 'false');
  panel.hidden = true;
  return {
    open: show,
    close,
    toggle: () => (open ? close() : show()),
    isOpen: () => open,
    reposition,
  };
}

/** Auto-grow a textarea between its CSS min-height and `maxPx`. */
function autoGrow(textarea, maxPx = 280) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxPx)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxPx ? 'auto' : 'hidden';
  };
  textarea.addEventListener('input', resize);
  resize();
  return resize;
}

module.exports = { button, iconButton, kbd, badge, positionFloating, createPopover, autoGrow };
