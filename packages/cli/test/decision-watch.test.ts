import { afterEach, expect, test } from "bun:test"
import type { DecisionItem, EventSubscribeOutput, SessionLogOutput, SessionSnapshotOutput, SessionSubagentListOutput, SessionTodoListOutput } from "@ycoding-ai/client/promise"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { namedOperation } from "@ycoding-ai/client/v5"
import { YCoding } from "@ycoding-ai/client/promise"
import { watchSession } from "../src/commands/handlers/decision/watch"
import { followFamily, type FollowReceipt } from "../src/commands/handlers/decision/follow"
import { validateFollowState, type FollowState } from "../src/commands/handlers/decision/follow-state"
import { sessionFixture, v5Server } from "./fixture/v5-server"

type LogType = Exclude<SessionLogOutput["type"], "log.synced">
type LogEvent = Exclude<SessionLogOutput, { type: "log.synced" }>
type Data<T extends LogType> = Extract<SessionLogOutput, { type: T }>["data"]

const base = Date.UTC(2026, 9, 29, 12, 0, 0)
const sourceEpoch = "source-1"
const iso = (seq: number) => new Date(base + seq * 1_000).toISOString()

function logEvent<T extends LogType>(type: T, seq: number, data: Data<T>, sessionID = "ses_target"): LogEvent {
  return { id: `evt_${sessionID}_${seq}`, created: base + seq * 1_000, sourceEpoch, type, durable: { aggregateID: sessionID, seq, version: 1 }, data } as LogEvent
}

const started = (seq: number, sessionID = "ses_target") => logEvent("session.execution.started", seq, { sessionID }, sessionID)
const consumed = (seq: number, inputIDs: [string, ...string[]], sessionID = "ses_target") =>
  logEvent("session.input.consumed", seq, { sessionID, inputIDs }, sessionID)
const promoted = (seq: number, inputID: string) => logEvent("session.input.promoted", seq, { sessionID: "ses_target", inputID })
const succeeded = (seq: number, sessionID = "ses_target") => logEvent("session.execution.succeeded", seq, { sessionID }, sessionID)
const text = (seq: number, value: string, phase: "commentary" | "final_answer") =>
  logEvent("session.text.ended", seq, { sessionID: "ses_target", assistantMessageID: "msg_assistant", ordinal: seq, text: value, phase })

type Message = SessionSnapshotOutput["messages"][number]
const user = (id: string) => ({ id, type: "user", text: "Task", time: { created: base } }) as Message
const assistant = (id: string, value: string) => ({ id, type: "assistant", agent: "build", model: { providerID: "synthetic", id: "model" },
  content: [{ type: "text", text: value }], time: { created: base } }) as Message

function decision(kind: DecisionItem["kind"], sessionID: string, id: string): DecisionItem {
  return {
    kind, sessionID, sessionTitle: sessionID === "ses_other" ? "Unrelated" : "Watched", directory: "/tmp/watched", id, summary: `${kind} summary ${id}`,
    decide: [{ label: "Once", argv: ["ycoding", "api", "session.review.decide", "--param", `sessionID=${sessionID}`, "--param", `itemID=${id}`, "-d", '{"decision":{"kind":"permission","reply":"once"}}'] }],
  }
}

function wake(sessionID: string): EventSubscribeOutput {
  return { id: `evt_wake_${Math.random()}`, created: base, type: "permission.asked", data: { id: "per_wake", sessionID, action: "shell", resources: ["true"] } }
}

type Task = SessionSubagentListOutput["data"][number]
type Todo = SessionTodoListOutput[number]

const ref = (seq: number) => ({ id: `evt_ses_target_${seq}`, seq })
const admitted = (seq: number, inputID: string) =>
  logEvent("session.input.admitted", seq, { sessionID: "ses_target", inputID, input: { type: "user", data: { text: "Task" }, delivery: "steer" } } as Data<"session.input.admitted">)
const receipt = (seq: number, inputID: string, assistantMessageID: string) =>
  logEvent("session.work.completed", seq, { sessionID: "ses_target", inputID, assistantMessageID })
const todo = (content: string, status: Todo["status"]): Todo => ({ content, status, priority: "high" })
const task = (sessionID: string, state: Task["state"], revision: number, extra: Partial<Task> = {}): Task => ({
  sessionID, parentID: "ses_target", description: `Synthetic ${sessionID}`, agent: "build", model: { providerID: "synthetic", id: "model" },
  background: true, state, revision, time: { created: base, updated: base }, ...extra,
})
const family = { ses_target: { title: "Watched" }, ses_child: { title: "Child", parentID: "ses_target" }, ses_other: { title: "Unrelated" } }

function printedRequest(stdout: string, operation: string) {
  const match = new RegExp(`ycoding api ${operation.replaceAll(".", "\\.")}((?: --param \\S+=\\S+)+)`).exec(stdout)
  expect(match).not.toBeNull()
  const params = Object.fromEntries([...match![1].matchAll(/--param (\w+)=(\S+)/g)].map((item) => [item[1], item[2]]))
  return { params, request: namedOperation(operation, params, undefined, new Headers()) }
}

function work(state: string, extra: Record<string, unknown> & { readonly todos?: { readonly open: number; readonly items: Todo[] } } = {}) {
  return { state, decisions: [], tasks: [], children: { total: 0, active: 0, running: 0, waiting: 0 }, running: [], lost: [], pending: 0, ...extra,
    todos: { sessionID: "ses_target", open: 0, items: [], ...extra.todos } }
}

type Control = {
  readonly subscriptions: number
  append: (sessionID: string, ...items: LogEvent[]) => void
  decisions: (items: DecisionItem[]) => void
  push: (event: EventSubscribeOutput) => void
  drop: () => void
  dropLogs: () => void
}

type Scenario = {
  readonly sessions?: Record<string, { readonly title: string; readonly parentID?: string }>
  readonly log?: Record<string, LogEvent[]>
  readonly decisions?: DecisionItem[]
  readonly messages?: Message[]
  readonly watermark?: number
  readonly stall?: string | { readonly operation: string; readonly sessionID: string }
  readonly active?: string[]
  readonly outstanding?: { readonly data?: string[]; readonly running?: string[]; readonly lost?: string[]; readonly failed?: string[] }
  readonly todos?: Record<string, Todo[]>
  readonly pending?: Record<string, number>
  readonly tasks?: Record<string, Task[]>
  readonly members?: { sessionID: string; owner?: { sessionID: string } }[]
  readonly onSubscribe?: (control: Control) => void
  readonly onLog?: (logs: Map<string, LogEvent[]>, count: number) => void
  readonly onFollow?: (sessionID: string, control: Control) => void
  readonly epoch?: () => string
  readonly onSnapshot?: (sessionID: string, control: Control) => void
  readonly readActive?: (control: Control) => Promise<readonly string[]>
}

const home = `${process.env.YCODING_TEST_XDG_ROOT}/home`
const servers: Array<{ stop: (force?: boolean) => unknown }> = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

type Subscription<T> = { send: (...values: T[]) => void; end: () => void }
type Selectors = {
  readonly params?: { readonly sessionID?: string; readonly parentID?: string }
  readonly query?: { readonly after?: number; readonly follow?: boolean; readonly limit?: number; readonly parentID?: string | null }
}
type WatchRequest = { readonly name: string; readonly data: Selectors }

function selectors(value: unknown): Selectors {
  const fields = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {}
  const request = fields(value)
  const params = fields(request.params)
  const query = fields(request.query)
  return {
    params: {
      sessionID: typeof params.sessionID === "string" ? params.sessionID : undefined,
      parentID: typeof params.parentID === "string" ? params.parentID : undefined,
    },
    query: {
      parentID: typeof query.parentID === "string" || query.parentID === null ? query.parentID : undefined,
      after: typeof query.after === "number" ? query.after : undefined,
      follow: typeof query.follow === "boolean" ? query.follow : undefined,
      limit: typeof query.limit === "number" ? query.limit : undefined,
    },
  }
}

function watchScenario(scenario: Scenario) {
  const sessions = scenario.sessions ?? { ses_target: { title: "Watched" }, ses_other: { title: "Unrelated" } }
  const logs = new Map(Object.entries(scenario.log ?? {}))
  let decisions = scenario.decisions ?? []
  let logReads = 0
  let subscriptions = 0
  const streams = new Set<Subscription<EventSubscribeOutput>>()
  const followers = new Map<string, Set<Subscription<SessionLogOutput>>>()
  const closing = new Set<() => void>()
  const openStreams = () => streams.size + [...followers.values()].reduce((sum, items) => sum + items.size, 0)
  const closed = () => { if (openStreams() === 0) for (const resolve of closing) resolve() }
  function attach<T>(set: Set<Subscription<T>>, stream: Subscription<T>) {
    set.add(stream)
    return () => { set.delete(stream); closed() }
  }
  const control: Control = {
    get subscriptions() { return subscriptions },
    append: (sessionID, ...items) => {
      logs.set(sessionID, [...(logs.get(sessionID) ?? []), ...items])
      for (const stream of followers.get(sessionID) ?? []) stream.send(...items)
    },
    decisions: (items) => { decisions = items },
    push: (event) => { for (const stream of streams) stream.send(event) },
    drop: () => { for (const stream of streams) stream.end() },
    dropLogs: () => { for (const subscribed of followers.values()) for (const stream of subscribed) stream.end() },
  }
  const last = (id: string) => {
    const items = logs.get(id) ?? []
    return items.length ? Math.max(...items.map((item) => item.durable.seq)) : undefined
  }
  const info = (id: string, session: typeof sessions[string]) => ({
    ...sessionFixture(id, "/tmp/watched"), ...session, scope: "bound", projectID: "prj_synthetic", time: { created: base, updated: base },
  })
  const missing = (sessionID: string) => ({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` })
  const epoch = () => scenario.epoch?.() ?? sourceEpoch
  const watermark = (id: string, seq?: number) => ({ type: "log.synced" as const, aggregateID: id, ...(seq === undefined ? {} : { seq }) })
  const activeResult = (active: readonly string[]) => ({ data: Object.fromEntries(active.map((id) => [id, { type: "running" }])) })
  const read = (operation: string, { params = {}, query = {} }: Selectors = {}) => {
    const id = params.sessionID ?? ""
    if (scenario.stall === operation || (typeof scenario.stall === "object" && scenario.stall.operation === operation && scenario.stall.sessionID === id))
      return new Promise<never>(() => {})
    if (operation === "health.get") return { data: { healthy: true, version: InstallationVersion, pid: process.pid } }
    if (operation === "session.active") return scenario.readActive ? scenario.readActive(control).then(activeResult) : activeResult(scenario.active ?? [])
    if (operation === "session.outstanding")
      return { data: scenario.outstanding?.data ?? [], running: scenario.outstanding?.running ?? [], failed: scenario.outstanding?.failed ?? [], lost: scenario.outstanding?.lost ?? [] }
    if (operation === "session.todo.list") return { data: scenario.todos?.[id] ?? [] }
    if (operation === "session.pending.list") return { data: Array.from({ length: scenario.pending?.[id] ?? 0 }, (_, index) => ({
      admittedSeq: index, id: `msg_pending_${index}`, sessionID: id, timeCreated: base, type: "user", data: { text: "Queued" }, delivery: "queue" })) }
    if (operation === "session.subagent.list") {
      const tasks = scenario.tasks?.[params.parentID ?? ""] ?? []
      const count = (states: Task["state"][]) => tasks.filter((item) => states.includes(item.state)).length
      return { data: { data: tasks.slice(0, query.limit ?? 10), cursor: {},
        summary: { total: tasks.length, active: count(["starting", "running", "waiting", "cancelling"]), running: count(["running"]), waiting: count(["waiting"]) } } }
    }
    if (operation === "session.list") {
      return { data: { data: Object.entries(sessions).filter(([, session]) => session.parentID === query.parentID).map(([id, session]) => info(id, session)), cursor: {} } }
    }
    if (operation === "session.get" || operation === "session.snapshot") {
      const session = sessions[id]
      if (!session) return missing(id)
      if (operation === "session.get") return { data: info(id, session) }
      const seq = scenario.watermark ?? last(id)
      scenario.onSnapshot?.(id, control)
      return { data: { sourceEpoch: epoch(), session: info(id, session), messages: scenario.messages ?? [], watermark: watermark(id, seq) } }
    }
    if (operation === "decision.list") return { data: decisions }
    if (operation === "coordination.group.list") return { data: scenario.members ? [{ id: "cgrp_watch", masterSessionID: "ses_target" }] : [] }
    if (operation === "coordination.group.get") return { data: { id: "cgrp_watch", revision: 1, members: scenario.members ?? [] } }
    return new Error(`Unexpected watch operation: ${operation}`)
  }
  return {
    control, read, missing, epoch, hasSession: (id: string) => Object.hasOwn(sessions, id), openStreams,
    subscribe(stream: Subscription<EventSubscribeOutput>) {
      const detach = attach(streams, stream)
      subscriptions++
      queueMicrotask(() => scenario.onSubscribe?.(control))
      return detach
    },
    log(id: string, query: Selectors["query"], stream: Subscription<SessionLogOutput>) {
      scenario.onLog?.(logs, ++logReads)
      const items = (logs.get(id) ?? []).filter((item) => item.durable.seq > (query?.after ?? -1))
      stream.send(...items, { ...watermark(id, last(id)), sourceEpoch: epoch() })
      if (!query?.follow) { stream.end(); return () => {} }
      const subscribed = followers.get(id) ?? new Set<Subscription<SessionLogOutput>>()
      followers.set(id, subscribed)
      const detach = attach(subscribed, stream)
      queueMicrotask(() => scenario.onFollow?.(id, control))
      return detach
    },
    closed: () => new Promise<void>((resolve, reject) => {
      if (openStreams() === 0) return resolve()
      const timer = setTimeout(() => { closing.delete(done); reject(new Error(`${openStreams()} streams remain open`)) }, 500)
      const done = () => { clearTimeout(timer); closing.delete(done); resolve() }
      closing.add(done)
    }),
  }
}

function sse<T>(request: Request, subscribe: (stream: Subscription<T>) => () => void) {
  const encoder = new TextEncoder()
  let detach: (() => void) | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      detach = subscribe({
        send: (...values) => { for (const value of values) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) },
        end: () => { controller.close(); detach?.() },
      })
      request.signal.addEventListener("abort", () => detach?.(), { once: true })
    },
    cancel() { detach?.() },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

function stub(scenario: Scenario) {
  const fixture = watchScenario(scenario)
  const requests: string[] = []
  const server = Bun.serve({ port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    requests.push(`${request.method} ${path}${url.search}`)
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
    const logMatch = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(path)
    if (logMatch) {
      const id = decodeURIComponent(logMatch[1])
      if (!fixture.hasSession(id)) return Response.json(fixture.missing(id), { status: 404 })
      return sse<SessionLogOutput>(request, (stream) => fixture.log(id, {
        after: Number(url.searchParams.get("after") ?? -1), follow: url.searchParams.get("follow") === "true",
      }, stream))
    }
    if (path === "/api/event") return sse<EventSubscribeOutput>(request, (stream) => {
      stream.send({ id: "evt_connected", sourceEpoch: fixture.epoch(), type: "server.connected", data: {} })
      return fixture.subscribe(stream)
    })
    const routes: Record<string, string> = {
      "/api/session": "session.list", "/api/session/active": "session.active", "/api/session/outstanding": "session.outstanding",
      "/api/decision": "decision.list", "/api/coordination": "coordination.group.list", "/api/coordination/cgrp_watch": "coordination.group.get",
    }
    const [, sessionID, resource] = /^\/api\/session\/([^/]+)(?:\/(snapshot|todo|pending|subagent))?$/.exec(path) ?? []
    const operation = routes[path] ?? (resource === "snapshot" ? "session.snapshot" : resource ? `session.${resource}.list` : "session.get")
    const result = await fixture.read(operation, {
      params: { sessionID, parentID: sessionID }, query: { parentID: url.searchParams.get("parentID"), limit: Number(url.searchParams.get("limit") ?? 10) },
    })
    if (result instanceof Error) return new Response(result.message, { status: 404 })
    if ("_tag" in result) return Response.json(result, { status: 404 })
    return Response.json(["session.list", "session.snapshot", "session.subagent.list"].includes(operation) ? result.data : result)
  } })
  servers.push(server)
  return { url: server.url.toString(), requests, ...fixture }
}

function nativeStub(scenario: Scenario) {
  const fixture = watchScenario(scenario)
  const requests: WatchRequest[] = []
  const httpRequests: string[] = []
  const unexpected: string[] = []
  const server = v5Server((name, value) => {
    const data = selectors(value)
    if (name !== "health.get") requests.push({ name, data })
    const result = fixture.read(name, data)
    if (result instanceof Error || name.startsWith("coordination.")) unexpected.push(name)
    return result
  }, {
    httpRequests,
    stream(name, value, stream) {
      const data = selectors(value)
      requests.push({ name, data })
      if (name === "event.subscribe") return fixture.subscribe(stream)
      if (name !== "session.log" || !data.params?.sessionID || !fixture.hasSession(data.params.sessionID))
        throw new Error(`Unexpected watch stream: ${name} (${data.params?.sessionID})`)
      return fixture.log(data.params.sessionID, data.query, stream)
    },
  })
  return { ...server, requests, httpRequests, unexpected, control: fixture.control }
}

type SignalAtRead = { readonly signal: NodeJS.Signals; readonly operation: string }

test("follow reconciliation waits for attached Project members, then reports proceedable unfinished idle once", async () => {
  const running = ["ses_member"]
  const server = stub({ members: [{ sessionID: "ses_member", owner: { sessionID: "ses_owner" } }],
    outstanding: { running }, todos: { ses_target: [todo("Integrate verified member delivery", "pending")] } })
  const controller = new AbortController()
  const receipts: FollowReceipt[] = []
  const state: FollowState = { version: 1, rootSessionID: "ses_target", server: "a".repeat(64), cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] }
  const run = followFamily(YCoding.make({ baseUrl: server.url }), { state, signal: controller.signal, heartbeatSeconds: 0.02,
    save: async (value) => { validateFollowState(value, state.rootSessionID, state.server) }, emit: async (value) => { receipts.push(value) } })
  const wait = async (predicate: () => boolean) => {
    for (let n = 0; !predicate(); n++) { if (n > 300) throw new Error(JSON.stringify(receipts)); await Bun.sleep(5) }
  }
  try {
    await wait(() => receipts.filter((r) => r.kind === "heartbeat").length >= 2)
    expect(receipts.filter((r) => r.kind === "reconciliation")).toEqual([])
    running.splice(0)
    await wait(() => receipts.some((r) => r.kind === "reconciliation"))
    const idle = receipts.filter((r) => r.kind === "reconciliation")
    expect(idle).toHaveLength(1)
    expect(idle[0]).toMatchObject({ reason: "unfinished-idle" })
    expect(idle[0]?.evidence).toContain("open root todos: 1; next pending: Integrate verified member delivery")
    expect(idle[0]?.evidence).toContain("ses_member")
    const before = receipts.filter((r) => r.kind === "heartbeat").length
    await wait(() => receipts.filter((r) => r.kind === "heartbeat").length >= before + 3)
    expect(receipts.filter((r) => r.kind === "reconciliation")).toHaveLength(1)
  } finally { controller.abort(); await run }
})

for (const mode of ["completed", "open-questions", "recovery-needed", "failed", "superseded"] as const) {
  test(`follow reconciliation classifies ${mode} from retained evidence`, async () => {
    const server = stub({ log: { ses_target: mode === "completed" ? [receipt(1, "msg_input", "msg_assistant")] : mode === "superseded" ? [receipt(1, "msg_input", "msg_assistant"), started(2)] : [] },
      decisions: mode === "open-questions" ? [decision("review", "ses_target", "rvw_wait")] : [],
      members: [{ sessionID: "ses_member" }], outstanding: { lost: mode === "recovery-needed" ? ["ses_member", "ses_target"] : [], failed: mode === "failed" ? ["ses_member"] : [] } })
    const controller = new AbortController()
    const receipts: FollowReceipt[] = []
    const state: FollowState = { version: 1, rootSessionID: "ses_target", server: "a".repeat(64), cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] }
    const run = followFamily(YCoding.make({ baseUrl: server.url }), { state, signal: controller.signal, heartbeatSeconds: 0.02, save: async () => {}, emit: async (value) => { receipts.push(value) } })
    try {
      for (let n = 0; receipts.filter((r) => r.kind === "heartbeat").length < 3; n++) { if (n > 300) throw new Error(JSON.stringify(receipts)); await Bun.sleep(5) }
      const summaries = receipts.filter((r) => r.kind === "reconciliation")
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ reason: mode === "superseded" ? "unfinished-idle" : mode === "failed" ? "recovery-needed" : mode })
      if (mode === "open-questions") expect(summaries[0]?.evidence).toContain("review rvw_wait sessionID=ses_target")
      if (mode === "recovery-needed") expect(summaries[0]?.evidence).toContain("lost: ses_member")
      if (mode === "failed") expect(summaries[0]?.evidence).toContain("failed: ses_member")
    } finally { controller.abort(); await run }
  })
}

test("follow reconciliation persists idle dedup across reconnect/reload and reports a new settled activity", async () => {
  const running: string[] = []
  const server = stub({ outstanding: { running } })
  let state: FollowState = { version: 1, rootSessionID: "ses_target", server: "a".repeat(64), cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] }
  const receipts: FollowReceipt[] = []
  const wait = async (predicate: () => boolean) => {
    for (let n = 0; !predicate(); n++) { if (n > 300) throw new Error(JSON.stringify(receipts)); await Bun.sleep(5) }
  }
  const start = () => {
    const controller = new AbortController()
    const run = followFamily(YCoding.make({ baseUrl: server.url }), { state: structuredClone(state), signal: controller.signal, heartbeatSeconds: 0.02,
      save: async (value) => { state = validateFollowState(structuredClone(value), state.rootSessionID, state.server) }, emit: async (value) => { receipts.push(value) } })
    return { controller, run }
  }
  const first = start()
  try { await wait(() => receipts.filter((r) => r.kind === "heartbeat").length >= 2) }
  finally { first.controller.abort(); await first.run }
  expect(receipts.filter((r) => r.kind === "reconciliation")).toHaveLength(1)
  const second = start()
  try {
    await wait(() => receipts.filter((r) => r.kind === "heartbeat").length >= 5)
    expect(receipts.filter((r) => r.kind === "reconciliation")).toHaveLength(1)
    running.push("ses_target")
    await wait(() => receipts.some((r) => r.kind === "heartbeat" && r.rootActive === true))
    running.splice(0)
    await wait(() => receipts.filter((r) => r.kind === "reconciliation").length === 2)
  } finally { second.controller.abort(); await second.run }
})

test("follow survives an unrelated oversized volatile SSE frame and reconciles native cursors and decisions", async () => {
  const server = stub({})
  const controller = new AbortController()
  const receipts: FollowReceipt[] = []
  let saved: FollowState = { version: 1, rootSessionID: "ses_target", server: "a".repeat(64), cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] }
  const run = followFamily(YCoding.make({ baseUrl: server.url }), { state: saved, signal: controller.signal, heartbeatSeconds: 3600,
    save: async (value) => { saved = structuredClone(value) }, emit: async (value) => { receipts.push(value) } })
  const wait = async (predicate: () => boolean) => {
    for (let n = 0; !predicate(); n++) { if (n > 600) throw new Error(JSON.stringify(receipts)); await Bun.sleep(5) }
  }
  run.catch(() => undefined)
  try {
    await wait(() => receipts.some((r) => r.kind === "ready"))
    server.control.push({ type: "permission.asked", id: "evt_unrelated_large", created: base,
      data: { sessionID: "ses_other", id: "per_unrelated", action: "synthetic", resources: ["x".repeat(17 * 1024 * 1024)] } })
    server.control.decisions([decision("review", "ses_target", "rvw_after_large")])
    server.control.append("ses_target", started(1), succeeded(2))
    await wait(() => receipts.filter((r) => r.kind === "ready").length >= 2)
    expect(saved.cursors).toEqual([{ sessionID: "ses_target", after: 2 }])
    expect(saved.pending.map((r) => r.id)).toEqual(["rvw_after_large"])
    expect(receipts.filter((r) => r.kind === "durable" && r.seq === 2)).toHaveLength(1)
    expect(server.control.subscriptions).toBe(2)
  } finally { controller.abort(); await run }
}, 30_000)

for (const recovered of [false, true]) {
  test(`follow reports only an unrecovered root interruption (${recovered ? "restarted" : "stopped"})`, async () => {
    const interrupted = logEvent("session.execution.interrupted", 1, { sessionID: "ses_target", reason: "user" })
    const server = stub({ log: { ses_target: recovered ? [interrupted, started(2), succeeded(3)] : [interrupted] } })
    const controller = new AbortController()
    const receipts: FollowReceipt[] = []
    const state: FollowState = { version: 1, rootSessionID: "ses_target", server: "a".repeat(64), cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] }
    const run = followFamily(YCoding.make({ baseUrl: server.url }), { state, signal: controller.signal, heartbeatSeconds: 0.02, save: async () => {}, emit: async (value) => { receipts.push(value) } })
    try {
      for (let n = 0; receipts.filter((r) => r.kind === "heartbeat").length < 3; n++) { if (n > 300) throw new Error(JSON.stringify(receipts)); await Bun.sleep(5) }
      expect(receipts.filter((r) => r.kind === "interruption")).toHaveLength(recovered ? 0 : 1)
    } finally { controller.abort(); await run }
  })
}

async function watch(scenario: Scenario, args: string[], options: { entry?: "tui" | "index"; signalAfterSubscribe?: NodeJS.Signals; signalAtRead?: SignalAtRead } = {}) {
  const server = nativeStub(scenario)
  const child = Bun.spawn([process.execPath, new URL(`../src/${options.entry ?? "tui"}.ts`, import.meta.url).pathname, "decision", "watch", ...args, "--server", server.url], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, YCODING_TEST_HOME: home, YCODING_PASSWORD: "" },
  })
  try {
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const signalAt = options.signalAtRead
    const signal = options.signalAfterSubscribe ?? signalAt?.signal
    if (signal) {
      const reached = () => server.requests.some(({ name }) => name === (signalAt?.operation ?? "event.subscribe"))
      const deadline = Date.now() + 20_000
      while (!reached() && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await Bun.sleep(25)
      expect(reached()).toBe(true)
      child.kill(signal)
    }
    const [stdout, stderr, exit] = await output
    expect(server.unexpected).toEqual([])
    expect(server.httpRequests.filter((request) => request !== "GET /api/health")).toEqual([])
    return { stdout, stderr, exit, requests: server.requests, control: server.control, url: server.url }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
    await server.close()
  }
}

test("both entrypoints advertise decision watch with its flags", async () => {
  for (const entry of ["tui", "index"] as const) {
    const child = Bun.spawn([process.execPath, new URL(`../src/${entry}.ts`, import.meta.url).pathname, "decision", "watch", "--help"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, YCODING_TEST_HOME: home } })
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exit).toBe(0)
    for (const flag of ["--input", "--after", "--family", "--timeout", "--json", "--server"]) expect(stdout).toContain(flag)
  }
}, 30_000)

test("an already pending decision on the watched Session returns at once with exact decide commands and excludes other Sessions", async () => {
  const result = await watch({ decisions: [decision("permission", "ses_target", "per_target"), decision("question", "ses_other", "que_other")] }, ["ses_target", "--input", "msg_input"])
  expect(result.exit).toBe(2)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain("Pending decision in Session \"Watched\" (ses_target)")
  expect(result.stdout).toContain("per_target")
  expect(result.stdout).toContain(`ycoding api session.review.decide --param sessionID=ses_target --param itemID=per_target -d '{"decision":{"kind":"permission","reply":"once"}}'`)
  expect(result.stdout).not.toContain("que_other")
  expect(result.stdout).toContain("ycoding decision watch ses_target --input msg_input")
}, 30_000)

test("every decision kind is reported unchanged in JSON", async () => {
  const items = (["permission", "guardrail", "question", "form", "review"] as const).map((kind, index) => decision(kind, "ses_target", `item_${index}`))
  const result = await watch({ decisions: items }, ["ses_target", "--json"])
  expect(result.exit).toBe(2)
  const output = JSON.parse(result.stdout)
  expect(output.outcome).toBe("decision")
  expect(output.sessionID).toBe("ses_target")
  expect(output.decisions).toEqual(items)
  expect(output.resume[0]).toBe("ycoding")
}, 30_000)

test("a decision raised after the watch subscribes wakes it", async () => {
  const result = await watch({ onSubscribe: (control) => {
    control.decisions([decision("question", "ses_other", "que_other")])
    control.push(wake("ses_other"))
    setTimeout(() => {
      control.decisions([decision("question", "ses_other", "que_other"), decision("guardrail", "ses_target", "grd_target")])
      control.push(wake("ses_target"))
    }, 300)
  } }, ["ses_target", "--timeout", "20"])
  expect(result.exit).toBe(2)
  expect(result.stdout).toContain("grd_target")
  expect(result.stdout).not.toContain("que_other")
}, 30_000)

test("family decisions are included only for an explicit root watch", async () => {
  const scenario = {
    sessions: { ses_target: { title: "Watched" }, ses_child: { title: "Child", parentID: "ses_target" }, ses_other: { title: "Unrelated" } },
    decisions: [decision("question", "ses_child", "que_child"), decision("permission", "ses_other", "per_other")],
  }
  const family = await watch(scenario, ["ses_target", "--family", "--json"])
  expect(family.exit).toBe(2)
  expect(JSON.parse(family.stdout).decisions.map((item: DecisionItem) => item.id)).toEqual(["que_child"])
  const own = await watch(scenario, ["ses_target", "--timeout", "1", "--json"])
  expect(own.exit).toBe(3)
  expect(JSON.parse(own.stdout).outcome).toBe("timeout")
  const child = await watch(scenario, ["ses_child", "--family"])
  expect(child.exit).toBe(1)
  expect(child.stderr).toContain("--family requires a root Session")
}, 60_000)

test("completion is reported only for the execution that consumed the watched input, with its final response and timestamps", async () => {
  const result = await watch({
    log: { ses_target: [
      logEvent("session.input.admitted", 1, { sessionID: "ses_target", inputID: "msg_input", input: { type: "user", data: { text: "Task" }, delivery: "queue" } }),
      started(2), promoted(3, "msg_earlier"), text(4, "Earlier answer.", "final_answer"), succeeded(5),
    ] },
    messages: [user("msg_earlier"), assistant("msg_a1", "Earlier answer."), user("msg_input"), assistant("msg_a2", "Working on it."), assistant("msg_a3", "Done: watched answer.")],
    onSubscribe: (control) => {
      control.append("ses_target", started(6), promoted(7, "msg_input"), consumed(8, ["msg_input"]), text(9, "Done: watched answer.", "final_answer"), succeeded(10))
      control.push(wake("ses_target"))
    },
  }, ["ses_target", "--input", "msg_input", "--json"])
  expect(result.exit).toBe(0)
  const output = JSON.parse(result.stdout)
  expect(output).toEqual({
    outcome: "settled", sessionID: "ses_target", after: 10,
    execution: { status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(6), settledAt: iso(10), startEvent: ref(6), endEvent: ref(10), response: "Done: watched answer." },
    work: work("incomplete"),
    resume: ["ycoding", "decision", "watch", "ses_target", "--after", "10", "--server", result.url, "--json"],
  })
}, 30_000)

test("failed, interrupted, and rejected settlements are terminal outcomes", async () => {
  const failed = await watch({ log: { ses_target: [started(2), promoted(3, "msg_input"),
    logEvent("session.execution.failed", 4, { sessionID: "ses_target", error: { type: "provider", message: "Synthetic provider failure" } })] } },
  ["ses_target", "--input", "msg_input"])
  expect(failed.exit).toBe(0)
  expect(failed.stdout).toContain("Execution failed in Session \"Watched\" (ses_target)")
  expect(failed.stdout).toContain("provider: Synthetic provider failure")

  const interrupted = await watch({ log: { ses_target: [started(2), consumed(4, ["msg_input"]),
    logEvent("session.execution.interrupted", 5, { sessionID: "ses_target", reason: "user" })] } },
  ["ses_target", "--input", "msg_input", "--after", "3", "--json"])
  expect(interrupted.exit).toBe(0)
  expect(JSON.parse(interrupted.stdout).execution).toEqual({ status: "interrupted", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(5), startEvent: ref(2), endEvent: ref(5), reason: "user" })

  const rejected = await watch({ log: { ses_target: [logEvent("session.dots.instruction.rejected", 2, {
    sessionID: "ses_target", inputID: "msg_input", anchorSessionID: "ses_target", exchangeID: "dex_synthetic", delegationID: "ddl_synthetic", reason: "delegation_invalid",
  } as Data<"session.dots.instruction.rejected">)] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(rejected.exit).toBe(0)
  expect(JSON.parse(rejected.stdout).execution).toEqual({ status: "rejected", inputIDs: ["msg_input"], settledAt: iso(2), endEvent: ref(2), reason: "delegation_invalid" })
}, 60_000)

test("a timeout reports progress and a resume cursor that replays the open execution", async () => {
  const log = [started(2), promoted(3, "msg_input"), logEvent("session.tool.called", 4, { sessionID: "ses_target", assistantMessageID: "msg_assistant", callID: "call_1", input: {}, executed: true } as Data<"session.tool.called">), text(5, "Still working.", "commentary")]
  const timeout = await watch({ log: { ses_target: log }, active: ["ses_target"] }, ["ses_target", "--input", "msg_input", "--timeout", "1", "--json"])
  expect(timeout.exit).toBe(3)
  expect(JSON.parse(timeout.stdout)).toEqual({
    outcome: "timeout", sessionID: "ses_target", after: 1,
    progress: { state: "running", startedAt: iso(2), toolCalls: 1, input: "promoted", latest: "Still working." },
    work: work("running"),
    resume: ["ycoding", "decision", "watch", "ses_target", "--input", "msg_input", "--after", "1", "--server", timeout.url, "--timeout", "1", "--json"],
  })
  const resumed = await watch({ log: { ses_target: [...log, succeeded(6)] } }, ["ses_target", "--input", "msg_input", "--after", "1", "--json"])
  expect(resumed.exit).toBe(0)
  expect(JSON.parse(resumed.stdout).execution.status).toBe("succeeded")
  expect(resumed.requests.some(({ name, data }) => name === "session.log" && data.query?.after === 1)).toBe(true)
}, 60_000)

test("without an input the watch ignores history and returns on the next settlement", async () => {
  const result = await watch({ log: { ses_target: [started(1), succeeded(3)] }, onSubscribe: (control) => {
    control.append("ses_target", started(4), consumed(5, ["msg_live"]), succeeded(6))
    control.push(wake("ses_target"))
  } }, ["ses_target", "--json"])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_live"], startedAt: iso(4), settledAt: iso(6), startEvent: ref(4), endEvent: ref(6) })
  expect(result.requests.some(({ name, data }) => name === "session.snapshot" && data.params?.sessionID === "ses_target")).toBe(true)
}, 30_000)

test("a dropped event stream is resubscribed and state is re-read", async () => {
  const result = await watch({ onSubscribe: (control) => {
    if (control.subscriptions === 1) {
      control.decisions([])
      setTimeout(() => control.drop(), 200)
      return
    }
    control.decisions([decision("form", "ses_target", "frm_target")])
  } }, ["ses_target", "--timeout", "20"])
  expect(result.exit).toBe(2)
  expect(result.stdout).toContain("frm_target")
  expect(result.control.subscriptions).toBe(2)
}, 30_000)

test("an unknown Session fails without watching", async () => {
  const result = await watch({}, ["ses_missing"])
  expect(result.exit).toBe(1)
  expect(result.stderr).toContain("Session not found: ses_missing")
  expect(result.requests.some(({ name }) => name === "event.subscribe")).toBe(false)
}, 30_000)

test("cancelling a watch exits without changing server state", async () => {
  const pending = [decision("question", "ses_other", "que_other")]
  const result = await watch({ decisions: pending }, ["ses_target", "--timeout", "30"], { signalAfterSubscribe: "SIGINT" })
  expect(result.exit).not.toBe(0)
  expect(result.exit).not.toBe(2)
  expect(result.stdout).not.toContain("que_other")
}, 30_000)

test("a resumed watch whose execution events were pruned reports an unknown result instead of a later success", async () => {
  const result = await watch({ log: { ses_target: [promoted(3, "msg_input"), promoted(22, "msg_later"), succeeded(30), started(31)] },
    messages: [user("msg_input"), assistant("msg_a1", "Old answer."), user("msg_later"), assistant("msg_a2", "Later answer.")] },
  ["ses_target", "--input", "msg_input", "--after", "2", "--json"])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "unknown", inputIDs: ["msg_input"] })
  const later = await watch({ log: { ses_target: [promoted(3, "msg_input"), started(31)] } }, ["ses_target", "--input", "msg_input", "--after", "2"])
  expect(later.exit).toBe(0)
  expect(later.stdout).toContain("its retained history no longer proves the result. Read message.list; do not treat it as succeeded.")
}, 30_000)

test("a settlement is tied to the watched input only when retained history proves it", async () => {
  const interrupted = (seq: number) => logEvent("session.execution.interrupted", seq, { sessionID: "ses_target", reason: "user" })
  const ambiguous = await watch({ log: { ses_target: [promoted(3, "msg_input"), succeeded(10), started(11), interrupted(12)] } },
    ["ses_target", "--input", "msg_input", "--after", "2", "--json"])
  expect(ambiguous.exit).toBe(0)
  expect(JSON.parse(ambiguous.stdout).execution).toEqual({ status: "unknown", inputIDs: ["msg_input"] })

  const observed = await watch({ log: { ses_target: [started(2), promoted(3, "msg_input"), succeeded(4), started(5), interrupted(6)] } },
    ["ses_target", "--input", "msg_input", "--after", "1", "--json"])
  expect(observed.exit).toBe(0)
  expect(JSON.parse(observed.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(4), startEvent: ref(2), endEvent: ref(4) })

  const failure = logEvent("session.execution.failed", 4, { sessionID: "ses_target", error: { type: "provider", message: "Synthetic request failure" } })
  const beforeOutput = await watch({ log: { ses_target: [started(2), promoted(3, "msg_input"), failure] } },
    ["ses_target", "--input", "msg_input", "--after", "2", "--json"])
  expect(beforeOutput.exit).toBe(0)
  expect(JSON.parse(beforeOutput.stdout).execution).toEqual({ status: "failed", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(4),
    startEvent: ref(2), endEvent: ref(4), error: { type: "provider", message: "Synthetic request failure" } })

  const startless = await watch({ log: { ses_target: [promoted(3, "msg_input"), failure] } }, ["ses_target", "--input", "msg_input", "--after", "2", "--json"])
  expect(startless.exit).toBe(0)
  expect(JSON.parse(startless.stdout).execution).toEqual({ status: "unknown", inputIDs: ["msg_input"] })
}, 60_000)

test("a server read that never answers still ends at the timeout", async () => {
  const started = Date.now()
  const result = await watch({ stall: "decision.list" }, ["ses_target", "--timeout", "1", "--json"])
  expect(result.exit).toBe(3)
  expect(JSON.parse(result.stdout).outcome).toBe("timeout")
  expect(Date.now() - started).toBeLessThan(15_000)
}, 30_000)

test("sequence zero is a real cursor", async () => {
  const result = await watch({ log: { ses_target: [started(0)] } }, ["ses_target", "--timeout", "1", "--json"])
  expect(result.exit).toBe(3)
  const output = JSON.parse(result.stdout)
  expect(output.after).toBe(0)
  expect(output.resume).toEqual(["ycoding", "decision", "watch", "ses_target", "--after", "0", "--server", result.url, "--timeout", "1", "--json"])
  expect(result.requests.some(({ name, data }) => name === "session.log" && data.query?.after === 0)).toBe(true)
}, 30_000)

test("a start pruned between the main read and its proof read never yields a later execution's success", async () => {
  const prune = (logs: Map<string, LogEvent[]>, count: number) => {
    if (count === 2) logs.set("ses_target", logs.get("ses_target")!.filter((item) => item.durable.seq !== 2))
  }
  const ambiguous = await watch({ log: { ses_target: [started(2), promoted(3, "msg_input"), succeeded(7), started(8)] }, onLog: prune },
    ["ses_target", "--input", "msg_input", "--after", "1", "--json"])
  expect(ambiguous.exit).toBe(0)
  expect(JSON.parse(ambiguous.stdout).execution).toEqual({ status: "unknown", inputIDs: ["msg_input"] })

  const latest = await watch({ log: { ses_target: [started(2), promoted(3, "msg_input"), succeeded(7)] }, onLog: prune },
    ["ses_target", "--input", "msg_input", "--after", "1", "--json"])
  expect(latest.exit).toBe(0)
  expect(JSON.parse(latest.stdout).execution).toEqual({ status: "unknown", inputIDs: ["msg_input"] })
}, 60_000)

test("an execution starting at sequence zero is proven with a proof read from the beginning", async () => {
  const result = await watch({ log: { ses_target: [started(0), promoted(1, "msg_input"), succeeded(2)] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(0), settledAt: iso(2), startEvent: { id: "evt_ses_target_0", seq: 0 }, endEvent: ref(2) })
  const reads = result.requests.filter(({ name, data }) => name === "session.log" && data.params?.sessionID === "ses_target")
  expect(reads.filter(({ data }) => data.query?.after === undefined).length).toBe(2)
  expect(reads.filter(({ data }) => data.query?.after !== undefined).every(({ data }) => data.query?.after === 2)).toBe(true)
}, 30_000)

test("an input promoted at or before --after is refused instead of waiting", async () => {
  const result = await watch({ log: { ses_target: [started(1), promoted(2, "msg_input"), succeeded(3)] }, messages: [user("msg_input"), assistant("msg_a1", "Done.")] },
    ["ses_target", "--input", "msg_input", "--after", "3", "--timeout", "20"])
  expect(result.exit).toBe(1)
  expect(result.stderr).toContain("Input msg_input ran at or before --after 3; rerun without --after")
  expect(result.stdout).toBe("")
}, 30_000)

test("duplicate decisions print once and an item too large to print is named without a partial command", async () => {
  const large = {
    ...decision("form", "ses_target", "frm_large"),
    summary: "\x1b".repeat(34 * 1024),
    decide: [{ label: "Submit", argv: ["ycoding", "api", "session.form.reply", "--param", "sessionID=ses_target", "--param", "formID=frm_large",
      "-d", JSON.stringify({ answer: { response: "'".repeat(70 * 1024) } })] }],
  }
  const small = decision("permission", "ses_target", "per_small")
  for (const json of [true, false]) {
    const result = await watch({ decisions: [small, small, large] }, ["ses_target", ...(json ? ["--json"] : [])])
    expect(result.exit).toBe(2)
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(64 * 1024)
    if (json) {
      const output = JSON.parse(result.stdout)
      expect(output.decisions).toEqual([small])
      expect(output.oversized).toEqual([{ kind: "form", id: "frm_large", sessionID: "ses_target" }])
      continue
    }
    expect(result.stdout.split("per_small in").length).toBe(2)
    expect(result.stdout).toContain("form frm_large in ses_target is too large to print here; run ycoding decision list --json")
    expect(result.stdout).not.toContain("formID=frm_large")
  }
}, 30_000)

test("a later start committed beyond the read watermark never lets a start-less terminal count as the input's result", async () => {
  const result = await watch({ log: { ses_target: [promoted(3, "msg_input"), succeeded(7)] }, onLog: (logs, count) => {
    if (count === 2) logs.set("ses_target", [...logs.get("ses_target")!, started(8)])
  } }, ["ses_target", "--input", "msg_input", "--after", "2", "--json"])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "unknown", inputIDs: ["msg_input"] })
}, 30_000)

test("an input steered into an execution that started before --after is proven by that retained start", async () => {
  const result = await watch({ log: { ses_target: [started(1), promoted(2, "msg_other"), promoted(4, "msg_input"), succeeded(5)] },
    messages: [user("msg_other"), assistant("msg_a1", "Working."), user("msg_input"), assistant("msg_a2", "Steered answer.")] },
  ["ses_target", "--input", "msg_input", "--after", "3", "--json"])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_other", "msg_input"], startedAt: iso(1), settledAt: iso(5),
    startEvent: ref(1), endEvent: ref(5), response: "Steered answer." })
}, 30_000)

test("a resume command keeps the explicit server connection and output mode, and omits defaults", async () => {
  const decided = await watch({ decisions: [decision("permission", "ses_target", "per_target")] }, ["ses_target", "--input", "msg_input"])
  expect(decided.exit).toBe(2)
  expect(decided.stdout).toContain(`Resume after deciding: ycoding decision watch ses_target --input msg_input --server ${decided.url}\n`)
  const { resumeCommand } = await import("../src/commands/handlers/decision/watch")
  expect(resumeCommand({ sessionID: "ses_target", family: false, timeout: 300, standalone: true, json: false }, 4))
    .toEqual(["ycoding", "decision", "watch", "ses_target", "--after", "4", "--standalone"])
  expect(resumeCommand({ sessionID: "ses_target", family: true, timeout: 300, standalone: false, json: false }, undefined))
    .toEqual(["ycoding", "decision", "watch", "ses_target", "--family"])
}, 30_000)

const ownerRun = (end: LogEvent) => ({ ses_target: [admitted(1, "msg_input"), started(2), promoted(3, "msg_input"), end] })

async function familyBoundary(scenario: Scenario, options: { family?: boolean; input?: string; after?: number; checkpoint?: string; cancel?: AbortSignal } = {}) {
  const server = stub(scenario)
  const result = await watchSession(YCoding.make({ baseUrl: server.url }), {
    sessionID: "ses_target", family: options.family ?? true, timeout: 0.3, standalone: false, json: true,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.after === undefined ? {} : { after: options.after }),
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
  }, options.cancel ?? AbortSignal.timeout(2_000))
  return { ...server, result }
}

test("family watch boundary: a child terminal without a global wake returns incomplete owner work, not root settlement", async () => {
  const result = await familyBoundary({
    sessions: family, todos: { ses_target: [todo("Finish owner validation", "pending")] },
    onSubscribe: (control) => { setTimeout(() => control.append("ses_child", succeeded(1, "ses_child")), 20) },
  })
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "incomplete", todos: { open: 1 } } })
  expect(result.result.outcome).not.toHaveProperty("execution")
  expect(result.requests.some((request) => request.includes("/ses_child/log?") && request.includes("follow=true"))).toBe(true)
}, 5_000)

test("family watch boundary: child drain after its terminal is reassessed without reporting root completion", async () => {
  const active = ["ses_child"]
  const tasks = { ses_target: [task("ses_child", "running", 1)] }
  const result = await familyBoundary({
    sessions: family, active, tasks, outstanding: { running: active },
    todos: { ses_target: [todo("Finish owner validation", "pending")] },
    onSubscribe: (control) => {
      setTimeout(() => control.append("ses_child", succeeded(1, "ses_child")), 20)
      setTimeout(() => {
        active.splice(0)
        tasks.ses_target = [task("ses_child", "completed", 2)]
        control.push({ id: "evt_child_idle", created: base, type: "session.status", data: { sessionID: "ses_child", status: { type: "idle" } } })
      }, 50)
    },
  })
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "incomplete", children: { active: 0 }, running: [] } })
}, 5_000)

test("family watch boundary: a child failure is incomplete work, not restart loss", async () => {
  const failure = logEvent("session.execution.failed", 2, { sessionID: "ses_child", error: { type: "unknown", message: "Synthetic failure" } }, "ses_child")
  const failed = await familyBoundary({
    sessions: family, tasks: { ses_target: [task("ses_child", "failed", 2)] },
    onSubscribe: (control) => { setTimeout(() => control.append("ses_child", failure), 20) },
  })
  expect(failed.result.outcome).toMatchObject({ outcome: "family", work: { state: "incomplete", lost: [] } })
  expect(failed.result.outcome).toHaveProperty("changes", [expect.objectContaining({ sessionID: "ses_child", type: "session.execution.failed", id: failure.id, seq: 2 })])
}, 5_000)

test("family watch boundary: explicit restart loss is reported from outstanding work", async () => {
  const failure = logEvent("session.execution.failed", 2, { sessionID: "ses_child", error: { type: "unknown", message: "Synthetic failure" } }, "ses_child")
  const lost = await familyBoundary({
    sessions: family, outstanding: { lost: ["ses_child"] }, tasks: { ses_target: [task("ses_child", "lost", 2)] },
    onSubscribe: (control) => { setTimeout(() => control.append("ses_child", failure), 20) },
  })
  expect(lost.result.outcome).toMatchObject({ outcome: "family", work: { state: "lost", lost: ["ses_child"] } })
}, 5_000)

test("family watch boundary: a retained open root execution is unconfirmed, not lost", async () => {
  const open = await familyBoundary({ sessions: family, log: { ses_target: [started(1)] } }, { input: "msg_input" })
  expect(open.result.outcome).toMatchObject({ outcome: "timeout", state: "unconfirmed", work: { state: "unconfirmed", lost: [] } })
}, 5_000)

test("family watch boundary: child completion preserves the root input and its open execution", async () => {
  const result = await familyBoundary({
    sessions: family, log: { ses_target: [admitted(1, "msg_input"), started(2), promoted(3, "msg_input")] }, active: ["ses_target"],
    onSubscribe: (control) => { setTimeout(() => control.append("ses_child", succeeded(20, "ses_child")), 20) },
  }, { input: "msg_input", after: 0 })
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "running" } })
  expect(result.result.outcome).not.toHaveProperty("execution")
  expect(result.result.input).toBe("promoted")
  expect(result.result.after).toBeLessThan(2)
  expect(result.result.execution?.inputIDs).toEqual(["msg_input"])
}, 5_000)

test("family watch boundary: a child accepted receipt never completes owner work", async () => {
  const childReceipt = logEvent("session.work.completed", 2, { sessionID: "ses_child", inputID: "msg_child", assistantMessageID: "msg_child_answer" }, "ses_child")
  const child = await familyBoundary({ sessions: family, onSubscribe: (control) => {
    setTimeout(() => control.append("ses_child", succeeded(1, "ses_child"), childReceipt), 20)
  } })
  expect(child.result.outcome).toMatchObject({ outcome: "family", work: { state: "incomplete" } })
  expect(child.result.outcome).not.toHaveProperty("work.receipt")
}, 5_000)

test("family watch boundary: a root accepted receipt completes owner work without a new execution terminal", async () => {
  const root = await familyBoundary({ sessions: family, onSubscribe: (control) => {
    setTimeout(() => {
      control.append("ses_target", receipt(1, "msg_input", "msg_answer"))
      control.push(wake("ses_target"))
    }, 20)
  } })
  expect(root.result.outcome).toMatchObject({ outcome: "family", work: { state: "completed", receipt: { inputID: "msg_input", current: true } } })
}, 5_000)

test("family watch boundary: ready and reconnect reconcile current ephemeral decisions with exact IDs", async () => {
  for (const kind of ["permission", "guardrail", "question", "form"] as const) {
    const item = decision(kind, "ses_child", `${kind}_current`)
    const ready = await familyBoundary({ sessions: family, onSubscribe: (control) => control.decisions([item]) })
    expect(ready.result.outcome).toEqual({ outcome: "decision", decisions: [item], oversized: [], omitted: 0 })
    const reconnect = await familyBoundary({ sessions: family, onSubscribe: (control) => {
      if (control.subscriptions !== 1) return
      setTimeout(() => { control.decisions([item]); control.drop() }, 20)
    } })
    expect(reconnect.result.outcome).toEqual({ outcome: "decision", decisions: [item], oversized: [], omitted: 0 })
  }
}, 5_000)

test("family watch boundary: duplicate child replay reports one transition after a log reconnect", async () => {
  const terminal = succeeded(7, "ses_child")
  let followed = 0
  const result = await familyBoundary({ sessions: family, onFollow: (sessionID, control) => {
    if (sessionID !== "ses_child") return
    followed++
    if (followed === 1) {
      control.dropLogs()
      control.append("ses_child", terminal)
    } else control.append("ses_child", terminal)
  } })
  expect(result.result.outcome).toMatchObject({ outcome: "family" })
  expect(result.result.outcome).toHaveProperty("changes", [{ sessionID: "ses_child", type: terminal.type, id: terminal.id, seq: 7 }])
  expect(followed).toBeGreaterThan(1)
}, 5_000)

test("family watch boundary: epoch replacement rejects late old-epoch child events", async () => {
  let epoch = sourceEpoch
  const current = { ...succeeded(2, "ses_child"), sourceEpoch: "epoch_replaced" }
  const result = await familyBoundary({ sessions: family, epoch: () => epoch, onSubscribe: (control) => {
    if (control.subscriptions !== 1) return
    setTimeout(() => {
      epoch = "epoch_replaced"
      control.drop()
      control.dropLogs()
      control.append("ses_child", { ...succeeded(99, "ses_child"), sourceEpoch }, current)
    }, 20)
  } })
  expect(result.result.outcome).toMatchObject({ outcome: "family" })
  expect(result.result.outcome).toHaveProperty("changes", [{ sessionID: "ses_child", type: current.type, id: current.id, seq: 2 }])
}, 5_000)

test("family watch boundary: a child event between its snapshot and subscription is replayed", async () => {
  let injected = false
  const terminal = succeeded(4, "ses_child")
  const result = await familyBoundary({ sessions: family, onSnapshot: (sessionID, control) => {
    if (sessionID !== "ses_child" || injected) return
    injected = true
    control.append("ses_child", terminal)
  } })
  expect(result.result.outcome).toMatchObject({ outcome: "family" })
  expect(result.result.outcome).toHaveProperty("changes", [{ sessionID: "ses_child", type: terminal.type, id: terminal.id, seq: 4 }])
}, 5_000)

test("family watch boundary: new grandchildren are discovered and watched without a root terminal", async () => {
  const sessions: NonNullable<Scenario["sessions"]> = { ...family }
  const result = await familyBoundary({ sessions, onSubscribe: (control) => {
    setTimeout(() => {
      sessions.ses_grandchild = { title: "Grandchild", parentID: "ses_child" }
      control.push({ id: "evt_created_grandchild", created: base, type: "session.created",
        durable: { aggregateID: "ses_grandchild", seq: 0, version: 2 }, data: {
          sessionID: "ses_grandchild", title: "Grandchild", parentID: "ses_child", projectID: "prj_synthetic",
          location: { directory: "/tmp/watched" }, created: base,
        } })
    }, 20)
    setTimeout(() => control.append("ses_grandchild", succeeded(1, "ses_grandchild")), 50)
  } })
  expect(result.result.outcome).toMatchObject({ outcome: "family" })
  expect(result.result.outcome).toHaveProperty("changes", [expect.objectContaining({ sessionID: "ses_grandchild" })])
}, 5_000)

test("family watch boundary: a new child settled during disconnect is replayed after discovery", async () => {
  const sessions: NonNullable<Scenario["sessions"]> = { ses_target: { title: "Watched" } }
  const result = await familyBoundary({ sessions, onSubscribe: (control) => {
    if (control.subscriptions !== 1) return
    setTimeout(() => {
      control.drop()
      control.dropLogs()
      sessions.ses_child = { title: "Child", parentID: "ses_target" }
      control.append("ses_child", succeeded(1, "ses_child"))
    }, 20)
  } })
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "incomplete" } })
  expect(result.result.outcome).toHaveProperty("changes", [{ sessionID: "ses_child", type: "session.execution.succeeded", id: "evt_ses_child_1", seq: 1 }])
}, 5_000)

test("family watch boundary: stale-epoch status cannot release a terminal before current-epoch status", async () => {
  let currentSent = false
  const result = await familyBoundary({ sessions: family, active: ["ses_child"], onSubscribe: (control) => {
    setTimeout(() => control.append("ses_child", succeeded(1, "ses_child")), 20)
    setTimeout(() => control.push({ id: "evt_stale_idle", created: base, sourceEpoch: "epoch_old", type: "session.status", data: {
      sessionID: "ses_child", status: { type: "idle" },
    } }), 35)
    setTimeout(() => {
      currentSent = true
      control.push({ id: "evt_current_busy", created: base, sourceEpoch, type: "session.status", data: {
        sessionID: "ses_child", status: { type: "busy" },
      } })
    }, 60)
  } })
  expect(currentSent).toBe(true)
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "running" } })
}, 5_000)

test("family watch boundary: more than 64 Sessions fails explicitly rather than silently missing work", async () => {
  const sessions: NonNullable<Scenario["sessions"]> = { ses_target: { title: "Watched" } }
  for (let i = 0; i < 64; i++) sessions[`ses_child_${i}`] = { title: `Child ${i}`, parentID: "ses_target" }
  await expect(familyBoundary({ sessions })).rejects.toThrow(/family.*64|64.*family/i)
}, 5_000)

test("family watch boundary: success, timeout, and abort release all owned streams and never follow children without family", async () => {
  const success = await familyBoundary({ sessions: family, decisions: [decision("permission", "ses_child", "per_child")] })
  await success.closed()
  expect(success.openStreams()).toBe(0)
  const timed = await familyBoundary({ sessions: family })
  await timed.closed()
  expect(timed.result.outcome).toMatchObject({ outcome: "timeout" })
  expect(timed.openStreams()).toBe(0)
  const single = await familyBoundary({ sessions: family }, { family: false })
  expect(single.requests.some((request) => request.includes("/ses_child/log"))).toBe(false)
  const controller = new AbortController()
  const server = stub({ sessions: family, onSubscribe: () => { setTimeout(() => controller.abort(), 20) } })
  await expect(watchSession(YCoding.make({ baseUrl: server.url }), {
    sessionID: "ses_target", family: true, timeout: 1, standalone: false, json: true,
  }, controller.signal)).rejects.toThrow()
  await server.closed()
  expect(server.openStreams()).toBe(0)
}, 5_000)

const checkpoint = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const familyCursor = {
  version: 1, rootSessionID: "ses_target", sourceEpoch,
  cursors: [{ sessionID: "ses_target", after: 0 }, { sessionID: "ses_child", after: 0 }],
}

test("family checkpoint boundary: resuming replays a child terminal committed between invocations", async () => {
  const result = await watch({ sessions: family,
    log: { ses_target: [text(0, "Baseline", "commentary")], ses_child: [succeeded(1, "ses_child")] }, todos: { ses_target: [todo("Verify owner work", "pending")] },
  }, ["ses_target", "--family", "--after", "0", "--checkpoint", checkpoint(familyCursor), "--timeout", "1", "--json"])
  expect(result.exit).toBe(0)
  const output = JSON.parse(result.stdout)
  expect(output).toMatchObject({ outcome: "family", work: { state: "incomplete" } })
  expect(output.checkpoint).toEqual(expect.any(String))
  expect(output.resume).toContain("--checkpoint")
  const next = JSON.parse(Buffer.from(output.checkpoint, "base64url").toString())
  expect(next).toMatchObject({ version: 1, rootSessionID: "ses_target", sourceEpoch })
  expect(next.cursors).toContainEqual({ sessionID: "ses_child", after: 1 })
}, 10_000)

for (const [name, value, error] of [
  ["version", { ...familyCursor, version: 2 }, "checkpoint version"],
  ["root", { ...familyCursor, rootSessionID: "ses_other" }, "checkpoint root"],
  ["epoch", { ...familyCursor, sourceEpoch: "" }, "checkpoint epoch"],
  ["duplicate", { ...familyCursor, cursors: [familyCursor.cursors[0], familyCursor.cursors[0]] }, "checkpoint Session IDs"],
  ["cursor", { ...familyCursor, cursors: [{ sessionID: "ses_target", after: -1 }] }, "checkpoint cursor"],
  ["authority", { ...familyCursor, completed: true }, "checkpoint fields"],
  ["Session ID", { ...familyCursor, cursors: [{ sessionID: "ses_target" }, { sessionID: "foreign" }] }, "checkpoint Session IDs"],
] as const) {
  test(`family checkpoint boundary: rejects invalid ${name} without watching`, async () => {
    const result = await watch({ sessions: family }, ["ses_target", "--family", "--checkpoint", checkpoint(value), "--timeout", "1", "--json"])
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain(error)
    expect(result.control.subscriptions).toBe(0)
  }, 10_000)
}

test("family checkpoint boundary: an explicit conflicting root cursor is rejected", async () => {
  const result = await watch({ sessions: family }, ["ses_target", "--family", "--after", "1", "--checkpoint", checkpoint(familyCursor)])
  expect(result.exit).toBe(1)
  expect(result.stderr).toContain("--after conflicts with checkpoint")
}, 10_000)

test("family checkpoint boundary: a stalled snapshot preserves an unvisited child cursor", async () => {
  const saved = { ...familyCursor, cursors: [{ sessionID: "ses_target" }, { sessionID: "ses_child", after: 7 }] }
  const result = await familyBoundary({ sessions: family, stall: { operation: "session.snapshot", sessionID: "ses_child" } }, { checkpoint: checkpoint(saved) })
  expect(result.result.outcome).toMatchObject({ outcome: "timeout" })
  expect(JSON.parse(Buffer.from(result.result.checkpoint!, "base64url").toString()).cursors).toContainEqual({ sessionID: "ses_child", after: 7 })
}, 5_000)

test("family checkpoint boundary: zero cursor against absent watermark rejects empty history", async () => {
  const saved = { ...familyCursor, cursors: [{ sessionID: "ses_target", after: 0 }] }
  await expect(familyBoundary({}, { checkpoint: checkpoint(saved) })).rejects.toThrow(/ahead of current Session history/)
}, 5_000)

test("family checkpoint boundary: zero cursor against actual zero watermark remains valid", async () => {
  const saved = { ...familyCursor, cursors: [{ sessionID: "ses_target", after: 0 }] }
  const result = await familyBoundary({ log: { ses_target: [text(0, "Baseline", "commentary")] } }, { checkpoint: checkpoint(saved) })
  expect(result.result.outcome).toMatchObject({ outcome: "timeout" })
  expect(result.result.after).toBe(0)
}, 5_000)

test("family checkpoint boundary: undefined cursor against absent watermark remains valid", async () => {
  const saved = { ...familyCursor, cursors: [{ sessionID: "ses_target" }] }
  const result = await familyBoundary({}, { checkpoint: checkpoint(saved) })
  expect(result.result.outcome).toMatchObject({ outcome: "timeout" })
  expect(result.result.after).toBeUndefined()
}, 5_000)

test("family checkpoint boundary: an unsettled child terminal is replayed until post-cleanup assessment", async () => {
  const terminal = succeeded(2, "ses_child")
  const first = await familyBoundary({ sessions: family, active: ["ses_child"], outstanding: { running: ["ses_child"] },
    onSubscribe: (control) => { setTimeout(() => control.append("ses_child", terminal), 20) },
  })
  expect(first.result.outcome).toMatchObject({ outcome: "timeout" })
  const second = await familyBoundary({ sessions: family, log: { ses_child: [terminal] } }, { checkpoint: first.result.checkpoint })
  expect(second.result.outcome).toMatchObject({ outcome: "family", work: { state: "incomplete" } })
  expect(second.result.outcome).toHaveProperty("changes", [{ sessionID: "ses_child", type: terminal.type, id: terminal.id, seq: 2 }])
}, 5_000)

test("family checkpoint boundary: current root receipt is re-read rather than stored as checkpoint authority", async () => {
  const saved = { ...familyCursor, cursors: [{ sessionID: "ses_target", after: 6 }, { sessionID: "ses_child", after: 0 }] }
  const result = await familyBoundary({ sessions: family,
    log: { ses_target: [admitted(1, "msg_input"), started(2), promoted(3, "msg_input"), succeeded(5), receipt(6, "msg_input", "msg_answer")],
      ses_child: [succeeded(1, "ses_child")] },
  }, { checkpoint: checkpoint(saved) })
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "completed", receipt: { ...ref(6), inputID: "msg_input", assistantMessageID: "msg_answer", current: true } } })
  expect(result.result.outcome).not.toHaveProperty("execution")
}, 5_000)

test("family watch boundary: post-cleanup busy invalidation reports a running successor as running", async () => {
  const result = await familyBoundary({ sessions: family, active: ["ses_child"], onSubscribe: (control) => {
    setTimeout(() => control.append("ses_child", succeeded(1, "ses_child")), 20)
    setTimeout(() => control.push({ id: "evt_successor_busy", created: base, type: "session.status", data: { sessionID: "ses_child", status: { type: "busy" } } }), 50)
  } })
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "running" } })
}, 5_000)

test("family watch boundary: a newer terminal during assessment cannot consume its cursor with older work", async () => {
  const lost: string[] = []
  let reads = 0
  const failure = logEvent("session.execution.failed", 2, { sessionID: "ses_child", error: { type: "unknown", message: "Synthetic failure" } }, "ses_child")
  const result = await familyBoundary({ sessions: family, outstanding: { lost },
    onSubscribe: (control) => { setTimeout(() => control.append("ses_child", succeeded(1, "ses_child")), 20) },
    readActive: (control) => {
      if (++reads > 1) return Promise.resolve([])
      return new Promise((resolve) => { setTimeout(() => {
        lost.push("ses_child")
        control.append("ses_child", failure)
        resolve([])
      }, 20) })
    },
  })
  expect(result.result.outcome).toMatchObject({ outcome: "family", work: { state: "lost", lost: ["ses_child"] } })
  expect(result.result.outcome).toHaveProperty("changes", [{ sessionID: "ses_child", type: failure.type, id: failure.id, seq: 2 }])
  expect(reads).toBe(2)
}, 5_000)

test("family checkpoint boundary: a replaced source with a regressed root cursor fails without inventing input proof", async () => {
  const saved = { ...familyCursor, sourceEpoch: "epoch_old", cursors: [{ sessionID: "ses_target", after: 100 }] }
  await expect(familyBoundary({ log: { ses_target: [started(1), consumed(2, ["msg_new"]), succeeded(3)] } },
    { checkpoint: checkpoint(saved), input: "msg_old" })).rejects.toThrow(/history.*restart.*checkpoint/i)
}, 5_000)

test("family checkpoint boundary: an explicit same-epoch future root cursor is never lowered", async () => {
  const result = await familyBoundary({ log: { ses_target: [started(1), succeeded(3)] }, onSubscribe: (control) => {
    setTimeout(() => control.append("ses_target", succeeded(4)), 20)
  } }, { after: 100 })
  expect(result.result.outcome).toMatchObject({ outcome: "timeout" })
  expect(result.result.after).toBe(100)
  expect(JSON.parse(Buffer.from(result.result.checkpoint!, "base64url").toString()).cursors).toContainEqual({ sessionID: "ses_target", after: 100 })
}, 5_000)

test("family checkpoint boundary: a changed process epoch preserves valid durable cursors", async () => {
  const saved = { ...familyCursor, sourceEpoch: "epoch_old", cursors: [{ sessionID: "ses_target" }, { sessionID: "ses_child", after: 1 }] }
  const result = await familyBoundary({ sessions: family, log: { ses_child: [succeeded(1, "ses_child")] }, onSubscribe: (control) => {
    setTimeout(() => control.append("ses_child", succeeded(2, "ses_child")), 20)
  } }, { checkpoint: checkpoint(saved) })
  expect(result.result.outcome).toHaveProperty("changes", [{ sessionID: "ses_child", type: "session.execution.succeeded", id: "evt_ses_child_2", seq: 2 }])
}, 5_000)

test("an owner idle after its children drained, with open todos and no accepted receipt, is reported incomplete and never completed", async () => {
  const scenario: Scenario = {
    sessions: family,
    log: ownerRun(succeeded(9)),
    tasks: { ses_target: [task("ses_child", "completed", 4)] },
    todos: { ses_target: [todo("Port the parser", "in_progress"), todo("Port the tests", "pending"), todo("Plan the rewrite", "completed")], ses_other: [todo("Foreign", "pending")] },
    outstanding: { data: ["ses_other"], running: ["ses_other"], lost: ["ses_other"] },
    decisions: [decision("permission", "ses_other", "per_other")],
  }
  const json = await watch(scenario, ["ses_target", "--input", "msg_input", "--family", "--json"])
  expect(json.exit).toBe(0)
  const output = JSON.parse(json.stdout)
  expect(output.execution.status).toBe("succeeded")
  expect(output.work).toEqual(work("incomplete", {
    todos: { open: 2, items: [todo("Port the parser", "in_progress"), todo("Port the tests", "pending")] },
    children: { total: 1, active: 0, running: 0, waiting: 0 },
  }))
  expect(output.resume).toEqual(["ycoding", "decision", "watch", "ses_target", "--family", "--after", "9", "--checkpoint", output.checkpoint, "--server", json.url, "--json"])
  expect(JSON.parse(Buffer.from(output.checkpoint, "base64url").toString())).toEqual({
    version: 1, rootSessionID: "ses_target", sourceEpoch,
    cursors: [{ sessionID: "ses_target", after: 9 }, { sessionID: "ses_child" }],
  })
  const text = await watch(scenario, ["ses_target", "--input", "msg_input", "--family"])
  expect(text.exit).toBe(0)
  expect(text.stdout).toContain("Execution succeeded in Session \"Watched\" (ses_target).")
  expect(text.stdout).toContain("Work incomplete: no accepted completion receipt; 2 open todos.")
  expect(text.stdout).toContain("[in_progress] Port the parser")
  expect(text.stdout).toContain("Child tasks: 0 of 1 active.")
  expect(text.stdout).toContain("Watch the next transition: ycoding decision watch ses_target --family --after 9 --checkpoint ")
  expect(text.stdout).toContain(`--server ${text.url}`)
  expect(text.stdout).not.toContain("Work completed")
  for (const foreign of ["ses_other", "per_other", "Foreign"]) expect(text.stdout + json.stdout).not.toContain(foreign)
}, 60_000)

test("an idle owner with an open recovery review or a waiting child needs a decision with exact identities", async () => {
  const review = decision("review", "ses_child", "rev_recovery")
  const recovery = await watch({
    sessions: family, log: ownerRun(succeeded(9)), decisions: [review, decision("question", "ses_other", "que_other")],
    tasks: { ses_target: [task("ses_child", "failed", 5, { stoppedRecovery: { itemID: "rev_recovery" } })] }, todos: { ses_target: [todo("Port the parser", "pending")] },
  }, ["ses_target", "--input", "msg_input", "--family", "--json"])
  expect(recovery.exit).toBe(0)
  expect(JSON.parse(recovery.stdout).work).toEqual(work("needs-decision", {
    todos: { open: 1, items: [todo("Port the parser", "pending")] }, decisions: [review],
    tasks: [{ sessionID: "ses_child", parentID: "ses_target", state: "failed", revision: 5, description: "Synthetic ses_child", recoveryItemID: "rev_recovery" }],
    children: { total: 1, active: 0, running: 0, waiting: 0 },
  }))

  const waiting = await watch({
    sessions: family, log: ownerRun(succeeded(9)), decisions: [decision("question", "ses_child", "que_child")],
    tasks: { ses_target: [task("ses_child", "waiting", 3, { question: { id: "que_child", text: "Which parser?", time: base } })] },
  }, ["ses_target", "--input", "msg_input"])
  expect(waiting.exit).toBe(0)
  expect(waiting.stdout).toContain("Work needs a decision before it can continue. Add --family to list child Session decisions.")
  expect(waiting.stdout).toContain("ses_child waiting revision 3 (parent ses_target): Synthetic ses_child; question que_child")
  expect(waiting.stdout).not.toContain("Work incomplete")
}, 60_000)

test("live child and shell work is running even after the root execution settles", async () => {
  const child = await watch({
    sessions: family, log: ownerRun(succeeded(9)), todos: { ses_target: [todo("Port the parser", "in_progress")] },
    tasks: { ses_target: [task("ses_child", "running", 2)] }, outstanding: { data: ["ses_target"], running: ["ses_child"] },
  }, ["ses_target", "--input", "msg_input", "--family", "--json"])
  expect(child.exit).toBe(0)
  expect(JSON.parse(child.stdout).work).toEqual(work("running", {
    todos: { open: 1, items: [todo("Port the parser", "in_progress")] },
    tasks: [{ sessionID: "ses_child", parentID: "ses_target", state: "running", revision: 2, description: "Synthetic ses_child" }],
    children: { total: 1, active: 1, running: 1, waiting: 0 }, running: ["ses_child"],
  }))

  const shell = await watch({ log: ownerRun(succeeded(9)), outstanding: { data: ["ses_target"], running: ["ses_target"] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(JSON.parse(shell.stdout).work).toEqual(work("running", { running: ["ses_target"] }))

  const queued = await watch({ log: ownerRun(succeeded(9)), pending: { ses_target: 1 } }, ["ses_target", "--input", "msg_input"])
  expect(queued.exit).toBe(0)
  expect(queued.stdout).toContain("Work continues in the background")
  expect(queued.stdout).toContain("Pending inputs: 1")
}, 60_000)

test("an accepted completion receipt is reported apart from the execution terminal and counts only while current", async () => {
  const run = [admitted(1, "msg_input"), started(2), promoted(3, "msg_input"), succeeded(5), receipt(6, "msg_input", "msg_answer")]
  const accepted = { id: "evt_ses_target_6", seq: 6, inputID: "msg_input", assistantMessageID: "msg_answer" }
  const done = await watch({ log: { ses_target: run } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(done.exit).toBe(0)
  const output = JSON.parse(done.stdout)
  expect(output.execution.endEvent).toEqual(ref(5))
  expect(output.work).toEqual(work("completed", { receipt: { ...accepted, current: true } }))

  const stale = { ses_target: [todo("Port the tests", "pending")] }
  const openJson = await watch({ log: { ses_target: run }, todos: stale }, ["ses_target", "--input", "msg_input", "--json"])
  expect(JSON.parse(openJson.stdout).work).toEqual(work("completed", { receipt: { ...accepted, current: true }, todos: { open: 1, items: stale.ses_target } }))
  const open = await watch({ log: { ses_target: run }, todos: stale }, ["ses_target", "--input", "msg_input"])
  expect(open.stdout).toContain("Work completed: an accepted completion receipt is current.")
  expect(open.stdout).toContain("Receipt: evt_ses_target_6 (seq 6) accepted input msg_input with message msg_answer.")
  expect(open.stdout).toContain("Open todos in ses_target (1):\n  [pending] Port the tests")

  const superseded = await watch({ log: { ses_target: [...run, admitted(7, "msg_next")] }, pending: { ses_target: 1 } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(JSON.parse(superseded.stdout).work).toEqual(work("background", { receipt: { ...accepted, current: false }, pending: 1 }))
}, 60_000)

test("an owner still active after its terminal is reported running once, and the printed resume reconciles its later receipt", async () => {
  const settling = await watch({ log: ownerRun(succeeded(4)), active: ["ses_target"] }, ["ses_target", "--input", "msg_input", "--json"])
  expect(settling.exit).toBe(0)
  const output = JSON.parse(settling.stdout)
  expect(output.execution.status).toBe("succeeded")
  expect(output.work).toEqual(work("running"))
  expect(output.resume).toEqual(["ycoding", "decision", "watch", "ses_target", "--after", "4", "--server", settling.url, "--json"])
  expect(settling.requests.filter(({ name }) => name === "session.active")).toHaveLength(1)

  const resumed = await watch({ log: { ses_target: [...ownerRun(succeeded(4)).ses_target, receipt(5, "msg_input", "msg_answer")] } },
    ["ses_target", "--after", "4", "--timeout", "1", "--json"])
  expect(resumed.exit).toBe(3)
  expect(JSON.parse(resumed.stdout).work).toEqual(work("completed", { receipt: { id: "evt_ses_target_5", seq: 5, inputID: "msg_input", assistantMessageID: "msg_answer", current: true } }))
}, 30_000)

test("a pending decision outranks a running child task and a locally active owner, keeping the running details", async () => {
  const guardrail = decision("guardrail", "ses_child", "grd_child")
  const result = await watch({
    sessions: family, log: ownerRun(succeeded(9)), active: ["ses_target"], decisions: [guardrail, decision("guardrail", "ses_other", "grd_other")],
    tasks: { ses_target: [task("ses_child", "running", 7)] }, outstanding: { data: ["ses_target"], running: ["ses_target", "ses_child", "ses_other"] },
  }, ["ses_target", "--input", "msg_input", "--family", "--json"])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout).work).toEqual(work("needs-decision", {
    decisions: [guardrail], running: ["ses_child", "ses_target"], children: { total: 1, active: 1, running: 1, waiting: 0 },
    tasks: [{ sessionID: "ses_child", parentID: "ses_target", state: "running", revision: 7, description: "Synthetic ses_child" }],
  }))
}, 30_000)

test("restart-lost work is reported as lost, and an open execution the service does not report is unconfirmed rather than lost", async () => {
  const lost = await watch({
    sessions: family, log: ownerRun(logEvent("session.execution.interrupted", 4, { sessionID: "ses_target", reason: "shutdown" })),
    outstanding: { data: ["ses_target"], lost: ["ses_target"] }, tasks: { ses_target: [task("ses_child", "lost", 6), task("ses_done", "completed", 2)] },
  }, ["ses_target", "--input", "msg_input", "--json"])
  expect(lost.exit).toBe(0)
  const output = JSON.parse(lost.stdout)
  expect(output.execution).toMatchObject({ status: "interrupted", reason: "shutdown" })
  expect(output.work).toEqual(work("lost", {
    lost: ["ses_target"], children: { total: 2, active: 0, running: 0, waiting: 0 },
    tasks: [{ sessionID: "ses_child", parentID: "ses_target", state: "lost", revision: 6, description: "Synthetic ses_child" }],
  }))

  const open = { ses_target: [admitted(1, "msg_input"), started(2), promoted(3, "msg_input")] }
  const unconfirmed = await watch({ log: open }, ["ses_target", "--input", "msg_input", "--timeout", "1", "--json"])
  expect(unconfirmed.exit).toBe(3)
  const progress = JSON.parse(unconfirmed.stdout)
  expect(progress.progress.state).toBe("unconfirmed")
  expect(progress.work).toEqual(work("unconfirmed"))
  const text = await watch({ log: open }, ["ses_target", "--input", "msg_input", "--timeout", "1"])
  expect(text.exit).toBe(3)
  expect(text.stdout).toContain("State: unconfirmed")
  expect(text.stdout).not.toContain("lost")
}, 60_000)

test("reconnects and repeated events produce one settlement report with one work assessment", async () => {
  const result = await watch({ onSubscribe: (control) => {
    if (control.subscriptions === 1) {
      for (let index = 0; index < 5; index++) control.push(wake("ses_target"))
      setTimeout(() => control.drop(), 200)
      return
    }
    control.append("ses_target", started(4), consumed(5, ["msg_live"]), succeeded(6))
    for (let index = 0; index < 3; index++) control.push(wake("ses_target"))
  } }, ["ses_target", "--timeout", "20", "--json"])
  expect(result.exit).toBe(0)
  expect(result.control.subscriptions).toBe(2)
  expect(JSON.parse(result.stdout).execution.status).toBe("succeeded")
  expect(result.requests.filter(({ name }) => name === "session.outstanding")).toHaveLength(1)
  expect(result.requests.filter(({ name, data }) => name === "session.todo.list" && data.params?.sessionID === "ses_target")).toHaveLength(1)
}, 30_000)

test("a timeout reports the authoritative idle state with bounded todos", async () => {
  const many = Array.from({ length: 15 }, (_, index) => todo(`Step ${index}`, "pending"))
  const incomplete = await watch({ todos: { ses_target: many } }, ["ses_target", "--timeout", "1", "--json"])
  expect(incomplete.exit).toBe(3)
  const output = JSON.parse(incomplete.stdout)
  expect(output.progress).toEqual({ state: "idle" })
  expect(output.work).toEqual(work("incomplete", { todos: { open: 15, items: many.slice(0, 10) } }))
  const idle = await watch({}, ["ses_target", "--timeout", "1", "--json"])
  expect(idle.exit).toBe(3)
  expect(JSON.parse(idle.stdout).work).toEqual(work("idle"))
}, 30_000)

test("a waiting or running child hidden behind a full page of pinned completed tasks still decides the work state from the summary", async () => {
  const pinned = Array.from({ length: 10 }, (_, index) => task(`ses_pinned_${String(index).padStart(2, "0")}`, "completed", 1, { pinnedAt: base }))
  const current = { id: "evt_ses_target_6", seq: 6, inputID: "msg_input", assistantMessageID: "msg_answer", current: true }
  const log = { ses_target: [...ownerRun(succeeded(5)).ses_target, receipt(6, "msg_input", "msg_answer")] }
  const waiting = await watch({ log, active: ["ses_target"], tasks: { ses_target: [...pinned, task("ses_hidden", "waiting", 4)] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(waiting.exit).toBe(0)
  expect(JSON.parse(waiting.stdout).work).toEqual(work("needs-decision", {
    receipt: current, omittedTasks: 1, children: { total: 11, active: 1, running: 0, waiting: 1 },
  }))
  const text = await watch({ log, active: ["ses_target"], tasks: { ses_target: [...pinned, task("ses_hidden", "waiting", 4)] } }, ["ses_target", "--input", "msg_input"])
  expect(text.stdout).toContain("Work needs a decision before it can continue. Add --family to list child Session decisions.")
  expect(text.stdout).toContain("1 more active child task not listed (1 waiting on a decision); run ycoding api session.subagent.list --param parentID=ses_target and follow cursor.next.")
  expect(printedRequest(text.stdout, "session.subagent.list").request).toMatchObject({
    binding: { method: "session.subagent.list" }, data: { params: { parentID: "ses_target" }, query: {} },
  })
  expect(text.stdout).not.toContain("ses_hidden")

  const running = await watch({ log, tasks: { ses_target: [...pinned, task("ses_hidden", "running", 4)] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(running.exit).toBe(0)
  expect(JSON.parse(running.stdout).work).toEqual(work("running", {
    receipt: current, omittedTasks: 1, children: { total: 11, active: 1, running: 1, waiting: 0 },
  }))
}, 60_000)

test("a later execution that started and settled after the watched terminal is not reported running or borrowed as the watched result", async () => {
  const later = logEvent("session.execution.failed", 7, { sessionID: "ses_target", error: { type: "provider", message: "Later synthetic failure" } })
  const log = { ses_target: [...ownerRun(succeeded(5)).ses_target, started(6), later] }
  const watched = await watch({ log }, ["ses_target", "--input", "msg_input", "--json"])
  expect(watched.exit).toBe(0)
  const output = JSON.parse(watched.stdout)
  expect(output.execution).toEqual({ status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(5), startEvent: ref(2), endEvent: ref(5) })
  expect(output.work).toEqual(work("incomplete"))
  expect(output.after).toBe(5)
  expect(output.resume).toEqual(["ycoding", "decision", "watch", "ses_target", "--after", "5", "--server", watched.url, "--json"])

  const next = await watch({ log }, ["ses_target", "--after", "5", "--json"])
  expect(next.exit).toBe(0)
  expect(JSON.parse(next.stdout).execution).toEqual({ status: "failed", inputIDs: [], startedAt: iso(6), settledAt: iso(7), startEvent: ref(6), endEvent: ref(7),
    error: { type: "provider", message: "Later synthetic failure" } })
}, 30_000)

test("bounded child task and todo lists report how many entries were not listed", async () => {
  const children = Array.from({ length: 12 }, (_, index) => task(`ses_child_${String(index).padStart(2, "0")}`, "running", index))
  const many = Array.from({ length: 13 }, (_, index) => todo(`Step ${index}`, "in_progress"))
  const scenario: Scenario = { log: ownerRun(succeeded(9)), tasks: { ses_target: children }, todos: { ses_target: many }, outstanding: { data: ["ses_target"] } }
  const json = await watch(scenario, ["ses_target", "--input", "msg_input", "--json"])
  expect(json.exit).toBe(0)
  const output = JSON.parse(json.stdout).work
  expect(output.state).toBe("running")
  expect(output.tasks.map((item: { sessionID: string }) => item.sessionID)).toEqual(children.slice(0, 10).map((item) => item.sessionID))
  expect(output.omittedTasks).toBe(2)
  expect(output.children).toEqual({ total: 12, active: 12, running: 12, waiting: 0 })
  expect(output.todos).toEqual({ sessionID: "ses_target", open: 13, items: many.slice(0, 10) })
  expect(json.requests.some(({ name, data }) => name === "session.subagent.list" && data.params?.parentID === "ses_target" && data.query?.limit === 10)).toBe(true)
  const text = await watch(scenario, ["ses_target", "--input", "msg_input"])
  expect(text.stdout).toContain("Child tasks: 12 of 12 active.")
  expect(text.stdout).toContain("2 more active child tasks not listed; run ycoding api session.subagent.list --param parentID=ses_target and follow cursor.next.")
  expect(text.stdout).toContain("3 more not listed; run ycoding api server.session.session.todo.list --param sessionID=ses_target\n")
  expect(printedRequest(text.stdout, "server.session.session.todo.list").request).toMatchObject({
    binding: { method: "session.todo.list" }, data: { params: { sessionID: "ses_target" } },
  })
  expect(printedRequest(text.stdout, "session.subagent.list").request).toMatchObject({
    binding: { method: "session.subagent.list" }, data: { params: { parentID: "ses_target" }, query: {} },
  })

  const members = Array.from({ length: 21 }, (_, index) => `ses_member_${String(index).padStart(2, "0")}`)
  const wideScenario: Scenario = {
    sessions: { ses_target: { title: "Watched" }, ...Object.fromEntries(members.map((id) => [id, { title: "Member", parentID: "ses_target" }])) },
    log: ownerRun(succeeded(9)), outstanding: { data: members },
  }
  const wide = await watch(wideScenario, ["ses_target", "--input", "msg_input", "--family", "--json"])
  expect(wide.exit).toBe(0)
  expect(JSON.parse(wide.stdout).work.omittedParents).toBe(2)
  expect(wide.requests.filter(({ name }) => name === "session.subagent.list")).toHaveLength(20)
  const wideText = await watch(wideScenario, ["ses_target", "--input", "msg_input", "--family"])
  expect(wideText.stdout).toContain("Child tasks of 2 more family Sessions were not read; run ycoding api session.subagent.list --param parentID=<parent-session-id> for each parent Session in the family, starting with ses_target, and follow cursor.next.")
  const template = printedRequest(wideText.stdout, "session.subagent.list")
  expect(template.params).toEqual({ parentID: "<parent-session-id>" })
  expect(namedOperation("session.subagent.list", { parentID: "ses_member_20" }, undefined, new Headers())).toMatchObject({
    binding: { method: "session.subagent.list" }, data: { params: { parentID: "ses_member_20" }, query: {} },
  })
}, 60_000)

const unassessedLine = "Work not assessed: the Session state could not be read before the deadline."
const slowActive = () => Bun.sleep(3_000).then(() => [])
const resumeArgs = (resume: readonly string[]) => resume.slice(3).filter((value, index, all) => value !== "--server" && all[index - 1] !== "--server")

function expectUnavailable(...outputs: Record<string, unknown>[]) {
  expect(outputs).toMatchObject(outputs.map(() => ({ assessment: "unavailable" })))
  for (const output of outputs) expect(output).not.toHaveProperty("work")
}

test("an assessment cut off by the deadline marks a timeout result unavailable", async () => {
  const plain = await watch({ stall: "session.active" }, ["ses_target", "--timeout", "1"])
  expect(plain.exit).toBe(3)
  expect(plain.stdout).toContain(unassessedLine)
  const json = await watch({ stall: "session.active" }, ["ses_target", "--timeout", "1", "--json"])
  expect(json.exit).toBe(3)
  expect(json.requests.some(({ name }) => name === "session.active")).toBe(true)
  const output = JSON.parse(json.stdout)
  expect(output).toMatchObject({ outcome: "timeout", sessionID: "ses_target", progress: { state: "unconfirmed" } })
  const familyJson = await watch({ sessions: family, readActive: slowActive }, ["ses_target", "--family", "--timeout", "1", "--json"])
  expect(familyJson.exit).toBe(3)
  const familyOutput = JSON.parse(familyJson.stdout)
  expect(familyOutput).toMatchObject({ outcome: "timeout", sessionID: "ses_target", progress: { state: "unconfirmed" } })
  expect(typeof familyOutput.checkpoint).toBe("string")
  expectUnavailable(output, familyOutput)
}, 30_000)

const unavailableState = "State: unconfirmed; the Session state could not be assessed before the deadline, so whether it is executing is unknown"

test("a re-armed watch past an open execution's start reports unconfirmed, not idle, when the assessment is unavailable", async () => {
  const scenario = { log: { ses_target: [started(2), promoted(3, "msg_live")] }, active: ["ses_target"], stall: "session.active" }
  const json = await watch(scenario, ["ses_target", "--after", "3", "--timeout", "1", "--json"])
  expect(json.exit).toBe(3)
  const output = JSON.parse(json.stdout)
  expect(output).toMatchObject({ outcome: "timeout", after: 3, progress: { state: "unconfirmed" } })
  expectUnavailable(output)
  const text = await watch(scenario, ["ses_target", "--after", "3", "--timeout", "1"])
  expect(text.exit).toBe(3)
  expect(text.stdout).toContain(unavailableState)
  expect(text.stdout).not.toContain("does not report it active")
  expect(text.stdout).not.toContain("State: idle")
}, 30_000)

test("a timeout whose assessment never ran after an aborted read reports unconfirmed", async () => {
  const json = await watch({ stall: "decision.list" }, ["ses_target", "--timeout", "1", "--json"])
  expect(json.exit).toBe(3)
  const output = JSON.parse(json.stdout)
  expect(output).toMatchObject({ outcome: "timeout", progress: { state: "unconfirmed" } })
  expectUnavailable(output)
  const text = await watch({ stall: "decision.list" }, ["ses_target", "--timeout", "1"])
  expect(text.stdout).toContain(unavailableState)
}, 30_000)

test("a completed assessment with no execution still reports idle", async () => {
  const json = await watch({}, ["ses_target", "--timeout", "1", "--json"])
  expect(JSON.parse(json.stdout)).toMatchObject({ outcome: "timeout", progress: { state: "idle" }, work: { state: "idle" } })
  const text = await watch({}, ["ses_target", "--timeout", "1"])
  expect(text.exit).toBe(3)
  expect(text.stdout).toContain("State: idle\n")
  expect(text.stdout).not.toContain(unassessedLine)
}, 30_000)

test("an assessment cut off by the deadline marks a settled result unavailable", async () => {
  const plain = await watch({ log: ownerRun(succeeded(4)), stall: "session.active" }, ["ses_target", "--input", "msg_input", "--timeout", "1"])
  expect(plain.exit).toBe(0)
  expect(plain.stdout).toContain("Execution succeeded in Session \"Watched\" (ses_target).")
  expect(plain.stdout).toContain(unassessedLine)
  const settled = { status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(4), startEvent: ref(2), endEvent: ref(4) }
  const json = await watch({ log: ownerRun(succeeded(4)), stall: "session.active" }, ["ses_target", "--input", "msg_input", "--timeout", "1", "--json"])
  expect(json.exit).toBe(0)
  const output = JSON.parse(json.stdout)
  expect(output).toMatchObject({ outcome: "settled", sessionID: "ses_target", after: 4, execution: settled })
  const familyJson = await watch({ sessions: family, log: ownerRun(succeeded(4)), readActive: slowActive },
    ["ses_target", "--family", "--input", "msg_input", "--timeout", "1", "--json"])
  expect(familyJson.exit).toBe(0)
  const familyOutput = JSON.parse(familyJson.stdout)
  expect(familyOutput).toMatchObject({ outcome: "settled", sessionID: "ses_target", after: 4, execution: settled })
  expectUnavailable(output, familyOutput)
}, 30_000)

test("a read cut off by the deadline outside the assessment marks the timeout result unavailable", async () => {
  const outputs: Record<string, unknown>[] = []
  for (const args of [["--json"], ["--family", "--json"]]) {
    const result = await watch({ sessions: family, stall: "decision.list" }, ["ses_target", "--timeout", "1", ...args])
    expect(result.exit).toBe(3)
    expect(result.requests.some(({ name }) => name === "session.active")).toBe(false)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ outcome: "timeout", sessionID: "ses_target", progress: { state: "unconfirmed" } })
    outputs.push(output)
  }
  const plain = await watch({ stall: "decision.list" }, ["ses_target", "--timeout", "1"])
  expect(plain.exit).toBe(3)
  expect(plain.stdout).toContain(unassessedLine)
  const changed = await watch({ sessions: family, readActive: slowActive, onSubscribe: (control) => {
    setTimeout(() => control.append("ses_child", succeeded(1, "ses_child")), 20)
  } }, ["ses_target", "--family", "--timeout", "1", "--json"])
  expect(changed.exit).toBe(3)
  expect(changed.requests.filter(({ name }) => name === "session.active")).toHaveLength(1)
  const output = JSON.parse(changed.stdout)
  expect(output).toMatchObject({ outcome: "timeout", sessionID: "ses_target" })
  expectUnavailable(...outputs, output)
}, 30_000)

test("a watch resumed after an unavailable assessment reports the normal assessment once reads succeed", async () => {
  const log = ownerRun(succeeded(4))
  const completed = work("completed", { receipt: { id: "evt_ses_target_5", seq: 5, inputID: "msg_input", assistantMessageID: "msg_answer", current: true } })
  const cut = await watch({ log, stall: "session.active" }, ["ses_target", "--after", "4", "--timeout", "1", "--json"])
  expect(cut.exit).toBe(3)
  const first = JSON.parse(cut.stdout)
  expectUnavailable(first)
  expect(first.resume).toEqual(["ycoding", "decision", "watch", "ses_target", "--after", "4", "--server", cut.url, "--timeout", "1", "--json"])
  const resumed = await watch({ log: { ses_target: [...log.ses_target, receipt(5, "msg_input", "msg_answer")] } }, resumeArgs(first.resume))
  expect(resumed.exit).toBe(3)
  const output = JSON.parse(resumed.stdout)
  expect(output).not.toHaveProperty("assessment")
  expect(output.work).toEqual(completed)

  const familyCut = await watch({ sessions: family, log, readActive: slowActive }, ["ses_target", "--family", "--timeout", "1", "--json"])
  expect(familyCut.exit).toBe(3)
  const familyFirst = JSON.parse(familyCut.stdout)
  expectUnavailable(familyFirst)
  expect(familyFirst.resume).toContain("--checkpoint")
  const familyResumed = await watch({ sessions: family, log: { ses_target: [...log.ses_target, receipt(5, "msg_input", "msg_answer")] } }, resumeArgs(familyFirst.resume))
  expect(familyResumed.exit).toBe(0)
  const familyOutput = JSON.parse(familyResumed.stdout)
  expect(familyOutput).toMatchObject({ outcome: "family", changes: [{ sessionID: "ses_target", type: "session.work.completed", id: "evt_ses_target_5", seq: 5 }] })
  expect(familyOutput).not.toHaveProperty("assessment")
  expect(familyOutput.work).toEqual(completed)
}, 30_000)

test("cancelling or killing a watch during a stalled assessment prints no result and no assessment", async () => {
  for (const signal of ["SIGINT", "SIGKILL"] as const) {
    const result = await watch({ log: ownerRun(succeeded(4)), stall: "session.active" }, ["ses_target", "--input", "msg_input", "--timeout", "30", "--json"],
      { signalAtRead: { signal, operation: "session.active" } })
    expect(result.requests.some(({ name }) => name === "session.active")).toBe(true)
    expect(result.stdout).toBe("")
    expect([0, 2, 3]).not.toContain(result.exit)
  }
}, 30_000)

test("queued work in outstanding data blocks completion only inside the watched scope", async () => {
  const log = { ses_target: [...ownerRun(succeeded(4)).ses_target, receipt(5, "msg_input", "msg_answer")] }
  const receiptWork = { id: "evt_ses_target_5", seq: 5, inputID: "msg_input", assistantMessageID: "msg_answer", current: true }
  const reported = async (outstanding: string[], args: string[]) => {
    const result = await watch({ sessions: family, log, outstanding: { data: outstanding } }, ["ses_target", "--timeout", "1", "--json", ...args])
    return [result.exit, JSON.parse(result.stdout).work]
  }
  expect(await reported(["ses_child"], ["--family"])).toEqual([3, work("background", { receipt: receiptWork })])
  expect(await reported(["ses_other"], ["--family"])).toEqual([3, work("completed", { receipt: receiptWork })])
  expect(await reported([], ["--family"])).toEqual([3, work("completed", { receipt: receiptWork })])
  expect(await reported(["ses_child"], ["--after", "4"])).toEqual([3, work("completed", { receipt: receiptWork })])
}, 60_000)
