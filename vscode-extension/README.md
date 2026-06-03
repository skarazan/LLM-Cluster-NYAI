# LLM Cluster VS Code Extension

This extension connects VS Code to the local LLM Cluster manager so you can get inline code completions and basic coding commands from the editor.

## Features

- Ghost-text completions powered by the manager's `/chat` endpoint.
- `LLM Cluster: Ask` to query the model from the current file.
- `LLM Cluster: Send Task` to route a task through the manager to a chosen local worker using the same code-agent tool schema flow as the desktop client.
- `LLM Cluster: Send to Local LLM` to hand selected text or nearby code snippets to your local desktop/web app.
- `LLM Cluster: Generate From Selection` to rewrite selected code.
- When you run Ask, Send Task, or Send to Local LLM, you can choose whether to send selected code, the current line, nearby code, or a file excerpt as context.
- When Send Task or Generate From Selection produces code changes, the extension opens a diff preview first so you can Accept or Discard the incoming changes.
- The Chat sidebar now includes a Prompt Studio where you can create prompt presets, assign skills to each prompt, and choose default prompts for chat and code mode.
- A sidebar chat panel in the activity bar for longer conversations.
- Status bar indicator for the configured manager URL.

## Setup

## Configuration

- `llmCluster.managerUrl` defaults to `http://localhost:3000`
- `llmCluster.model` defaults to `Qwen 2.5 Coder 7B`
- `llmCluster.enableInlineCompletions` enables ghost-text suggestions
- `llmCluster.maxContextChars` controls how much prefix context is sent around the cursor
- `llmCluster.maxSuffixChars` controls how much suffix context is sent after the cursor
- `llmCluster.clientProxyUrl` points at the local app endpoint used by client mode and Send to Local LLM

The task workflow lets you pick a worker from the manager's worker list, then sends the job through the manager so the local worker still receives it from the cluster scheduler.
Send Task can run with or without an active editor tab. If no editor is open, it still sends workspace-root task context to the manager.

## Packaging Notes

- `npm run check` validates the extension entry point with Node.
- `npm run package` runs `@vscode/vsce package`.
- The debug launch configuration uses the extension host so you can test the sidebar and inline completions locally.
