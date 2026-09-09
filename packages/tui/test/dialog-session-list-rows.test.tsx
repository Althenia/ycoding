/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { createEffect, onMount, type JSX } from "solid-js"
import { DialogSessionList } from "../src/component/dialog-session-list"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { ConfigProvider } from "../src/config"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const state = "/tmp/ycoding/dialog-session-list-rows"
const location = { directory: "/tmp/ycoding/packages/tui", project: { id: "proj_test", directory: "/tmp/ycoding" } }
const now = 1_800_000_000_000

test("the first recent session renders on its own row without a blank row above it", async () => {
  await mkdir(state, { recursive: true })

  const app = await testRender(
    () => (
      <DialogProviders>
        <DialogFixture />
      </DialogProviders>
    ),
    { width: 140, height: 40 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Keymap audit"))

  try {
    const rows = app.captureCharFrame().replace(/\n$/, "").split("\n")
    const header = rows.findIndex((row) => row.includes("Recent"))
    expect(header).toBeGreaterThanOrEqual(0)
    expect(rows[header + 1]?.trim()).toBe("")
    expect(rows[header + 2]).toContain("Provider cache audit")
    expect(rows[header + 3]).toContain("Docs sync sweep")
    expect(rows[header + 4]).toContain("Keymap audit")
  } finally {
    app.renderer.destroy()
  }
})

function DialogFixture() {
  const dialog = useDialog()
  onMount(() => dialog.replace(() => <DialogSessionList now={now} />))
  return <SyncLocation />
}

function SyncLocation() {
  const data = useData()
  const route = useLocation()
  createEffect(() => route.set(data.location.default()))
  return null
}

function DialogProviders(props: { children: JSX.Element }) {
  const events = createEventStream()
  const transport = createFetch(route, events)
  return (
    <TestTuiContexts paths={{ state }}>
      <ArgsProvider>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "home" }}>
                <ClientProvider api={createApi(transport.fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                          <LocalProvider>
                            <DialogProvider>{props.children}</DialogProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </ArgsProvider>
    </TestTuiContexts>
  )
}

function route(url: URL) {
  if (url.pathname === "/api/location") return json(location)
  if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
  if (url.pathname === "/api/session/active") return json({ data: {} })
  return undefined
}

const session = {
  id: "ses_capture",
  title: "Provider cache audit",
  projectID: "proj_test",
  location: { directory: location.directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  time: { created: now - 120_000, updated: now - 120_000 },
}

const sessions = [
  session,
  { ...session, id: "ses_docs", title: "Docs sync sweep", time: { created: now - 3_600_000, updated: now - 3_600_000 } },
  { ...session, id: "ses_keymap", title: "Keymap audit", time: { created: now - 86_400_000, updated: now - 86_400_000 } },
]
