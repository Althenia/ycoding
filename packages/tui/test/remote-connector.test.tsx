/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { CommandPaletteDialog } from "../src/component/command-palette"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { RemoteProvider, useRemote, type RemoteStatus } from "../src/remote-connector"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
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

async function awaitFrame(app: Awaited<ReturnType<typeof testRender>>, matches: (frame: string) => boolean) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (matches(app.captureCharFrame())) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(matches(app.captureCharFrame())).toBe(true)
}

async function renderRemote(server: ReturnType<typeof fakeServer>) {
  let remote!: ReturnType<typeof useRemote>
  let dispatch!: (id: string) => void
  let commands!: () => readonly { id?: string; title?: string }[]
  let colors!: () => { active: [number, number, number, number]; inactive: [number, number, number, number] }
  function Probe() {
    remote = useRemote()
    const keymap = Keymap.use()
    const dialog = useDialog()
    const theme = useTheme().contextual("elevated")
    colors = () => ({ active: theme.themeV2.text.feedback.success.default.toInts(), inactive: theme.themeV2.text.subdued.toInts() })
    commands = Keymap.useCommands()
    Keymap.createLayer(() => ({ mode: "global", commands: [
      { id: "command.palette.show", title: "Show command palette", run: () => dialog.replace(() => <CommandPaletteDialog />) },
      { id: "test.shortcut", title: "Other command", palette: true, bind: "ctrl+o", run: () => {} },
    ] }))
    onMount(() => { dispatch = (id) => keymap.dispatch(id) })
    return <text>Remote fixture: {remote.status().state}</text>
  }
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider><ToastProvider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><DialogProvider>
        <RemoteProvider server={server}><Probe /></RemoteProvider>
      </DialogProvider></ThemeProvider></ToastProvider></Keymap.Provider>
    </ConfigProvider></TestTuiContexts>
  ), { width: 80, height: 24 })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Remote fixture: off"))
  return { app, status: () => remote.status(), dispatch: (id: string) => dispatch(id), commands: () => commands(), colors: () => colors() }
}

test("the one remote row shows colored server states even when highlighted", async () => {
  const server = fakeServer()
  const view = await renderRemote(server)
  try {
    expect(view.commands().filter((command) => command.id?.startsWith("remote.")).map((command) => command.title)).toEqual(["Remote connection"])
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
    await view.app.waitForFrame((frame) => frame.includes("Remote fixture: on"))
    await select("on")
    await view.app.waitForFrame((frame) => frame.includes("Remote fixture: off"))
    expect(server.writes).toEqual([true, false])
  } finally {
    view.app.renderer.destroy()
  }
})

test("two TUIs display one server state and reflect the other's switch within a probe", async () => {
  const server = fakeServer()
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
        <Keymap.Provider><DialogProvider><RemoteProvider server={server}><Probe id="first" /></RemoteProvider></DialogProvider></Keymap.Provider>
        <Keymap.Provider><DialogProvider><RemoteProvider server={server}><Probe id="second" /></RemoteProvider></DialogProvider></Keymap.Provider>
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
