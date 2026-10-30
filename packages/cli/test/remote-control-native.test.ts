import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Session } from "@ycoding-ai/schema/session"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import { createRemoteControlBackend } from "../src/remote-control/backend"
import { createRemoteControlAppServer } from "../src/remote-control/app-server"
import { encodeOutbound } from "../src/remote-control/envelope"
import type { EventManifest } from "@ycoding-ai/schema/event-manifest"
import { sessionInfo } from "./remote-control-fixture"

const root = sessionInfo({ id: "ses_root", title: "Native", directory: "/recorded", updatedAt: 1_700_000_000.789 })
const candidate = (id: string): NativeDots.NativeRequest => ({
  id, threadID: root.id, turnID: "turn", itemID: "item",
  questions: [{ id: "choice", header: "Decision", question: "Choose", isOther: false, isSecret: false, options: [{ label: "Allow once", description: "Exact operation" }, { label: "Reject", description: "No operation" }] }],
  handle: {} as NativeDots.Candidate,
})

function fixture(messages: readonly SessionMessage.Info[] = []) {
  let snapshot: NativeDots.RootSnapshot = { session: root, active: false, waiting: [] }
  const calls: string[] = []
  let live = true
  let requests = [candidate("request")]
  const sent: Record<string, unknown>[] = []
  const settled: Array<{ handle: NativeDots.Candidate; answers: NativeDots.Answers }> = []
  const created: unknown[] = []
  const prompted: unknown[] = []
  const admitted = new Map<string, string>()
  const mutations: unknown[] = []
  let stops = 0
  let listener: Parameters<NativeDots.Channel["subscribe"]>[1] | undefined
  let onRetire: (() => void) | undefined
  let settlement: { entered: ReturnType<typeof Promise.withResolvers<void>>; released: ReturnType<typeof Promise.withResolvers<void>> } | undefined
  let subscription: { entered: ReturnType<typeof Promise.withResolvers<void>>; released: ReturnType<typeof Promise.withResolvers<void>> } | undefined
  const channel: NativeDots.Channel = {
    listRoots: async () => { calls.push("list"); return [snapshot] },
    getRoot: async (id) => { calls.push("get"); return id === root.id ? snapshot : undefined },
    readRoot: async (id) => { calls.push("read"); if (id !== root.id) throw Error("Unavailable"); return { ...snapshot, messages: [...messages] } },
    createRoot: async (input) => { calls.push("create"); if (input.directory !== snapshot.session.location.directory) throw Error("Unrecorded"); created.push(input); return snapshot },
    prompt: async (input) => {
      prompted.push(input)
      calls.push("prompt")
      if (!admitted.has(input.inputID)) admitted.set(input.inputID, admitted.size === 0 ? "message" : `message_${admitted.size}`)
      return { messageID: admitted.get(input.inputID)! }
    }, interrupt: async () => { calls.push("interrupt") },
    pending: async () => { calls.push("pending"); if (!live) throw Error("Retired"); return requests },
    settle: async (handle, answers) => {
      settlement?.entered.resolve()
      await settlement?.released.promise
      if (!live || !requests.some((item) => item.handle === handle)) throw Error("Stale")
      settled.push({ handle, answers }); requests = []
    },
    subscribe: async (_root, next, retired) => {
      calls.push("subscribe")
      listener = next; onRetire = retired
      subscription?.entered.resolve()
      await subscription?.released.promise
      return () => { stops++ }
    },
    retire: () => { live = false },
    models: async () => [], skills: async () => [],
    renameRoot: async (input) => { calls.push("rename"); mutations.push(["rename", input]) },
    archiveRoot: async (id) => { calls.push("archive"); mutations.push(["archive", id]) },
    unarchiveRoot: async (id) => { calls.push("unarchive"); mutations.push(["unarchive", id]); if (id !== root.id) throw Error("Unavailable"); return snapshot },
    removeRoot: async (id) => { calls.push("remove"); mutations.push(["remove", id]); if (id !== root.id) throw Error("Unavailable") },
    subscribeEscalations: async () => () => {},
  }
  const backend = createRemoteControlBackend({ channel, profile: "profile" })
  const server = createRemoteControlAppServer({ backend, codexHome: "/synthetic", requestScope: "client:stream", send: (text) => sent.push(JSON.parse(text)) })
  const rpc = async (method: string, params: unknown = {}, id = 1) => JSON.parse((await server.handle(JSON.stringify({ id, method, params })))!)
  const initialize = async () => { await rpc("initialize", { clientInfo: { name: "fixture" } }); await server.handle(JSON.stringify({ method: "initialized" })) }
  return { server, sent, settled, created, prompted, calls, mutations, rpc, initialize, setSnapshot: (next: Partial<NativeDots.RootSnapshot>) => { snapshot = { ...snapshot, ...next } }, requests: () => requests, replace: (next: NativeDots.NativeRequest[]) => { requests = next }, listener: () => listener, stops: () => stops,
    emit: (type: string, data: Record<string, unknown> = {}, createdAtMs = 1_700_000_000_000) => listener?.({ type, created: DateTime.makeUnsafe(createdAtMs), data: { sessionID: root.id, ...data } } as EventManifest.ServerEvent),
    revoke: () => onRetire?.(),
    holdSettlement: () => { settlement = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }; return settlement },
    holdSubscription: () => { subscription = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }; return subscription },
  }
}

test("native Thread exposes the stable installed shape without creator or provider fabrication", async () => {
  const system = Schema.decodeUnknownSync(SessionMessage.Info)({ id: "msg_preview_system", type: "system", text: "Synthetic system text", time: { created: 1 } })
  const user = Schema.decodeUnknownSync(SessionMessage.User)({ id: "msg_preview_user", type: "user", text: "Actual Core user preview", time: { created: 2 } })
  const f = fixture([system, user])
  f.setSnapshot({ session: { ...root, projectID: Schema.decodeUnknownSync(Session.Info.fields.projectID)("synthetic-project"),
    model: Schema.decodeUnknownSync(Session.Info.fields.model)({ id: "stored-model", providerID: "stored-provider" }),
    time: { ...root.time, created: DateTime.makeUnsafe(1_600_000_000_789) }, fork: { sessionID: Session.ID.make("ses_origin") } } })
  f.replace([])
  await f.initialize()
  const thread = {
    id: root.id, sessionId: root.id, forkedFromId: "ses_origin", parentThreadId: null,
    preview: "", ephemeral: false, section: null, sectionEnteredAt: null, projectId: "synthetic-project",
    historyMode: "legacy", modelProvider: "unknown", model: "unknown", reasoningEffort: null,
    createdAt: 1_600_000_000, updatedAt: 1_700_000_000, recencyAt: null, status: { type: "idle" }, path: null,
    cwd: "/recorded", cliVersion: "unknown", originator: null, source: "unknown", threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: "Native", turns: [],
  }
  expect((await f.rpc("thread/list")).result).toEqual({ data: [thread], nextCursor: null, backwardsCursor: null })
  expect((await f.rpc("thread/read", { threadId: root.id, includeTurns: false })).result).toEqual({ thread })
  const wrapper = { thread, model: "unknown", modelProvider: "unknown", serviceTier: null, cwd: "/recorded", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, reasoningEffort: null }
  expect((await f.rpc("thread/start", { cwd: "/recorded" })).result).toEqual(wrapper)
  expect((await f.rpc("thread/resume", { threadId: root.id, excludeTurns: true })).result).toEqual({ ...wrapper, turnsBackwardsCursor: null, itemsBackwardsCursor: null })
  const beforeRead = f.calls.length
  const loaded = (await f.rpc("thread/read", { threadId: root.id, includeTurns: true })).result.thread
  expect(f.calls.slice(beforeRead).filter((call) => call === "read")).toEqual(["read"])
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(f.sent.filter((message) => message.method === "thread/status/changed")).toEqual([])
  expect(loaded.preview).toBe("Actual Core user preview")
  expect("title" in loaded).toBe(false)
  expect(f.calls.filter((call) => call === "read")).toHaveLength(1)
  f.server.retire()
})

test.each([
  { active: false, waiting: [], status: { type: "idle" } },
  { active: true, waiting: [], status: { type: "active", activeFlags: [] } },
  { active: true, waiting: ["approval"], status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  { active: false, waiting: ["user-input"], status: { type: "active", activeFlags: ["waitingOnUserInput"] } },
  { active: true, waiting: ["approval", "user-input"], status: { type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] } },
] satisfies Array<{ active: boolean; waiting: Array<"approval" | "user-input">; status: unknown }>)("native Thread derives live status from %j", async ({ active, waiting, status }) => {
  const f = fixture()
  f.setSnapshot({ active, waiting, selectedModel: Schema.decodeUnknownSync(Session.Info.fields.model)({ id: "synthetic-model", providerID: "non-openai" }) })
  f.replace([])
  await f.initialize()
  const result = (await f.rpc("thread/resume", { threadId: root.id, excludeTurns: true })).result
  expect(result.thread.status).toEqual(status)
  expect(result.thread.model).toBe("synthetic-model")
  expect(result.thread.modelProvider).toBe("non-openai")
  expect(result.model).toBe("synthetic-model")
  expect(result.modelProvider).toBe("non-openai")
  f.server.retire()
})

const nativeOverrides = {
  model: "synthetic-model", modelProvider: "non-openai", approvalPolicy: "on-request", approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" }, sandboxPolicy: { type: "dangerFullAccess" }, config: {},
}

test.each(Object.entries(nativeOverrides))("native override %s is rejected before any Channel effect", async (field, value) => {
  const f = fixture()
  f.setSnapshot({ selectedModel: Schema.decodeUnknownSync(Session.Info.fields.model)({ id: "synthetic-model", providerID: "non-openai" }) })
  await f.initialize()
  for (const method of ["thread/start", "thread/resume", "thread/read", "thread/list", "thread/name/set", "thread/archive", "thread/unarchive", "thread/delete", "turn/start", "turn/steer", "turn/interrupt"]) {
    const reply = await f.rpc(method, { threadId: root.id, name: "Renamed", cwd: "/recorded", input: [{ type: "text", text: "task" }], [field]: value })
    expect(reply.error?.code).toBe(-32602)
    expect(f.calls).toEqual([])
    expect(f.sent).toEqual([])
  }
  f.server.retire()
})

test("native null overrides preserve YCoding model selection and successful start and resume", async () => {
  const f = fixture()
  f.replace([])
  f.setSnapshot({ selectedModel: Schema.decodeUnknownSync(Session.Info.fields.model)({ id: "chosen-model", providerID: "non-openai" }) })
  await f.initialize()
  const overrides = Object.fromEntries(Object.keys(nativeOverrides).map((field) => [field, null]))
  for (const method of ["thread/start", "thread/resume", "turn/start", "turn/steer"]) {
    const reply = await f.rpc(method, { threadId: root.id, cwd: method === "thread/resume" ? null : "/recorded", excludeTurns: true, input: [{ type: "text", text: "task" }], ...overrides })
    expect(reply.error).toBeUndefined()
    if (method.startsWith("thread/")) {
      expect(reply.result.model).toBe("chosen-model")
      expect(reply.result.modelProvider).toBe("non-openai")
    }
  }
  expect(f.created).toHaveLength(1)
  expect(f.prompted).toHaveLength(2)
  f.server.retire()
})

test.each(["thread/resume", "turn/start", "turn/steer", "turn/interrupt"])("native %s rejects a changed cwd before watch or mutation", async (method) => {
  const f = fixture()
  await f.initialize()
  expect((await f.rpc(method, { threadId: root.id, cwd: "/changed", excludeTurns: true, input: [{ type: "text", text: "task" }] })).error?.code).toBe(-32602)
  expect(f.calls.filter((call) => ["subscribe", "pending", "create", "prompt", "interrupt"].includes(call))).toEqual([])
  expect(f.sent).toEqual([])
  f.server.retire()
})

test("native history projects structured text input and explicit nullable summary fields", async () => {
  const user = Schema.decodeUnknownSync(SessionMessage.User)({ id: "msg_history_user", text: "Synthetic task", type: "user", time: { created: 1_000 } })
  const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({ id: "msg_history_assistant", type: "assistant", agent: "build", model: { id: "synthetic", providerID: "synthetic" }, content: [{ type: "text", text: "Synthetic answer" }], finish: "stop", time: { created: 2_000, completed: 3_000 } })
  const f = fixture([user, assistant])
  await f.initialize()
  expect((await f.rpc("thread/read", { threadId: root.id, includeTurns: true })).result.thread.turns).toEqual([{
    id: user.id, itemsView: "summary", status: "completed", error: null,
    startedAt: null, completedAt: null, durationMs: null,
    items: [
      { type: "userMessage", id: user.id, clientId: null, content: [{ type: "text", text: "Synthetic task", text_elements: [] }] },
      { type: "agentMessage", id: assistant.id, text: "Synthetic answer", phase: null, memoryCitation: null, delivery: null, questions: null },
    ],
  }])
  f.server.retire()
})

test("native thread timestamps use whole Unix seconds for list, read and creation", async () => {
  const f = fixture()
  await f.initialize()
  expect((await f.rpc("thread/list")).result.data[0].updatedAt).toBe(1_700_000_000)
  expect((await f.rpc("thread/read", { threadId: root.id })).result.thread.updatedAt).toBe(1_700_000_000)
  expect((await f.rpc("thread/start", { cwd: "/recorded" })).result.thread.updatedAt).toBe(1_700_000_000)
  f.server.retire()
})

test.each([false, true])("stored transcript summary completion is independent of active=%j and failed message telemetry", async (active) => {
  const user = Schema.decodeUnknownSync(SessionMessage.User)({ id: "msg_summary_user", text: "Stored user text", type: "user", time: { created: 1_000 } })
  const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({ id: "msg_summary_failed", type: "assistant", agent: "build", model: { id: "synthetic", providerID: "synthetic" }, content: [{ type: "text", text: "Stored partial answer" }], error: { type: "synthetic-failure", message: "Stored failure" }, time: { created: 2_000, completed: 3_000 } })
  const f = fixture([user, assistant])
  f.setSnapshot({ active })
  f.replace([])
  await f.initialize()
  const thread = (await f.rpc("thread/read", { threadId: root.id, includeTurns: true })).result.thread
  expect(thread.status).toEqual(active ? { type: "active", activeFlags: [] } : { type: "idle" })
  expect(thread.turns).toEqual([{
    id: user.id, itemsView: "summary", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null,
    items: [
      { type: "userMessage", id: user.id, clientId: null, content: [{ type: "text", text: "Stored user text", text_elements: [] }] },
      { type: "agentMessage", id: assistant.id, text: "Stored partial answer", phase: null, memoryCitation: null, delivery: null, questions: null },
    ],
  }])
  f.server.retire()
})

test("transcript summary omits internal records without changing authored roles, preview or grouping", async () => {
  const system = Schema.decodeUnknownSync(SessionMessage.System)({ id: "msg_summary_system", type: "system", text: "Internal system text", time: { created: 0 } })
  const user = Schema.decodeUnknownSync(SessionMessage.User)({ id: "msg_summary_authored", type: "user", text: "Actual\nuser text", time: { created: 1 } })
  const synthetic = Schema.decodeUnknownSync(SessionMessage.Synthetic)({ id: "msg_summary_synthetic", type: "synthetic", text: "Internal steering text", time: { created: 2 } })
  const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({ id: "msg_summary_answer", type: "assistant", agent: "build", model: { id: "synthetic", providerID: "synthetic" }, content: [{ type: "text", text: "Full " }, { type: "text", text: "assistant\nanswer" }], time: { created: 3 } })
  const compaction = Schema.decodeUnknownSync(SessionMessage.CompactionCompletedV1)({ id: "msg_summary_compaction", type: "compaction", reason: "auto", status: "completed", summary: "Internal compaction text", recent: "Internal recent text", time: { created: 4 } })
  const f = fixture([system, user, synthetic, assistant, compaction])
  f.replace([])
  await f.initialize()
  const thread = (await f.rpc("thread/read", { threadId: root.id, includeTurns: true })).result.thread
  expect(thread.preview).toBe("Actual\nuser text")
  expect(thread.turns).toHaveLength(1)
  expect(thread.turns[0].items).toEqual([
    { type: "userMessage", id: user.id, clientId: null, content: [{ type: "text", text: "Actual\nuser text", text_elements: [] }] },
    { type: "agentMessage", id: assistant.id, text: "Full assistant\nanswer", phase: null, memoryCitation: null, delivery: null, questions: null },
  ])
  f.server.retire()
})

test("private Channel owns root access, creation and stable prompt input IDs", async () => {
  const f = fixture()
  await f.initialize()
  expect((await f.rpc("thread/list")).result.data.map((item: { id: string }) => item.id)).toEqual([root.id])
  expect((await f.rpc("thread/read", { threadId: "ses_off" })).error).toBeDefined()
  await f.rpc("thread/start", { cwd: "/recorded" }, 4)
  await f.rpc("turn/start", { threadId: root.id, input: [{ type: "text", text: "task" }] }, 5)
  await f.rpc("turn/start", { threadId: root.id, input: [{ type: "text", text: "task" }] }, 5)
  expect(f.created).toEqual([{ directory: "/recorded", inputID: JSON.stringify(["client:stream", "thread/start", 4]) }])
  expect(f.prompted).toEqual([0, 1].map(() => ({ rootID: root.id, inputID: JSON.stringify(["client:stream", "turn/start", 5]), text: "task", delivery: "steer" })))
  f.server.retire()
})

test("native server request settles the exact candidate once and publishes resolution", async () => {
  const f = fixture()
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  const request = f.sent.find((message) => message.method === "item/tool/requestUserInput")!
  expect(request).toEqual({ jsonrpc: "2.0", id: "request", method: "item/tool/requestUserInput", params: {
    threadId: root.id, turnId: "turn", itemId: "item", isBlocking: true, questions: f.requests()[0]!.questions,
  } })
  const handle = f.requests()[0]!.handle
  const response = JSON.stringify({ id: request.id, result: { answers: { choice: { answers: ["Allow once"] } } } })
  expect(await f.server.handle(response)).toBeUndefined()
  expect(f.settled).toEqual([{ handle, answers: { choice: { answers: ["Allow once"] } } }])
  expect(f.sent).toContainEqual({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: root.id, requestId: request.id } })
  expect(JSON.parse((await f.server.handle(response))!).error).toBeDefined()
  expect(f.settled).toHaveLength(1)
  f.server.retire()
})

test.each(["unknown-id", "unknown-answer", "multiple", "label", "stale", "retired", "cross-channel"])("native response rejects %s without settlement", async (kind) => {
  const f = fixture()
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  const other = fixture()
  await other.initialize()
  const response = { id: kind === "unknown-id" ? "other" : "request", result: { answers: { [kind === "unknown-answer" ? "other" : "choice"]: { answers: kind === "multiple" ? ["Allow once", "Reject"] : [kind === "label" ? "other" : "Allow once"] } } } }
  if (kind === "stale") f.replace([candidate("request")])
  if (kind === "retired") f.server.retire()
  const target = kind === "cross-channel" ? other : f
  expect(JSON.parse((await target.server.handle(JSON.stringify(response)))!).error).toBeDefined()
  expect(f.settled).toEqual([])
  expect(other.settled).toEqual([])
  f.server.retire()
  other.server.retire()
})

test("staged native questions remain exact and subscriptions retire with the appserver", async () => {
  const f = fixture()
  await f.initialize()
  const first = candidate("first")
  f.replace([first])
  await f.rpc("thread/read", { threadId: root.id })
  await f.server.handle(JSON.stringify({ id: "first", result: { answers: { choice: { answers: ["Reject"] } } } }))
  f.replace([candidate("next-stage")])
  await f.rpc("thread/read", { threadId: root.id })
  expect(f.sent.filter((item) => item.method === "item/tool/requestUserInput").map((item) => item.id)).toEqual(["first", "next-stage"])
  f.server.retire()
  expect(f.stops()).toBe(1)
})

test("native outbound envelope carries a JSON-RPC object, not a JSON string", () => {
  const message = { id: "decision", method: "item/tool/requestUserInput", params: { threadId: "root", questions: [] } }
  const [wire] = encodeOutbound({ text: JSON.stringify(message), clientID: "client", streamID: "stream", envID: "env", seqID: 1 })
  expect(JSON.parse(wire!).message).toEqual(message)
})

test.each(["ended", "terminal", "retired"])("native item lifecycle uses occurrence timestamps for %s", async (mode) => {
  const f = fixture()
  f.replace([])
  await f.initialize()
  await f.rpc("turn/start", { threadId: root.id, input: [{ type: "text", text: "task" }] })
  if (mode === "retired") await f.rpc("turn/steer", { threadId: root.id, input: [{ type: "text", text: "follow-up" }] }, 2)
  const ids = mode === "retired" ? ["message", "message_1"] : ["message"]
  f.emit("session.execution.started")
  f.emit("session.input.consumed", { inputIDs: ids })
  f.emit("session.text.started", { assistantMessageID: "assistant", ordinal: 0, phase: "final_answer" }, 1_700_000_000_123)
  f.emit("session.text.delta", { assistantMessageID: "assistant", ordinal: 0, delta: "Synthetic output" }, 1_700_000_000_234)
  expect(f.sent.filter((message) => message.method === "item/started").map((message) => message.params)).toEqual(ids.map((id) => ({
    threadId: root.id, turnId: id, item: { id: "assistant:0", type: "agentMessage", text: "", phase: "final_answer" }, startedAtMs: 1_700_000_000_123,
  })))
  const before = Date.now()
  if (mode === "retired") f.revoke()
  else {
    if (mode === "ended") f.emit("session.text.ended", { assistantMessageID: "assistant", ordinal: 0, text: "Synthetic output", phase: "final_answer" }, 1_700_000_000_345)
    f.emit("session.execution.succeeded", {}, 1_700_000_000_456)
  }
  const after = Date.now()
  const completed = f.sent.filter((message) => message.method === "item/completed").map((message) => message.params as { completedAtMs: number })
  expect(completed).toHaveLength(ids.length)
  const completedAtMs = completed[0]!.completedAtMs
  if (mode === "retired") {
    expect(Number.isSafeInteger(completedAtMs)).toBe(true)
    expect(completedAtMs).toBeGreaterThanOrEqual(before)
    expect(completedAtMs).toBeLessThanOrEqual(after)
  } else expect(completedAtMs).toBe(mode === "ended" ? 1_700_000_000_345 : 1_700_000_000_456)
  expect(completed).toEqual(ids.map((id) => ({
    threadId: root.id, turnId: id, item: { id: "assistant:0", type: "agentMessage", text: "Synthetic output", phase: "final_answer" }, completedAtMs,
  })))
  expect(f.sent.filter((message) => message.method === "turn/completed").map((message) => message.params)).toEqual(ids.map((id) => ({
    threadId: root.id, turn: { id, status: mode === "retired" ? "interrupted" : "completed", error: null, items: [{ id: "assistant:0", type: "agentMessage", text: "Synthetic output", phase: "final_answer" }] },
  })))
  const size = f.sent.length
  f.emit("session.text.delta", { assistantMessageID: "assistant", ordinal: 0, delta: "late" })
  f.emit("session.execution.succeeded")
  expect(f.sent).toHaveLength(size)
  f.server.retire()
})

test.each(["succeeded", "failed", "interrupted"])("canonical execution %s completes only its consumed native turn", async (terminal) => {
  const f = fixture()
  f.replace([])
  await f.initialize()
  await f.rpc("turn/start", { threadId: root.id, input: [{ type: "text", text: "task" }] })
  f.emit("session.execution.started")
  f.emit("session.input.consumed", { inputIDs: ["message"] })
  f.emit("session.text.started", { assistantMessageID: "assistant", ordinal: 0, phase: "commentary" })
  f.emit("session.text.delta", { assistantMessageID: "assistant", ordinal: 0, delta: "progress" })
  f.emit("session.text.ended", { assistantMessageID: "assistant", ordinal: 0, text: "progress", phase: "commentary" })
  f.emit(`session.execution.${terminal}`, { ...(terminal === "failed" ? { error: { message: "Synthetic failure" } } : terminal === "interrupted" ? { reason: "user" } : {}) })
  expect(f.sent.map((item) => item.method)).toEqual(["turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed"])
  const final = (f.sent.at(-1)!.params as { turn: { status: string; items: unknown[]; error: unknown } }).turn
  expect(final.status).toBe(terminal === "succeeded" ? "completed" : terminal)
  expect(final.items).toEqual([{ id: "assistant:0", type: "agentMessage", text: "progress", phase: "commentary" }])
  expect(final.error).toEqual(terminal === "failed" ? { message: "Synthetic failure" } : null)
  const size = f.sent.length
  f.emit("session.execution.started")
  f.emit("session.input.consumed", { inputIDs: ["unrelated"] })
  f.emit("session.text.started", { assistantMessageID: "other", ordinal: 0 })
  f.emit("session.execution.succeeded")
  expect(f.sent).toHaveLength(size)
  f.server.retire()
})

test("zero-output completion includes items and another Session cannot feed a native turn", async () => {
  const f = fixture()
  f.replace([])
  await f.initialize()
  await f.rpc("turn/start", { threadId: root.id, input: [{ type: "text", text: "task" }] })
  f.emit("session.execution.started")
  f.emit("session.input.consumed", { inputIDs: ["message"] })
  f.emit("session.text.delta", { assistantMessageID: "unknown", ordinal: 1, delta: "no start" })
  f.emit("session.text.started", { sessionID: "ses_other", assistantMessageID: "foreign", ordinal: 0 })
  f.emit("session.status", { status: { type: "idle" } })
  expect(f.sent).toHaveLength(1)
  f.emit("session.execution.succeeded")
  expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: root.id, turn: { id: "message", status: "completed", error: null, items: [] } } })
  f.server.retire()
})

test("Core retirement resolves displayed input without settling and discards turn state", async () => {
  const f = fixture()
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  f.revoke()
  expect(f.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: root.id, requestId: "request" } })
  expect(JSON.parse((await f.server.handle(JSON.stringify({ id: "request", result: { answers: { choice: { answers: ["Reject"] } } } })))!).error).toBeDefined()
  expect(f.settled).toEqual([])
  f.server.retire()
})

test("native projections preserve multiple questions and free text without decoding domain answers", async () => {
  const f = fixture()
  const request = candidate("typed")
  const questions = [request.questions[0]!, { id: "text", header: "Details", question: "Describe", isOther: true, isSecret: true, options: null }]
  f.replace([{ ...request, questions }])
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  expect((f.sent[0]!.params as { questions: unknown }).questions).toEqual(questions.map((question) => ({ ...question, options: question.options ?? [] })))
  const answers = { choice: { answers: ["Reject"] }, text: { answers: ['{"text":"explicit value"}'] } }
  expect(await f.server.handle(JSON.stringify({ id: "typed", result: { answers } }))).toBeUndefined()
  expect(f.settled).toEqual([{ handle: request.handle, answers }])
  f.server.retire()
})

test("disconnect during private settlement reports uncertainty and never reports success", async () => {
  const f = fixture()
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  const gate = f.holdSettlement()
  const response = f.server.handle(JSON.stringify({ id: "request", result: { answers: { choice: { answers: ["Reject"] } } } }))
  await gate.entered.promise
  const count = f.sent.length
  f.server.retire()
  gate.released.resolve()
  expect(JSON.parse((await response)!).error).toBeDefined()
  expect(f.sent).toHaveLength(count)
  expect(f.settled).toEqual([])
})

test.each([false, true])("concurrent reads await subscription ownership and late stop is exact once: %s", async (retire) => {
  const f = fixture()
  await f.initialize()
  const gate = f.holdSubscription()
  const first = f.rpc("thread/read", { threadId: root.id })
  await gate.entered.promise
  const second = f.rpc("thread/read", { threadId: root.id }, 2)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(f.sent).toEqual([])
  if (retire) f.server.retire()
  gate.released.resolve()
  const replies = await Promise.all([first, second])
  if (retire) expect(replies.every((reply) => reply.error !== undefined)).toBe(true)
  else expect(f.sent.filter((message) => message.method === "item/tool/requestUserInput")).toHaveLength(1)
  f.server.retire()
  expect(f.stops()).toBe(1)
})

test("thread/start publishes thread/started with the response Thread shape", async () => {
  const f = fixture()
  f.replace([])
  await f.initialize()
  const reply = await f.rpc("thread/start", { cwd: "/recorded" })
  expect(f.sent.filter((message) => message.method === "thread/started")).toEqual([{ jsonrpc: "2.0", method: "thread/started", params: { thread: reply.result.thread } }])
  f.server.retire()
})

test("thread/name/set renames a verified root and publishes the new name", async () => {
  const f = fixture()
  f.replace([])
  await f.initialize()
  expect(await f.rpc("thread/name/set", { threadId: root.id, name: "  Renamed " })).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  expect(f.calls).toEqual(["get", "rename"])
  expect(f.mutations).toEqual([["rename", { rootID: root.id, title: "  Renamed " }]])
  expect(f.sent).toEqual([{ jsonrpc: "2.0", method: "thread/name/updated", params: { threadId: root.id, threadName: "  Renamed " } }])
  f.server.retire()
})

test.each([
  ["missing threadId", { name: "Renamed" }],
  ["non-string name", { threadId: root.id, name: 7 }],
  ["blank name", { threadId: root.id, name: "   " }],
  ["unavailable root", { threadId: "ses_off", name: "Renamed" }],
])("thread/name/set rejects %s without mutation", async (_case, params) => {
  const f = fixture()
  await f.initialize()
  const reply = await f.rpc("thread/name/set", params)
  expect(reply.error?.code).toBe(-32602)
  expect(f.mutations).toEqual([])
  expect(f.sent).toEqual([])
  f.server.retire()
})

test("thread/archive archives a verified root, retires its displayed requests and publishes archival", async () => {
  const f = fixture()
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  const before = f.sent.length
  expect(await f.rpc("thread/archive", { threadId: root.id }, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: {} })
  expect(f.mutations).toEqual([["archive", root.id]])
  expect(f.sent.slice(before)).toEqual([
    { jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: root.id, requestId: "request" } },
    { jsonrpc: "2.0", method: "thread/archived", params: { threadId: root.id } },
  ])
  expect(JSON.parse((await f.server.handle(JSON.stringify({ id: "request", result: { answers: { choice: { answers: ["Reject"] } } } })))!).error).toBeDefined()
  expect(f.settled).toEqual([])
  f.server.retire()
})

test("thread/unarchive returns the restored Thread, publishes unarchival and allows later access", async () => {
  const f = fixture()
  f.replace([])
  await f.initialize()
  const listed = (await f.rpc("thread/list")).result.data[0]
  await f.rpc("thread/archive", { threadId: root.id }, 2)
  const before = f.sent.length
  expect(await f.rpc("thread/unarchive", { threadId: root.id }, 3)).toEqual({ jsonrpc: "2.0", id: 3, result: { thread: listed } })
  expect(f.mutations).toEqual([["archive", root.id], ["unarchive", root.id]])
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(f.sent.slice(before)).toEqual([{ jsonrpc: "2.0", method: "thread/unarchived", params: { threadId: root.id } }])
  expect((await f.rpc("thread/read", { threadId: root.id }, 4)).result.thread.id).toBe(root.id)
  f.server.retire()
})

test("thread/unarchive surfaces a decision still pending from before archival without a thread read", async () => {
  const f = fixture()
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  await f.rpc("thread/archive", { threadId: root.id }, 2)
  await f.rpc("thread/unarchive", { threadId: root.id }, 3)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(f.sent.filter((message) => message.method === "thread/status/changed")).toEqual([])
  const requests = f.sent.filter((message) => message.method === "item/tool/requestUserInput")
  expect(requests.map((message) => message.id)).toEqual(["request", "request"])
  expect(requests[1]).toEqual(requests[0])
  const handle = f.requests()[0]!.handle
  const response = JSON.stringify({ id: "request", result: { answers: { choice: { answers: ["Reject"] } } } })
  expect(await f.server.handle(response)).toBeUndefined()
  expect(f.settled).toEqual([{ handle, answers: { choice: { answers: ["Reject"] } } }])
  expect(JSON.parse((await f.server.handle(response))!).error).toBeDefined()
  expect(f.settled).toHaveLength(1)
  expect(f.sent.filter((message) => message.method === "item/tool/requestUserInput")).toHaveLength(2)
  f.server.retire()
})

test("thread/delete removes the root, retires its displayed requests and publishes deletion", async () => {
  const f = fixture()
  await f.initialize()
  await f.rpc("thread/read", { threadId: root.id })
  const before = f.sent.length
  expect(await f.rpc("thread/delete", { threadId: root.id }, 2)).toEqual({ jsonrpc: "2.0", id: 2, result: {} })
  expect(f.mutations).toEqual([["remove", root.id]])
  expect(f.sent.slice(before)).toEqual([
    { jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: root.id, requestId: "request" } },
    { jsonrpc: "2.0", method: "thread/deleted", params: { threadId: root.id } },
  ])
  f.server.retire()
})

test.each([
  ["thread/archive", { threadId: "ses_off" }, []],
  ["thread/archive", {}, []],
  ["thread/unarchive", { threadId: "ses_off" }, [["unarchive", "ses_off"]]],
  ["thread/unarchive", { threadId: 7 }, []],
  ["thread/delete", { threadId: "ses_off" }, [["remove", "ses_off"]]],
  ["thread/delete", {}, []],
])("%s rejects %j as an unavailable Thread without publishing", async (method, params, mutations) => {
  const f = fixture()
  await f.initialize()
  const reply = await f.rpc(method, params)
  expect(reply.error?.code).toBe(-32602)
  expect(f.mutations).toEqual(mutations)
  expect(f.sent).toEqual([])
  f.server.retire()
})
