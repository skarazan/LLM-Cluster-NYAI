'use strict';

/**
 * Minimal, safe Markdown renderer for model output.
 *
 * - parseMarkdown(text)  -> AST (pure JS, no DOM; unit-testable in Node)
 * - renderMarkdown(text, opts) -> DocumentFragment built with createElement/textContent
 *
 * SECURITY: the renderer process runs with nodeIntegration, so model output must
 * never reach innerHTML. Every string ends up in a text node; links are only
 * created for http(s)/mailto URLs and are opened externally through the main
 * process (see opts.onLink).
 *
 * Supported: fenced code (``` / ~~~, unclosed fences while streaming), ATX
 * headings, paragraphs with soft line breaks, ordered/unordered/task lists
 * (nested by indentation), blockquotes, horizontal rules, GFM tables, inline
 * code, **strong**, *em*, ~~strike~~, [links](https://...), bare URLs.
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP_RE = /^ *\|? *:?-{1,}:? *(\| *:?-{1,}:? *)*\|? *$/;
const SAFE_URL_RE = /^(https?:\/\/|mailto:)/i;

function indentWidth(s) {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

function stripIndent(line, n) {
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < n) {
    if (line[i] === ' ') removed += 1;
    else if (line[i] === '\t') removed += 4 - (removed % 4);
    else break;
    i += 1;
  }
  return line.slice(i);
}

function isBlank(line) {
  return /^\s*$/.test(line);
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line) {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line)
    || QUOTE_RE.test(line) || LIST_RE.test(line);
}

function parseMarkdown(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    // Fenced code
    let m = line.match(FENCE_RE);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      const fence = m[1];
      const lang = m[2].trim().split(/\s+/)[0] || '';
      const body = [];
      let closed = false;
      i++;
      while (i < lines.length) {
        const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      if (!closed) while (body.length && isBlank(body[body.length - 1])) body.pop();
      blocks.push({ type: 'code', lang, text: body.join('\n'), closed });
      continue;
    }

    // Heading
    m = line.match(HEADING_RE);
    if (m) {
      blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2] || '') });
      i++;
      continue;
    }

    // Horizontal rule (checked before lists so "---" / "* * *" are rules)
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].match(QUOTE_RE)[1]);
        i++;
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner) });
      continue;
    }

    // GFM table
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const width = header.length;
      blocks.push({
        type: 'table',
        align: header.map((_, idx) => align[idx] || null),
        header: header.map(cell => parseInline(cell)),
        rows: rows.map(row => Array.from({ length: width }, (_, idx) => parseInline(row[idx] || ''))),
      });
      continue;
    }

    // List
    m = line.match(LIST_RE);
    if (m) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    // Paragraph: gather until a blank line or another block starts
    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-'))) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return blocks;
}

function parseList(lines, start) {
  const first = lines[start].match(LIST_RE);
  const baseIndent = indentWidth(first[1]);
  const ordered = /\d/.test(first[2]);
  const block = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : null, items: [] };
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(LIST_RE);
    if (!m || indentWidth(m[1]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = baseIndent + m[2].length + 1;
    const itemLines = [m[3]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        // Blank line: continue the item only if the next non-blank line is indented into it.
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentWidth(lines[j]) >= Math.min(contentIndent, baseIndent + 2)) {
          for (let k = i; k < j; k++) itemLines.push('');
          i = j;
          continue;
        }
        break;
      }
      const ind = indentWidth(line);
      const sub = line.match(LIST_RE);
      if (sub && indentWidth(sub[1]) <= baseIndent) break; // sibling or parent item
      if (ind > baseIndent) {
        itemLines.push(stripIndent(line, Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      if (startsBlock(line)) break;
      itemLines.push(line.trim()); // lazy continuation
      i++;
    }

    let checked = null;
    const task = itemLines[0].match(/^\[([ xX])\][ \t]+(.*)$/);
    if (task) {
      checked = task[1].toLowerCase() === 'x';
      itemLines[0] = task[2];
    }
    block.items.push({ checked, children: parseBlocks(itemLines) });

    // Allow a single blank line between sibling items.
    if (i < lines.length && isBlank(lines[i])) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      const next = j < lines.length ? lines[j].match(LIST_RE) : null;
      if (next && indentWidth(next[1]) === baseIndent && /\d/.test(next[2]) === ordered) {
        i = j;
        continue;
      }
      break;
    }
  }
  return { block, next: i };
}

function findClosing(src, delim, from) {
  let idx = from;
  while (idx < src.length) {
    const pos = src.indexOf(delim, idx);
    if (pos === -1) return -1;
    if (src[pos - 1] === '\\') { idx = pos + 1; continue; }
    if (/\s/.test(src[pos - 1] || '')) { idx = pos + delim.length; continue; }
    // For single-char delimiters, skip doubled runs (they belong to strong).
    if (delim.length === 1 && src[pos + 1] === delim) { idx = pos + 2; continue; }
    return pos;
  }
  return -1;
}

function parseInline(src) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) { out.push({ type: 'text', value: buf }); buf = ''; }
  };
  const s = String(src || '');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];

    if (ch === '\\' && next && /[\\`*_{}[\]()#+\-.!~|>]/.test(next)) {
      buf += next;
      i += 2;
      continue;
    }

    if (ch === '\n') {
      flush();
      out.push({ type: 'br' });
      i++;
      continue;
    }

    if (ch === '`') {
      const run = s.slice(i).match(/^`+/)[0];
      const close = s.indexOf(run, i + run.length);
      if (close !== -1) {
        flush();
        let code = s.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push({ type: 'code', value: code });
        i = close + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }

    if (ch === '[') {
      const m = s.slice(i).match(/^\[((?:[^\][\n]|\[[^\][\n]*\])*)\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"]*")?\s*\)/);
      if (m) {
        flush();
        out.push({ type: 'link', href: m[2], children: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    if (ch === 'h' && (i === 0 || /[\s(]/.test(s[i - 1])) && /^https?:\/\//i.test(s.slice(i, i + 8))) {
      const m = s.slice(i).match(/^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"\]*_]/i);
      if (m) {
        flush();
        out.push({ type: 'link', href: m[0], children: [{ type: 'text', value: m[0] }] });
        i += m[0].length;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && next === ch && s[i + 2] && !/\s/.test(s[i + 2])) {
      const intraword = ch === '_' && i > 0 && /\w/.test(s[i - 1]);
      const close = intraword ? -1 : findClosing(s, ch + ch, i + 2);
      if (close !== -1) {
        flush();
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (ch === '~' && next === '~' && s[i + 2] && !/\s/.test(s[i + 2])) {
      const close = findClosing(s, '~~', i + 2);
      if (close !== -1) {
        flush();
        out.push({ type: 'del', children: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && next && !/\s/.test(next) && next !== ch) {
      const intraword = ch === '_' && i > 0 && /\w/.test(s[i - 1]);
      let close = intraword ? -1 : findClosing(s, ch, i + 1);
      if (close !== -1 && ch === '_' && /\w/.test(s[close + 1] || '')) close = -1;
      if (close !== -1) {
        flush();
        out.push({ type: 'em', children: parseInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

function isSafeUrl(href) {
  return SAFE_URL_RE.test(String(href || '').trim());
}

/* ── DOM rendering ─────────────────────────────────────────────────────── */

function renderMarkdown(text, opts = {}) {
  const doc = opts.document || globalThis.document;
  const frag = doc.createDocumentFragment();
  for (const block of parseMarkdown(text)) frag.appendChild(renderBlock(block, doc, opts));
  return frag;
}

function el(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function renderBlock(block, doc, opts) {
  switch (block.type) {
    case 'heading': {
      const node = el(doc, `h${Math.min(6, Math.max(1, block.level))}`, `md-h md-h${block.level}`);
      renderInlines(node, block.children, doc, opts);
      return node;
    }
    case 'paragraph': {
      const node = el(doc, 'p', 'md-p');
      renderInlines(node, block.children, doc, opts);
      return node;
    }
    case 'code':
      return renderCodeBlock(block, doc, opts);
    case 'hr':
      return el(doc, 'hr', 'md-hr');
    case 'blockquote': {
      const node = el(doc, 'blockquote', 'md-quote');
      for (const child of block.children) node.appendChild(renderBlock(child, doc, opts));
      return node;
    }
    case 'list': {
      const node = el(doc, block.ordered ? 'ol' : 'ul', 'md-list');
      if (block.ordered && block.start != null && block.start !== 1) node.setAttribute('start', String(block.start));
      for (const item of block.items) {
        const li = el(doc, 'li', item.checked == null ? 'md-li' : `md-li md-task${item.checked ? ' is-checked' : ''}`);
        if (item.checked != null) {
          const box = el(doc, 'span', 'md-task-box');
          box.setAttribute('role', 'img');
          box.setAttribute('aria-label', item.checked ? 'done' : 'not done');
          li.appendChild(box);
        }
        const tight = item.children.length === 1 && item.children[0].type === 'paragraph';
        if (tight) {
          const span = el(doc, 'span', 'md-li-text');
          renderInlines(span, item.children[0].children, doc, opts);
          li.appendChild(span);
        } else {
          for (const child of item.children) li.appendChild(renderBlock(child, doc, opts));
        }
        node.appendChild(li);
      }
      return node;
    }
    case 'table': {
      const wrap = el(doc, 'div', 'md-table-wrap');
      const table = el(doc, 'table', 'md-table');
      const thead = el(doc, 'thead');
      const hr = el(doc, 'tr');
      block.header.forEach((cell, idx) => {
        const th = el(doc, 'th');
        if (block.align[idx]) th.style.textAlign = block.align[idx];
        renderInlines(th, cell, doc, opts);
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el(doc, 'tbody');
      for (const row of block.rows) {
        const tr = el(doc, 'tr');
        row.forEach((cell, idx) => {
          const td = el(doc, 'td');
          if (block.align[idx]) td.style.textAlign = block.align[idx];
          renderInlines(td, cell, doc, opts);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      return wrap;
    }
    default: {
      const node = el(doc, 'p', 'md-p');
      node.textContent = '';
      return node;
    }
  }
}

function renderCodeBlock(block, doc, opts) {
  const wrap = el(doc, 'div', 'md-code');
  const header = el(doc, 'div', 'md-code-header');
  const lang = el(doc, 'span', 'md-code-lang');
  lang.textContent = block.lang || 'text';
  header.appendChild(lang);
  const copy = el(doc, 'button', 'md-code-copy');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', 'Copy code');
  copy.addEventListener('click', () => {
    const done = () => {
      copy.textContent = 'Copied';
      copy.classList.add('is-copied');
      setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('is-copied'); }, 1400);
    };
    const fn = opts.onCopy || defaultCopy;
    Promise.resolve(fn(block.text)).then(done, done);
  });
  header.appendChild(copy);
  wrap.appendChild(header);
  const pre = el(doc, 'pre', 'md-pre');
  const code = el(doc, 'code', block.lang ? `language-${block.lang.replace(/[^\w+#-]/g, '')}` : '');
  code.textContent = block.text;
  pre.appendChild(code);
  wrap.appendChild(pre);
  return wrap;
}

function defaultCopy(text) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) return globalThis.navigator.clipboard.writeText(text);
  } catch {}
  try {
    // eslint-disable-next-line global-require
    return require('electron').clipboard.writeText(text);
  } catch {}
  return null;
}

function renderInlines(parent, nodes, doc, opts) {
  for (const node of nodes) parent.appendChild(renderInline(node, doc, opts));
}

function renderInline(node, doc, opts) {
  switch (node.type) {
    case 'text': return doc.createTextNode(node.value);
    case 'br': return el(doc, 'br');
    case 'code': {
      const c = el(doc, 'code', 'md-code-inline');
      c.textContent = node.value;
      return c;
    }
    case 'strong':
    case 'em':
    case 'del': {
      const tag = node.type === 'strong' ? 'strong' : node.type === 'em' ? 'em' : 'del';
      const e = el(doc, tag);
      renderInlines(e, node.children, doc, opts);
      return e;
    }
    case 'link': {
      if (!isSafeUrl(node.href)) {
        const span = el(doc, 'span');
        renderInlines(span, node.children, doc, opts);
        return span;
      }
      const a = el(doc, 'a', 'md-link');
      a.href = node.href;
      a.title = node.href;
      a.rel = 'noreferrer noopener';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof opts.onLink === 'function') opts.onLink(node.href);
      });
      renderInlines(a, node.children, doc, opts);
      return a;
    }
    default: return doc.createTextNode('');
  }
}

module.exports = { parseMarkdown, parseInline, renderMarkdown, isSafeUrl };
