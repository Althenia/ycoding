import { afterEach, expect, test } from "bun:test"
import type { DecisionItem, EventSubscribeOutput, SessionLogOutput, SessionSnapshotOutput, SessionSubagentListOutput, SessionTodoListOutput } from "@ycoding-ai/client/promise"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { ClientApi } from "@ycoding-ai/protocol/client"
import { OpenApi } from "effect/unstable/httpapi"
import { resolveOperation } from "../src/commands/handlers/api"

type LogType = Exclude<SessionLogOutput["type"], "log.synced">
type LogEvent = Exclude<SessionLogOutput, { type: "log.synced" }>
type Data<T extends LogType> = Extract<SessionLogOutput, { type: T }>["data"]

const base = Date.UTC(2026, 9, 29, 12, 0, 0)
const iso = (seq: number) => new Date(base + seq * 1_000).toISOString()

function logEvent<T extends LogType>(type: T, seq: number, data: Data<T>, sessionID = "ses_target"): LogEvent {
  return { id: `evt_${sessionID}_${seq}`, created: base + seq * 1_000, sourceEpoch: "epoch_synthetic", type, durable: { aggregateID: sessionID, seq, version: 1 }, data } as LogEvent
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
  return { params, request: resolveOperation(JSON.parse(JSON.stringify(OpenApi.fromApi(ClientApi))), operation, params) }
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
}

type Scenario = {
  readonly sessions?: Record<string, { readonly title: string; readonly parentID?: string }>
  readonly log?: Record<string, LogEvent[]>
  readonly decisions?: DecisionItem[]
  readonly messages?: Message[]
  readonly watermark?: number
  readonly stall?: string
  readonly active?: string[]
  readonly outstanding?: { readonly data?: string[]; readonly running?: string[]; readonly lost?: string[] }
  readonly todos?: Record<string, Todo[]>
  readonly pending?: Record<string, number>
  readonly tasks?: Record<string, Task[]>
  readonly onSubscribe?: (control: Control) => void
  readonly onLog?: (logs: Map<string, LogEvent[]>, count: number) => void
}

const home = `${process.env.YCODING_TEST_XDG_ROOT}/home`
const servers: Array<{ stop: (force?: boolean) => unknown }> = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

function stub(scenario: Scenario) {
  const sessions = scenario.sessions ?? { ses_target: { title: "Watched" }, ses_other: { title: "Unrelated" } }
  const logs = new Map(Object.entries(scenario.log ?? {}))
  let decisions = scenario.decisions ?? []
  const requests: string[] = []
  let logReads = 0
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
  const control: Control = {
    subscriptions: 0,
    append: (sessionID, ...items) => logs.set(sessionID, [...(logs.get(sessionID) ?? []), ...items]),
    decisions: (items) => { decisions = items },
    push: (event) => { for (const stream of streams) stream.enqueue(frame(event)) },
    drop: () => { for (const stream of streams) stream.close(); streams.clear() },
  }
  const last = (id: string) => {
    const items = logs.get(id) ?? []
    return items.length ? Math.max(...items.map((item) => item.durable.seq)) : undefined
  }
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    if (path === "/api/health") return Response.json({ healthy: true, version: InstallationVersion, pid: process.pid })
    requests.push(`${request.method} ${path}${url.search}`)
    if (path === scenario.stall) return new Promise<Response>(() => {})
    if (path === "/api/session/active")
      return Response.json({ data: Object.fromEntries((scenario.active ?? []).map((id) => [id, { type: "running" }])) })
    if (path === "/api/session/outstanding")
      return Response.json({ data: scenario.outstanding?.data ?? [], running: scenario.outstanding?.running ?? [], failed: [], lost: scenario.outstanding?.lost ?? [] })
    const nested = /^\/api\/session\/([^/]+)\/(todo|pending|subagent)$/.exec(path)
    if (nested) {
      const id = decodeURIComponent(nested[1])
      if (nested[2] === "todo") return Response.json({ data: scenario.todos?.[id] ?? [] })
      if (nested[2] === "pending") return Response.json({ data: Array.from({ length: scenario.pending?.[id] ?? 0 }, (_, index) => ({
        admittedSeq: index, id: `msg_pending_${index}`, sessionID: id, timeCreated: base, type: "user", data: { text: "Queued" }, delivery: "queue" })) })
      const tasks = scenario.tasks?.[id] ?? []
      const count = (states: Task["state"][]) => tasks.filter((item) => states.includes(item.state)).length
      return Response.json({ data: tasks.slice(0, Number(url.searchParams.get("limit") ?? 10)), cursor: {},
        summary: { total: tasks.length, active: count(["starting", "running", "waiting", "cancelling"]), running: count(["running"]), waiting: count(["waiting"]) } })
    }
    if (path === "/api/session") {
      const parentID = url.searchParams.get("parentID")
      return Response.json({ data: Object.entries(sessions).filter(([, session]) => session.parentID === parentID).map(([id, session]) => ({ id, title: session.title, parentID })), cursor: {} })
    }
    const sessionMatch = /^\/api\/session\/([^/]+)(\/snapshot)?$/.exec(path)
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!)
      const session = sessions[id]
      if (!session) return Response.json({ _tag: "SessionNotFoundError", sessionID: id, message: `Session not found: ${id}` }, { status: 404 })
      const info = { id, title: session.title, ...(session.parentID ? { parentID: session.parentID } : {}), projectID: "prj_synthetic",
        location: { directory: "/tmp/watched" }, time: { created: base, updated: base } }
      if (!sessionMatch[2]) return Response.json({ data: info })
      const seq = scenario.watermark ?? last(id)
      return Response.json({ sourceEpoch: "epoch_synthetic", session: info, messages: scenario.messages ?? [], watermark: { type: "log.synced", aggregateID: id, ...(seq === undefined ? {} : { seq }) } })
    }
    const logMatch = /^\/api\/experimental\/session\/([^/]+)\/log$/.exec(path)
    if (logMatch) {
      const id = decodeURIComponent(logMatch[1]!)
      if (!sessions[id]) return Response.json({ _tag: "SessionNotFoundError", sessionID: id, message: `Session not found: ${id}` }, { status: 404 })
      expect(url.searchParams.get("follow")).toBe("false")
      scenario.onLog?.(logs, ++logReads)
      const after = Number(url.searchParams.get("after") ?? -1)
      const items = (logs.get(id) ?? []).filter((item) => item.durable.seq > after)
      const seq = last(id)
      const body = [...items, { type: "log.synced", aggregateID: id, ...(seq === undefined ? {} : { seq }), sourceEpoch: "epoch_synthetic" }].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/api/event") {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        streams.add(controller)
        controller.enqueue(frame({ id: "evt_connected", type: "server.connected", data: {} }))
        Object.assign(control, { subscriptions: control.subscriptions + 1 })
        queueMicrotask(() => scenario.onSubscribe?.(control))
      } })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    }
    if (path === "/api/decision") return Response.json({ data: decisions })
    return new Response("not found", { status: 404 })
  } })
  servers.push(server)
  return { url: server.url.toString(), requests, control }
}

async function watch(scenario: Scenario, args: string[], options: { entry?: "tui" | "index"; signalAfterSubscribe?: NodeJS.Signals } = {}) {
  const server = stub(scenario)
  const child = Bun.spawn([process.execPath, new URL(`../src/${options.entry ?? "tui"}.ts`, import.meta.url).pathname, "decision", "watch", ...args, "--server", server.url], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, YCODING_TEST_HOME: home, YCODING_PASSWORD: "" },
  })
  if (options.signalAfterSubscribe) {
    const deadline = Date.now() + 20_000
    while (server.control.subscriptions === 0 && Date.now() < deadline) await Bun.sleep(25)
    child.kill(options.signalAfterSubscribe)
  }
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  for (const request of server.requests) expect(request.startsWith("GET ")).toBe(true)
  return { stdout, stderr, exit, requests: server.requests, control: server.control, url: server.url }
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
  expect(resumed.requests.some((request) => request.includes("/log?after=1"))).toBe(true)
}, 60_000)

test("without an input the watch ignores history and returns on the next settlement", async () => {
  const result = await watch({ log: { ses_target: [started(1), succeeded(3)] }, onSubscribe: (control) => {
    control.append("ses_target", started(4), consumed(5, ["msg_live"]), succeeded(6))
    control.push(wake("ses_target"))
  } }, ["ses_target", "--json"])
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_live"], startedAt: iso(4), settledAt: iso(6), startEvent: ref(4), endEvent: ref(6) })
  expect(result.requests.some((request) => request.startsWith("GET /api/session/ses_target/snapshot"))).toBe(true)
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
  expect(result.requests.some((request) => request.startsWith("GET /api/event"))).toBe(false)
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
  const result = await watch({ stall: "/api/decision" }, ["ses_target", "--timeout", "1", "--json"])
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
  expect(result.requests.some((request) => request.includes("/log?after=0"))).toBe(true)
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
  const reads = result.requests.filter((request) => request.startsWith("GET /api/experimental/session/ses_target/log"))
  expect(reads.filter((request) => !request.includes("after=")).length).toBe(2)
  expect(reads.filter((request) => request.includes("after=")).every((request) => request.includes("after=2"))).toBe(true)
}, 30_000)

test("an input promoted at or before --after is refused instead of waiting", async () => {
  const result = await watch({ log: { ses_target: [started(1), promoted(2, "msg_input"), succeeded(3)] }, messages: [user("msg_input"), assistant("msg_a1", "Done.")] },
    ["ses_target", "--input", "msg_input", "--after", "3", "--timeout", "20"])
  expect(result.exit).toBe(1)
  expect(result.stderr).toContain("Input msg_input ran at or before --after 3; rerun without --after")
  expect(result.stdout).toBe("")
}, 30_000)

test("duplicate decisions print once and an item too large to print is named without a partial command", async () => {
  const large = { ...decision("form", "ses_target", "frm_large"), summary: "x".repeat(300 * 1024) }
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
    expect(result.stdout).not.toContain("itemID=frm_large")
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
  expect(output.resume).toEqual(["ycoding", "decision", "watch", "ses_target", "--family", "--after", "9", "--server", json.url, "--json"])
  const text = await watch(scenario, ["ses_target", "--input", "msg_input", "--family"])
  expect(text.exit).toBe(0)
  expect(text.stdout).toContain("Execution succeeded in Session \"Watched\" (ses_target).")
  expect(text.stdout).toContain("Work incomplete: no accepted completion receipt; 2 open todos.")
  expect(text.stdout).toContain("[in_progress] Port the parser")
  expect(text.stdout).toContain("Child tasks: 0 of 1 active.")
  expect(text.stdout).toContain(`Watch the next transition: ycoding decision watch ses_target --family --after 9 --server ${text.url}`)
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

test("active background work is reported as background, never as a stall or completion", async () => {
  const child = await watch({
    sessions: family, log: ownerRun(succeeded(9)), todos: { ses_target: [todo("Port the parser", "in_progress")] },
    tasks: { ses_target: [task("ses_child", "running", 2)] }, outstanding: { data: ["ses_target"], running: ["ses_child"] },
  }, ["ses_target", "--input", "msg_input", "--family", "--json"])
  expect(child.exit).toBe(0)
  expect(JSON.parse(child.stdout).work).toEqual(work("background", {
    todos: { open: 1, items: [todo("Port the parser", "in_progress")] },
    tasks: [{ sessionID: "ses_child", parentID: "ses_target", state: "running", revision: 2, description: "Synthetic ses_child" }],
    children: { total: 1, active: 1, running: 1, waiting: 0 }, running: ["ses_child"],
  }))

  const shell = await watch({ log: ownerRun(succeeded(9)), outstanding: { data: ["ses_target"], running: ["ses_target"] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(JSON.parse(shell.stdout).work).toEqual(work("background", { running: ["ses_target"] }))

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
  expect(settling.requests.filter((request) => request.startsWith("GET /api/session/active")).length).toBe(1)

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
  expect(result.requests.filter((request) => request.startsWith("GET /api/session/outstanding")).length).toBe(1)
  expect(result.requests.filter((request) => request.startsWith("GET /api/session/ses_target/todo")).length).toBe(1)
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
  expect(printedRequest(text.stdout, "session.subagent.list").request).toEqual({ method: "GET", path: "/api/session/ses_target/subagent" })
  expect(text.stdout).not.toContain("ses_hidden")

  const running = await watch({ log, tasks: { ses_target: [...pinned, task("ses_hidden", "running", 4)] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(running.exit).toBe(0)
  expect(JSON.parse(running.stdout).work).toEqual(work("background", {
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
  expect(output.state).toBe("background")
  expect(output.tasks.map((item: { sessionID: string }) => item.sessionID)).toEqual(children.slice(0, 10).map((item) => item.sessionID))
  expect(output.omittedTasks).toBe(2)
  expect(output.children).toEqual({ total: 12, active: 12, running: 12, waiting: 0 })
  expect(output.todos).toEqual({ sessionID: "ses_target", open: 13, items: many.slice(0, 10) })
  expect(json.requests).toContain("GET /api/session/ses_target/subagent?limit=10")
  const text = await watch(scenario, ["ses_target", "--input", "msg_input"])
  expect(text.stdout).toContain("Child tasks: 12 of 12 active.")
  expect(text.stdout).toContain("2 more active child tasks not listed; run ycoding api session.subagent.list --param parentID=ses_target and follow cursor.next.")
  expect(text.stdout).toContain("3 more not listed; run ycoding api server.session.session.todo.list --param sessionID=ses_target\n")
  expect(printedRequest(text.stdout, "server.session.session.todo.list").request).toEqual({ method: "GET", path: "/api/session/ses_target/todo" })
  expect(printedRequest(text.stdout, "session.subagent.list").request).toEqual({ method: "GET", path: "/api/session/ses_target/subagent" })

  const members = Array.from({ length: 21 }, (_, index) => `ses_member_${String(index).padStart(2, "0")}`)
  const wideScenario: Scenario = {
    sessions: { ses_target: { title: "Watched" }, ...Object.fromEntries(members.map((id) => [id, { title: "Member", parentID: "ses_target" }])) },
    log: ownerRun(succeeded(9)), outstanding: { data: members },
  }
  const wide = await watch(wideScenario, ["ses_target", "--input", "msg_input", "--family", "--json"])
  expect(wide.exit).toBe(0)
  expect(JSON.parse(wide.stdout).work.omittedParents).toBe(2)
  expect(wide.requests.filter((request) => /^GET \/api\/session\/[^/]+\/subagent/.test(request)).length).toBe(20)
  const wideText = await watch(wideScenario, ["ses_target", "--input", "msg_input", "--family"])
  expect(wideText.stdout).toContain("Child tasks of 2 more family Sessions were not read; run ycoding api session.subagent.list --param parentID=<parent-session-id> for each parent Session in the family, starting with ses_target, and follow cursor.next.")
  const template = printedRequest(wideText.stdout, "session.subagent.list")
  expect(template.params).toEqual({ parentID: "<parent-session-id>" })
  expect(resolveOperation(JSON.parse(JSON.stringify(OpenApi.fromApi(ClientApi))), "session.subagent.list", { parentID: "ses_member_20" }))
    .toEqual({ method: "GET", path: "/api/session/ses_member_20/subagent" })
}, 60_000)
