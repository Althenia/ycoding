/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { createEffect, onMount, type JSX } from "solid-js"
import { DialogSessionList } from "../src/component/dialog-session-list"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider, useLocal } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider } from "../src/ui/toast"
import { ConfigProvider } from "../src/config"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const state = "/tmp/ycoding/dialog-session-list-background"
const location = { directory: "/tmp/ycoding/packages/tui", project: { id: "proj_test", directory: "/tmp/ycoding" } }
const now = 1_800_000_000_000
let renderCount = 0

const base = {
  projectID: "proj_test",
  location: { directory: location.directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
}
const row = (id: string, title: string, age: number, extra: Record<string, unknown> = {}) => ({
  ...base,
  id,
  title,
  ...extra,
  time: { created: now - age, updated: now - age, ...((extra.time as object | undefined) ?? {}) },
})
const sessions = [
  row("ses_bg_newest", "Renamed arbitrarily", 1_000, { origin: "dots-executor", time: { pinned: now - 50_000 } }),
  row("ses_bg_dots", "Dots executor hidden", 2_000, { origin: "dots-executor" }),
  row("ses_root", "Dots root visible", 3_000, { time: { pinned: now - 40_000 } }),
  row("ses_plain", "Plain ordinary", 4_000),
]

test("hides background Sessions from rows, pins and quick-switch slots while ordinary Dots-titled roots stay", async () => {
  const { app, requests, slots } = await renderList()
  try {
    await app.waitForFrame((frame) => frame.includes("Dots root visible") && frame.includes("Plain ordinary"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Pinned")
    expect(frame).not.toContain("Renamed arbitrarily")
    expect(frame).not.toContain("Dots executor hidden")
    expect(slots()).toEqual(["ses_root"])
    const listings = requests.filter((url) => url.pathname === "/api/session")
    expect(listings.length).toBeGreaterThan(0)
    expect(listings.every((url) => url.searchParams.get("background") === "exclude")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("a live session.created for a background Session never appears while an ordinary root does", async () => {
  const { app, events } = await renderList()
  try {
    await app.waitForFrame((frame) => frame.includes("Plain ordinary"))
    for (const [id, title, origin] of [
      ["ses_live_bg", "Live background", "dots-executor"],
      ["ses_live_root", "Live ordinary", undefined],
    ] as const)
      events.emit({
        id: `evt_${id}`,
        created: now,
        type: "session.created",
        durable: { aggregateID: id, seq: 1, version: 2 },
        data: { sessionID: id, projectID: "proj_test", location: { directory: location.directory }, title, created: now, ...(origin ? { origin } : {}) },
        location: { directory: location.directory },
      })
    await app.waitForFrame((frame) => frame.includes("Live ordinary"))
    expect(app.captureCharFrame()).not.toContain("Live background")
  } finally {
    app.renderer.destroy()
  }
})

test("search requests exclude background Sessions and drops any background row the server returns", async () => {
  const { app, requests } = await renderList()
  try {
    await app.waitForFrame((frame) => frame.includes("Plain ordinary"))
    await app.mockInput.typeText("dots")
    await app.waitFor(() => requests.some((url) => url.pathname === "/api/session" && url.searchParams.get("search") === "dots"))
    const search = requests.find((url) => url.searchParams.get("search") === "dots")!
    expect(search.searchParams.get("background")).toBe("exclude")
    await app.waitForFrame((frame) => frame.includes("Dots root visible"))
    await Bun.sleep(50)
    const frame = app.captureCharFrame()
    expect(frame).toContain("Dots root visible")
    expect(frame).not.toContain("Dots executor hidden")
  } finally {
    app.renderer.destroy()
  }
})

async function renderList() {
  const sessionState = `${state}/${renderCount++}`
  await mkdir(sessionState, { recursive: true })
  const events = createEventStream()
  const requests: URL[] = []
  let slotsRead: () => readonly string[] = () => []
  const transport = createFetch((url) => {
    requests.push(url)
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session") {
      const query = url.searchParams.get("search")?.toLowerCase()
      return json({ data: sessions.filter((item) => query === undefined || item.title.toLowerCase().includes(query)), cursor: {} })
    }
    if (url.pathname === "/api/session/active") return json({ data: {} })
    const detail = /^\/api\/session\/(ses_[a-z_]+)$/.exec(url.pathname)
    if (detail?.[1] === "ses_live_bg") return json({ data: row("ses_live_bg", "Live background", 0, { origin: "dots-executor" }) })
    if (detail?.[1] === "ses_live_root") return json({ data: row("ses_live_root", "Live ordinary", 0) })
    return undefined
  }, events)
  const app = await testRender(
    () => (
      <Providers api={createApi(transport.fetch)} state={sessionState}>
        <Fixture onSlots={(read) => (slotsRead = read)} />
      </Providers>
    ),
    { width: 140, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return { app, events, requests, slots: () => slotsRead() }
}

function Fixture(props: { onSlots: (read: () => readonly string[]) => void }) {
  const dialog = useDialog()
  const local = useLocal()
  const data = useData()
  const route = useLocation()
  createEffect(() => route.set(data.location.default()))
  onMount(() => {
    props.onSlots(() => local.session.slots())
    dialog.replace(() => <DialogSessionList now={now} />)
  })
  return null
}

function Providers(props: { api: ReturnType<typeof createApi>; children: JSX.Element; state: string }) {
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <ArgsProvider>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "home" }}>
                <ClientProvider api={props.api}>
                  <DataProvider>
                    <LocationProvider>
                      <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                        <LocalProvider>
                          <DialogProvider>{props.children}</DialogProvider>
                          <Toast />
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
