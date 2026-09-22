/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { onMount } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { Footer } from "../src/routes/session/footer"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const parentID = "ses_parent"

test("refreshes a resident subagent summary after reconnect and rejects the pre-disconnect response", async () => {
  const events = createEventStream()
  let active = 1
  let state: SessionOrchestrationTask["state"] = "running"
  let activeRequests = 0
  let subagentRequests = 0
  let releaseStale!: () => void
  const stale = new Promise<void>((resolve) => {
    releaseStale = resolve
  })
  const calls = createFetch(async (url) => {
    if (url.pathname === "/api/session/active") {
      activeRequests++
      return json({ data: {} })
    }
    if (url.pathname !== `/api/session/${parentID}/subagent`) return undefined
    subagentRequests++
    if (subagentRequests === 2) {
      const response = subagentPage(1)
      await stale
      return json(response)
    }
    return json(subagentPage(active, state))
  }, events)
  let data!: ReturnType<typeof useData>

  function Fixture() {
    data = useData()
    onMount(() => void data.session.subagent.sync(parentID))
    return <Footer sessionID={parentID} autonomy={{ mode: "normal", yolo: false }} />
  }

  const config = createTuiResolvedConfig()
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <RouteProvider initialRoute={{ type: "session", sessionID: parentID }}>
                <ClientProvider api={createApi(calls.fetch)}>
                  <DataProvider>
                    <Fixture />
                  </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 3 },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("subagents 1"))
    expect(data.session.subagent.summary(parentID)?.active).toBe(1)

    data.session.subagent.invalidate(parentID)
    const pendingStale = data.session.subagent.sync(parentID)
    await waitFor(() => subagentRequests === 2, "pre-disconnect subagent request")

    active = 0
    events.disconnect()
    await waitFor(() => activeRequests === 2, "reconnected active-session snapshot")
    await waitFor(() => subagentRequests === 3, "resident subagent refresh")
    releaseStale()
    await pendingStale

    await app.waitForFrame((frame) => frame.includes("subagents 0"))
    expect(data.session.subagent.summary(parentID)).toEqual({ total: 0, active: 0, running: 0, waiting: 0 })

    active = 1
    state = "waiting"
    events.disconnect()
    await waitFor(() => activeRequests === 3, "second reconnected active-session snapshot")
    await waitFor(() => subagentRequests === 4, "waiting subagent refresh")
    await app.waitForFrame((frame) => frame.includes("subagents 1"))
    expect(data.session.subagent.summary(parentID)).toEqual({ total: 1, active: 1, running: 0, waiting: 1 })
  } finally {
    releaseStale()
    app.renderer.destroy()
    events.disconnect()
  }
}, 15_000)

function subagentPage(active: number, state: SessionOrchestrationTask["state"] = "running") {
  const task: SessionOrchestrationTask = {
    sessionID: "ses_child",
    parentID,
    description: "Review implementation",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6" },
    background: true,
    state,
    revision: 1,
    time: { created: 1, updated: 1 },
  }
  return {
    data: active === 0 ? [] : [task],
    summary: {
      total: active,
      active,
      running: state === "running" ? active : 0,
      waiting: state === "waiting" ? active : 0,
    },
    cursor: {},
  }
}

async function waitFor(condition: () => boolean, description: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${description}`)
}
