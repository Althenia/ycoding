/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect, createSignal, onMount } from "solid-js"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { createApi, createEventStream, createFetch, json, sessionSnapshot } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type { FetchHandler } from "../../fixture/tui-client"

test("releasing a retained inventory immediately returns inactive metadata to its cache bound", async () => {
  const fixture = await mount(() => undefined)
  try {
    const ids = new Set(Array.from({ length: 100 }, (_, index) => `ses_retained_${index}`))
    const release = fixture.data.session.retain(ids)
    for (const id of ids) await fixture.data.session.message.sync(id)
    for (const id of ids) fixture.data.session.message.evict(id)
    expect(fixture.data.session.list()).toHaveLength(100)
    release()
    expect(fixture.data.session.list()).toHaveLength(50)
    release()
    expect(fixture.data.session.list()).toHaveLength(50)
  } finally {
    fixture.destroy()
  }
})

test("disposing during an outstanding read prevents queued activity refreshes", async () => {
  const gate = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  let reads = 0
  const fixture = await mount((url) => {
    if (url.pathname !== "/api/session/outstanding") return undefined
    reads++
    started.resolve()
    return gate.promise.then((response) => response.clone())
  })
  await started.promise
  fixture.events.emit({ id: "evt_activity", type: "session.execution.started", created: 1,
    data: { sessionID: "ses_active" }, durable: { aggregateID: "ses_active", seq: 1, version: 1 } })
  await fixture.waitFor(() => fixture.data.session.status("ses_active") === "running")
  fixture.destroy()
  gate.resolve(json({ data: [], running: [], failed: [], lost: [] }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(reads).toBe(1)
})

for (const disconnected of [false, true]) {
  test(disconnected
    ? "disposing the data owner settles a cancelled metadata read while disconnected"
    : "disposing the data owner cancels its unresolved Session metadata read", async () => {
    const response = Promise.withResolvers<Response>()
    const requested = Promise.withResolvers<void>()
    let signal: AbortSignal | undefined
    let requests = 0
    const fixture = await mount((url, request) => {
      if (url.pathname !== "/api/session/ses_disposed_metadata/permission") return undefined
      requests++
      signal = request.signal
      const cancel = () => response.reject(new Error("Session metadata read aborted"))
      if (signal.aborted) cancel()
      else signal.addEventListener("abort", cancel, { once: true })
      requested.resolve()
      return response.promise.finally(() => request.signal.removeEventListener("abort", cancel))
    })
    let settled = false
    const loading = fixture.data.session.permission.sync("ses_disposed_metadata").then(
      () => { settled = true },
      () => { settled = true },
    )
    let destroyed = false
    try {
      await requested.promise
      expect(settled).toBe(false)
      if (disconnected) {
        await fixture.waitFor(() => fixture.events.subscriptions() > 0)
        fixture.events.disconnect()
        await fixture.waitFor(() => signal?.aborted === true)
        expect(settled).toBe(false)
      }
      fixture.destroy()
      destroyed = true
      expect(signal?.aborted).toBe(true)
      await loading
      expect(settled).toBe(true)
      expect(requests).toBe(1)
      expect(fixture.data.session.permission.list("ses_disposed_metadata")).toBeUndefined()
    } finally {
      response.resolve(json({ data: [] }))
      await loading
      if (!destroyed) fixture.destroy()
    }
  })
}

for (const transition of ["eviction", "replacement", "disconnect", "disposal"] as const) {
  test(`${transition} cancels an unresolved older-page snapshot`, async () => {
    const sessionID = "ses_older_lifetime"
    const response = Promise.withResolvers<Response>()
    const requested = Promise.withResolvers<void>()
    let signal: AbortSignal | undefined
    let olderRequests = 0
    const recent = { id: "msg_recent", type: "user", text: "Current page", time: { created: 2 } }
    const older = { id: "msg_older", type: "user", text: "Older page", time: { created: 1 } }
    const fixture = await mount((url, request) => {
      if (url.pathname !== `/api/session/${sessionID}/snapshot`) return undefined
      if (!url.searchParams.has("before")) return sessionSnapshot(sessionID, [recent], { before: "opaque_older" })
      olderRequests++
      if (olderRequests > 1) return sessionSnapshot(sessionID, [older])
      signal = request.signal
      const cancel = () => response.reject(new Error("Older page aborted"))
      if (signal.aborted) cancel()
      else signal.addEventListener("abort", cancel, { once: true })
      requested.resolve()
      return response.promise.finally(() => request.signal.removeEventListener("abort", cancel))
    })
    let destroyed = false
    let paging = Promise.resolve(true)
    try {
      await fixture.data.session.message.sync(sessionID)
      paging = fixture.data.session.message.loadOlder(sessionID).then(() => true, () => false)
      await requested.promise
      expect(fixture.data.session.message.history(sessionID)?.status).toBe("paging")
      if (transition === "eviction") fixture.data.session.message.evict(sessionID)
      if (transition === "replacement") {
        fixture.data.session.message.invalidate(sessionID)
        await fixture.data.session.message.sync(sessionID)
      }
      if (transition === "disconnect") {
        await fixture.waitFor(() => fixture.events.subscriptions() > 0)
        const connected = Promise.withResolvers<void>()
        const unsubscribe = fixture.data.on("server.connected", () => connected.resolve())
        fixture.events.disconnect()
        await connected.promise
        unsubscribe()
      }
      if (transition === "disposal") {
        fixture.destroy()
        destroyed = true
      }
      expect(signal?.aborted).toBe(true)
      expect(await paging).toBe(true)
      expect(fixture.data.session.message.get(sessionID, older.id)).toBeUndefined()
      if (transition === "disposal") {
        await fixture.data.session.message.loadOlder(sessionID)
        expect(await fixture.data.session.message.find(sessionID, "msg_missing")).toBe(false)
        expect(olderRequests).toBe(1)
        return
      }
      await fixture.data.session.message.sync(sessionID)
      expect(fixture.data.session.message.history(sessionID)?.status).toBe("ready")
      await fixture.data.session.message.loadOlder(sessionID)
      expect(olderRequests).toBe(2)
      expect(fixture.data.session.message.list(sessionID).map((message) => message.id)).toEqual([older.id, recent.id])
      expect(fixture.data.session.message.history(sessionID)?.before).toBeUndefined()
    } finally {
      response.resolve(sessionSnapshot(sessionID, [older]))
      await paging
      if (!destroyed) fixture.destroy()
    }
  })
}

test("Find does not rehydrate an evicted Session after its older page is cancelled", async () => {
  const sessionID = "ses_find_evicted"
  const response = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const recent = { id: "msg_recent", type: "user", text: "Evicted row", time: { created: 2 } }
  let snapshots = 0
  const fixture = await mount((url, request) => {
    if (url.pathname !== `/api/session/${sessionID}/snapshot`) return undefined
    if (!url.searchParams.has("before")) {
      snapshots++
      return sessionSnapshot(sessionID, [recent], snapshots === 1 ? { before: "older_cursor" } : {})
    }
    const cancel = () => response.reject(new Error("Older page evicted"))
    request.signal.addEventListener("abort", cancel, { once: true })
    requested.resolve()
    return response.promise.finally(() => request.signal.removeEventListener("abort", cancel))
  })
  let finding = Promise.resolve(false)
  try {
    await fixture.data.session.message.sync(sessionID)
    finding = fixture.data.session.message.find(sessionID, "msg_missing")
    await requested.promise
    fixture.data.session.message.evict(sessionID)
    expect(await finding).toBe(false)
    expect(snapshots).toBe(1)
    expect(fixture.data.session.message.history(sessionID)).toBeUndefined()
    expect(fixture.data.session.message.list(sessionID)).toEqual([])
  } finally {
    fixture.destroy()
    response.resolve(sessionSnapshot(sessionID, [recent]))
    await finding
  }
}, 5000)

for (const fails of [false, true]) {
  test(fails
    ? "Find propagates a replacement snapshot failure after its older page is cancelled"
    : "Find yields while a replacement snapshot is pending and resumes from its cursor", async () => {
    const sessionID = "ses_find_replacement"
    const olderResponse = Promise.withResolvers<Response>()
    const replacement = Promise.withResolvers<Response>()
    const olderRequested = Promise.withResolvers<void>()
    const replacementRequested = Promise.withResolvers<void>()
    const recent = { id: "msg_recent", type: "user", text: "Current row", time: { created: 2 } }
    const next = { id: "msg_next", type: "user", text: "Replacement row", time: { created: 3 } }
    const target = { id: "msg_target", type: "user", text: "Find target", time: { created: 1 } }
    const cursors: string[] = []
    let snapshots = 0
    const fixture = await mount((url, request) => {
      if (url.pathname !== `/api/session/${sessionID}/snapshot`) return undefined
      const before = url.searchParams.get("before")
      if (!before) {
        if (snapshots++ === 0) return sessionSnapshot(sessionID, [recent], { before: "old_cursor" })
        replacementRequested.resolve()
        return replacement.promise
      }
      cursors.push(before)
      if (before === "new_cursor") return sessionSnapshot(sessionID, [target])
      const cancel = () => olderResponse.reject(new Error("Older page replaced"))
      request.signal.addEventListener("abort", cancel, { once: true })
      olderRequested.resolve()
      return olderResponse.promise.finally(() => request.signal.removeEventListener("abort", cancel))
    })
    let finding: Promise<{ found: boolean; error?: unknown }> = Promise.resolve({ found: false })
    let replacing = Promise.resolve()
    try {
      await fixture.data.session.message.sync(sessionID)
      let settled = false
      finding = fixture.data.session.message.find(sessionID, target.id).then(
        (found) => {
          settled = true
          return { found, error: undefined }
        },
        (error: unknown) => {
          settled = true
          return { found: false, error }
        },
      )
      await olderRequested.promise
      fixture.data.session.message.invalidate(sessionID)
      replacing = fixture.data.session.message.sync(sessionID).catch(() => undefined)
      await replacementRequested.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(cursors).toEqual(["old_cursor"])
      expect(fixture.data.session.message.history(sessionID)?.status).toBe("loading")
      replacement.resolve(fails
        ? json({ message: "Replacement unavailable" }, { status: 503 })
        : sessionSnapshot(sessionID, [recent, next], { before: "new_cursor" }))
      const result = await finding
      await replacing
      if (fails) {
        expect(result).toMatchObject({ found: false, error: { reason: "UnexpectedStatus", cause: { status: 503 } } })
        expect(cursors).toEqual(["old_cursor"])
        expect(fixture.data.session.message.history(sessionID)).toMatchObject({ status: "error", failedRead: "latest" })
      } else {
        expect(result).toEqual({ found: true, error: undefined })
        expect(cursors).toEqual(["old_cursor", "new_cursor"])
        expect(fixture.data.session.message.list(sessionID).map((message) => message.id)).toEqual([target.id, recent.id, next.id])
      }
    } finally {
      olderResponse.resolve(sessionSnapshot(sessionID, []))
      replacement.resolve(sessionSnapshot(sessionID, []))
      await Promise.all([finding, replacing])
      fixture.destroy()
    }
  }, 5000)
}

test("an older-page failure remains visible and allows retrying the same cursor", async () => {
  const sessionID = "ses_older_failure"
  const cursors: string[] = []
  const fixture = await mount((url) => {
    if (url.pathname !== `/api/session/${sessionID}/snapshot`) return undefined
    const before = url.searchParams.get("before")
    if (!before) return sessionSnapshot(sessionID, [], { before: "retry_cursor" })
    cursors.push(before)
    if (cursors.length === 1) return json({ message: "Older snapshot unavailable" }, { status: 503 })
    return sessionSnapshot(sessionID, [{ id: "msg_older", type: "user", text: "Recovered page", time: { created: 1 } }])
  })
  try {
    await fixture.data.session.message.sync(sessionID)
    await expect(fixture.data.session.message.loadOlder(sessionID)).rejects.toMatchObject({ reason: "UnexpectedStatus", cause: { status: 503 } })
    expect(fixture.data.session.message.history(sessionID)).toMatchObject({ status: "error", failedRead: "older", before: "retry_cursor" })
    await fixture.data.session.message.loadOlder(sessionID)
    expect(cursors).toEqual(["retry_cursor", "retry_cursor"])
    expect(fixture.data.session.message.get(sessionID, "msg_older")).toMatchObject({ text: "Recovered page" })
    expect(fixture.data.session.message.history(sessionID)?.status).toBe("ready")
  } finally {
    fixture.destroy()
  }
})

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
    waitFor: screen.waitFor,
    destroy() {
      screen.renderer.destroy()
      events.disconnect()
    },
  }
}
