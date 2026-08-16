/** @jsxImportSource @opentui/solid */
import { BoxRenderable, ImageRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { ConfigProvider } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { landingPlaceholder, LandingComposer, LandingHero, LandingMark } from "../src/routes/home"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "./viewport"

async function renderLanding(input: { width: number; height?: number; commandList?: string | string[] }) {
  const config = createTuiResolvedConfig({
    keybinds: input.commandList === undefined ? undefined : { command_list: input.commandList },
  })
  function Harness() {
    Keymap.createLayer(() => ({ commands: [{ id: "command.palette.show", run() {} }] }))
    return (
      <box width={input.width} height={input.height ?? 16} flexDirection="column">
        <LandingHero />
        <LandingComposer>
          <text>{landingPlaceholder.normal[0]}</text>
        </LandingComposer>
      </box>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <Harness />
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width, height: input.height ?? 16 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Message YCoding…"))
  return app
}

function frame(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureCharFrame().split("\n")
}

function colorFor(app: Awaited<ReturnType<typeof testRender>>, label: string) {
  return app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(label))?.fg.toInts()
}

function findImage(node: Renderable): ImageRenderable | undefined {
  if (node instanceof ImageRenderable) return node
  return node
    .getChildren()
    .flatMap((child) => findImage(child) ?? [])
    .at(0)
}

function findText(node: Renderable, text: string): TextRenderable | undefined {
  if (node instanceof TextRenderable && node.plainText.includes(text)) return node
  return node
    .getChildren()
    .flatMap((child) => findText(child, text) ?? [])
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

describe("landing", () => {
  test("renders the native brand image with the YCoding design tokens", async () => {
    const app = await renderLanding({ width: DESIGN_VIEWPORT.width })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

    expect(String(findImage(app.renderer.root)?.source)).toEndWith("ycoding-mark-256.png")
    expect(frame(app).join("\n")).toContain("What should we build?")
    expect(frame(app).join("\n")).toContain("Describe a goal, paste an error, or press ⌃p for commands.")
    expect(colorFor(app, "What should we build?")).toEqual(theme.text.default.toInts())
    expect(colorFor(app, "Describe a goal")).toEqual(theme.text.subdued.toInts())

    app.renderer.destroy()
  })

  test("uses a terminal-correct transparent mark footprint without moving the hero copy", async () => {
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    for (const viewport of [NARROW_VIEWPORT, DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]) {
      const app = await renderLanding(viewport)
      try {
        const image = findImage(app.renderer.root)
        const lines = frame(app)
        const titleRow = lines.findIndex((line) => line.includes("What should we build?"))

        if (!image || !(image.parent instanceof BoxRenderable)) throw new Error("Landing brand image is missing")
        await image.loadPromise
        image.parent.backgroundColor = theme.background.action.destructive.default
        await app.renderOnce()
        expect(image.width).toBe(12)
        expect(image.height).toBe(6)
        expect(image.image?.info().hasAlpha).toBe(true)
        expect(image.image?.raw().data[3]).toBe(0)
        expect(titleRow).toBe(image.y + 8)
        const background = theme.background.default.toInts()
        expect([
          backgroundAt(app, image.x, image.y),
          backgroundAt(app, image.x + image.width - 1, image.y),
          backgroundAt(app, image.x, image.y + image.height - 1),
          backgroundAt(app, image.x + image.width - 1, image.y + image.height - 1),
        ]).toEqual([background, background, background, background])
        expect(lines.join("\n")).not.toContain("y. ycoding")
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("uses the live command-palette keybinding and omits the clause when unbound", async () => {
    const rebound = await renderLanding({ width: DESIGN_VIEWPORT.width, commandList: "ctrl+g" })
    const unbound = await renderLanding({ width: DESIGN_VIEWPORT.width, commandList: [] })

    expect(frame(rebound).join("\n")).toContain("press ⌃g for commands.")
    expect(frame(unbound).join("\n")).toContain("Describe a goal, paste an error.")
    expect(frame(unbound).join("\n")).not.toContain("for commands")

    rebound.renderer.destroy()
    unbound.renderer.destroy()
  })

  test("uses the static landing placeholder and an uncapped full-width composer rule", async () => {
    // Both design grids are real: 189 columns with the sidebar open, 220 without.
    const narrow = await renderLanding({ width: NARROW_VIEWPORT.width })
    const sidebar = await renderLanding({ width: DESIGN_VIEWPORT.width })
    const full = await renderLanding({ width: DESIGN_VIEWPORT_WIDE.width })

    expect(frame(narrow).join("\n")).toContain("Message YCoding…")
    expect(landingPlaceholder.normal).toEqual(["Message YCoding…"])
    expect(frame(narrow)[7]?.length).toBe(NARROW_VIEWPORT.width)
    expect(frame(sidebar)[7]?.length).toBe(DESIGN_VIEWPORT.width)
    expect(frame(full)[7]?.length).toBe(DESIGN_VIEWPORT_WIDE.width)

    narrow.renderer.destroy()
    sidebar.renderer.destroy()
    full.renderer.destroy()
  })

  test("gives the landing composition the same resting height as the session composer", async () => {
    for (const viewport of [NARROW_VIEWPORT, DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE]) {
      const config = createTuiResolvedConfig()
      const app = await testRender(
        () => (
          <TestTuiContexts>
            <ConfigProvider config={config}>
              <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                <LandingComposer>
                  <box paddingTop={1}>
                    <text>single-line composer</text>
                  </box>
                </LandingComposer>
              </ThemeProvider>
            </ConfigProvider>
          </TestTuiContexts>
        ),
        viewport,
      )
      app.renderer.start()
      await app.waitForFrame((value) => value.includes("single-line composer"))
      try {
        const sessionComposerPadding = Math.max(1, Math.min(4, Math.floor(viewport.height / 16)))
        expect(findText(app.renderer.root, "single-line composer")?.parent?.parent?.height).toBe(
          2 + sessionComposerPadding,
        )
      } finally {
        app.renderer.destroy()
      }
    }
  })

  test("hides an image-mark slot while an overlay is open", async () => {
    const app = await testRender(() => <LandingMark overlay>{<text>bitmap mark</text>}</LandingMark>)
    app.renderer.start()
    await app.waitForFrame(() => true)

    expect(app.captureCharFrame()).not.toContain("bitmap mark")

    app.renderer.destroy()
  })
})
