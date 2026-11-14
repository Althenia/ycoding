import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { SharedCompactionDivider, SharedCompanionTabs, SharedComposerCapsule, SharedContextBreakdownPanel, SharedContextRingButton, SharedEffortControl, SharedTurnHead, SharedWorkspaceFrame, SharedCompanionSurface, SharedConversationHeader, SharedMessageTurn, SharedComposerSurface, WORKSPACE_DESTINATIONS } from "./shared-workspace"
import { SharedActivitySurface, SharedChangesSurface, SharedEditedFilesCard, SharedReasoningDisclosure, SharedToolDisclosure } from "./shared-workspace"
import { SharedPageSurface, SharedProjectsSurface, SharedSessionsSurface, SharedWorkspacesSurface, SharedUsageSurface, SharedSettingsSurface } from "./shared-workspace"
import { createSharedProjectForm, type SharedProjectDirectoryInput, type SharedProjectCreateInput } from "./shared-workspace"
import { SharedRadioGroup, SharedLoadingSkeleton } from "./shared-workspace"
import { Icon, type IconName } from "../../ui/icon"

const withWindow = <T>(render: () => T): T => {
  const host = globalThis as { window?: unknown }
  const previous = host.window
  host.window = { innerHeight: 800 }
  try { return render() } finally { host.window = previous }
}

test("workspace selection distinguishes directories sharing one project and unsupported keep-awake is honest", () => {
  const entries = ["/one", "/two"].map((directory) => ({ projectID: "p", name: directory, directory, sessions: 1, topLevelSummary: "1", childSummary: "0", copies: [] }))
  const html = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: entries, selectedID: "p:/two", onSelect: () => {} }))
  expect(html).toContain('<h3 class="ws-title">/two</h3>')
  expect(html.match(/aria-selected="true"/g)?.length).toBe(1)
  const settings = renderToString(() => createComponent(SharedSettingsSurface, { animations: true, keepAwakeChecked: false, keepAwakeDetail: "Unavailable", keepAwakeStatus: "unsupported", telemetryConsent: "undecided", telemetryNote: "Unknown", onToggleAnimations: () => {}, onToggleKeepAwake: () => {}, onDecideTelemetry: () => {}, onToggleNotifications: () => {}, onToggleSavedPermissions: () => {}, onToggleCloseApp: () => {} }))
  expect(settings).toContain('id="st-keep-awake-state" data-part="st-keep-awake-state">Keep awake is unsupported on this machine.</p>')
  for (const debug of ["rl-capability", "rl-sim", "rl-badge", "desktop local", "Unavailable"]) expect(settings).not.toContain(debug)
})

test("destination surfaces render supplied data, states and actions", () => {
  const same = ["/one", "/two"].map((directory) => ({ projectID: "p", name: directory, directory, sessions: 1, topLevelSummary: "1", childSummary: "0", copies: [] }))
  for (const selectedID of ["p", "/two", "/one", "missing", "two"]) {
    const html = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: same, selectedID, onSelect: () => {} }))
    expect(html.match(/aria-selected="true"/g)).toBeNull()
    expect(html).not.toContain('class="ws-title"')
  }
  const keyedItems = same.map((item) => ({ ...item, key: `custom:${item.directory}` }))
  const keyed = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: keyedItems, selectedID: "custom:/two", onSelect: () => {} }))
  expect(keyed).toContain('<h3 class="ws-title">/two</h3>')
  expect(keyed.match(/aria-selected="true"/g)?.length).toBe(1)
  const keyedBare = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: keyedItems, selectedID: "p:/two", onSelect: () => {} }))
  expect(keyedBare.match(/aria-selected="true"/g)).toBeNull()
  const none = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: same, onSelect: () => {} }))
  expect(none.match(/aria-selected="true"/g)).toBeNull()
  const page = renderToString(() => createComponent(SharedPageSurface, { title: "Sessions", sub: "Local", onBack: () => {}, children: "Contents" }))
  for (const text of ['data-part="page"', 'data-page-heading', 'data-action-id="page-back"', "Contents"]) expect(page).toContain(text)
  const projects = renderToString(() => createComponent(SharedProjectsSurface, { projects: [{ id: "p", name: "Project", active: true, statusText: "Ready", revision: 3, masterTitle: "Master", master: { sessionID: "s", title: "Master", state: "Running" }, members: [], openNote: "Opens master" }], selectedID: "p", onSelect: () => {}, onOpenMaster: () => {}, onChangeConcurrency: () => {} }))
  for (const text of ["1 project", "Project", "revision 3", "Open project chat"]) expect(projects).toContain(text)
  const sessions = renderToString(() => createComponent(SharedSessionsSurface, { search: "", filters: [{ value: "all", label: "All", count: 1 }], filter: "all", pinning: false, items: [{ id: "s", title: "Session", hint: "Workspace", meta: "Ready", pinned: true }], totalLoaded: 1, pinnedCount: 1, onNewSession: () => {}, onSearch: () => {}, onFilter: () => {}, onTogglePinMode: () => {}, onTogglePin: () => {}, onSelect: () => {} }))
  for (const text of ["Search Sessions", "Showing 1 of 1", "Unpin", "Session"]) expect(sessions).toContain(text)
  expect(sessions).not.toContain("📌")
  expect(sessions).toContain("M16 3l5 5-4 1-4 4-1 4-5-5 4-1 4-4z")
  const workspaces = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: [{ projectID: "w", name: "Workspace", directory: "/work", sessions: 1, topLevelSummary: "1", childSummary: "0", copies: [] }], selectedID: "w:/work", onSelect: () => {} }))
  const usage = renderToString(() => createComponent(SharedUsageSurface, { phase: "ready", statusText: "Updated", ranges: [{ value: "today", label: "Today" }], range: "today", rangeLabel: "Today", requests: "2", inputTokens: "10", outputTokens: "5", estimatedCost: "$1", onRange: () => {}, onRefresh: () => {} }))
  for (const text of ["Ready", "Requests · Today", "10", "$1", "Provider quota windows"]) expect(usage).toContain(text)
  for (const text of ["Workspace", "/work", "0 copies"]) expect(workspaces).toContain(text)
  for (const surface of [projects, workspaces, usage]) for (const debug of ["rl-capability", "Supported", "desktop local"]) expect(surface).not.toContain(debug)
  const settings = renderToString(() => createComponent(SharedSettingsSurface, { animations: true, keepAwakeChecked: false, keepAwakeDetail: "Off", telemetryConsent: "undecided", telemetryNote: "Not decided", onToggleAnimations: () => {}, onToggleKeepAwake: () => {}, onDecideTelemetry: () => {}, onToggleNotifications: () => {}, onToggleSavedPermissions: () => {}, onToggleCloseApp: () => {} }))
  for (const text of ["Appearance", "Keep awake", "Latency diagnostics", "Notifications", "Permissions", "Close app"]) expect(settings).toContain(text)
  const tabs = renderToString(() => createComponent(SharedCompanionTabs, { active: "activity", onSelect: () => {}, onCloseTab: () => {} }))
  for (const text of ['class="rl-pane-tabs"', 'class="rl-pane-tab" data-active="true"', 'class="rl-pane-tab-close"']) expect(tabs).toContain(text)
})

test("destination states distinguish empty, preparing, disabled and settled controls", async () => {
  const projects = renderToString(() => createComponent(SharedProjectsSurface, { projects: [], onSelect: () => {}, onOpenMaster: () => {}, onChangeConcurrency: () => {} }))
  expect(projects).toContain("No projects.")
  const usage = renderToString(() => createComponent(SharedUsageSurface, { phase: "preparing", statusText: "Loading", ranges: [], range: "today", rangeLabel: "Today", requests: "—", inputTokens: "—", outputTokens: "—", estimatedCost: "Unreported", refreshing: true, onRange: () => {}, onRefresh: () => {} }))
  expect(usage).toContain('data-phase="preparing"')
  expect(usage).toContain('data-action-id="st-usage-refresh" disabled')
  const settings = renderToString(() => createComponent(SharedSettingsSurface, { animations: false, keepAwakeChecked: true, keepAwakeDisabled: true, keepAwakeDetail: "Unavailable", telemetryConsent: "enabled", telemetryNote: "Sharing", onToggleAnimations: () => {}, onToggleKeepAwake: () => {}, onDecideTelemetry: () => {}, onToggleNotifications: () => {}, onToggleSavedPermissions: () => {}, onToggleCloseApp: () => {} }))
  expect(settings).toContain('aria-label="Keep this Mac awake" aria-checked="true" disabled')
  expect(settings).toContain('class="rl-switch-track"')
  expect(settings).toContain('aria-label="Share latency diagnostics" aria-checked="true"')
  const css = await Bun.file(new URL("../../styles/workspace-shell.css", import.meta.url)).text()
  for (const text of ["justify-content:flex-start", "overflow-x:auto", "overflow-y:hidden", 'data-active="true"', "min-height:28px", ".rl-pane-tabs .rl-pane-tab > button:focus-visible { outline:2px solid var(--yc-focus); outline-offset:-2px; box-shadow:none; }"]) expect(css).toContain(text)
})

test("compact chips, edited actions and companion controls expose requested presentation", () => {
  const tool = renderToString(() => createComponent(SharedToolDisclosure, { tools: [{ id: "t", name: "bash", status: "completed", inputText: "bun test" }], durationLabel: "19s", lastSummary: "bash bun test" }))
  for (const value of ['class="transcript-tools__button rl-chip"', "Worked for 19s · 1 tool", "bash bun test"]) expect(tool).toContain(value)
  const file = { path: "a.ts", patch: "", additions: 3, deletions: 2 }
  const card = renderToString(() => createComponent(SharedEditedFilesCard, { files: [file], onViewChanges: () => {}, onUndo: () => {}, undoLabel: "Undo selection", footerNote: "Note" }))
  for (const value of ['<span class="rl-edited-title">1 file changed</span>', '<span class="ws-add">+3</span>', '<span class="ws-del">−2</span>', "Undo selection", "Note"]) expect(card).toContain(value)
  expect(card).toContain('data-panel="true"')
  const companion = renderToString(() => createComponent(SharedCompanionSurface, { active: "activity", onSelect: () => {}, policyActions: "Goal", onCloseTab: () => {}, onAddTab: () => {}, activityContent: "Activity", changesContent: "Changes" }))
  for (const value of ["rl-companion-head", "rl-pane-policy", "Goal", "Close Activity tab", "Add companion tab"]) expect(companion).toContain(value)
  const changes = renderToString(() => createComponent(SharedChangesSurface, { files: [], turnsNotice: "Limited history", onOpenFullChanges: () => {}, fullChangesLabel: "Full view" }))
  expect(changes).toContain("Limited history")
  expect(changes).toContain("Full view")
})

test("shared adapters render turn-scoped diffs, staged revert and compact details", () => {
  const first = { path: "first.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }
  const second = { path: "second.ts", patch: "@@ -1 +1 @@\n-before\n+after", additions: 2, deletions: 1 }
  const revert = { staged: true, summary: "Confirm file changes", onStage: () => {}, onCommit: () => {}, onClear: () => {} }
  const changes = withWindow(() => renderToString(() => createComponent(SharedChangesSurface, { files: [first, second], turns: [{ id: "turn", label: "Turn one", files: [second] }], selectedTurnID: "turn", onSelectTurn: () => {}, revert })))
  for (const text of ["Turn one", "second.ts", "Confirm revert", "Cancel", 'class="rl-diff-num"', 'class="rl-diff-sign"']) expect(changes).toContain(text)
  expect(changes).not.toContain("first.ts")
  const card = renderToString(() => createComponent(SharedEditedFilesCard, { files: [first], revert }))
  expect(card).toContain("Confirm revert")
  const activity = renderToString(() => createComponent(SharedActivitySurface, { shells: [{ id: "shell", command: "echo", status: "running" }], subagents: [], subagentNext: "next", onLoadMoreSubagents: () => {} }))
  expect(activity).toContain('class="rl-activity-row__body"')
  expect(activity).toContain("Load older subagents")
  const context = renderToString(() => createComponent(SharedContextBreakdownPanel, { used: "24K", capacity: "128K", remaining: 104000, label: "19% used", modelLabel: "model", providerLabel: "provider" }))
  for (const text of ['class="companion__context-eyebrow rl-pane-kicker"', 'class="rl-context-total"', '<p class="rl-context-summary">104,000 remaining · 19% used</p>', '<p class="rl-context-meta">Provider: provider · Model: model</p>']) expect(context).toContain(text)
  expect(context).not.toContain("rl-draft-estimate")
  const draft = renderToString(() => createComponent(SharedContextBreakdownPanel, { used: "24K", draftTokens: 1200 }))
  expect(draft).toContain('<p class="rl-draft-estimate">Draft estimate · 1,200 tokens</p>')
})

test("shared surfaces expose supplied labels, shell ownership, file totals and empty states", () => {
  const context = renderToString(() => createComponent(SharedContextBreakdownPanel, { contextMessagesLabel: "Current messages", contextMessages: [] }))
  expect(context).toContain("Current messages")
  const activity = renderToString(() => createComponent(SharedActivitySurface, { shells: [{ id: "s", command: "cmd", status: "running", ownerSessionID: "session", cwd: "/work" }], subagents: [] }))
  for (const text of ["running · session · /work", "No subagent tasks.", "No loaded child Sessions."]) expect(activity).toContain(text)
  expect(renderToString(() => createComponent(SharedActivitySurface, { shells: [], subagents: [] }))).toContain("No Session-attributed shells.")
  const file = { path: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 3, deletions: 2 }
  const changes = renderToString(() => createComponent(SharedChangesSurface, { files: [file] }))
  expect(changes).toContain('class="rl-file-jump"')
  expect(changes).toContain("+3")
  expect(changes).toContain("−2")
  expect(renderToString(() => createComponent(SharedChangesSurface, { files: [] }))).toContain("No captured file changes for this Session.")
  expect(renderToString(() => createComponent(SharedEditedFilesCard, { files: [file], title: "Modified sources" }))).toContain("Modified sources")
})

test("rich shared presentation renders supplied tool and file data", () => {
  const tool = renderToString(() => createComponent(SharedToolDisclosure, { defaultOpen: true, tools: [{ id: "one", name: "Shell", status: "failed", summary: "command", inputText: "input", errorText: "failure" }] }))
  for (const text of ['aria-expanded="true"', "1 tool", "Shell", "command", "failure", 'data-status="failed"']) expect(tool).toContain(text)
  const reasoning = renderToString(() => createComponent(SharedReasoningDisclosure, { text: "analysis", streaming: true, durationLabel: "2s" }))
  expect(reasoning).toContain("Thought · 2s")
  expect(reasoning).toContain('aria-expanded="false"')
  const card = renderToString(() => createComponent(SharedEditedFilesCard, { defaultOpen: true, files: [{ path: "src/a.ts", patch: "", additions: 2, deletions: 1 }], onViewChanges: () => {} }))
  for (const text of ["1 file changed", "+2", "−1", "src/a.ts", "View changes"]) expect(card).toContain(text)
})

test("rich companion renders activity, unified diff numbers, and cache diagnostics", () => {
  const activity = renderToString(() => createComponent(SharedActivitySurface, { workspaceLabel: "Example", shells: [{ id: "s", command: "echo test", status: "running" }], subagents: [{ sessionID: "a", agent: "worker", description: "Review", state: "running", model: "example", progressText: "Inspecting", onOpen: () => {} }], childSessions: [{ id: "c", title: "Child", status: "completed", onOpen: () => {} }], notices: ["Notice"], changesSummary: { additions: 2, deletions: 1, onOpenChanges: () => {} } }))
  for (const text of ["Shell processes", "echo test", "Subagent tasks", "Inspecting", "Loaded child Sessions", "Child", "Recent activity", "Notice"]) expect(activity).toContain(text)
  const changes = renderToString(() => createComponent(SharedChangesSurface, { files: [{ path: "src/a.ts", patch: "@@ -3,2 +3,2 @@\n unchanged\n-old\n+new", additions: 1, deletions: 1 }] }))
  for (const text of ["Unified diff for src/a.ts", 'data-kind="hunk"', 'data-kind="context"', 'data-kind="removed"', 'data-kind="added"', "unchanged", "old", "new"]) expect(changes).toContain(text)
  const context = renderToString(() => createComponent(SharedContextBreakdownPanel, { providerLabel: "Example", stepDiagnostics: { uncachedInput: 12, output: 4, reasoning: 2, cacheRead: 8, cacheWrite: 1 }, contextMessages: [{ id: "m", role: "user", summary: "Question" }], onOpenUsage: () => {} }))
  for (const text of ["Provider: Example", "<h3>Step &amp; prompt cache diagnostics</h3>", "<dt>Uncached input</dt><dd>12</dd>", "Open Usage · cumulative spend", "Retained transcript messages"]) expect(context).toContain(text)
  expect(context).not.toContain("Active context messages")
})

test("shared presentation stays independent of remote state and is consumed by the web", async () => {
  const source = await Bun.file(new URL("./shared-workspace.tsx", import.meta.url)).text()
  for (const forbidden of ["../context", "../store", "@ycoding-ai/core", "@ycoding-ai/server"]) expect(source).not.toContain(forbidden)
  for (const name of ["shell", "conversation", "composer"]) expect(await Bun.file(new URL(`./${name}.tsx`, import.meta.url)).text()).toContain('from "./shared-workspace"')
  const shell = await Bun.file(new URL("./shell.tsx", import.meta.url)).text()
  for (const component of ["SharedWorkspaceFrame", "SharedCompanionSurface", "SharedConversationHeader", "WORKSPACE_DESTINATIONS"]) expect(shell).toContain(component)
  const conversation = await Bun.file(new URL("./conversation.tsx", import.meta.url)).text()
  for (const component of ["SharedMessageTurn", "SharedCompactionDivider"]) expect(conversation).toContain(`<${component}`)
  expect(await Bun.file(new URL("./composer.tsx", import.meta.url)).text()).toContain("<SharedComposerSurface")
  expect(await Bun.file(new URL("./model-control.tsx", import.meta.url)).text()).toContain("<SharedEffortControl")
})

test("context ring and companion tabs expose labels, selection and panel relationships", () => {
  const ring = renderToString(() => createComponent(SharedContextRingButton, { fraction: 0.42, label: "42%", ariaLabel: "Open context", expanded: false, onClick: () => {} }))
  expect(ring).toContain('aria-label="Open context"')
  expect(ring).toContain('stroke-dasharray="42 100"')
  expect(ring).toContain("42%")
  const tabs = renderToString(() => createComponent(SharedCompanionTabs, { active: "changes", onSelect: () => {} }))
  expect(tabs).toContain('aria-label="Session companion"')
  expect(tabs).toContain('aria-controls="companion-changes"')
  expect(tabs).toContain('aria-selected="true"')
  expect(tabs).toContain("Activity")
  expect(tabs).toContain("Context")
})

test("context breakdown renders measured totals, remaining tokens and seven categories", () => {
  const html = renderToString(() => createComponent(SharedContextBreakdownPanel, { used: "24K", capacity: "128K", label: "19% used", remaining: 104000, modelLabel: "sample · model", breakdown: { system: 1, tools: 1, user: 1, assistant: 1, reasoning: 1, toolCalls: 1, other: 1 } }))
  for (const text of ['<p class="companion__context-eyebrow rl-pane-kicker">Active window</p>', '<p class="rl-context-total"><strong class="companion__context-total">24K</strong><span class="companion__context-capacity">/ 128K tokens</span></p>', "104,000 remaining · 19% used", "Model: sample · model", "Tool calls", "Estimated input breakdown by category, separate from provider-reported window tokens and cumulative spend."]) expect(html).toContain(text)
  for (const text of ["ACTIVE WINDOW", "<h2", "title="]) expect(html).not.toContain(text)
  expect(html.match(/class="companion__context-row"/g)?.length).toBe(7)
  expect(html.match(/class="companion__context-bar-segment"[^>]*aria-hidden="true"/g)?.length).toBe(7)
  expect(html).toContain('<dt><span class="companion__context-swatch" data-category="toolCalls" aria-hidden="true"></span>Tool calls</dt><dd class="companion__context-count">1</dd><dd class="companion__context-percent">14.3%</dd>')
  const rows = html.slice(html.indexOf('class="companion__context-breakdown"'))
  expect(rows).not.toContain("tokens")
  const absent = renderToString(() => createComponent(SharedContextBreakdownPanel, {}))
  expect(absent).toContain('<p class="rl-context-empty">Context window usage is not reported for the selected model.</p>')
  for (const text of ["rl-context-total", "companion__context-breakdown", "Estimated input breakdown"]) expect(absent).not.toContain(text)
})

test("turn, composer and effort primitives render their supplied content", () => {
  expect(renderToString(() => createComponent(SharedTurnHead, { children: "Assistant" }))).toContain('class="transcript-message__mark"')
  expect(renderToString(() => createComponent(SharedComposerCapsule, { children: "Draft" }))).toContain('class="mini-composer__input-wrap"')
  const effort = renderToString(() => createComponent(SharedEffortControl, { variants: [{ value: "low", label: "low" }, { value: "high", label: "high" }], current: "high", currentLabel: "high", available: true, stale: false, selected: true, onSelect: () => {} }))
  expect(effort).toContain("REASONING EFFORT")
  expect(effort).toContain("high")
  expect(effort).toContain('type="range"')
  expect(effort).toContain('aria-valuetext="high"')
})

test("workspace frame and companion render owned landmarks and sections", () => {
  const companion = renderToString(() => createComponent(SharedCompanionSurface, { active: "activity", onSelect: () => {}, headerActions: "Policy", activityContent: "Shell output", changesContent: "Changes" }))
  expect(companion).toContain('<span class="rl-pane-kicker">Session companion</span>')
  expect(companion).not.toContain("SESSION COMPANION")
  expect(companion).toContain('id="companion-activity"')
  expect(companion).toContain('id="companion-context"')
  expect(companion).toContain("Shell output")
  const frame = renderToString(() => createComponent(SharedWorkspaceFrame, { railHeader: "Brand", newChat: "New chat", railBody: "Sessions", railNavigation: "Navigation", machineName: "Machine", children: "Chat" }))
  for (const text of ['id="session-rail"', '<div class="workspace__rail-head">BrandNew chat</div>', 'class="workspace__rail-body"', 'class="workspace__rail-footer"', 'id="remote-main"', "Machine", "Chat"]) expect(frame).toContain(text)
  expect(frame.match(/class="workspace__rail-navigation"/g)?.length).toBe(1)
  const bare = renderToString(() => createComponent(SharedWorkspaceFrame, { railHeader: "Brand", newChat: "New chat", railBody: "Sessions", railNavigation: "Navigation", children: "Chat" }))
  expect(bare).not.toContain("workspace__rail-footer")
  expect(WORKSPACE_DESTINATIONS.map((entry) => entry.id)).toEqual(["projects", "sessions", "workspaces", "usage", "settings"])
  expect(WORKSPACE_DESTINATIONS.map((entry) => entry.route)).toEqual(["/remote/projects", "/remote/sessions", "/remote/workspaces", "/remote/usage", "/remote/settings"])
  expect(WORKSPACE_DESTINATIONS.map((entry) => entry.desktopRoute)).toEqual(["/projects", "/sessions", "/workspaces", "/usage", "/settings"])
})

test("shared conversation and composer compositions render their semantic containers", () => {
  const header = renderToString(() => createComponent(SharedConversationHeader, { title: "Session", subtitle: "Machine · Workspace", actions: "Actions" }))
  expect(header).toContain('class="workspace__topbar"')
  expect(header).toContain("<h1")
  expect(header).toContain('class="conversation-header__actions"')
  const user = renderToString(() => createComponent(SharedMessageTurn, { kind: "user", text: "Hello", receipt: "Sent" }))
  expect(user).toContain('class="transcript-message transcript-message--user"')
  expect(user).toContain('class="transcript-message__bubble"')
  expect(user).toContain('class="transcript-message__receipt"')
  const composer = renderToString(() => createComponent(SharedComposerSurface, { ariaLabel: "Message", field: "Draft", controls: "Model" }))
  for (const text of ["<form", 'aria-label="Message"', 'class="composer__body"', 'class="mini-composer__input-wrap"', 'class="composer__controls"']) expect(composer).toContain(text)
})

test("shared message turns own unavailable, peer and compaction presentation", () => {
  const unavailable = renderToString(() => createComponent(SharedMessageTurn, { kind: "oversized", unavailable: "Content unavailable", onRetry: () => {} }))
  expect(unavailable).toContain('class="transcript-message__unavailable"')
  expect(unavailable).toContain('role="status"')
  expect(unavailable).toContain("Retry full content")
  const peer = renderToString(() => createComponent(SharedMessageTurn, { kind: "synthetic", peerLabel: "Side chat", peerText: "A reply" }))
  expect(peer).toContain('aria-label="Side chat"')
  expect(peer).toContain('class="transcript-message__system"')
  expect(peer).toContain("A reply")
  expect(renderToString(() => createComponent(SharedMessageTurn, { kind: "compaction", compaction: "Compacted" }))).toContain("Compacted")
  const compaction = renderToString(() => createComponent(SharedCompactionDivider, { completed: true, label: "Compacted", total: "Total", reduction: 25, number: "Saved", items: "Items" }))
  expect(compaction).toContain('class="transcript-compaction transcript-compaction--completed"')
  expect(compaction).toContain('aria-label="25% of input tokens removed"')
})

test("radio choices use the indicator structure and the selected option is marked", () => {
  const sessions = renderToString(() => createComponent(SharedSessionsSurface, { search: "", filters: [{ value: "all", label: "All", count: 2 }, { value: "live", label: "Live", count: 1 }], filter: "live", pinning: false, items: [], totalLoaded: 2, pinnedCount: 0, onNewSession: () => {}, onSearch: () => {}, onFilter: () => {}, onTogglePinMode: () => {}, onSelect: () => {} }))
  expect(sessions.match(/class="rl-radio"/g)?.length).toBe(2)
  expect(sessions.match(/<i aria-hidden="true"><\/i><span>/g)?.length).toBe(2)
  expect(sessions.match(/aria-checked="true"/g)?.length).toBe(1)
  const usage = renderToString(() => createComponent(SharedUsageSurface, { phase: "ready", statusText: "Updated", ranges: [{ value: "today", label: "Today" }, { value: "week", label: "Week" }], range: "week", rangeLabel: "Week", requests: "2", inputTokens: "10", outputTokens: "5", estimatedCost: "$1", onRange: () => {}, onRefresh: () => {} }))
  expect(usage.match(/class="rl-radio"/g)?.length).toBe(2)
  expect(usage.match(/aria-checked="true"/g)?.length).toBe(1)
  const projects = renderToString(() => createComponent(SharedProjectsSurface, { projects: [{ id: "p", name: "Project", active: true, statusText: "Ready", revision: 3, masterTitle: "Master", master: { sessionID: "s", title: "Master", state: "Running" }, members: [], concurrency: "2", openNote: "Opens master" }], selectedID: "p", onSelect: () => {}, onOpenMaster: () => {}, onChangeConcurrency: () => {} }))
  expect(projects.match(/class="rl-radio"/g)?.length).toBe(4)
  expect(projects.match(/aria-checked="true"/g)?.length).toBe(1)
})

test("activity rows carry a state icon, open rows end in a chevron and unopenable rows stay plain", () => {
  const activity = renderToString(() => createComponent(SharedActivitySurface, {
    shells: [{ id: "bad", command: "bun test", status: "exited 1", exit: 1 }, { id: "good", command: "ls", status: "exited 0", exit: 0 }, { id: "live", command: "dev", status: "running" }],
    subagents: [{ sessionID: "open", agent: "worker", description: "Openable", state: "completed", model: "m", onOpen: () => {} }, { sessionID: "closed", agent: "worker", description: "Closed", state: "failed", model: "m" }],
  }))
  expect(activity.match(/data-state="failed"/g)?.length).toBe(2)
  expect(activity.match(/data-state="done"/g)?.length).toBe(2)
  expect(activity.match(/data-state="active"/g)?.length).toBe(1)
  expect(activity.match(/class="rl-activity-row__icon"/g)?.length).toBe(5)
  expect(activity.match(/class="rl-activity-row__chevron"/g)?.length).toBe(4)
  expect(activity.match(/<button[^>]*class="rl-activity-row"/g)?.length).toBe(4)
  expect(activity.match(/<div[^>]*class="rl-activity-row"/g)?.length).toBe(1)
  expect(activity).not.toContain(">Open</button>")
  expect(activity.match(/class="rl-activity-row__icon" aria-hidden="true"><svg/g)?.length).toBe(5)
  expect(activity.match(/class="rl-activity-row__chevron" aria-hidden="true"><svg/g)?.length).toBe(4)
})

test("changes scope is an owned select that filters the existing file set and reports truthful states", () => {
  const first = { path: "first.ts", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1 }
  const second = { path: "second.ts", patch: "@@ -1 +1 @@\n-c\n+d", additions: 1, deletions: 1 }
  const turns = [{ id: "t1", label: "Turn one", files: [first] }, { id: "t2", label: "Turn two", files: [] }]
  const render = (props: Record<string, unknown>) => withWindow(() => renderToString(() => createComponent(SharedChangesSurface, { files: [first, second], turns, onSelectTurn: () => {}, ...props })))
  const initial = render({ selectedPath: "second.ts" })
  expect(initial).toContain('class="custom-select__trigger"')
  expect(initial).toContain('aria-expanded="false"')
  expect(initial).toContain("All Session changes")
  expect(initial).not.toContain('role="listbox"')
  expect(initial).not.toContain("<select")
  expect(initial).toContain("first.ts")
  expect(initial).toContain("second.ts")
  expect(initial.match(/data-selected="true"/g)?.length).toBe(1)
  expect(initial).toMatch(/data-selected="true"[^>]*>(?:(?!<\/button>).)*second\.ts/)
  expect(initial.match(/aria-current="true"/g)?.length).toBe(1)
  expect(initial.match(/class="rl-file-jump__icon" aria-hidden="true"><svg/g)?.length).toBe(2)
  expect(initial).toMatch(/rl-pane-section-heading[^>]*><div class="rl-turn-filter">/)
  expect(initial).not.toContain(">Session changes</strong>")
  const filtered = render({ selectedTurnID: "t1" })
  expect(filtered).toContain("Turn one")
  expect(filtered).not.toContain("second.ts")
  expect(render({ selectedTurnID: "t2" })).toContain("No captured file changes in this turn.")
  const missing = render({ selectedTurnID: "gone", turns: [] })
  expect(missing).toContain("Turn unavailable")
  expect(missing).toContain("This turn is no longer available.")
  const bare = render({ turns: [] })
  expect(bare).not.toContain("custom-select")
  expect(bare).toContain("<strong>Session changes</strong>")
})

test("the full changes action is an outlined pill with a file icon and keeps its label and callback", () => {
  const html = renderToString(() => createComponent(SharedChangesSurface, { files: [], onOpenFullChanges: () => {} }))
  expect(html).toMatch(/<button[^>]*class="rl-btn rl-changes-open-full"[^>]*><span class="rl-changes-open-full__icon" aria-hidden="true"><svg/)
  expect(html).toContain("<span>Open full changes page</span>")
  expect(renderToString(() => createComponent(SharedChangesSurface, { files: [], onOpenFullChanges: () => {}, fullChangesLabel: "Full view" }))).toContain("<span>Full view</span>")
  expect(renderToString(() => createComponent(SharedChangesSurface, { files: [] }))).not.toContain("rl-changes-open-full")
})

test("the activity refresh keeps its button semantics and name and gains the refresh icon", () => {
  const html = renderToString(() => createComponent(SharedCompanionSurface, { active: "activity", onSelect: () => {}, onRefresh: () => {}, activityContent: "Activity", changesContent: "Changes" }))
  expect(html).toMatch(/<button[^>]*class="button button--secondary button--small"[^>]*><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><span>Refresh<\/span><\/button>/)
  expect(renderToString(() => createComponent(SharedCompanionSurface, { active: "activity", onSelect: () => {}, activityContent: "Activity", changesContent: "Changes" }))).not.toContain("Refresh")
})

test("expanded disclosures render Markdown cards and every disclosure control uses SVG icons", () => {
  const pseudoIcons = ["⌄", "›", "✓", "×", "•"]
  const closedTool = renderToString(() => createComponent(SharedToolDisclosure, { tools: [{ id: "t", name: "bash", status: "completed" }] }))
  expect(closedTool).toMatch(/class="rl-disclosure-icon" aria-hidden="true"><svg/)
  expect(closedTool).toMatch(/class="rl-disclosure-chev" aria-hidden="true"><svg/)
  expect(closedTool).not.toContain("rl-disclosure-card")
  const tool = renderToString(() => createComponent(SharedToolDisclosure, { defaultOpen: true, reasoning: "**Plan** first", tools: [{ id: "a", name: "read", status: "completed", summary: "file", outputText: "# Report\n\n- item", markdown: true }, { id: "b", name: "bash", status: "failed", errorText: "exit 1" }] }))
  for (const pseudo of pseudoIcons) expect(tool).not.toContain(pseudo)
  expect(tool).toMatch(/class="rl-disclosure-card rl-tools-card"><div class="rl-card-markdown"><div class="transcript-md"><p><strong>Plan<\/strong>/)
  expect(tool.match(/class="rl-step-card"/g)?.length).toBe(2)
  expect(tool).toMatch(/class="rl-step-card" data-status="completed"><div class="rl-step-head"><span class="rl-step-icon" aria-hidden="true"><svg/)
  expect(tool).toContain('<span class="rl-step-summary">file</span>')
  expect(tool).toMatch(/class="rl-card-markdown"><div class="transcript-md"><div class="transcript-md__heading transcript-md__heading--1" role="heading" aria-level="1">Report/)
  expect(tool).toMatch(/class="rl-step-error" role="status"><svg[\s\S]*?<\/svg><span>exit 1<\/span>/)
  expect(tool).toMatch(/class="rl-disclosure-icon" aria-hidden="true"><svg[^>]*><path d="M12 4l9 16H3z"/)
  const plain = renderToString(() => createComponent(SharedToolDisclosure, { defaultOpen: true, tools: [{ id: "c", name: "bash", status: "completed", outputText: "# raw" }] }))
  expect(plain).toContain('<pre class="rl-output"><code># raw</code></pre>')
  const closedReasoning = renderToString(() => createComponent(SharedReasoningDisclosure, { text: "analysis", streaming: false }))
  for (const pseudo of ["…", "✓"]) expect(closedReasoning).not.toContain(pseudo)
  expect(closedReasoning).toMatch(/class="transcript-reasoning__tag"><svg/)
  expect(closedReasoning).toMatch(/class="rl-disclosure-chev" aria-hidden="true"><svg/)
  expect(closedReasoning).not.toContain("rl-disclosure-card")
  const reasoning = renderToString(() => createComponent(SharedReasoningDisclosure, { text: "## Steps\n\n1. **Read** `a.ts`\n\n| A | B |\n| - | - |\n| 1 | 2 |", defaultOpen: true }))
  expect(reasoning).toMatch(/class="transcript-reasoning__body rl-reason rl-disclosure-card"><div class="transcript-md">/)
  for (const text of ['aria-level="2"', "<ol", "<strong>Read</strong>", "<code>a.ts</code>", "<table>"]) expect(reasoning).toContain(text)
  const card = renderToString(() => createComponent(SharedEditedFilesCard, { defaultOpen: true, files: [{ path: "a.ts", patch: "", additions: 1, deletions: 0 }], onViewChanges: () => {}, onUndo: () => {} }))
  for (const pseudo of ["⌄", "›"]) expect(card).not.toContain(pseudo)
  expect(card).toMatch(/class="rl-edited-disclosure" aria-expanded="true"><svg/)
  expect(card).toMatch(/class="rl-disclosure-chev" aria-hidden="true"><svg/)
  expect(card).toMatch(/<button[^>]*class="rl-edited-file"[^>]*><svg/)
  const companion = renderToString(() => createComponent(SharedCompanionSurface, { active: "activity", onSelect: () => {}, onCloseTab: () => {}, onAddTab: () => {}, activityContent: "Activity", changesContent: "Changes" }))
  expect(companion).not.toContain(">×<")
  expect(companion).not.toContain(">+<")
  expect(companion).not.toMatch(/role="tab"[^>]*><svg/)
  for (const tab of ["Activity", "Changes", "Context"]) expect(companion).toMatch(new RegExp(`role="tab"[^>]*>${tab}</button>`))
  expect(companion).toMatch(/class="rl-icon rl-pane-tab-add"[^>]*><svg/)
  const page = renderToString(() => createComponent(SharedPageSurface, { title: "Usage", onBack: () => {}, children: "Body" }))
  expect(page).toMatch(/data-action-id="page-back"[^>]*><svg class="rl-ico rl-ico--back"[\s\S]*?<path d="M19 12H5"/)
})

test("user turns render supplied Markdown and keep plain text turns unchanged", () => {
  const markdown = renderToString(() => createComponent(SharedMessageTurn, { kind: "user", markdownText: "Use **bold** and `code`" }))
  expect(markdown).toMatch(/<div class="transcript-message__bubble"><div class="transcript-md"><p>Use <strong>bold<\/strong> and <code>code<\/code>/)
  expect(markdown).not.toContain('<p class="transcript-message__bubble">')
  const plain = renderToString(() => createComponent(SharedMessageTurn, { kind: "user", text: "**Hello**" }))
  expect(plain).toContain('<p class="transcript-message__bubble">**Hello**</p>')
  expect(plain).not.toContain("transcript-md")
})

test("settings offer an icon-led theme choice and expanded sections render as cards", () => {
  const base = { animations: true, keepAwakeChecked: false, keepAwakeDetail: "Off", telemetryConsent: "undecided" as const, telemetryNote: "Not decided", onToggleAnimations: () => {}, onToggleKeepAwake: () => {}, onDecideTelemetry: () => {}, onToggleNotifications: () => {}, onToggleSavedPermissions: () => {}, onToggleCloseApp: () => {} }
  const themed = renderToString(() => createComponent(SharedSettingsSurface, { ...base, theme: "dark", onThemeChange: () => {}, notificationsOpen: true, notificationsContent: "Notification list", savedPermissionsContent: "Rules", closeAppContent: "Quit details" }))
  const appearance = themed.slice(themed.indexOf('data-part="st-appearance"'), themed.indexOf('data-part="st-keep-awake"'))
  expect(appearance).toContain('role="radiogroup" aria-label="Theme"')
  expect(appearance.indexOf('aria-label="Theme"')).toBeLessThan(appearance.indexOf('aria-label="Animations"'))
  expect(appearance.match(/class="rl-radio"/g)?.length).toBe(3)
  for (const [label, path] of [["Light", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"], ["Dark", "M20.35 14.15A8.5 8.5 0 1 1 9.85 3.65a7 7 0 0 0 10.5 10.5z"], ["System", "M3 4.5h18v11H3z"]]) expect(appearance).toMatch(new RegExp(`<svg[^>]*><path d="${path!.replace(/\./g, "\\.")}"[\\s\\S]*?<span>${label}</span>`))
  expect(appearance).toMatch(/role="radio" class="rl-radio" aria-checked="true"[^>]*>[\s\S]*?<span>Dark<\/span>/)
  for (const content of ["Notification list", "Rules", "Quit details"]) expect(themed).toContain(`<div class="st-disclosure-card">${content}</div>`)
  expect(themed).toMatch(/data-action-id="st-open-notifications" aria-expanded="true"/)
  expect(themed.match(/<h3><svg/g)?.length).toBe(6)
  for (const [action, label] of [["st-open-notifications", "Open notifications"], ["st-saved-permissions", "Review saved rules"], ["st-open-quit", "Close app"]]) expect(themed).toMatch(new RegExp(`data-action-id="${action}"[^>]*>${label}</button>`))
  expect(themed).toContain('class="relay-settings st-stack st-ledger-settings"')
  const order = ["st-appearance", "st-keep-awake", "st-notify", "st-permissions", "st-close", "st-telemetry"].map((part) => themed.indexOf(`data-part="${part}"`))
  expect(order).toEqual([...order].sort((a, b) => a - b))
  const plain = renderToString(() => createComponent(SharedSettingsSurface, base))
  expect(plain).not.toContain('aria-label="Theme"')
  expect(plain).not.toContain("st-disclosure-card")
})

test("destination surfaces carry icon slots and accept a custom concurrency control", () => {
  const sessions = renderToString(() => createComponent(SharedSessionsSurface, { search: "", filters: [{ value: "all", label: "All", count: 1 }], filter: "all", pinning: false, items: [{ id: "s", title: "Session", hint: "Workspace", meta: "Ready", pinned: false }], totalLoaded: 1, pinnedCount: 0, onNewSession: () => {}, onSearch: () => {}, onFilter: () => {}, onTogglePinMode: () => {}, onSelect: () => {} }))
  expect(sessions).toMatch(/<span class="rl-input-icon"><svg[\s\S]*?<\/svg><input type="search"/)
  expect(sessions).toMatch(/class="rl-option-name"><span aria-hidden="true"><svg[^>]*><path d="M4 4.5h16v11H9l-5 4z"/)
  const workspaces = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: [{ projectID: "w", name: "work", directory: "/work", sessions: 1, topLevelSummary: "1", childSummary: "0", copies: [] }], selectedID: "w:/work", onSelect: () => {}, onRefreshCopies: () => {}, onOpenCreateCopy: () => {}, onStartChat: () => {}, onForgetWorkspace: () => {} }))
  expect(workspaces).toMatch(/class="ws-location" data-part="ws-projects-location"><svg/)
  expect(workspaces).toMatch(/class="ws-location" data-part="ws-projects-location"><svg[\s\S]*?<\/svg><span class="ws-location__label">No Session is open\.<\/span><\/div>/)
  const located = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: [], currentSession: { title: "Polish", directory: "/work", workspace: "work" }, onSelect: () => {} }))
  expect(located).toMatch(/<\/svg><span class="ws-location__label">This Session <strong>Polish<\/strong><\/span><p>Location <code>\/work<\/code> · workspace work<\/p><\/div>/)
  expect(workspaces).toMatch(/class="rl-option"[^>]*><span class="rl-option-text"><span class="rl-option-name"><span aria-hidden="true"><svg/)
  for (const label of ["Refresh", "New copy", "Start chat"]) expect(workspaces).toMatch(new RegExp(`<svg[^>]*>(?:(?!</svg>)[\\s\\S])*</svg> ${label}</button>`))
  const project = { id: "p", name: "Project", active: true, statusText: "Ready", revision: 3, masterTitle: "Master", master: { sessionID: "s", title: "Master", state: "Running" }, members: [], concurrency: "2", openNote: "Opens master" }
  const projects = renderToString(() => createComponent(SharedProjectsSurface, { projects: [project], selectedID: "p", onSelect: () => {}, onOpenMaster: () => {}, onChangeConcurrency: () => {}, onRefresh: () => {}, onOpenCreate: () => {}, onDeleteProject: () => {}, concurrencyControl: (selected: { readonly name: string }) => createComponent(() => `Custom limit for ${selected.name}`, {}) }))
  expect(projects).toContain("Custom limit for Project")
  expect(projects).not.toContain('aria-label="Members running at once"')
  expect(projects).not.toContain("+ New project")
  for (const action of ["st-coord-new", "st-coord-open", "st-coord-delete"]) expect(projects).toMatch(new RegExp(`data-action-id="${action}"[^>]*><svg`))
  const usage = renderToString(() => createComponent(SharedUsageSurface, { phase: "ready", statusText: "Updated", ranges: [], range: "today", rangeLabel: "Today", requests: "2", inputTokens: "10", outputTokens: "5", estimatedCost: "$1", models: [{ name: "m", detail: "d", value: "v" }], onRange: () => {}, onRefresh: () => {} }))
  expect(usage).toMatch(/data-action-id="st-usage-refresh"[^>]*><svg/)
  expect(usage.match(/class="st-tile"><small><svg/g)?.length).toBe(4)
  expect(usage.match(/<h3><svg/g)?.length).toBe(2)
})

test("destination actions lead with registry icons and workspace rows do not repeat identical paths", () => {
  const sessions = renderToString(() => createComponent(SharedSessionsSurface, { search: "", filters: [{ value: "all", label: "All", count: 0 }], filter: "all", pinning: false, items: [], totalLoaded: 0, pinnedCount: 0, onNewSession: () => {}, onSearch: () => {}, onFilter: () => {}, onTogglePinMode: () => {}, onTogglePin: () => {}, onSelect: () => {} }))
  expect(sessions).not.toContain("+ New Session")
  expect(sessions).toContain("M12 5v14")
  const same = ["/one"].map((directory) => ({ projectID: "p", name: directory, directory, sessions: 1, topLevelSummary: "1", childSummary: "0", copies: [] }))
  const list = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: same, onSelect: () => {} }))
  expect(list.split("/one").length - 1).toBe(1)
  const detail = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: [{ projectID: "w", name: "work", directory: "/work", sessions: 1, topLevelSummary: "1", childSummary: "0", copies: [] }], selectedID: "w:/work", onSelect: () => {}, onForgetWorkspace: () => {} }))
  const forget = detail.slice(detail.indexOf('data-action-id="ws-projects-forget"'))
  expect(forget.slice(0, forget.indexOf("</button>"))).toContain("<svg")
  const copies = detail.slice(detail.indexOf("New copy") - 200, detail.indexOf("New copy"))
  expect(copies).not.toContain("+")
})

const searchable = [
  { projectID: "a", name: "alpha", directory: "/src/alpha", sessions: 1, topLevelSummary: "1", childSummary: "0", copies: [] },
  { projectID: "b", name: "beta", directory: "/work/beta", sessions: 2, topLevelSummary: "2", childSummary: "0", copies: [{ name: "beta-fix", directory: "/work/beta-fix" }] },
]
const renderWorkspaces = (props: Record<string, unknown>) => renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: searchable, onSelect: () => {}, ...props }))
const optionCount = (html: string) => html.match(/role="option"/g)?.length ?? 0

test("workspace search filters by name, directory and loaded copies and keeps the box mounted", () => {
  const all = renderWorkspaces({})
  expect(all).toMatch(/class="rl-workspace-search"[\s\S]*?<svg[\s\S]*?<input type="search"[^>]*aria-label="Search workspaces"/)
  expect(all).toContain('placeholder="Search workspaces or paths..."')
  expect(optionCount(all)).toBe(2)
  expect(all).not.toContain('aria-label="Clear workspace search"')
  const byName = renderWorkspaces({ searchQuery: " ALPHA ", onSearchChange: () => {} })
  expect(optionCount(byName)).toBe(1)
  expect(byName).toContain("/src/alpha")
  expect(byName).not.toContain("/work/beta")
  expect(byName).toMatch(/<button type="button" class="rl-icon-button" aria-label="Clear workspace search"/)
  const byPath = renderWorkspaces({ searchQuery: "/work" })
  expect(optionCount(byPath)).toBe(1)
  expect(byPath).toContain("beta")
  expect(byPath).not.toContain("/src/alpha")
  expect(optionCount(renderWorkspaces({ searchQuery: "beta-fix" }))).toBe(1)
  const none = renderWorkspaces({ searchQuery: "zzz" })
  expect(optionCount(none)).toBe(0)
  expect(none).toContain("No workspaces match")
  expect(none).toContain("zzz")
  expect(none).toMatch(/<button type="button" class="rl-btn"[^>]*>Clear search<\/button>/)
  expect(none).toContain('aria-label="Search workspaces"')
})

test("workspace folder actions render only when their callbacks are supplied", () => {
  const actions = renderWorkspaces({ onOpenFolder: () => {}, onCreateFolder: () => {} })
  expect(actions).toMatch(/<button type="button" class="rl-btn"><svg[^>]*><path d="M3 5\.5h6l2 2h10v11H3z"><\/path><\/svg> Open folder…<\/button>/)
  expect(actions).toMatch(/<button type="button" class="rl-btn"><svg[^>]*><path d="M3 5\.5h6l2 2h10v11H3z"><\/path><path d="M12 10\.5v5"><\/path><path d="M9\.5 13h5"><\/path><\/svg> New folder…<\/button>/)
  const bare = renderWorkspaces({})
  expect(bare).not.toContain("Open folder…")
  expect(bare).not.toContain("New folder…")
})

test("the selected workspace shows a navigable files explorer when one is supplied", () => {
  const explorer = { directory: "/src/alpha/lib", rootDirectory: "/src/alpha", parent: "/src/alpha", entries: [{ name: "nested", path: "/src/alpha/lib/nested", kind: "directory" as const }, { name: "index.ts", path: "/src/alpha/lib/index.ts", kind: "file" as const }], showHidden: false, onNavigate: () => {}, onToggleHidden: () => {}, onCreateFolder: () => {}, onStartChatInFolder: () => {} }
  const html = renderWorkspaces({ selectedID: "a:/src/alpha", explorer })
  const files = html.slice(html.indexOf('aria-label="Workspace files"'))
  expect(files).toContain(">FILES</h3>")
  for (const label of ["Up", "Root", "Hidden", "New folder", "Chat here"]) expect(files).toMatch(new RegExp(`<button[^>]*>(?:<svg[\\s\\S]*?</svg> )?${label}</button>`))
  expect(files).toContain("<code>/src/alpha/lib</code>")
  expect(files).toMatch(/<button type="button" class="rl-option" data-kind="directory" data-path="\/src\/alpha\/lib\/nested"[^>]*><svg[^>]*><path d="M3 5\.5h6l2 2h10v11H3z"[\s\S]*?nested/)
  expect(files).toMatch(/<span class="rl-option" data-kind="file"[^>]*><svg[^>]*><path d="M6 3h8l4 4v14H6z"[\s\S]*?index\.ts/)
  expect(files).toContain('aria-pressed="false"')
  expect(files).not.toMatch(/<button[^>]*disabled[^>]*>(?:<svg[\s\S]*?<\/svg> )?Up<\/button>/)
  const atRoot = renderWorkspaces({ selectedID: "a:/src/alpha", explorer: { ...explorer, directory: "/src/alpha", parent: null, entries: [] } })
  expect(atRoot).toMatch(/<button[^>]*disabled[^>]*>(?:<svg[\s\S]*?<\/svg> )?Up<\/button>/)
  expect(atRoot).toContain("This folder is empty.")
  expect(renderWorkspaces({ selectedID: "a:/src/alpha" })).not.toContain("Workspace files")
})

const projectCandidates = ["s1", "s2", "s3", "s4", "s5"].map((id) => ({ id, title: `Session ${id}`, selected: false }))
const projectBase = { projects: [], creating: true, candidates: projectCandidates, onSelect: () => {}, onOpenMaster: () => {}, onChangeConcurrency: () => {} }

test("new project offers an existing Master Session or a new Session in a folder", () => {
  const html = renderToString(() => createComponent(SharedProjectsSurface, { ...projectBase, onCreateProject: () => {}, onCreateProjectInDirectory: () => {}, onBrowseFolder: () => {}, directories: [{ directory: "/work/app", name: "app" }] }))
  const source = html.slice(html.indexOf('class="rl-source-tabs"'))
  expect(source).toMatch(/role="radiogroup" aria-label="Master Session source"/)
  expect(source).toMatch(/aria-checked="true"[^>]*>[\s\S]*?<span>Existing Session<\/span>/)
  expect(source).toContain("<span>New Session in folder</span>")
  expect(html).toContain('aria-label="Search Sessions"')
  expect(html).toMatch(/role="radiogroup" aria-label="Master Session"/)
  expect(html).toMatch(/role="group" aria-label="Member Sessions"/)
  expect(html.match(/type="checkbox"/g)?.length).toBe(5)
  const legacy = renderToString(() => createComponent(SharedProjectsSurface, { ...projectBase, candidates: projectCandidates.slice(0, 2) }))
  expect(legacy).not.toContain("Master Session source")
  expect(legacy).not.toContain('aria-label="Search Sessions"')
})

test("an existing-Session project submits the chosen Master Session and members without the Master", () => {
  const created: SharedProjectCreateInput[] = []
  const options = { name: "  Release  ", candidates: projectCandidates, onCreateProject: (input: SharedProjectCreateInput) => created.push(input) }
  const form = createSharedProjectForm(options)
  form.submit()
  expect(created).toEqual([])
  expect(form.error()).toBe("Enter a project name and choose a Master Session first.")
  form.toggleMember("s1")
  form.toggleMember("s3")
  form.chooseMaster("s1")
  const html = renderToString(() => createComponent(SharedProjectsSurface, { ...projectBase, ...options, form }))
  expect(html.match(/>Master<\/span>/g)?.length).toBe(1)
  expect(html.match(/type="checkbox"/g)?.length).toBe(4)
  form.submit()
  expect(created).toEqual([{ name: "Release", masterSessionID: "s1", memberSessionIDs: ["s3"] }])
})

test("a new-folder project browses for a folder and submits the directory, title and members", () => {
  const created: SharedProjectDirectoryInput[] = []
  const browsed: string[] = []
  const options = { name: "Release", candidates: projectCandidates, onCreateProjectInDirectory: (input: SharedProjectDirectoryInput) => created.push(input), onBrowseFolder: (current: string, choose: (directory: string) => void) => { browsed.push(current); choose("/work/new-folder") } }
  const form = createSharedProjectForm(options)
  form.setSource("directory")
  form.submit()
  expect(created).toEqual([])
  expect(form.error()).toBe("Enter a project name and choose a folder first.")
  form.browse()
  expect(browsed).toEqual([""])
  expect(form.directory()).toBe("/work/new-folder")
  const html = renderToString(() => createComponent(SharedProjectsSurface, { ...projectBase, ...options, directories: [{ directory: "/work/app", name: "app" }], form }))
  expect(html).toMatch(/aria-checked="true"[^>]*>[\s\S]*?<span>New Session in folder<\/span>/)
  expect(html).toMatch(/<input[^>]*aria-label="Project folder path"[^>]*placeholder="\/path\/to\/folder"[^>]*value="\/work\/new-folder"/)
  expect(html).toMatch(/<svg[^>]*><path d="M3 5\.5h6l2 2h10v11H3z"><\/path><path d="M12 10\.5v5"[\s\S]*?<\/svg> Browse \/ New folder…<\/button>/)
  expect(html).toContain('placeholder="Defaults to project name"')
  expect(html).toContain(">app</button>")
  expect(html).toContain('role="alert"')
  form.setMasterTitle("  Lead  ")
  form.toggleMember("s2")
  form.submit()
  expect(created).toEqual([{ name: "Release", directory: "/work/new-folder", masterTitle: "Lead", memberSessionIDs: ["s2"] }])
  expect(form.error()).toBeUndefined()
  form.setMasterTitle(" ")
  form.submit()
  expect(created[1]).toEqual({ name: "Release", directory: "/work/new-folder", memberSessionIDs: ["s2"] })
})

test("every TUI-parity icon renders a 24 by 24 stroked SVG", () => {
  const names = ["plug", "server", "git-fork", "git-branch", "undo", "redo", "archive", "download", "globe", "folder-plus", "help", "bookmark", "list", "paperclip", "hand", "alert", "arrow-up-right", "sparkles", "monitor", "devices", "bell", "shield"] as IconName[]
  for (const name of names) {
    const html = renderToString(() => createComponent(Icon, { name }))
    expect(html).toMatch(/^<svg[^>]*viewBox="0 0 24 24"[^>]*stroke-width="1\.6"[^>]*stroke-linecap="round"[^>]*stroke-linejoin="round"[^>]*><path d="M[^"]+"/)
  }
  expect(renderToString(() => createComponent(Icon, { name: "arrow-up-right" }))).toContain('<path d="M7 17L17 7"></path><path d="M7 7h10v10"></path>')
})

test("radio options flag icons with data-has-icon without changing the class", () => {
  const html = renderToString(() => createComponent(SharedRadioGroup, { label: "Mode", value: "a", onChange: () => {}, options: [{ value: "a", label: "A", icon: "folder" as IconName }, { value: "b", label: "B" }] }))
  const buttons = html.match(/<button[^>]*>/g) ?? []
  expect(buttons).toHaveLength(2)
  expect(buttons[0]).toContain('class="rl-radio"')
  expect(buttons[0]).toContain('data-has-icon="true"')
  expect(buttons[1]).toContain('class="rl-radio"')
  expect(buttons[1]).not.toContain("data-has-icon")
})

const compactionBase = { label: "Compacting", total: "Total", reduction: 0, number: "", items: "" }

test("compaction divider shows indeterminate progress while running and no misleading metrics", () => {
  const running = renderToString(() => createComponent(SharedCompactionDivider, { ...compactionBase, completed: false, status: "running" }))
  expect(running).toContain("transcript-compaction--running")
  expect(running).toContain('data-status="running"')
  expect(running).toContain("transcript-compaction__indeterminate")
  expect(running).toContain('role="status"')
  expect(running).not.toContain("Metrics not reported")
  expect(running).not.toContain("transcript-compaction__bar")
  expect(running).not.toContain("transcript-compaction__details")
  const implicit = renderToString(() => createComponent(SharedCompactionDivider, { ...compactionBase, completed: false }))
  expect(implicit).toContain("transcript-compaction__indeterminate")
})

test("compaction divider settles with or without token metrics", () => {
  const bare = renderToString(() => createComponent(SharedCompactionDivider, { ...compactionBase, completed: false, status: "completed" }))
  expect(bare).not.toContain("transcript-compaction__bar")
  expect(bare).not.toContain("transcript-compaction__indeterminate")
  expect(bare).not.toContain("transcript-compaction--running")
  expect(bare).not.toContain("Metrics not reported")
  const noted = renderToString(() => createComponent(SharedCompactionDivider, { ...compactionBase, completed: false, status: "failed", number: "Provider error", items: "3 items" }))
  expect(noted).toContain("Provider error · 3 items")
  expect(noted).not.toContain("transcript-compaction__bar")
  const done = renderToString(() => createComponent(SharedCompactionDivider, { ...compactionBase, completed: true, status: "completed", reduction: 40, number: "Saved", items: "Items" }))
  expect(done).toContain('class="transcript-compaction transcript-compaction--completed"')
  expect(done).toContain('aria-label="40% of input tokens removed"')
  expect(done).toContain("width:40%")
  expect(done).toContain("Items")
})

test("usage quota cards keep header, account, status, groups, bars and note inside one card", () => {
  const usage = renderToString(() => createComponent(SharedUsageSurface, { phase: "ready", statusText: "Updated", ranges: [], range: "today", rangeLabel: "Today", requests: "2", inputTokens: "10", outputTokens: "5", estimatedCost: "$1", quotas: [
    { provider: "Anthropic", account: "dev@example.test", status: "Limited", statusTone: "warn", note: "Resets weekly", windows: [{ label: "5 hour", group: "Claude", used: 82.34, detail: "82%", reset: "in 2h", level: "warn" }, { label: "Weekly", group: "Claude", used: 95, detail: "95%", level: "danger" }, { label: "Credits", group: "Extra", detail: "Unreported" }] },
    { provider: "Other", windows: [] },
  ], onRange: () => {}, onRefresh: () => {} }))
  expect(usage).toContain('class="st-quota-grid"')
  const cards = usage.split('<div class="st-quota"').slice(1)
  expect(cards.length).toBe(2)
  const first = cards[0]!
  for (const text of ['class="st-quota-account">dev@example.test', 'class="st-chip" data-tone="wait">Limited', 'class="st-quota-group">Claude', 'class="st-quota-group">Extra', 'class="st-quota-note">Resets weekly', "in 2h", 'class="st-track-empty"']) expect(first).toContain(text)
  expect(first.match(/class="st-quota-group"/g)?.length).toBe(2)
  expect(first).toContain('class="rl-progress" data-level="warn"')
  expect(first).toContain('class="rl-progress" data-level="danger"')
  expect(first).toContain('data-reported="false"')
  expect(first).toContain('aria-label="Anthropic (dev@example.test) 5 hour used"')
  expect(first).toContain('aria-valuenow="82.3"')
  expect(usage.indexOf("st-quota-note")).toBeLessThan(usage.indexOf("Other"))
  const prepared = renderToString(() => createComponent(SharedUsageSurface, { phase: "preparing", statusText: "Loading", ranges: [], range: "today", rangeLabel: "Today", requests: "—", inputTokens: "—", outputTokens: "—", estimatedCost: "—", quotas: [], onRange: () => {}, onRefresh: () => {} }))
  expect(prepared).toContain('class="rl-indeterminate"')
  expect(prepared).toContain("No provider quotas reported.")
})

test("loading skeleton exposes status semantics and a stable kind", () => {
  const page = renderToString(() => createComponent(SharedLoadingSkeleton, { label: "Loading" }))
  expect(page).toContain('class="rl-skeleton" data-kind="page" role="status" aria-live="polite"')
  expect(page).toContain("Loading")
  for (const kind of ["conversation", "companion", "list"] as const) {
    const html = renderToString(() => createComponent(SharedLoadingSkeleton, { kind, label: "Loading" }))
    expect(html).toContain(`data-kind="${kind}"`)
    expect(html).toContain("rl-skeleton__bar")
  }
})

test("shared surfaces expose semantic hooks: page surface, project split, ring level, counts, running steps", () => {
  const page = renderToString(() => createComponent(SharedPageSurface, { title: "Usage Overview", children: "Body" }))
  expect(page).toContain('data-part="page" data-surface="usage-overview"')
  const projects = renderToString(() => createComponent(SharedProjectsSurface, { projects: [{ id: "p", name: "Project", active: true, statusText: "Ready", revision: 3, masterTitle: "Master", master: { sessionID: "s", title: "Master", state: "Running" }, members: [], openNote: "Opens master" }], selectedID: "p", onSelect: () => {}, onOpenMaster: () => {}, onChangeConcurrency: () => {} }))
  expect(projects).toContain('class="ws-split ws-projects"')
  for (const [fraction, level] of [[0.42, "ok"], [0.7, "warn"], [0.9, "danger"], [undefined, "ok"]] as const) {
    const ring = renderToString(() => createComponent(SharedContextRingButton, { fraction, label: "x", ariaLabel: "Open context", expanded: false, onClick: () => {} }))
    expect(ring).toContain(`data-level="${level}"`)
    expect(ring).toContain('class="rl-ring-value"')
    expect(ring).not.toContain('stroke="var(--yc-green-strong)"')
  }
  const sessions = renderToString(() => createComponent(SharedSessionsSurface, { search: "", filters: [{ value: "all", label: "All", count: 1250 }], filter: "all", pinning: false, items: [{ id: "a", title: "A", hint: "Waiting for input", meta: "now", pinned: false }, { id: "b", title: "B", hint: "Running", meta: "now", pinned: false }, { id: "c", title: "C", hint: "Idle", meta: "now", pinned: false }], totalLoaded: 1250, pinnedCount: 0, onNewSession: () => {}, onSearch: () => {}, onFilter: () => {}, onTogglePinMode: () => {}, onSelect: () => {} }))
  expect(sessions).toContain("All 1,250")
  expect(sessions.match(/1,250/g)?.length).toBe(2)
  expect(sessions).toContain('data-status="waiting"')
  expect(sessions).toContain('data-status="running"')
  const workspaces = renderToString(() => createComponent(SharedWorkspacesSurface, { workspaces: [{ projectID: "p", name: "W", directory: "/w", sessions: 1250, topLevelSummary: "", childSummary: "", copies: [] }], onSelect: () => {} }))
  expect(workspaces).toContain("1,250")
  const tools = renderToString(() => createComponent(SharedToolDisclosure, { defaultOpen: true, tools: [{ id: "t", name: "bash", status: "running" }, { id: "u", name: "read", status: "completed" }] }))
  expect(tools.match(/class="rl-indeterminate"/g)?.length).toBe(1)
})

test("workspace shell styles define quota cards, level colors and reduced-motion-safe loading motion", async () => {
  const css = await Bun.file(new URL("../../styles/workspace-shell.css", import.meta.url)).text()
  for (const selector of [".st-quota-grid", ".st-quota-provider", ".rl-skeleton", ".transcript-compaction__indeterminate", '.rl-progress[data-level="danger"]', "translate3d", "prefers-reduced-motion: reduce", 'html[data-animations="off"]']) expect(css).toContain(selector)
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
})

test("quota rows share a two-row grid so every bar spans the card regardless of value length", async () => {
  const css = await Bun.file(new URL("../../styles/workspace-shell.css", import.meta.url)).text()
  const block = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? ""
  const row = block(".st-quota-row")
  expect(row).toContain("display:grid")
  expect(row).toContain('grid-template-columns:minmax(0, 1fr) auto')
  expect(row).toContain('grid-template-areas:"label value" "bar bar"')
  expect(block(".st-quota-label")).toContain("grid-area:label")
  expect(block(".st-quota-label")).toContain("white-space:normal")
  expect(block(".st-quota-value")).toContain("grid-area:value")
  expect(block(".st-quota-value")).toContain("white-space:nowrap")
  expect(block(".st-quota-row > :is(.rl-progress, .st-track-empty)")).toContain("grid-area:bar")
})

test("the context panel ends in full-width usage and retained-message rows and keeps optional controls", () => {
  const messages = [{ id: "a", role: "user", summary: "Question" }, { id: "b", role: "assistant", summary: "Answer" }]
  const compacted: string[] = []
  const html = renderToString(() => createComponent(SharedContextBreakdownPanel, { used: "182,400", capacity: "500K", remaining: 317600, label: "36% used", fraction: 0.25, stepDiagnostics: { uncachedInput: 4212, output: 1086, reasoning: 2340, cacheRead: 176104, cacheWrite: 2084, hitRatio: 0.965, latestInvalidation: "Tools changed" }, onOpenUsage: () => {}, usageActionLabel: "Usage details", onCompact: () => compacted.push("compact"), compactDisabled: true, contextMessages: messages, staleReason: "Context may differ after a model change." }))
  expect(html).toContain("317,600 remaining · 36% used")
  expect(html).toMatch(/<div class="rl-context-progress" role="progressbar" aria-label="Context window used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="25" data-level="ok"><span style="width:25%"><\/span><\/div>/)
  expect(html).toContain('<p class="rl-context-stale">Context may differ after a model change.</p>')
  for (const text of ["<dt>Cache read</dt><dd>176,104</dd>", '<dt>Hit ratio</dt><dd class="rl-context-hit">96.5%</dd>', "<dt>Latest invalidation</dt><dd>Tools changed</dd>"]) expect(html).toContain(text)
  expect(html).toMatch(/<button type="button" class="rl-btn rl-context-compact" disabled[^>]*>Compact context<\/button>/)
  const footer = html.slice(html.indexOf('class="companion__context-footer"'))
  expect(footer).toMatch(/^class="companion__context-footer"><button type="button" class="rl-context-footer-row rl-context-usage"><span>Usage details<\/span><svg[^>]*><path d="M7 17L17 7"><\/path><path d="M7 7h10v10"><\/path><\/svg><\/button><details class="rl-context-messages"><summary class="rl-context-footer-row"><span>Retained transcript messages<\/span><span class="rl-context-messages__count">2<\/span><span class="rl-context-messages__chev" aria-hidden="true"><svg/)
  expect(footer).toContain('<ol class="rl-context-message-list"><li><strong>user</strong> · Question</li><li><strong>assistant</strong> · Answer</li></ol></details>')
  const bare = renderToString(() => createComponent(SharedContextBreakdownPanel, { used: "1K" }))
  for (const text of ["companion__context-footer", "rl-context-progress", "rl-context-compact", "rl-context-cache"]) expect(bare).not.toContain(text)
  const usageOnly = renderToString(() => createComponent(SharedContextBreakdownPanel, { onOpenUsage: () => {} }))
  expect(usageOnly).toContain("<span>Open Usage · cumulative spend</span>")
  expect(usageOnly).not.toContain("rl-context-messages")
})

test("collapsed transcript disclosures and edited files stay one quiet row until expanded", async () => {
  const files = [{ path: "a.ts", patch: "", additions: 40, deletions: 10 }, { path: "b.ts", patch: "", additions: 8, deletions: 9 }]
  const closed = renderToString(() => createComponent(SharedEditedFilesCard, { files }))
  expect(closed).toMatch(/<button type="button" class="rl-edited-disclosure" aria-expanded="false"><svg[^>]*width="14"[\s\S]*?<\/svg><span class="rl-edited-title">2 files changed<\/span><span class="rl-diff-total"><span class="ws-add">\+48<\/span><span class="ws-del">−19<\/span><\/span>/)
  for (const text of ["data-panel", "data-open", "rl-edited-files"]) expect(closed).not.toContain(text)
  expect(renderToString(() => createComponent(SharedEditedFilesCard, { files, title: "Edited files" }))).toContain('<span class="rl-edited-title">Edited files</span>')
  const opened = renderToString(() => createComponent(SharedEditedFilesCard, { files, defaultOpen: true }))
  expect(opened).toContain('data-open="true" data-panel="true"')
  expect(opened).toContain('class="rl-edited-files"')
  const css = await Bun.file(new URL("../../styles/workspace-shell.css", import.meta.url)).text()
  for (const text of [
    ".rl-edited-card.file-change-card:not([data-panel]) { padding:0; border:0; border-radius:0; background:transparent; box-shadow:none; }",
    ".transcript-tools__button.rl-chip { display:inline-flex;",
    ".transcript-reasoning.rl-reason-disclosure > summary { display:inline-flex;",
    "#companion-context .rl-context-panel .rl-context-total { display:flex; flex-wrap:nowrap; align-items:baseline; gap:var(--yc-space-2);",
    "#companion-context .rl-context-panel .companion__context-bar { display:flex; gap:1px; block-size:8px;",
    "grid-template-columns:minmax(0, 1fr) auto auto",
    ".rl-context-panel .rl-context-footer-row { display:flex; align-items:center; gap:var(--yc-space-2); inline-size:100%; min-block-size:44px;",
    ".relay-settings.st-stack.st-ledger-settings { display:grid; gap:var(--yc-space-8); inline-size:100%; max-inline-size:760px;",
    ".relay-settings.st-stack.st-ledger-settings .st-section { display:grid; gap:var(--yc-space-3); min-inline-size:0; padding:0; border:0; border-radius:0; background:transparent;",
  ]) expect(css).toContain(text)
  for (const disclosure of [".transcript-tools__button.rl-chip {", ".transcript-reasoning.rl-reason-disclosure > summary {", ".rl-edited-card .rl-edited-summary .rl-edited-disclosure {"]) {
    const rule = css.slice(css.indexOf(disclosure), css.indexOf("}", css.indexOf(disclosure)))
    for (const value of ["border:0", "background:transparent", "var(--yc-size-2xs)", "var(--yc-font-mono)"]) expect(rule).toContain(value)
  }
  expect(css).not.toContain("rl-page-mark")
  for (const text of [
    ".rl-edited-card.file-change-card:not([data-panel]) .rl-edited-actions .rl-btn { min-block-size:24px; padding-inline:var(--yc-space-2); border-color:transparent; background:transparent;",
    ".rl-edited-card.file-change-card:not([data-panel]) .rl-edited-actions .rl-btn:hover { background:var(--yc-surface-sunken); }",
    ".rl-companion-head .rl-pane-policy button { display:inline-flex; align-items:center; white-space:nowrap; }",
    ".rl-context-panel .rl-btn { display:inline-flex; align-items:center; justify-content:center; justify-self:start; gap:var(--yc-space-2); min-block-size:30px; padding-inline:var(--yc-space-3); border:1px solid var(--yc-border-strong); border-radius:var(--yc-radius-pill); background:transparent;",
    "@media (pointer: coarse) { .rl-context-panel .rl-btn { min-block-size:var(--yc-hit-min); } }",
    "#companion-context .rl-context-panel .companion__context-eyebrow { color:var(--yc-text-muted); font-family:var(--yc-font-mono);",
    ".rl-page .ws-host .ws-location > svg { display:block; grid-row:1; grid-column:1; align-self:center; }",
    ".rl-page .rl-workspace-search .rl-input-icon input[type=\"search\"] { min-block-size:28px; }",
  ]) expect(css).toContain(text)
  expect(css).not.toContain(".rl-mark")
})

test("pages, sessions and settings render the open Ledger without debug badges or native tooltips", () => {
  const page = renderToString(() => createComponent(SharedPageSurface, { title: "Settings", sub: "This Mac", icon: "Icon", actions: "Action", children: "Body" }))
  expect(page).not.toContain("rl-page-mark")
  expect(page).not.toContain(">Icon<")
  expect(page).toMatch(/<div class="rl-page-title"><h1[^>]*>Settings<\/h1><p>This Mac<\/p><\/div><div class="rl-page-actions">Action<\/div>/)
  const sessions = renderToString(() => createComponent(SharedSessionsSurface, { search: "", filters: [{ value: "all", label: "All", count: 1 }], filter: "all", pinning: false, items: [{ id: "s", title: "Session", hint: "Workspace", meta: "Ready", pinned: true }], totalLoaded: 1, pinnedCount: 1, onNewSession: () => {}, onSearch: () => {}, onFilter: () => {}, onTogglePinMode: () => {}, onTogglePin: () => {}, onSelect: () => {} }))
  expect(sessions).not.toContain('data-tone="go"')
  expect(sessions).not.toContain("title=")
  expect(sessions).toMatch(/<div class="ws-bar ws-chips">[\s\S]*?<button type="button" class="rl-btn ws-new-session" data-action-id="ws-list-new"><svg[\s\S]*?<\/svg> New Session<\/button><\/div>/)
  expect(sessions).toContain('aria-label="Unpin Session"')
  const base = { animations: true, keepAwakeChecked: false, keepAwakeDetail: "Off", telemetryConsent: "enabled" as const, telemetryNote: "Sharing", onToggleAnimations: () => {}, onToggleKeepAwake: () => {}, onDecideTelemetry: () => {}, onToggleNotifications: () => {}, onToggleSavedPermissions: () => {}, onToggleCloseApp: () => {} }
  const unified = renderToString(() => createComponent(SharedSettingsSurface, { ...base, leadingSections: "Machine and updates", colorSchemeControl: "Scheme select", theme: "dark", onThemeChange: () => {}, hideKeepAwakeSection: true }))
  expect(unified.indexOf("Machine and updates")).toBeLessThan(unified.indexOf('data-part="st-appearance"'))
  expect(unified).toContain('<div class="rl-switch-row" data-part="st-color-scheme"><span class="rl-switch-text"><span>Color scheme</span></span>Scheme select</div>')
  expect(unified).not.toContain('aria-label="Theme"')
  expect(unified).not.toContain('data-part="st-keep-awake"')
  for (const text of ["Notifications", "Review saved rules", "Close app", "Latency diagnostics"]) expect(unified).toContain(text)
  const standard = renderToString(() => createComponent(SharedSettingsSurface, { ...base, keepAwakeStatus: "partial" }))
  expect(standard).toContain('data-part="st-keep-awake-state">Off</p>')
  for (const debug of ["rl-capability", "rl-sim", "rl-badge", "title=", "ycoding keep-awake setup"]) expect(standard).not.toContain(debug)
})
