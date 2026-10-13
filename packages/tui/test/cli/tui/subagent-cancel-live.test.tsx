/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider } from "../../../src/context/location"
import { RouteProvider } from "../../../src/context/route"
import { Composer } from "../../../src/routes/session/composer"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, json, sessionSnapshot } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const parentID = "ses_parent"
const childID = "ses_child"
const otherChildID = "ses_child_b"

type State = "running" | "cancelling" | "cancelled" | "completed"

function task(sessionID: string, state: State) {
  return {
    sessionID,
    parentID,
    description: "Long review",
    agent: "reviewer",
    model: { providerID: "openai", id: "gpt-5.6" },
    background: true,
    state,
    revision: 1,
    time: { created: 1, updated: 2 },
  }
}

const childInfo = {
  id: childID,
  parentID,
  projectID: "proj_test",
  title: "Long review",
  agent: "reviewer",
  location: { directory: "/tmp/ycoding/subagent-cancel-live" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

function page(tasks: Array<ReturnType<typeof task>>) {
  const active = tasks.filter((item) => ["starting", "running", "waiting", "cancelling"].includes(item.state)).length
  return json({
    data: tasks,
    summary: {
      total: tasks.length,
      active,
      running: tasks.filter((item) => item.state === "running").length,
      waiting: 0,
    },
    cursor: {},
  })
}

function LeaderProbe() {
  const leaderActive = Keymap.useLeaderActive()
  return <text>{leaderActive() ? "leader pending" : ""}</text>
}

let data!: ReturnType<typeof useData>

function DataProbe() {
  data = useData()
  return <box />
}

async function mount(fixture: ReturnType<typeof createFetch>) {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const config = createTuiResolvedConfig()
  return testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <Keymap.Provider config={config}>
              <ClientProvider api={createApi(fixture.fetch)}>
                <DataProvider>
                  <DataProbe />
                  <LocationProvider>
                    <RouteProvider initialRoute={{ type: "session", sessionID: parentID }}>
                      <LeaderProbe />
                      <ToastProvider>
                        <Composer sessionID={parentID} open defaultTab="subagents" />
                      </ToastProvider>
                    </RouteProvider>
                  </LocationProvider>
                </DataProvider>
              </ClientProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 32, kittyKeyboard: true },
  )
}

function durable(aggregateID: string, seq: number) {
  return { aggregateID, seq, version: 1 as const }
}

test("cancel shows cancelling from the durable event before the cancel response and cancelled after it", async () => {
  const events = createEventStream()
  let state: State = "running"
  let seq = 0
  let releaseCancel!: () => void
  const cancelSettled = new Promise<void>((resolve) => (releaseCancel = resolve))
  const fixture = createFetch(async (url, request) => {
    if (url.pathname === `/api/session/${parentID}/subagent`) return page([task(childID, state)])
    if (url.pathname === `/api/session/${parentID}/subagent/${childID}/cancel` && request.method === "POST") {
      state = "cancelling"
      events.emit({
        id: "evt_cancel_requested",
        created: 3,
        durable: durable(childID, ++seq),
        type: "session.task.updated",
        data: { sessionID: childID, change: { type: "cancel_requested" } },
      })
      await cancelSettled
      state = "cancelled"
      events.emit({
        id: "evt_cancelled",
        created: 4,
        durable: durable(childID, ++seq),
        type: "session.task.updated",
        data: { sessionID: childID, change: { type: "cancelled" } },
      })
      return json(task(childID, "cancelled"))
    }
    return undefined
  }, events)
  const app = await mount(fixture)
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("running") && frame.includes("Long review"))
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("leader pending"))
    app.mockInput.pressKey("k")
    await app.waitForFrame((frame) => frame.includes("cancelling") && !frame.includes("running"))
    releaseCancel()
    await app.waitForFrame((frame) => frame.includes("cancelled") && !frame.includes("cancelling"))
    await app.waitForFrame((frame) => /Subagents\s+0/.test(frame))
  } finally {
    app.renderer.destroy()
  }
})

test("external parallel cancels update an open panel and its count while a child history is resident", async () => {
  const events = createEventStream()
  let tasks: State[] = ["running", "running"]
  const fixture = createFetch((url) => {
    if (url.pathname === `/api/session/${parentID}/subagent`)
      return page([task(childID, tasks[0]!), task(otherChildID, tasks[1]!)])
    if (url.pathname === `/api/session/${childID}`) return json(childInfo)
    if (url.pathname === `/api/session/${childID}/snapshot`)
      return sessionSnapshot(childID, [], {
        watermark: { type: "log.synced", aggregateID: childID, seq: 5 } as never,
        session: { id: childID, parentID } as never,
      })
    return undefined
  }, events)
  const app = await mount(fixture)
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("running") && frame.includes("Long review"))
    await data.session.message.sync(childID)
    tasks = ["cancelled", "cancelled"]
    events.emit({
      id: "evt_a_req",
      created: 3,
      durable: durable(childID, 6),
      type: "session.task.updated",
      data: { sessionID: childID, change: { type: "cancel_requested" } },
    })
    events.emit({
      id: "evt_b_cancelled",
      created: 4,
      durable: durable(otherChildID, 1),
      type: "session.task.updated",
      data: { sessionID: otherChildID, change: { type: "cancelled" } },
    })
    events.emit({
      id: "evt_a_cancelled",
      created: 5,
      durable: durable(childID, 7),
      type: "session.task.updated",
      data: { sessionID: childID, change: { type: "cancelled" } },
    })
    await app.waitForFrame((frame) => /Subagents\s+0/.test(frame) && !frame.includes("running"))
    expect(app.captureCharFrame()).toContain("cancelled")
  } finally {
    app.renderer.destroy()
  }
})

test("a task event delivered after the resident child snapshot already includes it still updates the open parent panel", async () => {
  const events = createEventStream()
  let state: State = "running"
  const fixture = createFetch((url) => {
    if (url.pathname === `/api/session/${parentID}/subagent`) return page([task(childID, state)])
    if (url.pathname === `/api/session/${childID}`) return json(childInfo)
    if (url.pathname === `/api/session/${childID}/snapshot`)
      return sessionSnapshot(childID, [], {
        watermark: { type: "log.synced", aggregateID: childID, seq: 7 } as never,
        session: { id: childID, parentID } as never,
      })
    return undefined
  }, events)
  const app = await mount(fixture)
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("running") && frame.includes("Long review"))
    state = "cancelled"
    await data.session.message.sync(childID)
    events.emit({
      id: "evt_req_late",
      created: 3,
      durable: durable(childID, 6),
      type: "session.task.updated",
      data: { sessionID: childID, change: { type: "cancel_requested" } },
    })
    events.emit({
      id: "evt_cancelled_late",
      created: 4,
      durable: durable(childID, 7),
      type: "session.task.updated",
      data: { sessionID: childID, change: { type: "cancelled" } },
    })
    await app.waitForFrame((frame) => frame.includes("cancelled") && !frame.includes("running"))
  } finally {
    app.renderer.destroy()
  }
})

test("a session.task.updated completion while the panel is open updates the row without reopening it", async () => {
  const events = createEventStream()
  let state: State = "running"
  const fixture = createFetch((url) => {
    if (url.pathname === `/api/session/${parentID}/subagent`) return page([task(childID, state)])
    return undefined
  }, events)
  const app = await mount(fixture)
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("running") && frame.includes("Long review"))
    state = "completed"
    events.emit({
      id: "evt_completed",
      created: 3,
      durable: durable(childID, 1),
      type: "session.task.updated",
      data: { sessionID: childID, change: { type: "completed", excerpt: "done" } },
    })
    await app.waitForFrame((frame) => frame.includes("completed") && !frame.includes("running"))
    await app.waitForFrame((frame) => /Subagents\s+0/.test(frame))
  } finally {
    app.renderer.destroy()
  }
})
