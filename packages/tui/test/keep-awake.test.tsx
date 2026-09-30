/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { CommandPaletteDialog } from "../src/component/command-palette"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { KeepAwakeProvider, useKeepAwake, type KeepAwakeStatus } from "../src/keep-awake"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider, useToast } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

function fakeServer(initial: KeepAwakeStatus = { state: "off" }) {
  let state = initial
  const writes: boolean[] = []
  return {
    get: async () => state,
    set: async (enabled: boolean): Promise<KeepAwakeStatus> => {
      writes.push(enabled)
      state = { state: enabled ? "on" : "off" }
      return state
    },
    change: (value: KeepAwakeStatus) => { state = value },
    writes,
  }
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!condition() && Date.now() < deadline) await Bun.sleep(20)
  expect(condition()).toBe(true)
}

async function renderKeepAwake(server: ReturnType<typeof fakeServer>) {
  let awake!: ReturnType<typeof useKeepAwake>
  let dispatch!: (id: string) => void
  let commands!: () => readonly { id?: string; title?: string }[]
  let toastMessage!: () => string | undefined
  let colors!: () => { on: [number, number, number, number]; off: [number, number, number, number]; error: [number, number, number, number] }
  function Probe() {
    awake = useKeepAwake()
    const toast = useToast()
    toastMessage = () => toast.currentToast?.message
    const keymap = Keymap.use()
    const dialog = useDialog()
    const theme = useTheme().contextual("elevated")
    colors = () => ({
      on: theme.themeV2.text.feedback.success.default.toInts(),
      off: theme.themeV2.text.subdued.toInts(),
      error: theme.themeV2.text.feedback.error.default.toInts(),
    })
    commands = Keymap.useCommands()
    Keymap.createLayer(() => ({ mode: "global", commands: [
      { id: "command.palette.show", title: "Show command palette", run: () => dialog.replace(() => <CommandPaletteDialog />) },
      { id: "test.shortcut", title: "Other command", palette: true, bind: "ctrl+o", run: () => {} },
    ] }))
    onMount(() => { dispatch = (id) => keymap.dispatch(id) })
    return <text>Awake fixture: {awake.status()?.state ?? "Checking"}</text>
  }
  const app = await testRender(() => (
    <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider><ToastProvider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><DialogProvider>
        <KeepAwakeProvider server={server}><Probe /></KeepAwakeProvider>
      </DialogProvider></ThemeProvider></ToastProvider></Keymap.Provider>
    </ConfigProvider></TestTuiContexts>
  ), { width: 80, height: 24 })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Awake fixture:"))
  return { app, status: () => awake.status(), toast: () => toastMessage(), dispatch: (id: string) => dispatch(id), commands: () => commands(), colors: () => colors() }
}

test("the one keep-awake row shows the backend state with a word and a color that agree", async () => {
  const server = fakeServer()
  const view = await renderKeepAwake(server)
  try {
    expect(view.commands().filter((command) => command.id?.startsWith("keepAwake.")).map((command) => command.title)).toEqual(["Keep machine awake"])
    view.dispatch("command.palette.show")
    await view.app.waitForFrame((frame) => frame.includes("Keep machine awake"))
    await view.app.mockInput.typeText("Keep machine awake")
    const check = async (label: string, color: [number, number, number, number]) => {
      await view.app.waitForFrame((frame) => frame.includes(`● ${label}`) && !frame.includes("Other command"))
      const row = view.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(`● ${label}`)))
      expect(row?.spans.find((span) => span.text.includes(`● ${label}`))?.fg.toInts()).toEqual(color)
    }
    await check("off", view.colors().off)
    server.change({ state: "on" })
    await Bun.sleep(2_100)
    await check("on", view.colors().on)
    server.change({ state: "unsupported", message: "Keep machine awake is available on macOS only." })
    await Bun.sleep(2_100)
    await check("unsupported", view.colors().off)
    server.change({ state: "error", message: "The sleep inhibitor stopped unexpectedly (exit code 3)." })
    await Bun.sleep(2_100)
    await check("error", view.colors().error)
  } finally {
    view.app.renderer.destroy()
  }
}, 20_000)

test("palette selection turns the backend switch on and off and explains what it does not override", async () => {
  const server = fakeServer()
  const view = await renderKeepAwake(server)
  try {
    const select = async (label: string) => {
      view.dispatch("command.palette.show")
      await view.app.waitForFrame((frame) => frame.includes("Keep machine awake"))
      await view.app.mockInput.typeText("Keep machine awake")
      await view.app.waitForFrame((frame) => frame.includes(`● ${label}`))
      view.app.mockInput.pressEnter()
      await view.app.waitForFrame((frame) => !frame.includes("Commands"))
    }
    await select("off")
    await view.app.waitForFrame((frame) => frame.includes("Awake fixture: on"))
    await until(() => view.toast() === "Idle sleep only; manual sleep and lid still apply.")
    await select("on")
    await view.app.waitForFrame((frame) => frame.includes("Awake fixture: off"))
    expect(server.writes).toEqual([true, false])
  } finally {
    view.app.renderer.destroy()
  }
}, 20_000)

test("an unsupported backend shows its reason and receives no write", async () => {
  const server = fakeServer({ state: "unsupported", message: "Keep machine awake is available on macOS only." })
  const view = await renderKeepAwake(server)
  try {
    await view.app.waitForFrame((frame) => frame.includes("Awake fixture: unsupported"))
    view.dispatch("keepAwake.toggle")
    await until(() => view.toast()?.includes("available on macOS only") === true)
    expect(server.writes).toEqual([])
    expect(view.status()?.state).toBe("unsupported")
  } finally {
    view.app.renderer.destroy()
  }
})

test("a backend error is surfaced and the next toggle retries", async () => {
  const failing = fakeServer()
  const view = await renderKeepAwake({
    ...failing,
    set: async (enabled: boolean): Promise<KeepAwakeStatus> => {
      failing.writes.push(enabled)
      return { state: "error", message: "The sleep inhibitor could not be started." }
    },
  })
  try {
    view.dispatch("keepAwake.toggle")
    await view.app.waitForFrame((frame) => frame.includes("Awake fixture: error"))
    expect(view.status()?.message).toBe("The sleep inhibitor could not be started.")
    await until(() => view.toast() === "The sleep inhibitor could not be started.")
    view.dispatch("keepAwake.toggle")
    await view.app.waitForFrame(() => failing.writes.length === 2)
    expect(failing.writes).toEqual([true, true])
  } finally {
    view.app.renderer.destroy()
  }
})

test("a rejected request reports the failure without claiming the machine is awake", async () => {
  const view = await renderKeepAwake({
    get: async () => ({ state: "off" }),
    set: async () => { throw new Error("backend unreachable") },
    change: () => {},
    writes: [],
  })
  try {
    view.dispatch("keepAwake.toggle")
    await view.app.waitForFrame((frame) => frame.includes("Awake fixture: error"))
    expect(view.status()).toEqual({ state: "error", message: "backend unreachable" })
    expect(view.toast()).toBe("backend unreachable")
  } finally {
    view.app.renderer.destroy()
  }
})

test.each(["on", "off", "error"] as const)("a delayed initial read shows Checking and writes nothing before settling %s", async (state) => {
  const initial = Promise.withResolvers<KeepAwakeStatus>()
  const server = fakeServer()
  const view = await renderKeepAwake({ ...server, get: () => initial.promise })
  try {
    expect(view.status()).toBeUndefined()
    expect(view.app.captureCharFrame()).toContain("Awake fixture: Checking")
    view.dispatch("keepAwake.toggle")
    expect(server.writes).toEqual([])
    view.dispatch("command.palette.show")
    await view.app.waitForFrame((frame) => frame.includes("Keep machine awake"))
    await view.app.mockInput.typeText("Keep machine awake")
    await view.app.waitForFrame((frame) => frame.includes("● Checking"))
    expect(view.app.captureCharFrame()).not.toContain("● off")
    const row = view.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("● Checking")))
    expect(row?.spans.find((span) => span.text.includes("● Checking"))?.fg.toInts()).toEqual(view.colors().off)
    if (state === "error") initial.reject(new Error("initial backend read failed"))
    else initial.resolve({ state })
    await view.app.waitForFrame((frame) => frame.includes(`● ${state}`))
    expect(view.status()?.state).toBe(state)
    if (state === "error") expect(view.status()?.message).toBe("initial backend read failed")
    view.dispatch("keepAwake.toggle")
    await view.app.waitForFrame((frame) => frame.includes(`● ${state === "on" ? "off" : "on"}`))
    expect(server.writes).toEqual([state !== "on"])
  } finally {
    view.app.renderer.destroy()
  }
})

test("disposing while the initial read is pending ignores its late result and prevents writes", async () => {
  const initial = Promise.withResolvers<KeepAwakeStatus>()
  const server = fakeServer()
  const view = await renderKeepAwake({ ...server, get: () => initial.promise })
  view.app.renderer.destroy()
  initial.resolve({ state: "on" })
  await initial.promise
  expect(view.status()).toBeUndefined()
  view.dispatch("keepAwake.toggle")
  expect(server.writes).toEqual([])
})
