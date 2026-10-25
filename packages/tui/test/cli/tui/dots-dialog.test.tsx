/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
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

async function fixture(options: {
  width?: number
  height?: number
  profiles?: readonly string[]
  targets?: readonly Dots.Target[]
  load?: () => Promise<readonly Dots.Target[]>
  confirm?: (target: Dots.Target) => Promise<void>
  status?: () => Promise<Dots.Status>
  mutate?: (action: "pause" | "resume", target: Dots.Target) => Promise<Dots.Status>
} = {}) {
  const reads: number[] = []
  const commands: { action: "pause" | "resume"; target: Dots.Target }[] = []
  const confirmed: Dots.Target[] = []
  const completed: (Dots.Target | null)[] = []
  let editor!: TextareaRenderable
  function Open() {
    const dialog = useDialog()
    onMount(() => {
      editor.setText("Composer draft retained")
      editor.focus()
      void DialogDots.show(dialog, {
      profiles: options.profiles ?? ["fixture"],
      load: options.load ?? (async () => options.targets ?? [target]),
      confirm: async (value) => { confirmed.push(value); await options.confirm?.(value) },
      status: async () => { reads.push(1); return options.status ? options.status() : active },
      pause: async (value) => { commands.push({ action: "pause", target: value }); return options.mutate ? options.mutate("pause", value) : { ...active, runtimeState: "paused" } },
      resume: async (value) => { commands.push({ action: "resume", target: value }); return options.mutate ? options.mutate("resume", value) : active },
    }).then((value) => completed.push(value)) })
    return <textarea ref={(value: TextareaRenderable) => { editor = value }} width="100%" height={2} />
  }
  const app = await testRender(() => <TestTuiContexts><ClipboardProvider value={{}}><ConfigProvider config={createTuiResolvedConfig()}>
    <Keymap.Provider><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><ToastProvider><DialogProvider><Open /></DialogProvider></ToastProvider></ThemeProvider></Keymap.Provider>
  </ConfigProvider></ClipboardProvider></TestTuiContexts>, { width: options.width ?? 80, height: options.height ?? 24, kittyKeyboard: true })
  app.renderer.start()
  return { ...app, reads, commands, confirmed, completed, get editor() { return editor } }
}

const primary = {
  profile: "fixture",
  dotID: `dot_${"d".repeat(66)}`,
  threadID: `thread_${"t".repeat(64)}`,
  generation: "generation-primary",
  label: "Primary Dot conversation",
}
const unbound = async (): Promise<Dots.Status> => ({ enabled: true, state: "disconnected" })

test.each(["confirm", "cancel", "failure"] as const)("L10 optional display name preserves selection, canonical target and draft on %s", async (outcome) => {
  const other = { ...primary, dotID: "dot_other", threadID: "thread_other", label: "Another Dot" }
  const app = await fixture({
    status: unbound, targets: [primary, other],
    confirm: outcome === "failure" ? async () => { throw new Error("Synthetic name confirmation failed") } : undefined,
  })
  try {
    await app.waitForFrame((frame) => frame.includes("ChatGPT profile"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Select Dot and conversation"))
    await app.mockInput.typeText("Primary")
    await app.waitForFrame((frame) => !frame.includes("Another Dot"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Confirm Dots destination"))
    app.mockInput.pressArrow("down")
    await app.waitForFrame((frame) => frame.includes("Edit display name"))
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable && app.renderer.currentFocusedEditor !== app.editor)
    const nameEditor = app.renderer.currentFocusedEditor
    if (!(nameEditor instanceof TextareaRenderable)) throw new Error("Expected the Dot name input")
    expect(nameEditor.plainText).toBe(primary.label)
    nameEditor.setText("")
    await app.mockInput.typeText("  V  ")
    expect(app.editor.plainText).toBe("Composer draft retained")
    expect(app.confirmed).toEqual([])
    expect(app.commands).toEqual([])
    if (outcome === "cancel") {
      app.mockInput.pressEscape()
      await app.waitFor(() => app.completed.length === 1 && app.editor.focused)
      expect(app.completed).toEqual([null])
      expect(app.confirmed).toEqual([])
      return
    }
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Confirm V"))
    expect(app.captureCharFrame().replace(/\s+/g, "")).toContain(primary.dotID)
    expect(app.confirmed).toEqual([])
    app.mockInput.pressEnter()
    if (outcome === "failure") {
      await app.waitForFrame((frame) => frame.includes("Could not resolve the Dots destination"))
      expect(app.completed).toEqual([])
      app.mockInput.pressEscape()
      await app.waitFor(() => app.editor.focused)
    }
    if (outcome === "confirm") await app.waitFor(() => app.completed.length === 1 && app.editor.focused)
    expect(app.confirmed).toEqual([{ ...primary, label: "V" }])
    expect(app.commands).toEqual([])
    expect(app.editor.plainText).toBe("Composer draft retained")
  } finally { app.renderer.destroy() }
})

test("L10 a bound display name can be edited only through a new explicit confirmation", async () => {
  const named = { ...target, label: "V" }
  const app = await fixture({ status: async () => ({ ...active, target: named }) })
  try {
    await app.waitForFrame((frame) => frame.includes("Dots destination · V"))
    expect(app.captureCharFrame()).toContain("Edit display name")
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable && app.renderer.currentFocusedEditor !== app.editor)
    const nameEditor = app.renderer.currentFocusedEditor
    if (!(nameEditor instanceof TextareaRenderable)) throw new Error("Expected the Dot name input")
    expect(nameEditor.plainText).toBe("V")
    nameEditor.setText("Vega")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Confirm Vega"))
    expect(app.confirmed).toEqual([])
    app.mockInput.pressEnter()
    await app.waitFor(() => app.completed.length === 1 && app.editor.focused)
    expect(app.confirmed).toEqual([{ ...named, label: "Vega" }])
    expect(app.commands).toEqual([])
    expect(app.editor.plainText).toBe("Composer draft retained")
  } finally { app.renderer.destroy() }
})

test.each([{ width: 80, height: 24 }, { width: 120, height: 36 }])(
  "primary destination keeps its readable title, full secondary IDs and action hints at $width x $height",
  async ({ width, height }) => {
    const app = await fixture({ width, height, status: unbound, targets: [primary] })
    try {
      await app.waitForFrame((frame) => frame.includes("ChatGPT profile"))
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("Select Dot and conversation"))
      const frame = app.captureCharFrame()
      expect(frame).toContain(primary.label)
      expect(frame).not.toContain("Search")
      expect(frame).toContain("Dot ID:")
      expect(frame).toContain("Conversation:")
      expect(frame.replace(/\s+/g, "")).toContain(primary.dotID)
      expect(frame.replace(/\s+/g, "")).toContain(primary.threadID)
      const title = frame.split("\n").find((line) => line.includes(primary.label))!
      expect(title).not.toContain("dot_")
      expect(title).not.toContain("thread_")
      expect(frame.replace(/\s+/g, " ")).toMatch(/(?:enter|return) select/)
      expect(frame.replace(/\s+/g, " ")).toContain("esc cancel")
      expect(app.confirmed).toEqual([])
      expect(app.commands).toEqual([])
      console.info(`Dots destination ${width}x${height}\n${frame}`)
    } finally { app.renderer.destroy() }
  },
)

test.each(["cancel", "confirm"] as const)("destination %s preserves the composer and never runs a runtime action", async (action) => {
  const app = await fixture({ status: unbound, targets: [primary] })
  try {
    await app.waitForFrame((frame) => frame.includes("ChatGPT profile"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Select Dot and conversation"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Confirm Dots destination"))
    expect(app.captureCharFrame()).not.toContain("Search")
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toMatch(/(?:enter|return) confirm only/)
    expect(app.confirmed).toEqual([])
    if (action === "cancel") app.mockInput.pressEscape()
    if (action === "confirm") app.mockInput.pressEnter()
    await app.waitForFrame(() => app.completed.length === 1 && app.editor.focused)
    expect(app.completed).toEqual([action === "confirm" ? primary : null])
    expect(app.confirmed).toEqual(action === "confirm" ? [primary] : [])
    expect(app.commands).toEqual([])
    expect(app.editor.plainText).toBe("Composer draft retained")
  } finally { app.renderer.destroy() }
})

test("profile search and keyboard navigation keep selection separate from confirmation", async () => {
  const app = await fixture({ status: unbound, profiles: ["first", "fixture"], targets: [primary] })
  try {
    await app.waitForFrame((frame) => frame.includes("ChatGPT profile") && frame.includes("Search"))
    await app.mockInput.typeText("fixture")
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Select Dot and conversation"))
    expect(app.captureCharFrame()).not.toContain("Search")
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Confirm Dots destination"))
    expect(app.confirmed).toEqual([])
    app.mockInput.pressEscape()
    await app.waitForFrame(() => app.completed.length === 1 && app.editor.focused)
    expect(app.completed).toEqual([null])
    expect(app.editor.plainText).toBe("Composer draft retained")
    expect(app.commands).toEqual([])
  } finally { app.renderer.destroy() }
})

test("pending destination confirmation stays locked and ignores late settlement after Escape", async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const app = await fixture({ status: unbound, confirm: () => pending })
  try {
    await app.waitForFrame((frame) => frame.includes("ChatGPT profile"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Select Dot and conversation"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Confirm Dots destination"))
    app.mockInput.pressEnter()
    await app.waitForFrame(() => app.confirmed.length === 1)
    app.mockInput.pressEnter()
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    app.mockInput.pressEscape()
    await app.waitForFrame(() => app.completed.length === 1 && app.editor.focused)
    release()
    await app.waitForFrame((frame) => !frame.includes("Confirm Dots destination"))
    expect(app.confirmed).toEqual([target])
    expect(app.completed).toEqual([null])
    expect(app.commands).toEqual([])
    expect(app.editor.plainText).toBe("Composer draft retained")
  } finally { release(); app.renderer.destroy() }
})

test.each(["load", "confirm"] as const)("destination %s failure retains its error copy and draft", async (stage) => {
  const app = await fixture({
    status: unbound,
    load: stage === "load" ? async () => { throw new Error("synthetic unavailable") } : undefined,
    confirm: stage === "confirm" ? async () => { throw new Error("synthetic unavailable") } : undefined,
  })
  try {
    await app.waitForFrame((frame) => frame.includes("ChatGPT profile"))
    app.mockInput.pressEnter()
    if (stage === "confirm") {
      await app.waitForFrame((frame) => frame.includes("Select Dot and conversation"))
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("Confirm Dots destination"))
      app.mockInput.pressEnter()
    }
    await app.waitForFrame((frame) => frame.includes("Could not resolve"))
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain("Could not resolve the Dots destination. Keep the draft and select again.")
    expect(app.editor.plainText).toBe("Composer draft retained")
    expect(app.completed).toEqual([])
    expect(app.commands).toEqual([])
  } finally { app.renderer.destroy() }
})

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
