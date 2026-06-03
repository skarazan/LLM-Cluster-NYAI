'use strict';

/**
 * Tool schema definitions sent to the manager for task mode.
 * Keep this aligned with the desktop client so the same agent behavior is available.
 */
const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read a file inside the workspace. Defaults to 300 lines. Before editing/overwriting an existing file, read it fully with a high limit such as 5000.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative to workspace root or absolute).' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Optional.' },
        limit: { type: 'number', description: 'Maximum number of lines to read. Optional, max 5000.' },
      },
      required: ['path'],
    },
    risk: 'read',
  },
  {
    name: 'read_many_files',
    description: 'Read several files in one call. Returns unchanged stubs for files already read fully and unchanged.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to read, max 12 files.' },
      },
      required: ['paths'],
    },
    risk: 'read',
  },
  {
    name: 'file_state',
    description: 'Check file existence/type/bytes/hash/mtime without reading full content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Single absolute path to inspect.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Several absolute paths to inspect, max 12.' },
      },
      required: [],
    },
    risk: 'read',
  },
  {
    name: 'inspect_project',
    description: 'Return compact project context: tree, package scripts, and local instruction files.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    risk: 'read',
  },
  {
    name: 'list_dir',
    description: 'List files and directories in a given directory inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (absolute). Defaults to workspace root if omitted.' },
      },
      required: [],
    },
    risk: 'read',
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.js" or "src/**/*.ts".' },
        root: { type: 'string', description: 'Sub-directory to search in (relative to workspace). Optional, defaults to workspace root.' },
      },
      required: ['pattern'],
    },
    risk: 'read',
  },
  {
    name: 'grep',
    description: 'Search for a regex or literal pattern in files inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex or literal string).' },
        path: { type: 'string', description: 'File or directory to search in (relative to workspace). Optional, defaults to workspace root.' },
        glob: { type: 'string', description: 'Glob to filter files, e.g. "*.js". Optional.' },
        regex: { type: 'boolean', description: 'If true, treat pattern as regex. Default true.' },
      },
      required: ['pattern'],
    },
    risk: 'read',
  },
  {
    name: 'write_file',
    description: 'Create a new file. Use append_file for long content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative to workspace root or absolute).' },
        content: { type: 'string', description: 'File content.' },
      },
      required: ['path', 'content'],
    },
    risk: 'write',
  },
  {
    name: 'append_file',
    description: 'Append content to end of existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to append to.' },
        content: { type: 'string', description: 'Content to append.' },
      },
      required: ['path', 'content'],
    },
    risk: 'write',
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file with a new string.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        old_string: { type: 'string', description: 'Exact text to find and replace. Must be unique in the file.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    risk: 'write',
  },
  {
    name: 'replace_file_range',
    description: 'Replace an inclusive line range in an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        start_line: { type: 'number', description: 'First line to replace, 1-indexed.' },
        end_line: { type: 'number', description: 'Last line to replace, inclusive.' },
        content: { type: 'string', description: 'Replacement content for that line range.' },
      },
      required: ['path', 'start_line', 'end_line', 'content'],
    },
    risk: 'write',
  },
  {
    name: 'delete_file',
    description: 'Delete a single file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete.' },
      },
      required: ['path'],
    },
    risk: 'write',
  },
  {
    name: 'run_shell',
    description: 'Run a short shell command for install, tests, build, lint, or open file actions.',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Command name only (e.g. "node", "npm").' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
        cwd: { type: 'string', description: 'Working directory relative to workspace root. Optional.' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 30000.' },
      },
      required: ['cmd'],
    },
    risk: 'shell',
  },
];

function getToolSchemas(workspace) {
  return TOOL_DEFINITIONS.map(({ name, description, parameters }) => {
    if (!workspace) {
      return { type: 'function', function: { name, description, parameters } };
    }

    const patched = JSON.parse(JSON.stringify(parameters));
    for (const [key, value] of Object.entries(patched.properties || {})) {
      if (['path', 'root', 'cwd'].includes(key) && typeof value.description === 'string') {
        value.description += ` Workspace root is: ${workspace}. Use absolute paths starting with ${workspace}/.`;
      }
    }

    return {
      type: 'function',
      function: {
        name,
        description,
        parameters: patched,
      },
    };
  });
}

module.exports = { getToolSchemas };
