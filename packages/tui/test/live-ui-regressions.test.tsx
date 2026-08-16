/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { onMount } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { formatSidebarFooterPath } from "../src/feature-plugins/sidebar/footer"
import { Keymap } from "../src/context/keymap"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { Footer } from "../src/routes/session/footer"
import { Header } from "../src/routes/session/header"
import { railWidth } from "../src/routes/session/rail"
import { FilePath } from "../src/ui/file-path"
import { Toast, ToastProvider, useToast } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("centers the first rail section title in a full-width three-row background band", async () => {
  const dimensions = { width: 189, height: 69 }
  const app = await bootPromptRegression(dimensions)

  try {
    await waitFor(app.frame, "Prompt regression")
    const frame = app.frame().split("\n")
    const lines = app.spans().lines
    const titleRow = frame.findIndex((row) => row.includes("SESSION"))
    const contentRow = frame.findIndex((row) => row.includes("Prompt regression"))
    const titleBackground = lines[titleRow]?.spans.find((span) => span.text.includes("SESSION"))?.bg.toInts()
    const backgroundColumns = (row: number) =>
      lines[row]?.spans.flatMap((span) => Array.from({ length: span.text.length }, () => span.bg.toInts())) ?? []
    const matchesTitleBackground = (column: ReturnType<typeof backgroundColumns>[number]) =>
      Boolean(titleBackground && column.every((value, index) => value === titleBackground[index]))
    const hasTitleBackground = (row: number) =>
      backgroundColumns(row).slice(dimensions.width - railWidth(dimensions.width)).some(matchesTitleBackground)
    const filledColumns = backgroundColumns(titleRow)
      .map((background, column) => (matchesTitleBackground(background) ? column : undefined))
      .filter(
        (column): column is number =>
          column !== undefined && column >= dimensions.width - railWidth(dimensions.width),
      )

    expect(titleRow).toBe(4)
    expect(contentRow).toBe(titleRow + 3)
    expect([titleRow - 1, titleRow, titleRow + 1].map(hasTitleBackground)).toEqual([true, true, true])
    expect(hasTitleBackground(titleRow + 2)).toBe(false)
    // The rail's one-column left rule sits at its outer edge, so the section band fills every
    // column to its right, through to the terminal edge.
    expect([filledColumns[0], filledColumns.at(-1)]).toEqual([
      dimensions.width - railWidth(dimensions.width) + 1,
      dimensions.width - 1,
    ])
    // The left rule occupies the rail's outermost column, so the band fills the remainder.
    expect(filledColumns).toHaveLength(railWidth(dimensions.width) - 1)
  } finally {
    await app.dispose()
  }
}, 30_000)

test("keeps the prompt input visible with Prompt, Shell, and Subagents selected", async () => {
  const capture = await bootPromptRegression()

  try {
    await waitFor(capture.frame, "Message YCoding")
    expect(capture.frame()).toContain("Message YCoding")

    capture.input.pressKey("ARROW_DOWN")
    await waitFor(capture.frame, "No subagents")
    expect(capture.frame()).toContain("Message YCoding")

    capture.input.pressKey("ARROW_LEFT")
    await waitFor(capture.frame, "No shell commands")
    expect(capture.frame()).toContain("Message YCoding")
  } finally {
    await capture.dispose()
  }
}, 30_000)

test("never renders a Unix home directory username in a file path", async () => {
  const app = await testRender(
    () => (
      <box flexDirection="column">
        <FilePath value={formatSidebarFooterPath("/Users/alice/Workspace/project", "/Users/bob")} maxWidth={38} />
        <FilePath value={formatSidebarFooterPath("/home/alice/Workspace/project", "/home/bob")} maxWidth={38} />
      </box>
    ),
    { width: 40, height: 2 },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.length > 0)
    const frame = app.captureCharFrame()
    expect(frame.match(/~\/Workspace\/project/g)).toHaveLength(2)
    expect(frame).not.toContain("/Users/")
    expect(frame).not.toContain("/home/")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps subagent and shell footer counts as independent segments", async () => {
  const config = createTuiResolvedConfig()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_footer/subagent")
      return json({
        data: [
          { state: "running" },
          { state: "waiting" },
          { state: "completed" },
          { state: "cancelled" },
        ],
      })
    return undefined
  })

  function FooterFixture() {
    const data = useData()
    onMount(() => void data.session.subagent.sync("ses_footer"))
    return <Footer branch="main" sessionID="ses_footer" autonomy={{ mode: "normal", yolo: false }} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <FooterFixture />
                </DataProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 3 },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("subagents"))
    const line = app.captureCharFrame().split("\n").find((row) => row.includes("subagents"))
    expect(line).toContain("subagents 2   shells 0")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the header model readable while a toast is visible", async () => {
  const config = createTuiResolvedConfig()

  function ToastFixture() {
    const toast = useToast()
    onMount(() => toast.show({ variant: "info", message: "Provider usage refreshed", duration: 60_000 }))
    return <Toast />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <RouteProvider initialRoute={{ type: "session", sessionID: "ses_toast" }}>
                <ToastProvider>
                  <box width={120} height={12} flexDirection="column">
                    <Header
                      path="~/Workspace/YCoding"
                      branch="main"
                      agent="Build"
                      model="Claude Opus 5"
                      variant="max"
                      state={{ type: "ready" }}
                    />
                    <ToastFixture />
                  </box>
                </ToastProvider>
              </RouteProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 12 },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("Provider usage refreshed"))
    expect(app.captureCharFrame()).toContain("Claude Opus 5")
  } finally {
    app.renderer.destroy()
  }
})

async function bootPromptRegression(dimensions = { width: 120, height: 56 }) {
  const setup = await createTestRenderer({ ...dimensions, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventStream()
  const session = {
    id: "ses_prompt_regression",
    title: "Prompt regression",
    projectID: "proj_test",
    location: { directory },
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const model = {
    id: "claude-opus-5",
    modelID: "claude-opus-5",
    providerID: "anthropic",
    name: "Claude Opus 5",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    time: { released: 0 },
    cost: [],
    status: "active" as const,
    enabled: true,
    limit: { context: 200_000, output: 32_000 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
    if (
      [`pending`, `permission`, `form`, `todo`, `skills`, `subagent`, `guardrail/request`].some((suffix) =>
        url.pathname.endsWith(`/${suffix}`),
      )
    )
      return json({ data: [] })
    if (url.pathname === `/api/session/${session.id}/guardrail`)
      return json({ data: { rootSessionID: session.id, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
    if (url.pathname === "/api/model") return json({ data: [model] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({}), update: async () => ({}) },
      packages: { resolve: async () => undefined },
      args: { sessionID: session.id },
      log: () => {},
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
  )

  return {
    frame: () => setup.captureCharFrame(),
    spans: () => setup.captureSpans(),
    input: setup.mockInput,
    async dispose() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task.catch(() => {})
      await server.stop()
      mock.restore()
    },
  }
}

async function waitFor(frame: () => string, text: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (frame().includes(text)) return
    await Bun.sleep(50)
  }
  throw new Error(`screen did not settle on ${text}`)
}
