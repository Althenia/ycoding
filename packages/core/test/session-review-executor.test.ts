import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionReview as SessionReviewSchema } from "@ycoding-ai/schema/session-review"
import { testEffect } from "./lib/effect"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(reviewLayer())
const agent = Agent.ID.make("executor-test")
const command = "cat notes.txt"

const services = (location: Location.Ref) => Effect.gen(function* () {
  const locations = yield* LocationServiceMap.Service
  const provided = locations.get(location, [LocationServiceMap.full])
  const agents = yield* Agent.Service.pipe(Effect.provide(provided))
  yield* agents.transform((draft) => draft.update(agent, (entry) => {
    entry.permissions = [
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "rm *", effect: "deny" },
    ]
  }))
  return {
    permission: yield* Permission.Service.pipe(Effect.provide(provided)),
    guardrail: yield* SessionGuardrail.Service.pipe(Effect.provide(provided)),
  }
})

const setupAt = (location: Effect.Effect<Location.Ref, never, Scope.Scope>) => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* sessions.create({ location: yield* location })
  return { sessions, reviews, root, ...(yield* services(root.location)) }
})
const setup = setupAt(reviewLocation)

const shellInput = (sessionID: Session.ID, metadata: Record<string, string> = {}, resource = command) => ({
  sessionID, agent, action: "shell", resources: [resource], save: [resource], defer: true as const,
  metadata: { cwd: "/work", workdir: "/work", ...metadata },
})

const permissionDeferred = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined
  for (const reason of exit.cause.reasons)
    if (Cause.isDieReason(reason) && reason.defect instanceof Permission.DeferredError) return reason.defect
  return undefined
}

const deferPermission = (permission: Permission.Interface, input: Permission.AssertInput) =>
  permission.assert(input).pipe(Effect.timeout("2 seconds"), Effect.exit, Effect.map(permissionDeferred))

const hardInput = (sessionID: Session.ID, metadata: Record<string, string> = {}) => ({
  sessionID, action: "shell", resources: ["git reset --hard"], defer: true as const,
  metadata: { cwd: "/work", workdir: "/work", ...metadata },
})

const deferGuardrail = (guardrail: SessionGuardrail.Interface, input: SessionGuardrail.EvaluateInput) =>
  guardrail.assert(input).pipe(Effect.timeout("2 seconds"), Effect.flip)

it.effect("a deferred permission ask fails fast with an executor review item and no live ask", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  const deferred = yield* deferPermission(permission, shellInput(root.id, { processId: "proc_1" }))
  expect(deferred).toBeInstanceOf(Permission.DeferredError)
  expect(deferred).toMatchObject({ sessionID: root.id, state: "open", action: "shell", resources: [command] })
  const items = yield* reviews.list(root.id)
  expect(items).toHaveLength(1)
  expect(items[0]?.itemID).toBe(deferred!.itemID!)
  expect(items[0]?.origin).toEqual({ requestID: expect.any(String), executor: true })
  expect(yield* permission.list()).toEqual([])
}))

it.effect("an identical deferred permission ask reuses the open item across volatile metadata", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  const first = yield* deferPermission(permission, shellInput(root.id, { processId: "proc_1", sandboxProfile: "managed" }))
  const second = yield* deferPermission(permission, shellInput(root.id, { processId: "proc_2" }))
  expect(second?.state).toBe("open")
  expect(second?.itemID).toBe(first?.itemID)
  expect(yield* reviews.list(root.id)).toHaveLength(1)
}))

it.effect("an approved once lets exactly one identical deferred retry pass", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  const first = yield* deferPermission(permission, shellInput(root.id, { processId: "proc_1" }))
  yield* reviews.decide({ sessionID: root.id, itemID: first!.itemID!, decision: { kind: "permission", reply: "once" } })
  yield* permission.assert(shellInput(root.id, { processId: "proc_2", sandboxFileSystem: "restricted" }))
  const third = yield* deferPermission(permission, shellInput(root.id, { processId: "proc_3" }))
  expect(third?.state).toBe("open")
  expect(third?.itemID).not.toBe(first!.itemID!)
}))

it.effect("a deferred approval does not match a different cwd, argv or command", () => Effect.gen(function* () {
  const { root, reviews, permission } = yield* setup
  const first = yield* deferPermission(permission, shellInput(root.id, { argv: "[\"sh\",\"-c\",\"cat notes.txt\"]" }))
  yield* reviews.decide({ sessionID: root.id, itemID: first!.itemID!, decision: { kind: "permission", reply: "once" } })
  for (const input of [
    shellInput(root.id, { cwd: "/elsewhere", workdir: "/elsewhere", argv: "[\"sh\",\"-c\",\"cat notes.txt\"]" }),
    shellInput(root.id, { argv: "[\"bash\",\"-c\",\"cat notes.txt\"]" }),
    shellInput(root.id, { argv: "[\"sh\",\"-c\",\"cat notes.txt\"]" }, "cat other.txt"),
  ]) expect((yield* deferPermission(permission, input))?.state).toBe("open")
  yield* permission.assert(shellInput(root.id, { argv: "[\"sh\",\"-c\",\"cat notes.txt\"]" }))
}))

it.effect("a rejected deferred permission keeps the identical retry refused without a new item", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  const first = yield* deferPermission(permission, shellInput(root.id))
  yield* reviews.decide({ sessionID: root.id, itemID: first!.itemID!, decision: { kind: "permission", reply: "reject" } })
  const retry = yield* deferPermission(permission, shellInput(root.id, { processId: "proc_retry" }))
  expect(retry).toMatchObject({ state: "rejected", itemID: first!.itemID!, sessionID: root.id })
  expect(yield* reviews.list(root.id)).toEqual([])
}))

it.effect("an always approval remembers save so later identical deferred asks pass", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  const first = yield* deferPermission(permission, shellInput(root.id))
  yield* reviews.decide({ sessionID: root.id, itemID: first!.itemID!, decision: { kind: "permission", reply: "always" } })
  yield* permission.assert(shellInput(root.id, { processId: "proc_2" }))
  yield* permission.assert(shellInput(root.id, { processId: "proc_3" }))
  expect(yield* reviews.list(root.id)).toEqual([])
}))

it.effect("deny rules refuse a deferred permission ask before any review item", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  const exit = yield* permission.assert(shellInput(root.id, {}, "rm notes.txt")).pipe(Effect.timeout("2 seconds"), Effect.exit)
  expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error instanceof Permission.BlockedError)).toBe(true)
  expect(yield* reviews.list(root.id)).toEqual([])
}))

it.effect("auto permissions still allow a deferred ask without a review item", () => Effect.gen(function* () {
  const { sessions, reviews, root, permission } = yield* setup
  yield* sessions.autonomy.set({ sessionID: root.id, permissions: "auto" })
  yield* permission.assert(shellInput(root.id)).pipe(Effect.timeout("2 seconds"))
  expect(yield* reviews.list(root.id)).toEqual([])
}))

it.effect("yolo permissions assess first and defer an escalation to an executor item", () => Effect.gen(function* () {
  const { sessions, reviews, root, permission } = yield* setup
  yield* sessions.autonomy.set({ sessionID: root.id, permissions: "yolo" })
  const deferred = yield* deferPermission(permission, shellInput(root.id))
  expect(deferred?.state).toBe("open")
  const items = yield* reviews.list(root.id)
  expect(items.map((item) => [item.kind, item.origin])).toEqual([["permission", { requestID: expect.any(String), executor: true }]])
}))

it.effect("a sleeping Session defers a deferred ask the same way", () => Effect.gen(function* () {
  const { sessions, reviews, root, permission } = yield* setup
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const deferred = yield* deferPermission(permission, shellInput(root.id))
  expect(deferred?.state).toBe("open")
  expect((yield* reviews.list(root.id))[0]?.origin).toEqual({ requestID: expect.any(String), executor: true })
}))

it.effect("a full review box refuses a deferred ask with no item", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  for (let index = 0; index < 16; index++)
    yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16, origin: { requestID: `frm_fill_${index}` },
      payload: { type: "form", title: "Fill", fields: [{ key: "plan", type: "string", required: true }] } })
  const deferred = yield* deferPermission(permission, shellInput(root.id))
  expect(deferred).toMatchObject({ state: "full", sessionID: root.id })
  expect(deferred?.itemID).toBeUndefined()
  expect(yield* reviews.list(root.id)).toHaveLength(16)
}))

it.effect("deferred and ordinary permission approvals never consume each other across volatile metadata", () => Effect.gen(function* () {
  const { sessions, reviews, root, permission } = yield* setup
  const volatile = { processId: "proc_shared" }
  const ordinary = { ...shellInput(root.id, volatile), defer: undefined }
  const deferredFirst = yield* deferPermission(permission, shellInput(root.id, volatile))
  yield* reviews.decide({ sessionID: root.id, itemID: deferredFirst!.itemID!, decision: { kind: "permission", reply: "once" } })
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const ordinaryExit = yield* permission.assert(ordinary).pipe(Effect.timeout("2 seconds"), Effect.exit)
  expect(permissionDeferred(ordinaryExit)?.state).toBe("open")
  const ordinaryItem = (yield* reviews.list(root.id)).find((item) => !("executor" in item.origin))
  expect(ordinaryItem).toBeDefined()
  yield* reviews.decide({ sessionID: root.id, itemID: ordinaryItem!.itemID, decision: { kind: "permission", reply: "once" } })
  yield* permission.assert(shellInput(root.id, volatile))
  const second = yield* deferPermission(permission, shellInput(root.id, volatile))
  expect(second?.state).toBe("open")
  yield* permission.assert(ordinary)
}))

it.effect("a deferred guardrail review fails fast with an executor item and no live ask", () => Effect.gen(function* () {
  const { reviews, root, guardrail } = yield* setup
  const deferred = yield* deferGuardrail(guardrail, hardInput(root.id, { processId: "proc_1" }))
  expect(deferred).toBeInstanceOf(SessionGuardrail.DeferredError)
  expect(deferred).toMatchObject({ sessionID: root.id, state: "open", hardReview: true, action: "shell", resources: ["git reset --hard"] })
  const items = yield* reviews.list(root.id)
  expect(items.map((item) => [item.kind, item.origin])).toEqual([["guardrail", { requestID: expect.any(String), executor: true }]])
  expect(yield* guardrail.list()).toEqual([])
}))

it.effect("an identical deferred guardrail review reuses the open item and a once approval passes one retry", () => Effect.gen(function* () {
  const { reviews, root, guardrail } = yield* setup
  const first = yield* deferGuardrail(guardrail, hardInput(root.id, { processId: "proc_1" }))
  if (!(first instanceof SessionGuardrail.DeferredError)) throw new Error("Expected a deferred guardrail review")
  const second = yield* deferGuardrail(guardrail, hardInput(root.id, { processId: "proc_2", sandboxProfile: "managed" }))
  expect(second).toMatchObject({ state: "open", itemID: first.itemID })
  yield* reviews.decide({ sessionID: root.id, itemID: first.itemID!, decision: { kind: "guardrail", reply: "once" } })
  const reservation = yield* guardrail.assert(hardInput(root.id, { processId: "proc_3" })).pipe(Effect.timeout("2 seconds"))
  yield* reservation.release
  const again = yield* deferGuardrail(guardrail, hardInput(root.id, { processId: "proc_4" }))
  if (!(again instanceof SessionGuardrail.DeferredError)) throw new Error("Expected a deferred guardrail review")
  expect(again.state).toBe("open")
  expect(again.itemID).not.toBe(first.itemID)
}))

it.effect("a rejected deferred guardrail review stays refused without a new item", () => Effect.gen(function* () {
  const { reviews, root, guardrail } = yield* setup
  const first = yield* deferGuardrail(guardrail, hardInput(root.id))
  if (!(first instanceof SessionGuardrail.DeferredError)) throw new Error("Expected a deferred guardrail review")
  yield* reviews.decide({ sessionID: root.id, itemID: first.itemID!, decision: { kind: "guardrail", reply: "reject" } })
  expect(yield* deferGuardrail(guardrail, hardInput(root.id, { processId: "proc_retry" }))).toMatchObject({ state: "rejected", itemID: first.itemID, hardReview: true })
  expect(yield* reviews.list(root.id)).toEqual([])
}))

it.effect("guardrail auto still approves an ordinary deferred review while manual defers it", () => Effect.gen(function* () {
  const { sessions, reviews, root, guardrail } = yield* setup
  const input = { sessionID: root.id, action: "shell", resources: [`touch ${path.join(os.homedir(), "ycoding-outside-probe.txt")}`], defer: true as const,
    metadata: { cwd: root.location.directory, workdir: root.location.directory } }
  expect(yield* guardrail.evaluate(input)).toMatchObject({ decision: "ask", standard: true, hardReview: false })
  expect(yield* deferGuardrail(guardrail, input)).toMatchObject({ state: "open", hardReview: false })
  yield* sessions.autonomy.set({ sessionID: root.id, guardrails: "auto" })
  const reservation = yield* guardrail.assert({ ...input, resources: [`touch ${path.join(os.homedir(), "ycoding-outside-other.txt")}`] }).pipe(Effect.timeout("2 seconds"))
  yield* reservation.release
  expect(yield* reviews.list(root.id)).toHaveLength(1)
}))

it.effect("deciding an executor item admits no steer prompt and reconciliation leaves it alone", () => Effect.gen(function* () {
  const { reviews, root, permission } = yield* setup
  const first = yield* deferPermission(permission, shellInput(root.id))
  yield* reviews.decide({ sessionID: root.id, itemID: first!.itemID!, decision: { kind: "permission", reply: "once" } })
  const db = (yield* Database.Service).db
  expect(yield* SessionPending.lookup(db, root.id, SessionReview.promptID(first!.itemID!))).toBeUndefined()
  const second = yield* deferPermission(permission, shellInput(root.id, {}, "cat second.txt"))
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Review.Decided, { sessionID: root.id, itemID: second!.itemID!, decision: { kind: "permission", reply: "once" } })
  yield* reviews.reconcile
  expect(yield* SessionPending.lookup(db, root.id, SessionReview.promptID(second!.itemID!))).toBeUndefined()
}))

test("the executor origin flag decodes and omits an absent flag", () => {
  const decode = Schema.decodeUnknownSync(SessionReviewSchema.Origin)
  const encode = Schema.encodeSync(SessionReviewSchema.Origin)
  expect(decode({ requestID: "per_executor", executor: true })).toEqual({ requestID: "per_executor", executor: true })
  expect(encode(decode({ requestID: "per_plain" }))).toEqual({ requestID: "per_plain" })
  expect(() => decode({ requestID: "per_bad", executor: false })).toThrow()
})

test("a deferred approval survives a runtime rebuild and is consumed by the retry", async () => {
  await using directory = await tmpdir("ycoding-review-executor-restart-")
  const build = () => reviewLayer(Database.layer({ path: path.join(directory.path, "state.sqlite") }))
  const workspace = path.join(directory.path, "workspace")
  await Bun.write(path.join(workspace, "ycoding.json"), JSON.stringify({ guardrails: { decide_reviews: true } }))
  const location = Location.Ref.make({ directory: AbsolutePath.make(workspace) })
  const saved = await Effect.runPromise(Effect.gen(function* () {
    const { reviews, root, permission } = yield* setupAt(Effect.succeed(location))
    const first = yield* deferPermission(permission, shellInput(root.id))
    yield* reviews.decide({ sessionID: root.id, itemID: first!.itemID!, decision: { kind: "permission", reply: "once" } })
    return root
  }).pipe(Effect.scoped, Effect.provide(build())))
  await Effect.runPromise(Effect.gen(function* () {
    const { permission } = yield* services(saved.location)
    yield* permission.assert(shellInput(saved.id, { processId: "proc_after_restart" })).pipe(Effect.timeout("2 seconds"))
    expect((yield* deferPermission(permission, shellInput(saved.id)))?.state).toBe("open")
  }).pipe(Effect.scoped, Effect.provide(build())))
})
