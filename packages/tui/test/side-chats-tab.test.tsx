/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionInfo } from "@ycoding-ai/client"
import { createEffect } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocationProvider } from "../src/context/location"
import { RouteProvider, useRoute } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { Composer } from "../src/routes/session/composer"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const module = await import("../src/routes/session/composer/side-chats-tab")

function session(id: string, input: Partial<Pick<SessionInfo, "agent" | "parentID" | "title">> = {}): SessionInfo {
  return {
    id,
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/workspace" },
    title: "Session",
    ...input,
  }
}

test("lists only direct BTW side chats without assigning managed-task state", () => {
  const entries = module.entriesFromBtwSessions(
    [
      session("ses_other_parent", { agent: "btw", parentID: "ses_other", title: "Other parent" }),
      session("ses_task", { agent: "reviewer", parentID: "ses_main", title: "Managed task" }),
      session("ses_later", { agent: "btw", parentID: "ses_main", title: "Later BTW" }),
      session("ses_first", { agent: "btw", parentID: "ses_main", title: "First BTW" }),
    ],
    "ses_main",
    "ses_later",
  )

  expect(entries).toEqual([
    { sessionID: "ses_first", title: "First BTW", current: false },
    { sessionID: "ses_later", title: "Later BTW", current: true },
  ])
  expect(entries.flatMap(Object.keys)).not.toContain("status")
})

test("loads older direct BTW chats, reopens one, and creates only one model-deferred side chat", async () => {
  const created: unknown[] = []
  const cursors: Array<string | null> = []
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/session" && request.method === "POST") {
      const body: unknown = await request.json()
      created.push(body)
      return json({ data: session("ses_btw_new", { agent: "btw", parentID: "ses_main", title: "New BTW" }) })
    }
    if (url.pathname === "/api/session/ses_btw_new/synthetic") return json({ data: {} })
    if (url.pathname !== "/api/session") return undefined
    expect(url.searchParams.get("parentID")).toBe("ses_main")
    cursors.push(url.searchParams.get("cursor"))
    if (url.searchParams.get("cursor") === "older")
      return json({ data: [session("ses_btw", { agent: "btw", parentID: "ses_main", title: "Ask about caching" })], cursor: {} })
    return json({ data: [session("ses_task", { agent: "reviewer", parentID: "ses_main", title: "Managed task" })], cursor: { next: "older" } })
  })
  const config = createTuiResolvedConfig()
  let routeSessionID: string | undefined
  function RouteProbe() {
    const route = useRoute().data
    createEffect(() => {
      routeSessionID = route.type === "session" ? route.sessionID : undefined
    })
    return null
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
            <ClientProvider api={createApi(calls.fetch)}>
              <DataProvider>
                <LocationProvider>
                  <ToastProvider>
                    <RouteProvider initialRoute={{ type: "session", sessionID: "ses_main" }}>
                      <RouteProbe />
                      <Composer sessionID="ses_main" open defaultTab="side-chats" />
                    </RouteProvider>
                  </ToastProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("+ New side chat") && frame.includes("+ More side chats"))
    app.mockInput.pressKey("n", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("Ask about caching"))
    expect(app.captureCharFrame()).toContain("> Ask about caching")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(routeSessionID).toBe("ses_btw")
    app.mockInput.pressKey("n")
    app.mockInput.pressKey("n")
    await app.waitForFrame(() => routeSessionID === "ses_btw_new")
    expect(created).toEqual([{ parentID: "ses_main", agent: "btw" }])
    expect(cursors).toEqual([null, "older"])
  } finally {
    app.renderer.destroy()
  }
})

test("renders a visible list error instead of an empty-side-chat message", async () => {
  const config = createTuiResolvedConfig()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ error: "list unavailable" }, { status: 500 })
    return undefined
  })
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <LocationProvider>
                    <ToastProvider>
                      <RouteProvider initialRoute={{ type: "session", sessionID: "ses_main" }}>
                        <Composer sessionID="ses_main" open defaultTab="side-chats" />
                      </RouteProvider>
                    </ToastProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 20 },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("Unable to load side chats"))
    expect(app.captureCharFrame()).not.toContain("No side chats")
  } finally {
    app.renderer.destroy()
  }
})
