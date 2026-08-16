/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { CommandPaletteDialog } from "../src/component/command-palette"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap, type KeymapCommand } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, directory } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "./viewport"

test("renders command-palette groups, selection, and live keymap hints", async () => {
  const colors = {
    info: [121, 184, 255, 255],
    selected: [121, 184, 255, 255],
    selectedText: [15, 17, 21, 255],
  }
  const design = await renderCommandPalette("ctrl+x n", DESIGN_VIEWPORT, 1)
  const wide = await renderCommandPalette("ctrl+x n", DESIGN_VIEWPORT_WIDE, 1)
  const narrow = await renderCommandPalette("ctrl+x n", NARROW_VIEWPORT, 1)
  const rebound = await renderCommandPalette("ctrl+z", DESIGN_VIEWPORT)
  const extraSuggested = await renderCommandPalette("ctrl+x n", DESIGN_VIEWPORT, 0, true)
  const model = requireSpan(design.spans, "Switch model")
  const modelKeybind = requireSpan(design.spans, "⌃t")
  const suggested = requireSpan(design.spans, "Suggested")
  const session = requireSpan(design.spans, "Session")

  expect(design.frame).toContain("Commands")
  expect(design.frame).toContain("esc")
  expect(suggestedRows(design.frame)).toEqual(["Switch session ⌃x n", "Switch model ⌃t", "Open settings"])
  expect(groupRows(extraSuggested.frame, "Session", "Agent")).toContain("New session")
  expect(groupRows(extraSuggested.frame, "Session", "Agent")).toContain("Share session")
  expect(commandRows(design.frame, "Switch model")).toHaveLength(1)
  expect(commandRows(design.frame, "Switch session")).toHaveLength(1)
  expect(commandRows(extraSuggested.frame, "New session")).toHaveLength(1)
  expect(commandRows(extraSuggested.frame, "Share session")).toHaveLength(1)
  expect(suggested?.fg).toEqual(colors.info)
  expect(session?.fg).toEqual(colors.info)
  expect(model?.fg).toEqual(colors.selectedText)
  expect(model?.bg).toEqual(colors.selected)
  expect(modelKeybind?.fg).toEqual(colors.selectedText)
  expect(modelKeybind?.bg).toEqual(colors.selected)
  expectSelectedBand(design, colors.selected)
  expect(design.frame.split("\n").find((line) => line.includes("Open settings"))?.trim()).toBe("Open settings")
  expect(rebound.frame).toContain("⌃z")
  expect(rebound.frame).not.toContain("⌃x n")
  expect(design.frame).not.toContain("ctrl+")
  expect(rebound.frame).not.toContain("ctrl+")
  expectRightAligned(design, "⌃t", "⌃x n")
  expectRightAligned(wide, "⌃t", "⌃x n")
  expectRightAligned(narrow, "⌃t", "⌃x n")
  expectReferenceGeometry(design, { width: 98, height: 34 }, colors.selected)
  expectResponsiveGeometry(narrow, NARROW_VIEWPORT)
})

async function renderCommandPalette(
  binding: string,
  viewport: { width: number; height: number },
  selectionMoves = 0,
  includeExtraSuggested = false,
) {
  const events = createEventStream()
  const calls = createFetch(() => undefined, events)

  function Commands() {
    const extraSuggested: KeymapCommand[] = includeExtraSuggested
      ? [{ id: "test.share", title: "Share session", group: "Session", palette: true, suggested: true, run: () => {} }]
      : []
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "test.session", bind: binding, title: "Switch session", group: "Suggested", palette: true, suggested: true, run: () => {} },
        { id: "test.model", bind: "ctrl+t", title: "Switch model", group: "Suggested", palette: true, suggested: true, run: () => {} },
        { id: "test.settings", bind: false, title: "Open settings", group: "Suggested", palette: true, run: () => {} },
        { id: "test.new", title: "New session", group: "Session", palette: true, suggested: true, run: () => {} },
        ...extraSuggested,
        { id: "test.editor", bind: "ctrl+x e", title: "Open editor", group: "Session", palette: true, run: () => {} },
        { id: "test.move", bind: "ctrl+x u", title: "Move session", group: "Session", palette: true, run: () => {} },
        { id: "test.agent", bind: "ctrl+x a", title: "Switch agent", group: "Agent", palette: true, run: () => {} },
        { id: "test.variant", bind: "ctrl+t", title: "Variant cycle", group: "Agent", palette: true, run: () => {} },
        { id: "test.status", bind: "ctrl+x s", title: "View status", group: "System", palette: true, run: () => {} },
        { id: "test.hidden", title: "Hidden command", group: "System", palette: true, run: () => {} },
      ],
    }))
    return null
  }

  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <CommandPaletteDialog />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ClientProvider api={createApi(calls.fetch)}>
              <Keymap.Provider>
                <Commands />
                <ToastProvider>
                  <DialogProvider>
                    <DialogFixture />
                  </DialogProvider>
                </ToastProvider>
              </Keymap.Provider>
            </ClientProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Switch session"))
  await new Promise((resolve) => setTimeout(resolve, 10))
  for (let index = 0; index < selectionMoves; index++) app.mockInput.pressKey("n", { ctrl: true })
  if (selectionMoves > 0) await new Promise((resolve) => setTimeout(resolve, 50))

  try {
    const panelColor = [29, 33, 40, 255]
    const panel = descendants(app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable && item.backgroundColor.toInts().every((value, index) => value === panelColor[index]),
    )
    if (!panel) throw new Error("Command palette panel not found")
    return {
      frame: app.captureCharFrame(),
      panel: { height: panel.height, width: panel.width, x: panel.x, y: panel.y },
      lines: app.captureSpans().lines.map((line) => line.spans.map(snapshotSpan)),
      spans: app.captureSpans().lines.flatMap((line) => line.spans).map(snapshotSpan),
    }
  } finally {
    app.renderer.destroy()
  }
}

function expectReferenceGeometry(
  snapshot: Awaited<ReturnType<typeof renderCommandPalette>>,
  panel: { width: number; height: number },
  selectionColor: number[],
) {
  expect(snapshot.panel.width).toBe(panel.width)
  expect(snapshot.panel.height).toBe(panel.height)
  expectRelativePosition(snapshot, "Commands", 3, 2)
  expectRelativePosition(snapshot, "Search", 6, 5)
  expectRelativePosition(snapshot, "Suggested", 3, 8)
  expectRelativePosition(snapshot, "Switch session", 6, 10)
  expectRelativePosition(snapshot, "Switch model", 6, 11)
  expectRelativePosition(snapshot, "Open settings", 6, 12)
  expectRelativePosition(snapshot, "Session", 3, 14)
  expectRelativePosition(snapshot, "New session", 6, 16)
  expectRelativePosition(snapshot, "Open editor", 6, 17)
  expectRelativePosition(snapshot, "Move session", 6, 18)
  expectRelativePosition(snapshot, "Agent", 3, 20)
  expectRelativePosition(snapshot, "Switch agent", 6, 22)
  expectRelativePosition(snapshot, "Variant cycle", 6, 23)
  expectRelativePosition(snapshot, "System", 3, 25)
  expectRelativePosition(snapshot, "View status", 6, 27)
  expectRelativeRightEdge(snapshot, "esc", 4)
  expectRelativeRightEdge(snapshot, "⌃t", 4)
  expectSelectedFill(snapshot, 11, panel.width, selectionColor)
}

function expectResponsiveGeometry(
  snapshot: Awaited<ReturnType<typeof renderCommandPalette>>,
  viewport: { width: number; height: number },
) {
  expect(snapshot.panel.width).toBe(viewport.width)
  expect(snapshot.panel.height).toBe(viewport.height)
  expect(snapshot.panel.x).toBe(0)
  expect(snapshot.panel.y).toBe(0)
  expect(snapshot.frame).not.toContain("Hidden command")
}

function expectRelativePosition(snapshot: Awaited<ReturnType<typeof renderCommandPalette>>, text: string, x: number, y: number) {
  const row = snapshot.frame.split("\n").findIndex((line) => line.includes(text))
  const line = snapshot.frame.split("\n")[row]
  expect(row - snapshot.panel.y).toBe(y)
  expect(line.indexOf(text) - snapshot.panel.x).toBe(x)
}

function expectRelativeRightEdge(snapshot: Awaited<ReturnType<typeof renderCommandPalette>>, text: string, right: number) {
  const row = snapshot.frame.split("\n").find((line) => line.includes(text))
  expect(snapshot.panel.x + snapshot.panel.width - ((row?.lastIndexOf(text) ?? -text.length) + text.length)).toBe(right)
}

function expectSelectedFill(snapshot: Awaited<ReturnType<typeof renderCommandPalette>>, row: number, width: number, color: number[]) {
  const line = snapshot.lines[snapshot.panel.y + row]
  const cells = line.flatMap((span, index) =>
    Array.from({ length: span.width }, (_, offset) => ({
      bg: span.bg,
      x: line.slice(0, index).reduce((total, item) => total + item.width, 0) + offset,
    })),
  )
  const expected = cells.slice(snapshot.panel.x, snapshot.panel.x + width)
  expect(expected.every((cell) => cell.bg?.every((value, index) => value === color[index]))).toBe(true)
  expect(cells[snapshot.panel.x + width]?.bg?.every((value, index) => value === color[index])).toBe(false)
}

function expectRightAligned(snapshot: Awaited<ReturnType<typeof renderCommandPalette>>, short: string, long: string) {
  const shortEdge = rightEdge(snapshot.frame, short)
  const longEdge = rightEdge(snapshot.frame, long)
  const escapeEdge = rightEdge(snapshot.frame, "esc")

  expect(longEdge).toBe(snapshot.panel.x + snapshot.panel.width - 4)
  expect(shortEdge).toBe(snapshot.panel.x + snapshot.panel.width - 4)
  expect(escapeEdge).toBe(snapshot.panel.x + snapshot.panel.width - 4)
}

function expectSelectedBand(snapshot: Awaited<ReturnType<typeof renderCommandPalette>>, color: number[]) {
  const line = snapshot.lines.find((spans) => spans.some((span) => span.text === "Switch model"))
  if (!line) throw new Error("Missing selected command row")
  expect(snapshot.lines.filter((row) => isPanelFill(snapshot, row, color))).toHaveLength(1)
  expect(isPanelFill(snapshot, line, color)).toBe(true)
}

function isPanelFill(
  snapshot: Awaited<ReturnType<typeof renderCommandPalette>>,
  line: Awaited<ReturnType<typeof renderCommandPalette>>["lines"][number],
  color: number[],
) {
  const cells = line.flatMap((span, index) =>
    Array.from({ length: span.width }, (_, offset) => ({ bg: span.bg, x: line.slice(0, index).reduce((total, item) => total + item.width, 0) + offset })),
  )
  const panel = cells.filter((cell) => cell.x >= snapshot.panel.x && cell.x < snapshot.panel.x + snapshot.panel.width)
  return panel.length === snapshot.panel.width && panel.every((cell) => cell.bg?.every((value, index) => value === color[index]))
}

function rightEdge(frame: string, value: string) {
  const line = frame.split("\n").find((item) => item.includes(value))
  return (line?.lastIndexOf(value) ?? -value.length) + value.length
}

function commandRows(frame: string, title: string) {
  return frame.split("\n").filter((line) => line.includes(title))
}

function suggestedRows(frame: string) {
  return groupRows(frame, "Suggested", "Session")
}

function groupRows(frame: string, heading: string, nextHeading: string) {
  const lines = frame.split("\n").map((line) => line.trim())
  const start = lines.findIndex((line) => line === heading)
  const end = lines.findIndex((line, index) => index > start && line === nextHeading)
  return lines.slice(start + 1, end).filter(Boolean).map((line) => line.replace(/\s+/g, " "))
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}

function snapshotSpan(span: { text: string; width: number; fg?: { toInts(): number[] }; bg?: { toInts(): number[] } }) {
  return { text: span.text, width: span.width, fg: span.fg?.toInts(), bg: span.bg?.toInts() }
}

function requireSpan(spans: Awaited<ReturnType<typeof renderCommandPalette>>["spans"], text: string) {
  const span = spans.find((item) => item.text.trimEnd().startsWith(text))
  if (!span) throw new Error(`Missing rendered span: ${text}`)
  return span
}
