import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { SessionInfo, YCodingEvent } from "@ycoding-ai/client"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { ConfigProvider } from "../src/config"
import { DialogSessionList } from "../src/component/dialog-session-list"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { useEvent } from "../src/context/event"
import { Keymap } from "../src/context/keymap"
import { LocalProvider } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider, useRoute } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { DialogSelect } from "../src/ui/dialog-select"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const now = 1_800_000_000_000
const directory = "/tmp/ycoding/packages/tui"
const state = `${tmpdir()}/session-palette-freeze`
let renders = 0

test("metadata updates preserve picker focus selection and unchanged row resources", async () => {
  const paths = `${state}/${renders++}`
  await mkdir(paths, { recursive: true })
  const resources = { mounted: 0, disposed: 0 }
  const selected: string[] = []
  let update = () => {}
  function Gutter() {
    onMount(() => resources.mounted++)
    onCleanup(() => resources.disposed++)
    return <text>·</text>
  }
  const gutter = () => <Gutter />
  function Fixture() {
    const dialog = useDialog()
    const [options, setOptions] = createSignal([
      { value: "alpha", title: "Alpha resident", category: "Recent", gutter },
      { value: "beta", title: "Beta resident", category: "Recent", gutter },
    ])
    onMount(() => {
      update = () => setOptions([
        { value: "alpha", title: "Alpha resident updated", category: "Recent", gutter },
        { value: "beta", title: "Beta resident updated", category: "Recent", gutter },
      ])
      dialog.replace(() => <DialogSelect title="Resident picker" options={options()} preserveSelection
        onSelect={(option) => selected.push(option.value)} />)
    })
    return null
  }
  const app = await testRender(
    () => <Providers api={createApi(createFetch().fetch)} state={paths}><Fixture /></Providers>,
    { width: 120, height: 60, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    await app.waitForFrame((frame) => frame.includes("Beta resident"))
    app.mockInput.pressArrow("down")
    await settle(app)
    const input = app.renderer.currentFocusedEditor
    const before = { ...resources }
    update()
    await app.waitForFrame((frame) => frame.includes("Beta resident updated"))
    await settle(app)
    const after = { ...resources }
    expect(app.renderer.currentFocusedEditor).toBe(input)
    app.mockInput.pressEnter()
    await app.waitFor(() => selected.length === 1)
    expect(selected).toEqual(["beta"])
    expect(before.mounted).toBeGreaterThan(0)
    expect(after).toEqual(before)
  } finally {
    app.renderer.destroy()
  }
})

test("activity bursts update groups and preserve search and navigation without rediscovering roots", async () => {
  const fixture = await renderPalette()
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Alpha resident") && frame.includes("Beta resident"))
    await settle(fixture.app)
    const discovery = fixture.roots.length
    for (let index = 0; index < 24; index++) fixture.emitStarted(index)
    await fixture.app.waitFor(() => fixture.seen() === 24)
    await fixture.app.waitForFrame((frame) => {
      const running = frame.indexOf("Running")
      const recent = frame.indexOf("Recent")
      const beta = frame.indexOf("Beta resident")
      return running >= 0 && beta > running && beta < recent
    })
    const frame = fixture.app.captureCharFrame()
    expect(frame.split("Beta resident").length - 1).toBe(1)
    await settle(fixture.app)
    const afterActivity = fixture.roots.length
    await fixture.app.mockInput.typeText("resident")
    await fixture.app.waitForFrame((value) => value.includes("resident") && !value.includes("Pinned fixture"))
    fixture.app.mockInput.pressArrow("down")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitFor(() => fixture.opened.length === 1)
    expect(fixture.opened).toEqual(["ses_alpha"])
    await settle(fixture.app)
    expect(afterActivity - discovery, "nonstructural activity must not rediscover root inventory").toBe(0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("Escape closes the palette during activity refresh and later events cannot restart discovery", async () => {
  const fixture = await renderPalette()
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Alpha resident"))
    await settle(fixture.app)
    const discovery = fixture.roots.length
    fixture.holdOutstanding()
    for (let index = 0; index < 24; index++) fixture.emitStarted(index)
    await fixture.app.waitFor(() => fixture.seen() === 24)
    await fixture.app.waitFor(() => fixture.outstandingHeld())
    await fixture.app.mockInput.typeText("Alpha")
    await fixture.app.waitForFrame((frame) => frame.includes("Alpha resident") && !frame.includes("Beta resident"))
    fixture.app.mockInput.pressEscape()
    await fixture.app.waitForFrame((frame) => !frame.includes("Switch session"))
    fixture.releaseOutstanding()
    await settle(fixture.app)
    const afterClose = fixture.roots.length
    for (let index = 24; index < 48; index++) fixture.emitStarted(index)
    await fixture.app.waitFor(() => fixture.seen() === 48)
    await settle(fixture.app)
    expect(fixture.opened).toEqual([])
    expect(fixture.app.captureCharFrame()).not.toContain("Switch session")
    expect(fixture.roots.length).toBe(afterClose)
    expect(afterClose - discovery, "activity before Escape must not rediscover root inventory").toBe(0)
  } finally {
    fixture.releaseOutstanding()
    fixture.app.renderer.destroy()
  }
})

async function settle(app: Awaited<ReturnType<typeof testRender>>) {
  for (let frame = 0; frame < 30; frame++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await app.renderOnce()
  }
}

async function renderPalette() {
  const paths = `${state}/${renders++}`
  await mkdir(paths, { recursive: true })
  const events = createEventStream()
  const roots: string[] = []
  const opened: string[] = []
  let seen = 0
  let running = false
  let outstanding: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let outstandingHeld = false
  const sessions: SessionInfo[] = [
    row("ses_alpha", "Alpha resident", now - 1_000),
    row("ses_beta", "Beta resident", now - 2_000),
    {
      ...row("ses_pinned", "Pinned fixture", now - 3_000),
      time: { created: now - 4_000, updated: now - 3_000, pinned: now - 3_000 },
    },
  ]
  const transport = createFetch(async (url) => {
    if (url.pathname === "/api/session") {
      const search = url.searchParams.get("search")
      if (search === null) roots.push(url.search)
      return json({
        data: sessions.filter((session) => !search || session.title.toLowerCase().includes(search.toLowerCase())),
        cursor: {},
      })
    }
    if (url.pathname === "/api/session/outstanding") {
      if (outstanding) outstandingHeld = true
      await outstanding?.promise
      return json({ data: running ? ["ses_beta"] : [], running: running ? ["ses_beta"] : [], failed: [], lost: [] })
    }
    const session = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
    if (session) return json({ data: session })
    return undefined
  }, events)
  function Fixture() {
    const dialog = useDialog()
    const route = useRoute()
    const data = useData()
    const location = useLocation()
    onCleanup(useEvent().subscribe(() => seen++))
    createEffect(() => location.set(data.location.default()))
    createEffect(() => {
      if (route.data.type === "session") opened.push(route.data.sessionID)
    })
    onMount(() => dialog.replace(() => <DialogSessionList now={now} />))
    return null
  }
  const app = await testRender(
    () => (
      <Providers api={createApi(transport.fetch)} state={paths}>
        <Fixture />
      </Providers>
    ),
    { width: 120, height: 60, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return {
    app,
    roots,
    opened,
    seen: () => seen,
    outstandingHeld: () => outstandingHeld,
    holdOutstanding: () => {
      outstanding = Promise.withResolvers<void>()
    },
    releaseOutstanding: () => {
      outstanding?.resolve()
      outstanding = undefined
    },
    emitStarted(index: number) {
      running = true
      events.emit({
        id: `evt_palette_activity_${index}`,
        created: now + index,
        type: "session.execution.started",
        durable: { aggregateID: "ses_beta", seq: index + 2, version: 1 },
        data: { sessionID: "ses_beta" },
        location: { directory },
      } satisfies YCodingEvent)
    },
  }
}

function Providers(props: { api: ReturnType<typeof createApi>; state: string; children: JSX.Element }) {
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

function row(id: string, title: string, updated: number): SessionInfo {
  return {
    id,
    title,
    projectID: "proj_test",
    location: { directory },
    agent: "build",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now - 60_000, updated },
  }
}
