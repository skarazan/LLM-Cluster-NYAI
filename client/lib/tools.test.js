const test = require('node:test');
const assert = require('node:assert/strict');

const { getToolSchemas } = require('./tools');

test('model-exposed tools do not include create_dir or inspect_project', () => {
  const tools = getToolSchemas('/Users/tester/workspace');
  const names = tools.map(t => t.function.name);
  assert.equal(names.includes('create_dir'), false);
  assert.equal(names.includes('inspect_project'), false);
});

