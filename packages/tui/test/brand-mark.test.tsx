/** @jsxImportSource @opentui/solid */
import { BoxRenderable, ImageRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"

function findImage(node: Renderable): ImageRenderable | undefined {
  if (node instanceof ImageRenderable) return node
  return node
    .getChildren()
    .flatMap((child) => findImage(child) ?? [])
    .at(0)
}

function backgroundAt(app: Awaited<ReturnType<typeof testRender>>, x: number, y: number) {
  const spans = app.captureSpans().lines[y]?.spans ?? []
  let column = 0
  for (const span of spans) {
    if (x >= column && x < column + span.width) return span.bg.toInts()
    column += span.width
  }
  return undefined
}

test("renders the bitmap brand mark through a native terminal image", async () => {
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { BrandMark }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
    import("../src/component/logo"),
  ])

  function Harness() {
    return (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box width={40} height={12}>
              <BrandMark />
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 40, height: 12 })
  app.renderer.start()
  await app.waitForFrame(() => true)

  const image = findImage(app.renderer.root)!
  expect(String(image.source)).toEndWith("ycoding-mark-256.png")
  await image.loadPromise
  expect(image.image?.width).toBeGreaterThan(0)
  expect(image.image?.height).toBeGreaterThan(0)
  expect(image.image?.info().hasAlpha).toBe(true)
  expect(image.image?.raw().data[3]).toBe(0)

  await app.renderOnce()
  expect(app.captureCharFrame().trim()).not.toBe("")
  app.renderer.destroy()
})

test("owns the transparent image plane for landing and header surfaces under both themes", async () => {
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { BrandMark }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
    import("../src/component/logo"),
  ])

  for (const mode of ["dark", "light"] as const) {
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, mode, "ycoding")
    for (const surface of [
      { width: 12, height: 6, background: theme.background.default },
      { width: 6, height: 1, background: theme.background.chrome },
    ]) {
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <ConfigProvider config={config}>
              <ThemeProvider mode={mode} source={{ discover: () => Promise.resolve({}) }}>
                <box width={40} height={12} backgroundColor={theme.background.action.destructive.default}>
                  <box width={40} height={12} backgroundColor={surface.background}>
                    <BrandMark width={surface.width} height={surface.height} />
                  </box>
                </box>
              </ThemeProvider>
            </ConfigProvider>
          </TestTuiContexts>
        ),
        { width: 40, height: 12 },
      )
      app.renderer.start()
      await app.waitForFrame(() => true)
      const image = findImage(app.renderer.root)!
      await image.loadPromise
      if (!(image.parent instanceof BoxRenderable)) throw new Error("BrandMark image wrapper is missing")
      image.parent.backgroundColor = theme.background.action.destructive.default
      await app.renderOnce()

      const expected = surface.background.toInts()
      expect(theme.background.action.destructive.default.toInts()).not.toEqual(expected)
      expect([
        backgroundAt(app, image.x, image.y),
        backgroundAt(app, image.x + image.width - 1, image.y),
        backgroundAt(app, image.x, image.y + image.height - 1),
        backgroundAt(app, image.x + image.width - 1, image.y + image.height - 1),
      ]).toEqual([expected, expected, expected, expected])
      app.renderer.destroy()
    }
  }
})

test("falls back to the terminal mark after a native image error", async () => {
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }, { BrandMark }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
    import("../src/component/logo"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <box width={40} height={12}>
              <BrandMark />
            </box>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 40, height: 12 },
  )
  app.renderer.start()
  await app.waitForFrame(() => true)
  const image = findImage(app.renderer.root)!
  image.source = "/missing-ycoding-mark.png"
  await app.waitForFrame((frame) => frame.includes("█   █"))

  expect(findImage(app.renderer.root)).toBeUndefined()
  expect(app.captureCharFrame()).toContain("█   █")
  app.renderer.destroy()
})
