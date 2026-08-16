/** @jsxImportSource @opentui/solid */
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

async function renderLanding(input: { width: number; commandList?: string | string[] }) {
  const config = createTuiResolvedConfig({
    keybinds: input.commandList === undefined ? undefined : { command_list: input.commandList },
  })
  function Harness() {
    Keymap.createLayer(() => ({ commands: [{ id: "command.palette.show", run() {} }] }))
    return (
      <box width={input.width} flexDirection="column">
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
    { width: input.width, height: 12 },
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

describe("landing", () => {
  test("renders the text hero in the YCoding design tokens", async () => {
    const app = await renderLanding({ width: DESIGN_VIEWPORT.width })
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

    expect(frame(app).join("\n")).toContain("y. ycoding")
    expect(frame(app).join("\n")).toContain("What should we build?")
    expect(frame(app).join("\n")).toContain("Describe a goal, paste an error, or press ⌃p for commands.")
    expect(colorFor(app, "y. ycoding")).toEqual(theme.text.feedback.success.default.toInts())
    expect(colorFor(app, "What should we build?")).toEqual(theme.text.default.toInts())
    expect(colorFor(app, "Describe a goal")).toEqual(theme.text.subdued.toInts())

    app.renderer.destroy()
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

  test("hides an image-mark slot while an overlay is open", async () => {
    const app = await testRender(() => <LandingMark overlay>{<text>bitmap mark</text>}</LandingMark>)
    app.renderer.start()
    await app.waitForFrame(() => true)

    expect(app.captureCharFrame()).not.toContain("bitmap mark")

    app.renderer.destroy()
  })
})
