'use strict';

const path = require('path');
const vscode = require('vscode');
const fs = require('fs');

const config = require('./lib/config');
const { getToolSchemas } = require('./lib/tools');
const {
  getDocumentExcerpt,
  getSnippetAroundLine,
  getSelectedTextOrSnippet,
  chooseEditorContext,
  buildInlineMessages,
  buildChatMessages,
  getWorkspaceRootPath,
  buildTaskMessages,
  buildLocalLlmMessages,
} = require('./lib/context');
const {
  createDefaultPromptStudioState,
  normalizePromptStudioState,
  getPromptPreviewSummary,
} = require('./lib/promptStudio');
const {
  requestCompletion,
  pingManager,
  showResultInEditor,
} = require('./lib/transport');
const { openDashboardPanel } = require('./lib/dashboardPanel');
const { previewChangeAndConfirm } = require('./lib/review');
const {
  getConfig,
  getManagerBaseUrl,
  getModelName,
  getTimeoutMs,
  getInvocationMode,
  getEngineEndpoint,
  getClientProxyUrl,
  getPreferredWorkerId,
  getPreferredWorkerEndpoint,
  setInvocationMode,
  setEngineUrl,
  setClientProxyUrl,
  setPreferredWorkerId,
  setPreferredWorkerEndpoint,
  setUseWorkerEndpointForDirect,
} = config;
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchWorkersFromManager() {
  const response = await fetch(`${getManagerBaseUrl()}/workers`, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Worker list request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  const workers = Array.isArray(data?.workers) ? data.workers : [];
  return workers.map((worker) => ({
    id: String(worker.id || '').trim(),
    name: String(worker.name || 'worker').trim(),
    ip: String(worker.ip || '').trim(),
    port: Number(worker.port || 0),
    status: String(worker.status || ''),
    inflight: Number(worker.inflight || 0),
    models: Array.isArray(worker.models) ? worker.models : [],
    endpoint: worker.ip && worker.port ? `http://${worker.ip}:${worker.port}` : '',
  }));
}

const PROMPT_STUDIO_KEY = 'llm-cluster.promptStudioState';
let promptStudioState = createDefaultPromptStudioState();

async function openChatSidebar() {
  await vscode.commands.executeCommand('workbench.view.extension.llmClusterContainer');
}

async function chooseTaskWorker(workers) {
  const items = [
    {
      label: 'Auto-select best worker',
      description: 'Let the manager choose the worker for this task',
      workerId: '',
    },
    ...workers.map((worker) => ({
      label: worker.name,
      description: worker.endpoint || 'No endpoint',
      detail: `${worker.status || 'unknown'} • ${worker.models.length ? worker.models.join(', ') : 'no model list'}`,
      workerId: worker.id,
    })),
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Choose a worker for this task',
    placeHolder: 'Pick a worker or let the manager auto-select one',
  });

  return choice || null;
}

class ChatViewProvider {
  constructor(context, onSendPrompt, onSendTask) {
    this.context = context;
    this.onSendPrompt = onSendPrompt;
    this.onSendTask = onSendTask;
    this.view = null;
    this.messages = [];
    this.workers = [];
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    try {
      webviewView.webview.html = this.getHtml(webviewView.webview);
    } catch (error) {
      console.error('Failed to generate webview HTML:', error);
      webviewView.webview.html = `<html><body><pre>Error loading view: ${error.message}</pre></body></html>`;
    }

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message.type !== 'string') {
        return;
      }

      if (message.type === 'sendPrompt') {
        const prompt = String(message.prompt || '').trim();
        if (!prompt) {
          return;
        }
        await this.onSendPrompt(prompt, this);
      }

      if (message.type === 'sendTask') {
        const prompt = String(message.prompt || '').trim();
        if (!prompt) {
          return;
        }
        await this.onSendTask(prompt, this);
      }

      if (message.type === 'clearChat') {
        this.messages = [];
        this.render();
      }

      if (message.type === 'saveChat') {
        try {
          await this.context.globalState.update('llm-cluster.chatHistory', this.messages || []);
          vscode.window.showInformationMessage('Chat history saved locally');
        } catch (err) {
          vscode.window.showErrorMessage('Failed to save chat history: ' + err.message);
        }
      }

      if (message.type === 'loadChat') {
        try {
          const history = this.context.globalState.get('llm-cluster.chatHistory', []);
          this.messages = Array.isArray(history) ? history : [];
          this.render();
          vscode.window.showInformationMessage('Chat history restored');
        } catch (err) {
          vscode.window.showErrorMessage('Failed to load chat history: ' + err.message);
        }
      }

      if (message.type === 'exportChat') {
        try {
          const defaultName = `llm-cluster-chat-${Date.now()}.json`;
          const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(getWorkspaceRootPath() || process.cwd(), defaultName)), filters: { 'JSON': ['json'] } });
          if (uri) {
            fs.writeFileSync(uri.fsPath, JSON.stringify(this.messages || [], null, 2), 'utf8');
            vscode.window.showInformationMessage(`Chat exported to ${uri.fsPath}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage('Export failed: ' + err.message);
        }
      }

      if (message.type === 'importChat') {
        try {
          const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'JSON': ['json'] } });
          if (uris && uris[0]) {
            const data = fs.readFileSync(uris[0].fsPath, 'utf8');
            const parsed = JSON.parse(data);
            this.messages = Array.isArray(parsed) ? parsed : [];
            await this.context.globalState.update('llm-cluster.chatHistory', this.messages);
            this.render();
            vscode.window.showInformationMessage('Chat imported');
          }
        } catch (err) {
          vscode.window.showErrorMessage('Import failed: ' + err.message);
        }
      }

      if (message.type === 'executeLLMCommand') {
        const cmd = String(message.command || '').trim();
        // Only commands this extension contributes — the webview is untrusted
        // input and must not be able to invoke arbitrary VS Code commands.
        const allowed = cmd.startsWith('llmCluster.');
        if (cmd && allowed) {
          try {
            await vscode.commands.executeCommand(cmd);
          } catch (err) {
            vscode.window.showErrorMessage('Failed to execute command: ' + err.message);
          }
        } else if (cmd) {
          vscode.window.showErrorMessage('Blocked non-LLM Cluster command: ' + cmd);
        }
      }

      if (message.type === 'copyLLMCommand') {
        const text = String(message.text || '');
        if (text) {
          try {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage('Command copied to clipboard');
          } catch (err) {
            vscode.window.showErrorMessage('Failed to copy: ' + err.message);
          }
        }
      }

      if (message.type === 'setMode') {
        const mode = String(message.mode || 'manager');
        const ok = await setInvocationMode(mode);
        if (ok) {
          vscode.window.showInformationMessage(`LLM Cluster mode set to ${mode}`);
          this.render();
        } else {
          vscode.window.showErrorMessage('Failed to save invocation mode');
        }
      }

      if (message.type === 'setPromptStudioState') {
        promptStudioState = normalizePromptStudioState(message.state);
        await this.context.globalState.update(PROMPT_STUDIO_KEY, promptStudioState);
        this.render();
      }

      if (message.type === 'setEngineUrl') {
        const url = String(message.url || '').trim();
        const ok = await setEngineUrl(url);
        if (ok) {
          vscode.window.showInformationMessage(`Engine URL saved: ${url}`);
          this.render();
        } else {
          vscode.window.showErrorMessage('Failed to save engine URL');
        }
      }

      if (message.type === 'setUseWorkerEndpoint') {
        const enabled = Boolean(message.enabled);
        const ok = await setUseWorkerEndpointForDirect(enabled);
        if (ok) {
          vscode.window.showInformationMessage(`Use worker endpoint for direct calls: ${enabled ? 'enabled' : 'disabled'}`);
          this.render();
        } else {
          vscode.window.showErrorMessage('Failed to save worker-endpoint toggle');
        }
      }

      if (message.type === 'setClientProxyUrl') {
        const url = String(message.url || '').trim();
        const ok = await setClientProxyUrl(url);
        if (ok) {
          vscode.window.showInformationMessage(`Client proxy URL saved: ${url}`);
          this.render();
        } else {
          vscode.window.showErrorMessage('Failed to save client proxy URL');
        }
      }

      if (message.type === 'refreshWorkers') {
        await this.loadWorkers();
      }

      if (message.type === 'selectWorker') {
        const workerId = String(message.workerId || '').trim();
        const worker = this.workers.find((entry) => entry.id === workerId);
        if (!worker) {
          vscode.window.showErrorMessage('Selected worker not found');
          return;
        }
        const okId = await setPreferredWorkerId(worker.id);
        const okEndpoint = await setPreferredWorkerEndpoint(worker.endpoint);

        // Only auto-fill engine URL and switch to direct if user enabled the toggle
        const useWorkerEndpoint = Boolean(getConfig().get('useWorkerEndpointForDirectCalls', false));
        let okEngine = true;
        let okMode = true;
        if (useWorkerEndpoint) {
          okEngine = await setEngineUrl(worker.endpoint);
          okMode = await setInvocationMode('direct');
        }

        if (okId && okEndpoint && okMode && okEngine) {
          vscode.window.showInformationMessage(`Selected worker: ${worker.name} (${worker.endpoint})`);
          this.render();
        } else {
          vscode.window.showErrorMessage('Failed to save selected worker or settings');
        }
      }
    });

    this.render();
  }

  async loadWorkers() {
    try {
      this.workers = await fetchWorkersFromManager();
      this.render();
    } catch (error) {
      this.workers = [];
      this.render();
      vscode.window.showWarningMessage(`Could not load workers: ${error.message}`);
    }
  }

  append(role, text) {
    this.messages.push({ role, text: String(text || '') });
    this.render();
  }

  setBusy(isBusy) {
    this.busy = Boolean(isBusy);
    this.render();
  }

  render() {
    if (!this.view) {
      return;
    }

    try {
      this.view.webview.html = this.getHtml(this.view.webview);
    } catch (error) {
      console.error('Failed to render webview:', error);
      this.view.webview.html = `<html><body><pre>Error rendering: ${error.message}</pre></body></html>`;
    }
  }

  getHtml(webview) {
    const managerUrl = escapeHtml(getManagerBaseUrl());
    const modelName = escapeHtml(getModelName());
    const currentMode = escapeHtml(getInvocationMode());
    const engineUrlEsc = escapeHtml(getEngineEndpoint());
    const clientUrlEsc = escapeHtml(getClientProxyUrl());
    const preferredWorkerId = getPreferredWorkerId();
    const preferredWorkerEndpoint = escapeHtml(getPreferredWorkerEndpoint());
    const useWorkerToggleChecked = getConfig().get('useWorkerEndpointForDirectCalls', false) ? 'checked' : '';
    const promptSummary = getPromptPreviewSummary(promptStudioState, getInvocationMode());
    const latestTask = escapeHtml((this.messages || []).slice().reverse().find((message) => message.role === 'user')?.text || '');
    const toolCount = getToolSchemas(getWorkspaceRootPath() || undefined).length;
    const workerOptions = this.workers.length
      ? this.workers.map((worker) => {
          const selected = worker.id === preferredWorkerId ? 'selected' : '';
          const label = `${worker.name} — ${worker.endpoint || 'no endpoint'} (${worker.status || 'unknown'})`;
          return `<option value="${escapeHtml(worker.id)}" ${selected}>${escapeHtml(label)}</option>`;
        }).join('')
      : '<option value="">No workers loaded</option>';

    const history = this.messages.length
      ? this.messages.map((message) => {
          const roleClass = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
          return `<div class="message ${roleClass}"><div class="label">${escapeHtml(message.role)}</div><div class="body">${escapeHtml(message.text).replace(/\n/g, '<br>')}</div></div>`;
        }).join('')
      : '<div class="empty">Ask a question or select code and generate from the sidebar.</div>';

    const status = this.busy ? 'Thinking…' : `Ready • ${modelName}`;

    const webviewBuilder = require('./lib/webview');
    return webviewBuilder.buildWebviewHtml({
      managerUrl,
      modelName,
      currentMode,
      engineUrlEsc,
      clientUrlEsc,
      preferredWorkerId,
      preferredWorkerEndpoint,
      promptStudioState,
      promptSummary,
      latestTask,
      toolCount,
      workerOptions,
      history,
      status,
      useWorkerToggleChecked,
    });
  }
}

function activate(context) {
  console.log('LLM Cluster extension activating...');
  promptStudioState = normalizePromptStudioState(context.globalState.get(PROMPT_STUDIO_KEY) || createDefaultPromptStudioState());
  const output = vscode.window.createOutputChannel('LLM Cluster');
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const showStatusBar = () => {
    statusBarItem.command = 'llmCluster.showPanel';
    statusBarItem.tooltip = 'LLM Cluster: open extension panel and settings';
    statusBarItem.text = '$(sparkle) LLM Cluster';
    statusBarItem.show();
  };

  showStatusBar();
  console.log('LLM Cluster extension activated, status bar shown');

  const refreshStatus = async () => {
    const online = await pingManager();
    statusBarItem.text = online ? '$(sparkle) LLM Cluster' : '$(warning) LLM Cluster';
    statusBarItem.tooltip = online
      ? `LLM Cluster manager is reachable at ${getManagerBaseUrl()}`
      : `LLM Cluster manager is unreachable at ${getManagerBaseUrl()}`;
  };

  const refreshTimer = setInterval(refreshStatus, 30000);
  refreshStatus();

  const windowStateListener = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      showStatusBar();
    }
  });

  let chatViewProvider;
  const sendChatPrompt = async (prompt, provider) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file first to use LLM Cluster.');
      return;
    }

    const contextText = await chooseEditorContext(editor, 'LLM Cluster: Choose Context');
    if (!contextText) {
      return;
    }

    provider.append('user', prompt);
    provider.append('assistant', 'Thinking...');
    provider.setBusy(true);
    output.appendLine('Sending request to manager...');
    output.show(true);

    try {
      const messages = buildChatMessages(editor.document, contextText, prompt, promptStudioState);
      let accumulated = '';
      const onChunk = (chunk) => {
        accumulated += chunk;
        // update last assistant message in-place
        const lastIdx = provider.messages.length - 1;
        if (lastIdx >= 0 && provider.messages[lastIdx].role === 'assistant') {
          const prev = provider.messages[lastIdx].text;
          provider.messages[lastIdx].text = (prev === 'Thinking...' ? chunk : prev + chunk);
        }
        provider.render();
        try { output.append(chunk); } catch {}
      };

      const responseText = await requestCompletion(messages, null, onChunk);
      provider.messages[provider.messages.length - 1] = { role: 'assistant', text: responseText };
      provider.setBusy(false);
      provider.render();
      output.appendLine('');
      output.appendLine(responseText);
      await showResultInEditor(responseText, editor.document.languageId);
    } catch (error) {
      provider.messages[provider.messages.length - 1] = { role: 'assistant', text: `Error: ${error.message}` };
      provider.setBusy(false);
      provider.render();
      output.appendLine(`Error: ${error.message}`);
      vscode.window.showErrorMessage(`LLM Cluster request failed: ${error.message}`);
    }
  };

  const sendTaskPrompt = async (prompt, provider) => {
    const editor = vscode.window.activeTextEditor;
    const hasSelection = Boolean(editor && editor.selection && !editor.selection.isEmpty);
    const contextText = editor
      ? await chooseEditorContext(editor, 'LLM Cluster: Choose Context')
      : '';
    if (editor && !contextText) {
      return;
    }

    const workspaceRoot = getWorkspaceRootPath();
    const tools = getToolSchemas(workspaceRoot || undefined);

    let workers = [];
    try {
      workers = await fetchWorkersFromManager();
    } catch (error) {
      vscode.window.showWarningMessage(`Could not load workers: ${error.message}`);
    }

    const workerChoice = workers.length ? await chooseTaskWorker(workers) : { workerId: '' };
    if (workerChoice === null) {
      return;
    }

    if (provider) {
      provider.append('user', `${prompt}\n\nTask worker: ${workerChoice?.label || 'Auto-select best worker'}`);
      provider.append('assistant', 'Thinking...');
      provider.setBusy(true);
    }

    output.appendLine(`Sending task to manager${workerChoice?.workerId ? ` for ${workerChoice.label}` : ' (auto worker selection)'}...`);
    output.show(true);

    try {
      const messages = buildTaskMessages(editor?.document, contextText, prompt, workspaceRoot, promptStudioState);
      let accumulated = '';
      const onChunk = (chunk) => {
        accumulated += chunk;
        if (provider) {
          const lastIdx = provider.messages.length - 1;
          if (lastIdx >= 0 && provider.messages[lastIdx].role === 'assistant') {
            const prev = provider.messages[lastIdx].text;
            provider.messages[lastIdx].text = (prev === 'Thinking...' ? chunk : prev + chunk);
          }
          provider.render();
        }
        try { output.append(chunk); } catch {}
      };

      const responseText = await requestCompletion(messages, null, onChunk, {
        modeOverride: 'manager',
        preferredWorkerId: workerChoice?.workerId || '',
        agentMode: 'code',
        tools,
      });

      if (provider) {
        provider.messages[provider.messages.length - 1] = { role: 'assistant', text: responseText };
        provider.setBusy(false);
        provider.render();
      }

      output.appendLine('');
      output.appendLine(responseText);

      if (editor && hasSelection) {
        const shouldApply = await previewChangeAndConfirm({
          originalText: editor.document.getText(editor.selection),
          replacementText: responseText,
          languageId: editor.document.languageId,
          title: 'LLM Cluster: Review Incoming Changes',
        });

        if (shouldApply) {
          await editor.edit((editBuilder) => {
            editBuilder.replace(editor.selection, responseText);
          });
          output.appendLine('Changes applied.');
        } else {
          output.appendLine('Changes discarded.');
        }
      } else if (editor) {
        await showResultInEditor(responseText, editor.document.languageId);
      } else {
        await showResultInEditor(responseText, 'markdown');
      }
    } catch (error) {
      if (provider) {
        provider.messages[provider.messages.length - 1] = { role: 'assistant', text: `Error: ${error.message}` };
        provider.setBusy(false);
        provider.render();
      }
      output.appendLine(`Error: ${error.message}`);
      vscode.window.showErrorMessage(`LLM Cluster task failed: ${error.message}`);
    }
  };

  chatViewProvider = new ChatViewProvider(context, sendChatPrompt, sendTaskPrompt);
  console.log('ChatViewProvider created');

  const chatViewRegistration = vscode.window.registerWebviewViewProvider('llmCluster.chatView', chatViewProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  });
  console.log('WebviewViewProvider registered for llmCluster.chatView');

  const inlineProvider = vscode.languages.registerInlineCompletionItemProvider(
    [{ scheme: 'file' }, { scheme: 'untitled' }],
    {
      async provideInlineCompletionItems(document, position, context, token) {
        if (!getConfig().get('enableInlineCompletions', true)) {
          return [];
        }

        if (token.isCancellationRequested) {
          return [];
        }

        const fullText = document.getText();
        if (!fullText.trim()) {
          return [];
        }

        const messages = buildInlineMessages(document, position);
        const completion = await requestCompletion(messages, token);
        if (!completion) {
          return [];
        }

        const item = new vscode.InlineCompletionItem(completion, new vscode.Range(position, position));
        return { items: [item] };
      },
    }
  );

  const askCommand = vscode.commands.registerCommand('llmCluster.ask', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file first to use LLM Cluster.');
      return;
    }

    const prompt = await vscode.window.showInputBox({
      title: 'LLM Cluster: Ask',
      prompt: 'Describe what you want to do with the current file or selection',
      placeHolder: 'Refactor this function for clarity',
    });

    if (!prompt) {
      return;
    }

    const contextText = await chooseEditorContext(editor, 'LLM Cluster: Choose Context');
    if (!contextText) {
      return;
    }

    output.appendLine('Sending request to manager...');
    output.show(true);

    try {
      const messages = buildChatMessages(editor.document, contextText, prompt, promptStudioState);
      let accumulated = '';
      const onChunk = (chunk) => { accumulated += chunk; try { output.append(chunk); } catch {} };
      const responseText = await requestCompletion(messages, null, onChunk);
      output.appendLine('');
      output.appendLine(responseText);
      await showResultInEditor(responseText, editor.document.languageId);
    } catch (error) {
      output.appendLine(`Error: ${error.message}`);
      vscode.window.showErrorMessage(`LLM Cluster request failed: ${error.message}`);
    }
  });

  const sendTaskCommand = vscode.commands.registerCommand('llmCluster.sendTask', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file first to use LLM Cluster.');
      return;
    }

    const prompt = await vscode.window.showInputBox({
      title: 'LLM Cluster: Send Task',
      prompt: 'Describe the task for the local worker',
      placeHolder: 'Refactor this function and update the error handling',
    });

    if (!prompt) {
      return;
    }

    await sendTaskPrompt(prompt, null);
  });

  const sendToLocalLlmCommand = vscode.commands.registerCommand('llmCluster.sendToLocalLlm', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file first to use LLM Cluster.');
      return;
    }

    const snippetText = await chooseEditorContext(editor, 'LLM Cluster: Choose Context');
    if (!snippetText) {
      vscode.window.showInformationMessage('Select text or place the cursor on code first.');
      return;
    }

    const instruction = await vscode.window.showInputBox({
      title: 'LLM Cluster: Send to Local LLM',
      prompt: 'Optional instruction for the local LLM',
      placeHolder: 'Explain this snippet, look for bugs, or suggest improvements',
    });

    if (instruction === undefined) {
      return;
    }

    output.appendLine('Sending snippet to local LLM...');
    output.show(true);

    try {
      const messages = buildLocalLlmMessages(editor.document, snippetText, instruction);
      const onChunk = (chunk) => { try { output.append(chunk); } catch {} };
      const responseText = await requestCompletion(messages, null, onChunk, { modeOverride: 'client' });
      output.appendLine('');
      output.appendLine(responseText);
      await showResultInEditor(responseText, 'markdown');
    } catch (error) {
      output.appendLine(`Error: ${error.message}`);
      vscode.window.showErrorMessage(`LLM Cluster local LLM request failed: ${error.message}`);
    }
  });

  const generateFromSelectionCommand = vscode.commands.registerCommand('llmCluster.generateFromSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Open a file first to use LLM Cluster.');
      return;
    }

    if (editor.selection.isEmpty) {
      vscode.window.showInformationMessage('Select code first, then run Generate From Selection.');
      return;
    }

    const instruction = await vscode.window.showInputBox({
      title: 'LLM Cluster: Generate From Selection',
      prompt: 'Describe the change you want applied to the selected code',
      placeHolder: 'Convert this to async/await and improve variable names',
    });

    if (!instruction) {
      return;
    }

    const selectedText = editor.document.getText(editor.selection);
    output.appendLine('Sending selection to manager...');
    output.show(true);

    try {
      const messages = buildChatMessages(editor.document, selectedText, instruction, promptStudioState);
      let accumulated = '';
      const onChunk = (chunk) => { accumulated += chunk; try { output.append(chunk); } catch {} };
      const responseText = await requestCompletion(messages, null, onChunk);
      output.appendLine('');
      output.appendLine(responseText);

      const shouldApply = await previewChangeAndConfirm({
        originalText: selectedText,
        replacementText: responseText,
        languageId: editor.document.languageId,
        title: 'LLM Cluster: Review Incoming Changes',
      });

      if (shouldApply) {
        await editor.edit((editBuilder) => {
          editBuilder.replace(editor.selection, responseText);
        });
        output.appendLine('Changes applied.');
      } else {
        output.appendLine('Changes discarded.');
      }
    } catch (error) {
      output.appendLine(`Error: ${error.message}`);
      vscode.window.showErrorMessage(`LLM Cluster request failed: ${error.message}`);
    }
  });

  const focusChatCommand = vscode.commands.registerCommand('llmCluster.focusChat', async () => {
    await openChatSidebar();
  });

  const showPanelCommand = vscode.commands.registerCommand('llmCluster.showPanel', async () => {
    await openDashboardPanel(context);
  });

  const openPanelsCommand = vscode.commands.registerCommand('llmCluster.openPanels', async () => {
    await openDashboardPanel(context);
  });

  const saveHistoryCommand = vscode.commands.registerCommand('llmCluster.saveChatHistory', async () => {
    if (!chatViewProvider) {
      vscode.window.showErrorMessage('Chat view not available');
      return;
    }
    try {
      await context.globalState.update('llm-cluster.chatHistory', chatViewProvider.messages || []);
      vscode.window.showInformationMessage('Chat history saved');
    } catch (err) {
      vscode.window.showErrorMessage('Failed to save chat history: ' + err.message);
    }
  });

  const loadHistoryCommand = vscode.commands.registerCommand('llmCluster.loadChatHistory', async () => {
    if (!chatViewProvider) {
      vscode.window.showErrorMessage('Chat view not available');
      return;
    }
    try {
      const history = context.globalState.get('llm-cluster.chatHistory', []);
      chatViewProvider.messages = Array.isArray(history) ? history : [];
      chatViewProvider.render();
      vscode.window.showInformationMessage('Chat history loaded');
    } catch (err) {
      vscode.window.showErrorMessage('Failed to load chat history: ' + err.message);
    }
  });

  const exportHistoryCommand = vscode.commands.registerCommand('llmCluster.exportChatHistory', async () => {
    if (!chatViewProvider) {
      vscode.window.showErrorMessage('Chat view not available');
      return;
    }
    try {
      const defaultName = `llm-cluster-chat-${Date.now()}.json`;
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(getWorkspaceRootPath() || process.cwd(), defaultName)), filters: { 'JSON': ['json'] } });
      if (uri) {
        fs.writeFileSync(uri.fsPath, JSON.stringify(chatViewProvider.messages || [], null, 2), 'utf8');
        vscode.window.showInformationMessage(`Chat exported to ${uri.fsPath}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage('Export failed: ' + err.message);
    }
  });

  const importHistoryCommand = vscode.commands.registerCommand('llmCluster.importChatHistory', async () => {
    if (!chatViewProvider) {
      vscode.window.showErrorMessage('Chat view not available');
      return;
    }
    try {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'JSON': ['json'] } });
      if (uris && uris[0]) {
        const data = fs.readFileSync(uris[0].fsPath, 'utf8');
        const parsed = JSON.parse(data);
        chatViewProvider.messages = Array.isArray(parsed) ? parsed : [];
        await context.globalState.update('llm-cluster.chatHistory', chatViewProvider.messages);
        chatViewProvider.render();
        vscode.window.showInformationMessage('Chat imported');
      }
    } catch (err) {
      vscode.window.showErrorMessage('Import failed: ' + err.message);
    }
  });

  context.subscriptions.push(
    output,
    statusBarItem,
    windowStateListener,
    chatViewRegistration,
    inlineProvider,
    askCommand,
    sendTaskCommand,
    sendToLocalLlmCommand,
    generateFromSelectionCommand,
    saveHistoryCommand,
    loadHistoryCommand,
    exportHistoryCommand,
    importHistoryCommand,
    focusChatCommand,
    showPanelCommand,
    openPanelsCommand,
    {
      dispose() {
        clearInterval(refreshTimer);
      },
    }
  );

  // Auto-open Chat view on startup if enabled in configuration
  try {
    const openOnStartup = getConfig().get('openOnStartup', true);
    if (openOnStartup) {
      setTimeout(() => {
        openChatSidebar().catch(() => {});
      }, 250);
    }
  } catch (err) {
    // ignore
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};