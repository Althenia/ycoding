/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onMount, type JSX } from "solid-js"
import { DialogAgent } from "../../src/component/dialog-agent"
import { DialogConfig } from "../../src/component/dialog-config"
import { DialogDebug } from "../../src/component/dialog-debug"
import { DialogIntegration, DialogIntegrationMethods } from "../../src/component/dialog-integration"
import { DialogMcp } from "../../src/component/dialog-mcp"
import { DialogModel } from "../../src/component/dialog-model"
import { DialogMoveSession } from "../../src/component/dialog-move-session"
import { DialogSessionGoal } from "../../src/component/dialog-session-goal"
import { DialogSessionList } from "../../src/component/dialog-session-list"
import { DialogSessionRename } from "../../src/component/dialog-session-rename"
import { DialogSkill } from "../../src/component/dialog-skill"
import { DialogStash } from "../../src/component/dialog-stash"
import { DialogStatus } from "../../src/component/dialog-status"
import { DialogTag } from "../../src/component/dialog-tag"
import { DialogVariant } from "../../src/component/dialog-variant"
import { PromptStashProvider } from "../../src/component/prompt/stash"
import { ArgsProvider } from "../../src/context/args"
import { ClientProvider } from "../../src/context/client"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider, useLocation } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { DialogFork } from "../../src/routes/session/dialog-fork"
import { DialogMessage } from "../../src/routes/session/dialog-message"
import { DialogSubagent } from "../../src/routes/session/dialog-subagent"
import { DialogTimeline } from "../../src/routes/session/dialog-timeline"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { ConfigProvider } from "../../src/config"
import { DialogExportOptions } from "../../src/ui/dialog-export-options"
import { DialogExportResult } from "../../src/ui/dialog-export-result"
import { DialogHelp } from "../../src/ui/dialog-help"
import { DialogProjectCopyName } from "../../src/component/dialog-project-copy-name"
import { DialogRetryAction } from "../../src/component/dialog-retry-action"
import { DialogSessionDeleteFailed } from "../../src/component/dialog-session-delete-failed"
import { DialogThemeList } from "../../src/component/dialog-theme-list"
import { DialogWorkspaceFileChanges } from "../../src/component/dialog-workspace-file-changes"
import { createApi, createEventStream, createFetch, directory, json, worktree } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const state = "/tmp/ycoding/dialog-remaining-capture"
const sessionID = "ses_dialog_capture"
const location = { directory, project: { id: "proj_test", directory: worktree } }
const viewports = [
  { width: 189, height: 69 },
  { width: 220, height: 69 },
] as const

const helpShortcuts = {
  "session.list": "⌃x l",
  "session.new": "⌃x n",
  "session.compact": "⌃x c",
  "session.child.first": "↓",
  "session.child.next": "→",
  "session.child.previous": "←",
  "session.parent": "↑",
  "model.list": "⌃x m",
  "variant.cycle": "⌃t",
} as const

const states = [
  { name: "mcp-servers", settle: "agentmemory", evidence: "Connecting", view: () => <DialogMcp /> },
  { name: "select-agent", settle: "Default primary agent", evidence: "Background subagent", view: () => <DialogAgent /> },
  { name: "settings", settle: "Settings", view: () => <DialogConfig /> },
  { name: "connect-service", settle: "GitHub Copilot", evidence: "Popular", view: () => <DialogIntegration /> },
  { name: "connect-github-copilot", settle: "Login with GitHub Copilot", evidence: "API key", view: () => <DialogIntegrationMethods integration={integrations[2]!} /> },
  { name: "select-model", settle: "Claude Opus 5", evidence: "Gemini 3 Pro", view: () => <DialogModel order={[
    { providerID: "anthropic", modelID: "claude-opus-5" },
    { providerID: "anthropic", modelID: "claude-sonnet-5" },
    { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    { providerID: "openai", modelID: "gpt-5-2" },
    { providerID: "google", modelID: "gemini-3-pro" },
  ]} /> },
  { name: "select-variant", settle: "deep reasoning · highest cost", evidence: "lower latency", view: () => <DialogVariant variants={["max", "balanced", "fast"]} current="balanced" /> },
  { name: "switch-session", settle: "Provider cache audit", evidence: "Theme migration", view: () => <DialogSessionList pinned={[sessionID]} messageCounts={{ [sessionID]: 1_204, ses_docs_capture: 88, ses_keymap_capture: 41, ses_theme_capture: 210 }} now={captureNow} /> },
  { name: "session-goal", settle: "Set autonomous goal", evidence: "Activate the concrete goal dialog", view: () => <DialogSessionGoal sessionID={sessionID} currentGoal="Activate the concrete goal dialog" /> },
  { name: "session-timeline", settle: "Fix shared cache accounting", evidence: "Verify baseline", view: () => <DialogTimeline sessionID={sessionID} onMove={() => {}} presentation={[
    { id: "msg_active", title: "Fix shared cache accounting", age: "2 min ago", status: "Active", category: "Today" },
    { id: "msg_test", title: "Add failing test", age: "8 min ago", status: "Done", category: "Today", done: true },
    { id: "msg_verify", title: "Verify baseline", age: "14 min ago", status: "Done", category: "Today", done: true },
  ]} /> },
  { name: "subagents", settle: "Triage 2 failing tests", evidence: "Benchmark cache warm", view: () => <DialogSubagent sessionID="ses_subagent_capture" /> },
  { name: "message-actions", settle: "Copy as markdown", evidence: "Revert to here", view: () => <DialogMessage sessionID={sessionID} messageID="msg_audit" shortcuts={{ editor: "⌃x e", fork: "⌃x f" }} /> },
  { name: "fork-session", settle: "From this message", evidence: "message 88 of 88", view: () => <DialogFork sessionID={sessionID} boundary={{ messageID: "msg_audit", index: 42, total: 88 }} /> },
  { name: "status", settle: "v1.18.4", evidence: "Durable store", view: () => <DialogStatus version="v1.18.4" bunVersion="1.3.14" pluginCount={1} serviceSummary={{ configured: 6, connected: 5 }} /> },
  { name: "move-session", settle: "~/Workspace/Personal/YCoding", evidence: "~/Workspace/work/bkof", view: () => <DialogMoveSession projectID="proj_test" current={{ type: "directory", directory: "/tmp/ycoding/home/Workspace/Personal/YCoding", subdirectory: false }} initialDirectories={directories} onSelect={() => {}} /> },
  { name: "rename-session", settle: "Provider cache audit", evidence: "Rename session", view: () => <DialogSessionRename sessionID={sessionID} currentTitle="Provider cache audit" /> },
  { name: "name-copy", settle: "Provider cache audit (copy)", view: () => <DialogProjectCopyName value="Provider cache audit (copy)" onConfirm={() => {}} /> },
  { name: "session-delete-failed", settle: "Could not delete", evidence: "Docs sync sweep", view: () => <DialogSessionDeleteFailed session="Provider cache audit" workspace="broken-workspace" failures={[{ session: "Provider cache audit", reason: "Store locked" }, { session: "Docs sync sweep", reason: "In use" }]} /> },
  { name: "export-options", settle: "Export session", view: () => <DialogExportOptions defaultThinking /> },
  { name: "export-result", settle: "Export complete", evidence: "1.2 MB", view: () => <DialogExportResult path="~/Downloads/provider-cache-audit.md" size="1.2 MB" /> },
  { name: "workspace-changes", settle: "Workspace changes", view: () => <DialogWorkspaceFileChanges title="Workspace changes" message="Keep the current changes before moving the session?" files={[{ file: "packages/tui/src/ui/dialog.tsx", status: "modified", additions: 12, deletions: 4 }]} onSelect={() => {}} /> },
  { name: "select-theme", settle: "tokyonight", evidence: "←/→ preview", view: () => <DialogThemeList themes={["ycoding", "tokyonight", "osaka-jade", "vesper", "catppuccin"]} current="ycoding" defaultTheme="ycoding" /> },
  { name: "retry-action", settle: "429 rate limited", evidence: "Cancel the turn", view: () => <DialogRetryAction title="Provider connection" message="Could not connect to the provider. Check your network and credentials." label="Open provider settings" link="https://opencode.ai/go" request={{ provider: "Anthropic", error: "429 rate limited", retryAfter: "retry after 30s" }} /> },
  { name: "help", settle: "Keyboard shortcuts", evidence: "Cycle variant", view: () => <DialogHelp shortcuts={helpShortcuts} /> },
  { name: "stash", settle: "cache-accounting-wip", evidence: "⌃x k drop", view: () => <DialogStash onSelect={() => {}} /> },
  { name: "tag", settle: "dialog-remaining-capture.test.tsx", view: () => <DialogTag /> },
  { name: "run-skill", settle: "Scoped Go implementation", evidence: "Penpot UX/UI work", view: () => <DialogSkill onSelect={() => {}} /> },
  { name: "debug", settle: "Renderer stats", evidence: "Console", view: () => <DialogDebug /> },
] as const

const designChecks: Partial<Record<(typeof states)[number]["name"], { title: string; row: number; column: number; text: string }>> = {
  "mcp-servers": { title: "MCP servers", row: 7, column: 6, text: "agentmemory" },
  "select-agent": { title: "Select agent", row: 7, column: 6, text: "build" },
  settings: { title: "Settings", row: 8, column: 3, text: "Appearance" },
  "connect-service": { title: "Connect a service", row: 8, column: 3, text: "Popular" },
  "connect-github-copilot": { title: "Connect GitHub Copilot", row: 7, column: 6, text: "Login with GitHub Copilot" },
  "select-model": { title: "Select model", row: 8, column: 3, text: "Anthropic" },
  "select-variant": { title: "Select variant", row: 7, column: 6, text: "max" },
  "switch-session": { title: "Switch session", row: 8, column: 3, text: "Pinned" },
  "session-timeline": { title: "Session timeline", row: 8, column: 3, text: "Today" },
  subagents: { title: "Subagents", row: 8, column: 3, text: "Active" },
  "message-actions": { title: "Message actions", row: 7, column: 6, text: "Copy message" },
  "fork-session": { title: "Fork session", row: 8, column: 3, text: "Fork point" },
  "retry-action": { title: "Request failed", row: 8, column: 3, text: "Anthropic" },
  "select-theme": { title: "Select theme", row: 7, column: 6, text: "ycoding" },
  status: { title: "Status", row: 8, column: 3, text: "Runtime" },
  help: { title: "Keyboard shortcuts", row: 8, column: 3, text: "Session" },
  "move-session": { title: "Move session", row: 8, column: 3, text: "Recent workspaces" },
  "rename-session": { title: "Rename session", row: 7, column: 6, text: "Provider cache audit" },
  "name-copy": { title: "Name the copy", row: 7, column: 6, text: "Provider cache audit (copy)" },
  "session-delete-failed": { title: "Could not delete", row: 8, column: 3, text: "2 sessions could not be removed" },
  "export-result": { title: "Export complete", row: 8, column: 3, text: "Written to" },
  stash: { title: "Stashes", row: 7, column: 6, text: "cache-accounting-wip" },
  "run-skill": { title: "Run skill", row: 8, column: 3, text: "Project" },
  debug: { title: "Debug", row: 8, column: 3, text: "Panels" },
}

const directories = [
  { directory: "/tmp/ycoding/home/Workspace/Personal/YCoding" },
  { directory: "/tmp/ycoding/home/Workspace/Personal/Weeeee", strategy: "copy" as const },
  { directory: "/tmp/ycoding/home/Workspace/work/bkof", strategy: "copy" as const },
]

test("captures concrete remaining dialog fixtures at canonical terminal dimensions", async () => {
  await mkdir(state, { recursive: true })
  const now = Date.now()
  await Bun.write(
    path.join(state, "prompt-stash.jsonl"),
    [
      { prompt: { text: "keymap-audit", pasted: [{}] }, timestamp: now - 86_400_000 },
      { prompt: { text: "cache-accounting-wip", pasted: [{}, {}, {}] }, timestamp: now - 120_000 },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  )

  for (const viewport of viewports) {
    for (const dialogState of states) await capture(dialogState, viewport)
  }
}, 120_000)

function DialogProviders(props: { children: JSX.Element }) {
  const events = createEventStream()
  const transport = createFetch(route, events)
  return (
    <TestTuiContexts paths={{ state }}>
      <ClipboardProvider>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig({ session: { thinking: "show" } })}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <PermissionProvider>
                      <DataProvider>
                        <LocationProvider>
                          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                            <LocalProvider>
                              <PromptStashProvider>
                                <DialogProvider>{props.children}</DialogProvider>
                              </PromptStashProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </LocationProvider>
                      </DataProvider>
                    </PermissionProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </ClipboardProvider>
    </TestTuiContexts>
  )
}

function SyncLocation() {
  const data = useData()
  const route = useLocation()
  createEffect(() => route.set(data.location.default()))
  onMount(() => {
    void data.session.message.sync(sessionID)
  })
  return null
}

async function capture(dialogState: (typeof states)[number], viewport: (typeof viewports)[number]) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(dialogState.view))
    return <SyncLocation />
  }

  const app = await testRender(() => <DialogProviders><DialogFixture /></DialogProviders>, viewport)
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(dialogState.settle))

  try {
    const rows = app.captureCharFrame().replace(/\n$/, "").split("\n")
    expect(rows).toHaveLength(viewport.height)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)
    const frame = rows.join("\n")
    expect(frame).toContain(dialogState.settle)
    if ("evidence" in dialogState) expect(frame).toContain(dialogState.evidence)
    const design = designChecks[dialogState.name]
    if (design) {
      const titleRow = rows.findIndex((row) => row.includes(design.title))
      expect(titleRow).toBeGreaterThanOrEqual(0)
      const origin = { row: titleRow - 1, column: rows[titleRow]!.indexOf(design.title) - 3 }
      expectAt(rows, origin.row + design.row - 1, origin.column + design.column, design.text)
      expectAt(rows, origin.row + 1, origin.column + 91, "esc")
    }
    await Bun.write(path.join(renders, `dialog-remaining-${dialogState.name}-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
  } finally {
    app.renderer.destroy()
  }
}

function expectAt(rows: string[], row: number, column: number, text: string) {
  expect(rows[row]?.slice(column, column + text.length)).toBe(text)
}

function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages, cursor: {} })
  if (url.pathname === "/api/mcp") return json({ location, data: mcp })
  if (url.pathname === "/api/model") return json({ location, data: models })
  if (url.pathname === "/api/provider") return json({ location, data: providers })
  if (url.pathname === "/api/agent") return json({ location, data: agents })
  if (url.pathname === "/api/integration") return json({ location, data: integrations })
  if (url.pathname === "/api/skill") return json({ location, data: skills })
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/fs/find") return json({ data: [{ path: "packages/tui/test/screen/dialog-remaining-capture.test.tsx" }] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/project/proj_test/directories") return json(directories)
  if (url.pathname === "/api/project-copy/proj_test/refresh") return json({})
  if (url.pathname === "/api/server") return json({ urls: ["http://127.0.0.1:4096"] })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/form`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`, `/api/session/${sessionID}/subagent`, "/api/reference", "/api/command", "/api/shell", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/session/active") return json({ data: {} })
  if (url.pathname === `/api/session/${sessionID}/autonomy`) return json({ data: { mode: "normal" } })
  if (url.pathname === "/api/session/ses_subagent_capture/subagent") return json({ data: subagents })
  return undefined
}

const captureNow = 1_800_000_000_000
const session = { id: sessionID, title: "Provider cache audit", projectID: "proj_test", location: { directory }, agent: "build", model: { providerID: "anthropic", id: "claude-opus-5" }, time: { created: captureNow - 120_000, updated: captureNow - 120_000 } }
const sessions = [
  session,
  { ...session, id: "ses_docs_capture", title: "Docs sync sweep", time: { created: captureNow - 3_600_000, updated: captureNow - 3_600_000 } },
  { ...session, id: "ses_keymap_capture", title: "Keymap audit", time: { created: captureNow - 86_400_000, updated: captureNow - 86_400_000 } },
  { ...session, id: "ses_theme_capture", title: "Theme migration", time: { created: captureNow - 259_200_000, updated: captureNow - 259_200_000 } },
]
const messages = [{ id: "msg_audit", type: "user" as const, text: "Concrete timeline message", time: { created: 1 } }, { id: "msg_review", type: "user" as const, text: "Concrete fork boundary", time: { created: 2 } }]
const agents = [
  { id: "build", description: "Default primary agent" },
  { id: "plan", description: "Planning and analysis" },
  { id: "analyze", description: "Code analysis and review" },
  { id: "brainstorm", description: "Ideation and design" },
  { id: "general", description: "Background subagent" },
].map((agent) => ({ ...agent, name: agent.id, mode: "primary" as const, hidden: false, permissions: [], request: { headers: {}, body: {} } }))
const model = (input: { id: string; providerID: string; name: string; family: string; context: number; enabled?: boolean }) => ({
  id: input.id,
  modelID: input.id,
  providerID: input.providerID,
  name: input.name,
  family: input.family,
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 1 },
  cost: [],
  status: "active" as const,
  enabled: input.enabled ?? true,
  limit: { context: input.context, output: 32_000 },
})
const models = [
  model({ id: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5", family: "deep reasoning", context: 200_000 }),
  model({ id: "claude-sonnet-5", providerID: "anthropic", name: "Claude Sonnet 5", family: "balanced", context: 200_000 }),
  model({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Claude Haiku 4.5", family: "fast", context: 200_000 }),
  model({ id: "gpt-5-2", providerID: "openai", name: "GPT-5.2", family: "", context: 400_000 }),
  model({ id: "gemini-3-pro", providerID: "google", name: "Gemini 3 Pro", family: "connect first", context: 1_000_000, enabled: false }),
]
const providers = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "google", name: "Not configured" },
]
const credential = (label: string) => [{ type: "credential" as const, id: `cred_${label}`, label }]
const integrations = [
  { id: "ycoding", name: "YCoding Go", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  { id: "openai", name: "OpenAI", methods: [{ type: "key" as const, label: "API key" }], connections: credential("default") },
  { id: "github-copilot", name: "GitHub Copilot", methods: [{ id: "github", type: "oauth" as const, label: "Login with GitHub Copilot" }, { type: "key" as const, label: "API key" }], connections: [] },
  { id: "anthropic", name: "Claude", methods: [{ type: "key" as const, label: "API key" }], connections: credential("Claude Max") },
  { id: "google", name: "Google", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  { id: "302ai", name: "302.AI", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  { id: "amazon-bedrock", name: "Amazon Bedrock", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
]
const skills = [
  { id: "go-developer", name: "go-developer", description: "Scoped Go implementation", location: `${worktree}/.ycoding/skills/go-developer/SKILL.md`, content: "" },
  { id: "writing-test", name: "writing-test", description: "Markdown QA plans", location: "/tmp/ycoding/home/.agents/skills/writing-test/SKILL.md", content: "" },
  { id: "penpot", name: "penpot", description: "Penpot UX/UI work", location: "/tmp/ycoding/home/.agents/skills/penpot/SKILL.md", content: "" },
]
const subagent = (input: { id: string; description: string; state: "waiting" | "running" | "completed" | "cancelled"; elapsed: number; progress?: string }) => ({
  sessionID: input.id,
  parentID: "ses_subagent_capture",
  description: input.description,
  agent: "general",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  background: true,
  state: input.state,
  ...(input.progress ? { progress: { text: input.progress, time: captureNow } } : {}),
  revision: 1,
  time: { created: captureNow - input.elapsed, updated: captureNow },
})
const subagents = [
  subagent({ id: "test-triage", description: "Triage 2 failing tests", state: "waiting", elapsed: 120_000 }),
  subagent({ id: "docs-sync", description: "Sync provider docs", state: "running", elapsed: 134_000, progress: "74% hit · 2m14s" }),
  subagent({ id: "keymap-audit", description: "Audit duplicate keybinds", state: "completed", elapsed: 48_000 }),
  subagent({ id: "bench-run", description: "Benchmark cache warm", state: "cancelled", elapsed: 30_000 }),
]
const mcp = [
  { name: "agentmemory", transport: "stdio", status: { status: "connected" as const } },
  { name: "atlassian-rovo", transport: "stdio", status: { status: "disabled" as const } },
  { name: "capacities", transport: "http", status: { status: "connected" as const } },
  { name: "codebase-memory-mcp", transport: "stdio", status: { status: "connected" as const } },
  { name: "firecrawl", transport: "stdio", status: { status: "pending" as const } },
  { name: "playwright", transport: "stdio", status: { status: "failed" as const, error: "Connection failed" } },
]
