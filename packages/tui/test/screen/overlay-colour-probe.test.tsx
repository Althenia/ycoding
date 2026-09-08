/** @jsxImportSource @opentui/solid */
import { type BoxRenderable, InputRenderable, type TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, onMount } from "solid-js"
import { Autocomplete, type AutocompleteRef } from "../../src/component/prompt/autocomplete"
import { ConfigProvider } from "../../src/config"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { Keymap } from "../../src/context/keymap"
import { LocationProvider, useLocation } from "../../src/context/location"
import { ThemeProvider } from "../../src/context/theme"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogSelect } from "../../src/ui/dialog-select"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { RouteProvider } from "../../src/context/route"
import { createApi, createEventStream, createFetch, directory } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"

const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE] as const
const focusedActionFill = [121, 184, 255, 255] satisfies [number, number, number, number]
const successFeedback = [103, 215, 164, 255] satisfies [number, number, number, number]

function colorOf(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  return spans(app).find((span) => span.text.includes(text))?.fg.toInts()
}

function spans(app: Awaited<ReturnType<typeof testRender>>) {
  return app.captureSpans().lines.flatMap((line) => line.spans)
}

function spanRow(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const row = app.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes(text)))
  if (!row || row.spans.length === 0) throw new Error(`No rendered span row for ${text}`)
  return row.spans
}

function selectionBand(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const row = spanRow(app, text)
  const index = row.findIndex((span) => span.text.includes(text))
  if (index <= 0 || index >= row.length - 1) throw new Error(`No complete selection band for ${text}`)
  return row.slice(index - 1, index + 2)
}

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
      { id: "test.mode", title: "Mode", description: "normal mode", slash: { name: "mode" }, run: () => {} },
    ],
  }))
  return null
}

test("probes dialog, toast, and autocomplete colours at canonical viewports", async () => {
  for (const viewport of viewports) {
    await probeDialog(viewport)
    await probeToast(viewport)
    await probeAutocomplete(viewport)
  }
}, 60_000)

async function probeDialog(viewport: (typeof viewports)[number]) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect
          title="Choose overlay model"
          options={[
            { title: "Selected model", value: "selected" },
            { title: "Other model", value: "other" },
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
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Selected model"))
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)

  try {
    const selectedRow = selectionBand(app, "Selected model")
    expect(selectedRow).not.toHaveLength(0)
    expect(selectedRow.every((span) => span.bg.toInts().every((value, index) => value === focusedActionFill[index]))).toBe(true)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof InputRenderable)) throw new Error("Dialog search input did not receive focus")
    expect(input.cursorColor.toInts()).toEqual(focusedActionFill)
  } finally {
    app.renderer.destroy()
  }
}

async function probeToast(viewport: (typeof viewports)[number]) {
  function ToastFixture() {
    const toast = useToast()
    onMount(() => toast.show({ variant: "success", message: "Overlay colour probe", duration: 60_000 }))
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
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Overlay colour probe"))

  try {
    expect(colorOf(app, "Success")).toEqual(successFeedback)
  } finally {
    app.renderer.destroy()
  }
}

async function probeAutocomplete(viewport: (typeof viewports)[number]) {
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
                        <box width={viewport.width} height={viewport.height} flexDirection="column">
                          <box flexGrow={1} />
                          <box ref={(value: BoxRenderable) => (anchor = value)} height={1}>
                            <textarea ref={(value: TextareaRenderable) => (textarea = value)} width="100%" />
                          </box>
                          <text>overlay-ready</text>
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
  await app.waitForFrame((frame) => frame.includes("overlay-ready"))
  textarea.insertText("/mo")
  autocomplete.onInput("/mo")
  await app.waitForFrame((frame) => frame.includes("/model"))

  try {
    const selectedRow = selectionBand(app, "/mo")
    expect(selectedRow).not.toHaveLength(0)
    expect(selectedRow.every((span) => span.bg.toInts().every((value, index) => value === focusedActionFill[index]))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
}
