/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect, createSignal, onMount } from "solid-js"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { createApi, createEventStream, createFetch, json, sessionSnapshot } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type { FetchHandler } from "../../fixture/tui-client"

test("200 actual-provider open and evict cycles retain a bounded inactive metadata cache", async () => {
  const events = createEventStream()
  const reads: string[] = []
  const calls = createFetch((url) => {
    const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
    if (!match || match[1] === "active") return undefined
    const sessionID = match[1]
    reads.push(url.pathname)
    if (match[2] === "snapshot") return sessionSnapshot(sessionID, [])
    if (["pending", "permission", "guardrail/request", "form", "todo"].includes(match[2] ?? ""))
      return json({ data: [] })
    if (match[2] === "subagent")
      return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
    if (!match[2])
      return json({
        data: {
          id: sessionID,
          projectID: "proj_test",
          title: sessionID,
          agent: "build",
          location: { directory: "/tmp/ycoding" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: Number(sessionID.slice(-3)) },
        },
      })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  const ready = Promise.withResolvers<void>()
  function Probe() {
    data = useData()
    onMount(ready.resolve)
    return <box />
  }
  const screen = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  await ready.promise
  try {
    for (let index = 0; index < 200; index++) {
      const sessionID = `ses_metadata_${String(index).padStart(3, "0")}`
      await data.session.sync(sessionID)
      await data.session.message.sync(sessionID)
      await data.session.pending.sync(sessionID)
      await data.session.diagnostics.sync(sessionID)
      await data.session.usage.sync(sessionID)
      await data.session.permission.sync(sessionID)
      await data.session.guardrail.sync(sessionID)
      await data.session.form.sync(sessionID)
      await data.session.todo.sync(sessionID)
      await data.session.subagent.sync(sessionID)
      data.session.message.evict(sessionID)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    Bun.gc(true)
    expect(data.session.message.memory("none").counts.residentSessions).toBe(0)
    expect(data.session.list().length).toBeLessThanOrEqual(50)
    for (const count of Object.values(data.session.message.memory("none").metadataKeys))
      expect(count).toBeLessThanOrEqual(50)
    expect(data.session.get("ses_metadata_000")).toBeUndefined()
    expect(data.session.family("ses_metadata_000")).toEqual([])
    expect(data.session.permission.list("ses_metadata_000")).toBeUndefined()
    expect(data.session.form.list("ses_metadata_000")).toBeUndefined()
    expect(data.session.subagent.page("ses_metadata_000")).toBeUndefined()
    const previous = reads.length
    await data.session.sync("ses_metadata_000")
    await data.session.message.sync("ses_metadata_000")
    await data.session.pending.sync("ses_metadata_000")
    await data.session.diagnostics.sync("ses_metadata_000")
    await data.session.usage.sync("ses_metadata_000")
    await data.session.permission.sync("ses_metadata_000")
    await data.session.guardrail.sync("ses_metadata_000")
    await data.session.form.sync("ses_metadata_000")
    await data.session.todo.sync("ses_metadata_000")
    await data.session.subagent.sync("ses_metadata_000")
    expect(reads.slice(previous).filter((path) => path.startsWith("/api/session/ses_metadata_000")).sort()).toEqual(
      ["", "/snapshot", "/pending", "/diagnostics", "/usage", "/permission", "/guardrail/request", "/guardrail", "/form", "/todo", "/subagent"].map((suffix) => `/api/session/ses_metadata_000${suffix}`).sort(),
    )
    expect(data.session.get("ses_metadata_000")?.id).toBe("ses_metadata_000")
    expect(data.session.subagent.page("ses_metadata_000")?.data).toEqual([])
  } finally {
    screen.renderer.destroy()
    events.disconnect()
  }
}, 60_000)

test("metadata pressure preserves selected and visible families and pending permission owners", async () => {
  const [selected, select] = createSignal<string | undefined>("ses_selected")
  const fixture = await mount((url) => {
    const sessionID = url.pathname.split("/")[3]
    if (url.pathname.endsWith("/permission"))
      return json({
        data:
          sessionID === "ses_request"
            ? [{ id: "per_waiting", sessionID, action: "read", resources: ["fixture.txt"] }]
            : [],
      })
    return undefined
  }, selected)
  try {
    await fixture.data.session.message.sync("ses_selected")
    await fixture.data.session.message.sync("ses_selected_child")
    fixture.data.session.message.evict("ses_selected_child")
    fixture.data.session.message.evict("ses_selected")
    await fixture.data.session.message.sync("ses_visible")
    await fixture.data.session.message.sync("ses_request")
    await fixture.data.session.permission.sync("ses_request")
    fixture.data.session.message.evict("ses_request")
    for (let index = 0; index < 200; index++) {
      const sessionID = `ses_pressure_${index}`
      await fixture.data.session.message.sync(sessionID)
      fixture.data.session.message.evict(sessionID)
    }
    Bun.gc(true)
    expect(fixture.data.session.get("ses_selected")?.id).toBe("ses_selected")
    expect(fixture.data.session.get("ses_selected_child")?.parentID).toBe("ses_selected")
    expect(fixture.data.session.family("ses_selected")).toEqual(["ses_selected", "ses_selected_child"])
    expect(fixture.data.session.get("ses_visible")?.id).toBe("ses_visible")
    expect(fixture.data.session.permission.list("ses_request")?.[0]?.id).toBe("per_waiting")
    expect(fixture.data.session.list().length).toBeLessThanOrEqual(54)
    select(undefined)
    expect(fixture.data.session.get("ses_selected")).toBeUndefined()
    expect(fixture.data.session.get("ses_selected_child")).toBeUndefined()
    expect(fixture.data.session.get("ses_request")?.id).toBe("ses_request")
  } finally {
    fixture.destroy()
  }
}, 60_000)

test("reconnect rehydrates released metadata and refreshes resident request state", async () => {
  let title = "Before reconnect"
  let permission = "per_before"
  const connected = Promise.withResolvers<void>()
  const fixture = await mount(
    (url) => {
      if (url.pathname === "/api/session")
        return json({
          data: [
            {
              id: "ses_released",
              projectID: "proj_test",
              title,
              agent: "build",
              location: { directory: "/tmp/ycoding" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 1 },
            },
          ],
          cursor: {},
        })
      if (url.pathname === "/api/session/ses_request/permission") {
        if (permission === "per_after") connected.resolve()
        return json({
          data: [{ id: permission, sessionID: "ses_request", action: "read", resources: ["fixture.txt"] }],
        })
      }
      if (url.pathname === "/api/session/ses_released")
        return json({
          data: {
            id: "ses_released",
            projectID: "proj_test",
            title,
            agent: "build",
            location: { directory: "/tmp/ycoding" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
          },
        })
      return undefined
    },
    undefined,
    true,
  )
  try {
    await fixture.data.session.message.sync("ses_released")
    fixture.data.session.message.evict("ses_released")
    for (let index = 0; index < 60; index++) {
      const sessionID = `ses_pressure_${index}`
      await fixture.data.session.message.sync(sessionID)
      fixture.data.session.message.evict(sessionID)
    }
    expect(fixture.data.session.get("ses_released")).toBeUndefined()
    await fixture.data.session.permission.sync("ses_request")
    title = "After reconnect"
    permission = "per_after"
    fixture.events.disconnect()
    await connected.promise
    await fixture.data.session.permission.sync("ses_request")
    await fixture.data.session.sync("ses_released")
    expect(fixture.data.session.get("ses_released")?.title).toBe("After reconnect")
    expect(fixture.data.session.permission.list("ses_request")?.[0]?.id).toBe("per_after")
    expect(fixture.data.session.list().length).toBeLessThanOrEqual(51)
  } finally {
    fixture.destroy()
  }
}, 30_000)

test("cache pressure preserves active families, queued inputs, forms and in-flight metadata reads", async () => {
  const requested = Promise.withResolvers<void>()
  const read = Promise.withResolvers<Response>()
  const fixture = await mount((url) => {
    if (url.pathname === "/api/session/ses_read/permission") {
      requested.resolve()
      return read.promise
    }
    if (url.pathname === "/api/session/ses_pending/pending")
      return json({
        data: [
          {
            id: "msg_pending",
            sessionID: "ses_pending",
            admittedSeq: 1,
            timeCreated: 1,
            type: "user",
            delivery: "queue",
            data: { text: "Waiting input" },
          },
        ],
      })
    if (url.pathname === "/api/session/ses_form/form")
      return json({
        data: [
          {
            id: "frm_waiting",
            sessionID: "ses_form",
            title: "Input required",
            fields: [{ key: "answer", type: "text", label: "Answer" }],
          },
        ],
      })
    return undefined
  })
  try {
    for (const sessionID of ["ses_running", "ses_running_child", "ses_pending", "ses_form", "ses_read"]) {
      await fixture.data.session.message.sync(sessionID)
      fixture.data.session.message.evict(sessionID)
    }
    const started = Promise.withResolvers<void>()
    const unsubscribe = fixture.data.on("session.execution.started", () => started.resolve())
    fixture.events.emit({
      id: "evt_running",
      created: 1,
      type: "session.execution.started",
      durable: { aggregateID: "ses_running_child", seq: 1, version: 1 },
      data: { sessionID: "ses_running_child" },
    })
    await started.promise
    unsubscribe()
    await fixture.data.session.pending.sync("ses_pending")
    await fixture.data.session.form.sync("ses_form")
    const loading = fixture.data.session.permission.sync("ses_read")
    await requested.promise
    for (let index = 0; index < 200; index++) {
      const sessionID = `ses_pressure_${index}`
      await fixture.data.session.message.sync(sessionID)
      fixture.data.session.message.evict(sessionID)
    }
    Bun.gc(true)
    expect(fixture.data.session.status("ses_running_child")).toBe("running")
    expect(fixture.data.session.family("ses_running")).toEqual(["ses_running", "ses_running_child"])
    expect(fixture.data.session.get("ses_running")?.id).toBe("ses_running")
    expect(fixture.data.session.pending.list("ses_pending")[0]?.id).toBe("msg_pending")
    expect(fixture.data.session.form.list("ses_form")?.[0]?.id).toBe("frm_waiting")
    expect(fixture.data.session.get("ses_read")?.id).toBe("ses_read")
    expect(fixture.data.session.list().length).toBeLessThanOrEqual(55)
    read.resolve(json({ data: [] }))
    await loading
    expect(fixture.data.session.get("ses_read")).toBeUndefined()
    expect(fixture.data.session.pending.list("ses_pending")[0]?.id).toBe("msg_pending")
  } finally {
    read.resolve(json({ data: [] }))
    fixture.destroy()
  }
}, 60_000)

async function mount(handler: FetchHandler, selectedSessionID?: () => string | undefined, refreshRequests = false) {
  const events = createEventStream()
  const calls = createFetch(async (url, request) => {
    const response = await handler(url, request)
    if (response) return response
    const match = url.pathname.match(/^\/api\/session\/([^/]+)\/snapshot$/)
    if (match)
      return sessionSnapshot(match[1], [], {
        session: match[1].endsWith("_child") ? { parentID: match[1].slice(0, -6) } : {},
      })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  const ready = Promise.withResolvers<void>()
  function Probe() {
    data = useData()
    const client = useClient()
    if (refreshRequests)
      createEffect(() => {
        if (client.connection.status() === "connected") void data.session.permission.sync("ses_request")
      })
    onMount(ready.resolve)
    return <box />
  }
  const screen = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider selectedSessionID={selectedSessionID}>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  await ready.promise
  return {
    data,
    events,
    destroy() {
      screen.renderer.destroy()
      events.disconnect()
    },
  }
}
