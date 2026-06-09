const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('./agentLoop');

const workspace = '/Users/tester/workspace';

test('normalizeTodoPath resolves relative paths into workspace', () => {
  const out = __test.normalizeTodoPath('src/index.html', workspace);
  assert.equal(out, '/Users/tester/workspace/src/index.html');
});

test('normalizeTodoPath rejects URL-like paths (direct and embedded)', () => {
  assert.equal(__test.normalizeTodoPath('https://cdn.example.com/style.css', workspace), '');
  assert.equal(__test.normalizeTodoPath('/Users/tester/workspace/https://cdn.example.com/style.css', workspace), '');
});

test('continuation prompt detection', () => {
  assert.equal(__test.isContinuationPrompt('go on'), true);
  assert.equal(__test.isContinuationPrompt('continue from where you stopped'), true);
  assert.equal(__test.isContinuationPrompt('create an amazon copycat website'), false);
});

test('plan update prompt detection', () => {
  assert.equal(__test.isPlanUpdatePrompt('update the plan and todos for mobile layout'), true);
  assert.equal(__test.isPlanUpdatePrompt('revise todo scope and remove backend tasks'), true);
  assert.equal(__test.isPlanUpdatePrompt('go on'), false);
  assert.equal(__test.isPlanUpdatePrompt('create website from scratch'), false);
});

test('frontend-only task detection', () => {
  assert.equal(__test.isFrontendOnlyTask('build an amazon clone website in html css javascript'), true);
  assert.equal(__test.isFrontendOnlyTask('build frontend and backend api for ecommerce app'), false);
});

test('fresh task reset heuristic', () => {
  assert.equal(__test.shouldResetTaskStateFromPrompt('create a new project from scratch', false), true);
  assert.equal(__test.shouldResetTaskStateFromPrompt('build a website demo', false), true);
  assert.equal(__test.shouldResetTaskStateFromPrompt('continue', true), false);
  assert.equal(__test.shouldResetTaskStateFromPrompt('continue', false), false);
});

test('createTaskTodoList uses approved plan paths and avoids older user noise', () => {
  const messages = [
    { role: 'user', content: 'old task: create /Users/tester/workspace/src/old.js' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'new task: create an amazon clone website' },
  ];
  const approvedPlan = [
    '1. /Users/tester/workspace/index.html — main markup',
    '2. /Users/tester/workspace/style.css — styles',
    '3. /Users/tester/workspace/script.js — interactivity',
  ].join('\n');

  const todos = __test.createTaskTodoList(messages, approvedPlan, workspace);
  const paths = todos.map(t => t.path);

  assert.deepEqual(paths, [
    '/Users/tester/workspace/index.html',
    '/Users/tester/workspace/style.css',
    '/Users/tester/workspace/script.js',
  ]);
});

test('createTaskTodoList drops CDN URL pseudo-paths', () => {
  const messages = [
    { role: 'user', content: 'build static site' },
  ];
  const approvedPlan = [
    '1. /Users/tester/workspace/index.html — page',
    '2. /Users/tester/workspace/https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css — external css',
    '3. /Users/tester/workspace/style.css — local styles',
  ].join('\n');
  const todos = __test.createTaskTodoList(messages, approvedPlan, workspace);
  const paths = todos.map(t => t.path);
  assert.deepEqual(paths, [
    '/Users/tester/workspace/index.html',
    '/Users/tester/workspace/style.css',
  ]);
});

test('createTaskTodoList can filter backend paths for frontend-only tasks', () => {
  const messages = [
    { role: 'user', content: 'create a frontend-only amazon clone in html css js' },
  ];
  const approvedPlan = [
    '1. /Users/tester/workspace/index.html — page',
    '2. /Users/tester/workspace/style.css — styling',
    '3. /Users/tester/workspace/backend/server.js — api',
    '4. /Users/tester/workspace/api/routes/products.js — api routes',
    '5. /Users/tester/workspace/script.js — client logic',
  ].join('\n');
  const todos = __test.createTaskTodoList(messages, approvedPlan, workspace, { frontendOnlyHint: true });
  const paths = todos.map(t => t.path);
  assert.deepEqual(paths, [
    '/Users/tester/workspace/index.html',
    '/Users/tester/workspace/style.css',
    '/Users/tester/workspace/script.js',
  ]);
});

test('createTaskTodoList prefers file manifest paths over implementation bullet duplicates', () => {
  const messages = [{ role: 'user', content: 'build frontend clone' }];
  const approvedPlan = [
    '## Implementation Plan',
    '1. Build cart-manager.js and product-list.js.',
    '',
    '## File Manifest',
    '1. /Users/tester/workspace/js/main.js - entry',
    '2. /Users/tester/workspace/js/store.js - state',
    '3. /Users/tester/workspace/style.css - styling',
  ].join('\n');
  const todos = __test.createTaskTodoList(messages, approvedPlan, workspace, { frontendOnlyHint: true });
  const paths = todos.map(t => t.path);
  assert.deepEqual(paths, [
    '/Users/tester/workspace/js/main.js',
    '/Users/tester/workspace/js/store.js',
    '/Users/tester/workspace/style.css',
  ]);
});

test('normalizeTodoPath strips malformed numeric suffix after extension', () => {
  const out = __test.normalizeTodoPath('/Users/tester/workspace/js/search-filter.js3.', workspace);
  assert.equal(out, '/Users/tester/workspace/js/search-filter.js');
});

test('isTodoStatePoisoned detects mixed duplicate architecture paths', () => {
  const poisoned = __test.isTodoStatePoisoned([
    { status: 'pending', path: '/Users/tester/workspace/style.css' },
    { status: 'pending', path: '/Users/tester/workspace/js/style.css' },
  ], workspace);
  assert.equal(poisoned, true);
});

test('isTodoStatePoisoned detects markdown contamination inside paths', () => {
  const poisoned = __test.isTodoStatePoisoned([
    { status: 'pending', path: '/Users/tester/workspace/js/search-filter.js3. **State**' },
  ], workspace);
  assert.equal(poisoned, true);
});

test('sanitizePlanForExecution fallback uses latest user prompt', () => {
  const messages = [
    { role: 'user', content: 'old task: python cli with setup.py' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'create a website clone with html css javascript' },
  ];

  const plan = __test.sanitizePlanForExecution('', messages, workspace);
  assert.match(plan, /index\.html/);
  assert.match(plan, /style\.css/);
  assert.match(plan, /script\.js/);
});

test('extractToolCallsFromText parses legacy XML-ish read_file wrapper', () => {
  const text = [
    '<read_file>',
    '<parameter=path>',
    '/Users/tester/workspace/src/index.html',
    '</parameter>',
    '</function>',
    '</tool_call>',
  ].join('\n');
  const calls = __test.extractToolCallsFromText(text, []);
  assert.equal(Array.isArray(calls), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.equal(calls[0].function.arguments.path, '/Users/tester/workspace/src/index.html');
});

test('findIncompleteTextWriteBlock ignores instructional mention of write tag', () => {
  const text = 'Use this exact opening tag:\n<write_file path="/Users/tester/workspace/index.html">\nThen write content and close it.';
  const found = __test.findIncompleteTextWriteBlock(text);
  assert.equal(found, null);
});
