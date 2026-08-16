/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import path from "node:path"
import { createEffect } from "solid-js"
import { Composer } from "../../src/routes/session/composer"
import { Footer } from "../../src/routes/session/footer"
import { Header } from "../../src/routes/session/header"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider, useLocation } from "../../src/context/location"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { ToastProvider } from "../../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_0085fc701x"
const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "project", directory } }
const capturedAt = Date.now()
const session = {
  id: sessionID,
  title: "YCoding",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}
const tasks = [
  task("ses_0a11ce02", "test-triage", "Triage the 2 failing provider tests", "waiting", 4 * 60 + 2, "claude-sonnet-5"),
  task("ses_0a11ce03", "docs-sync", "Sync provider docs with cache fields", "running", 2 * 60 + 14, "claude-sonnet-5"),
  task("ses_0a11ce04", "keymap-audit", "Audit duplicate keybinds", "completed", 48, "claude-haiku-4-5"),
  task("ses_0a11ce05", "bench-run", "Benchmark cache warm path", "cancelled", 12, "claude-sonnet-5"),
]
const children = tasks.map((task) => ({
  ...session,
  id: task.sessionID,
  parentID: sessionID,
  title: task.description,
  agent: task.agent,
  model: task.model,
  cost: childCost(task.sessionID),
  time: task.time,
}))
const shells = ["test", "dev", "lint"].map((id, index) => ({
  id: `sh_${id}`,
  command: id,
  status: "running",
  cwd: directory,
  shell: "bash",
  file: `/tmp/sh_${id}`,
  pid: 48_000 + index,
  metadata: { sessionID },
  time: { started: capturedAt - (index + 1) * 1_000 },
}))

test("captures populated subagent picker states at reference terminal dimensions", async () => {
  for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT]) {
    const capture = await boot(viewport)
    try {
      await waitFor(capture.frame, "Claude Opus 5")
      await waitFor(capture.frame, "ACTIVE")

      const lines = capture.rows()
      expect(lines).toHaveLength(viewport.height)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(viewport.width)
      expect(lines.join("\n")).toContain("Subagents")
      expect(lines.join("\n")).toContain("ACTIVE")
      expect(lines.join("\n")).toContain("INACTIVE")
      // Subagents leads the tab strip, and every task owns exactly one row: the status column, the
      // agent, the description and the metadata share it, with the metadata flush against the
      // composer's right inset so no column can overlap or push another off the row.
      const tabs = viewport.height === NARROW_VIEWPORT.height ? 6 : 45
      expectAt(lines, tabs, 3, "Subagents")
      expectAt(lines, tabs, 14, "2")
      expectAt(lines, tabs, 19, "Shell")
      expectAt(lines, tabs, 25, "3")
      const rows = viewport.height === NARROW_VIEWPORT.height ? [11, 13, 15, 16] : [50, 52, 54, 55]
      expectAt(lines, rows[0]!, 3, "? awaiting")
      expectAt(lines, rows[0]!, 19, "test-triage  · Tria")
      expectAt(lines, rows[1]!, 3, "running")
      expectAt(lines, rows[1]!, 19, "docs-sync  · Sync ")
      expectAt(lines, rows[2]!, 3, "completed")
      expectAt(lines, rows[2]!, 19, "keymap-audit  · Aud")
      expectAt(lines, rows[3]!, 3, "cancelled")
      expectAt(lines, rows[3]!, 19, "bench-run  · Bench")
      for (const row of rows) expect(lines[row]?.trimEnd().length).toBe(viewport.width - 5)
      expect(lines[rows[0]!]).toContain("anthropic/claude-sonnet-5")
      expect(lines[rows[1]!]).toContain("anthropic/claude-sonnet-5")
      expect(lines[rows[2]!]).toContain("anthropic/claude-haiku-4-5")
      expect(lines[rows[3]!]).toContain("anthropic/claude-sonnet-5")
      if (viewport.width === NARROW_VIEWPORT.width) {
        // Narrow terminals drop whole trailing fields instead of colliding.
        for (const row of rows) expect(lines[row]).not.toContain("% hit")
        expect(lines[rows[1]!]).not.toContain("attached")
      }
      if (viewport.width !== NARROW_VIEWPORT.width) {
        expect(lines[rows[0]!]).toContain("anthropic/claude-sonnet-5 · 68% hit · ")
        expect(lines[rows[1]!]).toContain("anthropic/claude-sonnet-5 · attached · 74% hit · ")
        expect(lines[rows[2]!]).toContain("anthropic/claude-haiku-4-5 · 81% hit · ")
        expect(lines[rows[3]!]).toContain("anthropic/claude-sonnet-5 · — · ")
        // Only the awaiting task adds a second row, and it carries the question, never metadata.
        expectAt(lines, 51, 19, "? Should I mark the pre-existing failures as expected, or fix them?")
        expect(lines.filter((line) => line.includes("anthropic/"))).toHaveLength(rows.length)
        expectAt(lines, 64, 3, "Enter attach")
        expectAt(lines, 64, 18, "↑↓ move")
        expectAt(lines, 64, 28, "⌃x k cancel")
        expectAt(lines, 64, 43, "r answer")
        expectAt(lines, 64, 54, "Esc close")
      }
      await Bun.write(path.resolve(import.meta.dir, `../../../../.aphrodite/renders/subagent-picker-${viewport.width}x${viewport.height}.txt`), lines.join("\n"))
    } finally {
      await capture.dispose()
    }
  }
}, 120_000)

test("renders populated subagents in the parent-session rail", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    settle: "SUBAGENTS",
    route,
  })

  try {
    const frame = screen.frame()
    expect(frame).toContain("SUBAGENTS")
    expect(frame).toContain("Should I mark the pre-existing")
    expect(frame).toContain("waiting · 2 subagents")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps the parent header status informational while subagents are active", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    settle: "SUBAGENTS",
    route,
  })

  try {
    const spanOf = (text: string) =>
      screen.spans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === text)

    expect(spanOf("waiting · 2 subagents")?.fg.toInts()).not.toEqual([240, 190, 98, 255])
  } finally {
    await screen.dispose()
  }
}, 60_000)

async function boot(viewport: { width: number; height: number }) {
  const events = createEventStream()
  const calls = createFetch(route, events)
  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ClientProvider api={createApi(calls.fetch)}>
              <DataProvider>
                <LocationProvider>
                  <SyncLocation />
                  <RouteProvider initialRoute={{ type: "session", sessionID }}>
                    <Keymap.Provider>
                      <ToastProvider>
                        <box width={viewport.width} height={viewport.height} flexDirection="column">
                          <Header
                            path="~/Workspace/Personal/YCoding"
                            branch="main"
                            agent="Build"
                            model="Claude Opus 5"
                            variant="max"
                            state={{ type: "awaiting-input", count: 1 }}
                          />
                          <box flexGrow={1} />
                          <Composer sessionID={sessionID} open={true} defaultTab="subagents" />
                          <Footer branch="main" sessionID={sessionID} autonomy={{ mode: "normal", yolo: false }} />
                        </box>
                      </ToastProvider>
                    </Keymap.Provider>
                  </RouteProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()

  return {
    frame: () => app.captureCharFrame(),
    rows: () => {
      const frame = app.captureCharFrame()
      return (frame.endsWith("\n") ? frame.slice(0, -1) : frame).split("\n")
    },
    spanOf: (text: string) =>
      app
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes(text))
        ?.fg.toInts(),
    async dispose() {
      app.renderer.destroy()
    },
  }
}

function SyncLocation() {
  const data = useData()
  const locationState = useLocation()
  createEffect(() => locationState.set(data.location.default()))
  return null
}

async function waitFor(frame: () => string, text: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (frame().includes(text)) return
    await Bun.sleep(50)
  }
  throw new Error(`screen did not settle on ${text}`)
}

function expectAt(lines: string[], row: number, column: number, text: string) {
  const actual = lines[row]?.slice(column, column + text.length)
  if (actual !== text) throw new Error(`Expected ${JSON.stringify(text)} at ${row}:${column}, found at ${lines[row]?.indexOf(text)}: ${lines[row]}`)
}

function task(sessionID: string, agent: string, description: string, state: "waiting" | "running" | "completed" | "cancelled", elapsed: number, modelID: string) {
  return {
    sessionID,
    parentID: session.id,
    description,
    agent,
    model: { providerID: "anthropic", id: modelID },
    background: true,
    state,
    revision: 1,
    question: state === "waiting" ? { text: "Should I mark the pre-existing failures as expected, or fix them?" } : undefined,
    time: { created: capturedAt - elapsed * 1_000, updated: capturedAt },
  }
}

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session, ...children], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (children.some((child) => url.pathname === `/api/session/${child.id}`))
    return json({ data: children.find((child) => url.pathname === `/api/session/${child.id}`) })
  if (children.some((child) => [`/api/session/${child.id}/pending`, `/api/session/${child.id}/permission`, `/api/session/${child.id}/form`, `/api/session/${child.id}/todo`, `/api/session/${child.id}/skills`, `/api/session/${child.id}/guardrail/request`].includes(url.pathname))) return json({ data: [] })
  if (children.some((child) => url.pathname === `/api/session/${child.id}/guardrail`)) return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({ data: [
      { id: "msg_assistant", type: "assistant", agent: "ycoding", model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" }, content: [{ type: "text", text: "Dispatched two background subagents. They run independently and report back here." }], time: { created: 2, completed: 3 } },
      { id: "msg_user", type: "user", text: "Dispatch the background subagents.", time: { created: 1 } },
    ], cursor: {} })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/form`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/subagent`)
    return json({ data: tasks, summary: { total: 4, active: 2, running: 1, waiting: 1 }, cursor: {} })
  if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: diagnostics(sessionID) })
  if (children.some((child) => url.pathname === `/api/session/${child.id}/diagnostics`))
    return json({ data: diagnostics(url.pathname.slice("/api/session/".length, -"/diagnostics".length)) })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/shell") return json({ location, data: shells })
  if (url.pathname === "/api/model") return json({ location, data: models() })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  return undefined
}

function childCost(id: string) {
  return { ses_0a11ce02: 0.45, ses_0a11ce03: 0.41, ses_0a11ce04: 0.26, ses_0a11ce05: 0.12 }[id] ?? 0
}

function model(id: string, name: string, variants: string[] = []) {
  return {
    id,
    modelID: id,
    providerID: "anthropic",
    name,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: variants.map((id) => ({ id })),
    time: { released: 0 },
    cost: [],
    status: "active" as const,
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }
}

function models() {
  return [model("claude-opus-5", "Claude Opus 5", ["max"]), model("claude-sonnet-5", "Sonnet 5"), model("claude-haiku-4-5", "Haiku 4.5")]
}

function diagnostics(id: string) {
  const child = children.find((child) => child.id === id)
  if (!child)
    return {
      model: session.model,
      context: { total: 1_464, percent: 56 },
      tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
      cache: { eligible: 220_672, hitRatio: 0.71, mechanism: "anthropic-cache-control", readReported: true, writeReported: true },
      requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens, latestInvalidation: "stable-hit" },
    }
  const hitRatio = { ses_0a11ce02: 0.68, ses_0a11ce03: 0.74, ses_0a11ce04: 0.81 }[id]
  return {
    model: child.model,
    context: { total: 1_464, percent: 56 },
    tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
    cache: { eligible: 220_672, hitRatio, mechanism: "anthropic-cache-control", readReported: hitRatio !== undefined, writeReported: hitRatio !== undefined },
    requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: child.tokens, latestInvalidation: "stable-hit" },
  }
}
