'use strict';

/**
 * Inline SVG icon set.
 *
 * Why not emoji / unicode glyphs? Emoji and symbol glyphs (lightning bolt, pencil,
 * page, magnifier…) render with a different font on Windows (Segoe UI Emoji), macOS (Apple Color Emoji) and Linux
 * (Noto / DejaVu) — or not at all. SVG paths render pixel-identical everywhere.
 *
 * All icons: 24x24 viewBox, stroke = currentColor, 2px stroke width, round joins.
 * Usage: icon('folder', { size: 16, className: 'muted' })
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  chat: [['path', { d: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' }]],
  code: [['path', { d: 'M8 7l-5 5 5 5' }], ['path', { d: 'M16 7l5 5-5 5' }], ['path', { d: 'M13.5 4l-3 16' }]],
  plus: [['path', { d: 'M12 5v14' }], ['path', { d: 'M5 12h14' }]],
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  folderOpen: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1' }], ['path', { d: 'M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.5 12a1 1 0 0 0-1-1.3H8.2a2 2 0 0 0-1.9 1.4L4 19' }]],
  lock: [['rect', { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]],
  eye: [['path', { d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  zap: [['path', { d: 'M13 2L4 14h7l-1 8 9-12h-7z' }]],
  shield: [['path', { d: 'M12 3l8 3v6c0 5-3.5 8.5-8 9.5-4.5-1-8-4.5-8-9.5V6z' }]],
  shieldCheck: [['path', { d: 'M12 3l8 3v6c0 5-3.5 8.5-8 9.5-4.5-1-8-4.5-8-9.5V6z' }], ['path', { d: 'M9 12l2 2 4-4' }]],
  arrowUp: [['path', { d: 'M12 19V5' }], ['path', { d: 'M5 12l7-7 7 7' }]],
  stop: [['rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5, fill: 'currentColor' }]],
  chevronDown: [['path', { d: 'M6 9l6 6 6-6' }]],
  chevronUp: [['path', { d: 'M6 15l6-6 6 6' }]],
  chevronRight: [['path', { d: 'M9 6l6 6-6 6' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
  x: [['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6L6 18' }]],
  alertTriangle: [['path', { d: 'M10.3 4.2L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z' }], ['path', { d: 'M12 9.5v4' }], ['path', { d: 'M12 17h.01' }]],
  alertCircle: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7.5v5' }], ['path', { d: 'M12 16h.01' }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5' }], ['path', { d: 'M12 8h.01' }]],
  file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5' }]],
  filePlus: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5' }], ['path', { d: 'M12 11v6' }], ['path', { d: 'M9 14h6' }]],
  pencil: [['path', { d: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z' }], ['path', { d: 'M14.5 7.5l2 2' }]],
  trash: [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V4h6v3' }], ['path', { d: 'M6 7l1 13h10l1-13' }]],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4' }]],
  terminal: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M7 9l3 3-3 3' }], ['path', { d: 'M13 15h4' }]],
  listChecks: [['path', { d: 'M11 6h10' }], ['path', { d: 'M11 12h10' }], ['path', { d: 'M11 18h10' }], ['path', { d: 'M3 6l1.5 1.5L7 5' }], ['path', { d: 'M3 12l1.5 1.5L7 11' }], ['path', { d: 'M3 18l1.5 1.5L7 17' }]],
  panelRight: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M15 4v16' }]],
  copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }]],
  server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 7.5h.01' }], ['path', { d: 'M7 16.5h.01' }]],
  broadcast: [['circle', { cx: 12, cy: 12, r: 2 }], ['path', { d: 'M16.2 7.8a6 6 0 0 1 0 8.4' }], ['path', { d: 'M7.8 16.2a6 6 0 0 1 0-8.4' }], ['path', { d: 'M19 5a10 10 0 0 1 0 14' }], ['path', { d: 'M5 19A10 10 0 0 1 5 5' }]],
  activity: [['path', { d: 'M3 12h4l3-8 4 16 3-8h4' }]],
  sparkle: [['path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' }], ['path', { d: 'M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z' }]],
  clipboard: [['rect', { x: 8, y: 3, width: 8, height: 4, rx: 1 }], ['path', { d: 'M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2' }], ['path', { d: 'M8 12h8' }], ['path', { d: 'M8 16h5' }]],
  circle: [['circle', { cx: 12, cy: 12, r: 8 }]],
  circleDot: [['circle', { cx: 12, cy: 12, r: 8 }], ['circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor', stroke: 'none' }]],
  checkCircle: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l3 3 5-6' }]],
  xCircle: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9 9l6 6' }], ['path', { d: 'M15 9l-6 6' }]],
  loader: [['path', { d: 'M12 3a9 9 0 1 0 9 9' }]],
  download: [['path', { d: 'M12 4v11' }], ['path', { d: 'M7 10l5 5 5-5' }], ['path', { d: 'M5 20h14' }]],
  refresh: [['path', { d: 'M20 11a8 8 0 0 0-14.7-4.3L4 8' }], ['path', { d: 'M4 4v4h4' }], ['path', { d: 'M4 13a8 8 0 0 0 14.7 4.3L20 16' }], ['path', { d: 'M20 20v-4h-4' }]],
  cpu: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ['rect', { x: 9.5, y: 9.5, width: 5, height: 5, rx: 0.5 }], ['path', { d: 'M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3' }]],
  keyboard: [['rect', { x: 2.5, y: 6, width: 19, height: 12, rx: 2 }], ['path', { d: 'M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10' }]],
  external: [['path', { d: 'M14 4h6v6' }], ['path', { d: 'M20 4l-9 9' }], ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
};

function svgEl(tag, attrs, doc) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

/**
 * Create an SVG icon element.
 * @param {string} name   key of ICONS
 * @param {object} [opts] { size=16, className='', title, strokeWidth=1.75, document }
 */
function icon(name, opts = {}) {
  const doc = opts.document || globalThis.document;
  const size = opts.size || 16;
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': opts.strokeWidth || 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: `icon icon-${name}${opts.className ? ` ${opts.className}` : ''}`,
    'aria-hidden': opts.title ? 'false' : 'true',
    focusable: 'false',
  }, doc);
  if (opts.title) {
    const t = svgEl('title', {}, doc);
    t.textContent = opts.title;
    svg.appendChild(t);
  }
  for (const [tag, attrs] of ICONS[name] || ICONS.circle) svg.appendChild(svgEl(tag, attrs, doc));
  return svg;
}

/**
 * Brand mark: rust rounded square with three linked nodes (a "cluster").
 */
function brandMark(opts = {}) {
  const doc = opts.document || globalThis.document;
  const size = opts.size || 22;
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'brand-mark', 'aria-hidden': 'true', focusable: 'false' }, doc);
  svg.appendChild(svgEl('rect', { x: 1, y: 1, width: 22, height: 22, rx: 6, fill: 'var(--rust-500)' }, doc));
  svg.appendChild(svgEl('path', { d: 'M8 9L16 9M8 9L12 16M16 9L12 16', stroke: 'var(--brand-ink)', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }, doc));
  for (const [cx, cy] of [[8, 9], [16, 9], [12, 16]]) {
    svg.appendChild(svgEl('circle', { cx, cy, r: 3, fill: 'var(--brand-ink)' }, doc));
  }
  return svg;
}

module.exports = { icon, brandMark, ICON_NAMES: Object.keys(ICONS) };
