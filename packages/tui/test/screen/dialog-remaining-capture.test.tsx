/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onMount, type JSX } from "solid-js"
import { DialogAgent } from "../../src/component/dialog-agent"
import { DialogConfig } from "../../src/component/dialog-config"
import { DialogDebug } from "../../src/component/dialog-debug"
import { DialogIntegration } from "../../src/component/dialog-integration"
import { DialogMcp } from "../../src/component/dialog-mcp"
import { DialogModel } from "../../src/component/dialog-model"
import { DialogMoveSession } from "../../src/component/dialog-move-session"
import { DialogPair } from "../../src/component/dialog-pair"
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

const states = [
  { name: "mcp-servers", settle: "context7", evidence: "Authorize", view: () => <DialogMcp /> },
  { name: "select-agent", settle: "build agent", evidence: "build agent", view: () => <DialogAgent /> },
  { name: "settings", settle: "Scroll speed", view: () => <DialogConfig /> },
  { name: "connect-service", settle: "GitHub Copilot", evidence: "Popular", view: () => <DialogIntegration /> },
  { name: "connect-github-copilot", settle: "Pair", evidence: "URLs", view: () => <DialogPair credentials={{ username: "ycoding", password: "capture-token" }} /> },
  { name: "select-model", settle: "Claude concrete provider", evidence: "Claude", view: () => <DialogModel /> },
  { name: "select-variant", settle: "precision-capture", evidence: "balanced-capture", view: () => <DialogVariant /> },
  { name: "switch-session", settle: "Provider cache audit", evidence: "Sessions", view: () => <DialogSessionList /> },
  { name: "session-goal", settle: "Set autonomous goal", evidence: "Activate the concrete goal dialog", view: () => <DialogSessionGoal sessionID={sessionID} currentGoal="Activate the concrete goal dialog" /> },
  { name: "session-timeline", settle: "Concrete timeline message", evidence: "Timeline", view: () => <DialogTimeline sessionID={sessionID} onMove={() => {}} /> },
  { name: "subagents", settle: "the subagent's session", view: () => <DialogSubagent sessionID="ses_subagent_capture" /> },
  { name: "message-actions", settle: "undo messages and file changes", view: () => <DialogMessage sessionID={sessionID} messageID="msg_audit" /> },
  { name: "fork-session", settle: "Concrete fork boundary", evidence: "Full session", view: () => <DialogFork sessionID={sessionID} /> },
  { name: "status", settle: "3 MCP servers", view: () => <DialogStatus /> },
  { name: "move-session", settle: "concrete-dialog-destination", evidence: "Current", view: () => <DialogMoveSession projectID="proj_test" initialDirectories={directories} onSelect={() => {}} /> },
  { name: "rename-session", settle: "Concrete renamed session", evidence: "Rename session", view: () => <DialogSessionRename sessionID={sessionID} currentTitle="Concrete renamed session" /> },
  { name: "name-copy", settle: "Name project copy", view: () => <DialogProjectCopyName onConfirm={() => {}} /> },
  { name: "session-delete-failed", settle: "Failed to Delete Session", view: () => <DialogSessionDeleteFailed session="Provider cache audit" workspace="broken-workspace" /> },
  { name: "export-options", settle: "Export session", view: () => <DialogExportOptions defaultThinking /> },
  { name: "export-result", settle: "Session exported", view: () => <DialogExportResult path="/tmp/ycoding/provider-cache-audit.md" /> },
  { name: "workspace-changes", settle: "Workspace changes", view: () => <DialogWorkspaceFileChanges title="Workspace changes" message="Keep the current changes before moving the session?" files={[{ file: "packages/tui/src/ui/dialog.tsx", status: "modified", additions: 12, deletions: 4 }]} onSelect={() => {}} /> },
  { name: "select-theme", settle: "Themes", view: () => <DialogThemeList /> },
  { name: "retry-action", settle: "Provider connection", view: () => <DialogRetryAction title="Provider connection" message="Could not connect to the provider. Check your network and credentials." label="Open provider settings" link="https://opencode.ai/go" /> },
  { name: "help", settle: "Help", view: () => <DialogHelp /> },
  { name: "stash", settle: "Concrete stash provider", evidence: "delete ctrl+d", view: () => <DialogStash onSelect={() => {}} /> },
  { name: "tag", settle: "dialog-remaining-capture.test.tsx", view: () => <DialogTag /> },
  { name: "run-skill", settle: "Concrete skill provider", evidence: "Run TUI verification", view: () => <DialogSkill onSelect={() => {}} /> },
  { name: "debug", settle: "Share this when reporting an issue.", view: () => <DialogDebug /> },
] as const

const directories = [
  { directory: worktree },
  { directory: "/tmp/concrete-dialog-destination", strategy: "copy" as const },
]

test("captures concrete remaining dialog fixtures at canonical terminal dimensions", async () => {
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "prompt-stash.jsonl"), `${JSON.stringify({ prompt: { text: "Concrete stash provider", pasted: [] }, timestamp: 0 })}\n`)

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
          <ConfigProvider config={createTuiResolvedConfig()}>
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
    await Bun.write(path.join(renders, `dialog-remaining-${dialogState.name}-${viewport.width}x${viewport.height}.txt`), rows.join("\n"))
  } finally {
    app.renderer.destroy()
  }
}

function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session, otherSession], cursor: {} })
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
  return undefined
}

const session = { id: sessionID, title: "Provider cache audit", projectID: "proj_test", location: { directory }, agent: "build", model: { providerID: "anthropic", id: "claude-opus-5" }, time: { created: 1, updated: 2 } }
const otherSession = { ...session, id: "ses_review_capture", title: "Review dialog states", time: { created: 1, updated: 1 } }
const messages = [{ id: "msg_audit", type: "user" as const, text: "Concrete timeline message", time: { created: 1 } }, { id: "msg_review", type: "user" as const, text: "Concrete fork boundary", time: { created: 2 } }]
const agents = ["build", "plan", "review"].map((id) => ({ id, name: id, description: `${id} agent`, mode: "primary" as const, hidden: false, permissions: [], request: { headers: {}, body: {} } }))
const models = [{ id: "claude-opus-5", modelID: "claude-opus-5", providerID: "anthropic", name: "Claude concrete provider", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "precision-capture" }, { id: "balanced-capture" }], time: { released: 1 }, cost: [], status: "active" as const, enabled: true, limit: { context: 200_000, output: 32_000 } }]
const providers = [{ id: "anthropic", name: "Claude" }]
const integrations = [{ id: "github-copilot", name: "GitHub Copilot", methods: [{ type: "key" as const, label: "Access token" }], connections: [] }]
const skills = [{ id: "tui-verification-gates", name: "Concrete skill provider", description: "Run TUI verification from the package directory." }]
const mcp = [{ name: "context7", status: { status: "connected" as const } }, { name: "filesystem", status: { status: "needs_auth" as const } }, { name: "github", status: { status: "failed" as const, error: "Credential expired" } }]
