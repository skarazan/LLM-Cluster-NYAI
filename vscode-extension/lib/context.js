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
        'Return only the text that should be inserted at the cursor.',
        'Do not use markdown, code fences, bullet points, or explanations.',
        'Preserve the surrounding language, indentation, and formatting.',
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
        'Be concise and output only the requested code or explanation.',
        'If the user asks for code changes, return the updated code only unless they ask otherwise.',
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
        'You are a coding task agent routed through the LLM Cluster manager.',
        'Use tools when needed and keep edits scoped to the user request.',
        'When you finish all requested work, return a concise completion summary.',
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
