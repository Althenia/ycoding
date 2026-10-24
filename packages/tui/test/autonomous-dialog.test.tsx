/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import type { SessionAutonomyView } from "@ycoding-ai/client"
import { DialogAutonomous } from "../src/component/dialog-autonomous"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider } from "../src/ui/toast"
import { autonomyView } from "./fixture/autonomy"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

type Changes = Partial<Pick<SessionAutonomyView, "permissions" | "guardrails" | "answers">>

const selected = [121, 184, 255, 255]

async function mount(input: {
  initial: SessionAutonomyView | undefined
  effective?: (state: Changes) => Partial<SessionAutonomyView["effective"]>
  save?: (changes: Changes) => Promise<void>
  size?: { width: number; height: number }
}) {
  const saved: Changes[] = []
  const [view, setView] = createSignal(input.initial)
  const save = async (changes: Changes) => {
    saved.push(changes)
    await input.save?.(changes)
    const current = view()
    if (!current) return
    setView(autonomyView({ ...current, ...changes }, input.effective?.(changes)))
  }

  function Fixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogAutonomous autonomy={view} save={save} />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <RouteProvider initialRoute={{ type: "home" }}>
                <ToastProvider>
                  <DialogProvider>
                    <Fixture />
                  </DialogProvider>
                  <Toast />
                </ToastProvider>
              </RouteProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    input.size ?? { width: 120, height: 36 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Autonomous"))
  const rows = () => app.captureCharFrame().split("\n")
  const row = (title: string) => rows().find((line) => line.includes(title)) ?? ""
  return { app, saved, row, rows }
}

test("renders the Autonomous title, three ordered rows, right-aligned mode words, and every key hint", async () => {
  const { app, row, rows } = await mount({ initial: autonomyView({ permissions: "auto", answers: "yolo" }) })
  try {
    const lines = rows()
    const titles = ["Permissions", "Guardrails", "Answers"].map((title) => lines.findIndex((line) => line.includes(title)))
    expect(titles.every((index) => index >= 0)).toBe(true)
    expect(titles).toEqual([titles[0]!, titles[0]! + 1, titles[0]! + 2])
    const panel = panelOf(app.renderer.root)
    for (const [title, word] of [["Permissions", "Auto"], ["Guardrails", "Manual"], ["Answers", "YOLO"]] as const) {
      const line = row(title)
      expect(line.trimEnd().endsWith(word)).toBe(true)
      expect(line.indexOf(word)).toBeGreaterThan(panel.x + panel.width - 20)
      expect(line.indexOf(word)).toBeLessThan(panel.x + panel.width)
    }
    const frame = app.captureCharFrame()
    for (const hint of ["←", "→", "cycle", "1 all Manual", "2 all YOLO", "3 all Auto"])
      expect(frame).toContain(hint)
    expect(frame).not.toContain("Search")
  } finally {
    app.renderer.destroy()
  }
})

test("the selected row is one full-width primary band that follows up and down", async () => {
  const { app } = await mount({ initial: autonomyView() })
  try {
    await app.renderOnce()
    expect(bandedTitles(app)).toEqual(["Permissions"])
    app.mockInput.pressArrow("down")
    await app.renderOnce()
    expect(bandedTitles(app)).toEqual(["Guardrails"])
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    await app.renderOnce()
    expect(bandedTitles(app)).toEqual(["Permissions"])
    app.mockInput.pressArrow("up")
    await app.renderOnce()
    expect(bandedTitles(app)).toEqual(["Answers"])
  } finally {
    app.renderer.destroy()
  }
})

test("right and left cycle the selected row through Manual, YOLO, Auto and wrap", async () => {
  const { app, saved, row } = await mount({ initial: autonomyView() })
  try {
    app.mockInput.pressArrow("right")
    await app.waitForFrame(() => row("Permissions").trimEnd().endsWith("YOLO"))
    app.mockInput.pressArrow("right")
    await app.waitForFrame(() => row("Permissions").trimEnd().endsWith("Auto"))
    app.mockInput.pressArrow("right")
    await app.waitForFrame(() => row("Permissions").trimEnd().endsWith("Manual"))
    app.mockInput.pressArrow("left")
    await app.waitForFrame(() => row("Permissions").trimEnd().endsWith("Auto"))
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("left")
    await app.waitForFrame(() => row("Guardrails").trimEnd().endsWith("Auto"))
    expect(saved).toEqual([
      { permissions: "yolo" },
      { permissions: "auto" },
      { permissions: "manual" },
      { permissions: "auto" },
      { guardrails: "auto" },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("1, 2, and 3 set all three categories to Manual, YOLO, or Auto in one request", async () => {
  const { app, saved, row } = await mount({ initial: autonomyView({ permissions: "auto", answers: "yolo" }) })
  const all = (word: string) => ["Permissions", "Guardrails", "Answers"].every((title) => row(title).trimEnd().endsWith(word))
  try {
    app.mockInput.pressKey("2")
    await app.waitForFrame(() => all("YOLO"))
    app.mockInput.pressKey("3")
    await app.waitForFrame(() => all("Auto"))
    app.mockInput.pressKey("1")
    await app.waitForFrame(() => all("Manual"))
    expect(saved).toEqual([
      { permissions: "yolo", guardrails: "yolo", answers: "yolo" },
      { permissions: "auto", guardrails: "auto", answers: "auto" },
      { permissions: "manual", guardrails: "manual", answers: "manual" },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("digits are key commands, never filter text, and arrows move once per press", async () => {
  const { app, saved, row } = await mount({ initial: autonomyView() })
  try {
    app.mockInput.pressKey("2")
    await app.waitFor(() => saved.length === 1)
    await app.waitForFrame(() => row("Permissions").includes("YOLO"))
    expect(app.captureCharFrame()).not.toContain("Search")
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("right")
    await app.waitFor(() => saved.length === 2)
    expect(saved[1]).toEqual({ guardrails: "auto" })
  } finally {
    app.renderer.destroy()
  }
})

test("a failed save reports the error and keeps the displayed mode", async () => {
  const { app, saved, row } = await mount({
    initial: autonomyView(),
    save: async () => {
      throw new Error("autonomy rejected")
    },
  })
  try {
    app.mockInput.pressArrow("right")
    await app.waitForFrame((frame) => frame.includes("autonomy rejected"))
    expect(saved).toEqual([{ permissions: "yolo" }])
    expect(row("Permissions").trimEnd().endsWith("Manual")).toBe(true)
    expect(app.captureCharFrame()).not.toMatch(/Success|saved|updated/i)
    app.mockInput.pressArrow("right")
    await app.waitFor(() => saved.length === 2)
    expect(saved[1]).toEqual({ permissions: "yolo" })
  } finally {
    app.renderer.destroy()
  }
})

test("keys are ignored while a save is in flight", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { app, saved, row } = await mount({ initial: autonomyView(), save: () => gate })
  try {
    app.mockInput.pressArrow("right")
    await app.waitFor(() => saved.length === 1)
    app.mockInput.pressArrow("right")
    app.mockInput.pressKey("3")
    await app.renderOnce()
    expect(saved).toHaveLength(1)
    release()
    await app.waitForFrame(() => row("Permissions").trimEnd().endsWith("YOLO"))
    app.mockInput.pressArrow("right")
    await app.waitFor(() => saved.length === 2)
    expect(saved[1]).toEqual({ permissions: "auto" })
  } finally {
    app.renderer.destroy()
  }
})

test("an inherited effective mode shows its source and labels the differing local mode", async () => {
  const { app, row, rows } = await mount({
    initial: autonomyView(
      { permissions: "manual", guardrails: "yolo" },
      { permissions: "auto", inherited: { permissions: "ses_parent_source" } },
    ),
  })
  try {
    expect(row("Permissions").trimEnd().endsWith("Auto · inherited")).toBe(true)
    expect(row("Permissions")).not.toContain("Manual")
    expect(row("Guardrails")).not.toContain("inherited")
    const lines = rows()
    const detail = lines.findIndex((line) => line.includes("Inherited from ses_parent_source"))
    expect(detail).toBe(lines.findIndex((line) => line.includes("Permissions")) + 1)
    expect(lines[detail]).toContain("this Session: Manual")
    expect(row("Guardrails").trimEnd().endsWith("YOLO")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("a matching inherited source still shows its source Session", async () => {
  const { app, row, rows } = await mount({
    initial: autonomyView({ guardrails: "yolo" }, { inherited: { guardrails: "ses_root", permissions: "ses_root" } }),
  })
  try {
    expect(row("Guardrails").trimEnd().endsWith("YOLO · inherited")).toBe(true)
    expect(row("Permissions").trimEnd().endsWith("Manual · inherited")).toBe(true)
    const lines = rows()
    expect(lines.some((line) => line.includes("Inherited from ses_root · this Session: YOLO"))).toBe(true)
    expect(lines.some((line) => line.includes("Inherited from ses_root · this Session: Manual"))).toBe(true)
    expect(row("Answers").trimEnd().endsWith("Manual")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("cycling an inherited row sets only the local mode and keeps the inherited outcome visible", async () => {
  const { app, saved, row } = await mount({
    initial: autonomyView({ permissions: "manual" }, { permissions: "auto", inherited: { permissions: "ses_parent_source" } }),
    effective: () => ({ permissions: "auto", inherited: { permissions: "ses_parent_source" } }),
  })
  try {
    app.mockInput.pressArrow("right")
    await app.waitFor(() => saved.length === 1)
    expect(saved).toEqual([{ permissions: "yolo" }])
    await app.waitForFrame((frame) => frame.includes("this Session: YOLO"))
    expect(row("Permissions").trimEnd().endsWith("Auto · inherited")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("an unloaded read shows unknown rows and writes nothing", async () => {
  const { app, saved, row } = await mount({ initial: undefined })
  try {
    for (const title of ["Permissions", "Guardrails", "Answers"]) {
      expect(row(title).trimEnd().endsWith("unknown")).toBe(true)
      expect(row(title)).not.toContain("Manual")
    }
    app.mockInput.pressArrow("right")
    app.mockInput.pressKey("2")
    app.mockInput.pressKey("3")
    await app.renderOnce()
    expect(saved).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

function bandedTitles(app: Awaited<ReturnType<typeof mount>>["app"]) {
  const panel = panelOf(app.renderer.root)
  return app
    .captureSpans()
    .lines.flatMap((line) => {
      const cells = line.spans.flatMap((span) =>
        Array.from({ length: span.width }, (_, index) => ({ text: span.text[index] ?? " ", bg: span.bg?.toInts() })),
      )
      const inPanel = cells.slice(panel.x, panel.x + panel.width)
      if (!inPanel.every((cell) => cell.bg?.every((value, index) => value === selected[index]))) return []
      const text = inPanel.map((cell) => cell.text).join("")
      return ["Permissions", "Guardrails", "Answers"].filter((title) => text.includes(title))
    })
}

function panelOf(root: Renderable) {
  const surface = RGBA.fromHex("#1D2128").toInts()
  const panel = descendants(root).find(
    (item): item is BoxRenderable =>
      item instanceof BoxRenderable && item.backgroundColor.toInts().every((value, index) => value === surface[index]),
  )
  if (!panel) throw new Error("Dialog panel not found")
  return panel
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}
