'use strict';

/**
 * Tiny hyperscript helper used by every UI component.
 *
 *   h('button', { class: 'btn btn-primary', type: 'button', onClick: fn }, 'Send')
 *
 * Rules (security — the renderer runs with nodeIntegration):
 *   - Children that are strings are inserted as TEXT nodes, never parsed as HTML.
 *   - `text` prop sets textContent. There is intentionally no `html` prop.
 *   - Event props start with `on` (onClick, onKeydown, ...).
 *   - `dataset` and `style` accept plain objects.
 *   - Boolean `true` sets an empty attribute; `false`/null/undefined skip it.
 */
function h(tag, props, ...children) {
  const doc = (props && props.document) || globalThis.document;
  const el = doc.createElement(tag);
  if (props) applyProps(el, props);
  appendChildren(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'document' || value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) if (dv != null) el.dataset[dk] = String(dv);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [sk, sv] of Object.entries(value)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in el && typeof value !== 'string' && key !== 'list') {
      el[key] = value; // properties such as disabled, checked, value, tabIndex
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    el.append(typeof child === 'object' && 'nodeType' in child ? child : String(child));
  }
}

/** Remove every child node. */
function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Shorten an absolute path to its last `keep` segments (cross-platform separators). */
function shortPath(p, keep = 2) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.slice(-keep).join('/') || String(p);
}

/** Last path segment (folder or file name) for both POSIX and Windows paths. */
function baseName(p) {
  return shortPath(p, 1);
}

/** 1234 -> "1.2k" for compact token counters. */
function compactNumber(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

module.exports = { h, clear, shortPath, baseName, compactNumber };
