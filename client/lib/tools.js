'use strict';

/**
 * Tool schema definitions sent to Ollama on every Code-mode request.
 * Each entry: { name, description, parameters (JSON Schema), risk }
 *
 * risk: "read" | "write" | "shell"
 */
const TOOL_DEFINITIONS = [
  // ── Tier A: read-only ──────────────────────────────────────────────
  {
    name: 'read_file',
    description: 'Read the contents of a file inside the workspace. Use offset and limit to read large files in chunks.',
    parameters: {
      type: 'object',
      properties: {
        path:   { type: 'string', description: 'Path to the file (relative to workspace root or absolute).' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Optional.' },
        limit:  { type: 'number', description: 'Maximum number of lines to read. Optional.' },
      },
      required: ['path'],
    },
    risk: 'read',
  },
  {
    name: 'list_dir',
    description: 'List files and directories in a given directory inside the workspace. Omit path to list the workspace root.',
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
        root:    { type: 'string', description: 'Sub-directory to search in (relative to workspace). Optional, defaults to workspace root.' },
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
        path:    { type: 'string', description: 'File or directory to search in (relative to workspace). Optional, defaults to workspace root.' },
        glob:    { type: 'string', description: 'Glob to filter files, e.g. "*.js". Optional.' },
        regex:   { type: 'boolean', description: 'If true, treat pattern as regex. Default true.' },
      },
      required: ['pattern'],
    },
    risk: 'read',
  },

  // ── Tier B: mutating ───────────────────────────────────────────────
  {
    name: 'write_file',
    description: 'Create a new file. HARD LIMIT: 50 lines / 1500 chars MAX per call. For longer files: write_file first 50 lines, then append_file next 50 lines, repeat. NEVER put an entire file in one call. Use edit_file for existing files.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Path to the file (relative to workspace root or absolute).' },
        content: { type: 'string', description: 'File content. HARD LIMIT: 50 lines, 1500 chars. Use append_file for remaining parts.', maxLength: 1500 },
      },
      required: ['path', 'content'],
    },
    risk: 'write',
  },
  {
    name: 'append_file',
    description: 'Append content to end of existing file. HARD LIMIT: 50 lines / 1500 chars per call. Use after write_file to continue writing.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Path to the file to append to.' },
        content: { type: 'string', description: 'Content to append. HARD LIMIT: 1500 chars.', maxLength: 1500 },
      },
      required: ['path', 'content'],
    },
    risk: 'write',
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file with a new string. ALWAYS prefer this over write_file for modifying existing files — it is faster, safer, and uses far fewer tokens. old_string must appear exactly once in the file. Call edit_file multiple times to make multiple changes.',
    parameters: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'Path to the file.' },
        old_string: { type: 'string', description: 'Exact text to find and replace. Must be unique in the file.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    risk: 'write',
  },
  {
    name: 'create_dir',
    description: 'Create a directory (and any missing parent directories).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create.' },
      },
      required: ['path'],
    },
    risk: 'write',
  },
  {
    name: 'delete_file',
    description: 'Delete a single file. Does NOT support recursive directory deletion.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete.' },
      },
      required: ['path'],
    },
    risk: 'write',
  },

  // ── Tier C: shell ──────────────────────────────────────────────────
  {
    name: 'run_shell',
    description: 'Run a shell command inside the workspace directory. Use for running tests, builds, linters, etc.',
    parameters: {
      type: 'object',
      properties: {
        cmd:        { type: 'string',  description: 'Command name (e.g. "node", "python3", "npm").' },
        args:       { type: 'array',   items: { type: 'string' }, description: 'Command arguments as an array.' },
        cwd:        { type: 'string',  description: 'Working directory relative to workspace root. Optional.' },
        timeout_ms: { type: 'number',  description: 'Timeout in milliseconds. Default 30000.' },
      },
      required: ['cmd'],
    },
    risk: 'shell',
  },
];

/**
 * Return OpenAI-compatible tool schemas.
 * If workspace is provided, inject it into relevant descriptions so the model
 * always knows the exact path to use without guessing.
 */
function getToolSchemas(workspace) {
  return TOOL_DEFINITIONS.map(({ name, description, parameters }) => {
    let desc = description;
    if (workspace) {
      // Patch path/root descriptions to include the actual workspace root
      const patchedParams = JSON.parse(JSON.stringify(parameters));
      for (const [key, val] of Object.entries(patchedParams.properties || {})) {
        if (['path', 'root', 'cwd'].includes(key) && typeof val.description === 'string') {
          val.description = val.description
            + ` Workspace root is: ${workspace}. Use absolute paths starting with ${workspace}/.`;
        }
      }
      return { type: 'function', function: { name, description: desc, parameters: patchedParams } };
    }
    return { type: 'function', function: { name, description: desc, parameters } };
  });
}

/** Look up a tool definition by name. */
function getTool(name) {
  return TOOL_DEFINITIONS.find(t => t.name === name) || null;
}

module.exports = { TOOL_DEFINITIONS, getToolSchemas, getTool };
