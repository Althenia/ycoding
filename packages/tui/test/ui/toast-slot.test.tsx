/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { BoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { railPlacement, railWidth } from "../../src/routes/session/rail"
import { SessionRailContent } from "../../src/routes/session/sidebar"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { RouteProvider } from "../../src/context/route"
import { json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"
import { renderScreen } from "../screen/harness"

const variants = [
  { variant: "success", title: "✓ Success", accent: [103, 215, 170, 255], borderAccent: [103, 215, 170, 255] },
  { variant: "info", title: "⋯ Info", accent: [121, 184, 255, 255], borderAccent: [121, 184, 255, 255] },
  { variant: "warning", title: "! Warning", accent: [240, 190, 98, 255], borderAccent: [240, 190, 98, 255] },
  { variant: "error", title: "✗ Error", accent: [239, 125, 132, 255], borderAccent: [239, 125, 132, 255] },
] satisfies Array<{
  variant: "info" | "success" | "warning" | "error"
  title: string
  accent: [number, number, number, number]
  borderAccent: [number, number, number, number]
}>
const overlay = [37, 42, 51, 255] satisfies [number, number, number, number]
const messageInk = [242, 244, 247, 255] satisfies [number, number, number, number]

for (const viewport of [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]) {
  for (const current of variants) {
    test(`renders the measured ${current.variant} toast treatment at ${viewport.width} columns`, async () => {
      const message = `${current.variant} toast message`

      function ToastFixture() {
        const toast = useToast()
        onMount(() => toast.show({ variant: current.variant, message, duration: 60_000 }))
        return <Toast />
      }

      const app = await testRender(
        () => (
          <TestTuiContexts>
            <ConfigProvider config={createTuiResolvedConfig()}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <RouteProvider initialRoute={{ type: "home" }}>
                  <ToastProvider>
                    <ToastFixture />
                  </ToastProvider>
                </RouteProvider>
              </ThemeProvider>
            </ConfigProvider>
          </TestTuiContexts>
        ),
        viewport,
      )
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes(message))

      try {
        const toast = findToast(app.renderer.root, current.title)
        const rows = app.captureCharFrame().split("\n")
        const titleRow = rows.findIndex((row) => row.includes(current.title))
        const messageRow = rows.findIndex((row) => row.includes(message))
        const titleColumn = rows[titleRow]?.indexOf(current.title) ?? -1
        const title = spanFor(app, current.title)
        const body = spanFor(app, message)
        const border = spans(app).filter((span) => span.text.includes("│"))

        expect(toast.width).toBe(60)
        expect(toast.height).toBe(7)
        expect(toast.y).toBe(3)
        expect(toast.x + toast.width).toBe(viewport.width - 2)
        expect(titleRow).toBe(toast.y + 2)
        expect(messageRow).toBe(toast.y + 4)
        expect(titleColumn).toBe(toast.x + 3)
        expect(messageRow - titleRow).toBe(2)
        expect(title.fg.toInts()).toEqual(current.accent)
        expect(title.bg.toInts()).toEqual(overlay)
        expect(body.fg.toInts()).toEqual(messageInk)
        expect(body.bg.toInts()).toEqual(overlay)
        expect(border).toHaveLength(toast.height * 2)
        expect(border.every((span) => span.fg.toInts().every((value, index) => value === current.borderAccent[index]))).toBe(true)
      } finally {
        app.renderer.destroy()
      }
    })
  }
}

test("keeps a capped toast on the physical right edge above the docked session rail", async () => {
  const width = 220
  const rail = railWidth(width)
  const title = "New session - 2026-07-30T06:00"

  function ToastFixture() {
    const toast = useToast()
    onMount(() => toast.show({ variant: "info", message: "Provider usage refreshed", duration: 60_000 }))
    return <Toast />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <RouteProvider initialRoute={{ type: "session", sessionID: "ses_toast" }}>
            <ToastProvider>
              <box width={width} height={24}>
                <box flexGrow={1} />
                {railPlacement(width) === "docked" && (
                  <box id="session-rail" position="absolute" top={0} right={0} width={rail} height="100%">
                    <SessionRailContent sessionID="ses_toast" title={title} />
                  </box>
                )}
                <ToastFixture />
              </box>
            </ToastProvider>
            </RouteProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Provider usage refreshed"))

  try {
    const rendered = descendants(app.renderer.root)
    const toast = rendered.find((item) =>
      item.getChildren().some((child) => child instanceof TextRenderable && child.plainText.includes("Info")),
    )
    const sessionRail = rendered.find((item) => item.id === "session-rail")

    expect(railPlacement(width)).toBe("docked")
    expect(toast).toBeDefined()
    expect(sessionRail).toBeDefined()
    const toastWidth = toast?.width ?? Infinity
    const toastRight = (toast?.x ?? Infinity) + toastWidth
    const railStart = sessionRail?.x ?? -Infinity
    expect(toastWidth).toBe(60)
    expect(toast?.y).toBe(3)
    expect(toastRight).toBe(width - 2)
    expect(toast?.x).toBeLessThan(railStart)
    expect(toastRight).toBeGreaterThan(railStart)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the toast on the right margin when the route renders no rail", async () => {
  const width = 220

  function ToastFixture() {
    const toast = useToast()
    onMount(() => toast.show({ variant: "info", message: "Provider usage refreshed", duration: 60_000 }))
    return <Toast />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <RouteProvider initialRoute={{ type: "home" }}>
              <ToastProvider>
                <box width={width} height={24}>
                  <ToastFixture />
                </box>
              </ToastProvider>
            </RouteProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Provider usage refreshed"))

  try {
    const toast = descendants(app.renderer.root).find((item) =>
      item.getChildren().some((child) => child instanceof TextRenderable && child.plainText.includes("Info")),
    )

    expect(railPlacement(width)).toBe("docked")
    expect(toast).toBeDefined()
    // The home route renders no rail, so the toast must sit on the right margin instead of
    // reserving the width of a rail that is not on screen.
    expect((toast?.x ?? 0) + (toast?.width ?? 0)).toBe(width - 2)
  } finally {
    app.renderer.destroy()
  }
})

test("renders the full docked session route with a top-right toast over the rail", async () => {
  const screen = await renderScreen({
    ...DESIGN_VIEWPORT_WIDE,
    args: { sessionID: "ses_toast" },
    route: toastRoute,
    settle: "Provider usage refreshed",
  })

  try {
    expect(screen.frame()).toContain("Provider usage refreshed")
  } finally {
    await screen.dispose()
  }
}, 60_000)

function descendants(root: Renderable): BoxRenderable[] {
  return root.getChildren().flatMap((child) => {
    if (!(child instanceof BoxRenderable)) return []
    return [child, ...descendants(child)]
  })
}

function findToast(root: Renderable, title: string) {
  const toast = descendants(root).find((item) =>
    item.getChildren().some((child) => child instanceof TextRenderable && child.plainText.includes(title)),
  )
  if (!toast) throw new Error(`No toast for ${title}`)
  return toast
}

function spans(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureSpans().lines.flatMap((line) => line.spans)
}

function spanFor(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const span = spans(app).find((item) => item.text.includes(text))
  if (!span) throw new Error(`No rendered span for ${text}`)
  return span
}

function toastRoute(url: URL) {
  const directory = "/tmp/ycoding/toast-route"
  const location = { directory, project: { id: "proj_toast", directory } }
  const session = {
    id: "ses_toast",
    title: "New session - 2026-07-30T06:00",
    projectID: "proj_toast",
    location: { directory },
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }

  if (url.pathname === "/api/event") return toastEvents()
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === "/api/session/ses_toast") return json({ data: session })
  if (url.pathname === "/api/session/ses_toast/message") return json({ data: [], cursor: {} })
  if (
    [
      "/api/session/ses_toast/pending",
      "/api/session/ses_toast/permission",
      "/api/session/ses_toast/subagent",
      "/api/session/ses_toast/todo",
      "/api/session/ses_toast/skills",
      "/api/session/ses_toast/guardrail/request",
      "/api/shell",
      "/api/mcp",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === "/api/session/ses_toast/guardrail")
    return json({
      data: {
        rootSessionID: "ses_toast",
        profile: "standard",
        customRules: 0,
        approvals: 0,
        blocked: 0,
        counters: [],
        invalidFiles: [],
      },
    })
  if (url.pathname === "/api/session/ses_toast/diagnostics") return json({ data: null })
  if (url.pathname === "/api/vcs/branch") return json({ location, data: { current: "main", default: "main" } })
  if (url.pathname === "/api/model")
    return json({
      location,
      data: [
        {
          id: "claude-opus-5",
          modelID: "claude-opus-5",
          providerID: "anthropic",
          name: "Claude Opus 5",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [{ id: "max" }],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        },
      ],
    })
  if (url.pathname === "/api/provider") return json({ location, data: [{ id: "anthropic", name: "Claude" }] })
  if (url.pathname === "/api/agent")
    return json({
      location,
      data: [{ id: "build", name: "Build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
    })
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname))
    return json({ location, data: [] })
  if (url.pathname === "/api/permission/request" || url.pathname === "/api/form/request") return json({ location, data: [] })
  return undefined
}

function toastEvents() {
  const encoder = new TextEncoder()
  let timeout: ReturnType<typeof setTimeout> | undefined
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n'))
        timeout = setTimeout(() => {
          controller.enqueue(
            encoder.encode(
              'data: {"id":"evt_toast","created":1,"type":"tui.toast.show","data":{"variant":"info","message":"Provider usage refreshed","duration":60000}}\n\n',
            ),
          )
        }, 1_000).unref()
      },
      cancel() {
        if (timeout) clearTimeout(timeout)
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}
