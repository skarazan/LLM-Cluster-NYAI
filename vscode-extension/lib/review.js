'use strict';

const vscode = require('vscode');

async function previewChangeAndConfirm({ originalText, replacementText, languageId, title }) {
  const sourceDoc = await vscode.workspace.openTextDocument({
    content: originalText,
    language: languageId || 'plaintext',
  });
  const targetDoc = await vscode.workspace.openTextDocument({
    content: replacementText,
    language: languageId || 'plaintext',
  });

  await vscode.commands.executeCommand(
    'vscode.diff',
    sourceDoc.uri,
    targetDoc.uri,
    title || 'LLM Cluster: Proposed Changes',
    { preview: true }
  );

  const choice = await vscode.window.showWarningMessage(
    'Apply these changes?',
    { modal: true },
    'Accept',
    'Discard'
  );

  return choice === 'Accept';
}

module.exports = { previewChangeAndConfirm };
