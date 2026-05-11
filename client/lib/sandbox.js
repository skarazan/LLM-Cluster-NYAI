'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Directories that are always denied regardless of workspace
const ABSOLUTE_DENY = [
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.config', 'gcloud'),
  path.join(os.homedir(), 'Library', 'Keychains'),
  '/etc', '/System', '/usr/bin', '/usr/sbin',
  'C:\\Windows', 'C:\\System32',
];

// Shell commands that are never allowed
const SHELL_DENY = [
  /^rm\b/, /^del\b/, /^rmdir\b/,
  /\brm\s+-[^\s]*r/, // rm -rf style
  /^mkfs\b/, /^dd\b/, /^fdisk\b/,
  /\bsudo\b/, /\bdoas\b/, /\brunas\b/,
  /^curl\b/, /^wget\b/,
  /\bcat\s*>/, /\becho\s*>/, /\btee\b/, /<<\s*['"]?\w+['"]?/, // no shell file writes — use <write_file> tags
  /:\(\)\s*\{/, // fork bomb
];

function isDeniedAbsolute(resolved) {
  return ABSOLUTE_DENY.some(d => resolved === d || resolved.startsWith(d + path.sep));
}

/**
 * Resolve a potentially relative path against workspaceRoot.
 * Returns { ok: true, resolved } or { ok: false, error }.
 * Blocks path traversal and absolute deny-list.
 */
function resolveSafe(workspaceRoot, p) {
  if (!workspaceRoot) return { ok: false, error: 'No workspace selected. Click "Workspace" in the header to choose a folder.' };

  // Normalize workspace root (strip trailing sep)
  workspaceRoot = workspaceRoot.replace(/[/\\]+$/, '');

  // Default undefined/null/empty path to workspace root itself
  if (p === undefined || p === null || p === '' || p === 'undefined' || p === 'null') {
    p = '.';
  }

  // Expand ~ shorthand
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  if (typeof p === 'string' && /[\0\r\n]/.test(p)) {
    return { ok: false, error: `Path "${p}" contains invalid characters.` };
  }

  // Common model slip: "/workspacefile.js" instead of "/workspace/file.js".
  if (typeof p === 'string' && path.isAbsolute(p) && p.startsWith(workspaceRoot) && !p.startsWith(workspaceRoot + path.sep) && p !== workspaceRoot) {
    p = path.join(workspaceRoot, p.slice(workspaceRoot.length));
  }

  const resolved = path.resolve(workspaceRoot, p);

  // Must be inside workspace
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    return { ok: false, error: `Path "${p}" is outside the workspace root "${workspaceRoot}". Use an absolute path inside the selected workspace.` };
  }

  // Check absolute deny-list
  if (isDeniedAbsolute(resolved)) {
    return { ok: false, error: `Access to "${resolved}" is not allowed.` };
  }

  // Check realpath to catch symlink escape attempts
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(workspaceRoot + path.sep) && real !== workspaceRoot) {
      return { ok: false, error: `Symlink "${p}" points outside the workspace.` };
    }
    if (isDeniedAbsolute(real)) {
      return { ok: false, error: `Symlink "${p}" points to a protected path.` };
    }
  } catch {
    // File doesn't exist yet (e.g. write_file to a new path) — that's fine
  }

  return { ok: true, resolved };
}

/**
 * Check a shell command + args for deny-list patterns.
 * Returns { ok: true } or { ok: false, error }.
 */
function checkShellCommand(cmd, args = []) {
  const full = [cmd, ...args].join(' ');
  for (const pattern of SHELL_DENY) {
    if (pattern.test(full)) {
      return { ok: false, error: `Command "${cmd}" is not allowed.` };
    }
  }
  return { ok: true };
}

module.exports = { resolveSafe, checkShellCommand };
