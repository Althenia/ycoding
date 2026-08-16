/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "path"
import { createEffect, onMount, type JSX } from "solid-js"
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
import { DialogAlert } from "../../src/ui/dialog-alert"
import { DialogConfirm } from "../../src/ui/dialog-confirm"
import { DialogPrompt } from "../../src/ui/dialog-prompt"
import { DialogSelect } from "../../src/ui/dialog-select"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { createApi, createEventStream, createFetch, directory } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE } from "../viewport"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const viewports = [DESIGN_VIEWPORT, DESIGN_VIEWPORT_WIDE] as const

const toasts = [
  { name: "toast-success", variant: "success", message: "Copied to clipboard" },
  { name: "toast-info", variant: "info", message: "Session exported to ~/Downloads/provider-cache-audit.md" },
  { name: "toast-warning", variant: "warning", message: "Skill conflict: go-review is defined by 2 sources" },
  { name: "toast-error", variant: "error", message: "Anthropic returned 429 rate limited. The turn was not sent." },
] as const

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
      { id: "test.mode", title: "Mode", description: "normal · yolo · goal", slash: { name: "mode" }, run: () => {} },
      { id: "test.compact", title: "Compact", description: "compact the transcript", slash: { name: "compact" }, run: () => {} },
      { id: "test.mcp", title: "MCP", description: "manage MCP servers", slash: { name: "mcp" }, run: () => {} },
    ],
  }))
  return null
}

test("captures deterministic overlay frames", async () => {
  for (const viewport of viewports) {
    await captureDialog(
      "dialog-select",
      "Select model",
      () => (
        <DialogSelect
          title="Select model"
          options={[
            { title: "Claude Opus 5", value: "opus" },
            { title: "Claude Sonnet 5", value: "sonnet" },
          ]}
        />
      ),
      viewport,
    )
    await captureDialog("dialog-prompt", "Prompt", () => <DialogPrompt title="Prompt" placeholder="Enter text" />, viewport)
    await captureDialog(
      "dialog-confirm",
      "Confirm",
      () => <DialogConfirm title="Confirm" message="Continue with this action?" />,
      viewport,
    )
    await captureDialog(
      "dialog-alert",
      "Alert",
      () => <DialogAlert title="Alert" message="This action needs your attention." />,
      viewport,
    )
    await captureAutocomplete(viewport)

    for (const toast of toasts) {
      await captureToast(toast, viewport)
    }
  }
})

async function captureDialog(
  name: string,
  settle: string,
  view: () => JSX.Element,
  viewport: (typeof viewports)[number],
) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(view))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ToastProvider>
                <DialogProvider>
                  <DialogFixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(settle))

  try {
    await writeCapture(`${name}-${viewport.width}x${viewport.height}.txt`, app.captureCharFrame(), viewport)
  } finally {
    app.renderer.destroy()
  }
}

async function captureToast(toast: (typeof toasts)[number], viewport: (typeof viewports)[number]) {
  function ToastFixture() {
    const overlay = useToast()
    onMount(() => overlay.show({ ...toast, duration: 60_000 }))
    return <Toast />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToastProvider>
              <ToastFixture />
            </ToastProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    viewport,
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(toast.message.slice(0, 16)))

  try {
    await writeCapture(`${toast.name}-${viewport.width}x${viewport.height}.txt`, app.captureCharFrame(), viewport)
  } finally {
    app.renderer.destroy()
  }
}

async function captureAutocomplete(viewport: (typeof viewports)[number]) {
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

  try {
    await writeCapture(`autocomplete-${viewport.width}x${viewport.height}.txt`, app.captureCharFrame(), viewport)
  } finally {
    app.renderer.destroy()
  }
}

async function writeCapture(name: string, frame: string, viewport: (typeof viewports)[number]) {
  const rows = frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n")
  expect(rows).toHaveLength(viewport.height)
  for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)
  await Bun.write(path.join(renders, name), rows.join("\n"))
}
