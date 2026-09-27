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
