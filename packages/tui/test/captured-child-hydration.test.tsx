/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { createCapturedChildHydration } from "../src/routes/session/captured-child-hydration"
import { createApi, createEventStream, createFetch, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"

async function mount() {
  const [selection, select] = createSignal("ses_first")
  const events = createEventStream()
  const membershipGates = new Map<string, Promise<void>>()
  const messageGates = new Map<string, Promise<void>>()
  const failures = new Set<string>()
  const membershipFailures = new Set<string>()
  const requests: string[] = []
  let hydration!: ReturnType<typeof createCapturedChildHydration>
  let data!: ReturnType<typeof useData>
  const child = (sessionID: string) => (sessionID === "ses_first" ? "ses_old" : "ses_new")
  const transport = createFetch(async (url) => {
    requests.push(url.pathname)
    const parentID = ["ses_first", "ses_second"].find((id) => url.pathname === `/api/session/${id}/subagent`)
    if (parentID) {
      await membershipGates.get(parentID)
      if (membershipFailures.has(parentID)) return json({ message: "Membership unavailable" }, { status: 500 })
      return json({
        data: [
          {
            parentID,
            sessionID: child(parentID),
            agent: "general",
            description: "Read child",
            background: true,
            state: "running",
            revision: 1,
            time: { created: 1, updated: 1 },
          },
        ],
        cursor: {},
      })
    }
    const childID = ["ses_old", "ses_new"].find((id) => url.pathname === `/api/session/${id}/message`)
    if (childID) {
      await messageGates.get(childID)
      return failures.has(childID)
        ? json({ message: "Read failed" }, { status: 500 })
        : json({ data: [{ id: `msg_${childID}`, type: "user", text: childID, time: { created: 1 } }], cursor: {} })
    }
    if (url.pathname === "/api/session/ses_old" || url.pathname === "/api/session/ses_new")
      return json({
        data: {
          id: url.pathname.split("/").at(-1),
          parentID: url.pathname.endsWith("ses_old") ? "ses_first" : "ses_second",
        },
      })
    return undefined
  }, events)
  function Probe() {
    data = useData()
    hydration = createCapturedChildHydration({
      sessionID: selection,
      parentID: () => undefined,
      dispatched: () => child(selection()),
    })
    return (
      <text>
        {selection()} {hydration.ids().join(",")} {JSON.stringify(hydration.status([child(selection())]) ?? "ready")}
      </text>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClientProvider api={createApi(transport.fetch)}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ClientProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 5 },
  )
  return {
    app,
    data: () => data,
    hydration: () => hydration,
    select,
    events,
    membershipGates,
    messageGates,
    failures,
    membershipFailures,
    requests,
    child,
  }
}

test("an obsolete membership result cannot authorize or read a previous selection's child", async () => {
  const fixture = await mount()
  let release!: () => void
  fixture.membershipGates.set(
    "ses_first",
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  fixture.app.renderer.start()
  try {
    await fixture.app.waitForFrame((frame) => frame.includes('"loading":true'))
    fixture.select("ses_second")
    await fixture.app.waitForFrame((frame) => frame.includes('ses_second ses_new "ready"'))
    release()
    await fixture.app.renderOnce()
    expect(fixture.hydration().ids()).toEqual(["ses_new"])
    expect(fixture.requests).not.toContain("/api/session/ses_old/message")
  } finally {
    release()
    fixture.app.renderer.destroy()
    fixture.events.disconnect()
  }
})

test("a late failed child read cannot overwrite the new selection and shared in-flight reads coalesce", async () => {
  const fixture = await mount()
  let release!: () => void
  fixture.messageGates.set(
    "ses_old",
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  fixture.failures.add("ses_old")
  fixture.app.renderer.start()
  try {
    await fixture.app.waitForFrame((frame) => frame.includes("ses_first ses_old") && frame.includes('"loading":true'))
    const pending = fixture
      .data()
      .session.message.sync("ses_old")
      .then(
        () => "ready",
        () => "failed",
      )
    fixture.select("ses_second")
    await fixture.app.waitForFrame((frame) => frame.includes('ses_second ses_new "ready"'))
    release()
    expect(await pending).toBe("failed")
    expect(fixture.hydration().ids()).toEqual(["ses_new"])
    expect(fixture.hydration().status(["ses_new"])).toBeUndefined()
    expect(fixture.requests.filter((url) => url === "/api/session/ses_old/message")).toHaveLength(1)
  } finally {
    release()
    fixture.app.renderer.destroy()
    fixture.events.disconnect()
  }
})

test("disconnect retains authorized captured children and marks the retained data incomplete until rehydration", async () => {
  const fixture = await mount()
  fixture.app.renderer.start()
  try {
    await fixture.app.waitForFrame((frame) => frame.includes('ses_first ses_old "ready"'))
    fixture.events.disconnect()
    await fixture.app.waitForFrame((frame) => frame.includes('"loading":true'))
    expect(fixture.hydration().ids()).toEqual(["ses_old"])
    expect(fixture.data().session.message.list("ses_old")).toHaveLength(1)
  } finally {
    fixture.app.renderer.destroy()
    fixture.events.disconnect()
  }
})

test("failed membership reads expose their error, read no unverified child, and recover on a relevant task update", async () => {
  const fixture = await mount()
  fixture.membershipFailures.add("ses_first")
  fixture.app.renderer.start()
  try {
    await fixture.app.waitForFrame((frame) => {
      const error = fixture.hydration().status(["ses_old"])?.error
      return error !== undefined && frame.includes(error)
    })
    expect(fixture.hydration().ids()).toEqual([])
    expect(fixture.requests).not.toContain("/api/session/ses_old/message")
    fixture.membershipFailures.clear()
    fixture.events.emit({
      id: "evt_membership_progress",
      created: 2,
      durable: { aggregateID: "ses_old", seq: 1, version: 1 },
      type: "session.task.updated",
      data: { sessionID: "ses_old", change: { type: "progressed", progress: { text: "Progress", time: 2 } } },
    })
    await fixture.app.waitForFrame((frame) => frame.includes('ses_first ses_old "ready"'))
    expect(fixture.requests.filter((url) => url === "/api/session/ses_old/message")).toHaveLength(1)
  } finally {
    fixture.app.renderer.destroy()
    fixture.events.disconnect()
  }
})
