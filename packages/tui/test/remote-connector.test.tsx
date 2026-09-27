/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { onMount } from "solid-js"
import { TestTuiContexts } from "./fixture/tui-environment"
import { Keymap } from "../src/context/keymap"
import { ToastProvider } from "../src/ui/toast"
import { DialogProvider } from "../src/ui/dialog"
import { ThemeProvider } from "../src/context/theme"
import { useTheme } from "../src/context/theme"
import { ConfigProvider } from "../src/config"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { CommandPaletteDialog } from "../src/component/command-palette"
import { useDialog } from "../src/ui/dialog"
import { RemoteProvider, useRemote, type RemoteStatus } from "../src/remote-connector"

function makePort() {
  let status: RemoteStatus = { state: "off" }
  const listeners = new Set<(next: RemoteStatus) => void>()
  const emit = (next: RemoteStatus) => { status = next; listeners.forEach((listener) => listener(next)) }
  return {
    notice: "All backend Sessions are available to the owner.",
    status: () => status,
    subscribe(listener: (next: RemoteStatus) => void) { listeners.add(listener); listener(status); return () => listeners.delete(listener) },
    start: async () => { emit({ state: "connecting", notice: "All backend Sessions are available to the owner." }); emit({ state: "on" }) },
    stop: async () => emit({ state: "off" }),
    emit,
  }
}

async function renderRemote(
  state: string,
  create: () => Promise<ReturnType<typeof makePort>>,
  inspect?: () => Promise<RemoteStatus>,
) {
  let dispatch!: (id: string) => void
  let commands!: () => readonly { id?: string; palette?: boolean; title?: string }[]
  let action!: ReturnType<typeof useRemote>
  let colors!: () => { active: [number, number, number, number]; inactive: [number, number, number, number] }
  function Probe() {
    action = useRemote()
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
    return <text>Remote fixture</text>
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider><ToastProvider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><DialogProvider>
        <RemoteProvider create={create} inspect={inspect}><Probe /></RemoteProvider>
      </DialogProvider></ThemeProvider></ToastProvider></Keymap.Provider>
      </ConfigProvider>
    </TestTuiContexts>
  ), { width: 80, height: 24 })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Remote fixture"))
  return { app, dispatch: (id: string) => dispatch(id), action: () => action, commands: () => commands(), colors: () => colors() }
}

async function waitForStatus(view: Awaited<ReturnType<typeof renderRemote>>, state: RemoteStatus["state"]) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && view.action().status().state !== state) await Bun.sleep(10)
  expect(view.action().status().state).toBe(state)
}

test("one remote palette toggle calls the injected port and leaves another process alone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  const port = makePort()
  const view = await renderRemote(directory, async () => port)
  try {
    expect(view.commands().filter((command) => command.id?.startsWith("remote.")).map((command) => [command.title, command.palette])).toEqual([
      ["Remote connection", true],
    ])
    view.dispatch("remote.toggle")
    await waitForStatus(view, "on")
    port.emit({ state: "connecting" })
    await waitForStatus(view, "connecting")
    port.emit({ state: "error", message: "Relay rejected the device" })
    await waitForStatus(view, "error")
    expect(view.action().status().message).toBe("Relay rejected the device")
    port.emit({ state: "other-process", message: "Remote is on in another process" })
    await waitForStatus(view, "other-process")
    view.dispatch("remote.toggle")
    await waitForStatus(view, "other-process")
    expect(view.action().status().message).toBe("Remote is on in another process")
    port.emit({ state: "on" })
    view.dispatch("remote.toggle")
    await waitForStatus(view, "off")
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("remote-on preference reconnects at the next TUI launch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  let creations = 0
  const create = async () => { creations++; return makePort() }
  try {
    const first = await renderRemote(directory, create)
    first.dispatch("remote.toggle")
    await waitForStatus(first, "on")
    first.app.renderer.destroy()
    const second = await renderRemote(directory, create)
    try {
      await waitForStatus(second, "on")
      expect(creations).toBe(2)
      second.dispatch("remote.toggle")
      await waitForStatus(second, "off")
    } finally {
      second.app.renderer.destroy()
    }
    const third = await renderRemote(directory, create)
    try {
      await third.app.renderOnce()
      await waitForStatus(third, "off")
      expect(creations).toBe(2)
    } finally {
      third.app.renderer.destroy()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("disconnect supersedes a connector that is still being created", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  const ready = Promise.withResolvers<ReturnType<typeof makePort>>()
  const port = makePort()
  let starts = 0
  const originalStart = port.start
  port.start = async () => { starts++; await originalStart() }
  const view = await renderRemote(directory, () => ready.promise)
  try {
    view.dispatch("remote.toggle")
    await waitForStatus(view, "connecting")
    await view.action().disconnect()
    ready.resolve(port)
    await waitForStatus(view, "off")
    await view.app.renderOnce()
    expect(starts).toBe(0)
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("an unenrolled connect action exposes the enrollment command instead of failing silently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  const view = await renderRemote(directory, async () => {
    throw new Error("This machine is not enrolled; run `ycoding remote enroll <enrollmentID>` first")
  })
  try {
    view.dispatch("remote.toggle")
    await waitForStatus(view, "error")
    expect(view.action().status().message).toContain("ycoding remote enroll <enrollmentID>")
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("shows a CLI-owned connector even when this TUI's preference is off", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  let creations = 0
  const view = await renderRemote(directory, async () => { creations++; return makePort() }, async () => ({
    state: "other-process", message: "Remote is on in another process",
  }))
  try {
    await waitForStatus(view, "other-process")
    view.dispatch("remote.toggle")
    expect(view.action().status().message).toContain("another process")
    expect(creations).toBe(0)
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("the highlighted remote palette row colors its right-side state across all connector states", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  const port = makePort()
  const view = await renderRemote(directory, async () => port)
  try {
    view.dispatch("command.palette.show")
    await view.app.waitForFrame((frame) => frame.includes("Remote connection"))
    await view.app.mockInput.typeText("Remote connection")
    await view.app.waitForFrame((frame) => frame.includes("● off") && !frame.includes("Other command"))
    const assertState = async (state: RemoteStatus, label: string, color: [number, number, number, number]) => {
      if (state.state !== "off") port.emit(state)
      await view.app.waitForFrame((frame) => frame.includes(`● ${label}`))
      const row = view.app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(`● ${label}`)) && line.spans.some((span) => span.text.includes("Remote connection")))
      expect(row?.spans.find((span) => span.text.includes(`● ${label}`))?.fg.toInts()).toEqual(color)
    }
    await assertState({ state: "off" }, "off", view.colors().inactive)
    view.dispatch("remote.toggle")
    await waitForStatus(view, "on")
    await assertState({ state: "on" }, "on", view.colors().active)
    await assertState({ state: "other-process", message: "Remote is on in another process" }, "on elsewhere", view.colors().active)
    await assertState({ state: "connecting" }, "connecting", view.colors().inactive)
    await assertState({ state: "error", message: "Relay rejected the device" }, "error", view.colors().inactive)
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("selecting the remote palette row toggles the connector in both directions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  const port = makePort()
  let starts = 0
  let stops = 0
  const start = port.start
  const stop = port.stop
  port.start = async () => { starts++; await start() }
  port.stop = async () => { stops++; await stop() }
  const view = await renderRemote(directory, async () => port)
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
    await waitForStatus(view, "on")
    expect(starts).toBe(1)
    await select("on")
    await waitForStatus(view, "off")
    expect(stops).toBe(1)
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
