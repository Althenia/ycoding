/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect, onMount } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider, useLocation } from "../../src/context/location"
import { TuiLifecycleProvider } from "../../src/context/runtime"
import { ThemeProvider } from "../../src/context/theme"
import { PluginProvider } from "../../src/plugin/context"
import { createPluginRuntime, PluginRuntimeProvider } from "../../src/plugin/runtime"
import { railPlacement } from "../../src/routes/session/rail"
import { Sidebar } from "../../src/routes/session/sidebar"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogAlert } from "../../src/ui/dialog-alert"
import { ToastProvider } from "../../src/ui/toast"
import { RouteProvider } from "../../src/context/route"
import { createApi, createEventStream, createFetch, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "../viewport"
import { renderScreen } from "./harness"

const sessionID = "ses_responsive_capture"
const directory = "/tmp/ycoding/responsive-capture"
const location = { directory, project: { id: "proj_responsive_capture", directory } }
const session = {
  id: sessionID,
  title: "Responsive rail session",
  projectID: "proj_responsive_capture",
  location: { directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  cost: 9.08,
  tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } },
  time: { created: 1, updated: 4 },
}

test("renders the responsive rail placement bands", async () => {
  expect(railPlacement(99)).toBe("hidden")
  expect(railPlacement(100)).toBe("overlay")
  expect(railPlacement(119)).toBe("overlay")
  expect(railPlacement(120)).toBe("docked")

  const narrow = await renderScreen({ ...NARROW_VIEWPORT, args: { sessionID }, route, settle: "Claude Opus 5" })
  try {
    expect(narrow.frame()).not.toContain("SESSION")
    expect(narrow.frame()).not.toContain(session.title)
  } finally {
    await narrow.dispose()
  }

  for (const width of [100, 119]) {
    const app = await renderOverlayRail(width, 30)
    try {
      const line = app.captureCharFrame().split("\n").find((value) => value.includes("SESSION"))
      // Measure from the rail's own left rule rather than the interpolated rail width. The extra
      // section-label padding only applies at the full-width rail, so the overlay band sits at 5.
      expect((line?.indexOf("SESSION") ?? -1) - (line?.indexOf("│") ?? -1)).toBe(5)
      expect(app.captureCharFrame()).toContain(session.title)
    } finally {
      app.renderer.destroy()
    }
  }

  for (const viewport of [{ width: 120, height: 30 }, DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]) {
    const screen = await renderScreen({ ...viewport, args: { sessionID }, route, settle: "Claude Opus 5" })
    try {
      const line = screen.lines().find((value) => value.includes("SESSION"))
      // Measured from the rail's left rule. The full-width rail adds one column of section-label
      // padding that the narrower docked band does not.
      const labelOffset = viewport.width >= 160 ? 6 : 5
      expect((line?.indexOf("SESSION") ?? -1) - (line?.indexOf("│") ?? -1)).toBe(labelOffset)
      expect(screen.frame()).toContain(session.title)
    } finally {
      await screen.dispose()
    }
  }
}, 60_000)

test("renders the shared dialog at the responsive width ladder", async () => {
  for (const viewport of [NARROW_VIEWPORT, { width: 100, height: 30 }, DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]) {
    const app = await renderDialog(viewport)
    try {
      const line = app.captureCharFrame().split("\n").find((value) => value.includes("Responsive dialog"))
      // The shared dialog panel is the design's 98-column frame above the narrow band.
      const width = viewport.width < 100 ? viewport.width : 98
      // Board 20 places the dialog title at panel column 3.
      expect(line?.indexOf("Responsive dialog")).toBe(Math.ceil((viewport.width - width) / 2) + 3)
      expect(line).toContain("esc")
    } finally {
      app.renderer.destroy()
    }
  }
}, 60_000)

async function renderOverlayRail(width: number, height: number) {
  const events = createEventStream()
  const calls = createFetch(route, events)
  const app = await testRender(
    () => (
      <TuiLifecycleProvider value={{ add: () => () => {} }}>
        <TestTuiContexts directory={directory}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <RouteProvider initialRoute={{ type: "session", sessionID }}>
                <PluginRuntimeProvider value={createPluginRuntime()}>
                  <ClientProvider api={createApi(calls.fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <SyncLocation />
                        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                          <PluginProvider packages={{ resolve: async () => undefined }}>
                            <box width={width} height={height} alignItems="flex-end">
                              <Sidebar sessionID={sessionID} autonomy={{ mode: "normal" }} overlay />
                            </box>
                          </PluginProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </PluginRuntimeProvider>
              </RouteProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      </TuiLifecycleProvider>
    ),
    { width, height },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(session.title))
  return app
}

function SyncLocation() {
  const data = useData()
  const locationState = useLocation()
  createEffect(() => locationState.set(data.location.default()))
  return null
}

async function renderDialog(viewport: { width: number; height: number }) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => {
      dialog.setCentered(true)
      dialog.replace(() => <DialogAlert title="Responsive dialog" message="The shared dialog follows the responsive ladder." />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <DialogFixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Responsive dialog"))
  return app
}

function route(url: URL) {
  if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/message`)
    return json({
      data: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5", variant: "max" },
          content: [{ type: "text", text: "The responsive rail is ready for comparison." }],
          time: { created: 2, completed: 3 },
        },
        { id: "msg_user", type: "user", text: "Check the responsive rail.", time: { created: 1 } },
      ],
      cursor: {},
    })
  if (
    [
      `/api/session/${sessionID}/pending`,
      `/api/session/${sessionID}/permission`,
      `/api/session/${sessionID}/subagent`,
      `/api/session/${sessionID}/todo`,
      `/api/session/${sessionID}/skills`,
      `/api/session/${sessionID}/guardrail/request`,
      "/api/shell",
      "/api/mcp",
    ].includes(url.pathname)
  )
    return json({ location, data: [] })
  if (url.pathname === "/api/mcp/resource") return json({ location, data: { resources: [], templates: [] } })
  if (url.pathname === `/api/session/${sessionID}/guardrail`)
    return json({ data: { rootSessionID: sessionID, profile: "standard", customRules: 0, approvals: 0, blocked: 0, counters: [], invalidFiles: [] } })
  if (url.pathname === `/api/session/${sessionID}/diagnostics`)
    return json({
      data: {
        model: { providerID: "anthropic", id: "claude-opus-5" },
        context: { total: 1_464, percent: 56 },
        tokens: { uncachedInput: 1_411, output: 53, reasoning: 0, cacheRead: 220_672, cacheWrite: 4_096 },
        cache: { eligible: 220_672, hitRatio: 0.71, mechanism: "anthropic-cache-control", readReported: true, writeReported: true },
        requests: { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens: { input: 1_411, output: 53, reasoning: 0, cache: { read: 220_672, write: 4_096 } }, latestInvalidation: "stable-hit" },
      },
    })
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
  if (["/api/integration", "/api/command", "/api/skill", "/api/reference"].includes(url.pathname)) return json({ location, data: [] })
  if (url.pathname === "/api/permission/request" || url.pathname === "/api/form/request") return json({ location, data: [] })
  return undefined
}
