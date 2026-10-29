import { afterEach, expect, test } from "bun:test"
import type { DecisionItem, EventSubscribeOutput, SessionLogOutput, SessionSnapshotOutput } from "@ycoding-ai/client/promise"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"

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
    execution: { status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(6), settledAt: iso(10), response: "Done: watched answer." },
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
  expect(JSON.parse(interrupted.stdout).execution).toEqual({ status: "interrupted", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(5), reason: "user" })

  const rejected = await watch({ log: { ses_target: [logEvent("session.dots.instruction.rejected", 2, {
    sessionID: "ses_target", inputID: "msg_input", anchorSessionID: "ses_target", exchangeID: "dex_synthetic", delegationID: "ddl_synthetic", reason: "delegation_invalid",
  } as Data<"session.dots.instruction.rejected">)] } }, ["ses_target", "--input", "msg_input", "--json"])
  expect(rejected.exit).toBe(0)
  expect(JSON.parse(rejected.stdout).execution).toEqual({ status: "rejected", inputIDs: ["msg_input"], settledAt: iso(2), reason: "delegation_invalid" })
}, 60_000)

test("a timeout reports progress and a resume cursor that replays the open execution", async () => {
  const log = [started(2), promoted(3, "msg_input"), logEvent("session.tool.called", 4, { sessionID: "ses_target", assistantMessageID: "msg_assistant", callID: "call_1", input: {}, executed: true } as Data<"session.tool.called">), text(5, "Still working.", "commentary")]
  const timeout = await watch({ log: { ses_target: log } }, ["ses_target", "--input", "msg_input", "--timeout", "1", "--json"])
  expect(timeout.exit).toBe(3)
  expect(JSON.parse(timeout.stdout)).toEqual({
    outcome: "timeout", sessionID: "ses_target", after: 1,
    progress: { state: "running", startedAt: iso(2), toolCalls: 1, input: "promoted", latest: "Still working." },
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
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_live"], startedAt: iso(4), settledAt: iso(6) })
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
  expect(JSON.parse(observed.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(4) })

  const failure = logEvent("session.execution.failed", 4, { sessionID: "ses_target", error: { type: "provider", message: "Synthetic request failure" } })
  const beforeOutput = await watch({ log: { ses_target: [started(2), promoted(3, "msg_input"), failure] } },
    ["ses_target", "--input", "msg_input", "--after", "2", "--json"])
  expect(beforeOutput.exit).toBe(0)
  expect(JSON.parse(beforeOutput.stdout).execution).toEqual({ status: "failed", inputIDs: ["msg_input"], startedAt: iso(2), settledAt: iso(4),
    error: { type: "provider", message: "Synthetic request failure" } })

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
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_input"], startedAt: iso(0), settledAt: iso(2) })
  expect(result.requests.filter((request) => request.startsWith("GET /api/experimental/session/ses_target/log")).every((request) => !request.includes("after="))).toBe(true)
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
  expect(JSON.parse(result.stdout).execution).toEqual({ status: "succeeded", inputIDs: ["msg_other", "msg_input"], startedAt: iso(1), settledAt: iso(5), response: "Steered answer." })
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
