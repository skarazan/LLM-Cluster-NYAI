'use strict';
const { test, expect } = require('@playwright/test');
const { describeToolRequest, buildPreview, summariseArgs, rememberTarget } = require('../../renderer/components/approvalCard');

test.describe('permission request descriptions', () => {
  test('describes reads, writes, shell and delete with the right risk', () => {
    expect(describeToolRequest('read_file', { path: '/w/a.js' }, 'read')).toMatchObject({ title: 'Read a file', target: '/w/a.js', risk: 'read', tone: 'info' });
    expect(describeToolRequest('write_file', { path: '/w/a.js' }, 'write')).toMatchObject({ title: 'Write a file', risk: 'write', tone: 'accent' });
    expect(describeToolRequest('run_shell', { cmd: 'npm', args: ['test'] }, 'shell')).toMatchObject({ title: 'Run a shell command', target: 'npm test', risk: 'shell', tone: 'warning' });
    expect(describeToolRequest('delete_file', { path: '/w/a.js' }, 'write')).toMatchObject({ risk: 'delete', tone: 'danger', riskLabel: 'Delete' });
  });

  test('"always allow" copy matches the key the agent remembers', () => {
    expect(rememberTarget({ path: '/w/src/app.js' })).toBe('/w/src/app.js');
    expect(describeToolRequest('edit_file', { path: '/w/src/app.js' }, 'write').rememberLabel)
      .toBe("Yes, and don't ask again for edit_file on src/app.js this session");
    // No path → the agent stores "tool:" which matches every call of that tool.
    expect(describeToolRequest('inspect_project', {}, 'read').rememberLabel)
      .toBe("Yes, and don't ask again for inspect_project this session");
  });

  test('unknown tools fall back gracefully', () => {
    const d = describeToolRequest('mystery_tool', { foo: 1 }, 'nonsense');
    expect(d.title).toBe('Use mystery_tool');
    expect(d.risk).toBe('write');
  });

  test('diff previews', () => {
    expect(buildPreview('edit_file', { old_string: 'a', new_string: 'b' })).toBe('- a\n+ b');
    expect(buildPreview('run_shell', { cmd: 'ls', args: ['-la'] })).toBe('$ ls -la');
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    expect(buildPreview('write_file', { content: long })).toContain('(20 lines total)');
    expect(buildPreview('read_file', { path: 'x' })).toBeNull();
  });

  test('inline summaries', () => {
    expect(summariseArgs('replace_file_range', { path: 'a.js', start_line: 1, end_line: 4 })).toBe('"a.js", lines 1-4');
    expect(summariseArgs('grep', { pattern: 'TODO', path: 'src' })).toBe('"TODO", "src"');
  });
});
