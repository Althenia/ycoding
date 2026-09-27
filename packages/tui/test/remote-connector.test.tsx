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
import { ConfigProvider } from "../src/config"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { RemoteProvider, RemoteStatusLine, useRemote, type RemoteStatus } from "../src/remote-connector"

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
  function Probe() {
    action = useRemote()
    const keymap = Keymap.use()
    commands = Keymap.useCommands()
    onMount(() => { dispatch = (id) => keymap.dispatch(id) })
    return <RemoteStatusLine />
  }
  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <ConfigProvider config={createTuiResolvedConfig()}>
      <Keymap.Provider><ToastProvider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><DialogProvider>
        <RemoteProvider create={create} inspect={inspect}><Probe /></RemoteProvider>
      </DialogProvider></ThemeProvider></ToastProvider></Keymap.Provider>
      </ConfigProvider>
    </TestTuiContexts>
  ), { width: 24, height: 3 })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("remote off") || frame.includes("remote on"))
  return { app, dispatch: (id: string) => dispatch(id), action: () => action, commands: () => commands() }
}

test("remote status renders every state and palette actions call the injected port", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  const port = makePort()
  const view = await renderRemote(directory, async () => port)
  try {
    expect(view.commands().filter((command) => command.id?.startsWith("remote.")).map((command) => [command.title, command.palette])).toEqual([
      ["Connect remote", true], ["Disconnect remote", true],
    ])
    view.dispatch("remote.connect")
    await view.app.waitForFrame((frame) => frame.includes("remote on"))
    port.emit({ state: "connecting" })
    await view.app.waitForFrame((frame) => frame.includes("remote connecting"))
    port.emit({ state: "error", message: "Relay rejected the device" })
    await view.app.waitForFrame((frame) => frame.includes("remote error"))
    expect(view.action().status().message).toBe("Relay rejected the device")
    port.emit({ state: "other-process", message: "Remote is on in another process" })
    await view.app.waitForFrame((frame) => frame.includes("remote on elsewhere"))
    view.dispatch("remote.disconnect")
    await view.app.waitForFrame((frame) => frame.includes("remote off"))
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
    first.dispatch("remote.connect")
    await first.app.waitForFrame((frame) => frame.includes("remote on"))
    first.app.renderer.destroy()
    const second = await renderRemote(directory, create)
    try {
      await second.app.waitForFrame((frame) => frame.includes("remote on"))
      expect(creations).toBe(2)
      second.dispatch("remote.disconnect")
      await second.app.waitForFrame((frame) => frame.includes("remote off"))
    } finally {
      second.app.renderer.destroy()
    }
    const third = await renderRemote(directory, create)
    try {
      await third.app.renderOnce()
      expect(third.app.captureCharFrame()).toContain("remote off")
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
    view.dispatch("remote.connect")
    await view.app.waitForFrame((frame) => frame.includes("remote connecting"))
    view.dispatch("remote.disconnect")
    ready.resolve(port)
    await view.app.waitForFrame((frame) => frame.includes("remote off"))
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
    view.dispatch("remote.connect")
    await view.app.waitForFrame((frame) => frame.includes("remote error"))
    expect(view.action().status().message).toContain("ycoding remote enroll <enrollmentID>")
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("shows a CLI-owned connector even when this TUI's preference is off", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-tui-remote-"))
  const view = await renderRemote(directory, async () => makePort(), async () => ({
    state: "other-process", message: "Remote is on in another process",
  }))
  try {
    await view.app.waitForFrame((frame) => frame.includes("remote on elsewhere"))
    expect(view.action().status().message).toContain("another process")
  } finally {
    view.app.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})
