/** @jsxImportSource @opentui/solid */
import { TextAttributes, type BoxRenderable, type TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect } from "solid-js"
import { Autocomplete, type AutocompleteRef } from "../src/component/prompt/autocomplete"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { EditorContextProvider } from "../src/context/editor"
import { Keymap } from "../src/context/keymap"
import { LocationProvider, useLocation } from "../src/context/location"
import { ThemeProvider } from "../src/context/theme"
import { FrecencyProvider } from "../src/prompt/frecency"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"
import { createApi, createEventStream, createFetch, directory } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE, NARROW_VIEWPORT } from "./viewport"

function SyncLocation() {
  const data = useData()
  const location = useLocation()
  createEffect(() => location.set(data.location.default()))
  return null
}

function Commands() {
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: "test.model", title: "Model", description: "switch the active model", slash: { name: "model" }, run: () => {} },
      { id: "test.mode", title: "Mode", description: "normal \u00b7 yolo \u00b7 goal", slash: { name: "mode" }, run: () => {} },
      { id: "test.compact", title: "Compact", description: "compact the transcript", slash: { name: "compact" }, run: () => {} },
      { id: "test.mcp", title: "MCP", description: "manage MCP servers", slash: { name: "mcp" }, run: () => {} },
    ],
  }))
  return null
}

async function renderAutocomplete(viewport: typeof DESIGN_VIEWPORT) {
  const events = createEventStream()
  const calls = createFetch(() => undefined, events)
  let textarea!: TextareaRenderable
  let anchor!: BoxRenderable
  let autocomplete!: AutocompleteRef
  const app = await testRender(
    () => (
      <TestTuiContexts directory={directory}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ClientProvider api={createApi(calls.fetch)}>
              <DataProvider>
                <LocationProvider>
                  <SyncLocation />
                  <EditorContextProvider>
                    <FrecencyProvider>
                      <Keymap.Provider>
                        <Commands />
                        <box width={viewport.width} height={viewport.height} flexDirection="row">
                          <box width="74%" height="100%" flexDirection="column">
                            <box flexGrow={1} />
                            <box ref={(value: BoxRenderable) => (anchor = value)} height={1}>
                              <textarea ref={(value: TextareaRenderable) => (textarea = value)} width="100%" />
                            </box>
                            <text>ready</text>
                            <Autocomplete
                              value="/mo"
                              anchor={() => anchor}
                              input={() => textarea}
                              ref={(value) => (autocomplete = value)}
                              setPrompt={() => {}}
                              setExtmark={() => {}}
                              fileStyleId={0}
                              agentStyleId={0}
                              skillStyleId={0}
                              promptPartTypeId={() => 0}
                            />
                          </box>
                          <box flexGrow={1} />
                        </box>
                      </Keymap.Provider>
                    </FrecencyProvider>
                  </EditorContextProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("ready"))
  textarea.insertText("/mo")
  autocomplete.onInput("/mo")
  await app.waitForFrame((frame) => frame.includes("/model"))
  return app
}

function expectGeometry(frame: string[], viewport: typeof DESIGN_VIEWPORT) {
  const header = frame.find((line) => line.includes("/ COMMANDS"))!
  const description = frame.find((line) => line.includes("switch the active model"))!
  const left = header.indexOf("┃")
  const right = header.lastIndexOf("┃")
  const count = header.indexOf("2 of 4")

  const width = right - left + 1
  const innerLeft = left + 2
  const innerWidth = width - 4

  expect(Math.abs(width / viewport.width - 0.74)).toBeLessThan(0.01)
  expect(count + "2 of 4".length).toBe(right - 1)
  expect(Math.abs((description.indexOf("switch the active model") - innerLeft) / innerWidth - 244 / 992)).toBeLessThanOrEqual(
    1 / innerWidth,
  )
}

test("renders the command autocomplete design frame", async () => {
  const app = await renderAutocomplete(DESIGN_VIEWPORT)
  try {
    const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
    const frame = app.captureCharFrame().split("\n")
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const selectedLabel = spans.find(
      (span) =>
        span.text.startsWith("/") &&
        span.bg.toInts().every((value, index) => value === theme.background.action.primary.focused.toInts()[index]),
    )
    const selectedDescription = spans.find(
      (span) =>
        (span.text.includes("normal \u00b7 yolo \u00b7 goal") || span.text.includes("switch the active model")) &&
        span.bg.toInts().every((value, index) => value === theme.background.action.primary.focused.toInts()[index]) &&
        span.fg.toInts().every((value, index) => value === theme.text.action.primary.focused.toInts()[index]),
    )
    const selectedRemainder = spans.find(
      (span) =>
        span.text.startsWith("de") &&
        span.bg.toInts().every((value, index) => value === theme.background.action.primary.focused.toInts()[index]) &&
        span.fg.toInts().every((value, index) => value === theme.text.action.primary.focused.toInts()[index]),
    )
    const modelPrefix = spans.find(
      (span) => span.text === "/mo" && span.fg.toInts().every((value, index) => value === theme.text.feedback.success.default.toInts()[index]),
    )
    const modelRemainder = spans.find(
      (span) =>
        span.text.startsWith("de") &&
        span.fg.toInts().every((value, index) => value === theme.text.default.toInts()[index]),
    )

    expect(frame.join("\n")).toContain("/ COMMANDS")
    expect(frame.join("\n")).toContain("2 of 4")
    expect(frame.join("\n")).toContain("\u2191\u2193 move")
    expect(frame.join("\n")).toContain("Enter accept")
    expect(frame.join("\n")).toContain("Tab complete")
    expect(frame.join("\n")).toContain("Esc close")
    expect(selectedLabel?.fg.toInts()).toEqual(theme.text.action.primary.focused.toInts())
    expect(selectedLabel?.bg.toInts()).toEqual(theme.background.action.primary.focused.toInts())
    expect(selectedLabel!.attributes & TextAttributes.BOLD).toBeTruthy()
    expect(selectedRemainder!.attributes & TextAttributes.BOLD).toBe(0)
    expect(selectedDescription?.fg.toInts()).toEqual(theme.text.action.primary.focused.toInts())
    expect(selectedDescription?.bg.toInts()).toEqual(theme.background.action.primary.focused.toInts())
    expect(selectedDescription!.attributes & TextAttributes.BOLD).toBe(0)
    expect(modelPrefix?.fg.toInts()).toEqual(theme.text.feedback.success.default.toInts())
    expect(modelPrefix!.attributes & TextAttributes.BOLD).toBeTruthy()
    expect(modelRemainder?.fg.toInts()).toEqual(theme.text.default.toInts())
    expect(modelRemainder!.attributes & TextAttributes.BOLD).toBe(0)
    expect(frame.find((line) => line.includes("/model"))?.indexOf("switch the active model")).toBe(
      frame.find((line) => line.includes("/mode"))?.indexOf("normal \u00b7 yolo \u00b7 goal"),
    )
    expectGeometry(frame, DESIGN_VIEWPORT)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the command popup geometry proportional at the narrow viewport", async () => {
  const app = await renderAutocomplete(NARROW_VIEWPORT)
  try {
    expectGeometry(app.captureCharFrame().split("\n"), NARROW_VIEWPORT)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the command popup geometry proportional at the wide design viewport", async () => {
  const app = await renderAutocomplete(DESIGN_VIEWPORT_WIDE)
  try {
    expectGeometry(app.captureCharFrame().split("\n"), DESIGN_VIEWPORT_WIDE)
  } finally {
    app.renderer.destroy()
  }
})
