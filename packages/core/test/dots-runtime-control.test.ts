import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { DotsHttp } from "../src/dots/http"
import { DotsRoom } from "../src/dots/room"
import { DotsTransport } from "../src/dots/transport"

const credentials = { access: "synthetic-access", accountID: "synthetic-account" }
const target = { dotID: "dot/control", threadID: "thread/control" }
const metadata = { id: target.dotID, active_root_thread_id: target.threadID, status: "active", is_paused: false }
const failure = (exit: Exit.Exit<unknown, DotsTransport.Error>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("Expected a transport failure")
  return Cause.squash(exit.cause) as DotsTransport.Error
}

function fixture() {
  const calls: DotsHttp.Request[] = []
  const replies: unknown[] = []
  let dispatched = 0
  const transport = DotsRoom.make({
    http: { json: (_credentials, request) => Effect.suspend(() => {
      calls.push(request)
      const response = replies.shift()
      return response instanceof DotsTransport.Error ? Effect.fail(response) : Effect.succeed(response)
    }) },
    pubsub: { connect: () => Effect.die("Runtime controls must not open a messaging socket") },
  })
  return { transport, calls, replies, dispatched: () => dispatched, onDispatch: () => { dispatched++ } }
}

test("reads paused, unpaused and unknown without inferring execution activity", async () => {
  for (const [is_paused, expected] of [[true, "paused"], [false, "unpaused"], [undefined, "unknown"], ["false", "unknown"]] as const) {
    const value = fixture()
    value.replies.push({ ...metadata, is_paused })
    expect(await Effect.runPromise(value.transport.runtimeState(credentials, target))).toBe(expected)
    expect(value.calls).toEqual([{ method: "GET", path: "/tbo/by-thread/thread%2Fcontrol" }])
  }
})

test("rejects a different Dot, replaced root or inactive metadata before any control", async () => {
  for (const changed of [{ id: "another-dot" }, { active_root_thread_id: "replacement" }, { status: "inactive" }]) {
    const value = fixture()
    value.replies.push({ ...metadata, ...changed })
    expect(failure(await Effect.runPromiseExit(value.transport.runtimeState(credentials, target))).reason).toBe("target-changed")
    expect(value.calls).toHaveLength(1)
  }
  const value = fixture()
  value.replies.push({ ...metadata, active_root_thread_id: undefined })
  expect(await Effect.runPromise(value.transport.runtimeState(credentials, target))).toBe("unpaused")
})

test("sends bodyless runtime controls and confirms both outcomes with a fresh metadata read", async () => {
  for (const action of ["pause", "resume"] as const) {
    const value = fixture()
    value.replies.push({ thread_id: target.threadID, status: "synthetic-unclassified-status" }, { ...metadata, is_paused: action === "pause" })
    expect(await Effect.runPromise(value.transport.control(credentials, { ...target, action }, () => true, value.onDispatch))).toBe(action === "pause" ? "paused" : "unpaused")
    expect(value.calls).toEqual([
      { method: "POST", path: `/tbo/dot%2Fcontrol/runtime/${action}` },
      { method: "GET", path: "/tbo/by-thread/thread%2Fcontrol" },
    ])
    expect(value.dispatched()).toBe(1)
  }
})

test("never dispatches a stale control or follows a root returned by the control response", async () => {
  const stale = fixture()
  expect(failure(await Effect.runPromiseExit(stale.transport.control(credentials, { ...target, action: "pause" }, () => false, stale.onDispatch))).reason).toBe("target-changed")
  expect(stale.calls).toEqual([])
  expect(stale.dispatched()).toBe(0)
  const changed = fixture()
  changed.replies.push({ thread_id: "replacement", status: "paused" })
  expect(failure(await Effect.runPromiseExit(changed.transport.control(credentials, { ...target, action: "pause" }, () => true))).reason).toBe("target-changed")
  expect(changed.calls).toEqual([{ method: "POST", path: "/tbo/dot%2Fcontrol/runtime/pause" }])
})

test("rejects malformed acknowledgements and unconfirmed runtime state without replay", async () => {
  for (const reply of [null, {}, { thread_id: target.threadID, status: 1 }]) {
    const value = fixture()
    value.replies.push(reply)
    expect(failure(await Effect.runPromiseExit(value.transport.control(credentials, { ...target, action: "pause" }, () => true))).reason).toBe("invalid-response")
    expect(value.calls).toHaveLength(1)
  }
  for (const is_paused of [false, undefined]) {
    const value = fixture()
    value.replies.push({ thread_id: target.threadID, status: "accepted" }, { ...metadata, is_paused })
    expect(failure(await Effect.runPromiseExit(value.transport.control(credentials, { ...target, action: "pause" }, () => true))).reason).toBe("invalid-response")
    expect(value.calls).toHaveLength(2)
  }
})

test("detects replacement during confirmation and does not retry HTTP failures", async () => {
  const changed = fixture()
  changed.replies.push({ thread_id: target.threadID, status: "accepted" }, { ...metadata, active_root_thread_id: "replacement" })
  expect(failure(await Effect.runPromiseExit(changed.transport.control(credentials, { ...target, action: "pause" }, () => true))).reason).toBe("target-changed")
  for (const reason of ["unauthorized", "disconnected"] as const) {
    const value = fixture()
    value.replies.push(new DotsTransport.Error({ reason, message: "synthetic failure" }))
    expect(failure(await Effect.runPromiseExit(value.transport.control(credentials, { ...target, action: "pause" }, () => true))).reason).toBe(reason)
    expect(value.calls).toHaveLength(1)
  }
})

test("allows only bodyless POST runtime actions through the HTTP boundary", async () => {
  const calls: RequestInit[] = []
  const http = DotsHttp.make({ fetch: async (_url, input) => { calls.push(input); return Response.json({ thread_id: target.threadID, status: "accepted" }) } })
  for (const action of ["pause", "resume"]) await Effect.runPromise(http.json(credentials, { method: "POST", path: `/tbo/dot%2Fcontrol/runtime/${action}` }))
  expect(calls).toHaveLength(2)
  expect(calls.every(call => call.method === "POST" && call.body === undefined)).toBe(true)
  for (const request of [
    { method: "GET" as const, path: "/tbo/dot/runtime/pause" },
    { method: "POST" as const, path: "/tbo/dot/runtime/pause", body: {} },
    { method: "POST" as const, path: "/tbo/dot/runtime/delete" },
  ]) expect(Exit.isFailure(await Effect.runPromiseExit(http.json(credentials, request)))).toBe(true)
  expect(calls).toHaveLength(2)
})
