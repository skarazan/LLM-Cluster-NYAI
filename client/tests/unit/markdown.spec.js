'use strict';
const { test, expect } = require('@playwright/test');
const { parseMarkdown, parseInline, isSafeUrl } = require('../../renderer/components/markdown');

const types = (blocks) => blocks.map(b => b.type);

test.describe('markdown parser (model output → AST)', () => {
  test('headings, paragraphs and soft line breaks', () => {
    const ast = parseMarkdown('# Title\nfirst line\nsecond line\n\n## Sub');
    expect(types(ast)).toEqual(['heading', 'paragraph', 'heading']);
    expect(ast[0].level).toBe(1);
    expect(ast[1].children.map(n => n.type)).toEqual(['text', 'br', 'text']);
  });

  test('fenced code keeps content verbatim and reports language', () => {
    const ast = parseMarkdown('```js\nconst a = "<b>";\n  indented();\n```');
    expect(ast).toEqual([{ type: 'code', lang: 'js', text: 'const a = "<b>";\n  indented();', closed: true }]);
  });

  test('unclosed fence (mid-stream) still renders as code', () => {
    const ast = parseMarkdown('Here:\n```python\nprint(1)\n');
    expect(types(ast)).toEqual(['paragraph', 'code']);
    expect(ast[1]).toMatchObject({ lang: 'python', text: 'print(1)', closed: false });
  });

  test('ordered, unordered, nested and task lists', () => {
    const ast = parseMarkdown('- a\n- b\n  - b1\n- [x] done\n- [ ] todo\n\n3. three\n4. four');
    expect(types(ast)).toEqual(['list', 'list']);
    const [ul, ol] = ast;
    expect(ul.ordered).toBe(false);
    expect(ul.items).toHaveLength(4);
    expect(types(ul.items[1].children)).toEqual(['paragraph', 'list']);
    expect(ul.items[2].checked).toBe(true);
    expect(ul.items[3].checked).toBe(false);
    expect(ol).toMatchObject({ ordered: true, start: 3 });
  });

  test('a list directly after a sentence (common in model output) is still a list', () => {
    expect(types(parseMarkdown('Steps:\n1. one\n2. two'))).toEqual(['paragraph', 'list']);
  });

  test('GFM tables with alignment', () => {
    const [table] = parseMarkdown('| File | Lines |\n|:-----|------:|\n| a.js | 10 |\n| b.js | 2 |');
    expect(table.type).toBe('table');
    expect(table.align).toEqual(['left', 'right']);
    expect(table.rows).toHaveLength(2);
  });

  test('blockquote and horizontal rule', () => {
    expect(types(parseMarkdown('> quoted\n\n---\nafter'))).toEqual(['blockquote', 'hr', 'paragraph']);
  });

  test('inline formatting', () => {
    const nodes = parseInline('**bold** *em* ~~del~~ `code` [x](https://x.dev)');
    expect(nodes.filter(n => n.type !== 'text').map(n => n.type)).toEqual(['strong', 'em', 'del', 'code', 'link']);
  });

  test('snake_case identifiers and lone asterisks are not emphasised', () => {
    const nodes = parseInline('call my_helper_fn with 2 * 3 * 4');
    expect(nodes).toEqual([{ type: 'text', value: 'call my_helper_fn with 2 * 3 * 4' }]);
  });

  test('bare URLs become links without trailing punctuation', () => {
    const nodes = parseInline('See https://example.com/docs.');
    expect(nodes[1]).toMatchObject({ type: 'link', href: 'https://example.com/docs' });
    expect(nodes[2]).toEqual({ type: 'text', value: '.' });
  });

  test('HTML in model output stays plain text (never markup)', () => {
    const ast = parseMarkdown('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(ast).toHaveLength(1);
    expect(ast[0].children).toEqual([{ type: 'text', value: '<img src=x onerror="alert(1)"> <script>alert(2)</script>' }]);
  });

  test('only http(s) and mailto links are considered safe', () => {
    expect(isSafeUrl('https://a.b')).toBe(true);
    expect(isSafeUrl('mailto:a@b.c')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('data:text/html,hi')).toBe(false);
  });
});
