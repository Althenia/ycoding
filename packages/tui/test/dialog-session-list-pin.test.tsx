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
import { LocalProvider } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider } from "../src/ui/toast"
import { ConfigProvider } from "../src/config"
import { createApi, createEventStream, createFetch, json, type FetchHandler } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const state = "/tmp/ycoding/dialog-session-list-pin"
const location = { directory: "/tmp/ycoding/packages/tui", project: { id: "proj_test", directory: "/tmp/ycoding" } }
const now = 1_800_000_000_000
let renderCount = 0

test("lists server-pinned sessions first in pin order with quick-switch slots", async () => {
  const { app } = await renderPinList({ pinned: { ses_second: now - 1_000, ses_first: now - 2_000 } })
  try {
    await app.waitForFrame((frame) => frame.includes("Pinned") && frame.includes("Second session"))
    const frame = app.captureCharFrame()
    const pinned = frame.indexOf("Pinned")
    const first = frame.indexOf("First session")
    const second = frame.indexOf("Second session")
    const recent = frame.indexOf("Recent")
    expect(pinned).toBeLessThan(first)
    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(recent)
    expect(frame.indexOf("Other session")).toBeGreaterThan(recent)
  } finally {
    app.renderer.destroy()
  }
})

test("pin toggle asks the server to pin the highlighted unpinned session", async () => {
  const requests: string[] = []
  const { app, keymap } = await renderPinList({
    pinned: { ses_first: now - 2_000 },
    sessionID: "ses_other",
    override: (url, request) => {
      if (url.pathname.endsWith("/pin")) {
        requests.push(`${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Other session"))
    keymap.dispatch("session.pin.toggle")
    await app.waitFor(() => requests.length === 1)
    expect(requests).toEqual(["POST /api/session/ses_other/pin"])
  } finally {
    app.renderer.destroy()
  }
})

test("pin toggle on a pinned session asks the server to unpin it", async () => {
  const requests: string[] = []
  const { app, keymap } = await renderPinList({
    pinned: { ses_first: now - 2_000 },
    sessionID: "ses_first",
    override: (url, request) => {
      if (url.pathname.endsWith("/pin")) {
        requests.push(`${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("First session"))
    keymap.dispatch("session.pin.toggle")
    await app.waitFor(() => requests.length === 1)
    expect(requests).toEqual(["DELETE /api/session/ses_first/pin"])
  } finally {
    app.renderer.destroy()
  }
})

test("a session.pinned event moves the session into the pinned group", async () => {
  const { app, events } = await renderPinList({ pinned: {} })
  try {
    await app.waitForFrame((frame) => frame.includes("Other session"))
    expect(app.captureCharFrame()).not.toContain("Pinned")
    events.emit({
      id: "evt_pin_other",
      created: now,
      type: "session.pinned",
      durable: { aggregateID: "ses_other", seq: 1, version: 1 },
      data: { sessionID: "ses_other" },
      location: { directory: location.directory },
    })
    await app.waitForFrame((frame) => frame.includes("Pinned"))
    const frame = app.captureCharFrame()
    expect(frame.indexOf("Pinned")).toBeLessThan(frame.indexOf("Other session"))
  } finally {
    app.renderer.destroy()
  }
})

test("imports pins from the previous local session.json once and removes it", async () => {
  const requests: string[] = []
  const sessionState = `${state}/${renderCount++}`
  await mkdir(sessionState, { recursive: true })
  await Bun.write(`${sessionState}/session.json`, JSON.stringify({ pinned: ["ses_second", "ses_missing", "ses_first"] }))
  const { app } = await renderPinList({
    pinned: {},
    state: sessionState,
    override: (url, request) => {
      if (url.pathname.endsWith("/pin")) {
        requests.push(`${request.method} ${url.pathname}`)
        if (url.pathname.includes("ses_missing"))
          return json({ _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "Session not found" }, { status: 404 })
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  try {
    await app.waitFor(() => requests.length === 3)
    expect(requests).toEqual([
      "POST /api/session/ses_second/pin",
      "POST /api/session/ses_missing/pin",
      "POST /api/session/ses_first/pin",
    ])
    await app.waitFor(async () => !(await Bun.file(`${sessionState}/session.json`).exists()))
  } finally {
    app.renderer.destroy()
  }
})

async function renderPinList(input: {
  pinned: Record<string, number>
  sessionID?: string
  state?: string
  override?: FetchHandler
}) {
  const sessionState = input.state ?? `${state}/${renderCount++}`
  await mkdir(sessionState, { recursive: true })
  const events = createEventStream()
  let keymap!: ReturnType<typeof Keymap.use>
  const transport = createFetch((url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session")
      return json({
        data: sessions.map((session) => ({
          ...session,
          time: { ...session.time, ...(input.pinned[session.id] === undefined ? {} : { pinned: input.pinned[session.id] }) },
        })),
        cursor: {},
      })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    return input.override?.(url, request)
  }, events)
  const app = await testRender(
    () => (
      <ArchiveProviders api={createApi(transport.fetch)} state={sessionState} sessionID={input.sessionID}>
        <PinFixture onKeymap={(value) => (keymap = value)} />
      </ArchiveProviders>
    ),
    { width: 140, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return { app, keymap, events }
}

function PinFixture(props: { onKeymap: (keymap: ReturnType<typeof Keymap.use>) => void }) {
  const dialog = useDialog()
  const keymap = Keymap.use()
  onMount(() => {
    props.onKeymap(keymap)
    dialog.replace(() => <DialogSessionList now={now} />)
  })
  return <SyncLocation />
}

function SyncLocation() {
  const data = useData()
  const route = useLocation()
  createEffect(() => route.set(data.location.default()))
  return null
}

function ArchiveProviders(props: {
  api: ReturnType<typeof createApi>
  children: JSX.Element
  state: string
  sessionID?: string
}) {
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <ArgsProvider>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <RouteProvider
                initialRoute={props.sessionID ? { type: "session", sessionID: props.sessionID } : { type: "home" }}
              >
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

const session = {
  id: "ses_other",
  title: "Other session",
  projectID: "proj_test",
  location: { directory: location.directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  time: { created: now - 120_000, updated: now - 120_000 },
}

const sessions = [
  session,
  { ...session, id: "ses_first", title: "First session", time: { created: now - 3_600_000, updated: now - 3_600_000 } },
  { ...session, id: "ses_second", title: "Second session", time: { created: now - 7_200_000, updated: now - 7_200_000 } },
]
