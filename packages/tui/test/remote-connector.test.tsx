/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { CommandPaletteDialog } from "../src/component/command-palette"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { RemoteProvider, useRemote, type RemoteMcpStatus, type RemoteStatus } from "../src/remote-connector"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider, useToast } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

function fakeServer() {
  let state: RemoteStatus = { state: "off" }
  const writes: boolean[] = []
  return {
    get: async () => state,
    set: async (enabled: boolean) => {
      writes.push(enabled)
      state = { state: enabled ? "on" as const : "off" as const }
      return state
    },
    change: (value: RemoteStatus) => { state = value },
    writes,
  }
}

function fakeMcp() {
  let state: RemoteMcpStatus = { state: "off" }
  const writes: boolean[] = []
  return {
    get: async () => state,
    set: async (enabled: boolean) => {
      writes.push(enabled)
      state = enabled ? { state: "on", url: "https://relay.example/api/mcp/devices/dev_1" } : { state: "off" }
      return state
    },
    change: (value: RemoteMcpStatus) => { state = value },
    writes,
  }
}

async function awaitFrame(app: Awaited<ReturnType<typeof testRender>>, matches: (frame: string) => boolean) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (matches(app.captureCharFrame())) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(matches(app.captureCharFrame())).toBe(true)
}

async function renderRemote(server: ReturnType<typeof fakeServer>, mcp: ReturnType<typeof fakeMcp> = fakeMcp(), width = 80) {
  let remote!: ReturnType<typeof useRemote>
  let dispatch!: (id: string) => void
  let toastMessage!: () => string | undefined
  let commands!: () => readonly { id?: string; title?: string }[]
  let colors!: () => { active: [number, number, number, number]; inactive: [number, number, number, number] }
  function Probe() {
    remote = useRemote()
    const keymap = Keymap.use()
    const dialog = useDialog()
    const toast = useToast()
    toastMessage = () => toast.currentToast?.message
    const theme = useTheme().contextual("elevated")
    colors = () => ({ active: theme.theme.text.feedback.success.default.toInts(), inactive: theme.theme.text.subdued.toInts() })
    commands = Keymap.useCommands()
    Keymap.createLayer(() => ({ mode: "global", commands: [
      { id: "command.palette.show", title: "Show command palette", run: () => dialog.replace(() => <CommandPaletteDialog />) },
      { id: "test.shortcut", title: "Other command", palette: true, bind: "ctrl+o", run: () => {} },
    ] }))
    onMount(() => { dispatch = (id) => keymap.dispatch(id) })
    return <><text>Remote fixture: {remote.status().state} mcp: {remote.mcp().state}</text><Toast /></>
  }
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider><ToastProvider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><DialogProvider>
        <RemoteProvider server={server} mcp={mcp}><Probe /></RemoteProvider>
      </DialogProvider></ThemeProvider></ToastProvider></Keymap.Provider>
    </ConfigProvider></TestTuiContexts>
  ), { width, height: 24 })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Remote fixture: off mcp: off"))
  return { app, status: () => remote.status(), dispatch: (id: string) => dispatch(id), commands: () => commands(), toastMessage: () => toastMessage(), colors: () => colors() }
}

test("the one remote row shows colored server states even when highlighted", async () => {
  const server = fakeServer()
  const view = await renderRemote(server)
  try {
    expect(view.commands().filter((command) => command.id?.startsWith("remote.")).map((command) => command.title)).toEqual(["Remote connection", "Relay MCP"])
    view.dispatch("command.palette.show")
    await view.app.waitForFrame((frame) => frame.includes("Remote connection"))
    await view.app.mockInput.typeText("Remote connection")
    const check = async (label: string, color: [number, number, number, number]) => {
      await awaitFrame(view.app, (frame) => frame.includes(`● ${label}`) && !frame.includes("Other command"))
      const row = view.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(`● ${label}`)))
      expect(row?.spans.find((span) => span.text.includes(`● ${label}`))?.fg.toInts()).toEqual(color)
      expect(view.app.captureCharFrame()).not.toContain("elsewhere")
    }
    await check("off", view.colors().inactive)
    server.change({ state: "on" })
    await check("on", view.colors().active)
    server.change({ state: "connecting" })
    await check("connecting", view.colors().inactive)
    server.change({ state: "error", message: "Relay rejected the device" })
    await check("error", view.colors().inactive)
  } finally {
    view.app.renderer.destroy()
  }
}, 15_000)

test("palette selection toggles the shared server switch in both directions", async () => {
  const server = fakeServer()
  const view = await renderRemote(server)
  try {
    const select = async (label: string) => {
      view.dispatch("command.palette.show")
      await view.app.waitForFrame((frame) => frame.includes("Remote connection"))
      await view.app.mockInput.typeText("Remote connection")
      await view.app.waitForFrame((frame) => frame.includes(`● ${label}`))
      view.app.mockInput.pressEnter()
      await view.app.waitForFrame((frame) => !frame.includes("Commands"))
    }
    await select("off")
    expect(server.writes).toEqual([true])
    await view.app.waitForFrame((frame) => frame.includes("Remote fixture: on"))
    await select("on")
    await view.app.waitForFrame((frame) => frame.includes("Remote fixture: off"))
    expect(server.writes).toEqual([true, false])
  } finally {
    view.app.renderer.destroy()
  }
})

test.each(["connecting", "error"] as const)("remote toggle disables the enabled connector while %s", async (state) => {
  const server = fakeServer()
  const view = await renderRemote(server)
  try {
    server.change({ state, ...(state === "error" ? { message: "Connection needs attention" } : {}) })
    await awaitFrame(view.app, (frame) => frame.includes(`Remote fixture: ${state}`))
    view.dispatch("remote.toggle")
    await view.app.waitForFrame((frame) => frame.includes("Remote fixture: off"))
    expect(server.writes).toEqual([false])
  } finally {
    view.app.renderer.destroy()
  }
}, 10_000)

test("a second toggle cancels pending enable intent and ignores its late reply", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const fixture = fakeServer()
  const server = {
    ...fixture,
    set: async (enabled: boolean): Promise<RemoteStatus> => {
      fixture.writes.push(enabled)
      if (!enabled) {
        fixture.change({ state: "off" })
        return { state: "off" }
      }
      started.resolve()
      await release.promise
      settled.resolve()
      return { state: "connecting" }
    },
  }
  const view = await renderRemote(server)
  try {
    view.dispatch("remote.toggle")
    await started.promise
    view.dispatch("remote.toggle")
    await view.app.waitForFrame((frame) => frame.includes("Remote fixture: off"))
    expect(fixture.writes).toEqual([true, false])
    release.resolve()
    await settled.promise
    await view.app.renderOnce()
    expect(view.status()).toEqual({ state: "off" })
  } finally {
    release.resolve()
    view.app.renderer.destroy()
  }
})

test("two TUIs display one server state and reflect the other's switch within a probe", async () => {
  const server = fakeServer()
  const mcp = fakeMcp()
  const controls: Partial<Record<"first" | "second", () => void>> = {}
  function Probe(props: { id: "first" | "second" }) {
    const remote = useRemote()
    const keymap = Keymap.use()
    onMount(() => { controls[props.id] = () => keymap.dispatch("remote.toggle") })
    return <text>{props.id}: {remote.status().state}</text>
  }
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}>
      <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><ToastProvider>
        <Keymap.Provider><DialogProvider><RemoteProvider server={server} mcp={mcp}><Probe id="first" /></RemoteProvider></DialogProvider></Keymap.Provider>
        <Keymap.Provider><DialogProvider><RemoteProvider server={server} mcp={mcp}><Probe id="second" /></RemoteProvider></DialogProvider></Keymap.Provider>
      </ToastProvider></ThemeProvider>
    </ConfigProvider></TestTuiContexts>
  ), { width: 80, height: 24 })
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("first: off") && frame.includes("second: off"))
    controls.first?.()
    await app.waitForFrame((frame) => frame.includes("first: on"))
    await awaitFrame(app, (frame) => frame.includes("second: on"))
    expect(app.captureCharFrame()).toContain("second: on")
    expect(app.captureCharFrame()).not.toContain("elsewhere")
    controls.second?.()
    await app.waitForFrame((frame) => frame.includes("second: off"))
    await awaitFrame(app, (frame) => frame.includes("first: off"))
    expect(app.captureCharFrame()).toContain("first: off")
    expect(server.writes).toEqual([true, false])
  } finally {
    app.renderer.destroy()
  }
}, 12_000)

test("Relay MCP palette row shows its own colored state and toggles the shared MCP switch", async () => {
  const server = fakeServer()
  const mcp = fakeMcp()
  const view = await renderRemote(server, mcp)
  try {
    server.change({ state: "on" })
    await awaitFrame(view.app, (frame) => frame.includes("Remote fixture: on"))
    view.dispatch("command.palette.show")
    await view.app.waitForFrame((frame) => frame.includes("Relay MCP"))
    await view.app.mockInput.typeText("Relay MCP")
    const check = async (label: string, color: [number, number, number, number]) => {
      await awaitFrame(view.app, (frame) => frame.includes(`● ${label}`) && !frame.includes("Other command"))
      const row = view.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(`● ${label}`)))
      expect(row?.spans.find((span) => span.text.includes(`● ${label}`))?.fg.toInts()).toEqual(color)
    }
    await check("off", view.colors().inactive)
    mcp.change({ state: "on", url: "https://relay.example/api/mcp/devices/dev_1" })
    await check("on", view.colors().active)
    mcp.change({ state: "connecting" })
    await check("connecting", view.colors().inactive)
    mcp.change({ state: "error", message: "Relay rejected MCP" })
    await check("error", view.colors().inactive)
  } finally {
    view.app.renderer.destroy()
  }
}, 15_000)

test("Relay MCP enables from off and disables from connecting, on, or error with an authority notice", async () => {
  const server = fakeServer()
  const mcp = fakeMcp()
  const view = await renderRemote(server, mcp)
  try {
    server.change({ state: "on" })
    await awaitFrame(view.app, (frame) => frame.includes("Remote fixture: on"))
    view.dispatch("remote.mcp.toggle")
    await view.app.waitForFrame((frame) => frame.includes("mcp: on"))
    await view.app.waitForFrame((frame) => frame.includes("Relay MCP") && frame.includes("Info"))
    for (const phrase of ["existing and", "future Sessions", "home", "Always approvals", "YOLO"])
      expect(view.app.captureCharFrame()).toContain(phrase)
    view.dispatch("remote.mcp.toggle")
    await view.app.waitForFrame((frame) => frame.includes("mcp: off"))
    expect(mcp.writes).toEqual([true, false])
    for (const state of ["connecting", "error"] as const) {
      mcp.change({ state, ...(state === "error" ? { message: "needs attention" } : {}) })
      await awaitFrame(view.app, (frame) => frame.includes(`mcp: ${state}`))
      view.dispatch("remote.mcp.toggle")
      await view.app.waitForFrame((frame) => frame.includes("mcp: off"))
    }
    expect(mcp.writes).toEqual([true, false, false, false])
    expect(server.writes).toEqual([])
  } finally {
    view.app.renderer.destroy()
  }
}, 15_000)

test("Relay MCP refuses to enable while Remote is off and names the connect command", async () => {
  const server = fakeServer()
  const mcp = fakeMcp()
  const view = await renderRemote(server, mcp)
  try {
    view.dispatch("remote.mcp.toggle")
    await view.app.waitForFrame((frame) => frame.includes("Error"))
    expect(view.toastMessage()).toContain("ycoding remote connect")
    expect(mcp.writes).toEqual([])
    expect(view.app.captureCharFrame()).toContain("mcp: off")
  } finally {
    view.app.renderer.destroy()
  }
}, 10_000)

test("the Remote authority notice keeps its wrapped final line visible", async () => {
  const view = await renderRemote(fakeServer(), fakeMcp(), 32)
  try {
    view.dispatch("remote.toggle")
    await view.app.waitForFrame((frame) => frame.includes("backend."))
    expect(view.app.captureCharFrame()).toContain("Connecting grants")
  } finally { view.app.renderer.destroy() }
}, 10_000)

test("the complete Relay MCP authority notice fits a narrow terminal", async () => {
  const server = fakeServer()
  const view = await renderRemote(server, fakeMcp(), 32)
  try {
    server.change({ state: "on" })
    await awaitFrame(view.app, (frame) => frame.includes("Remote fixture: on"))
    view.dispatch("remote.mcp.toggle")
    await view.app.waitForFrame((frame) => frame.includes("Runtime limits apply."))
    for (const phrase of ["All existing and", "future Sessions on", "this machine.", "existing folders", "strictly below home.", "Give Always approvals.", "Change YOLO/autonomy."])
      expect(view.app.captureCharFrame()).toContain(phrase)
  } finally { view.app.renderer.destroy() }
}, 10_000)

test("a second Relay MCP toggle cancels a pending enable and ignores its late reply", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const fixture = fakeMcp()
  const mcp = {
    ...fixture,
    set: async (enabled: boolean): Promise<RemoteMcpStatus> => {
      fixture.writes.push(enabled)
      if (!enabled) {
        fixture.change({ state: "off" })
        return { state: "off" }
      }
      started.resolve()
      await release.promise
      settled.resolve()
      return { state: "on", url: "https://relay.example/api/mcp/devices/dev_1" }
    },
  }
  const server = fakeServer()
  const view = await renderRemote(server, mcp)
  try {
    server.change({ state: "on" })
    await awaitFrame(view.app, (frame) => frame.includes("Remote fixture: on"))
    view.dispatch("remote.mcp.toggle")
    await started.promise
    view.dispatch("remote.mcp.toggle")
    await view.app.waitForFrame((frame) => frame.includes("mcp: off"))
    release.resolve()
    await settled.promise
    await view.app.renderOnce()
    expect(view.app.captureCharFrame()).toContain("mcp: off")
    expect(fixture.writes).toEqual([true, false])
  } finally {
    release.resolve()
    view.app.renderer.destroy()
  }
}, 10_000)
