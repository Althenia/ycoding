/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createEffect, onMount, type JSX } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClientProvider } from "../../src/context/client"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider, useData } from "../../src/context/data"
import { Keymap } from "../../src/context/keymap"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider, useLocation } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { RouteProvider } from "../../src/context/route"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogAlert } from "../../src/ui/dialog-alert"
import { DialogConfirm } from "../../src/ui/dialog-confirm"
import { DialogPrompt } from "../../src/ui/dialog-prompt"
import { DialogSelect } from "../../src/ui/dialog-select"
import { ToastProvider } from "../../src/ui/toast"
import { createApi, createEventStream, createFetch, directory, worktree } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const renders = path.resolve(import.meta.dir, "../../../../.aphrodite/renders")
const state = "/tmp/ycoding/dialog-base-capture"
const sessionID = "ses_dialog_base_capture"
const location = { directory, project: { id: "proj_test", directory: worktree } }
const viewports = [
  { width: 189, height: 69 },
  { width: 220, height: 69 },
  { width: 80, height: 24 },
] as const

const states = [
  {
    name: "select",
    settle: "Select",
    evidence: ["The generic picker every list dialog composes", "Option one", "current"],
    view: () => (
      <DialogSelect
        title="Select"
        options={[
          { title: "Option one", value: "one", description: "current", category: "The generic picker every list dialog composes" },
          { title: "Option two", value: "two", category: "The generic picker every list dialog composes" },
          { title: "Option three", value: "three", category: "The generic picker every list dialog composes" },
        ]}
        current="one"
      />
    ),
  },
  {
    name: "prompt",
    settle: "Enter a value",
    evidence: ["...", "Search", "enter submit"],
    view: () => <DialogPrompt title="Enter a value" description={() => <text>...</text>} value="Search" />,
  },
  {
    name: "prompt-busy",
    settle: "Enter a value",
    evidence: ["...", "Search", "Saving...", "processing..."],
    view: () => <DialogPrompt title="Enter a value" description={() => <text>...</text>} value="Search" busy busyText="Saving..." />,
  },
  {
    name: "confirm",
    settle: "Delete session?",
    evidence: ["Provider cache audit and its 1,204 archived messages", "permanently", "removed.", "Cancel", "Delete"],
    view: () => (
      <DialogConfirm
        title="Delete session?"
        message="Provider cache audit and its 1,204 archived messages will be permanently removed."
        label="Delete"
      />
    ),
  },
  {
    name: "alert",
    settle: "Session delete failed",
    evidence: ["The durable store rejected the delete.", "The session", "is unchanged.", "Dismiss"],
    view: () => <DialogAlert title="Session delete failed" message="The durable store rejected the delete. The session is unchanged." />,
  },
] as const

test("captures canonical shared dialog fixtures at canonical and compact dimensions", async () => {
  await mkdir(state, { recursive: true })
  for (const viewport of viewports) {
    for (const dialogState of states) await capture(dialogState, viewport)
  }
}, 30_000)

function DialogProviders(props: { children: JSX.Element }) {
  const events = createEventStream()
  const transport = createFetch(route, events)
  return (
    <TestTuiContexts paths={{ state }}>
      <ClipboardProvider>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <PermissionProvider>
                      <DataProvider>
                        <LocationProvider>
                          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                            <LocalProvider>
                              <DialogProvider>{props.children}</DialogProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </LocationProvider>
                      </DataProvider>
                    </PermissionProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </ClipboardProvider>
    </TestTuiContexts>
  )
}

function SyncLocation() {
  const data = useData()
  const route = useLocation()
  createEffect(() => route.set(data.location.default()))
  return null
}

async function capture(dialogState: (typeof states)[number], viewport: (typeof viewports)[number]) {
  function DialogFixture() {
    const dialog = useDialog()
    onMount(() => dialog.replace(dialogState.view))
    return <SyncLocation />
  }

  const app = await testRender(() => <DialogProviders><DialogFixture /></DialogProviders>, viewport)
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(dialogState.settle))

  try {
    const rows = app.captureCharFrame().replace(/\n$/, "").split("\n")
    const frame = rows.join("\n")
    expect(rows).toHaveLength(viewport.height)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(viewport.width)
    for (const evidence of dialogState.evidence) expect(frame).toContain(evidence)
    await Bun.write(path.join(renders, `dialog-base-${dialogState.name}-${viewport.width}x${viewport.height}.txt`), frame)
  } finally {
    app.renderer.destroy()
  }
}

function route(url: URL) {
  if (url.pathname === "/api/location") return Response.json(location)
  return undefined
}
