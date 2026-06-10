'use strict';

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildWebviewHtml(vars) {
  const {
    managerUrl,
    modelName,
    currentMode,
    engineUrlEsc,
    clientUrlEsc,
    preferredWorkerId,
    preferredWorkerEndpoint,
    latestTask,
    toolCount,
    workerOptions,
    history,
    status,
    useWorkerToggleChecked,
    promptStudioState,
    promptSummary,
  } = vars;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0c1017;
      --panel: #141a24;
      --panel-2: #1a2230;
      --text: #edf2ff;
      --muted: #93a1b8;
      --border: #263246;
      --accent: #78f0b3;
      --accent-2: #71b7ff;
      --accent-3: #ffd166;
      --danger: #ff8b7f;
      --shadow: 0 24px 70px rgba(0, 0, 0, 0.4);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    body {
      margin: 0;
      padding: 14px;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(113, 183, 255, 0.16), transparent 30%),
        radial-gradient(circle at top right, rgba(120, 240, 179, 0.12), transparent 24%),
        linear-gradient(180deg, #090d13 0%, #111722 100%);
      color: var(--text);
    }
    .shell {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: calc(100vh - 28px);
    }
    .hero {
      background: linear-gradient(135deg, rgba(120, 240, 179, 0.16), rgba(113, 183, 255, 0.12));
      border: 1px solid rgba(120, 240, 179, 0.2);
      border-radius: 20px;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .title { font-size: 24px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    .subtitle { color: var(--muted); font-size: 13px; line-height: 1.5; max-width: 70ch; margin-top: 6px; }
    .status-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 12px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(10px);
    }
    .chip strong { color: var(--accent); }
    .chip.secondary strong { color: var(--accent-2); }
    .chip.warn strong { color: var(--accent-3); }
    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(280px, 0.85fr);
      gap: 14px;
      align-items: start;
      flex: 1;
      min-height: 0;
    }
    .stream, .sidebar {
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .panel {
      background: rgba(12, 16, 23, 0.72);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 14px 14px 0;
      flex-wrap: wrap;
    }
    .panel-title { font-size: 14px; font-weight: 700; letter-spacing: 0.01em; }
    .panel-subtitle { color: var(--muted); font-size: 12px; }
    .mode-switch {
      display: inline-flex;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.04);
      border-radius: 999px;
      padding: 4px;
      gap: 4px;
    }
    .mode-switch button {
      border: 0;
      background: transparent;
      color: var(--muted);
      border-radius: 999px;
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
      transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
    }
    .mode-switch button.active {
      color: var(--text);
      background: linear-gradient(135deg, rgba(120, 240, 179, 0.18), rgba(113, 183, 255, 0.18));
      box-shadow: inset 0 0 0 1px rgba(120, 240, 179, 0.18);
    }
    .mode-switch button:hover { transform: translateY(-1px); }
    .messages {
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 1;
      overflow: auto;
      padding: 14px;
      min-height: 300px;
    }
    .message {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px;
      position: relative;
    }
    .message::before {
      content: '';
      position: absolute;
      left: 0;
      top: 14px;
      bottom: 14px;
      width: 3px;
      border-radius: 999px;
      background: var(--muted);
      opacity: 0.6;
    }
    .message.user::before { background: var(--accent-2); }
    .message.assistant::before { background: var(--accent); }
    .message.system::before { background: var(--accent-3); }
    .label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin-bottom: 8px;
      padding-left: 8px;
    }
    .body {
      white-space: normal;
      line-height: 1.55;
      font-size: 13px;
      color: var(--text);
      word-break: break-word;
      padding-left: 8px;
    }
    .empty {
      padding: 18px;
      border: 1px dashed var(--border);
      border-radius: 16px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.02);
      margin: 14px;
    }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding: 14px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.03));
      border-radius: 0 0 18px 18px;
    }
    textarea {
      width: 100%;
      min-height: 110px;
      resize: vertical;
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      font: inherit;
      box-sizing: border-box;
      outline: none;
    }
    textarea:focus, input:focus, select:focus {
      border-color: rgba(120, 240, 179, 0.45);
      box-shadow: 0 0 0 3px rgba(120, 240, 179, 0.12);
    }
    .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    button {
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 999px;
      padding: 9px 14px;
      cursor: pointer;
      font: inherit;
    }
    button.primary {
      background: linear-gradient(135deg, rgba(120, 240, 179, 0.18), rgba(113, 183, 255, 0.22));
      border-color: rgba(120, 240, 179, 0.34);
    }
    button.secondary {
      background: rgba(255, 255, 255, 0.04);
    }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .meta { color: var(--muted); font-size: 11px; line-height: 1.4; }
    code {
      background: rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      padding: 2px 4px;
    }
    .stack { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
    .info-grid { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .info-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
    }
    .info-card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; }
    .info-card .v { margin-top: 6px; font-size: 13px; line-height: 1.45; }
    .workflow { display: flex; flex-direction: column; gap: 8px; }
    .workflow-step {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.03);
    }
    .workflow-step .dot {
      width: 12px;
      height: 12px;
      margin-top: 3px;
      border-radius: 50%;
      background: var(--muted);
      flex: 0 0 auto;
      box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.03);
    }
    .workflow-step.done .dot { background: var(--accent); }
    .workflow-step.active .dot { background: var(--accent-2); }
    .workflow-step.warning .dot { background: var(--accent-3); }
    .workflow-step .step-title { font-weight: 600; font-size: 13px; }
    .workflow-step .step-body { color: var(--muted); font-size: 12px; margin-top: 2px; line-height: 1.45; }
    .sidebar-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    select, input {
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      font: inherit;
    }
    .compact-note { color: var(--muted); font-size: 12px; line-height: 1.5; }
    .hidden { display: none !important; }
    .prompt-summary {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .prompt-summary .v {
      color: var(--text);
      font-size: 13px;
      line-height: 1.45;
    }
    .studio-tools {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .studio-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .studio-form input,
    .studio-form textarea,
    .studio-form select {
      width: 100%;
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      font: inherit;
      box-sizing: border-box;
      outline: none;
    }
    .studio-form textarea { min-height: 72px; resize: vertical; }
    .prompt-editor-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .skill-picker {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .skill-option {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      cursor: pointer;
    }
    .skill-option input { margin-top: 3px; accent-color: var(--accent); }
    .skill-option strong { display: block; font-size: 12px; color: var(--text); margin-bottom: 3px; }
    .skill-option small { display: block; color: var(--muted); font-size: 11px; line-height: 1.4; }
    .skill-option.selected { border-color: rgba(120, 240, 179, 0.45); box-shadow: inset 0 0 0 1px rgba(120, 240, 179, 0.14); }
    .skill-option.disabled { opacity: 0.6; }
    .studio-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 260px;
      overflow: auto;
    }
    .studio-item {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .studio-item-title { font-size: 13px; font-weight: 700; color: var(--text); }
    .studio-item-body { font-size: 12px; line-height: 1.45; color: var(--muted); white-space: pre-wrap; }
    .studio-item-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .studio-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(120, 240, 179, 0.12);
      border: 1px solid rgba(120, 240, 179, 0.2);
      color: var(--accent);
      font-size: 11px;
    }
    .studio-tag.muted {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.08);
      color: var(--muted);
    }
    .prompt-skill-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .empty-state {
      border: 1px dashed var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.02);
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      padding: 12px;
    }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: 1fr; }
      .info-grid { grid-template-columns: 1fr; }
      .skill-picker { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div class="hero-top">
        <div>
          <h1 class="title">LLM Cluster Agent</h1>
          <div class="subtitle">A VS Code agent-style workspace for chat, task execution, worker routing, and code responses. Connected to <code>${managerUrl}</code>.</div>
        </div>
        <div class="status-row">
          <div class="chip"><strong>${status}</strong></div>
          <div class="chip secondary"><strong>${modelName}</strong></div>
          <div class="chip warn"><strong>${toolCount}</strong> tools</div>
        </div>
      </div>
    </div>

    <div class="workspace">
      <section class="stream panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Conversation</div>
            <div class="panel-subtitle">Switch between chat and agent flow without leaving the panel.</div>
          </div>
          <div class="mode-switch" role="tablist" aria-label="Panel mode">
            <button id="modeChat" type="button">Chat</button>
            <button id="modeAgent" type="button">Agent</button>
          </div>
        </div>

        <div class="messages">${history}</div>

        <div class="composer">
          <textarea id="prompt" placeholder="Ask a question, request a refactor, or describe a task for the agent..."></textarea>
          <div class="actions">
            <label class="secondary" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;" title="Let the model search the web (needs SearXNG on the manager)"><input type="checkbox" id="webSearch" /> Web</label>
            <button id="clear" class="secondary">Clear</button>
            <button id="task" class="secondary">Agent</button>
            <button id="send" class="primary">Send</button>
            <button id="saveChat" class="secondary">Save</button>
            <button id="loadChat" class="secondary">Load</button>
            <button id="exportChat" class="secondary">Export</button>
            <button id="importChat" class="secondary">Import</button>
          </div>
          <div class="meta">Chat mode sends a prompt. Agent mode routes through task execution with workspace context and tools.</div>
        </div>
      </section>

      <aside class="sidebar">
        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">Agent Snapshot</div>
              <div class="panel-subtitle">Current run state and execution settings.</div>
            </div>
          </div>
          <div class="stack">
            <div class="info-grid">
              <div class="info-card"><div class="k">Invocation</div><div class="v"><code>${currentMode}</code></div></div>
              <div class="info-card"><div class="k">Worker</div><div class="v"><code>${preferredWorkerId || 'auto'}</code></div></div>
              <div class="info-card"><div class="k">Endpoint</div><div class="v"><code>${preferredWorkerEndpoint || 'none'}</code></div></div>
              <div class="info-card"><div class="k">Task</div><div class="v">${latestTask ? latestTask : 'No task yet. Use Agent mode to start one.'}</div></div>
            </div>

            <div class="workflow">
              <div class="workflow-step done">
                <div class="dot"></div>
                <div><div class="step-title">1. Receive request</div><div class="step-body">Capture the prompt, file context, and current workspace scope.</div></div>
              </div>
              <div class="workflow-step active">
                <div class="dot"></div>
                <div><div class="step-title">2. Route through the manager</div><div class="step-body">Choose the target worker or let the manager auto-pick one.</div></div>
              </div>
              <div class="workflow-step">
                <div class="dot"></div>
                <div><div class="step-title">3. Execute with tools</div><div class="step-body">The manager can receive tool schemas and return a code-focused result.</div></div>
              </div>
              <div class="workflow-step warning">
                <div class="dot"></div>
                <div><div class="step-title">4. Verify output</div><div class="step-body">Review the response, then apply the generated code or keep iterating.</div></div>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">Workers</div>
              <div class="panel-subtitle">Pick a target worker or refresh the roster.</div>
            </div>
          </div>
          <div class="stack">
            <div class="sidebar-actions">
              <label style="display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;flex:1;min-width:180px">
                <span>Worker</span>
                <select id="workerSelect" style="flex:1;min-width:140px">${workerOptions}</select>
              </label>
              <button id="refreshWorkers">Refresh</button>
            </div>
            <label style="color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="useWorkerEndpoint" ${useWorkerToggleChecked} />
              Use worker endpoint for direct calls
            </label>
            <div class="compact-note">Preferred worker id: <code>${preferredWorkerId || 'none'}</code></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">LLM Commands</div>
              <div class="panel-subtitle">Right-click a command for quick actions.</div>
            </div>
          </div>
          <div class="stack">
            <div id="cmdList" class="cmd-list"></div>
            <div id="cmdContextMenu" class="hidden" style="position:fixed;z-index:9999;background:var(--panel);border:1px solid var(--border);padding:8px;border-radius:8px;">
              <button id="cmdExecute" class="secondary">Execute</button>
              <button id="cmdCopy" class="secondary">Copy</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">Connection</div>
              <div class="panel-subtitle">Update runtime URLs without leaving VS Code.</div>
            </div>
          </div>
          <div class="stack">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <label style="display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;flex:1;min-width:180px">
                <span>Invocation mode</span>
                <select id="modeSelect" style="flex:1;min-width:140px">
                  <option value="manager" ${currentMode === 'manager' ? 'selected' : ''}>manager</option>
                  <option value="direct" ${currentMode === 'direct' ? 'selected' : ''}>direct</option>
                  <option value="client" ${currentMode === 'client' ? 'selected' : ''}>client</option>
                  <option value="LLM Cluster" ${currentMode === 'LLM Cluster' ? 'selected' : ''}>LLM Cluster</option>
                </select>
              </label>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input id="engineUrl" placeholder="Engine URL (direct mode)" value="${engineUrlEsc}" style="flex:1;min-width:180px" />
              <button id="saveEngine">Save</button>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input id="clientUrl" placeholder="Local app URL" value="${clientUrlEsc}" style="flex:1;min-width:180px" />
              <button id="saveClient">Save</button>
            </div>
            <div class="compact-note">The webview mirrors the same manager API used by inline completions and task routing.</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">Prompt Studio</div>
              <div class="panel-subtitle">Create prompt presets and skills, then choose the defaults.</div>
            </div>
          </div>
          <div class="stack">
            <div class="info-grid">
              <div class="info-card prompt-summary">
                <div class="k">Active prompt</div>
                <div class="v" id="promptSummaryValue">${escapeHtml(promptSummary?.promptName || 'General Assistant')}</div>
              </div>
              <div class="info-card prompt-summary">
                <div class="k">Selected skills</div>
                <div class="v" id="skillSummaryValue">${escapeHtml(String(promptSummary?.skillCount ?? 0))}</div>
              </div>
            </div>

            <div class="studio-form">
              <label style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px">
                <span>Default for chat</span>
                <select id="chatPromptDefault"></select>
              </label>
              <label style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px">
                <span>Default for code</span>
                <select id="codePromptDefault"></select>
              </label>
            </div>

            <div class="studio-form">
              <input id="promptName" placeholder="Prompt preset name" />
              <textarea id="promptInstruction" placeholder="Instruction for this preset"></textarea>
              <div class="prompt-editor-meta">
                <div class="compact-note">Pick the skills this prompt should attach to the agent.</div>
                <div class="studio-tools">
                  <button id="selectAllPromptSkills" type="button" class="secondary">Select All</button>
                  <button id="clearPromptSkills" type="button" class="secondary">Clear</button>
                </div>
              </div>
              <div id="promptSkillPicker" class="skill-picker"></div>
              <div class="studio-tools">
                <button id="savePrompt" type="button">Save Prompt</button>
                <button id="cancelPromptEdit" type="button" class="secondary">Cancel</button>
              </div>
            </div>

            <div id="promptList" class="studio-list"></div>

            <div class="studio-form">
              <input id="skillName" placeholder="Skill name" />
              <textarea id="skillInstruction" placeholder="What should this skill teach the agent to do?"></textarea>
              <div class="studio-tools">
                <button id="saveSkill" type="button">Save Skill</button>
                <button id="cancelSkillEdit" type="button" class="secondary">Cancel</button>
              </div>
            </div>

            <div id="skillList" class="studio-list"></div>
          </div>
        </section>
      </aside>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const initialState = vscode.getState() || {};
    let panelMode = initialState.panelMode || 'agent';
    const initialPromptStudioState = initialState.promptStudio || ${jsonForScript(promptStudioState || {})};
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const clear = document.getElementById('clear');
    const task = document.getElementById('task');
    const saveChatBtn = document.getElementById('saveChat');
    const loadChatBtn = document.getElementById('loadChat');
    const exportChatBtn = document.getElementById('exportChat');
    const importChatBtn = document.getElementById('importChat');
    const modeSelect = document.getElementById('modeSelect');
    const modeChat = document.getElementById('modeChat');
    const modeAgent = document.getElementById('modeAgent');
    const workerSelect = document.getElementById('workerSelect');
    const refreshWorkers = document.getElementById('refreshWorkers');
    const engineUrlInput = document.getElementById('engineUrl');
    const clientUrlInput = document.getElementById('clientUrl');
    const saveEngine = document.getElementById('saveEngine');
    const saveClient = document.getElementById('saveClient');
    const useWorkerToggle = document.getElementById('useWorkerEndpoint');
    const promptSummaryValue = document.getElementById('promptSummaryValue');
    const skillSummaryValue = document.getElementById('skillSummaryValue');
    const chatPromptDefault = document.getElementById('chatPromptDefault');
    const codePromptDefault = document.getElementById('codePromptDefault');
    const promptName = document.getElementById('promptName');
    const promptInstruction = document.getElementById('promptInstruction');
    const promptSkillPicker = document.getElementById('promptSkillPicker');
    const selectAllPromptSkills = document.getElementById('selectAllPromptSkills');
    const clearPromptSkills = document.getElementById('clearPromptSkills');
    const savePrompt = document.getElementById('savePrompt');
    const cancelPromptEdit = document.getElementById('cancelPromptEdit');
    const promptList = document.getElementById('promptList');
    const skillName = document.getElementById('skillName');
    const skillInstruction = document.getElementById('skillInstruction');
    const saveSkill = document.getElementById('saveSkill');
    const cancelSkillEdit = document.getElementById('cancelSkillEdit');
    const skillList = document.getElementById('skillList');
    const cmdList = document.getElementById('cmdList');
    const cmdContextMenu = document.getElementById('cmdContextMenu');
    const cmdExecute = document.getElementById('cmdExecute');
    const cmdCopy = document.getElementById('cmdCopy');

    let promptStudioState = normalizePromptState(initialPromptStudioState);
    let editingPromptId = '';
    let editingSkillId = '';
    let promptSkillSelection = [];

    function post(type, extra = {}) {
      vscode.postMessage({ type, ...extra });
    }

    const availableCommands = [
      { id: 'llmCluster.ask', label: 'Ask' },
      { id: 'llmCluster.sendTask', label: 'Send Task' },
      { id: 'llmCluster.sendToLocalLlm', label: 'Send to Local LLM' },
      { id: 'llmCluster.generateFromSelection', label: 'Generate From Selection' },
      { id: 'llmCluster.saveChatHistory', label: 'Save Chat History' },
      { id: 'llmCluster.loadChatHistory', label: 'Load Chat History' },
      { id: 'llmCluster.exportChatHistory', label: 'Export Chat History' },
      { id: 'llmCluster.importChatHistory', label: 'Import Chat History' },
      { id: 'llmCluster.focusChat', label: 'Focus Chat' }
    ];

    function renderCommandList() {
      if (!cmdList) return;
      cmdList.innerHTML = availableCommands.map((c) => '<div class="cmd-item" data-cmd="' + escapeHtml(c.id) + '">' + escapeHtml(c.label) + '</div>').join('');
    }

    let currentCmdId = '';
    function hideCmdMenu() { if (cmdContextMenu) cmdContextMenu.classList.add('hidden'); }
    function showCmdMenu(x, y) {
      if (!cmdContextMenu) return;
      cmdContextMenu.style.left = x + 'px';
      cmdContextMenu.style.top = y + 'px';
      cmdContextMenu.classList.remove('hidden');
    }

    document.addEventListener('click', (e) => { hideCmdMenu(); });
    if (cmdList) {
      cmdList.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const target = ev.target.closest('.cmd-item');
        if (!target) return;
        currentCmdId = target.dataset.cmd || '';
        showCmdMenu(ev.clientX, ev.clientY);
      });
      cmdList.addEventListener('dblclick', (ev) => {
        const target = ev.target.closest('.cmd-item');
        if (!target) return;
        const cid = target.dataset.cmd;
        post('executeLLMCommand', { command: cid });
      });
    }

    if (cmdExecute) {
      cmdExecute.addEventListener('click', () => {
        if (currentCmdId) post('executeLLMCommand', { command: currentCmdId });
        hideCmdMenu();
      });
    }
    if (cmdCopy) {
      cmdCopy.addEventListener('click', () => {
        if (currentCmdId) post('copyLLMCommand', { text: currentCmdId });
        hideCmdMenu();
      });
    }

    renderCommandList();

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function normalizePromptState(state) {
      const source = state && typeof state === 'object' ? state : {};
      const skills = Array.isArray(source.skills) ? source.skills : [];
      const normalizedSkills = skills.length
        ? skills.map((item, index) => ({
            id: String(item.id || 'skill-' + index).trim(),
            name: String(item.name || 'Skill ' + (index + 1)).trim(),
            instruction: String(item.instruction || '').trim(),
            enabled: item.enabled !== false,
          }))
        : [
            { id: 'debugging', name: 'Debugging', instruction: 'Investigate failures from the smallest reproducible anchor and validate changes with a focused check.', enabled: true },
            { id: 'code-editing', name: 'Code Editing', instruction: 'Make the smallest possible edit that solves the problem at the root cause.', enabled: true },
            { id: 'testing', name: 'Testing', instruction: 'Run or suggest the cheapest validation step after each meaningful code change.', enabled: true },
          ];
      const defaults = source.defaults && typeof source.defaults === 'object' ? source.defaults : {};
      const validSkillIds = new Set(normalizedSkills.map((item) => item.id));
      const enabledSkillIds = normalizedSkills.filter((item) => item.enabled !== false).map((item) => item.id);
      const promptSource = Array.isArray(source.prompts) && source.prompts.length
        ? source.prompts
        : [
            { id: 'general-assistant', name: 'General Assistant', instruction: 'Be direct, helpful, and careful. Ask clarifying questions when the request is ambiguous.', enabled: true, skillIds: ['debugging'] },
            { id: 'code-reviewer', name: 'Code Reviewer', instruction: 'Focus on correctness, regressions, edge cases, and missing tests. Prioritize concrete findings.', enabled: true, skillIds: ['debugging', 'testing'] },
          ];

      const normalizedPrompts = promptSource.map((item, index) => ({
        id: String(item.id || 'prompt-' + index).trim(),
        name: String(item.name || 'Prompt ' + (index + 1)).trim(),
        instruction: String(item.instruction || '').trim(),
        enabled: item.enabled !== false,
        skillIds: Array.isArray(item.skillIds)
          ? [...new Set(item.skillIds.map((skillId) => String(skillId || '').trim()).filter((skillId) => skillId && validSkillIds.has(skillId)))]
          : (enabledSkillIds.length ? enabledSkillIds : normalizedSkills.map((skillItem) => skillItem.id)),
      }));

      const promptIds = new Set(normalizedPrompts.map((item) => item.id));
      const chatPromptId = promptIds.has(defaults.chatPromptId) ? defaults.chatPromptId : normalizedPrompts[0].id;
      const codePromptId = promptIds.has(defaults.codePromptId) ? defaults.codePromptId : normalizedPrompts[Math.min(1, normalizedPrompts.length - 1)].id;

      return {
        prompts: normalizedPrompts,
        skills: normalizedSkills,
        defaults: { chatPromptId, codePromptId },
      };
    }

    function getDefaultPromptSkillSelection() {
      return promptStudioState.skills.filter((skill) => skill.enabled !== false).map((skill) => skill.id);
    }

    function sanitizePromptSkillSelection(skillIds) {
      const validSkillIds = new Set(promptStudioState.skills.map((skill) => skill.id));
      const seen = new Set();
      return (Array.isArray(skillIds) ? skillIds : [])
        .map((skillId) => String(skillId || '').trim())
        .filter((skillId) => skillId && validSkillIds.has(skillId) && !seen.has(skillId) && seen.add(skillId));
    }

    function syncPromptSkillSelection(nextSelection) {
      promptSkillSelection = sanitizePromptSkillSelection(nextSelection);
    }

    function savePromptState() {
      promptStudioState = normalizePromptState(promptStudioState);
      promptSkillSelection = sanitizePromptSkillSelection(promptSkillSelection);
      vscode.setState({ ...initialState, panelMode, promptStudio: promptStudioState });
      post('setPromptStudioState', { state: promptStudioState });
      renderPromptStudio();
    }

    function promptOptions(selectedId) {
      return promptStudioState.prompts.map((promptItem) => {
        const selected = promptItem.id === selectedId ? 'selected' : '';
        return '<option value="' + escapeHtml(promptItem.id) + '" ' + selected + '>' + escapeHtml(promptItem.name) + '</option>';
      }).join('');
    }

    function renderPromptStudio() {
      const enabledSkills = promptStudioState.skills.filter((skill) => skill.enabled !== false);
      if (promptSummaryValue) {
        const activePrompt = promptStudioState.prompts.find((item) => item.id === promptStudioState.defaults[panelMode === 'agent' ? 'codePromptId' : 'chatPromptId']) || promptStudioState.prompts[0];
        const selectedSkills = activePrompt
          ? (activePrompt.skillIds || []).map((skillId) => promptStudioState.skills.find((skill) => skill.id === skillId)).filter(Boolean)
          : [];
        promptSummaryValue.textContent = activePrompt
          ? activePrompt.name + (selectedSkills.length ? ' • ' + selectedSkills.map((skill) => skill.name).join(', ') : ' • No skills')
          : 'None';
      }
      if (skillSummaryValue) {
        skillSummaryValue.textContent = enabledSkills.length + ' available';
      }
      if (chatPromptDefault) {
        chatPromptDefault.innerHTML = promptOptions(promptStudioState.defaults.chatPromptId);
        chatPromptDefault.value = promptStudioState.defaults.chatPromptId;
      }
      if (codePromptDefault) {
        codePromptDefault.innerHTML = promptOptions(promptStudioState.defaults.codePromptId);
        codePromptDefault.value = promptStudioState.defaults.codePromptId;
      }

      if (promptList) {
        promptList.innerHTML = promptStudioState.prompts.map((promptItem) => {
          const selectedSkillNames = (promptItem.skillIds || [])
            .map((skillId) => promptStudioState.skills.find((skill) => skill.id === skillId))
            .filter(Boolean)
            .map((skill) => skill.name);
          const badges = [
            promptItem.id === promptStudioState.defaults.chatPromptId ? '<span class="studio-tag">Chat default</span>' : '',
            promptItem.id === promptStudioState.defaults.codePromptId ? '<span class="studio-tag">Code default</span>' : '',
            promptItem.enabled ? '<span class="studio-tag">Enabled</span>' : '<span class="studio-tag">Disabled</span>',
          ].filter(Boolean).join(' ');
          return '<div class="studio-item">'
            + '<div>'
            + '<div class="studio-item-title">' + escapeHtml(promptItem.name) + '</div>'
            + '<div class="studio-item-body">' + escapeHtml(promptItem.instruction || '') + '</div>'
            + '<div class="prompt-skill-summary">' + (selectedSkillNames.length
              ? selectedSkillNames.map((skillName) => '<span class="studio-tag">' + escapeHtml(skillName) + '</span>').join('')
              : '<span class="studio-tag muted">No skills selected</span>') + '</div>'
            + '</div>'
            + '<div>' + badges + '</div>'
            + '<div class="studio-item-actions">'
            + '<button type="button" data-action="toggle-prompt" data-id="' + escapeHtml(promptItem.id) + '">' + (promptItem.enabled ? 'Disable' : 'Enable') + '</button>'
            + '<button type="button" data-action="edit-prompt" data-id="' + escapeHtml(promptItem.id) + '">Edit</button>'
            + '<button type="button" data-action="chat-default" data-id="' + escapeHtml(promptItem.id) + '">Chat Default</button>'
            + '<button type="button" data-action="code-default" data-id="' + escapeHtml(promptItem.id) + '">Code Default</button>'
            + '<button type="button" data-action="delete-prompt" data-id="' + escapeHtml(promptItem.id) + '">Delete</button>'
            + '</div>'
            + '</div>';
        }).join('') || '<div class="studio-item"><div class="studio-item-body">No prompts yet.</div></div>';
      }

      if (promptSkillPicker) {
        const currentSelection = sanitizePromptSkillSelection(promptSkillSelection);
        promptSkillPicker.innerHTML = promptStudioState.skills.length
          ? promptStudioState.skills.map((skillItem) => {
              const selected = currentSelection.includes(skillItem.id) ? 'selected' : '';
              const checked = currentSelection.includes(skillItem.id) ? 'checked' : '';
              const disabledClass = skillItem.enabled === false ? 'disabled' : '';
              const disabledAttr = skillItem.enabled === false ? 'disabled="disabled"' : '';
              return '<label class="skill-option ' + selected + ' ' + disabledClass + '">'
                + '<input type="checkbox" value="' + escapeHtml(skillItem.id) + '" ' + checked + ' ' + disabledAttr + ' />'
                + '<span>'
                + '<strong>' + escapeHtml(skillItem.name) + '</strong>'
                + '<small>' + escapeHtml(skillItem.instruction || 'No description') + '</small>'
                + '</span>'
                + '</label>';
            }).join('')
          : '<div class="empty-state">Create a skill first, then assign it to a prompt.</div>';
      }

      if (skillList) {
        skillList.innerHTML = promptStudioState.skills.map((skillItem) => {
          const skillBadge = skillItem.enabled ? '<span class="studio-tag">Enabled</span>' : '<span class="studio-tag">Disabled</span>';
          return '<div class="studio-item">'
            + '<div>'
            + '<div class="studio-item-title">' + escapeHtml(skillItem.name) + '</div>'
            + '<div class="studio-item-body">' + escapeHtml(skillItem.instruction || '') + '</div>'
            + '</div>'
            + '<div>' + skillBadge + '</div>'
            + '<div class="studio-item-actions">'
            + '<button type="button" data-action="toggle-skill" data-id="' + escapeHtml(skillItem.id) + '">' + (skillItem.enabled ? 'Disable' : 'Enable') + '</button>'
            + '<button type="button" data-action="edit-skill" data-id="' + escapeHtml(skillItem.id) + '">Edit</button>'
            + '<button type="button" data-action="delete-skill" data-id="' + escapeHtml(skillItem.id) + '">Delete</button>'
            + '</div>'
            + '</div>';
        }).join('') || '<div class="studio-item"><div class="studio-item-body">No skills yet.</div></div>';
      }

      if (cancelPromptEdit) {
        cancelPromptEdit.classList.toggle('hidden', !editingPromptId);
      }
      if (cancelSkillEdit) {
        cancelSkillEdit.classList.toggle('hidden', !editingSkillId);
      }
    }

    function startPromptEdit(promptId) {
      const item = promptStudioState.prompts.find((promptItem) => promptItem.id === promptId);
      if (!item) return;
      editingPromptId = item.id;
      promptName.value = item.name;
      promptInstruction.value = item.instruction;
      syncPromptSkillSelection(item.skillIds || getDefaultPromptSkillSelection());
      renderPromptStudio();
    }

    function startSkillEdit(skillId) {
      const item = promptStudioState.skills.find((skillItem) => skillItem.id === skillId);
      if (!item) return;
      editingSkillId = item.id;
      skillName.value = item.name;
      skillInstruction.value = item.instruction;
      renderPromptStudio();
    }

    function clearPromptEdit() {
      editingPromptId = '';
      promptName.value = '';
      promptInstruction.value = '';
      syncPromptSkillSelection(getDefaultPromptSkillSelection());
      renderPromptStudio();
    }

    function clearSkillEdit() {
      editingSkillId = '';
      skillName.value = '';
      skillInstruction.value = '';
      renderPromptStudio();
    }

    function savePromptFromForm() {
      const name = promptName.value.trim();
      const instruction = promptInstruction.value.trim();
      if (!name || !instruction) return;
      const next = normalizePromptState(promptStudioState);
      const selectedSkillIds = sanitizePromptSkillSelection(promptSkillSelection);
      const existingIndex = next.prompts.findIndex((item) => item.id === editingPromptId);
      const existingEnabled = existingIndex >= 0 ? next.prompts[existingIndex].enabled : true;
      const item = { id: editingPromptId || ('prompt-' + Date.now().toString(36)), name, instruction, enabled: existingEnabled, skillIds: selectedSkillIds };
      if (existingIndex >= 0) {
        next.prompts.splice(existingIndex, 1, item);
      } else {
        next.prompts.push(item);
      }
      if (!next.defaults.chatPromptId || !next.prompts.some((promptItem) => promptItem.id === next.defaults.chatPromptId)) {
        next.defaults.chatPromptId = item.id;
      }
      if (!next.defaults.codePromptId || !next.prompts.some((promptItem) => promptItem.id === next.defaults.codePromptId)) {
        next.defaults.codePromptId = item.id;
      }
      promptStudioState = next;
      editingPromptId = '';
      syncPromptSkillSelection(getDefaultPromptSkillSelection());
      promptName.value = '';
      promptInstruction.value = '';
      savePromptState();
    }

    function saveSkillFromForm() {
      const name = skillName.value.trim();
      const instruction = skillInstruction.value.trim();
      if (!name || !instruction) return;
      const next = normalizePromptState(promptStudioState);
      const existingIndex = next.skills.findIndex((item) => item.id === editingSkillId);
      const existingEnabled = existingIndex >= 0 ? next.skills[existingIndex].enabled : true;
      const item = { id: editingSkillId || ('skill-' + Date.now().toString(36)), name, instruction, enabled: existingEnabled };
      if (existingIndex >= 0) {
        next.skills.splice(existingIndex, 1, item);
      } else {
        next.skills.push(item);
      }
      promptStudioState = next;
      editingSkillId = '';
      skillName.value = '';
      skillInstruction.value = '';
      savePromptState();
    }

    function syncPanelMode() {
      const isAgent = panelMode === 'agent';
      modeChat.classList.toggle('active', !isAgent);
      modeAgent.classList.toggle('active', isAgent);
      send.textContent = isAgent ? 'Run Agent' : 'Send';
      task.textContent = isAgent ? 'Ask' : 'Agent';
      task.title = isAgent ? 'Switch to chat-style prompt flow' : 'Switch to agent task flow';
      prompt.placeholder = isAgent
        ? 'Describe the task, the files to inspect, or the change you want the agent to execute...'
        : 'Ask a question or request a quick response...';
      vscode.setState({ ...initialState, panelMode });
      renderPromptStudio();
    }

    function setPanelMode(next) {
      panelMode = next;
      syncPanelMode();
    }

    const webSearchToggle = document.getElementById('webSearch');
    const webSearchOn = () => Boolean(webSearchToggle && webSearchToggle.checked);

    send.addEventListener('click', () => {
      const value = prompt.value.trim();
      if (!value) {
        return;
      }
      post(panelMode === 'agent' ? 'sendTask' : 'sendPrompt', { prompt: value, webSearch: webSearchOn() });
      prompt.value = '';
    });

    task.addEventListener('click', () => {
      const value = prompt.value.trim();
      if (!value) {
        return;
      }
      post(panelMode === 'agent' ? 'sendPrompt' : 'sendTask', { prompt: value, webSearch: webSearchOn() });
      prompt.value = '';
    });

    modeChat.addEventListener('click', () => setPanelMode('chat'));
    modeAgent.addEventListener('click', () => setPanelMode('agent'));

    clear.addEventListener('click', () => post('clearChat'));

    if (saveChatBtn) saveChatBtn.addEventListener('click', () => post('saveChat'));
    if (loadChatBtn) loadChatBtn.addEventListener('click', () => post('loadChat'));
    if (exportChatBtn) exportChatBtn.addEventListener('click', () => post('exportChat'));
    if (importChatBtn) importChatBtn.addEventListener('click', () => post('importChat'));

    modeSelect.addEventListener('change', () => {
      post('setMode', { mode: modeSelect.value });
    });

    workerSelect.addEventListener('change', () => {
      if (workerSelect.value) {
        post('selectWorker', { workerId: workerSelect.value });
      }
    });

    refreshWorkers.addEventListener('click', () => post('refreshWorkers'));

    saveEngine.addEventListener('click', () => {
      post('setEngineUrl', { url: engineUrlInput.value.trim() });
    });
    if (useWorkerToggle) {
      useWorkerToggle.addEventListener('change', () => {
        post('setUseWorkerEndpoint', { enabled: useWorkerToggle.checked });
      });
    }
    saveClient.addEventListener('click', () => {
      post('setClientProxyUrl', { url: clientUrlInput.value.trim() });
    });

    if (chatPromptDefault) {
      chatPromptDefault.addEventListener('change', () => {
        promptStudioState.defaults.chatPromptId = chatPromptDefault.value;
        savePromptState();
      });
    }

    if (codePromptDefault) {
      codePromptDefault.addEventListener('change', () => {
        promptStudioState.defaults.codePromptId = codePromptDefault.value;
        savePromptState();
      });
    }

    if (savePrompt) {
      savePrompt.addEventListener('click', savePromptFromForm);
    }
    if (saveSkill) {
      saveSkill.addEventListener('click', saveSkillFromForm);
    }
    if (cancelPromptEdit) {
      cancelPromptEdit.addEventListener('click', clearPromptEdit);
    }
    if (cancelSkillEdit) {
      cancelSkillEdit.addEventListener('click', clearSkillEdit);
    }

    if (promptSkillPicker) {
      promptSkillPicker.addEventListener('change', (event) => {
        if (event.target && event.target.matches('input[type="checkbox"]')) {
          const selectedIds = Array.from(promptSkillPicker.querySelectorAll('input[type="checkbox"]:checked')).map((checkbox) => checkbox.value);
          syncPromptSkillSelection(selectedIds);
          renderPromptStudio();
        }
      });
    }

    if (selectAllPromptSkills) {
      selectAllPromptSkills.addEventListener('click', () => {
        syncPromptSkillSelection(promptStudioState.skills.map((skill) => skill.id));
        renderPromptStudio();
      });
    }

    if (clearPromptSkills) {
      clearPromptSkills.addEventListener('click', () => {
        syncPromptSkillSelection([]);
        renderPromptStudio();
      });
    }

    if (promptList) {
      promptList.addEventListener('click', (event) => {
        const action = event.target?.dataset?.action;
        const id = event.target?.dataset?.id;
        if (!action || !id) return;
        if (action === 'toggle-prompt') {
          promptStudioState.prompts = promptStudioState.prompts.map((item) => (
            item.id === id ? { ...item, enabled: !item.enabled } : item
          ));
          savePromptState();
        } else if (action === 'edit-prompt') {
          startPromptEdit(id);
        } else if (action === 'chat-default') {
          promptStudioState.defaults.chatPromptId = id;
          savePromptState();
        } else if (action === 'code-default') {
          promptStudioState.defaults.codePromptId = id;
          savePromptState();
        } else if (action === 'delete-prompt') {
          promptStudioState.prompts = promptStudioState.prompts.filter((item) => item.id !== id);
          if (editingPromptId === id) {
            editingPromptId = '';
            syncPromptSkillSelection(getDefaultPromptSkillSelection());
          }
          if (!promptStudioState.prompts.length) {
            promptStudioState = normalizePromptState({});
            syncPromptSkillSelection(getDefaultPromptSkillSelection());
          }
          if (!promptStudioState.prompts.some((item) => item.id === promptStudioState.defaults.chatPromptId)) {
            promptStudioState.defaults.chatPromptId = promptStudioState.prompts[0]?.id || '';
          }
          if (!promptStudioState.prompts.some((item) => item.id === promptStudioState.defaults.codePromptId)) {
            promptStudioState.defaults.codePromptId = promptStudioState.prompts[0]?.id || '';
          }
          savePromptState();
        }
      });
    }

    if (skillList) {
      skillList.addEventListener('click', (event) => {
        const action = event.target?.dataset?.action;
        const id = event.target?.dataset?.id;
        if (!action || !id) return;
        if (action === 'toggle-skill') {
          promptStudioState.skills = promptStudioState.skills.map((item) => (
            item.id === id ? { ...item, enabled: !item.enabled } : item
          ));
          savePromptState();
        } else if (action === 'edit-skill') {
          startSkillEdit(id);
        } else if (action === 'delete-skill') {
          promptStudioState.skills = promptStudioState.skills.filter((item) => item.id !== id);
          if (editingSkillId === id) {
            editingSkillId = '';
          }
          savePromptState();
        }
      });
    }

    prompt.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        send.click();
      }
    });

    syncPromptSkillSelection(getDefaultPromptSkillSelection());
    syncPanelMode();
    renderPromptStudio();
  </script>
</body>
</html>`;
}

module.exports = { buildWebviewHtml };
