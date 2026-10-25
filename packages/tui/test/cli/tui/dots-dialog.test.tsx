/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { Dots } from "@ycoding-ai/schema/dots"
import { DialogDots } from "../../../src/component/dialog-dots"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const target = { profile: "fixture", dotID: "dot-1", threadID: "thread-1", generation: "generation-1", label: "Fixture Dot" }
const active = { enabled: true as const, state: "connected" as const, target, runtimeState: "unpaused" as const }

async function fixture(options: { width?: number; status?: () => Promise<Dots.Status>; mutate?: (action: "pause" | "resume", target: Dots.Target) => Promise<Dots.Status> } = {}) {
  const reads: number[] = []
  const commands: { action: "pause" | "resume"; target: Dots.Target }[] = []
  const confirmed: Dots.Target[] = []
  const completed: (Dots.Target | null)[] = []
  function Open() {
    const dialog = useDialog()
    onMount(() => { void DialogDots.show(dialog, {
      profiles: ["fixture"], load: async () => [target], confirm: async (value) => { confirmed.push(value) },
      status: async () => { reads.push(1); return options.status ? options.status() : active },
      pause: async (value) => { commands.push({ action: "pause", target: value }); return options.mutate ? options.mutate("pause", value) : { ...active, runtimeState: "paused" } },
      resume: async (value) => { commands.push({ action: "resume", target: value }); return options.mutate ? options.mutate("resume", value) : active },
    }).then((value) => completed.push(value)) })
    return <text>Composer draft retained</text>
  }
  const app = await testRender(() => <TestTuiContexts><ClipboardProvider value={{}}><ConfigProvider config={createTuiResolvedConfig()}>
    <Keymap.Provider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><ToastProvider><DialogProvider><Open /></DialogProvider></ToastProvider></ThemeProvider></Keymap.Provider>
  </ConfigProvider></ClipboardProvider></TestTuiContexts>, { width: options.width ?? 80, height: 24, kittyKeyboard: true })
  app.renderer.start()
  return { ...app, reads, commands, confirmed, completed }
}

test.each([50, 100])("Dots Pause and Resume preserve the displayed target and wait for authoritative state at width %s", async (width) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const app = await fixture({ width, mutate: async (action) => { if (action === "pause") await gate; return { ...active, runtimeState: action === "pause" ? "paused" : "unpaused" } } })
  try {
    await app.waitForFrame((frame) => frame.includes("Pause Dot"))
    expect(app.captureCharFrame()).toContain("Not paused")
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("Pause stops the Dot's autonomous runtime until Resume; Resume may continue its work and goals.")
    expect(app.captureCharFrame()).not.toContain("Stop active response")
    expect(app.reads).toHaveLength(1)
    app.mockInput.pressEnter()
    await app.waitForFrame(() => app.commands.length === 1)
    app.mockInput.pressEnter()
    expect(app.commands).toEqual([{ action: "pause", target }])
    expect(app.reads).toHaveLength(1)
    release()
    await app.waitForFrame((frame) => frame.includes("Resume Dot"))
    expect(app.captureCharFrame()).toContain("Paused")
    expect(app.reads).toHaveLength(1)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Pause Dot"))
    expect(app.commands).toEqual([{ action: "pause", target }, { action: "resume", target }])
    expect(app.reads).toHaveLength(1)
    expect(app.confirmed).toEqual([])
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Dots destination"))
    expect(app.completed).toEqual([null])
  } finally { release(); app.renderer.destroy() }
})

test("Dots failed runtime action stays open and requires Refresh without replay", async () => {
  const app = await fixture({ mutate: async () => { throw new Error("stale target") } })
  try {
    await app.waitForFrame((frame) => frame.includes("Pause Dot"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("not confirmed"))
    expect(app.captureCharFrame()).toContain("not confirmed")
    expect(app.captureCharFrame()).not.toContain("Pause Dot")
    expect(app.captureCharFrame()).not.toContain("Resume Dot")
    expect(app.commands).toEqual([{ action: "pause", target }])
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Pause Dot"))
    expect(app.reads).toHaveLength(2)
    expect(app.commands).toHaveLength(1)
  } finally { app.renderer.destroy() }
})

test("Dots status failure retains a read-only recovery action until Refresh succeeds", async () => {
  let first = true
  const app = await fixture({ status: async () => {
    if (first) { first = false; throw new Error("unavailable") }
    return active
  } })
  try {
    await app.waitForFrame((frame) => frame.includes("could not be read"))
    expect(app.captureCharFrame()).not.toContain("Pause Dot")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Pause Dot"))
    expect(app.reads).toHaveLength(2)
    expect(app.commands).toEqual([])
  } finally { app.renderer.destroy() }
})

test.each([
  { enabled: true as const, state: "connected" as const, target },
  { ...active, state: "disconnected" as const },
  { ...active, runtimeState: "unknown" as const },
])("Dots omits runtime actions for missing, disconnected or unknown state", async (status) => {
  const app = await fixture({ status: async () => status })
  try {
    await app.waitForFrame((frame) => frame.includes("Refresh status"))
    expect(app.captureCharFrame()).not.toContain("Pause Dot")
    expect(app.captureCharFrame()).not.toContain("Resume Dot")
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("Runtime state unavailable")
    if (status.state === "disconnected") {
      expect(app.captureCharFrame()).toContain("disconnected")
      expect(app.captureCharFrame()).not.toContain("Not paused")
    }
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Select ChatGPT profile"))
    expect(app.captureCharFrame()).not.toContain("Pause Dot")
    app.mockInput.pressEscape()
    expect(app.commands).toEqual([])
  } finally { app.renderer.destroy() }
})

test("closing Dots during Pause ignores the late returned state", async () => {
  let release!: () => void
  let settled = false
  const pending = new Promise<void>((resolve) => { release = resolve })
  const app = await fixture({ mutate: async () => { await pending; settled = true; return { ...active, runtimeState: "paused" } } })
  try {
    await app.waitForFrame((frame) => frame.includes("Pause Dot"))
    app.mockInput.pressEnter()
    await app.waitForFrame(() => app.commands.length === 1)
    app.mockInput.pressEscape()
    await app.waitForFrame(() => app.completed.length === 1)
    release()
    await app.waitForFrame((frame) => settled && !frame.includes("Dots destination"))
    expect(app.completed).toEqual([null])
    expect(app.commands).toEqual([{ action: "pause", target }])
    expect(app.reads).toHaveLength(1)
  } finally { release(); app.renderer.destroy() }
})

test.each(["status", "pause"] as const)("Dots closes without controls when the backend reports it disabled on %s", async (source) => {
  const disabled = { enabled: false as const, state: "disconnected" as const }
  const app = await fixture({
    status: async () => source === "status" ? disabled : active,
    mutate: async () => disabled,
  })
  try {
    if (source === "pause") {
      await app.waitForFrame((frame) => frame.includes("Pause Dot"))
      app.mockInput.pressEnter()
    }
    await app.waitForFrame((frame) => app.completed.length === 1 && !frame.includes("Dots destination"))
    expect(app.completed).toEqual([null])
    expect(app.captureCharFrame()).not.toContain("Pause Dot")
    expect(app.confirmed).toEqual([])
  } finally { app.renderer.destroy() }
})
