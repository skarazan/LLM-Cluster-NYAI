'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { resolveSafe } = require('../../lib/sandbox');

test('selected workspace paths remain valid through a filesystem alias', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmc-sandbox-'));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(actual);
  fs.writeFileSync(path.join(actual, 'note.txt'), 'hello');
  try {
    if (process.platform === 'win32') {
      // A junction avoids requiring Windows developer-mode symlink privileges.
      fs.symlinkSync(actual, alias, 'junction');
    } else {
      fs.symlinkSync(actual, alias, 'dir');
    }
    expect(resolveSafe(alias, alias)).toEqual({ ok: true, resolved: alias });
    expect(resolveSafe(alias, path.join(alias, 'note.txt'))).toEqual({
      ok: true,
      resolved: path.join(alias, 'note.txt'),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
