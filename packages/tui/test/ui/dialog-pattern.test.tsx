/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount, type JSX } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogAlert } from "../../src/ui/dialog-alert"
import { DialogConfirm } from "../../src/ui/dialog-confirm"
import { DialogSelect } from "../../src/ui/dialog-select"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { RouteProvider } from "../../src/context/route"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("clamps the 98-column dialog panel across responsive widths", async () => {
  for (const size of ["medium", "large", "xlarge"] as const) {
    const panel = await renderDialogPanel({ width: 80, height: 24 }, size)
    expect(panel.width).toBe(80)
  }

  for (const size of ["medium", "large", "xlarge"] as const) {
    const panel = await renderDialogPanel({ width: 120, height: 30 }, size)
    expect(panel.width).toBe(98)
    expect(panel.x).toBe(11)
  }

  const boundary = await renderDialogPanel({ width: 100, height: 30 }, "large")
  expect(boundary.width).toBe(98)
  expect(boundary.x).toBe(1)
})

test("renders select, confirm, and alert dialogs on the shared panel cell grid", async () => {
  const colors = {
    surface: [29, 33, 40, 255],
    selected: [121, 184, 255, 255],
  }
  const select = await renderDialogView(
    { width: 189, height: 40 },
    () => (
      <DialogSelect
        title="Select"
        options={[
          { title: "Option one", value: "one", category: "Section" },
          { title: "Option two", value: "two", category: "Section" },
          { title: "Option three", value: "three", category: "Section" },
        ]}
      />
    ),
    "Option three",
  )
  expect(select.panel.width).toBe(98)
  expect(select.panel.height).toBe(14)
  expectRelativePosition(select, "Select", 3, 2)
  expectRelativePosition(select, "esc", 91, 2)
  expectRelativePosition(select, "Search", 6, 5)
  expectRelativePosition(select, "Section", 3, 8)
  expectRelativePosition(select, "Option one", 6, 10)
  expectRelativePosition(select, "Option two", 6, 11)
  expectRelativePosition(select, "Option three", 6, 12)
  expectFullPanelBand(select, "Option one", colors.selected)
  expectOneRowSelection(select, "Option one", colors)
  expectSearchFocusMark(select, colors)

  const confirm = await renderDialogView(
    { width: 189, height: 40 },
    () => (
      <DialogConfirm
        title="Delete session?"
        message="Provider cache audit and its 1,204 archived messages will be permanently removed."
        label="Delete"
      />
    ),
    "Delete session?",
  )
  expect(confirm.panel.width).toBe(98)
  expect(confirm.panel.height).toBe(14)
  expectRelativePosition(confirm, "Delete session?", 3, 2)
  expectRelativePosition(confirm, "esc", 91, 2)
  expectRelativePosition(confirm, "Search", 6, 5)
  expectRelativePosition(confirm, "Provider cache audit and its 1,204 archived messages", 3, 8)
  expectRelativePosition(confirm, "will be permanently removed.", 3, 10)
  expectRelativePosition(confirm, "Cancel", 6, 12)
  expectRelativePosition(confirm, "Delete", 6, 13)
  expectFullPanelBand(confirm, "Delete", colors.selected)
  expectOneRowSelection(confirm, "Delete", colors)
  expectSearchFocusMark(confirm, colors)

  const alert = await renderDialogView(
    { width: 189, height: 40 },
    () => (
      <DialogAlert
        title="Session delete failed"
        message="The durable store rejected the delete. The session is unchanged."
      />
    ),
    "Session delete failed",
  )
  expect(alert.panel.width).toBe(98)
  expect(alert.panel.height).toBe(13)
  expectRelativePosition(alert, "Session delete failed", 3, 2)
  expectRelativePosition(alert, "esc", 91, 2)
  expectRelativePosition(alert, "Search", 6, 5)
  expectRelativePosition(alert, "The durable store rejected the delete.", 3, 8)
  expectRelativePosition(alert, "The session is unchanged.", 3, 10)
  expectRelativePosition(alert, "Dismiss", 6, 12)
  expectFullPanelBand(alert, "Dismiss", colors.selected)
  expectOneRowSelection(alert, "Dismiss", colors)
})

test("fills selected dialog bands across the compact 80-column panel", async () => {
  const colors = [121, 184, 255, 255]
  const dialogs: [() => JSX.Element, string, string][] = [
    [() => <DialogSelect title="Select" options={[{ title: "Option", value: "option" }]} />, "Option", "Option"],
    [() => <DialogConfirm title="Confirm" message="Confirm the operation." label="Confirm" />, "Confirm", "Confirm"],
    [() => <DialogAlert title="Alert" message="The operation failed." />, "Alert", "Dismiss"],
  ]

  for (const [view, settle, selected] of dialogs) {
    const snapshot = await renderDialogView({ width: 80, height: 24 }, view, settle)
    expect(snapshot.panel.width).toBe(80)
    expectFullPanelBand(snapshot, selected, colors)
    expectOneRowSelection(snapshot, selected, { surface: [29, 33, 40, 255], selected: colors })
  }
})

test("renders a full dialog panel with its selected model", async () => {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect
          title="Select model"
          options={[
            { title: "Claude Opus 5", value: "opus" },
            { title: "Claude Sonnet 5", value: "sonnet" },
          ]}
        />
      )),
    )
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <RouteProvider initialRoute={{ type: "home" }}><ToastProvider>
                <DialogProvider>
                  <DialogFixture />
                </DialogProvider>
              </ToastProvider></RouteProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Select model"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Select model")
    expect(frame).toContain("Claude Opus 5")
    expect(frame).toContain("Claude Sonnet 5")
  } finally {
    app.renderer.destroy()
  }
})

test("renders the variant glyph and label in toast titles", async () => {
  function ToastFixture() {
    const toast = useToast()
    onMount(() => toast.show({ variant: "success", title: "Copied", message: "Copied to clipboard" }))
    return <Toast />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <RouteProvider initialRoute={{ type: "home" }}><ToastProvider>
              <ToastFixture />
            </ToastProvider></RouteProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Copied to clipboard"))

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Success")
    expect(frame).toContain("Copied to clipboard")
  } finally {
    app.renderer.destroy()
  }
})

async function renderDialogPanel(
  dimensions: { width: number; height: number },
  size: "medium" | "large" | "xlarge",
) {
  const result = await renderDialogView(dimensions, () => <text>Dialog width fixture</text>, "Dialog width fixture", size)
  return result.panel
}

async function renderDialogView(
  dimensions: { width: number; height: number },
  view: () => JSX.Element,
  settle: string,
  size?: "medium" | "large" | "xlarge",
) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => {
      dialog.replace(view)
      if (size) dialog.setSize(size)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <RouteProvider initialRoute={{ type: "home" }}><ToastProvider>
                <DialogProvider>
                  <DialogFixture />
                </DialogProvider>
              </ToastProvider></RouteProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    dimensions,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(settle))

  try {
    const panel = descendants(app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable &&
        item.backgroundColor.toInts().every((value, index) => value === RGBA.fromHex("#1D2128").toInts()[index]),
    )
    if (!panel) throw new Error("Dialog panel not found")
    return {
      frame: app.captureCharFrame(),
      panel: { width: panel.width, height: panel.height, x: panel.x, y: panel.y },
      lines: app.captureSpans().lines.map((line) => line.spans.map(snapshotSpan)),
    }
  } finally {
    app.renderer.destroy()
  }
}

function expectRelativePosition(
  snapshot: Awaited<ReturnType<typeof renderDialogView>>,
  text: string,
  column: number,
  row: number,
) {
  const lines = snapshot.frame.split("\n")
  const terminalRow = snapshot.panel.y + row
  expect(lines[terminalRow].indexOf(text) - snapshot.panel.x).toBe(column)
}

function expectFullPanelBand(snapshot: Awaited<ReturnType<typeof renderDialogView>>, text: string, color: number[]) {
  const band = cells(requireLine(snapshot, text)).slice(snapshot.panel.x, snapshot.panel.x + snapshot.panel.width)
  expect(band.filter((cell) => sameColor(cell.bg, color))).toHaveLength(snapshot.panel.width)
}

function expectOneRowSelection(
  snapshot: Awaited<ReturnType<typeof renderDialogView>>,
  text: string,
  colors: { surface: number[]; selected: number[] },
) {
  const line = requireLine(snapshot, text)
  expect(snapshot.lines.filter((row) => panelCells(snapshot, row).every((cell) => sameColor(cell.bg, colors.selected)))).toHaveLength(1)
  expect(panelCells(snapshot, line).every((cell) => sameColor(cell.bg, colors.selected))).toBe(true)
}

function expectSearchFocusMark(
  snapshot: Awaited<ReturnType<typeof renderDialogView>>,
  colors: { surface: number[]; selected: number[] },
) {
  const line = requireLine(snapshot, "Search")
  const searchColumn = cells(line).findIndex((cell) => cell.text === "S")
  expect(searchColumn).toBe(snapshot.panel.x + 6)
  expect(sameColor(cells(line)[searchColumn]?.bg, colors.selected)).toBe(true)
  expect(cells(line).slice(searchColumn + 1, snapshot.panel.x + snapshot.panel.width).every((cell) => sameColor(cell.bg, colors.surface))).toBe(true)
}

function requireLine(snapshot: Awaited<ReturnType<typeof renderDialogView>>, text: string) {
  const line = snapshot.lines.findLast((line) => line.map((span) => span.text).join("").includes(text))
  if (!line) throw new Error(`Missing rendered line: ${text}`)
  return line
}

function cells(line: { text: string; width: number; bg?: number[] }[]) {
  return line.flatMap((span) => Array.from({ length: span.width }, (_, index) => ({ text: span.text[index] ?? " ", bg: span.bg })))
}

function panelCells(
  snapshot: Awaited<ReturnType<typeof renderDialogView>>,
  line: { text: string; width: number; bg?: number[] }[],
) {
  return cells(line).slice(snapshot.panel.x, snapshot.panel.x + snapshot.panel.width)
}

function sameColor(actual: number[] | undefined, expected: number[]) {
  return actual?.every((value, index) => value === expected[index]) ?? false
}

function snapshotSpan(span: { text: string; width: number; bg?: { toInts(): number[] } }) {
  return { text: span.text, width: span.width, bg: span.bg?.toInts() }
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}
