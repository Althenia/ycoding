import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import os from "node:os"
import path from "node:path"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { CoordinationRuntime } from "../src/session/coordination-runtime"
import { CoordinationService } from "../src/coordination/index"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const running = new Set<SessionSchema.ID>()
const execution = Layer.mock(SessionExecution.Service, {
  active: Effect.sync(() => new Set(running)),
  wake: () => Effect.void,
  interrupt: () => Effect.void,
})
const stack = (database?: ReturnType<typeof Database.layer>) => AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, CoordinationService.node]),
  [[SessionExecution.node, execution], ...(database ? [[Database.node, database] as const] : [])],
)
const it = testEffect(stack())

const makeRuntime = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const coordination = yield* CoordinationService.Service
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  return CoordinationRuntime.make({
    db: database.db, events, coordination, sessions, execution: yield* SessionExecution.Service,
    decisions: { pending: () => Effect.succeed([]) } as never,
    validateModel: () => Effect.void,
    jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set<SessionSchema.ID>()) },
  })
})

let launches = 0
const managedChild = (parentID: SessionSchema.ID, title: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventRuntime.Service
    const child = yield* sessions.create({ parentID, title })
    const launch = ++launches
    yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
      type: "launched", parentID, parentAssistantMessageID: `msg_assignment_parent_${launch}`, toolCallID: `call_assignment_${launch}`,
      inputID: `msg_assignment_child_${launch}`, description: title, agent: "build", model: { providerID: "test", id: "model" },
      promptDigest: "digest", background: true, delivery: "steer",
    } }))
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
    return child
  })

const setup = Effect.gen(function* () {
  running.clear()
  const sessions = yield* Session.Service
  const coordination = yield* CoordinationService.Service
  const events = yield* EventRuntime.Service
  const location = { directory: AbsolutePath.make(os.tmpdir()) }
  const master = yield* sessions.create({ location, title: "master" })
  const alpha = yield* sessions.create({ location, title: "alpha" })
  const beta = yield* sessions.create({ location, title: "beta" })
  const gamma = yield* sessions.create({ location, title: "gamma" })
  const outsider = yield* sessions.create({ location, title: "outsider" })
  const first = yield* managedChild(master.id, "first subagent")
  const second = yield* managedChild(master.id, "second subagent")
  const plainChild = yield* sessions.create({ parentID: master.id, title: "plain child" })
  const memberSubagent = yield* managedChild(alpha.id, "alpha subagent")
  const outsiderSubagent = yield* managedChild(outsider.id, "outsider subagent")
  const group = yield* coordination.create({ name: "Docs", masterSessionID: master.id, memberSessionIDs: [alpha.id, beta.id] })
  yield* coordination.activate(group.id)
  const runtime = yield* makeRuntime
  return { sessions, coordination, events, runtime, group, master, alpha, beta, gamma, outsider, first, second, plainChild, memberSubagent, outsiderSubagent }
})
type Fixture = Effect.Success<typeof setup>

const participantOf = (runtime: Fixture["runtime"], groupID: Coordination.GroupID, sessionID: SessionSchema.ID) =>
  runtime.get(groupID).pipe(Effect.map((info) => [info.master, ...info.members].find((participant) => participant.sessionID === sessionID)))

const ownerOf = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  participantOf(fixture.runtime, fixture.group.id, sessionID).pipe(Effect.map((participant) => participant?.owner))

const ownedBy = (session: { readonly id: SessionSchema.ID; readonly title: string }) => ({ sessionID: session.id, title: session.title })

const refused = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toBeInstanceOf(CoordinationRuntime.RefusedError)
      expect((error as CoordinationRuntime.RefusedError).message.trim().length).toBeGreaterThan(0)
    }),
  )

const restartableDatabase = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir("ycoding-coordination-assignment-")),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )
  return () => stack(Database.layer({ path: path.join(directory.path, "state.sqlite") }))
})

describe("post-approval: project member assignment", () => {
  it.effect("an assigned member reports its supervising owner until it is released", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
      expect(yield* ownerOf(fixture, fixture.beta.id)).toBeUndefined()
      expect(yield* ownerOf(fixture, fixture.master.id)).toBeUndefined()
      yield* fixture.runtime.release(fixture.master.id, { sessionID: fixture.alpha.id, reason: "released" })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()
    }), 30_000)

  it.effect("the owner's turn settling, going idle or failing does not end its assignment", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      running.add(fixture.first.id)
      const succeeded = yield* fixture.events.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.first.id })
      yield* fixture.runtime.handle(succeeded as never)
      running.delete(fixture.first.id)
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
      const completed = yield* fixture.events.publish(SessionEvent.Work.Completed, {
        sessionID: fixture.first.id, inputID: SessionMessage.ID.create(), assistantMessageID: SessionMessage.ID.create(),
      })
      yield* fixture.runtime.handle(completed as never)
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
      const failed = yield* fixture.events.publish(SessionEvent.Execution.Failed, {
        sessionID: fixture.first.id, error: { type: "provider.error", message: "failed" },
      })
      yield* fixture.runtime.handle(failed as never)
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
    }), 30_000)

  it.effect("assigning an owned member to another owner transfers it so it has exactly one owner", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.second.id })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.second))
      yield* refused(fixture.runtime.release(fixture.first.id, { sessionID: fixture.alpha.id, reason: "completed" }))
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.second))
      yield* fixture.runtime.release(fixture.second.id, { sessionID: fixture.alpha.id, reason: "completed" })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()
    }), 30_000)

  it.effect("release with reason completed or released clears the owner; other callers are refused", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* fixture.runtime.release(fixture.first.id, { sessionID: fixture.alpha.id, reason: "completed" })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()

      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.beta.id, ownerSessionID: fixture.second.id })
      yield* fixture.runtime.release(fixture.second.id, { sessionID: fixture.beta.id, reason: "released" })
      expect(yield* ownerOf(fixture, fixture.beta.id)).toBeUndefined()

      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      for (const caller of [fixture.second.id, fixture.alpha.id, fixture.beta.id, fixture.plainChild.id, fixture.memberSubagent.id, fixture.outsider.id])
        for (const reason of ["completed", "released"] as const)
          yield* refused(fixture.runtime.release(caller, { sessionID: fixture.alpha.id, reason }))
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
      yield* fixture.runtime.release(fixture.master.id, { sessionID: fixture.alpha.id, reason: "completed" })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()
    }), 30_000)

  it.effect("only the Master assigns, only to a managed subagent of its family, and only members of its group", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      for (const caller of [fixture.first.id, fixture.plainChild.id, fixture.alpha.id, fixture.memberSubagent.id, fixture.outsider.id])
        yield* refused(fixture.runtime.assign(caller, { sessionID: fixture.alpha.id, ownerSessionID: fixture.second.id }))
      for (const owner of [fixture.plainChild.id, fixture.alpha.id, fixture.beta.id, fixture.memberSubagent.id, fixture.outsider.id, fixture.outsiderSubagent.id])
        yield* refused(fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: owner }))
      for (const sessionID of [fixture.master.id, fixture.gamma.id, fixture.outsider.id, fixture.first.id])
        yield* refused(fixture.runtime.assign(fixture.master.id, { sessionID, ownerSessionID: fixture.first.id }))
      const info = yield* fixture.runtime.get(fixture.group.id)
      expect([info.master, ...info.members].map((participant) => participant.owner)).toEqual([undefined, undefined, undefined])
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.second.id })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.second))
    }), 30_000)

  it.effect("the Master can own a member explicitly and transfer it without granting its executor control", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.master.id })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.master))
      yield* refused(fixture.runtime.send(fixture.first.id, { sessionID: fixture.alpha.id, text: "Not assigned" }))
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* fixture.runtime.send(fixture.first.id, { sessionID: fixture.alpha.id, text: "Assigned" })
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.master.id })
      yield* refused(fixture.runtime.send(fixture.first.id, { sessionID: fixture.alpha.id, text: "Stale owner" }))
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.master))
    }), 30_000)

  it.effect("ownership survives a restart of the runtime over the same database", () =>
    Effect.gen(function* () {
      const restartable = yield* restartableDatabase
      const before = yield* Effect.gen(function* () {
        const fixture = yield* setup
        yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
        yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.beta.id, ownerSessionID: fixture.second.id })
        yield* fixture.runtime.release(fixture.master.id, { sessionID: fixture.beta.id, reason: "released" })
        yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Master-owned work" })
        return { groupID: fixture.group.id, alpha: fixture.alpha.id, beta: fixture.beta.id, first: ownedBy(fixture.first) }
      }).pipe(Effect.scoped, Effect.provide(restartable(), { local: true }))
      yield* Effect.gen(function* () {
        const runtime = yield* makeRuntime
        running.add(before.first.sessionID)
        const alpha = yield* participantOf(runtime, before.groupID, before.alpha)
        expect(alpha?.owner).toEqual(before.first)
        expect(alpha?.drivenBy).toBeUndefined()
        expect((yield* participantOf(runtime, before.groupID, before.beta))?.owner).toBeUndefined()
      }).pipe(Effect.scoped, Effect.provide(restartable(), { local: true }))
    }), 30_000)

  it.effect("a subagent sending a member message never creates ownership", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      running.add(fixture.first.id)
      yield* fixture.runtime.send(fixture.first.id, { sessionID: fixture.alpha.id, text: "Check the alpha docs" })
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Check the beta docs" })
      const alpha = yield* participantOf(fixture.runtime, fixture.group.id, fixture.alpha.id)
      const beta = yield* participantOf(fixture.runtime, fixture.group.id, fixture.beta.id)
      expect(alpha?.owner).toEqual(ownedBy(fixture.first))
      expect(alpha?.drivenBy).toEqual(ownedBy(fixture.first))
      expect(beta?.owner).toBeUndefined()
      expect(beta?.drivenBy).toBeUndefined()
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Master follow-up" })
      expect(yield* ownerOf(fixture, fixture.beta.id)).toBeUndefined()
    }), 30_000)

  it.effect("removing a member from the Project ends its ownership", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.beta.id, ownerSessionID: fixture.second.id })
      const renamed = yield* fixture.coordination.update(fixture.group.id, { revision: fixture.group.revision, name: "Docs v2" })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
      expect(yield* ownerOf(fixture, fixture.beta.id)).toEqual(ownedBy(fixture.second))
      const removed = yield* fixture.coordination.update(fixture.group.id, { revision: renamed.revision, memberSessionIDs: [fixture.alpha.id] })
      expect((yield* fixture.runtime.get(fixture.group.id)).members.map((member) => member.sessionID)).toEqual([fixture.alpha.id])
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
      yield* fixture.coordination.update(fixture.group.id, { revision: removed.revision, memberSessionIDs: [fixture.alpha.id, fixture.beta.id] })
      expect(yield* ownerOf(fixture, fixture.beta.id)).toBeUndefined()
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toEqual(ownedBy(fixture.first))
    }), 30_000)

  it.effect("replacing the Master clears assignments from the former controller family", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* fixture.coordination.update(fixture.group.id, { revision: fixture.group.revision, masterSessionID: fixture.outsider.id })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()
      yield* refused(fixture.runtime.send(fixture.first.id, { sessionID: fixture.alpha.id, text: "Former controller" }))
      expect((yield* fixture.runtime.get(fixture.group.id)).master.sessionID).toBe(fixture.outsider.id)
    }), 30_000)

  it.effect("a member with no assignment has no owner, including members created before ownership existed", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const added = yield* fixture.coordination.update(fixture.group.id, { revision: fixture.group.revision, memberSessionIDs: [fixture.alpha.id, fixture.beta.id, fixture.gamma.id] })
      expect(added.memberSessionIDs).toContain(fixture.gamma.id)
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      const info = yield* fixture.runtime.get(fixture.group.id)
      expect(Object.fromEntries([info.master, ...info.members].map((participant) => [participant.sessionID, participant.owner]))).toEqual({
        [fixture.master.id]: undefined, [fixture.alpha.id]: ownedBy(fixture.first), [fixture.beta.id]: undefined, [fixture.gamma.id]: undefined,
      })
      expect([info.master, ...info.members].filter((participant) => participant.sessionID !== fixture.alpha.id).some((participant) => "owner" in participant)).toBe(false)
      const stored = { sessionID: fixture.beta.id, title: "beta", location: { directory: os.tmpdir() }, state: "idle", lastActivity: 0, pending: [] }
      const legacy = Schema.decodeUnknownSync(Coordination.Participant)(stored)
      expect("owner" in legacy).toBe(false)
      expect(Schema.decodeUnknownSync(Coordination.Participant)({ ...stored, owner: ownedBy(fixture.first) }).owner).toEqual(ownedBy(fixture.first))
    }), 30_000)

  it.effect("deleting the owning Session clears its ownership and leaves the member in the Project", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* fixture.events.publish(SessionEvent.Deleted, { sessionID: fixture.first.id })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()
      expect((yield* fixture.runtime.get(fixture.group.id)).members.map((member) => member.sessionID)).toContain(fixture.alpha.id)
    }), 30_000)
})
