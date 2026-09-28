import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore, readSessionInfo } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayHandlerOutcome, type RelayHandlerResult } from "./relay-double"
import type { RemoteRequest } from "@ycoding-ai/remote"

const task = (sessionID: string, parentID = "ses_a", state = "running") => ({
  sessionID, parentID, description: `Task ${sessionID}`, agent: "builder",
  model: { providerID: "openai", id: "gpt-5" }, background: true, state,
  revision: 1, time: { created: 1, updated: 2 },
})

async function setup(handler: (operation: string, sessionID?: string, cursor?: unknown) => RelayHandlerResult,
  snapshot?: (sessionID: string) => unknown, other?: (request: RemoteRequest) => RelayHandlerResult) {
  const relay = await startRelayDouble({ handler: (request) => request.operation === "session.subagent.list"
    ? handler(request.operation, request.sessionID, request.input?.cursor) : other?.(request) ?? "default", snapshot })
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }),
    batchMs: 1,
  })
  await store.load()
  await waitFor(() => store.state().sessions.length > 0, 5_000)
  return { store, relay, stop: async () => { store.dispose(); await relay.stop() } }
}

describe("remote team facts", () => {
  test("Team controls read bounded family economics, cancel and answer tasks, kill shells, and create BTW", async () => {
    const test = await setup(() => ({ ok: true, value: { data: [{ ...task("ses_child"), state: "waiting", question: { id: "qst_1", text: "Which scope?", time: 2 } }], summary: { total: 1, active: 1 }, cursor: {} } }), undefined,
      (request) => {
        if (request.operation === "session.team.economics") return { ok: true, value: { data: [{ sessionID: "ses_child", cost: 0.25,
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 0 } }, cacheHitRatio: 0.75, contextTotal: 800, contextLimit: 2_000, cacheRead: 3, cacheWrite: 0 }] } }
        if (request.operation === "session.team.shell.list") return { ok: true, value: { data: [{ id: "sh_child", ownerID: "ses_child", command: "bun test", status: "running", startedAt: 1 }] } }
        if (request.operation === "session.side-chat.list") return { ok: true, value: { data: [{ id: "ses_btw", title: "Side question", updatedAt: 3 }], cursor: {} } }
        if (request.operation === "session.subagent.answer") return { ok: true, value: { data: { ...task("ses_child"), state: "running", revision: 2 } } }
        if (request.operation === "session.subagent.cancel") return { ok: true, value: { data: { ...task("ses_child"), state: "cancelling", revision: 3 } } }
        if (request.operation === "session.team.shell.kill") return { ok: true, value: null }
        if (request.operation === "session.side-chat.create") return { ok: true, value: { data: { id: request.input?.id, parentID: "ses_a", agent: "btw", title: "New side chat", time: { updated: 4 } } } }
        return "default"
      })
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      await test.store.loadTeamControls()
      await waitFor(() => test.store.state().team?.tasks[0]?.cacheHitRatio === 0.75)
      expect(test.store.state().team?.tasks[0]).toMatchObject({ question: { id: "qst_1" }, tokens: 20, cost: 0.25, contextTotal: 800, cacheRead: 3 })
      expect(test.store.state().team).toMatchObject({ shellStatus: "ready", sideChatStatus: "ready", shells: [{ id: "sh_child", ownerID: "ses_child" }], sideChats: [{ id: "ses_btw" }] })
      expect(await test.store.answerSubagent("ses_child", "qst_1", "staging")).toMatchObject({ status: "ok" })
      expect(test.store.state().team?.tasks[0]?.state).toBe("running")
      expect(await test.store.cancelSubagent("ses_child")).toMatchObject({ status: "ok" })
      expect(test.store.state().team?.tasks[0]?.state).toBe("cancelling")
      expect(await test.store.killTeamShell("sh_child")).toMatchObject({ status: "ok" })
      expect(test.store.state().team?.shells[0]?.status).toBe("killed")
      expect(await test.store.createSideChat()).toMatchObject({ status: "ok" })
      expect(test.relay.requests.filter((request) => request.operation === "session.side-chat.create")).toHaveLength(1)
      expect(test.relay.requests.filter((request) => request.operation === "session.family.activity")).toEqual([])
    } finally { await test.stop() }
  })

  test("watching task facts in Conversation never starts Office activity polling", async () => {
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }))
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      await Bun.sleep(100)
      expect(test.relay.requests.filter((request) => request.operation === "session.family.activity")).toEqual([])
    } finally { await test.stop() }
  })

  test("one Office activity read reports each member and stops after leaving Office", async () => {
    let reads = 0
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }), undefined,
      (request) => request.operation === "session.family.activity" ? { ok: true, value: { data: [
        { sessionID: "ses_a", executing: false },
        { sessionID: "ses_child", executing: true, activity: ++reads === 1 ? { kind: "tool", room: "qa", text: "Running bun test" }
          : { kind: "tool", room: "research", text: "Reading store.ts" } },
      ] } } : "default")
    try {
      test.store.watchTeam(true)
      test.store.watchFamilyActivity(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().familyActivity?.status === "ready")
      expect(test.store.state().familyActivity?.members).toMatchObject([{ sessionID: "ses_a", executing: false }, { sessionID: "ses_child", executing: true }])
      expect(test.relay.requests.filter((request) => request.operation === "session.family.activity")).toMatchObject([{ sessionID: "ses_a", input: { sessionIDs: ["ses_child"] } }])
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.family.activity").length === 2, 4_000)
      await waitFor(() => test.store.state().familyActivity?.members[1]?.activity?.text === "Reading store.ts")
      test.store.watchFamilyActivity(false)
      await Bun.sleep(3_150)
      expect(test.relay.requests.filter((request) => request.operation === "session.family.activity")).toHaveLength(2)
    } finally { await test.stop() }
  }, 12_000)

  test("an older connector marks family activity unsupported instead of inventing child work", async () => {
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }), undefined,
      (request) => request.operation === "session.family.activity" ? { ok: false, code: "unknown_operation", message: "Update YCoding" } : "default")
    try {
      test.store.watchTeam(true)
      test.store.watchFamilyActivity(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().familyActivity?.status === "unsupported")
      expect(test.store.state().familyActivity?.members).toEqual([])
      expect(test.store.state().team?.tasks).toMatchObject([{ sessionID: "ses_child" }])
    } finally { await test.stop() }
  })
  test("a transient family activity error stays retryable rather than asking for an update", async () => {
    let reads = 0
    const test = await setup(() => ({ ok: true, value: { data: [], summary: { total: 0 }, cursor: {} } }), undefined,
      (request) => request.operation !== "session.family.activity" ? "default" : ++reads === 1
        ? { ok: false, code: "internal_error", message: "Temporary backend failure" }
        : { ok: true, value: { data: [{ sessionID: "ses_a", executing: false }] } })
    try {
      test.store.watchTeam(true)
      test.store.watchFamilyActivity(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().familyActivity?.status === "error")
      await waitFor(() => test.store.state().familyActivity?.status === "ready", 4_000)
      expect(reads).toBe(2)
    } finally { await test.stop() }
  }, 8_000)

  test("disconnect cancels the Office activity refresh", async () => {
    const test = await setup(() => ({ ok: true, value: { data: [], summary: { total: 0 }, cursor: {} } }), undefined,
      (request) => request.operation === "session.family.activity" ? { ok: true, value: { data: [{ sessionID: "ses_a", executing: false }] } } : "default")
    try {
      test.store.watchTeam(true)
      test.store.watchFamilyActivity(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().familyActivity?.status === "ready")
      const before = test.relay.requests.filter((request) => request.operation === "session.family.activity").length
      test.store.disconnect()
      await Bun.sleep(3_150)
      expect(test.relay.requests.filter((request) => request.operation === "session.family.activity")).toHaveLength(before)
    } finally { await test.stop() }
  }, 6_000)

  test("the one family read includes a selected child from a later task page", async () => {
    const test = await setup((_operation, _id, cursor) => ({ ok: true, value: {
      data: Array.from({ length: 10 }, (_, index) => task(`ses_${String(index + (cursor ? 10 : 0)).padStart(2, "0")}`)),
      summary: { total: 20 }, cursor: cursor ? {} : { next: "more" },
    } }), (id) => ({ session: { id, parentID: id === "ses_a" ? undefined : "ses_a", title: id, time: { created: 1, updated: 2 } },
      messages: [], watermark: { seq: 0 }, sourceEpoch: "epoch_1" }), (request) => request.operation === "session.family.activity"
      ? { ok: true, value: { data: [{ sessionID: "ses_a", executing: false },
        ...(Array.isArray(request.input?.sessionIDs) ? request.input.sessionIDs.map((id) => ({ sessionID: id, executing: false })) : [])] } } : "default")
    try {
      test.store.watchTeam(true)
      test.store.watchFamilyActivity(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      await test.store.loadMoreTeam()
      await waitFor(() => test.store.state().team?.tasks.length === 20)
      await test.store.selectSession("ses_19")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.family.activity" &&
        Array.isArray(request.input?.sessionIDs) && request.input.sessionIDs.includes("ses_19")), 5_000)
      const ids = test.relay.requests.findLast((request) => request.operation === "session.family.activity")?.input?.sessionIDs
      expect(ids).toContain("ses_19")
      expect(Array.isArray(ids) ? ids.length : Infinity).toBeLessThanOrEqual(15)
    } finally { await test.stop() }
  }, 20_000)

  test("selecting a child in the same root retains its ready team and family activity", async () => {
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }), (id) => ({
      session: { id, parentID: id === "ses_child" ? "ses_a" : undefined, title: id, time: { created: 1, updated: 2 } }, messages: [], watermark: { seq: 0 }, sourceEpoch: "epoch_1",
    }), (request) => request.operation === "session.family.activity" ? { ok: true, value: { data: [
      { sessionID: "ses_a", executing: false }, { sessionID: "ses_child", executing: true, activity: { kind: "tool", room: "developer", text: "Editing app.ts" } },
    ] } } : "default")
    try {
      test.store.watchTeam(true)
      test.store.watchFamilyActivity(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready" && test.store.state().familyActivity?.status === "ready")
      const rows = test.store.state().team?.tasks
      const family = test.store.state().familyActivity?.members
      const selecting = test.store.selectSession("ses_child")
      expect(test.store.state().team?.tasks).toEqual(rows)
      expect(test.store.state().familyActivity?.members).toEqual(family)
      await selecting
      await waitFor(() => test.store.state().team?.status === "ready")
      expect(test.store.state().team?.tasks).toEqual(rows)
      expect(test.store.state().familyActivity?.members).toEqual(family)
    } finally { await test.stop() }
  })
  test("a history size failure still loads todos, requests, and the selected root team", async () => {
    const todos = [{ content: "Check output", status: "in_progress", priority: "high" }] as const
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }),
      undefined, (request) => {
        if (request.operation === "session.snapshot") return { ok: false, code: "message_too_large", message: "History exceeds the relay response limit" }
        if (request.operation === "session.todo.list") return { ok: true, value: { data: todos } }
        if (request.operation === "session.permission.list") return { ok: true, value: { data: [{ id: "per_1", sessionID: "ses_a", action: "shell", resources: ["test"] }] } }
        return "default"
      })
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready" && test.store.state().todos?.length === 1)
      expect(test.store.state().notice).toContain("History exceeds")
      expect(test.store.state().view?.messages).toEqual([])
      expect(test.store.state().todos).toEqual(todos)
      expect(test.store.state().view?.requests).toMatchObject([{ id: "per_1", kind: "permission" }])
      expect(test.store.state().team?.tasks).toMatchObject([{ sessionID: "ses_child" }])
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list").map((request) => request.sessionID)).toEqual(["ses_a"])
      test.relay.pushEvent("ses_a", { type: "session.step.started", data: { assistantMessageID: "msg_live", agent: "god", model: { providerID: "openai", id: "gpt-6" } } })
      await waitFor(() => test.store.state().view?.messages.some((message) => message.id === "msg_live") === true)
    } finally { await test.stop() }
  })
  test("a pending or failed refresh retains the ready Office roster", async () => {
    const held = Promise.withResolvers<RelayHandlerOutcome>()
    let reads = 0
    const test = await setup(() => ++reads === 1
      ? { ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }
      : held.promise)
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      test.relay.pushEvent("ses_a", { id: "evt_team_refresh", type: "session.tool.progress", durable: { aggregateID: "ses_a", seq: 1, version: 1 },
        data: { sessionID: "ses_a", assistantMessageID: "msg_1", callID: "call_1", structured: { sessionID: "ses_child", status: "running" }, content: [] } })
      await waitFor(() => reads === 2)
      expect(test.store.state().team).toMatchObject({ status: "ready", tasks: [{ sessionID: "ses_child" }] })
      held.resolve({ ok: false, code: "internal_error", message: "Unavailable" })
      await waitFor(() => test.store.state().team?.pageLoading === false)
      expect(test.store.state().team).toMatchObject({ status: "ready", tasks: [{ sessionID: "ses_child" }] })
    } finally { held.resolve("default"); await test.stop() }
  })

  test("a refresh queued behind an in-flight read keeps the ready Office roster", async () => {
    const second = Promise.withResolvers<RelayHandlerOutcome>()
    const third = Promise.withResolvers<RelayHandlerOutcome>()
    const ready: RelayHandlerOutcome = { ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }
    let reads = 0
    const test = await setup(() => {
      reads += 1
      if (reads === 1) return ready
      return reads === 2 ? second.promise : third.promise
    })
    const cue = (seq: number) => test.relay.pushEvent("ses_a", { id: `evt_team_refresh_${seq}`, type: "session.tool.progress", durable: { aggregateID: "ses_a", seq, version: 1 },
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", callID: `call_${seq}`, structured: { sessionID: "ses_child", status: "running" }, content: [] } })
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      cue(1)
      await waitFor(() => reads === 2)
      cue(2)
      await waitFor(() => test.store.state().view?.watermark === 2)
      second.resolve(ready)
      await waitFor(() => reads === 3)
      expect(test.store.state().team).toMatchObject({ status: "ready", tasks: [{ sessionID: "ses_child" }] })
      third.resolve(ready)
      await waitFor(() => test.store.state().team?.pageLoading === false)
      expect(test.store.state().team).toMatchObject({ status: "ready", tasks: [{ sessionID: "ses_child" }] })
    } finally { second.resolve("default"); third.resolve("default"); await test.stop() }
  })

  test("disabling Office during a pending snapshot cannot recreate team state on failure", async () => {
    const held = Promise.withResolvers<RelayHandlerOutcome>()
    const test = await setup(() => "default", undefined,
      (request) => request.operation === "session.snapshot" ? held.promise : "default")
    try {
      test.store.watchTeam(true)
      const selecting = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot"))
      test.store.watchTeam(false)
      held.resolve({ ok: false, code: "internal_error", message: "Snapshot unavailable" })
      await selecting
      expect(test.store.state().team).toBeUndefined()
      expect(test.store.state().teamCues).toEqual([])
    } finally { held.resolve("default"); await test.stop() }
  })

  test("mounting Office on the snapshot notification requests the first page once", async () => {
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }))
    let watching = false
    const unsubscribe = test.store.subscribe(() => {
      if (watching || test.store.state().view?.watermark !== 0) return
      watching = true
      test.store.watchTeam(true)
    })
    try {
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      await Bun.sleep(20)
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list")).toHaveLength(1)
    } finally { unsubscribe(); await test.stop() }
  })

  test("a disabled and re-enabled watcher cannot publish its predecessor's page", async () => {
    const old = Promise.withResolvers<RelayHandlerOutcome>()
    let reads = 0
    const test = await setup(() => ++reads === 1 ? old.promise :
      { ok: true, value: { data: [task("ses_new")], summary: { total: 1 }, cursor: {} } })
    try {
      await test.store.selectSession("ses_a")
      test.store.watchTeam(true)
      await waitFor(() => reads === 1)
      test.store.watchTeam(false)
      test.store.watchTeam(true)
      old.resolve({ ok: true, value: { data: [task("ses_old")], summary: { total: 1 }, cursor: {} } })
      await waitFor(() => test.store.state().team?.status === "ready")
      expect(test.store.state().team?.tasks.map((item) => item.sessionID)).toEqual(["ses_new"])
      expect(reads).toBe(2)
    } finally { old.resolve("default"); await test.stop() }
  })

  test("does not spend a task-page request in Conversation, and fences a disabled watcher", async () => {
    const held = Promise.withResolvers<RelayHandlerOutcome>()
    const test = await setup(() => held.promise)
    try {
      await test.store.selectSession("ses_a")
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list")).toEqual([])
      expect(test.store.state().team).toBeUndefined()
      test.store.watchTeam(true)
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.subagent.list").length === 1)
      test.store.watchTeam(false)
      held.resolve({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } })
      await Bun.sleep(20)
      expect(test.store.state().team).toBeUndefined()
      expect(test.store.state().teamCues).toEqual([])
      await test.store.selectSession("ses_b")
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list")).toHaveLength(1)
      test.relay.pushEvent("ses_b", { id: "evt_after_disable", type: "session.synthetic", durable: { aggregateID: "ses_b", seq: 1, version: 1 },
        data: { sessionID: "ses_b", text: "Report", metadata: { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 1 } } })
      await Bun.sleep(20)
      expect(test.store.state().teamCues).toEqual([])
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list")).toHaveLength(1)
    } finally { held.resolve("default"); await test.stop() }
  })

  test("retains only a recorded parent ID from Session info", () => {
    expect(readSessionInfo({ id: "ses_child", parentID: "ses_parent", title: "Child", time: { updated: 2 } })?.parentID).toBe("ses_parent")
    expect(readSessionInfo({ id: "ses_child", parentID: 42 })?.parentID).toBeUndefined()
  })

  test("does not animate an event observed inside the initial snapshot hydration window", async () => {
    const held = Promise.withResolvers<RelayHandlerOutcome>()
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }),
      undefined, (request) => request.operation === "session.snapshot" ? held.promise : "default")
    try {
      test.store.watchTeam(true)
      const selecting = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot"))
      test.relay.pushEvent("ses_a", { id: "evt_during", type: "session.tool.progress", durable: { aggregateID: "ses_a", seq: 1, version: 1 },
        data: { sessionID: "ses_a", assistantMessageID: "msg_1", callID: "call_1", structured: { sessionID: "ses_child", status: "running" }, content: [] } })
      await Bun.sleep(20)
      expect(test.store.state().teamCues).toEqual([])
      held.resolve({ ok: true, value: { sourceEpoch: "epoch_1", session: { id: "ses_a", title: "Root", time: { created: 1, updated: 1 } },
        messages: [], watermark: { seq: 1 } } })
      await selecting
      await waitFor(() => test.store.state().team?.status === "ready")
      expect(test.store.state().teamCues).toEqual([])
    } finally { held.resolve("default"); await test.stop() }
  })

  test("keeps a late team page out of a new selection and a replaced device", async () => {
    const old = Promise.withResolvers<RelayHandlerOutcome>()
    const test = await setup((_operation, parent) => parent === "ses_a" ? old.promise :
      { ok: true, value: { data: [task("ses_b_child", "ses_b")], summary: { total: 1 }, cursor: {} } })
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.subagent.list" && request.sessionID === "ses_a"))
      await test.store.selectSession("ses_b")
      expect(test.store.state().team).toMatchObject({ rootID: "ses_b", status: "loading", tasks: [] })
      old.resolve({ ok: true, value: { data: [task("ses_old")], summary: { total: 1 }, cursor: {} } })
      await waitFor(() => test.store.state().team?.status === "ready")
      expect(test.store.state().team?.tasks.map((item) => item.sessionID)).toEqual(["ses_b_child"])
      test.store.connect("dev_2")
      expect(test.store.state().team).toBeUndefined()
      expect(test.store.state().teamCues).toEqual([])
    } finally { old.resolve("default"); await test.stop() }
  })

  test("loads one bounded direct-child page, filters foreign rows, and pages only on demand", async () => {
    const test = await setup((_operation, _parent, cursor) => ({ ok: true, value: cursor === undefined
      ? { data: [task("ses_child"), task("ses_foreign", "ses_other")], summary: { total: 2 }, cursor: { next: "more" } }
      : { data: [task("ses_next")], summary: { total: 2 }, cursor: {} } }))
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      expect(test.store.state().team).toMatchObject({ rootID: "ses_a", total: 2, next: "more", tasks: [{ sessionID: "ses_child", parentID: "ses_a", state: "running" }] })
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list")).toHaveLength(1)
      await test.store.loadMoreTeam()
      expect(test.store.state().team?.tasks.map((item) => item.sessionID)).toEqual(["ses_child", "ses_next"])
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list").map((request) => request.input?.cursor)).toEqual([undefined, "more"])
    } finally { await test.stop() }
  })

  test("uses a recorded child parent as the team root and reports old agents as unsupported", async () => {
    const test = await setup(() => ({ ok: false, code: "unknown_operation", message: "Unknown operation" }), (sessionID) => ({
      session: { id: sessionID, parentID: sessionID === "ses_child" ? "ses_a" : undefined, title: sessionID, time: { created: 1, updated: 1 } },
      messages: [], watermark: { seq: 0 }, sourceEpoch: "epoch_1",
    }))
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_child")
      await waitFor(() => test.store.state().team?.status === "unsupported")
      expect(test.store.state().team?.rootID).toBe("ses_a")
      expect(test.relay.requests.filter((request) => request.operation === "session.subagent.list").map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().teamCues).toEqual([])
    } finally { await test.stop() }
  })

  test("records bounded durable live cues only, never from snapshot hydration or reconnect", async () => {
    let watermark = 0
    const test = await setup(() => ({ ok: true, value: { data: [task("ses_child")], summary: { total: 1 }, cursor: {} } }), () => ({
      session: { id: "ses_a", title: "Root", time: { created: 1, updated: 1 } },
      messages: [{ id: "msg_old", type: "synthetic", text: "Old report", metadata: { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 1 }, time: { created: 1 } }],
      watermark: { seq: watermark }, sourceEpoch: "epoch_1",
    }))
    try {
      test.store.watchTeam(true)
      await test.store.selectSession("ses_a")
      await waitFor(() => test.store.state().team?.status === "ready")
      expect(test.store.state().teamCues).toEqual([])
      const delegated = { id: "evt_delegate", type: "session.tool.progress", durable: { aggregateID: "ses_a", seq: 1, version: 1 },
        data: { sessionID: "ses_a", assistantMessageID: "msg_assistant", callID: "call_1", structured: { sessionID: "ses_child", status: "running" }, content: [] } }
      test.relay.pushEvent("ses_a", delegated)
      test.relay.pushEvent("ses_a", { id: "evt_report", type: "session.synthetic", durable: { aggregateID: "ses_a", seq: 2, version: 1 },
        data: { sessionID: "ses_a", text: "Report", metadata: { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 2 } } })
      await waitFor(() => test.store.state().teamCues.length === 2)
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.subagent.list").length >= 2)
      expect(test.store.state().teamCues).toEqual([
        { id: "msg_assistant:call_1:ses_child", kind: "delegated", childID: "ses_child" },
        { id: "evt_report:2:ses_child", kind: "reported", childID: "ses_child", outcome: "completed" },
      ])
      test.relay.pushEvent("ses_a", delegated)
      await Bun.sleep(20)
      expect(test.store.state().teamCues).toHaveLength(2)
      for (let index = 3; index <= 12; index += 1) test.relay.pushEvent("ses_a", {
        id: `evt_${index}`, type: "session.tool.progress", durable: { aggregateID: "ses_a", seq: index, version: 1 },
        data: { sessionID: "ses_a", assistantMessageID: "msg_assistant", callID: `call_${index}`,
          structured: { sessionID: `ses_child_${index}`, status: "running" }, content: [] },
      })
      await waitFor(() => test.store.state().teamCues.at(-1)?.childID === "ses_child_12")
      expect(test.store.state().teamCues).toHaveLength(8)
      expect(test.store.state().teamCues[0]?.childID).toBe("ses_child_5")
      watermark = 12
      test.relay.dropConnections(1006, "")
      await waitFor(() => test.store.state().teamCues.length === 0)
      await waitFor(() => test.store.state().transport.kind === "open", 3_000)
      await waitFor(() => test.store.state().view?.watermark === 12)
      await waitFor(() => test.store.state().team?.status === "ready")
      test.relay.pushEvent("ses_a", delegated)
      await Bun.sleep(20)
      expect(test.store.state().teamCues).toEqual([])
    } finally { await test.stop() }
  })
})
