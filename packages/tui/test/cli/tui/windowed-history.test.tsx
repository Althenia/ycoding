/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { SessionMessageInfo, YCodingEvent } from "@ycoding-ai/client"
import { onMount } from "solid-js"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { createSessionRows } from "../../../src/routes/session/rows"
import {
  createApi,
  createEventStream,
  createFetch,
  json,
  sessionSnapshot,
  type FetchHandler,
} from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

const sessionID = "ses_windows"
const users = (start: number, end: number): SessionMessageInfo[] =>
  Array.from({ length: end - start }, (_, offset) => ({
    id: `msg_${String(start + offset).padStart(6, "0")}`,
    type: "user",
    text: `Message ${start + offset}`,
    time: { created: start + offset },
  }))

test("a canonical snapshot replaces Session metadata and clears an omitted prior model", async () => {
  let selected = true
  const fixture = await mount((url) =>
    url.pathname.endsWith("/snapshot")
      ? sessionSnapshot(sessionID, [], {
          session: { model: selected ? { providerID: "fixture", id: "fixture" } : undefined },
        })
      : undefined,
  )
  try {
    await fixture.data.session.message.sync(sessionID)
    expect(fixture.data.session.get(sessionID)?.model).toEqual({ providerID: "fixture", id: "fixture" })
    selected = false
    fixture.data.session.message.invalidate(sessionID)
    await fixture.data.session.message.sync(sessionID)
    expect(fixture.data.session.get(sessionID)?.model).toBeUndefined()
  } finally {
    fixture.destroy()
  }
})

test("opens only the newest 100 messages and merges older opaque-cursor pages in ascending order", async () => {
  const searches: string[] = []
  const fixture = await mount((url) => {
    if (url.pathname.endsWith("/message")) return json({ data: users(0, 200) })
    if (!url.pathname.endsWith("/snapshot")) return undefined
    searches.push(url.search)
    return url.searchParams.has("before")
      ? sessionSnapshot(sessionID, users(0, 100))
      : sessionSnapshot(sessionID, users(100, 200), { before: "opaque_oldest" })
  })
  try {
    await fixture.data.session.message.sync(sessionID)
    expect(fixture.data.session.message.list(sessionID).map((message) => message.id)).toEqual(
      users(100, 200).map((message) => message.id),
    )
    expect(searches).toEqual(["?limit=100"])
    await fixture.data.session.message.loadOlder(sessionID)
    expect(searches).toEqual(["?limit=100", "?limit=100&before=opaque_oldest"])
    expect(fixture.data.session.message.list(sessionID).map((message) => message.id)).toEqual(
      users(0, 200).map((message) => message.id),
    )
    expect(fixture.data.session.message.history(sessionID)?.before).toBeUndefined()
  } finally {
    fixture.destroy()
  }
})

test("newest refresh retains loaded older rows and protected promoted inputs until canonically observed", async () => {
  let latest = users(100, 200)
  const fixture = await mount((url) => {
    if (!url.pathname.endsWith("/snapshot")) return undefined
    return url.searchParams.has("before")
      ? sessionSnapshot(sessionID, users(0, 100), { before: "older_again" })
      : sessionSnapshot(sessionID, latest, { before: "older_first" })
  })
  try {
    await fixture.data.session.message.sync(sessionID)
    await fixture.data.session.message.loadOlder(sessionID)
    await fixture.deliver({
      id: "evt_admitted",
      created: 201,
      type: "session.input.admitted",
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: {
        sessionID,
        inputID: "msg_protected",
        input: { type: "user", data: { text: "protected steer" }, delivery: "steer" },
      },
    })
    await fixture.deliver({
      id: "evt_promoted",
      created: 202,
      type: "session.input.promoted",
      durable: { aggregateID: sessionID, seq: 2, version: 1 },
      data: { sessionID, inputID: "msg_protected" },
    })
    latest = users(110, 210)
    fixture.data.session.message.invalidate(sessionID)
    await fixture.data.session.message.sync(sessionID)
    expect(fixture.data.session.message.get(sessionID, "msg_000000")).toBeDefined()
    expect(fixture.data.session.message.get(sessionID, "msg_000105")).toBeUndefined()
    expect(fixture.data.session.message.get(sessionID, "msg_protected")).toMatchObject({ text: "protected steer" })
    expect(fixture.data.session.message.history(sessionID)?.before).toBe("older_again")
    latest = [...latest, { id: "msg_protected", type: "user", text: "canonical steer", time: { created: 202 } }]
    fixture.data.session.message.invalidate(sessionID)
    await fixture.data.session.message.sync(sessionID)
    expect(fixture.data.session.message.get(sessionID, "msg_protected")).toMatchObject({ text: "canonical steer" })
  } finally {
    fixture.destroy()
  }
})

test("a resident completed compaction stops paging and prunes its covered boundary", async () => {
  let requests = 0
  const checkpoint: SessionMessageInfo = {
    id: "msg_checkpoint",
    type: "compaction",
    jobID: "cmp_checkpoint",
    trigger: "manual",
    status: "completed",
    revision: 1,
    boundary: { messageID: "msg_000050", seq: 50 },
    metrics: { excludedMessages: 51, excludedParts: 0, inputTokens: 1000, retainedTokens: 100 },
    time: { created: 90 },
  }
  const fixture = await mount((url) => {
    if (!url.pathname.endsWith("/snapshot")) return undefined
    requests++
    return url.searchParams.has("before")
      ? sessionSnapshot(sessionID, [...users(0, 90), checkpoint], { before: "covered" })
      : sessionSnapshot(sessionID, users(100, 200), { before: "checkpoint_page" })
  })
  try {
    await fixture.data.session.message.sync(sessionID)
    await fixture.data.session.message.loadOlder(sessionID)
    expect(fixture.data.session.message.get(sessionID, "msg_000050")).toBeUndefined()
    expect(fixture.data.session.message.get(sessionID, "msg_000051")).toBeDefined()
    expect(fixture.data.session.message.history(sessionID)).toMatchObject({ checkpoint: true })
    await fixture.data.session.message.loadOlder(sessionID)
    expect(requests).toBe(2)
    expect(await fixture.data.session.message.find(sessionID, "msg_000001")).toBe(false)
    expect(requests).toBe(2)
  } finally {
    fixture.destroy()
  }
})

test("eviction and newest replacement fence a late older read without resurrecting payloads", async () => {
  const gate = Promise.withResolvers<Response>()
  const fixture = await mount((url) =>
    !url.pathname.endsWith("/snapshot")
      ? undefined
      : url.searchParams.has("before")
        ? gate.promise
        : sessionSnapshot(sessionID, users(100, 200), { before: "held_older" }),
  )
  try {
    await fixture.data.session.message.sync(sessionID)
    const older = fixture.data.session.message.loadOlder(sessionID)
    fixture.data.session.message.evict(sessionID)
    gate.resolve(sessionSnapshot(sessionID, users(0, 100)))
    await older
    expect(fixture.data.session.message.list(sessionID)).toEqual([])
    expect(fixture.data.session.message.history(sessionID)).toBeUndefined()
  } finally {
    gate.resolve(sessionSnapshot(sessionID, []))
    fixture.destroy()
  }
})

test("snapshot watermark discards replayed durable events before row and store consumers", async () => {
  const fixture = await mount(
    (url) =>
      url.pathname.endsWith("/snapshot")
        ? sessionSnapshot(sessionID, users(100, 102), {
            sourceEpoch: "source-1",
            watermark: { type: "log.synced", aggregateID: sessionID, seq: 5 },
          })
        : undefined,
    true,
  )
  try {
    await fixture.data.session.message.sync(sessionID)
    fixture.events.emit({
      id: "evt_replayed",
      created: 200,
      sourceEpoch: "source-1",
      type: "session.context.observed",
      durable: { aggregateID: sessionID, seq: 5, version: 1 },
      data: { sessionID, source: "session-state", text: "must not appear" },
    })
    await fixture.deliver({
      id: "evt_fresh",
      created: 201,
      sourceEpoch: "source-1",
      type: "session.context.observed",
      durable: { aggregateID: sessionID, seq: 6, version: 1 },
      data: { sessionID, source: "session-state", text: "fresh context" },
    })
    expect(fixture.data.session.message.get(sessionID, "msg_replayed")).toBeUndefined()
    expect(fixture.data.session.message.get(sessionID, "msg_fresh")).toMatchObject({ text: "fresh context" })
    expect(fixture.rows().some((row) => row.type === "message" && row.messageID === "msg_replayed")).toBe(false)
  } finally {
    fixture.destroy()
  }
})

test("gap recovery restores missing parts without losing live text received during the read", async () => {
  const assistant = {
    id: "msg_assistant",
    type: "assistant" as const,
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    content: [{ type: "text" as const, text: "base" }],
    time: { created: 1 },
  }
  let reads = 0
  const fixture = await mount((url) => {
    if (!url.pathname.endsWith("/snapshot")) return undefined
    reads++
    return sessionSnapshot(
      sessionID,
      [
        reads === 1
          ? assistant
          : { ...assistant, content: [...assistant.content, { type: "text", text: "recovered missing part" }] },
      ],
      {
        watermark: { type: "log.synced", aggregateID: sessionID, seq: reads === 1 ? 5 : 7 },
      },
    )
  })
  try {
    await fixture.data.session.message.sync(sessionID)
    await fixture.deliver({
      id: "evt_delta",
      created: 2,
      type: "session.text.delta",
      data: { sessionID, assistantMessageID: assistant.id, ordinal: 0, delta: " live" },
    })
    await fixture.deliver({
      id: "evt_gap",
      created: 3,
      type: "session.context.observed",
      durable: { aggregateID: sessionID, seq: 7, version: 1 },
      data: { sessionID, source: "session-state", text: "gap recovery" },
    })
    await fixture.data.session.message.sync(sessionID)
    expect(reads).toBe(2)
    const message = fixture.data.session.message.get(sessionID, assistant.id)
    expect(message?.type).toBe("assistant")
    if (message?.type !== "assistant") return
    expect(message.content.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "base live",
      "recovered missing part",
    ])
  } finally {
    fixture.destroy()
  }
})

async function mount(handler: FetchHandler, withRows = false) {
  const events = createEventStream()
  const calls = createFetch(handler, events)
  let data!: ReturnType<typeof useData>
  let rows: ReturnType<typeof createSessionRows> = []
  const ready = Promise.withResolvers<void>()
  function Probe() {
    data = useData()
    if (withRows) rows = createSessionRows(() => sessionID)
    onMount(ready.resolve)
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  await ready.promise
  return {
    data,
    events,
    rows: () => rows,
    destroy: () => app.renderer.destroy(),
    async deliver(event: YCodingEvent) {
      const delivered = Promise.withResolvers<void>()
      const unsubscribe = data.on(event.type, (value) => {
        if (value.id === event.id) delivered.resolve()
      })
      events.emit(event)
      await delivered.promise
      unsubscribe()
    },
  }
}
