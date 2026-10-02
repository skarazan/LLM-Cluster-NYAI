# LLM Cluster Chat — UI Component Logbook

The single reference for **every UI building block** in the desktop client: the design
tokens, each component's markup, states, JS API and keyboard behaviour, and the Electron
surfaces it relies on. Read this before adding a new tab, panel or dialog so that it looks
and behaves like the rest of the app on Windows, macOS and Linux.

> **Stack:** Electron 41 + plain DOM. There is **no React** (and no build step). Components
> are small factory functions that return `HTMLElement`s, styled by CSS classes. Each entry
> lists its props, so it maps 1:1 onto a React/Vue component if you migrate later.

---

## 0. File map

| Path | What lives there |
|------|------------------|
| `main.js` | Electron main process: window creation, IPC handlers, tool execution |
| `lib/windowChrome.js` | Title-bar / window options per OS, DevTools gating, external-URL allow-list |
| `lib/agentLoop.js` | Code agent. UI hooks only: `showApprovalCard`, `showPlanApproval`, `appendThinkingBlock`, todo refresh |
| `renderer/index.html` | App shell markup (title bar, transcript, composer, side panel, popover layer) |
| `renderer/renderer.js` | Controller: wires DOM ↔ IPC ↔ agent loop. Exposes `window.LLMClusterUI` |
| `renderer/style.css` | Entry stylesheet — only `@import`s, in cascade order |
| `renderer/styles/tokens.css` | **Design tokens** (the only file allowed to contain raw hex colours) |
| `renderer/styles/base.css` | Reset, typography, scrollbars, focus ring, utilities, keyframes |
| `renderer/styles/components.css` | Buttons, chips, kbd, badges, segmented, switch, dropdown, menu, popover, inputs, dot, banner |
| `renderer/styles/layout.css` | Title bar, conversation column, empty state, composer, side panel, responsive rules |
| `renderer/styles/messages.css` | Bubbles, markdown, code blocks, thinking, activity/decision rows, plan card, legacy approval card |
| `renderer/styles/approval.css` | Approval dock |
| `renderer/components/dom.js` | `h()` hyperscript helper, `clear`, `shortPath`, `baseName`, `compactNumber` |
| `renderer/components/icons.js` | SVG icon set + brand mark |
| `renderer/components/ui.js` | `button`, `iconButton`, `kbd`, `badge`, `positionFloating`, `createPopover`, `autoGrow` |
| `renderer/components/dropdown.js` | `enhanceSelect` (custom listbox over a hidden native `<select>`) |
| `renderer/components/markdown.js` | Safe Markdown → AST → DOM |
| `renderer/components/messages.js` | Message bubble, typing indicator, thinking block, activity row, decision row, plan card |
| `renderer/components/approvalDock.js` | Permission prompt docked above the composer |
| `renderer/components/approvalCard.js` | Request descriptions/previews + legacy inline card (fallback) |
| `renderer/components/todoPanel.js` | Progress checklist + summary |
| `tests/` | Playwright: `unit/` (Node) and `e2e/` (Electron, scripted fake model) |

---

## 1. Design tokens (`renderer/styles/tokens.css`)

### 1.1 Palette — Black · Dark Navy · Rust Orange

Navy (~220°) and rust (~18°) are **complementary** hues: navy recedes, rust advances. We use
a 60 / 30 / 10 split:

* **~60 % black** — the transcript / reading surface (maximum text contrast).
* **~30 % dark navy** — chrome and raised surfaces (title bar, side panel, composer, cards, menus, user bubbles).
* **~10 % rust** — *only* for things that need attention or mean "act here": primary
  button / send, focus ring, selected option, active tab underline, progress bar, in-progress
  task, brand mark, permission dock accent, links.

| Token | Hex | Role |
|-------|-----|------|
| `--black-950` | `#05070B` | code blocks, deepest wells (`--bg-code`) |
| `--black-900` | `#07090E` | app / transcript background (`--bg-app`) |
| `--navy-900` | `#0B1120` | chrome: title bar, side panel (`--bg-chrome`) |
| `--navy-850` | `#0F1729` | raised: composer, cards, dock, menus (`--bg-raised`) |
| `--navy-800` | `#141E34` | hover on raised (`--bg-hover`) |
| `--navy-750` | `#16213A` | user message bubble (`--bg-user`) |
| `--navy-700` | `#1A2742` | selected / pressed (`--bg-selected`) |
| `--navy-600` | `#24334F` | strong borders, scrollbar hover |
| `--line-1/2/3` | `#151E31` / `#1F2A42` / `#2C3A57` | hairline / default / strong borders |
| `--text-1` | `#E8EBF1` | primary copy |
| `--text-2` | `#A9B1C2` | secondary copy, labels |
| `--text-3` | `#8590A6` | meta, placeholders, hints |
| `--text-on-accent` | `#FFF7F2` | text on rust fills |
| `--rust-500` | `#B5481C` | primary fill (`--accent`) |
| `--rust-450` | `#BE4D1E` | primary hover (`--accent-hover`) |
| `--rust-600` | `#9C3D18` | primary pressed |
| `--rust-300` | `#E8804F` | accent text / icons on dark (`--accent-text`) |
| `--rust-200` | `#F0A27C` | soft accent text (inline code, badges) |
| `--rust-a10…a45` | rgba | tints for selection, focus glow, borders |
| `--success` / `--warning` / `--danger` / `--info` | `#4CC38A` / `#E5B045` / `#F0646F` / `#7AA5F5` | semantic, desaturated to sit in the palette; always paired with an icon or label (never colour alone) |
| `--code-text`, `--diff-*` | | code and diff colours |

**Readability contract** (enforced by `tests/unit/designTokens.spec.js`): every text token
above is ≥ 4.5 : 1 on every surface; `--text-on-accent` is ≥ 4.5 : 1 on all three rust fills;
rust is ≥ 3 : 1 against the background as a UI element. If you change a colour, run
`npm run test:unit` — it will tell you the exact pair that broke.

### 1.2 Typography

| Token | Value | Use |
|-------|-------|-----|
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, Ubuntu, Cantarell, "Noto Sans", …` | all UI — resolves to the native UI font of each OS |
| `--font-mono` | `"SF Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", …` | paths, code, URLs |
| `--fs-xs/sm/md/base/lg/xl/2xl` | 11 / 12 / 13 / 14 / 15 / 18 / 24 px | |
| `--lh-xs/sm/base/code/tight` | 16 / 18 / 22 / 20 / 30 px | **integer px line-heights** (see §2) |
| weights | 400 / 500 / 600 | no 700 — bold looks heavy on Windows ClearType |

### 1.3 Spacing, radii, elevation, motion, layers

* Spacing: 4-px grid `--sp-1…--sp-8` (4, 8, 12, 16, 20, 24, 32).
* Radii: `--r-sm 6`, `--r-md 8`, `--r-lg 12`, `--r-xl 16`, `--r-pill 999`.
* Elevation: `--shadow-sm` (segmented thumb), `--shadow-md` (composer), `--shadow-lg` (menus, popovers, dock, drawer).
* Motion: `--dur-fast 120ms`, `--dur-med 200ms`, `--ease ease-out`. Keyframes in `base.css`: `rise` (enter), `spin`, `pulse`, `dot-bounce`. `prefers-reduced-motion` disables all of them.
* Layout: `--titlebar-h 44px`, `--content-w 800px` (reading column), `--panel-w 340px`, `--gutter`.
* Layers: `--z-panel 20` (drawer), `--z-popover 100` (menus/popovers).

---

## 2. Cross-platform rules (Windows · macOS · Linux)

These are why the builds look identical. Follow them in every new view.

1. **No emoji or symbol glyphs as icons.** They come from different fonts per OS (Segoe UI Emoji / Apple Color Emoji / Noto) or are missing. Use `icon(name)` (SVG). *Test: "UI sources contain no emoji".*
2. **No native `<select>` or checkbox visuals.** macOS draws native popups. Use `enhanceSelect()` and the `.switch` markup. The native element stays hidden as the source of truth.
3. **Integer CSS numbers only** — px line-heights, integer px font sizes, no fractional `opacity` (use rgba tokens such as `--rust-a16`). This keeps the visual scale predictable across builds. *Test: "no fractional line-height, opacity or px font sizes".*
4. **Colours only via tokens.** No raw hex outside `tokens.css`. *Test enforced.*
5. **Custom scrollbars** (`base.css`): Windows otherwise draws thick light bars.
6. **Window chrome**: hidden native title bar + Window Controls Overlay on all OSes (`lib/windowChrome.js`). The `.titlebar` pads itself with `env(titlebar-area-x / -width)`, so the traffic lights (macOS, left) and min/max/close (Windows/Linux, right) never overlap content. Interactive elements inside the bar need `-webkit-app-region: no-drag` (already applied to `button, input, select, a`). Escape hatch: `LLM_CLUSTER_NATIVE_FRAME=1`.
7. **Paths**: always display with `baseName()` / `shortPath()` — they split on `/` and `\`.
8. **Keyboard**: Enter submits; check `e.isComposing` so IME users (CJK) are not interrupted. Use `Ctrl+Enter` *and* `Cmd+Enter` (`e.ctrlKey || e.metaKey`).
9. **`color-scheme: dark`** and `nativeTheme.themeSource = 'dark'` keep native bits (caret, autofill, context menu) dark.

---

## 3. Electron surfaces

### 3.1 Window (`main.js#createWindow` + `lib/windowChrome.js`)

| Option | Value | Why |
|--------|-------|-----|
| `width × height` | 1240 × 820 (min 640 × 520) | room for transcript + side panel |
| `backgroundColor` | `#07090E` | no white flash before first paint |
| `show: false` + `ready-to-show` | | no half-painted window |
| `titleBarStyle` | `'hidden'` | custom title bar on all OSes |
| `titleBarOverlay` | `{ color:'#0B1120', symbolColor:'#A9B1C2', height:44 }` (macOS: `{ height:44 }` + `trafficLightPosition {16,15}`) | OS buttons drawn over our bar |
| `webPreferences` | `nodeIntegration: true, contextIsolation: false` (unchanged) | renderer requires modules directly. **Consequence: never put untrusted strings in `innerHTML`.** |
| DevTools | opt-in: `npm run start:dev` (`--devtools`) or `LLM_CLUSTER_DEVTOOLS=1` | no longer pops open for users |
| Navigation | `setWindowOpenHandler` + `will-navigate` → http(s)/mailto open in the system browser; everything else blocked | links in model output can't hijack the app window |
| Profile | `LLM_CLUSTER_USER_DATA=/path` | isolated localStorage/agent state (tests, side-by-side clients) |

The renderer receives `?frame=custom|native&platform=…` and adds `body.frame-*` / `body.platform-*` classes.

### 3.2 IPC channels used by the renderer

| Channel | Kind | Used for |
|---------|------|----------|
| `ping-backend` | invoke | connection test (pill + popover) |
| `send-prompt` | invoke | chat + agent requests (chat now sends a `requestId`, so Stop works) |
| `stream-chunk` | event (main → renderer) | live tokens |
| `cancel-prompt` | invoke | Stop / New chat |
| `discover-managers` | invoke | "Discover on LAN" |
| `agent:choose-workspace` | invoke | native folder picker |
| `agent:load-state` / `agent:save-state` | invoke | persisted todos per workspace |
| `agent:*` (run-tool, get-file-state, …) | invoke | agent loop only |
| `open-external` | invoke | **new** — open a vetted http(s)/mailto URL |
| `update-available` | event | update banner |
| `open-releases` | send | update banner button |

### 3.3 localStorage keys

`llm-cluster-backend-url`, `llm-cluster-mode`, `llm-cluster-workspace`, `llm-cluster-approval-mode`,
`llm-cluster-todo-session-id` (unchanged), plus **new** `llm-cluster-model` and `llm-cluster-panel`.

---

## 4. Component catalog

Conventions: *Factory* = JS function that returns an element; *Markup* = static HTML in
`index.html`. All factories accept plain strings and insert them as **text** (never HTML).

### 4.1 `h(tag, props, ...children)` — DOM helper · `components/dom.js`
`h('button', { class: ['btn', 'btn-primary'], type: 'button', onClick, dataset: { id: 1 }, 'aria-label': 'Send' }, icon('arrowUp'), 'Send')`
* `class` accepts string or array (falsy entries dropped); `text` sets `textContent`; `on*` props attach listeners; `dataset`/`style` take objects; booleans set properties (`disabled`, `hidden`, `checked`).
* There is deliberately **no `html` prop.**
* Also exports `clear(el)`, `shortPath(p, keep=2)`, `baseName(p)`, `compactNumber(n)` (`1234 → "1.2k"`).

### 4.2 Icon — `icon(name, { size=16, className, title, strokeWidth=2 })` · `components/icons.js`
24×24 stroke icons using `currentColor` (colour them with CSS `color`). Names:
`chat code plus folder folderOpen lock eye zap shield shieldCheck arrowUp stop chevronDown chevronUp chevronRight check x alertTriangle alertCircle info file filePlus pencil trash search terminal listChecks panelRight copy server broadcast activity sparkle clipboard circle circleDot checkCircle xCircle loader download refresh cpu keyboard external`.
In static HTML use a slot: `<span class="icon-slot" data-icon="folder" data-size="14"></span>` (hydrated on boot).
**Brand mark:** `brandMark({ size })` — rust rounded square with three linked nodes (title bar 22 px, empty state 40 px).

### 4.3 Button — `button({ label, icon, iconRight, variant, size, title, id, className, onClick })` · `components/ui.js`
| Variant | Look | Use |
|---------|------|-----|
| `primary` | rust fill, light text | the one main action in a view |
| `secondary` | navy raised + border | neutral actions ("Choose", "Discover on LAN") |
| `ghost` | transparent, text-2 | low emphasis ("New chat") |
| `danger` | danger tint | destructive confirmation |
Sizes: `md` 32 px, `sm` 28 px. Disabled = navy-800 + text-3 (no opacity).
Markup: `<button class="btn btn-secondary btn-sm">…</button>`.

### 4.4 Icon button — `iconButton({ icon, label, size: 'sm'|undefined, onClick })`
32 px (26 px `sm`) square, text-2 → text-1 on hover. `aria-pressed="true"` tints rust (used by the panel toggle). `label` is mandatory (aria-label + tooltip).

### 4.5 Chip — `.chip` (markup)
28 px pill, used for the workspace selector in the composer. Modifiers: `.is-set` (value chosen), `.is-missing` (dashed rust border — "you need to pick this").

### 4.6 Kbd — `kbd('Esc')` → `<kbd class="kbd">`
Keyboard hint keycap. Used in the dock options and the composer hint row.

### 4.7 Badge — `badge({ text, tone, iconName })` → `.badge.badge-{tone}`
Tones: `neutral accent success warning danger info`. 20 px pill. Used for plan status and dock risk labels.

### 4.8 Segmented control — `.segmented > .segmented-item(.active)` (markup)
The Chat | Code switch. Items are `role="tab"` with `aria-selected`. The active item gets navy-700 + a rust icon. Disabled while a request runs.

### 4.9 Switch — markup only
```html
<label class="switch"><input type="checkbox" class="switch-input" id="x">
  <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
  <span class="switch-label">Plan first</span></label>
```
The real checkbox stays focusable (focus ring on the track); checked = rust track.

### 4.10 Dropdown — `enhanceSelect(select, opts)` · `components/dropdown.js`
Skins a native `<select>` (kept hidden as the source of truth: read `select.value`, listen to `change`).
* `opts`: `ariaLabel`, `icon` (fallback icon), `className`, `menuClass`, `align: 'start'|'end'`, `placement: 'auto'|'top'|'bottom'`, `title`.
* Per-option data attributes: `data-description` (2nd line), `data-icon`, `data-tone="warning"` (tints trigger), `data-short` (shorter trigger label). `<optgroup label>` becomes a section header.
* Returns `{ trigger, menu, refresh(), open(), close(), isOpen(), setValue(v), setDisabled(bool) }`. Call `refresh()` after changing `select.value` in code (or use `setValue`).
* Trigger id: `${select.id}-trigger` (e.g. `#model-trigger`, `#approval-mode-trigger`).
* Keyboard: Enter/Space/↑/↓ open; ↑/↓/Home/End move; Enter/Space select; Esc closes and returns focus; Tab closes.
* Menu: `.menu[role=listbox] > .menu-group-label | .menu-item[role=option][aria-selected]` (icon, label, description, check), rendered into `#popover-root`, flips up/down to fit.

### 4.11 Popover — `createPopover({ anchor, panel, placement, align, onOpen, onClose })`
Generic anchored panel controller (outside click, Esc, resize, `aria-expanded`). Returns `{ open, close, toggle, isOpen, reposition }`. Panel markup: `.popover` (340 px, raised navy, `--shadow-lg`) with `.popover-title`, `.popover-text`, `.popover-actions`. `positionFloating(el, anchor, opts)` is the low-level placement helper.
**Instance:** *Connection popover* (`#connection-popover`): URL field, "Discover on LAN", "Test connection", discovered list (`.discovered-item` — names rendered as text), status line (`.connection-status` with a dot).

### 4.12 Input — `.input` + `.field-label`
34 px, black well, mono font, rust focus glow.

### 4.13 Status dot — `.dot.dot-{unknown|pending|online|offline}`
8 px. Online/offline get a soft halo; pending pulses. Always accompanied by text (pill label or status line).

### 4.14 Connection pill — `#connection-btn.conn-pill`
Title-bar pill: status dot + manager host (mono) + chevron. Opens the connection popover.

### 4.15 Banner — `.banner` (`#update-banner`)
Slim strip under the title bar with a rust left accent: icon, text, primary `sm` button, dismiss icon button.

### 4.16 Title bar — `header.titlebar` (markup) · `layout.css`
44 px, navy-900, draggable. Left: brand + segmented control. Right: connection pill, panel toggle (Code only), New chat. It pads itself with the WCO env variables (see §2.6). Below 820 px the brand name and the "New chat" label hide.

### 4.17 Empty state — `.empty-state > .empty-inner` + `.suggestion` cards
Shown while `#chat` has no children (MutationObserver toggles `.conversation.is-empty`). Brand mark, title, subtitle, a mode-specific CTA (`#empty-workspace-btn` when no workspace), and a 2×2 grid of `.suggestion` buttons (icon, title, sub). Clicking one **pre-fills** the composer; it never auto-sends.

### 4.18 Composer — `.composer-region > .composer-column > (#approval-dock, .composer, .composer-hint)`
* `.composer`: raised navy card, 16 px radius, rust focus glow. It is a CSS container (`composer`) so the toolbar compacts itself (`@container composer`).
* `textarea#input`: auto-grows via `autoGrow(textarea, 280)`. Enter sends; Shift+Enter adds a newline; Shift+Tab (Code mode) cycles the permission mode.
* `.composer-toolbar`: left = workspace chip, permission dropdown, Plan switch (Code only); right = model dropdown, send/stop.
* `.send-btn`: 32 px rust; disabled (navy-700) when the input is empty or busy. `.stop-btn` (light fill, stop icon) replaces it while running — in **both** Chat and Code mode.
* `.composer-hint`: key hints · `#run-status` (`Generating…`, `Agent working…`, `Waiting for your approval (n)`, transient "Permission mode: X") · `#session-tokens`.
* Busy state (`setBusy`): disables mode switch, model/permission dropdowns, Plan switch and workspace buttons; adds `body.is-busy`.

### 4.19 Message bubble — `createMessage({ role, text, meta, onLink, onCopy })` · `components/messages.js`
| Role | Look |
|------|------|
| `user` | right-aligned navy-750 bubble, max 80 %, plain text |
| `assistant` | full-width, no bubble, **Markdown**; meta row with worker · model · tokens and a hover "Copy" action |
| `error` | danger-tinted notice with `alertCircle` icon |
| `notice` | neutral navy notice with `info` icon (e.g. "Stopped …") |
Legacy classes are kept (`.bubble.{role} > .bubble-body + .bubble-meta`), because the agent loop also creates `.bubble.assistant.streaming` live bubbles directly.
`createTypingIndicator(label)` → `.bubble.assistant.loading` with three bouncing rust dots ("Thinking", "Working").
Streaming: add `.streaming` to show a blinking rust caret.

### 4.20 Markdown — `renderMarkdown(text, { onLink, onCopy })`, `parseMarkdown(text)` · `components/markdown.js`
Supports fenced code (incl. unclosed fences mid-stream), headings, paragraphs with soft breaks, nested/ordered/task lists, blockquotes, rules, GFM tables, inline code, bold, italic, strikethrough, links and bare URLs. Only `http(s)`/`mailto` links become `<a class="md-link">`; clicks call `onLink(url)` → IPC `open-external`. CSS classes: `.md-p .md-h .md-h1..6 .md-list .md-li .md-task(.is-checked) .md-task-box .md-quote .md-hr .md-code-inline .md-table-wrap .md-table`.
**Code block** `.md-code > .md-code-header(.md-code-lang, .md-code-copy) + pre.md-pre > code` — black well, navy header, Copy → "Copied".

### 4.21 Thinking block — `createThinkingBlock(text, { open })`
Collapsed disclosure "› Thought process · N words"; expands to a muted, left-ruled panel (max 320 px, scrolls). Classes `.thinking-block .thinking-toggle(.open) .thinking-content(.open)`.

### 4.22 Activity row — `createActivityRow({ kind, status, title, subtitle, onSelect })`
32 px clickable tool step: icon tile (kind colour), title, mono subtitle (hidden when redundant), chevron on hover. Clicking it opens the **Details** tab.
`kind`: `read` (info blue, file icon) · `write` (rust, filePlus) · `edit` (rust, pencil) · `shell` (amber, terminal) · `dir` · `info`. `status`: `success` | `error` (danger tile) | `info`. `.active` = rust inset bar. Consecutive rows collapse into a tight group.

### 4.23 Decision row — `createDecisionRow({ decision, toolName, target })`
Audit line after a permission answer: `once` ("Allowed once", green check) · `always` ("Always allowed", shieldCheck) · `deny` ("Denied", red x) · `cancelled`. It shows the tool name as a code chip plus the short target.

### 4.24 Plan card — `createPlanCard(planText)` → `{ el, editor, getText, startEditing, stopEditing({commit}), setStatus(key) }`
Raised navy document with a header (clipboard icon, "Proposed plan", status badge) and a Markdown body; editing swaps in a mono textarea. Status keys: `pending` (rust glow) · `editing` · `approved` · `edited` · `rejected` · `cancelled`.

### 4.25 Approval dock — `getApprovalDock(document)` → `ApprovalDock` · `components/approvalDock.js`
The permission prompt **above the composer** (Claude-Code style). It is never rendered inside the model's messages.
* `requestTool({ toolName, args, risk, canRemember, transcript }) → Promise<'once'|'always'|'deny'>`
* `requestPlan({ planCard, transcript }) → Promise<'approve'|'reject'|'edit:<text>'>`
* `cancelAll()` (resolves everything as deny/reject; used by Stop and New chat), `isOpen()`, `pending`, `subscribe(fn)`.
* Layout: `.dock-card` (raised navy, rust top accent; danger accent for deletes) → `.dock-header` (risk badge, title, "1 of N") → `.dock-target` (tool chip + full target) → `.dock-preview` (diff with `.diff-add/.diff-del/.diff-hunk/.diff-cmd`, max 5 lines visible) → `.dock-question-row` (question + key hint) → `.dock-options` (`.dock-option` rows with caret, kbd number, label, optional hint; `.is-selected`, `.is-danger`).
* Options: tools → "Yes, allow once" / "Yes, and don't ask again for *tool* on *file* this session" (not for `delete_file`, `run_shell`) / "No, deny" (Esc). Plans → "Yes, execute this plan" / "Edit the plan first" / "No, reject the plan"; while editing → "Save changes and execute" (Ctrl/Cmd+Enter) / "Cancel editing" (Esc).
* Keyboard: `1-9` choose, `↑/↓` move (wraps), `Enter` confirm, `Esc` deny/reject/cancel. Keys are ignored while focus is in an input/textarea, so typing a message never answers a prompt.
* Focus: the dock takes focus only when the composer is empty. It never grabs focus from a half-typed message. `Shift+Tab` in the composer jumps to an open dock (`dock.focus()`), and focus returns to the composer when the prompt closes.
* Request copy comes from `describeToolRequest(toolName, args, risk)` in `approvalCard.js` (`{ title, target, risk, riskLabel, riskIcon, tone, rememberLabel }`); previews come from `buildPreview()`.
* The agent uses it via `lib/agentLoop.js#showApprovalCard` / `#showPlanApproval`, which fall back to the legacy inline `buildApprovalCard()` if a host has no `#approval-dock`.

### 4.26 Side panel — `aside#side-panel` (markup)
Code mode only. Docked at 340 px on windows ≥ 1081 px; an overlay drawer (shadow, closes on conversation click) below that. Toggle: `#panel-toggle`; close: `#activity-close`; the open state persists (`llm-cluster-panel`). It auto-opens the first time tasks appear.
* **Tabs** `.panel-tabs > .panel-tab(.active)` with rust underline and a `.tab-count` pill (`done/total`).
* **Workspace card** `.workspace-card(.is-missing)`: folder icon, name, full mono path, Choose/Change button.
* **Progress** — `renderTodoPanel(container, items, { onSelectPath })` (`components/todoPanel.js`): `.progress-summary` ("3 of 8 done · 1 failed", %, 4 px rust `.progress-bar`), then `.todo-list > .todo-item.status-{pending|in_progress|done|failed}` (status icon — spinning loader for in-progress, title, clickable mono path, error line). Empty: `.panel-empty`. `summarizeTodos(items)` gives the counts.
* **Details** — `.details-head` (title + mono subtitle) and `pre.activity-detail` filled line by line (`.detail-line`, `.detail-key`, diff colouring).

### 4.27 Legacy inline approval card — `buildApprovalCard(opts)` · `approvalCard.js`
Fallback only (`.bubble.approval` with SVG risk icon, preview, Approve / Always Allow / Reject).

---

## 5. Recipe — adding a new tab or panel

1. **Markup**: add a region to `index.html`. For a new side-panel tab, add `<button class="panel-tab" data-tab="x" role="tab">` plus a `<section class="panel-body hidden" role="tabpanel">`, and extend `switchTab()` in `renderer.js`. For a top-level view, add a segment to `.segmented` and mirror `applyMode()`.
2. **Build content with factories** — `h()`, `button()`, `icon()`, `badge()`, `createActivityRow()`, `renderTodoPanel()`… Never write `innerHTML` with dynamic data.
3. **Style with tokens** — surfaces `--bg-chrome`/`--bg-raised`, text `--text-1/2/3`, borders `--line-*`, rust only for the primary action/selection. Integer px only. Put new CSS in the matching `styles/*.css` (or a new file `@import`ed from `style.css`; the hygiene test checks the import list).
4. **Selects/toggles** — native `<select>` + `enhanceSelect()`, `.switch` markup.
5. **Persist** UI state in `localStorage` with a `llm-cluster-*` key.
6. **Test** — add an Electron test in `tests/e2e/` using `launchApp()`; assert layout with `rect()`, and run at 640 px and 1280 px.
7. **Log it here** — add the component to §4 with its props/states/keyboard.

Skeleton:
```js
const { h } = require('./components/dom');
const { button, badge } = require('./components/ui');
const { icon } = require('./components/icons');

function renderWorkersTab(container, workers) {
  container.replaceChildren(
    h('div', { class: 'panel-section-title', text: 'Workers' }),
    ...workers.map(w => h('div', { class: 'workspace-card' },
      h('span', { class: 'workspace-card-icon' }, icon('server')),
      h('div', { class: 'workspace-card-text' },
        h('div', { class: 'workspace-card-name', text: w.name }),
        h('div', { class: 'workspace-card-path', text: w.model })),
      badge({ text: w.online ? 'Online' : 'Offline', tone: w.online ? 'success' : 'neutral' }))),
    button({ label: 'Refresh', icon: 'refresh', variant: 'secondary', size: 'sm', onClick: () => {} }),
  );
}
```

---

## 6. Testing & debugging

| Command | What |
|---------|------|
| `npm run test:unit` | Node-only: tokens/contrast/CSS hygiene/emoji, markdown, approval copy, window chrome, helpers |
| `npm run test:e2e` | Electron: shell/layout, approval dock, agent flows (fake model), chat, connection; prefix with `xvfb-run -a` on headless Linux |
| `npm run test:ui` | both |
| `npm run start:dev` | app with DevTools |

* `tests/helpers/app.js`: `launchApp({ width, height, beforeReload })` (isolated profile), `fakeModel(app, steps)` (scripted `send-prompt`, supports `chunks`, `tool_calls`, `error`, `waitForCancel`), `mockIpc`, `recordIpc`, `chooseWorkspace`, `makeWorkspace`, `waitIdle`, `rect`. The manager, workers and models are **never** started.
* `window.LLMClusterUI` (renderer): `appendBubble`, `appendActivity`, `appendThinkingBlock`, `updateTodoView(detail, items)`, `showWorking`, `hideWorking`, `applyMode`, `setWorkspace`, `newChat`, `setBusy`, `approvalDock`, `getState()`. Handy in DevTools for building mock-ups of new states.

---

## 7. Change log — UI overhaul

* New shell: custom draggable title bar on all OSes (WCO), centred 800 px reading column, composer with inline controls, Code-mode side panel (Progress / Details), empty states with suggestions.
* Black / dark navy / rust design system with tested contrast; integer-only CSS; SVG icons; custom select, switch and scrollbars.
* **Approval dock** above the composer replaces approval questions inside the model's messages; it adds a queue, keyboard control, an audit trail, and cancel-on-stop.
* Plan review: plan document in the transcript, decision in the dock, in-place editing.
* Structured live todo list (agent passes items, not only text).
* Safe Markdown rendering for answers (code blocks with copy, tables, lists, links → system browser).
* Chat mode: live streaming, collapsible reasoning, Stop button, partial answers kept.
* Fixes: mDNS manager names were injected via `innerHTML` (XSS → code execution, given `nodeIntegration`); "New chat" during a run no longer lets the old run overwrite the new history; workspace names on Windows paths; DevTools no longer auto-open; model choice persists.
