/** @jsxImportSource @opentui/solid */
import { BoxRenderable, Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { CommandPaletteDialog } from "../src/component/command-palette"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, directory } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "./viewport"

test("renders command-palette groups, selection, and live keymap hints", async () => {
  const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
  const design = await renderCommandPalette("ctrl+x n", DESIGN_VIEWPORT)
  const wide = await renderCommandPalette("ctrl+x n", DESIGN_VIEWPORT_WIDE)
  const narrow = await renderCommandPalette("ctrl+x n", NARROW_VIEWPORT)
  const rebound = await renderCommandPalette("ctrl+z", DESIGN_VIEWPORT)
  const model = requireSpan(design.spans, "Switch model")
  const modelKeybind = requireSpan(design.spans, "ctrl+t")
  const suggested = requireSpan(design.spans, "Suggested")
  const session = requireSpan(design.spans, "Session")

  expect(design.frame).toContain("Commands")
  expect(design.frame).toContain("esc")
  expect(commandRows(design.frame, "Switch model")).toHaveLength(1)
  expect(commandRows(design.frame, "Switch session")).toHaveLength(1)
  expect(suggested?.fg).toEqual(theme.text.feedback.info.default.toInts())
  expect(session?.fg).toEqual(theme.text.feedback.info.default.toInts())
  expect(model?.fg).toEqual(theme.text.action.primary.focused.toInts())
  expect(model?.bg).toEqual(theme.background.action.primary.focused.toInts())
  expect(modelKeybind?.fg).toEqual(theme.text.action.primary.focused.toInts())
  expect(modelKeybind?.bg).toEqual(theme.background.action.primary.focused.toInts())
  expectSelectedBand(design, theme.background.action.primary.focused.toInts())
  expect(design.frame.split("\n").find((line) => line.includes("Open settings"))?.trim()).toBe("Open settings")
  expect(rebound.frame).toContain("ctrl+z")
  expect(rebound.frame).not.toContain("ctrl+x n")
  expectRightAligned(design, "ctrl+t", "ctrl+x n")
  expectRightAligned(wide, "ctrl+t", "ctrl+x n")
  expectRightAligned(narrow, "ctrl+t", "ctrl+x n")
})

async function renderCommandPalette(
  binding: string,
  viewport: { width: number; height: number },
) {
  const events = createEventStream()
  const calls = createFetch(() => undefined, events)

  function Commands() {
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "test.model", bind: "ctrl+t", title: "Switch model", group: "Suggested", palette: true, suggested: true, run: () => {} },
        { id: "test.session", bind: binding, title: "Switch session", group: "Suggested", palette: true, suggested: true, run: () => {} },
        { id: "test.settings", bind: false, title: "Open settings", group: "Suggested", palette: true, run: () => {} },
        { id: "test.new", title: "New session", group: "Session", palette: true, run: () => {} },
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

  try {
    const panelColor = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding").background.surface.offset.toInts()
    const panel = descendants(app.renderer.root).find(
      (item): item is BoxRenderable =>
        item instanceof BoxRenderable && item.backgroundColor.toInts().every((value, index) => value === panelColor[index]),
    )
    if (!panel) throw new Error("Command palette panel not found")
    return {
      frame: app.captureCharFrame(),
      panel: { width: panel.width, x: panel.x },
      lines: app.captureSpans().lines.map((line) => line.spans.map(snapshotSpan)),
      spans: app.captureSpans().lines.flatMap((line) => line.spans).map(snapshotSpan),
    }
  } finally {
    app.renderer.destroy()
  }
}

function expectRightAligned(snapshot: Awaited<ReturnType<typeof renderCommandPalette>>, short: string, long: string) {
  const shortEdge = rightEdge(snapshot.frame, short)
  const longEdge = rightEdge(snapshot.frame, long)
  const escapeEdge = rightEdge(snapshot.frame, "esc")

  expect(shortEdge).toBe(longEdge)
  expect(escapeEdge).toBe(snapshot.panel.x + snapshot.panel.width - 4)
}

function expectSelectedBand(snapshot: Awaited<ReturnType<typeof renderCommandPalette>>, color: number[]) {
  const line = snapshot.lines.find((spans) => spans.some((span) => span.text === "Switch model"))
  const cells = line?.flatMap((span, index) =>
    Array.from({ length: span.width }, (_, offset) => ({ bg: span.bg, x: line.slice(0, index).reduce((total, item) => total + item.width, 0) + offset })),
  )

  expect(cells?.filter((cell) => cell.x >= snapshot.panel.x && cell.x < snapshot.panel.x + snapshot.panel.width).every((cell) => cell.bg?.every((value, index) => value === color[index]))).toBe(true)
}

function rightEdge(frame: string, value: string) {
  const line = frame.split("\n").find((item) => item.includes(value))
  return (line?.lastIndexOf(value) ?? -value.length) + value.length
}

function commandRows(frame: string, title: string) {
  return frame.split("\n").filter((line) => line.includes(title))
}

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child, ...descendants(child)])
}

function snapshotSpan(span: { text: string; width: number; fg?: { toInts(): number[] }; bg?: { toInts(): number[] } }) {
  return { text: span.text, width: span.width, fg: span.fg?.toInts(), bg: span.bg?.toInts() }
}

function requireSpan(spans: Awaited<ReturnType<typeof renderCommandPalette>>["spans"], text: string) {
  const span = spans.find((item) => item.text === text)
  if (!span) throw new Error(`Missing rendered span: ${text}`)
  return span
}
