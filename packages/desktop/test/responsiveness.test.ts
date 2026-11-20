import { expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import type { YCodingEvent } from "@ycoding-ai/client"
import { createEventRefresh } from "../src/event-refresh"
import { connectNative } from "../src/native-client"

const data = { sessionID: "ses_synthetic", assistantMessageID: "msg_synthetic", ordinal: 0, delta: "fragment" }
const text: YCodingEvent = { id: "evt_text", created: 1, type: "session.text.delta", data }
const reasoning: YCodingEvent = { id: "evt_reasoning", created: 2, type: "session.reasoning.delta", data }

function fixture(accept?: (event: YCodingEvent) => boolean) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  const events = new Set<(event: YCodingEvent) => void>()
  const resyncs = new Set<() => void>()
  const scheduled = new Set<() => void>()
  const observers: (() => void)[] = []
  const calls: string[] = []
  let scope: readonly [number, number] = [1, 1]
  let received = 0
  const owner = createEventRefresh({ queries, scope: () => scope, accept, source: {
    onEvent: (callback) => { events.add(callback); return () => { events.delete(callback) } },
    onResync: (callback) => { resyncs.add(callback); return () => { resyncs.delete(callback) } },
  }, event: () => { received++ }, resync: () => {}, schedule: (callback) => { scheduled.add(callback); return () => { scheduled.delete(callback) } } })
  const watch = (resource: string, sessionID = data.sessionID, revision = scope, read?: () => Promise<string>) => {
    const key = [resource, ...revision, sessionID]
    queries.setQueryData(key, "initial")
    const observer = new QueryObserver(queries, { queryKey: key, queryFn: () => { calls.push(`${resource}:${sessionID}`); return read?.() ?? Promise.resolve("updated") } })
    observer.subscribe(() => {})
    observers.push(() => observer.destroy())
    return () => queries.getQueryData(key)
  }
  const settle = async () => { await Promise.all(queries.getQueryCache().getAll().flatMap((query) => { const promise = query.promise; return promise ? [promise] : [] })); await new Promise<void>((resolve) => setImmediate(resolve)) }
  const flush = async () => { const callbacks = [...scheduled]; scheduled.clear(); callbacks.forEach((callback) => callback()); await settle() }
  return { queries, events, resyncs, scheduled, calls, owner, watch, settle, flush, received: () => received, replace: () => { scope = [2, 2] }, emit: (event: YCodingEvent) => events.forEach((callback) => callback(event)), resync: () => resyncs.forEach((callback) => callback()), close() { owner.dispose(); observers.forEach((destroy) => destroy()); queries.clear() } }
}

test("stream bursts update the observed transcript once without reading captured files", async () => {
  const owned = fixture()
  try {
    const result = owned.watch("messages")
    owned.watch("fileChanges")
    owned.watch("messages", "ses_other")
    for (let index = 0; index < 50; index++) { owned.emit(index % 2 ? text : reasoning); await owned.settle() }
    await owned.flush()
    expect(result()).toBe("updated")
    expect(owned.calls).toEqual(["messages:ses_synthetic"])
    expect(owned.received()).toBe(50)
  } finally { owned.close() }
})

test("retired snapshot events neither change live status nor schedule reads", async () => {
  const owned = fixture((event) => event.id !== text.id)
  try {
    owned.watch("messages")
    owned.emit(text)
    await owned.flush()
    expect(owned.received()).toBe(0)
    expect(owned.calls).toEqual([])
    owned.emit(reasoning)
    await owned.flush()
    expect(owned.received()).toBe(1)
    expect(owned.calls).toEqual(["messages:ses_synthetic"])
  } finally { owned.close() }
})

test("Session completion reconciles durable pending inputs and observed diagnostics", async () => {
  const owned = fixture()
  try {
    owned.watch("pendingInputs")
    owned.watch("sessionInsights")
    owned.emit({ id: "evt_idle", created: 3, type: "session.idle", data: { sessionID: data.sessionID } })
    await owned.flush()
    expect(owned.calls.toSorted()).toEqual(["pendingInputs:ses_synthetic", "sessionInsights:ses_synthetic"])
  } finally { owned.close() }
})

test("withdrawn and steered inputs reconcile the pending list and transcript of their Session", async () => {
  for (const type of ["session.input.withdrawn", "session.input.steered"] as const) {
    const owned = fixture()
    try {
      owned.watch("pendingInputs")
      owned.watch("messages")
      owned.emit({ id: `evt_${type}`, created: 4, durable: { aggregateID: data.sessionID, seq: 4, version: 1 }, type, data: { sessionID: data.sessionID, inputID: "msg_synthetic_pending" } })
      await owned.flush()
      expect(owned.calls.toSorted()).toEqual(["messages:ses_synthetic", "pendingInputs:ses_synthetic"])
    } finally { owned.close() }
  }
})

test("family decisions: child review settlement refreshes the active root inbox once", async () => {
  const owned = fixture()
  try {
    const inbox = owned.watch("requests", "ses_root")
    owned.watch("requests", "ses_retired", [0, 0])
    owned.watch("messages", "ses_root")
    owned.watch("fileChanges", "ses_root")
    for (let index = 0; index < 20; index++) owned.emit({ id: `evt_review_${index}`, created: index, durable: { aggregateID: data.sessionID, seq: index + 1, version: 1 }, type: "session.review.decided", data: { sessionID: data.sessionID, itemID: "rvw_synthetic", decision: { kind: "question", answers: [["Local"]] } } })
    await owned.flush()
    expect(inbox()).toBe("updated")
    expect(owned.calls).toEqual(["requests:ses_root"])
  } finally { owned.close() }
})

test("family decisions: guardrail events refresh root and owner without reading unrelated Sessions", async () => {
  const owned = fixture()
  try {
    owned.watch("requests", "ses_root")
    owned.watch("requests")
    owned.watch("requests", "ses_unrelated")
    owned.emit({ id: "evt_cancelled", created: 1, type: "guardrail.cancelled", data: { rootSessionID: "ses_root", sessionID: data.sessionID, requestID: "grq_synthetic" } })
    await owned.flush()
    expect(owned.calls.toSorted()).toEqual(["requests:ses_root", "requests:ses_synthetic"])
  } finally { owned.close() }
})

test("family decisions: durable guardrail decisions refresh the named review Session", async () => {
  const owned = fixture()
  try {
    owned.watch("requests", "ses_root")
    owned.watch("requests")
    owned.watch("requests", "ses_unrelated")
    owned.emit({ id: "evt_decided", created: 1, durable: { aggregateID: "ses_root", seq: 1, version: 1 }, type: "session.guardrail.decided", data: { sessionID: "ses_root", reviewSessionID: data.sessionID, requestID: "grq_synthetic", reply: "once" } })
    await owned.flush()
    expect(owned.calls.toSorted()).toEqual(["requests:ses_root", "requests:ses_synthetic"])
  } finally { owned.close() }
})

test("an event received during a transcript read is reconciled after that read settles", async () => {
  const owned = fixture()
  const pending = Promise.withResolvers<string>()
  let reads = 0
  try {
    const result = owned.watch("messages", data.sessionID, [1, 1], () => ++reads === 1 ? pending.promise : Promise.resolve("latest"))
    owned.emit(text)
    const first = owned.flush()
    owned.emit(reasoning)
    pending.resolve("earlier")
    await first
    await owned.flush()
    expect(result()).toBe("latest")
    expect(owned.calls).toEqual(["messages:ses_synthetic", "messages:ses_synthetic"])
  } finally { pending.resolve("cleanup"); owned.close() }
})

test("an event during an independently started read still obtains a newer snapshot", async () => {
  const owned = fixture()
  const pending = Promise.withResolvers<string>()
  let reads = 0
  try {
    const result = owned.watch("messages", data.sessionID, [1, 1], () => ++reads === 1 ? pending.promise : Promise.resolve("latest"))
    const initial = owned.queries.refetchQueries({ queryKey: ["messages"] })
    owned.emit(text)
    const queued = owned.flush()
    pending.resolve("earlier")
    await Promise.all([initial, queued])
    await owned.flush()
    expect(result()).toBe("latest")
    expect(owned.calls).toEqual(["messages:ses_synthetic", "messages:ses_synthetic"])
  } finally { pending.resolve("cleanup"); owned.close() }
})

test("resync bursts refresh current active queries once and leave retired connections alone", async () => {
  const owned = fixture()
  try {
    owned.watch("messages")
    owned.watch("requests")
    owned.watch("messages", data.sessionID, [0, 0])
    for (let index = 0; index < 20; index++) { owned.resync(); await owned.settle() }
    expect(owned.calls).toEqual([])
    await owned.flush()
    expect(owned.calls.sort()).toEqual(["messages:ses_synthetic", "requests:ses_synthetic"])
  } finally { owned.close() }
})

test("connection replacement and disposal discard queued work and reject late callbacks", async () => {
  const owned = fixture()
  try {
    owned.watch("messages")
    const late = [...owned.events][0]!
    owned.emit(text)
    owned.replace()
    owned.watch("messages", data.sessionID, [2, 2])
    await owned.flush()
    expect(owned.calls).toEqual([])
    owned.emit(text)
    owned.owner.dispose()
    late(reasoning)
    await owned.flush()
    expect(owned.calls).toEqual([])
    expect(owned.received()).toBe(2)
    expect(owned.events.size + owned.resyncs.size + owned.scheduled.size).toBe(0)
  } finally { owned.close() }
})

test("file capture and execution settlement refresh affected state without reading another Session", async () => {
  const owned = fixture()
  try {
    for (const resource of ["messages", "fileChanges", "requests", "session", "sessions"]) owned.watch(resource)
    owned.watch("fileChanges", "ses_other")
    owned.emit({ id: "evt_file", created: 3, durable: { aggregateID: data.sessionID, seq: 1, version: 1 }, type: "session.file-change.recorded", data: { sessionID: data.sessionID, change: { path: "synthetic.ts", patch: "", additions: 1, deletions: 0 } } })
    owned.emit({ id: "evt_settled", created: 4, durable: { aggregateID: data.sessionID, seq: 2, version: 1 }, type: "session.execution.succeeded", data: { sessionID: data.sessionID } })
    await owned.flush()
    expect(owned.calls.sort()).toEqual(["fileChanges:ses_synthetic", "messages:ses_synthetic", "requests:ses_synthetic", "session:ses_synthetic", "sessions:ses_synthetic"])
  } finally { owned.close() }
})

async function streamFixture() {
  const owned = fixture()
  const abort = new AbortController()
  const encoder = new TextEncoder()
  const received = new Map<string, () => void>()
  const routes: string[] = []
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let aborted = false
  const native = await connectNative({ url: "http://synthetic.invalid" }, { signal: abort.signal, onEvent: (event) => { owned.emit(event); received.get(event.id)?.() }, fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const route = new URL(request.url).pathname
    if (route === "/api/health") return Response.json({ healthy: true, version: "synthetic", pid: 101, sourceEpoch: "synthetic" })
    if (route === "/api/event") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller
      controller.enqueue(encoder.encode('data: {"type":"server.connected","properties":{}}\n\n'))
      request.signal.addEventListener("abort", () => { aborted = true; controller.close() }, { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
    routes.push(route)
    if (route === `/api/session/${data.sessionID}/message`) return Response.json({ data: [{ id: "msg_user", sessionID: data.sessionID, type: "user", text: "SSE refreshed", files: [], agents: [], time: { created: 1 } }] })
    if (route === "/api/session/ses_root/review") return Response.json({ data: [] })
    throw new Error(`Unexpected synthetic request: ${route}`)
  }, { preconnect: () => {} }) })
  return { ...owned, native, routes, aborted: () => aborted, send(events: readonly YCodingEvent[]) {
    const last = events.at(-1)
    if (!last || !stream) throw new Error("Synthetic SSE stream is not ready")
    const delivered = Promise.withResolvers<void>()
    received.set(last.id, delivered.resolve)
    const bytes = encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
    const middle = Math.floor(bytes.length / 2)
    stream.enqueue(bytes.slice(0, middle))
    stream.enqueue(bytes.slice(middle))
    return delivered.promise.finally(() => received.delete(last.id))
  }, async close() { owned.close(); abort.abort(); await native.close() } }
}

test("decoded synthetic SSE fragments coalesce into one canonical transcript request", async () => {
  const owned = await streamFixture()
  try {
    const result = owned.watch("messages", data.sessionID, [1, 1], async () => (await owned.native.api.message.list({ sessionID: data.sessionID })).find((message) => message.type === "user")?.text ?? "missing")
    owned.watch("fileChanges")
    const baseline = owned.received()
    await owned.send(Array.from({ length: 50 }, (_, index) => ({ ...(index % 2 ? text : reasoning), id: `evt_fragment_${index}`, data: { ...data, delta: "synthetic UTF-8 · λ" } })))
    await owned.flush()
    expect(owned.received() - baseline).toBe(50)
    expect(result()).toBe("SSE refreshed")
    expect(owned.calls).toEqual(["messages:ses_synthetic"])
    expect(owned.routes).toEqual(["/api/session/ses_synthetic/message"])
  } finally { await owned.close() }
})

test("decoded child review SSE refreshes the parent inbox without reading its transcript or captured files", async () => {
  const owned = await streamFixture()
  try {
    const inbox = owned.watch("requests", "ses_root", [1, 1], async () => JSON.stringify(await owned.native.api.review.list({ sessionID: "ses_root" })))
    owned.watch("messages", "ses_root")
    owned.watch("fileChanges", "ses_root")
    await owned.send([{ id: "evt_review_settled", created: 1, durable: { aggregateID: data.sessionID, seq: 1, version: 1 }, type: "session.review.decided", data: { sessionID: data.sessionID, itemID: "rvw_synthetic", decision: { kind: "question", answers: [["Local"]] } } }])
    await owned.flush()
    expect(inbox()).toBe("[]")
    expect(owned.calls).toEqual(["requests:ses_root"])
    expect(owned.routes).toEqual(["/api/session/ses_root/review"])
  } finally { await owned.close() }
})

test("disposed query ownership ignores subsequent decoded SSE and native close aborts the stream", async () => {
  const owned = await streamFixture()
  try {
    owned.watch("messages")
    await owned.send([text])
    const baseline = owned.received()
    owned.owner.dispose()
    await owned.send([reasoning])
    await owned.flush()
    expect(owned.received()).toBe(baseline)
    expect(owned.calls).toEqual([])
    expect(owned.routes).toEqual([])
    await owned.native.close()
    expect(owned.aborted()).toBe(true)
    expect(owned.events.size + owned.resyncs.size + owned.scheduled.size).toBe(0)
  } finally { await owned.close() }
})
