/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable, RGBA, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { TuiKeybind } from "../../../src/config/keybind"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountPrompt(input: {
  root: string
  keybinds: Partial<TuiKeybind.Keybinds>
  onConfirm: (value: string) => void
  title?: string
  value?: string
  description?: string
  viewport?: { width: number; height: number }
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })

  const [
    { DialogProvider, useDialog },
    { DialogPrompt },
    { ThemeProvider },
    { ConfigProvider },
    { ToastProvider },
    { Keymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-prompt"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/context/keymap"),
  ])

  function Harness() {
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: input.keybinds,
      leader: { timeout: 1000 },
    })

    function Prompt() {
      const dialog = useDialog()
      onCleanup(Keymap.use().mode.push("modal"))
      onMount(() =>
        dialog.replace(() => (
          <DialogPrompt
            title={input.title ?? "Rename Session"}
            value={input.value ?? "draft"}
            description={input.description ? () => <text>{input.description}</text> : undefined}
            onConfirm={input.onConfirm}
          />
        )),
      )
      return null
    }

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <ConfigProvider config={resolvedConfig}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <Prompt />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { ...input.viewport, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(input.title ?? "Rename Session"))
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("renders prompt on the shared panel cell grid with the live confirm shortcut", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: { "dialog.prompt.submit": "return" },
    title: "Enter a value",
    value: "Search",
    description: "…",
    viewport: { width: 189, height: 40 },
    onConfirm: () => {},
  })

  try {
    await prompt.app.waitForFrame((frame) => frame.includes("Enter confirm"))
    const panel = descendants(prompt.app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable &&
        item.backgroundColor.toInts().every((value, index) => value === RGBA.fromHex("#1D2128").toInts()[index]),
    )
    if (!panel) throw new Error("Dialog panel not found")
    const frame = prompt.app.captureCharFrame().split("\n")

    expect(panel.width).toBe(98)
    expect(panel.height).toBe(12)
    expectPromptPosition(frame, panel, "Enter a value", 3, 2)
    expectPromptPosition(frame, panel, "esc", 91, 2)
    expectPromptPosition(frame, panel, "Search", 6, 5)
    expectPromptPosition(frame, panel, "…", 6, 7)
    expectPromptPosition(frame, panel, "Enter confirm", 6, 10)
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt submit wins when return is also input newline", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {
      input_submit: "super+return",
      input_newline: "return,shift+return,alt+return,ctrl+j",
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressEnter()

    expect(confirmed).toEqual(["draft"])
    expect(textarea.plainText).toBe("draft")
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt submit can be rebound separately from input submit", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {
      input_submit: "return",
      "dialog.prompt.submit": "ctrl+y",
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual([])
    expect(textarea.plainText).toBe("draft")

    prompt.app.mockInput.pressKey("y", { ctrl: true })

    expect(confirmed).toEqual(["draft"])
  } finally {
    await prompt.cleanup()
  }
})

function expectPromptPosition(frame: string[], panel: BoxRenderable, text: string, column: number, row: number) {
  expect(frame[panel.y + row].indexOf(text) - panel.x).toBe(column)
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}
