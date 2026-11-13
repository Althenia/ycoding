import { expect } from "bun:test"
import { DateTime, Deferred, Effect, Fiber, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { DotsAccess } from "../src/dots/access"
import { EventRuntime } from "../src/event"
import { KV } from "../src/kv"
import { Session } from "../src/session"
import { AbsolutePath } from "../src/schema"
import { reviewLayer } from "./fixture/review"
import { testEffect } from "./lib/effect"
import { SessionEvent } from "../src/session/event"
import { EventTable } from "../src/event/sql"
import { SessionHistoryPruning } from "../src/session/history-pruning"

const unavailable = async () => ({ ok: false as const, problem: "durable-unavailable" as const })
const unavailableConversation = { threads: unavailable, taskUpdates: unavailable, read: unavailable, send: unavailable, interrupt: unavailable, resume: unavailable, requests: unavailable, respond: unavailable }
const idleComputer = { computer: async () => ({ state: "detached" as const }), attachComputer: async () => ({ state: "detached" as const }), detachComputer: async () => ({ state: "detached" as const }), removeComputer: async () => ({ state: "unavailable" as const, problem: "configuration" as const }), conversation: unavailableConversation }

const it = testEffect(reviewLayer())

for (const operation of ["status", "attach"] as const) for (const change of ["profile", "access", "owner"] as const)
  it.live(`${operation} publication drops old details after ${change} changes during its transport read`, () => Effect.gen(function* () {
    const f = yield* setup
    let profile = "old-profile"
    const access = DotsAccess.make({ db: f.db, kv: f.kv, configuration: () => Effect.succeed({ ready: true, profile }) })
    yield* access.set({ enabled: true, expectedRevision: 0 })
    const entered = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    const target = { dotID: "old-dot", threadID: "old-thread", environmentID: "old-env", revision: "a".repeat(64) }
    const delayed = () => Effect.runPromise(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))))
    const release = access.attachTransport({
      ...idleComputer,
      status: async () => { if (operation === "status") await delayed(); return { state: "connected", hostname: "Old.local", name: "Old native" } },
      computer: async () => ({ state: "attached", name: "Old executor", target }),
      attachComputer: async () => { await delayed(); return { state: "attached", name: "Old executor", target } },
    })
    const pending = yield* (operation === "status" ? access.status() : access.attachComputer({ replaceOthers: false, expectedTarget: target })).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    if (change === "profile") profile = "new-profile"
    if (change === "access") yield* access.set({ enabled: false, expectedRevision: 1 })
    let next: (() => void) | undefined
    if (change === "owner") {
      release()
      next = access.attachTransport({ ...idleComputer, status: async () => ({ state: "connected", hostname: "New.local", name: "New native" }) })
    }
    yield* Deferred.succeed(gate, undefined)
    const result = yield* Fiber.join(pending)
    expect(result.connection.hostname).toBeUndefined()
    expect(result.connection.name).toBeUndefined()
    expect(result.computer?.name).toBeUndefined()
    expect(result.computer?.target).toBeUndefined()
    expect(result.computer?.state).not.toBe("attached")
    if (change === "profile") expect(result.configuration.profile).toBe("new-profile")
    release()
    next?.()
  }))

it.live("status preserves separate names and exact target receipts through attachment", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  let received: unknown
  const release = f.access.attachTransport({
    ...idleComputer,
    status: async () => ({ state: "connected", hostname: "box.local", name: "Native desk" }),
    computer: async () => ({ state: "detached", name: "Executor desk", target }),
    attachComputer: async (expected) => { received = expected; return { state: "attached", name: "Executor desk", target } },
  })
  const before = yield* f.access.status()
  expect(before.connection).toEqual({ state: "connected", hostname: "box.local", name: "Native desk" })
  expect(before.computer).toEqual({ state: "detached", name: "Executor desk", target })
  expect((yield* f.access.attachComputer({ replaceOthers: false, expectedTarget: target })).computer).toEqual({ state: "attached", name: "Executor desk", target })
  expect(received).toEqual({ replaceOthers: false, expectedTarget: target })
  release()
}))

it.live("an unconfirmed attachment explains that the mutation must not be replayed", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  let calls = 0
  const release = f.access.attachTransport({
   ...idleComputer,
    ...idleComputer,
    status: async () => ({ state: "connected" }),
    attachComputer: async () => { calls++; return { state: "unavailable", problem: "unconfirmed" } },
  })
  expect((yield* f.access.attachComputer({ replaceOthers: false })).computer?.message).toContain("Do not repeat")
  expect(calls).toBe(1)
  release()
}))
const setup = Effect.gen(function* () {
  const db = yield* Database.Service
  const kv = yield* KV.Service
  let ready = true
  const configuration = () => Effect.succeed({ ready, profile: "trusted" })
  const make = () => DotsAccess.make({ db, kv, configuration })
  return { db, kv, make, access: make(), unavailable: () => { ready = false } }
})

it.live("computer attachment forwards the replaceOthers consent to the transport", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  let received: unknown
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  const release = f.access.attachTransport({
    ...idleComputer,
    status: async () => ({ state: "connected" }),
    computer: async () => ({ state: "detached" }),
    attachComputer: async (input) => { received = input; return { state: "attached" } },
  })
  expect((yield* f.access.attachComputer({ replaceOthers: false, expectedTarget: target })).computer?.state).toBe("attached")
  expect(received).toEqual({ replaceOthers: false, expectedTarget: target })
  expect((yield* f.access.attachComputer({ replaceOthers: true, expectedTarget: target })).computer?.state).toBe("attached")
  expect(received).toEqual({ replaceOthers: true, expectedTarget: target })
  release()
}))

it.live("global access defaults off despite historical family grants and persists independently of Session creation", () => Effect.gen(function* () {
  const f = yield* setup
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  yield* sessions.create({ parentID: root.id })
  yield* events.publish(SessionEvent.DotsAccessChanged, { sessionID: root.id, enabled: true, revision: 9 })
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 0 })
  expect(yield* f.access.set({ enabled: true, expectedRevision: 0 })).toEqual({ enabled: true, revision: 1 })
  yield* sessions.create({ location: root.location })
  yield* sessions.fork({ sessionID: root.id })
  expect(yield* f.make().get()).toEqual({ enabled: true, revision: 1 })
  const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  expect(log.filter((event) => event.type === SessionEvent.DotsAccessChanged.type)).toHaveLength(1)
  f.unavailable()
  expect((yield* f.access.set({ enabled: true, expectedRevision: 1 }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* f.access.set({ enabled: false, expectedRevision: 1 })).toEqual({ enabled: false, revision: 2 })
  expect((yield* f.access.set({ enabled: true, expectedRevision: 2 }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 2 })
}))

it.live("global transactional CAS admits one writer, checks stale noops and preserves unrelated KV data", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.kv.set("synthetic.unrelated", { keep: true })
  let notified = 0
  const stop = f.access.subscribe(() => { notified++ })
  expect(yield* f.access.set({ enabled: false, expectedRevision: 0 })).toEqual({ enabled: false, revision: 0 })
  expect(notified).toBe(0)
  const results = yield* Effect.all([
    f.access.set({ enabled: true, expectedRevision: 0 }).pipe(Effect.exit),
    f.make().set({ enabled: true, expectedRevision: 0 }).pipe(Effect.exit),
  ], { concurrency: "unbounded" })
  expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"])
  expect((yield* f.access.set({ enabled: true, expectedRevision: 0 }).pipe(Effect.flip)).code).toBe("conflict")
  expect(yield* f.access.set({ enabled: true, expectedRevision: 1 })).toEqual({ enabled: true, revision: 1 })
  expect(notified).toBeLessThanOrEqual(1)
  stop()
  expect(yield* f.kv.get("synthetic.unrelated")).toEqual({ keep: true })
}))

it.live("malformed global preference fails closed without overwriting stored data", () => Effect.gen(function* () {
  const f = yield* setup
  const malformed = { enabled: true, revision: -1 }
  yield* f.kv.set("dots.native-access", malformed)
  expect((yield* f.access.get().pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* f.access.status().pipe(Effect.flip)).code).toBe("unavailable")
  expect((yield* f.access.set({ enabled: false, expectedRevision: 0 }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* f.kv.get("dots.native-access")).toEqual(malformed)
}))

it.live("historical family access remains decodable after pruning without granting global access", () => Effect.gen(function* () {
  const f = yield* setup
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: { directory: AbsolutePath.make(process.cwd()) } })
  const sequence = (yield* events.sequences([root.id])).get(root.id)!
  yield* events.replay({ id: EventRuntime.ID.create(), created: DateTime.makeUnsafe(0),
    type: EventRuntime.versionedType(SessionEvent.DotsAccessChanged.type, 1), aggregateID: root.id,
    seq: sequence + 1, data: { sessionID: root.id, enabled: true, revision: 1 } })
  yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
  yield* f.db.db.update(EventTable).set({ created: 0 }).where(eq(EventTable.aggregate_id, root.id)).run()
  yield* SessionHistoryPruning.make(f.db.db, Effect.succeed(new Set<Session.ID>())).prune(root.id)
  const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  expect(log.filter((event) => event.type === SessionEvent.DotsAccessChanged.type)).toHaveLength(1)
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 0 })
}))

it.live("native status distinguishes configuration, global access and attached transport", () => Effect.gen(function* () {
  const f = yield* setup
  expect(yield* f.access.status()).toEqual({ access: { enabled: false, revision: 0 }, configuration: { ready: true, profile: "trusted" }, connection: { state: "unavailable" } })
  const release = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connected", hostname: "Synthetic.local" }) })
  expect((yield* f.access.status()).connection).toEqual({ state: "off", hostname: "Synthetic.local" })
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  expect((yield* f.access.status()).connection).toEqual({ state: "connected", hostname: "Synthetic.local" })
  f.unavailable()
  expect((yield* f.access.status()).connection).toEqual({ state: "off", hostname: "Synthetic.local" })
  expect((yield* f.access.get()).enabled).toBe(true)
  release()
  expect((yield* f.access.status()).connection.state).toBe("unavailable")
}))

it.live("transport attachment rejects replacement and fences stale release and delayed status", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const entered = yield* Deferred.make<void>()
  const result = yield* Deferred.make<DotsAccess.TransportStatus>()
  const release = f.access.attachTransport({ ...idleComputer, status: () => Effect.runPromise(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(result)))) })
  expect(() => f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "off" }) })).toThrow()
  const reading = yield* f.access.status().pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  release()
  const next = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connecting" }) })
  release()
  yield* Deferred.succeed(result, { state: "connected", hostname: "Old.local" })
  expect((yield* Fiber.join(reading)).connection).toEqual({ state: "unavailable" })
  expect((yield* f.access.status()).connection).toEqual({ state: "connecting" })
  next()
}))

it.live("status discards a connected result delayed across global Off-On", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const entered = yield* Deferred.make<void>()
  const result = yield* Deferred.make<DotsAccess.TransportStatus>()
  const release = f.access.attachTransport({ ...idleComputer, status: () => Effect.runPromise(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(result)))) })
  const reading = yield* f.access.status().pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  yield* f.access.set({ enabled: false, expectedRevision: 1 })
  yield* f.access.set({ enabled: true, expectedRevision: 2 })
  yield* Deferred.succeed(result, { state: "connected", hostname: "Old.local" })
  expect((yield* Fiber.join(reading)).connection.state).not.toBe("connected")
  release()
}))

it.live("native status bounds display strings and exposes fixed error guidance rather than provider text", () => Effect.gen(function* () {
  const f = yield* setup
  const access = DotsAccess.make({ db: f.db, kv: f.kv, configuration: () => Effect.succeed({ ready: true, profile: "trusted\u001b\n" + "p".repeat(300) }) })
  yield* access.set({ enabled: true, expectedRevision: 0 })
  const release = access.attachTransport({ ...idleComputer, status: async () => ({ state: "connecting", hostname: "Synthetic\u001b\n" + "h".repeat(300), problem: "authentication", message: "synthetic private provider payload" }) })
  const status = yield* access.status()
  expect(status.configuration.profile!.length).toBeLessThanOrEqual(256)
  expect(status.connection.hostname!.length).toBeLessThanOrEqual(256)
  expect(status.connection.message).toContain("profile")
  expect(JSON.stringify(status)).not.toContain("private provider")
  expect(/[\u0000-\u001f\u007f-\u009f]/.test(status.configuration.profile! + status.connection.hostname!)).toBe(false)
  release()
}))

it.live("a failed transport status read reports a safe connection error without exposing its failure", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const release = f.access.attachTransport({ ...idleComputer, status: async () => { throw new Error("synthetic private provider payload") } })
  const status = yield* f.access.status()
  expect(status.connection.state).toBe("error")
  expect(status.connection.message).toContain("retries automatically")
  expect(JSON.stringify(status)).not.toContain("private provider")
  release()
}))

it.live("native status reports the transport's computer state with fixed guidance only while a transport is attached", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  let computer: () => Promise<DotsAccess.ComputerStatus> = async () => ({ state: "attached" })
  const release = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connected" }), computer: () => computer() })
  expect((yield* f.access.status()).computer).toEqual({ state: "attached" })
  computer = async () => ({ state: "detached", problem: "admin-disabled" })
  expect((yield* f.access.status()).computer).toEqual({ state: "detached", message: "Your workspace administrator has disabled local computer access." })
  computer = async () => { throw new Error("synthetic private provider payload") }
  const failed = yield* f.access.status()
  expect(failed.computer).toEqual({ state: "unavailable", message: "Your Dot's computers could not be read. Try again." })
  expect(JSON.stringify(failed)).not.toContain("private provider")
  release()
  expect((yield* f.access.status()).computer).toBeUndefined()
}))

it.live("a connected transport never makes the computer attached and an unlisted or unread computer keeps its own fixed guidance", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  let computer: () => Promise<DotsAccess.ComputerStatus> = async () => ({ state: "unavailable", problem: "not-listed" })
  const release = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connected" }), computer: () => computer() })
  const unlisted = yield* f.access.status()
  expect(unlisted.connection.state).toBe("connected")
  expect(unlisted.computer).toEqual({ state: "unavailable", message: "This computer is not among your Dot's computers yet. Keep Dots access on and try again." })
  computer = async () => ({ state: "unavailable", problem: "connection" })
  const unread = yield* f.access.status()
  expect(unread.connection.state).toBe("connected")
  expect(unread.computer).toEqual({ state: "unavailable", message: "Your Dot's computers could not be read. Try again." })
  release()
}))

it.live("computer attachment requires a transport and enabled access and reports the attach outcome", () => Effect.gen(function* () {
  const f = yield* setup
  expect((yield* f.access.attachComputer({ replaceOthers: false }).pipe(Effect.flip)).code).toBe("unavailable")
  let attaches = 0
  let outcome: DotsAccess.ComputerStatus = { state: "detached", problem: "rejected" }
  const release = f.access.attachTransport({
    ...idleComputer,
    status: async () => ({ state: "connected" }),
    computer: async () => ({ state: "detached" }),
    attachComputer: async () => { attaches++; return outcome },
  })
  expect((yield* f.access.attachComputer({ replaceOthers: false })).computer).toEqual({ state: "unavailable", message: "Turn on Dots access with a ready ChatGPT profile to attach this computer." })
  expect(attaches).toBe(0)
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  expect((yield* f.access.attachComputer({ replaceOthers: false })).computer).toEqual({ state: "detached", message: "ChatGPT refused the request." })
  outcome = { state: "attached" }
  const attached = yield* f.access.attachComputer({ replaceOthers: false })
  expect(attached.computer).toEqual({ state: "attached" })
  expect(attached.connection.state).toBe("connected")
  expect(attaches).toBe(2)
  f.unavailable()
  expect((yield* f.access.attachComputer({ replaceOthers: false })).computer?.state).toBe("unavailable")
  expect(attaches).toBe(2)
  release()
}))

it.live("status exposes readiness, task usability and the Dot environment from the transport and omits them when absent", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const dotEnvironment = { status: "offline", capabilities: [{ type: "remote_desktop", status: "starting" }] }
  let computer: DotsAccess.ComputerStatus = { state: "attached", readiness: "connected", usableForTasks: true, dotEnvironment }
  const release = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connected" }), computer: async () => computer })
  expect((yield* f.access.status()).computer).toEqual({ state: "attached", readiness: "connected", usableForTasks: true, dotEnvironment })
  computer = { state: "attached", usableForTasks: false }
  expect((yield* f.access.status()).computer).toEqual({ state: "attached", usableForTasks: false })
  computer = { state: "attached" }
  expect((yield* f.access.status()).computer).toEqual({ state: "attached" })
  release()
}))

it.live("computer detachment requires a transport and enabled access, forwards the target and reports fixed guidance", () => Effect.gen(function* () {
  const f = yield* setup
  expect((yield* f.access.detachComputer({}).pipe(Effect.flip)).code).toBe("unavailable")
  const calls: unknown[] = []
  let outcome: DotsAccess.ComputerStatus = { state: "attached", problem: "not-disconnectable" }
  const target = { dotID: "dot-a", threadID: "thread-a", environmentID: "env-a", revision: "a".repeat(64) }
  const release = f.access.attachTransport({
    ...idleComputer, status: async () => ({ state: "connected" }), computer: async () => ({ state: "attached" }),
    detachComputer: async (input) => { calls.push(input); return outcome },
  })
  expect((yield* f.access.detachComputer({})).computer).toEqual({ state: "unavailable", message: "Turn on Dots access with a ready ChatGPT profile to attach this computer." })
  expect(calls).toEqual([])
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  expect((yield* f.access.detachComputer({})).computer).toEqual({ state: "attached", message: "ChatGPT does not allow detaching this computer right now." })
  outcome = { state: "attached", problem: "rejected" }
  expect((yield* f.access.detachComputer({ expectedTarget: target })).computer).toEqual({ state: "attached", message: "ChatGPT refused the request." })
  outcome = { state: "attached", problem: "unconfirmed" }
  expect((yield* f.access.detachComputer({})).computer?.message).toContain("Do not repeat")
  outcome = { state: "detached" }
  const detached = yield* f.access.detachComputer({})
  expect(detached.computer).toEqual({ state: "detached" })
  expect(detached.connection.state).toBe("connected")
  expect(calls).toEqual([{}, { expectedTarget: target }, {}, {}])
  release()
}))

it.live("computer removal turns Dots access off only after a confirmed removal and reports the removed state", () => Effect.gen(function* () {
  const f = yield* setup
  expect((yield* f.access.removeComputer({}).pipe(Effect.flip)).code).toBe("unavailable")
  const calls: unknown[] = []
  let outcome: DotsAccess.ComputerStatus = { state: "attached", problem: "not-deletable" }
  const release = f.access.attachTransport({
    ...idleComputer, status: async () => ({ state: "connected" }), computer: async () => ({ state: "attached" }),
    removeComputer: async (input) => { calls.push(input); return outcome },
  })
  expect((yield* f.access.removeComputer({})).computer?.state).toBe("unavailable")
  expect(calls).toEqual([])
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  expect((yield* f.access.removeComputer({})).computer).toEqual({ state: "attached", message: "ChatGPT does not allow removing this computer right now." })
  outcome = { state: "detached", problem: "unconfirmed" }
  expect((yield* f.access.removeComputer({})).access).toEqual({ enabled: true, revision: 1 })
  outcome = { state: "removed" }
  const removed = yield* f.access.removeComputer({})
  expect(removed.access).toEqual({ enabled: false, revision: 2 })
  expect(removed.computer).toEqual({ state: "removed", message: "This computer was removed from your ChatGPT account and Dots access is off. Turn Dots access on to enroll it again." })
  expect(yield* f.access.get()).toEqual({ enabled: false, revision: 2 })
  expect(calls).toEqual([{}, {}, {}])
  release()
}))

it.live("removal reports the removed state without another write when access was already turned off concurrently", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const release = f.access.attachTransport({
    ...idleComputer, status: async () => ({ state: "connected" }), computer: async () => ({ state: "attached" }),
    removeComputer: async () => { await Effect.runPromise(f.access.set({ enabled: false, expectedRevision: 1 })); return { state: "removed" } },
  })
  const removed = yield* f.access.removeComputer({})
  expect(removed.access).toEqual({ enabled: false, revision: 2 })
  expect(removed.computer?.state).toBe("removed")
  release()
}))

it.live("Dot conversation operations require access, a ready configuration and an attached transport before any transport call", () => Effect.gen(function* () {
  const f = yield* setup
  const calls: unknown[] = []
  const conversation = { ...unavailableConversation, threads: async () => { calls.push("threads"); return { ok: true as const, value: { dotID: "dot-a", threads: [], tasks: [] } } } }
  expect((yield* Effect.flip(f.access.threads())).code).toBe("unavailable")
  const release = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connected" }), conversation })
  const off = yield* Effect.flip(f.access.threads())
  expect(off).toMatchObject({ code: "unavailable", message: "Turn on Dots access with a ready ChatGPT profile to use your Dot's conversation." })
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  f.unavailable()
  expect((yield* Effect.flip(f.access.threads())).code).toBe("unavailable")
  expect(calls).toEqual([])
  release()
}))

it.live("Dot conversation results are decoded and transport problems become fixed sanitized errors", () => Effect.gen(function* () {
  const f = yield* setup
  yield* f.access.set({ enabled: true, expectedRevision: 0 })
  const received: unknown[] = []
  let problem: DotsAccess.ConversationProblem = "stale"
  let responded = 0
  const conversation = {
    ...unavailableConversation,
    threads: async () => ({ ok: true as const, value: { dotID: "dot-a", rootThreadID: "thr-root", threads: [{ threadID: "thr-root", kind: "root" as const, name: "Root" }], tasks: [] } }),
    send: async (threadID: string, input: unknown) => { received.push([threadID, input]); return { ok: true as const, value: { admission: "steered" as const, turnID: "turn-1" } } },
    read: async () => ({ ok: true as const, value: { thread: { threadID: "thr-root", kind: "root" as const }, turns: [{ turnID: "t", items: [{ type: "agentMessage" as const, itemID: "i", text: "x".repeat(70000) }] }] } }),
    respond: async () => { responded++; return { ok: false as const, problem } },
    resume: async () => { throw new Error("synthetic private upstream payload sk-secret") },
  }
  const release = f.access.attachTransport({ ...idleComputer, status: async () => ({ state: "connected" }), conversation })
  expect(yield* f.access.threads()).toEqual({ dotID: "dot-a", rootThreadID: "thr-root", threads: [{ threadID: "thr-root", kind: "root", name: "Root" }], tasks: [] })
  const message = { text: "Continue", clientMessageID: "client-1", mode: "send" as const }
  expect(yield* f.access.sendMessage("thr-root", message)).toEqual({ admission: "steered", turnID: "turn-1" })
  expect(received).toEqual([["thr-root", message]])
  const extraField = { ...message, extra: true }
  expect((yield* Effect.flip(f.access.sendMessage("thr-root", extraField))).code).toBe("invalid_input")
  expect((yield* Effect.flip(f.access.sendMessage("", message))).code).toBe("invalid_input")
  expect(received).toHaveLength(1)
  expect(yield* Effect.flip(f.access.readThread("thr-root", {}))).toMatchObject({ code: "unavailable", message: "ChatGPT returned a response that could not be read." })
  for (const input of [{}, { decision: "accept" as const, answers: { q1: ["Yes"] } }])
    expect((yield* Effect.flip(f.access.respond("thr-root", "req-1", input))).code).toBe("invalid_input")
  expect(responded).toBe(0)
  expect(yield* Effect.flip(f.access.respond("thr-root", "req-1", { decision: "accept" }))).toMatchObject({ code: "conflict" })
  expect(responded).toBe(1)
  for (const [next, code] of [["unsupported", "invalid_input"], ["invalid-answer", "invalid_input"], ["durable-unavailable", "unavailable"], ["thread-unavailable", "unavailable"]] as const) {
    problem = next
    expect((yield* Effect.flip(f.access.respond("thr-root", "req-1", { decision: "accept" }))).code).toBe(code)
  }
  const failure = yield* Effect.flip(f.access.resume())
  expect(failure).toMatchObject({ code: "unavailable", message: "Your Dot could not be reached. Try again." })
  expect(JSON.stringify(failure)).not.toContain("sk-secret")
  release()
}))
