/** @jsxImportSource @opentui/solid */
import { ImageRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

function findImage(node: Renderable): ImageRenderable | undefined {
  if (node instanceof ImageRenderable) return node
  return node
    .getChildren()
    .flatMap((child) => findImage(child) ?? [])
    .at(0)
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
            <BrandMark />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 40, height: 12 })
  app.renderer.start()
  await app.waitFor(() => findImage(app.renderer.root) !== undefined)

  const image = findImage(app.renderer.root)!
  await image.loadPromise
  expect(image.image?.width).toBeGreaterThan(0)
  expect(image.image?.height).toBeGreaterThan(0)

  await app.renderOnce()
  expect(app.captureCharFrame().trim()).not.toBe("")
  app.renderer.destroy()
})
