/** @jsxImportSource @opentui/solid */
import {
  MouseEvent,
  TextAttributes,
  TextRenderable,
  type BoxRenderable,
  type Renderable,
  type TextareaRenderable,
} from "@opentui/core"
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
import { railPlacement, railWidth } from "../src/routes/session/rail"
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

function Commands(props: { onCommand?: (command: string) => void; commandCount?: number }) {
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      { id: "test.model", title: "Model", description: "switch the active model", slash: { name: "model", aliases: ["mo"] }, run: () => props.onCommand?.("model") },
      { id: "test.mode", title: "Mode", description: "normal \u00b7 yolo \u00b7 goal", slash: { name: "mode" }, run: () => props.onCommand?.("mode") },
      { id: "test.compact", title: "Compact", description: "compact the transcript", slash: { name: "compact", aliases: ["mo-c"] }, run: () => props.onCommand?.("compact") },
      { id: "test.mcp", title: "MCP", description: "manage MCP servers", slash: { name: "mcp", aliases: ["mo-managed-mcp-command"] }, run: () => props.onCommand?.("mcp") },
      ...Array.from({ length: props.commandCount ?? 0 }, (_, index) => ({
        id: `test.command-${index.toString().padStart(2, "0")}`,
        title: `Command ${index}`,
        description: `run command ${index}`,
        slash: { name: `command-${index.toString().padStart(2, "0")}` },
        run: () => props.onCommand?.(`command-${index}`),
      })),
    ],
  }))
  return null
}

function sessionMainWidth(width: number) {
  return railPlacement(width) === "docked" ? width - railWidth(width) : width
}

async function renderAutocomplete(
  viewport: typeof DESIGN_VIEWPORT,
  onCommand?: (command: string) => void,
  commandCount?: number,
  query = "/mo",
  activate = true,
) {
  const events = createEventStream()
  const calls = createFetch(() => undefined, events)
  let textarea!: TextareaRenderable
  let anchor!: BoxRenderable
  let autocomplete!: AutocompleteRef
  const mainWidth = sessionMainWidth(viewport.width)
  const dockedRailWidth = viewport.width - mainWidth
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
                        <Commands onCommand={onCommand} commandCount={commandCount} />
                        <box width={viewport.width} height={viewport.height} flexDirection="row">
                          <box width={mainWidth} height="100%" flexDirection="column">
                            <box flexGrow={1} />
                            <box ref={(value: BoxRenderable) => (anchor = value)} width="100%" minHeight={2}>
                              <box width="100%" minHeight={2} border={["top"]}>
                                <box width="100%" paddingLeft={3} paddingRight={4}>
                                  <textarea ref={(value: TextareaRenderable) => (textarea = value)} width="100%" />
                                </box>
                              </box>
                            </box>
                            <text>ready</text>
                            <Autocomplete
                              value={query}
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
                          {dockedRailWidth > 0 ? (
                            <box width={dockedRailWidth} height="100%">
                              <text>SESSION</text>
                            </box>
                          ) : null}
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
  if (!activate) return app
  textarea.focus()
  textarea.insertText(query)
  autocomplete.onInput(query)
  await app.waitForFrame((frame) => frame.includes(query === "/" ? "/command-00" : "/model"))
  return app
}

function expectGeometry(app: Awaited<ReturnType<typeof renderAutocomplete>>, viewport: typeof DESIGN_VIEWPORT) {
  const frame = app.captureCharFrame().split("\n")
  const mainWidth = sessionMainWidth(viewport.width)
  const header = frame.find((line) => line.includes("/ COMMANDS"))!
  const description = frame.find((line) => line.includes("switch the active model"))!
  const promptRow = frame.findIndex((line) => line.slice(0, mainWidth).trim() === "/mo")
  const footerRow = frame.findIndex((line) => line.includes("Enter accept"))
  const left = header.indexOf("┃")
  const right = header.lastIndexOf("┃")
  const count = header.indexOf("4 of 4")
  const selected = selectedBand(app, "/model")
  const suggestionRows = frame.flatMap((line, row) => {
    const command = line.match(/\/(?:model|mode|compact|mcp)\b/)?.[0]
    return command ? [{ command, row }] : []
  })

  expect(suggestionRows.map((item) => item.command)).toEqual(["/model", "/mode", "/compact", "/mcp"])
  expect(suggestionRows.slice(1).map((item, index) => item.row - suggestionRows[index]!.row)).toEqual([1, 1, 1])
  expect(header.slice(mainWidth)).not.toContain("/ COMMANDS")
  expect([left, right]).toEqual([0, mainWidth - 1])
  expect(count + "4 of 4".length).toBe(mainWidth - 3)
  expect(selected).toEqual({ start: 1, end: mainWidth - 1 })
  expect(selectedBackgroundRows(app)).toEqual([suggestionRows[0]!.row])
  expect(Math.abs(description.indexOf("switch the active model") / (selected.end - selected.start) - 244 / 992)).toBeLessThanOrEqual(
    1 / (selected.end - selected.start),
  )

  const composerRuleRow = frame.findIndex(
    (line, index) =>
      index > footerRow &&
      index < promptRow &&
      Array.from(line.slice(0, mainWidth)).filter((character) => character === "─").length >= mainWidth - 2,
  )
  expect(composerRuleRow - footerRow).toBe(2)
  expect(promptRow - composerRuleRow).toBe(1)
}

function expectNarrowGeometry(app: Awaited<ReturnType<typeof renderAutocomplete>>, viewport: typeof DESIGN_VIEWPORT) {
  const frame = app.captureCharFrame().split("\n")
  const header = frame.find((line) => line.includes("/ COMMANDS"))!
  expect([header.indexOf("┃"), header.lastIndexOf("┃")]).toEqual([0, viewport.width - 1])
  expect(frame.join("\n")).not.toContain("SESSION")
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
    expect(frame.join("\n")).toContain("4 of 4")
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
    expect(frame.find((line) => /\/model\s/.test(line))?.indexOf("switch the active model")).toBe(
      frame.find((line) => /\/mode\s/.test(line))?.indexOf("normal \u00b7 yolo \u00b7 goal"),
    )
    expectGeometry(app, DESIGN_VIEWPORT)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the command popup geometry proportional at the narrow viewport", async () => {
  const app = await renderAutocomplete(NARROW_VIEWPORT)
  try {
    expectNarrowGeometry(app, NARROW_VIEWPORT)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the command popup geometry proportional at the wide design viewport", async () => {
  const app = await renderAutocomplete(DESIGN_VIEWPORT_WIDE)
  try {
    expectGeometry(app, DESIGN_VIEWPORT_WIDE)
  } finally {
    app.renderer.destroy()
  }
})

test("keeps only the visible command rows resident", async () => {
  const app = await renderAutocomplete(DESIGN_VIEWPORT, undefined, 20, "/")
  try {
    expect(findTexts(app.renderer.root, /^\/command-/)).toHaveLength(10)
    const first = findText(app.renderer.root, "/command-00")
    if (!first) throw new Error("first command row did not render")
    first.processMouseEvent(mouseScrollEvent(first, "down"))
    await app.waitFor(() => selectedCommands(app).join() === "/command-01")
    Array.from({ length: 9 }).forEach(() => app.mockInput.pressArrow("down"))
    await app.waitForFrame((frame) => frame.includes("/command-10"))
    expect(findTexts(app.renderer.root, /^\/command-/)).toHaveLength(10)
    expect(selectedCommands(app)).toEqual(["/command-10"])
  } finally {
    app.renderer.destroy()
  }
})

test("does not allocate command rows while autocomplete is hidden", async () => {
  const app = await renderAutocomplete(DESIGN_VIEWPORT, undefined, 20, "/", false)
  try {
    expect(findTexts(app.renderer.root, /^\/command-/)).toHaveLength(0)
    expect(findText(app.renderer.root, "No matching files, agents, or references")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("moves the only selected command to the hovered row and selects that row on click", async () => {
  let command: string | undefined
  const app = await renderAutocomplete(DESIGN_VIEWPORT, (value) => (command = value))
  try {
    await app.waitFor(() => selectedCommands(app).join() === "/model")

    const compact = findText(app.renderer.root, "/compact")
    if (!compact) throw new Error("/compact row did not render")
    compact.processMouseEvent(mouseEvent(compact, "move"))
    await app.renderOnce()
    expect(selectedCommands(app)).toEqual(["/compact"])
    expect(selectedBackgroundRows(app)).toHaveLength(1)

    compact.processMouseEvent(mouseEvent(compact, "down"))
    compact.processMouseEvent(mouseEvent(compact, "up"))
    await app.renderOnce()
    expect(command).toBe("compact")
  } finally {
    app.renderer.destroy()
  }
})

function selectedCommands(app: Awaited<ReturnType<typeof renderAutocomplete>>) {
  const selected = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding").background.action.primary.focused.toInts()
  return app
    .captureSpans()
    .lines
    .reduce<string[]>((commands, spans) => {
      const selectedSpans = spans.spans.filter((span) =>
        span.bg.toInts().every((value, index) => value === selected[index]),
      )
      const command = selectedSpans
        .map((span) => span.text)
        .join("")
        .match(/\/\S+/)?.[0]
      return command ? [...commands, command] : commands
    }, [])
}

function selectedBand(app: Awaited<ReturnType<typeof renderAutocomplete>>, command: string) {
  const frame = app.captureCharFrame().split("\n")
  const row = frame.findIndex((line) => line.includes(command))
  const selected = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding").background.action.primary.focused.toInts()
  const spans = app.captureSpans().lines[row]?.spans ?? []
  let column = 0
  let start = Infinity
  let end = -Infinity
  for (const span of spans) {
    if (span.bg.toInts().every((value, index) => value === selected[index])) {
      start = Math.min(start, column)
      end = Math.max(end, column + span.width)
    }
    column += span.width
  }
  return { start, end }
}

function selectedBackgroundRows(app: Awaited<ReturnType<typeof renderAutocomplete>>) {
  const selected = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding").background.action.primary.focused.toInts()
  return app.captureSpans().lines.flatMap((line, row) =>
    line.spans.some((span) => span.bg.toInts().every((value, index) => value === selected[index])) ? [row] : [],
  )
}

function findText(node: Renderable, text: string): TextRenderable | undefined {
  if (node instanceof TextRenderable && node.plainText.includes(text)) return node
  return node
    .getChildren()
    .flatMap((child) => findText(child, text) ?? [])
    .at(0)
}

function findTexts(node: Renderable, pattern: RegExp): TextRenderable[] {
  return [
    ...(node instanceof TextRenderable && pattern.test(node.plainText) ? [node] : []),
    ...node.getChildren().flatMap((child) => findTexts(child, pattern)),
  ]
}

function mouseEvent(target: Renderable, type: "move" | "down" | "up") {
  return new MouseEvent(target, {
    type,
    button: 0,
    x: target.x,
    y: target.y,
    modifiers: { shift: false, alt: false, ctrl: false },
  })
}

function mouseScrollEvent(target: Renderable, direction: "up" | "down") {
  return new MouseEvent(target, {
    type: "scroll",
    button: direction === "up" ? 4 : 5,
    x: target.x,
    y: target.y,
    modifiers: { shift: false, alt: false, ctrl: false },
    scroll: { direction, delta: 1 },
  })
}
