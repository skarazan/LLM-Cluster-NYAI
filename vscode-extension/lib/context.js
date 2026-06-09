'use strict';

const path = require('path');
const vscode = require('vscode');
const { getConfig } = require('./config');
const { buildSystemPrompt } = require('./promptStudio');

function getInlineLimits() {
  const maxContextChars = Number(getConfig().get('maxContextChars', 6000));
  const maxSuffixChars = Number(getConfig().get('maxSuffixChars', 1500));
  return {
    maxContextChars: Number.isFinite(maxContextChars) ? Math.max(500, maxContextChars) : 6000,
    maxSuffixChars: Number.isFinite(maxSuffixChars) ? Math.max(0, maxSuffixChars) : 1500,
  };
}

function clampText(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

function getDocumentExcerpt(document, maxLines) {
  if (!document || document.lineCount === 0) {
    return '';
  }

  const lastLineIndex = Math.min(document.lineCount - 1, Math.max(0, maxLines - 1));
  const endPosition = document.lineAt(lastLineIndex).range.end;
  return document.getText(new vscode.Range(0, 0, endPosition.line, endPosition.character));
}

function getSnippetAroundLine(document, lineNumber, radius = 12) {
  if (!document || document.lineCount === 0) {
    return '';
  }

  const startLine = Math.max(0, lineNumber - radius);
  const endLine = Math.min(document.lineCount - 1, lineNumber + radius);
  const endPosition = document.lineAt(endLine).range.end;
  return document.getText(new vscode.Range(startLine, 0, endLine, endPosition.character));
}

function getSelectedTextOrSnippet(editor) {
  if (!editor || !editor.document) {
    return '';
  }

  if (editor.selection && !editor.selection.isEmpty) {
    return editor.document.getText(editor.selection);
  }

  const activeLine = editor.selection?.active?.line ?? 0;
  return getSnippetAroundLine(editor.document, activeLine, 12) || getDocumentExcerpt(editor.document, 120);
}

async function chooseEditorContext(editor, title) {
  if (!editor || !editor.document) {
    return '';
  }

  const hasSelection = Boolean(editor.selection && !editor.selection.isEmpty);
  const activeLine = editor.selection?.active?.line ?? 0;
  const items = [];

  if (hasSelection) {
    items.push({
      label: 'Selected code',
      description: 'Use only the highlighted code',
      value: 'selection',
    });
  }

  items.push(
    {
      label: 'Current line',
      description: 'Use the line under the cursor',
      value: 'line',
    },
    {
      label: 'Surrounding code',
      description: 'Use nearby lines around the cursor',
      value: 'surrounding',
    },
    {
      label: 'File excerpt',
      description: 'Use the beginning of the current file',
      value: 'file',
    }
  );

  const choice = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Choose what code to send as context',
  });

  if (!choice) {
    return '';
  }

  switch (choice.value) {
    case 'selection':
      return editor.document.getText(editor.selection).trim();
    case 'line':
      return editor.document.lineAt(activeLine).text.trim();
    case 'surrounding':
      return getSnippetAroundLine(editor.document, activeLine, 12).trim();
    case 'file':
      return getDocumentExcerpt(editor.document, 120).trim();
    default:
      return '';
  }
}

function buildInlineMessages(document, position) {
  const { maxContextChars, maxSuffixChars } = getInlineLimits();
  const fullText = document.getText();
  const cursorOffset = document.offsetAt(position);
  const prefix = clampText(fullText.slice(0, cursorOffset), maxContextChars);
  const suffix = fullText.slice(cursorOffset, cursorOffset + maxSuffixChars);
  const languageId = document.languageId || 'plaintext';
  const fileName = path.basename(document.uri.fsPath || 'untitled');

  return [
    {
      role: 'system',
      content: [
        'You are a code completion engine inside VS Code.',
        'Return only the text that should be inserted at the cursor — it must join seamlessly with the text before and after the cursor.',
        'Do not repeat any text that already appears before the cursor or in <after_cursor>.',
        'Stop at a natural boundary: the end of the current statement, block, or function. Do not continue past what the surrounding code needs.',
        'Do not use markdown, code fences, bullet points, or explanations.',
        'Preserve the surrounding language, indentation style, and formatting.',
        'If no completion is appropriate, return an empty string.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Language: ${languageId}`,
        `File: ${fileName}`,
        '',
        '<before_cursor>',
        prefix,
        '</before_cursor>',
        '',
        '<after_cursor>',
        suffix,
        '</after_cursor>',
        '',
        'Write the next useful completion only.',
      ].join('\n'),
    },
  ];
}

function buildChatMessages(document, selectionText, prompt, promptStudioState) {
  const languageId = document.languageId || 'plaintext';
  const fileName = path.basename(document.uri.fsPath || 'untitled');
  const context = selectionText || getDocumentExcerpt(document, 120);
  const systemContent = promptStudioState
    ? buildSystemPrompt(promptStudioState, 'chat')
    : [
        'You are a VS Code coding assistant.',
        'Be concise and output only the requested code or explanation — no preamble, no restating the question.',
        'If the user asks for code changes, return the complete updated code only, with no commentary, unless they ask otherwise.',
        'Match the language, style, and indentation of the provided context.',
        'If the request is ambiguous, state your assumption in one line and proceed.',
      ].join(' ');

  return [
    {
      role: 'system',
      content: systemContent,
    },
    {
      role: 'user',
      content: [
        `Language: ${languageId}`,
        `File: ${fileName}`,
        '',
        'Context:',
        context,
        '',
        'Task:',
        prompt,
      ].join('\n'),
    },
  ];
}

function getWorkspaceRootPath() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    return '';
  }
  return String(folders[0].uri.fsPath || '').trim();
}

function buildTaskMessages(document, selectionText, prompt, workspaceRoot, promptStudioState) {
  const languageId = document?.languageId || 'plaintext';
  const fileName = document ? path.basename(document.uri.fsPath || 'untitled') : 'untitled';
  const context = selectionText || (document ? getDocumentExcerpt(document, 120) : '');
  const workspaceLine = workspaceRoot
    ? `Workspace root: ${workspaceRoot}`
    : 'Workspace root: (none)';
  const systemContent = promptStudioState
    ? buildSystemPrompt(promptStudioState, 'code')
    : [
        'You are a coding task agent working in the user\'s VS Code workspace, routed through the LLM Cluster manager.',
        'Work autonomously with the provided tools until the task is complete — do not ask the user what to do next.',
        'Read a file before editing or overwriting it; never guess at existing content.',
        'Use absolute paths under the workspace root for every file operation.',
        'Keep edits scoped to the user request — no drive-by refactors or extra files.',
        'After changes, verify with the cheapest available check (build, test, or run) when possible.',
        'When you finish all requested work, return a short summary: files changed and how to verify.',
      ].join(' ');

  return [
    {
      role: 'system',
      content: systemContent,
    },
    {
      role: 'user',
      content: [
        workspaceLine,
        `Language: ${languageId}`,
        `File: ${fileName}`,
        '',
        'Context:',
        context || '(no active editor context)',
        '',
        'Task:',
        prompt,
      ].join('\n'),
    },
  ];
}

function buildLocalLlmMessages(document, snippetText, instruction) {
  const languageId = document.languageId || 'plaintext';
  const fileName = path.basename(document.uri.fsPath || 'untitled');
  const normalizedInstruction = String(instruction || '').trim();

  return [
    {
      role: 'system',
      content: [
        'You are a local LLM assistant connected to VS Code.',
        'Respond helpfully and concisely.',
        'Preserve code formatting when quoting or rewriting code.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Language: ${languageId}`,
        `File: ${fileName}`,
        '',
        'Snippet:',
        snippetText,
        '',
        normalizedInstruction ? 'Instruction:' : 'Request:',
        normalizedInstruction || 'Review this snippet and respond helpfully.',
      ].join('\n'),
    },
  ];
}

module.exports = {
  getInlineLimits,
  clampText,
  getDocumentExcerpt,
  getSnippetAroundLine,
  getSelectedTextOrSnippet,
  chooseEditorContext,
  buildInlineMessages,
  buildChatMessages,
  getWorkspaceRootPath,
  buildTaskMessages,
  buildLocalLlmMessages,
};
