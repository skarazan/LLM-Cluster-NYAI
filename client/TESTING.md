# Client UI tests

Install the client dependencies with `npm ci` from `client/`. The test suite uses
`@playwright/test` and Electron's bundled Chromium; no separate browser download
is required.

## Running the tests

| Command | What it runs |
|---------|--------------|
| `npm run test:unit` | Pure Node tests (`tests/unit`): design tokens and WCAG contrast, CSS hygiene, no-emoji rule, markdown parser, approval copy, window chrome per OS, helpers. No display needed. |
| `npm run test:e2e` | Electron tests (`tests/e2e`): app shell and responsive layout, approval dock, Code-mode agent flows, Chat mode, connection and menus. |
| `npm run test:ui` | Everything. |

On Linux without a display server, install Xvfb and prefix the Electron test
commands with `xvfb-run -a` (for example, `xvfb-run -a npm run test:e2e`).
macOS and Windows can run the commands as written.

The Electron tests launch **only the client**. The manager, workers and models
are never started. IPC handlers that would reach the network or open native
dialogs are replaced inside the Electron main process with scripted fakes
(`tests/helpers/app.js`):

- `launchApp({ width, height, beforeReload })` starts the client with an isolated
  profile (`LLM_CLUSTER_USER_DATA`), so localStorage and agent state never leak
  between tests.
- `fakeModel(app, steps)` swaps `send-prompt` for a scripted model. Steps support
  `chunks` (streamed tokens), `response`, `tool_calls: [{ name, args }]`, `error`,
  `delayMs`, and `waitForCancel` (resolved by the Stop button).
- `mockIpc`, `recordIpc` / `ipcCalls`, `chooseWorkspace`, `makeWorkspace`, `waitIdle`, `rect`.

The agent-flow tests drive the **real** `lib/agentLoop.js` and the real local tool
execution against a temp workspace. Only the model is fake.

## Visual checks

- For an Electron visual check on Linux, run the local Electron binary under
  Xvfb with `--no-sandbox --remote-debugging-port=9222`, then connect from a local Node
  script with `require('playwright').chromium.connectOverCDP(...)`. Or use
  `_electron.launch()` from `@playwright/test`, as `tests/helpers/app.js` does.
  The Electron window is the page whose URL starts with `file:`; call
  `page.screenshot()` to inspect the rendered UI.
- `window.LLMClusterUI` (see `UI_COMPONENTS.md` §6) lets you inject messages,
  activity rows, todos and approval requests to stage any UI state for a screenshot.
- DevTools are opt-in: `npm run start:dev` or `LLM_CLUSTER_DEVTOOLS=1`.

No browser download is required: Electron supplies the Chromium runtime used
by the client tests.
