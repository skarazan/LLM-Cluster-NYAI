'use strict';
const { test, expect } = require('@playwright/test');
const { summarizeTodos } = require('../../renderer/components/todoPanel');
const { compactNumber, shortPath, baseName } = require('../../renderer/components/dom');

test('summarizeTodos counts every status and ignores junk', () => {
  const s = summarizeTodos([
    { status: 'done' }, { status: 'done' }, { status: 'failed' },
    { status: 'in_progress' }, { status: 'pending' }, { status: 'weird' }, null,
  ]);
  expect(s).toMatchObject({ total: 6, done: 2, failed: 1, in_progress: 1, pending: 2, percent: 33 });
  expect(summarizeTodos(undefined)).toMatchObject({ total: 0, percent: 0 });
});

test('path helpers work for POSIX and Windows paths', () => {
  expect(baseName('/home/me/project')).toBe('project');
  expect(baseName('C:\\Users\\me\\project\\')).toBe('project');
  expect(shortPath('C:\\Users\\me\\project\\src\\app.js')).toBe('src/app.js');
  expect(shortPath('/a/b/c/d.js', 3)).toBe('b/c/d.js');
});

test('compact token counter', () => {
  expect(compactNumber(999)).toBe('999');
  expect(compactNumber(1234)).toBe('1.2k');
  expect(compactNumber(45000)).toBe('45k');
  expect(compactNumber(2_500_000)).toBe('2.5M');
});
