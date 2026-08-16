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

const sessionID = "ses_0085fc701"
const directory = `${process.env.HOME}/Workspace/Personal/YCoding`
const location = { directory, project: { id: "project", directory } }
const session = {
  id: sessionID,
  title: "Provider cache audit",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}
const tasks = [
  task("ses_0a11ce02", "test-triage", "Triage the two failing provider tests", "waiting", 4),
  task("ses_0a11ce03", "docs-sync", "Sync provider docs with cache fields", "running", 3),
  task("ses_0a11ce04", "keymap-audit", "Audit duplicate keybinds", "completed", 2),
  task("ses_0a11ce05", "bench-run", "Benchmark cache warm path", "cancelled", 1),
]

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
    expect(frame).toContain("1 awaiting input")
  } finally {
    await screen.dispose()
  }
}, 60_000)

test("keeps the header status amber and renders the footer awaiting chip dark on amber", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT,
    args: { sessionID },
    settle: "SUBAGENTS",
    route,
  })

  try {
    const spanOf = (text: string) =>
      screen.spans().lines.flatMap((line) => line.spans).find((span) => span.text.trim() === text)

    expect(spanOf("1 subagent awaiting input")?.fg.toInts()).toEqual([240, 190, 98, 255])
    expect(spanOf("1 awaiting")?.fg.toInts()).toEqual([15, 17, 21, 255])
    expect(spanOf("1 awaiting")?.bg.toInts()).toEqual([240, 190, 98, 255])
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
                          <Footer />
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

function task(sessionID: string, agent: string, description: string, state: "waiting" | "running" | "completed" | "cancelled", created: number) {
  return {
    sessionID,
    parentID: session.id,
    description,
    agent,
    model: { providerID: "anthropic", id: "claude-sonnet-5" },
    background: true,
    state,
    revision: 1,
    question: state === "waiting" ? { text: "Should I mark the pre-existing failures as expected?" } : undefined,
    time: { created, updated: created },
  }
}

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (tasks.some((task) => url.pathname === `/api/session/${task.sessionID}`))
    return json({ data: { ...session, id: url.pathname.slice("/api/session/".length), parentID: sessionID } })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({ data: [{ id: "msg_user", type: "user", text: "Dispatch the background subagents.", time: { created: 1 } }], cursor: {} })
  if ([`/api/session/${sessionID}/pending`, `/api/session/${sessionID}/permission`, `/api/session/${sessionID}/form`, `/api/session/${sessionID}/todo`, `/api/session/${sessionID}/skills`, `/api/session/${sessionID}/guardrail/request`].includes(url.pathname)) return json({ data: [] })
  if (url.pathname === `/api/session/${sessionID}/subagent`) return json({ data: tasks })
  if (url.pathname === `/api/session/${sessionID}/guardrail`) return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`) return json({ data: diagnostics() })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model") return json({ location, data: [model()] })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }] })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference", "/api/mcp", "/api/shell", "/api/permission/request", "/api/form/request"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/path") return json({ home: process.env.HOME, state: "", config: "", worktree: directory, directory })
  return undefined
}

function model() { return { id: "claude-opus-5", modelID: "claude-opus-5", providerID: "anthropic", name: "Claude Opus 5", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "max" }], time: { released: 0 }, cost: [], status: "active" as const, enabled: true, limit: { context: 200_000, output: 32_000 } } }
function diagnostics() { return { model: session.model, context: { total: 1_464, percent: 56 }, tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 }, cache: { eligible: 220_672, hitRatio: 0.71, mechanism: "anthropic-cache-control", readReported: true, writeReported: true }, requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: session.tokens, latestInvalidation: "stable-hit" } } }
