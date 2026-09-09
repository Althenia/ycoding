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

const state = "/tmp/ycoding/dialog-session-list-archive"
const location = { directory: "/tmp/ycoding/packages/tui", project: { id: "proj_test", directory: "/tmp/ycoding" } }
const now = 1_800_000_000_000
let renderCount = 0

test("renders archived sessions distinctly while retaining them in the switcher", async () => {
  const { app } = await renderArchiveList()

  try {
    await app.waitForFrame((frame) => frame.includes("Archived session"))
    expect(app.captureCharFrame()).toContain("Archived")
  } finally {
    app.renderer.destroy()
  }
})

test("cancelling archive leaves the selected session unchanged", async () => {
  const requests: URL[] = []
  const { app, keymap } = await renderArchiveList(
    (url) => {
      if (url.pathname.endsWith("/archive")) {
        requests.push(url)
        return json({}, { status: 204 })
      }
      return undefined
    },
    "ses_active",
    true,
    false,
  )

  try {
    await app.waitForFrame((frame) => frame.includes("Active session"))
    keymap.dispatch("session.archive")
    await app.waitForFrame((frame) => frame.includes("Archive session"))

    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Switch session"))
    expect(requests).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("reports archive failures for the selected session only", async () => {
  const requests: URL[] = []
  const { app, keymap } = await renderArchiveList(
    (url, request) => {
      if (url.pathname === "/api/session/ses_active/archive" && request.method === "POST") {
        requests.push(url)
        return json({ message: "Store locked" }, { status: 500 })
      }
      if (url.pathname.endsWith("/archive")) throw new Error(`unexpected archive target: ${url.pathname}`)
      return undefined
    },
    "ses_active",
    true,
    false,
  )

  try {
    await app.waitForFrame((frame) => frame.includes("Active session"))
    keymap.dispatch("session.archive")
    await app.waitForFrame((frame) => frame.includes("Archive session"))
    app.mockInput.pressEnter()

    await app.waitForFrame((frame) => frame.includes("Failed to archive session"))
    expect(requests.map((url) => url.pathname)).toEqual(["/api/session/ses_active/archive"])
  } finally {
    app.renderer.destroy()
  }
})

test("archives the selected active session after confirmation", async () => {
  const requests: URL[] = []
  const { app } = await renderArchiveList(
    (url, request) => {
      if (url.pathname === "/api/session/ses_active/archive" && request.method === "POST") {
        requests.push(url)
        return json({}, { status: 204 })
      }
      if (url.pathname.endsWith("/archive")) throw new Error(`unexpected archive target: ${url.pathname}`)
      return undefined
    },
    "ses_active",
    true,
    false,
  )

  try {
    await app.waitForFrame((frame) => frame.includes("Active session"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("Archive session"))
    const confirmation = app.captureCharFrame()
    expect(confirmation).toContain("This is reversible")
    expect(confirmation).toContain("does not automatically delete its history")
    app.mockInput.pressEnter()

    await app.waitFor(() => requests.length === 1)
    expect(requests.map((url) => url.pathname)).toEqual(["/api/session/ses_active/archive"])
  } finally {
    app.renderer.destroy()
  }
})

test("unarchives the selected archived session directly", async () => {
  const requests: URL[] = []
  const { app, keymap } = await renderArchiveList((url, request) => {
    if (url.pathname === "/api/session/ses_archived/archive" && request.method === "DELETE") {
      requests.push(url)
      return json({}, { status: 204 })
    }
    if (url.pathname.endsWith("/archive")) throw new Error(`unexpected archive target: ${url.pathname}`)
    return undefined
  }, "ses_archived")

  try {
    await app.waitForFrame((frame) => frame.includes("Archived session"))
    keymap.dispatch("session.archive")

    await app.waitFor(() => requests.length === 1)
    expect(requests.map((url) => url.pathname)).toEqual(["/api/session/ses_archived/archive"])
  } finally {
    app.renderer.destroy()
  }
})

async function renderArchiveList(override?: FetchHandler, sessionID?: string, activeFirst = false, archived = true) {
  const sessionState = `${state}/${renderCount++}`
  await mkdir(sessionState, { recursive: true })
  const events = createEventStream()
  let keymap!: ReturnType<typeof Keymap.use>
  const transport = createFetch((url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session")
      return json({
        data: sessions.map((session) => ({
          ...session,
          time: {
            ...session.time,
            ...(activeFirst && session.id === "ses_active" ? { updated: now } : {}),
            ...(archived ? {} : { archived: undefined }),
          },
        })),
        cursor: {},
      })
    if (url.pathname === "/api/session/active") return json({ data: {} })
    return override?.(url, request)
  }, events)
  const app = await testRender(
    () => (
      <ArchiveProviders api={createApi(transport.fetch)} state={sessionState} sessionID={sessionID}>
        <ArchiveFixture onKeymap={(value) => (keymap = value)} />
      </ArchiveProviders>
    ),
    { width: 140, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return { app, keymap }
}

function ArchiveFixture(props: { onKeymap: (keymap: ReturnType<typeof Keymap.use>) => void }) {
  const dialog = useDialog()
  const keymap = Keymap.use()
  onMount(() => {
    props.onKeymap(keymap)
    dialog.replace(() => <DialogSessionList now={now} pinned={[]} />)
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
  id: "ses_archived",
  title: "Archived session",
  projectID: "proj_test",
  location: { directory: location.directory },
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  time: { created: now - 120_000, updated: now - 120_000, archived: now - 60_000 },
}

const sessions = [
  session,
  {
    ...session,
    id: "ses_active",
    title: "Active session",
    time: { created: now - 3_600_000, updated: now - 3_600_000 },
  },
]
