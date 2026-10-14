/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, createMemo, onMount, type JSX } from "solid-js"
import { DialogAgent } from "../../src/component/dialog-agent"
import { DialogConfig } from "../../src/component/dialog-config"
import { DialogCustomEndpoint } from "../../src/component/dialog-custom-endpoint"
import { DialogDebug } from "../../src/component/dialog-debug"
import { beginOAuth, DialogIntegration, DialogIntegrationMethods } from "../../src/component/dialog-integration"
import { DialogMcp } from "../../src/component/dialog-mcp"
import { DialogModel } from "../../src/component/dialog-model"
import { DialogMoveSession } from "../../src/component/dialog-move-session"
import { DialogSessionGoal } from "../../src/component/dialog-session-goal"
import { DialogSessionList } from "../../src/component/dialog-session-list"
import { DialogSessionRename } from "../../src/component/dialog-session-rename"
import { DialogSkill } from "../../src/component/dialog-skill"
import { DialogStash } from "../../src/component/dialog-stash"
import { DialogStatus } from "../../src/component/dialog-status"
import { TelemetryProvider } from "../../src/context/telemetry"
import { DialogVariant } from "../../src/component/dialog-variant"
import { PromptStashProvider } from "../../src/prompt/stash"
import { ArgsProvider } from "../../src/context/args"
import { ClientProvider } from "../../src/context/client"
import { ClipboardProvider, type ClipboardService } from "../../src/context/clipboard"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider, useLocation } from "../../src/context/location"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { DialogFork } from "../../src/routes/session/dialog-fork"
import { DialogMessage } from "../../src/routes/session/dialog-message"
import { DialogSubagent } from "../../src/routes/session/dialog-subagent"
import { DialogTimeline } from "../../src/routes/session/dialog-timeline"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { ConfigProvider } from "../../src/config"
import { DialogExportOptions } from "../../src/ui/dialog-export-options"
import { DialogExportResult } from "../../src/ui/dialog-export-result"
import { DialogHelp } from "../../src/ui/dialog-help"
import { DialogProjectCopyName } from "../../src/component/dialog-project-copy-name"
import { DialogRetryAction } from "../../src/component/dialog-retry-action"
import { DialogSessionDeleteFailed } from "../../src/component/dialog-session-delete-failed"
import { DialogThemeList } from "../../src/component/dialog-theme-list"
import { DialogWorkspaceFileChanges } from "../../src/component/dialog-workspace-file-changes"
import {
  createApi,
  createEventStream,
  createFetch,
  directory,
  json,
  worktree,
  sessionSnapshot,
} from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const state = "/tmp/ycoding/dialog-remaining-capture"
const sessionID = "ses_dialog_capture"
const location = { directory, project: { id: "proj_test", directory: worktree } }
const oauthCancelled: string[] = []
const oauthSubmitted: string[] = []
const defaultProfileRequests: string[] = []
let profileActivationSucceeded = false
let profileActivationResponseAt = 0
let activationDialogCloseMs = 0
const profileRefreshPaths: string[] = []
const profileRefreshResolvers: Array<() => void> = []
let displayedWorkProfileActive = false
let resolveProfileListUpdate: (() => void) | undefined
let oauthManualCode = false
let oauthStatus: "pending" | "complete" = "pending"
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
  {
    name: "select-agent",
    settle: "Default primary agent",
    evidence: "Background subagent",
    view: () => <DialogAgent />,
  },
  { name: "settings", settle: "Settings", view: () => <DialogConfig /> },
  { name: "connect-service", settle: "Meta Muse", evidence: "Popular", view: () => <DialogIntegration /> },
  {
    name: "connect-meta-muse",
    settle: "Meta Muse Code account",
    evidence: "Meta Model API key",
    view: () => <DialogIntegrationMethods integration={integrations[2]!} />,
  },
  {
    name: "select-model",
    settle: "Claude Opus 5",
    evidence: "OpenRouter Model",
    view: () => (
      <DialogModel
        order={[
          { providerID: "anthropic", modelID: "claude-opus-5" },
          { providerID: "anthropic", modelID: "claude-sonnet-5" },
          { providerID: "anthropic", modelID: "claude-haiku-4-5" },
          { providerID: "openai", modelID: "gpt-5-2" },
          { providerID: "openrouter", modelID: "openrouter-model" },
        ]}
      />
    ),
  },
  {
    name: "select-variant",
    settle: "Select variant",
    evidence: "balanced",
    view: () => <DialogVariant variants={["max", "balanced", "fast"]} current="balanced" />,
  },
  {
    name: "switch-session",
    settle: "Provider cache audit",
    evidence: "Theme migration",
    view: () => (
      <DialogSessionList
        pinned={[sessionID]}
        messageCounts={{ [sessionID]: 1_204, ses_docs_capture: 88, ses_keymap_capture: 41, ses_theme_capture: 210 }}
        now={captureNow}
      />
    ),
  },
  {
    name: "session-goal",
    settle: "Set autonomous goal",
    evidence: "Activate the concrete goal dialog",
    view: () => <DialogSessionGoal sessionID={sessionID} currentGoal="Activate the concrete goal dialog" />,
  },
  {
    name: "session-timeline",
    settle: "Fix shared cache accounting",
    evidence: "Verify baseline",
    view: () => (
      <DialogTimeline
        sessionID={sessionID}
        onMove={() => {}}
        presentation={[
          {
            id: "msg_active",
            title: "Fix shared cache accounting",
            age: "2 min ago",
            status: "Active",
            category: "Today",
          },
          {
            id: "msg_test",
            title: "Add failing test",
            age: "8 min ago",
            status: "Done",
            category: "Today",
            done: true,
          },
          {
            id: "msg_verify",
            title: "Verify baseline",
            age: "14 min ago",
            status: "Done",
            category: "Today",
            done: true,
          },
        ]}
      />
    ),
  },
  {
    name: "subagents",
    settle: "Triage 2 failing tests",
    evidence: "Benchmark cache warm",
    view: () => <DialogSubagent sessionID="ses_subagent_capture" />,
  },
  {
    name: "message-actions",
    settle: "Copy as markdown",
    evidence: "Revert to here",
    view: () => (
      <DialogMessage sessionID={sessionID} messageID="msg_audit" shortcuts={{ editor: "⌃x e", fork: "⌃x f" }} />
    ),
  },
  {
    name: "fork-session",
    settle: "From this message",
    evidence: "message 88 of 88",
    view: () => <DialogFork sessionID={sessionID} boundary={{ messageID: "msg_audit", index: 42, total: 88 }} />,
  },
  {
    name: "status",
    settle: "v1.18.4",
    evidence: "Durable store",
    view: () => (
      <TelemetryProvider>
        <DialogStatus
          version="v1.18.4"
          bunVersion="1.3.14"
          pluginCount={1}
          serviceSummary={{ configured: 6, connected: 5 }}
        />
      </TelemetryProvider>
    ),
  },
  {
    name: "move-session",
    settle: "~/Workspace/Personal/YCoding",
    evidence: "~/Workspace/work/bkof",
    view: () => (
      <DialogMoveSession
        projectID="proj_test"
        current={{ type: "directory", directory: "/tmp/ycoding/home/Workspace/Personal/YCoding", subdirectory: false }}
        initialDirectories={directories}
        onSelect={() => {}}
      />
    ),
  },
  {
    name: "rename-session",
    settle: "Provider cache audit",
    evidence: "Rename session",
    view: () => <DialogSessionRename sessionID={sessionID} currentTitle="Provider cache audit" />,
  },
  {
    name: "name-copy",
    settle: "Provider cache audit (copy)",
    view: () => <DialogProjectCopyName value="Provider cache audit (copy)" onConfirm={() => {}} />,
  },
  {
    name: "session-delete-failed",
    settle: "Could not delete",
    evidence: "Docs sync sweep",
    view: () => (
      <DialogSessionDeleteFailed
        session="Provider cache audit"
        workspace="broken-workspace"
        failures={[
          { session: "Provider cache audit", reason: "Store locked" },
          { session: "Docs sync sweep", reason: "In use" },
        ]}
      />
    ),
  },
  { name: "export-options", settle: "Export session", view: () => <DialogExportOptions defaultThinking /> },
  {
    name: "export-result",
    settle: "Export complete",
    evidence: "1.2 MB",
    view: () => <DialogExportResult path="~/Downloads/provider-cache-audit.md" size="1.2 MB" />,
  },
  {
    name: "workspace-changes",
    settle: "Workspace changes",
    view: () => (
      <DialogWorkspaceFileChanges
        title="Workspace changes"
        message="Keep the current changes before moving the session?"
        files={[{ file: "packages/tui/src/ui/dialog.tsx", status: "modified", additions: 12, deletions: 4 }]}
        onSelect={() => {}}
      />
    ),
  },
  {
    name: "select-theme",
    settle: "tokyonight",
    evidence: "←/→ preview",
    view: () => (
      <DialogThemeList
        themes={["ycoding", "tokyonight", "osaka-jade", "vesper", "catppuccin"]}
        current="ycoding"
        defaultTheme="ycoding"
      />
    ),
  },
  {
    name: "retry-action",
    settle: "429 rate limited",
    evidence: "Cancel the turn",
    view: () => (
      <DialogRetryAction
        title="Provider connection"
        message="Could not connect to the provider. Check your network and credentials."
        label="Open provider settings"
        link="https://console.anthropic.com"
        request={{ provider: "Anthropic", error: "429 rate limited", retryAfter: "retry after 30s" }}
      />
    ),
  },
  {
    name: "help",
    settle: "Keyboard shortcuts",
    evidence: "Cycle variant",
    view: () => <DialogHelp shortcuts={helpShortcuts} />,
  },
  {
    name: "stash",
    settle: "cache-accounting-wip",
    evidence: "⌃x k drop",
    view: () => <DialogStash onSelect={() => {}} />,
  },
  {
    name: "run-skill",
    settle: "Scoped Go implementation",
    evidence: "Penpot UX/UI work",
    view: () => <DialogSkill onSelect={() => {}} />,
  },
  { name: "debug", settle: "Renderer stats", evidence: "Console", view: () => <DialogDebug /> },
] as const

test("the variant dialog renders only the backend's four offered effort IDs", async () => {
  const app = await testRender(
    () => (
      <DialogProviders>
        <DialogVariant variants={["low", "medium", "high", "xhigh"]} current="high" />
      </DialogProviders>
    ),
    { width: 100, height: 30 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Select variant") && frame.includes("xhigh"))
    const frame = app.captureCharFrame()
    for (const effort of ["low", "medium", "high", "xhigh"]) expect(frame).toContain(effort)
    expect(frame).not.toContain("500k")
    expect(frame).not.toContain("Extra High")
  } finally {
    app.renderer.destroy()
  }
})

test("OAuth authorization details remain visible in a short, narrow terminal", async () => {
  oauthCancelled.length = 0
  oauthManualCode = false
  oauthStatus = "pending"
  function OAuthFixture() {
    const dialog = useDialog()
    onMount(
      () => void beginOAuth(integrations[2], { id: "muse", type: "oauth", label: "Meta Muse Code account" }, dialog),
    )
    return null
  }

  for (const viewport of [
    { width: 40, height: 12 },
    { width: 120, height: 12 },
  ]) {
    let copied: string | undefined
    const app = await testRender(
      () => (
        <DialogProviders
          clipboard={{
            write: async (value) => {
              copied = value
            },
          }}
        >
          <OAuthFixture />
        </DialogProviders>
      ),
      { ...viewport, kittyKeyboard: true },
    )
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("Waiting for authorization"))
      const rows = app.captureCharFrame().replace(/\n$/, "").split("\n")
      expect(rows).toHaveLength(viewport.height)
      expect(rows.join("\n")).toContain("Meta Muse Code account")
      expect(rows.join("\n")).toContain("auth.example.test")
      expect(rows.join("\n")).toContain("client_id=synthetic-")
      expect(rows.join("\n")).toContain("client&scope=profile")
      expect(rows.join("\n")).toContain("TEST-ONLY")
      expect(rows.join("\n")).toContain("Waiting for authorization")
      expect(rows.join("\n")).toContain("copy")
      const titleRow = rows.findIndex((row) => row.includes("Meta Muse Code account"))
      expect(titleRow).toBeLessThanOrEqual(2)
      expect(rows[titleRow]).toContain("esc")
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)
      app.mockInput.pressKey("c")
      await app.waitForFrame(() => copied === "TEST-ONLY")
      expect(copied).toBe("TEST-ONLY")
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => !frame.includes("Meta Muse Code account"))
      await app.waitForFrame(() => oauthCancelled.includes("attempt_layout"))
    } finally {
      app.renderer.destroy()
    }
  }
})

test("auto OAuth keeps polling while accepting a manual code and cancels only when closed", async () => {
  oauthCancelled.length = 0
  oauthSubmitted.length = 0
  oauthManualCode = true
  oauthStatus = "pending"
  function OAuthFixture() {
    const dialog = useDialog()
    onMount(
      () => void beginOAuth(integrations[2], { id: "muse", type: "oauth", label: "Meta Muse Code account" }, dialog),
    )
    return null
  }
  const app = await testRender(
    () => (
      <DialogProviders>
        <OAuthFixture />
      </DialogProviders>
    ),
    { width: 80, height: 18, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame(
      (frame) => frame.includes("Waiting for authorization") && frame.includes("enter authorization code"),
    )
    app.mockInput.pressKey("e")
    await app.waitForFrame((frame) => frame.includes("Authorization code"))
    expect(oauthCancelled).toEqual([])
    await app.mockInput.typeText("code#state")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => oauthSubmitted.length === 1)
    expect(oauthSubmitted).toEqual(["code#state"])
    expect(oauthCancelled).toEqual([])
    await app.waitForFrame((frame) => frame.includes("Code submitted"))
    app.mockInput.pressKey("e")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Paste authorization code")
    expect(app.captureCharFrame()).toContain("Code submitted")
    oauthStatus = "complete"
    await app.waitForFrame((frame) => !frame.includes("Waiting for authorization"))
    expect(oauthCancelled).toEqual([])
  } finally {
    app.renderer.destroy()
    oauthManualCode = false
    oauthStatus = "pending"
  }
})

test("auto OAuth without manual capability has no code action", async () => {
  oauthManualCode = false
  oauthStatus = "pending"
  function OAuthFixture() {
    const dialog = useDialog()
    onMount(
      () => void beginOAuth(integrations[2], { id: "muse", type: "oauth", label: "Meta Muse Code account" }, dialog),
    )
    return null
  }
  const app = await testRender(
    () => (
      <DialogProviders>
        <OAuthFixture />
      </DialogProviders>
    ),
    { width: 80, height: 18, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Waiting for authorization"))
    expect(app.captureCharFrame()).not.toContain("enter authorization code")
    app.mockInput.pressKey("e")
    expect(app.captureCharFrame()).not.toContain("Authorization code")
    app.mockInput.pressEscape()
    await app.waitForFrame(() => oauthCancelled.includes("attempt_layout"))
  } finally {
    app.renderer.destroy()
  }
})

test("automatic completion while manual code entry is open settles without cancellation", async () => {
  oauthCancelled.length = 0
  oauthSubmitted.length = 0
  oauthManualCode = true
  oauthStatus = "pending"
  function OAuthFixture() {
    const dialog = useDialog()
    onMount(
      () => void beginOAuth(integrations[2], { id: "muse", type: "oauth", label: "Meta Muse Code account" }, dialog),
    )
    return null
  }
  const app = await testRender(
    () => (
      <DialogProviders>
        <OAuthFixture />
      </DialogProviders>
    ),
    { width: 80, height: 18, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("enter authorization code"))
    app.mockInput.pressKey("e")
    await app.waitForFrame((frame) => frame.includes("Paste authorization code"))
    oauthStatus = "complete"
    await app.waitForFrame((frame) => !frame.includes("Authorization code"))
    expect(oauthSubmitted).toEqual([])
    expect(oauthCancelled).toEqual([])
  } finally {
    app.renderer.destroy()
    oauthManualCode = false
    oauthStatus = "pending"
  }
})

test("escape from manual code entry cancels its one owned attempt", async () => {
  oauthCancelled.length = 0
  oauthSubmitted.length = 0
  oauthManualCode = true
  oauthStatus = "pending"
  function OAuthFixture() {
    const dialog = useDialog()
    onMount(
      () => void beginOAuth(integrations[2], { id: "muse", type: "oauth", label: "Meta Muse Code account" }, dialog),
    )
    return null
  }
  const app = await testRender(
    () => (
      <DialogProviders>
        <OAuthFixture />
      </DialogProviders>
    ),
    { width: 80, height: 18, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("enter authorization code"))
    app.mockInput.pressKey("e")
    await app.waitForFrame((frame) => frame.includes("Paste authorization code"))
    app.mockInput.pressEscape()
    await app.waitForFrame(() => oauthCancelled.length === 1)
    expect(oauthCancelled).toEqual(["attempt_layout"])
    expect(oauthSubmitted).toEqual([])
  } finally {
    app.renderer.destroy()
    oauthManualCode = false
  }
})

test("the Connect integration menu opens the custom endpoint dialog", async () => {
  let opened = false
  function Connect() {
    const dialog = useDialog()
    return (
      <DialogIntegration
        onCustomEndpoint={() => {
          opened = true
          dialog.replace(() => <DialogCustomEndpoint onComplete={() => dialog.clear()} />)
        }}
      />
    )
  }

  const app = await testRender(
    () => (
      <DialogProviders>
        <Connect />
      </DialogProviders>
    ),
    { width: 100, height: 35, kittyKeyboard: true, useMouse: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Connect a service"))
  await app.mockInput.typeText("Custom OpenAI-compatible endpoint")
  await app.waitForFrame((frame) => frame.includes("Configure an OpenAI-compatible provider"))
  await app.renderOnce()
  const rows = app.captureCharFrame().split("\n")
  const optionRow = rows.findIndex((row) => row.includes("Configure an OpenAI-compatible provider"))
  await app.mockMouse.click(rows[optionRow].indexOf("Custom OpenAI-compatible endpoint") + 1, optionRow)
  await app.waitForFrame((frame) => frame.includes("Custom OpenAI-Compatible Endpoint"))
  expect(opened).toBe(true)
  expect(app.captureCharFrame()).toContain("Endpoint URL")
  app.renderer.destroy()
})

test("Connect shows every kept provider and the custom endpoint action without dropped-provider options", async () => {
  function Connect() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogIntegration onCustomEndpoint={() => {}} />))
    return <SyncLocation />
  }
  for (const mode of ["dark", "light"] as const) {
    const app = await testRender(
      () => (
        <DialogProviders mode={mode}>
          <Connect />
        </DialogProviders>
      ),
      { width: 100, height: 60 },
    )
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("Z.ai") && frame.includes("Custom OpenAI-compatible endpoint"))
      const frame = app.captureCharFrame()
      for (const name of [
        "OpenAI",
        "Claude",
        "OpenRouter",
        "Cursor",
        "Meta Muse",
        "Meta",
        "Cline",
        "Z.ai",
        "MiniMax",
        "Kimi",
      ])
        expect(frame).toContain(name)
      expect(frame).toContain("Configure an OpenAI-compatible provider")
      expect(frame).not.toMatch(/OpenCode|YCoding Go|Copilot|Google|Gemini|Runpod|Bedrock|302\.AI|Kiro/)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("kept API-key and subscription methods remain visible", async () => {
  for (const [id, labels] of [
    ["openai", ["ChatGPT Pro/Plus (browser)", "API key"]],
    ["anthropic", ["Claude Code account", "API key"]],
    ["muse", ["Meta Muse Code account", "Meta Model API key"]],
  ] as const) {
    const app = await testRender(
      () => (
        <DialogProviders>
          <DialogIntegrationMethods integration={integrations.find((integration) => integration.id === id)!} />
        </DialogProviders>
      ),
      { width: 80, height: 30 },
    )
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => labels.every((label) => frame.includes(label)))
      const frame = app.captureCharFrame()
      for (const label of labels) expect(frame).toContain(label)
      expect(frame).not.toMatch(/OpenCode|Copilot|Google|Runpod|Bedrock|Kiro/)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("model dialogs show every kept provider and a backend-defined local endpoint", async () => {
  for (const [providerID, name] of [
    ["openai", "GPT-5.2"],
    ["anthropic", "Claude Opus 5"],
    ["openrouter", "OpenRouter Model"],
    ["cursor", "Cursor Model"],
    ["muse", "Meta Muse Model"],
    ["meta", "Meta Model"],
    ["cline-pass", "Cline Model"],
    ["zai", "Z.ai Model"],
    ["minimax", "MiniMax Model"],
    ["moonshotai", "Kimi Model"],
    ["local-endpoint", "Local endpoint Model"],
  ] as const) {
    function Picker() {
      const dialog = useDialog()
      onMount(() => dialog.replace(() => <DialogModel providerID={providerID} />))
      return <SyncLocation />
    }
    const app = await testRender(
      () => (
        <DialogProviders>
          <Picker />
        </DialogProviders>
      ),
      { width: 80, height: 30 },
    )
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes(name))
      const frame = app.captureCharFrame()
      expect(frame).toContain(name)
      if (providerID === "openrouter") expect(frame).toContain("Unavailable")
      expect(frame).not.toMatch(/OpenCode|Copilot|Google|Gemini|Runpod|Bedrock|Kiro/)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("retry links use the standard compact dialog treatment without a provider-specific upsell", async () => {
  for (const link of ["https://opencode.ai/go", "https://console.anthropic.com"]) {
    let dismissed: boolean | undefined
    function Retry() {
      const dialog = useDialog()
      onMount(() =>
        dialog.replace(() => (
          <DialogRetryAction
            title="Provider connection"
            message="Check your credentials."
            label="Open settings"
            link={link}
            onClose={(value) => {
              dismissed = value
            }}
          />
        )),
      )
      return <SyncLocation />
    }
    const app = await testRender(
      () => (
        <DialogProviders>
          <Retry />
        </DialogProviders>
      ),
      { width: 80, height: 30, kittyKeyboard: true, useMouse: true },
    )
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes(link) && frame.includes("don't show again"))
      const rows = app.captureCharFrame().split("\n")
      const titleRow = rows.findIndex((row) => row.includes("Provider connection"))
      const linkRow = rows.findIndex((row) => row.includes(link))
      expect(linkRow - titleRow).toBeLessThanOrEqual(4)
      expect(rows.join("\n")).toContain("Check your credentials.")
      expect(rows.join("\n")).toContain("Open settings")
      const dismissRow = rows.findIndex((row) => row.includes("don't show again"))
      await app.mockMouse.click(rows[dismissRow]!.indexOf("don't show again") + 1, dismissRow)
      await app.waitFor(() => dismissed !== undefined)
      expect(dismissed).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  }
})

test("a provider's profiles offer default selection instead of an active profile", async () => {
  defaultProfileRequests.length = 0
  function Connect() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogIntegration />))
    return <SyncLocation />
  }

  const app = await testRender(
    () => (
      <DialogProviders>
        <Connect />
      </DialogProviders>
    ),
    { width: 100, height: 35, kittyKeyboard: true, useMouse: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Linked · Claude Max, Work"))
    const rows = app.captureCharFrame().split("\n")
    const claudeRow = rows.findIndex((row) => row.includes("Linked · Claude Max, Work"))
    await app.mockMouse.click(rows[claudeRow].indexOf("Claude") + 1, claudeRow)
    await app.waitForFrame((frame) => frame.includes("Disconnect Work"))
    const frame = app.captureCharFrame()
    expect(frame).toMatch(/Claude Max\s+Default profile/)
    expect(frame).toContain("Used when a model has no profile")
    expect(frame).not.toMatch(/[Aa]ctive profile/)
    expect(frame).not.toContain("Use Claude Max")
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => defaultProfileRequests.length > 0)
    expect(defaultProfileRequests).toEqual(["/api/credential/cred_Work/activate"])
  } finally {
    app.renderer.destroy()
  }
})

test("profile activation closes the dialog before profile lists finish refreshing", async () => {
  defaultProfileRequests.length = 0
  profileActivationSucceeded = false
  profileActivationResponseAt = 0
  activationDialogCloseMs = 0
  profileRefreshPaths.length = 0
  profileRefreshResolvers.length = 0
  displayedWorkProfileActive = false
  const profileListUpdated = new Promise<void>((resolve) => {
    resolveProfileListUpdate = resolve
  })
  function Connect() {
    const dialog = useDialog()
    const data = useData()
    const workIsActive = createMemo(() =>
      data.location.integration
        .list()
        ?.find((item) => item.id === "anthropic")
        ?.connections.some(
          (connection) => connection.type === "credential" && connection.label === "Work" && connection.active,
        ),
    )
    createEffect(() => {
      displayedWorkProfileActive = workIsActive() ?? false
      if (displayedWorkProfileActive) resolveProfileListUpdate?.()
    })
    onMount(() => dialog.replace(() => <DialogIntegration />))
    return (
      <>
        <Toast />
        <SyncLocation />
        <text>{workIsActive() ? "Work profile active" : "Work profile inactive"}</text>
      </>
    )
  }

  const app = await testRender(
    () => (
      <DialogProviders>
        <Connect />
      </DialogProviders>
    ),
    {
      width: 100,
      height: 35,
      kittyKeyboard: true,
      useMouse: true,
    },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Linked · Claude Max, Work"))
    const rows = app.captureCharFrame().split("\n")
    const claudeRow = rows.findIndex((row) => row.includes("Linked · Claude Max, Work"))
    await app.mockMouse.click(rows[claudeRow]!.indexOf("Claude") + 1, claudeRow)
    await app.waitForFrame((frame) => frame.includes("Disconnect Work"))
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitForFrame(() => defaultProfileRequests.length > 0)
    await app.waitForFrame((frame) => frame.includes("Default profile changed") && !frame.includes("Disconnect Work"))
    activationDialogCloseMs = performance.now() - profileActivationResponseAt
    const frame = app.captureCharFrame()
    expect(frame).toContain("Default profile changed")
    await app.waitForFrame(() => profileRefreshPaths.length === 3)
    expect(profileRefreshPaths.toSorted()).toEqual(["/api/integration", "/api/model/default", "/api/provider"])
    expect(app.captureCharFrame()).toContain("Work profile inactive")
    for (const resolve of profileRefreshResolvers) resolve()
    await app.waitForFrame(() => profileRefreshPaths.length === 4)
    expect(profileRefreshPaths.toSorted()).toEqual([
      "/api/integration",
      "/api/model",
      "/api/model/default",
      "/api/provider",
    ])
    for (const resolve of profileRefreshResolvers) resolve()
    await profileListUpdated
    expect(displayedWorkProfileActive).toBe(true)
    console.info("Profile activation dialog-close timing", { activationDialogCloseMs })
  } finally {
    for (const resolve of profileRefreshResolvers) resolve()
    resolveProfileListUpdate = undefined
    profileActivationSucceeded = false
    app.renderer.destroy()
  }
})

const designChecks: Partial<
  Record<(typeof states)[number]["name"], { title: string; row: number; column: number; text: string }>
> = {
  "mcp-servers": { title: "MCP servers", row: 7, column: 6, text: "agentmemory" },
  "select-agent": { title: "Select agent", row: 7, column: 6, text: "build" },
  settings: { title: "Settings", row: 8, column: 3, text: "Appearance" },
  "connect-service": { title: "Connect a service", row: 8, column: 3, text: "Popular" },
  "connect-meta-muse": { title: "Connect Meta Muse", row: 7, column: 6, text: "Meta Muse Code account" },
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

function DialogProviders(props: { children: JSX.Element; clipboard?: ClipboardService; mode?: "dark" | "light" }) {
  const events = createEventStream()
  const transport = createFetch(route, events)
  return (
    <TestTuiContexts paths={{ state }}>
      <ClipboardProvider value={props.clipboard}>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig({ session: { thinking: "show" } })}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <ThemeProvider mode={props.mode ?? "dark"} source={{ discover: () => Promise.resolve({}) }}>
                          <LocalProvider>
                            <PromptStashProvider>
                              <DialogProvider>{props.children}</DialogProvider>
                            </PromptStashProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
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

  const app = await testRender(
    () => (
      <DialogProviders>
        <DialogFixture />
      </DialogProviders>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(dialogState.settle))

  try {
    const rows = app.captureCharFrame().replace(/\n$/, "").split("\n")
    expect(rows).toHaveLength(viewport.height)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)
    const frame = rows.join("\n")
    expect(frame).toContain(dialogState.settle)
    if (dialogState.name === "select-agent") {
      expect(frame).toContain("GSD")
      expect(frame).not.toContain("TLDR")
    }
    if ("evidence" in dialogState) expect(frame).toContain(dialogState.evidence)
    const design = designChecks[dialogState.name]
    if (design) {
      const titleRow = rows.findIndex((row) => row.includes(design.title))
      expect(titleRow).toBeGreaterThanOrEqual(0)
      const origin = { row: titleRow - 1, column: rows[titleRow]!.indexOf(design.title) - 3 }
      expectAt(rows, origin.row + design.row - 1, origin.column + design.column, design.text)
      expectAt(rows, origin.row + 1, origin.column + 91, "esc")
    }
    await Bun.write(
      path.join(renders, `dialog-remaining-${dialogState.name}-${viewport.width}x${viewport.height}.txt`),
      rows.join("\n"),
    )
  } finally {
    app.renderer.destroy()
  }
}

function expectAt(rows: string[], row: number, column: number, text: string) {
  expect(rows[row]?.slice(column, column + text.length)).toBe(text)
}

async function route(url: URL, request: Request) {
  if (url.pathname === "/api/integration/muse/connect/oauth")
    return json({
      location,
      data: {
        attemptID: "attempt_layout",
        url: "https://auth.example.test/authorize?client_id=synthetic-client&scope=profile",
        instructions: "Enter code: TEST-ONLY",
        mode: "auto",
        ...(oauthManualCode ? { manualCode: true } : {}),
        time: { created: 1, expires: 2 },
      },
    })
  if (url.pathname === "/api/integration/muse/connect/oauth/attempt_layout" && request.method === "GET")
    return json({ location, data: { status: oauthStatus, time: { created: 1, expires: 2 } } })
  if (url.pathname === "/api/integration/muse/connect/oauth/attempt_layout/complete" && request.method === "POST") {
    const input: unknown = await request.json()
    if (input && typeof input === "object" && "code" in input && typeof input.code === "string")
      oauthSubmitted.push(input.code)
    return new Response(null, { status: 204 })
  }
  if (url.pathname === "/api/integration/muse/connect/oauth/attempt_layout" && request.method === "DELETE") {
    oauthCancelled.push("attempt_layout")
    return new Response(null, { status: 204 })
  }
  if (url.pathname.startsWith("/api/credential/") && url.pathname.endsWith("/activate") && request.method === "POST") {
    defaultProfileRequests.push(url.pathname)
    profileActivationSucceeded = true
    profileActivationResponseAt = performance.now()
    return new Response(null, { status: 204 })
  }
  if (
    profileActivationSucceeded &&
    ["/api/integration", "/api/model", "/api/model/default", "/api/provider"].includes(url.pathname)
  ) {
    profileRefreshPaths.push(url.pathname)
    await new Promise<void>((resolve) => profileRefreshResolvers.push(resolve))
    if (url.pathname === "/api/integration") {
      return json({
        location,
        data: integrations.map((item) =>
          item.id !== "anthropic"
            ? item
            : {
                ...item,
                connections: item.connections.map((connection) =>
                  connection.type === "credential" && connection.label === "Work"
                    ? { ...connection, active: true }
                    : connection.type === "credential"
                      ? { ...connection, active: false }
                      : connection,
                ),
              },
        ),
      })
    }
  }
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, messages, { session })
  if (url.pathname === "/api/mcp") return json({ location, data: mcp })
  if (url.pathname === "/api/model") return json({ location, data: models })
  if (url.pathname === "/api/model/default") return json({ location, data: undefined })
  if (url.pathname === "/api/provider") return json({ location, data: providers })
  if (url.pathname === "/api/agent") return json({ location, data: agents })
  if (url.pathname === "/api/integration") return json({ location, data: integrations })
  if (url.pathname === "/api/skill") return json({ location, data: skills })
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/fs/find")
    return json({ data: [{ path: "packages/tui/test/screen/dialog-remaining-capture.test.tsx" }] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/project/proj_test/directories") return json(directories)
  if (url.pathname === "/api/project-copy/proj_test/refresh") return json({})
  if (url.pathname === "/api/server") return json({ urls: ["http://127.0.0.1:4096"] })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/form`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/reference",
      "/api/command",
      "/api/shell",
      "/api/permission/request",
      "/api/form/request",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/session/active") return json({ data: {} })
  if (url.pathname === `/api/session/${sessionID}/autonomy`) return json({ data: { mode: "normal", yolo: false } })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (url.pathname === "/api/session/ses_subagent_capture/subagent")
    return json({ data: subagents, summary: { total: 4, active: 2, running: 1, waiting: 1 }, cursor: {} })
  return undefined
}

const captureNow = 1_800_000_000_000
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  time: { created: captureNow - 120_000, updated: captureNow - 120_000 },
}
const sessions = [
  session,
  {
    ...session,
    id: "ses_docs_capture",
    title: "Docs sync sweep",
    time: { created: captureNow - 3_600_000, updated: captureNow - 3_600_000 },
  },
  {
    ...session,
    id: "ses_keymap_capture",
    title: "Keymap audit",
    time: { created: captureNow - 86_400_000, updated: captureNow - 86_400_000 },
  },
  {
    ...session,
    id: "ses_theme_capture",
    title: "Theme migration",
    time: { created: captureNow - 259_200_000, updated: captureNow - 259_200_000 },
  },
]
const messages = [
  { id: "msg_audit", type: "user" as const, text: "Concrete timeline message", time: { created: 1 } },
  { id: "msg_review", type: "user" as const, text: "Concrete fork boundary", time: { created: 2 } },
]
const agents = [
  { id: "build", description: "Default primary agent" },
  { id: "GSD", description: "Get shit done: orchestration-only delivery" },
  { id: "plan", description: "Planning and analysis" },
  { id: "analyze", description: "Code analysis and review" },
  { id: "brainstorm", description: "Ideation and design" },
  { id: "general", description: "Background subagent" },
].map((agent) => ({
  ...agent,
  name: agent.id,
  mode: "primary" as const,
  hidden: false,
  permissions: [],
  request: { headers: {}, body: {} },
}))
const model = (input: {
  id: string
  providerID: string
  name: string
  family: string
  context: number
  enabled?: boolean
}) => ({
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
  model({
    id: "claude-opus-5",
    providerID: "anthropic",
    name: "Claude Opus 5",
    family: "deep reasoning",
    context: 200_000,
  }),
  model({
    id: "claude-sonnet-5",
    providerID: "anthropic",
    name: "Claude Sonnet 5",
    family: "balanced",
    context: 200_000,
  }),
  model({
    id: "claude-haiku-4-5",
    providerID: "anthropic",
    name: "Claude Haiku 4.5",
    family: "fast",
    context: 200_000,
  }),
  model({ id: "gpt-5-2", providerID: "openai", name: "GPT-5.2", family: "", context: 400_000 }),
  ...[
    { id: "cursor", name: "Cursor" },
    { id: "muse", name: "Meta Muse" },
    { id: "meta", name: "Meta" },
    { id: "cline-pass", name: "Cline" },
    { id: "zai", name: "Z.ai" },
    { id: "minimax", name: "MiniMax" },
    { id: "moonshotai", name: "Kimi" },
    { id: "local-endpoint", name: "Local endpoint" },
  ].map((provider) =>
    model({
      id: `${provider.id}-model`,
      providerID: provider.id,
      name: `${provider.name} Model`,
      family: "",
      context: 200_000,
    }),
  ),
  model({
    id: "openrouter-model",
    providerID: "openrouter",
    name: "OpenRouter Model",
    family: "connect first",
    context: 1_000_000,
    enabled: false,
  }),
]
const providers = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "cursor", name: "Cursor" },
  { id: "muse", name: "Meta Muse" },
  { id: "meta", name: "Meta" },
  { id: "cline-pass", name: "Cline" },
  { id: "zai", name: "Z.ai" },
  { id: "minimax", name: "MiniMax" },
  { id: "moonshotai", name: "Kimi" },
  { id: "local-endpoint", name: "Local endpoint" },
]
const credential = (label: string) => [{ type: "credential" as const, id: `cred_${label}`, label, active: true }]
const integrations = [
  { id: "cline-pass", name: "Cline", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  {
    id: "openai",
    name: "OpenAI",
    methods: [
      { id: "chatgpt-browser", type: "oauth" as const, label: "ChatGPT Pro/Plus (browser)" },
      { type: "key" as const, label: "API key" },
    ],
    connections: credential("default"),
  },
  {
    id: "muse",
    name: "Meta Muse",
    methods: [
      { id: "muse", type: "oauth" as const, label: "Meta Muse Code account" },
      { type: "key" as const, label: "Meta Model API key" },
    ],
    connections: [],
  },
  {
    id: "anthropic",
    name: "Claude",
    methods: [
      { id: "claude-code", type: "oauth" as const, label: "Claude Code account" },
      { type: "key" as const, label: "API key" },
    ],
    connections: [
      ...credential("Claude Max"),
      { type: "credential" as const, id: "cred_Work", label: "Work", active: false },
    ],
  },
  { id: "openrouter", name: "OpenRouter", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  { id: "zai", name: "Z.ai", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  {
    id: "minimax",
    name: "MiniMax",
    methods: [{ type: "key" as const, label: "API key" }],
    connections: [],
  },
  { id: "cursor", name: "Cursor", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  { id: "meta", name: "Meta", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
  { id: "moonshotai", name: "Kimi", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
]
const skills = [
  {
    id: "go-developer",
    name: "go-developer",
    description: "Scoped Go implementation",
    location: `${worktree}/.ycoding/skills/go-developer/SKILL.md`,
    content: "",
  },
  {
    id: "writing-test",
    name: "writing-test",
    description: "Markdown QA plans",
    location: "/tmp/ycoding/home/.agents/skills/writing-test/SKILL.md",
    content: "",
  },
  {
    id: "penpot",
    name: "penpot",
    description: "Penpot UX/UI work",
    location: "/tmp/ycoding/home/.agents/skills/penpot/SKILL.md",
    content: "",
  },
]
const subagent = (input: {
  id: string
  description: string
  state: "waiting" | "running" | "completed" | "cancelled"
  elapsed: number
  progress?: string
}) => ({
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
  subagent({
    id: "docs-sync",
    description: "Sync provider docs",
    state: "running",
    elapsed: 134_000,
    progress: "74% hit · 2m14s",
  }),
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
