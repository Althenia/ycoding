import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import fs from "node:fs/promises"
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
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionPendingTable, SessionTable } from "../src/session/sql"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"
import { inertRuntime } from "./fixture/coordination-runtime"
import { tmpdir } from "./fixture/tmpdir"

const running = new Set<SessionSchema.ID>()
const execution = Layer.mock(SessionExecution.Service, {
  prepareTask: () => Effect.void,
  active: Effect.sync(() => new Set(running)),
  wake: () => Effect.void,
  interrupt: () => Effect.void,
})
const stack = (database?: ReturnType<typeof Database.layer>) => AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node, CoordinationService.node]),
  [[SessionExecution.node, execution], inertRuntime, ...(database ? [[Database.node, database] as const] : [])],
)
const it = testEffect(stack())

const unavailableModels = new Set<string>()
const makeRuntime = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const coordination = yield* CoordinationService.Service
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  return CoordinationRuntime.make({
    db: database.db, events, coordination, sessions, execution: yield* SessionExecution.Service,
    orchestration: yield* SessionOrchestration.Service,
    decisions: { pending: () => Effect.succeed([]) } as never,
    validateModel: (_sessionID, model) =>
      unavailableModels.has(model.id) ? Effect.fail(new CoordinationRuntime.RefusedError({ message: `Model ${model.id} is not available` })) : Effect.void,
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
  unavailableModels.clear()
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
  const database = yield* Database.Service
  return { db: database.db, sessions, coordination, events, runtime, group, master, alpha, beta, gamma, outsider, first, second, plainChild, memberSubagent, outsiderSubagent }
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

const stale = [
  { name: "cancelling", changes: [{ type: "cancel_requested" }] },
  { name: "cancelled", changes: [{ type: "cancel_requested" }, { type: "cancelled" }] },
  { name: "failed", changes: [{ type: "failed", error: "crashed" }] },
  { name: "lost", changes: [{ type: "lost" }] },
  { name: "archived", changes: [] },
] as const

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
      yield* refused(fixture.runtime.release(fixture.second.id, { sessionID: fixture.alpha.id, reason: "completed" }))
      yield* fixture.runtime.release(fixture.master.id, { sessionID: fixture.alpha.id, reason: "completed" })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()
    }), 30_000)

  it.effect("release with reason completed or released clears the owner; other callers are refused", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* refused(fixture.runtime.release(fixture.first.id, { sessionID: fixture.alpha.id, reason: "completed" }))
      yield* fixture.runtime.release(fixture.master.id, { sessionID: fixture.alpha.id, reason: "completed" })
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()

      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.beta.id, ownerSessionID: fixture.second.id })
      yield* refused(fixture.runtime.release(fixture.second.id, { sessionID: fixture.beta.id, reason: "released" }))
      yield* fixture.runtime.release(fixture.master.id, { sessionID: fixture.beta.id, reason: "released" })
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

  it.effect("assign refuses an owner whose task is cancelling, cancelled, failed or lost, or whose Session is archived", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      for (const state of stale) {
        const owner = yield* managedChild(fixture.master.id, `${state.name} subagent`)
        yield* staleOwner(fixture, owner.id, state)
        yield* refused(fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: owner.id }))
      }
      expect(yield* ownerOf(fixture, fixture.alpha.id)).toBeUndefined()
    }), 30_000)
})

describe("post-approval: test stack isolation", () => {
  it.live("with the Location graph's CoordinationRuntime node inert, a published owner loss leaves the assignment and every inbox unchanged", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.runtime.assign(fixture.master.id, { sessionID: fixture.alpha.id, ownerSessionID: fixture.first.id })
      yield* fixture.events.publish(SessionEvent.Task.Updated, { sessionID: fixture.first.id, change: { type: "lost" } })
      const inboxes = fixture.db.select({ id: SessionPendingTable.id }).from(SessionPendingTable).all().pipe(Effect.orDie, Effect.map((rows) => rows.length))
      const before = yield* inboxes
      for (let attempt = 0; attempt < 20; attempt++) {
        expect([yield* ownerOf(fixture, fixture.alpha.id), yield* inboxes]).toEqual([ownedBy(fixture.first), before])
        yield* Effect.sleep("25 millis")
      }
    }), 30_000)
})

const staleOwner = (fixture: Fixture, ownerSessionID: SessionSchema.ID, state: { readonly name: string; readonly changes: ReadonlyArray<unknown> }) =>
  Effect.gen(function* () {
    for (const change of state.changes)
      yield* fixture.events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: ownerSessionID, change }))
    if (state.name === "archived") yield* fixture.db.run(sql`UPDATE session SET time_archived = 1 WHERE id = ${ownerSessionID}`).pipe(Effect.orDie)
  })

const worktrees = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir("ycoding-coordination-create-")),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )
  const calls: string[] = []
  const create = <E = never>(before: Effect.Effect<void, E> = Effect.void) => (name: string) =>
    Effect.gen(function* () {
      calls.push(name)
      const directory = path.join(root.path, name)
      yield* Effect.promise(() => fs.mkdir(directory))
      yield* before
      return { directory: AbsolutePath.make(directory), branch: name }
    })
  return { root: root.path, calls, create }
})

const sessionCount = Effect.gen(function* () {
  const database = yield* Database.Service
  return (yield* database.db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)).length
})

const ceiling = [{ action: "bash", resource: "*", effect: "deny" as const }]
const agentRules = [
  { action: "webfetch", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "bash", resource: "*", effect: "deny" as const },
]
const unavailable = Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("missing") })

describe("post-approval: project member creation", () => {
  it.effect("the Master creates members in distinct managed worktrees as root Sessions under its ceiling and its agent's deny rules, unowned or owned", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const trees = yield* worktrees
      const database = yield* Database.Service
      yield* database.db.update(SessionTable).set({ permission: ceiling }).where(eq(SessionTable.id, fixture.master.id)).run().pipe(Effect.orDie)
      const plain = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: agentRules, name: "lane-plain" }, trees.create())
      const delegated = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: agentRules, name: "lane-owned", ownerSessionID: fixture.first.id, title: "Owned lane" }, trees.create())
      const mastered = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: agentRules, name: "lane-master", ownerSessionID: fixture.master.id }, trees.create())
      expect(plain).toEqual({ sessionID: plain.sessionID, directory: AbsolutePath.make(path.join(trees.root, "lane-plain")), branch: "lane-plain" })
      expect(delegated).toMatchObject({ directory: path.join(trees.root, "lane-owned"), branch: "lane-owned", owner: ownedBy({ id: fixture.first.id, title: fixture.first.title }) })
      expect(mastered.owner).toEqual(ownedBy(fixture.master))
      expect(new Set([plain.directory, delegated.directory, mastered.directory]).size).toBe(3)
      for (const [result, title] of [[plain, "lane-plain"], [delegated, "Owned lane"], [mastered, "lane-master"]] as const) {
        const member = yield* fixture.sessions.get(result.sessionID)
        expect(member.parentID).toBeUndefined()
        expect(member.location.directory).toBe(AbsolutePath.make(result.directory))
        expect(member.title).toBe(title)
        expect(member.permissionCeiling).toEqual([...ceiling, { action: "webfetch", resource: "*", effect: "deny" }])
      }
      expect(yield* ownerOf(fixture, plain.sessionID)).toBeUndefined()
      expect(yield* ownerOf(fixture, delegated.sessionID)).toEqual(ownedBy(fixture.first))
      expect(yield* ownerOf(fixture, mastered.sessionID)).toEqual(ownedBy(fixture.master))
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs).toEqual(expect.arrayContaining([plain.sessionID, delegated.sessionID, mastered.sessionID]))
    }), 30_000)

  it.effect("the owner is recorded before the optional prompt is admitted with coordination origin", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const trees = yield* worktrees
      const seen: Array<{ readonly type: string; readonly data: unknown }> = []
      const unsubscribe = yield* fixture.events.listen((event) => Effect.sync(() => { seen.push({ type: event.type, data: event.data }) }))
      const result = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-prompt", ownerSessionID: fixture.first.id, prompt: "Implement the lane" }, trees.create())
      yield* unsubscribe
      const member = result.sessionID
      const owned = seen.findIndex((event) => event.type === Coordination.Event.OwnerChanged.type && (event.data as { sessionID: string }).sessionID === member)
      const admitted = seen.findIndex((event) => event.type === SessionEvent.InputAdmitted.type && (event.data as { sessionID: string }).sessionID === member)
      expect(owned).toBeGreaterThan(-1)
      expect(admitted).toBeGreaterThan(owned)
      expect(result.prompt).toMatchObject({ sessionID: member, reconciled: false })
      const database = yield* Database.Service
      const [pending] = yield* database.db.select().from(SessionPendingTable).where(eq(SessionPendingTable.session_id, member)).all().pipe(Effect.orDie)
      expect(pending?.data).toMatchObject({ text: "Implement the lane", metadata: { inputOrigin: "coordination", coordination: { groupID: fixture.group.id, senderSessionID: fixture.master.id } } })
    }), 30_000)

  it.effect("non-Master callers, ineligible or stale owners, unavailable models and a prompt to an inactive Project are refused before any worktree or Session", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const trees = yield* worktrees
      const cancelled = yield* managedChild(fixture.master.id, "cancelled subagent")
      yield* staleOwner(fixture, cancelled.id, stale[1])
      unavailableModels.add("missing")
      const before = yield* sessionCount
      const members = (yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs
      for (const caller of [fixture.first.id, fixture.plainChild.id, fixture.alpha.id, fixture.memberSubagent.id, fixture.outsider.id])
        yield* refused(fixture.runtime.create(caller, { agentPermissions: [], name: "lane-refused" }, trees.create()))
      for (const owner of [fixture.plainChild.id, fixture.alpha.id, fixture.memberSubagent.id, fixture.outsiderSubagent.id, cancelled.id])
        yield* refused(fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-refused", ownerSessionID: owner }, trees.create()))
      yield* refused(fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-refused", model: unavailable }, trees.create()))
      yield* fixture.coordination.pause(fixture.group.id)
      expect(yield* fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-refused", prompt: "Start" }, trees.create()).pipe(Effect.flip, Effect.map((error) => error.message)))
        .toBe(CoordinationRuntime.inactiveMessage)
      expect(trees.calls).toEqual([])
      expect(yield* sessionCount).toBe(before)
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs).toEqual(members)
      const quiet = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-quiet" }, trees.create())
      expect(quiet.prompt).toBeUndefined()
      expect(trees.calls).toEqual(["lane-quiet"])
    }), 30_000)

  it.effect("a worktree refusal, such as an existing name, creates no Session", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const before = yield* sessionCount
      const failure = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-taken" }, () => Effect.fail(new CoordinationRuntime.RefusedError({ message: "A worktree named lane-taken already exists" })))
        .pipe(Effect.flip)
      expect(failure.message).toBe("A worktree named lane-taken already exists")
      expect(yield* sessionCount).toBe(before)
    }), 30_000)

  it.effect("a failure after the worktree exists names its path and branch and keeps the worktree and Session", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const trees = yield* worktrees
      const before = yield* sessionCount
      const failure = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-partial", ownerSessionID: fixture.first.id },
        trees.create(staleOwner(fixture, fixture.first.id, stale[1]))).pipe(Effect.flip)
      const directory = path.join(trees.root, "lane-partial")
      expect(failure.message).toContain(directory)
      expect(failure.message).toContain("lane-partial")
      expect((yield* Effect.promise(() => fs.stat(directory))).isDirectory()).toBe(true)
      expect(yield* sessionCount).toBe(before + 1)
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs).toEqual(fixture.group.memberSessionIDs)
    }), 30_000)

  it.effect("a prompt refused after creation is reported with the created member instead of undoing it", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const trees = yield* worktrees
      yield* fixture.coordination.update(fixture.group.id, { revision: fixture.group.revision, settings: { concurrency: 1 } })
      running.add(fixture.beta.id)
      const result = yield* fixture.runtime.create(fixture.master.id, { agentPermissions: [], name: "lane-busy", prompt: "Start" }, trees.create())
      expect(result.prompt).toEqual({ refused: "Project concurrency limit 1 reached" })
      expect((yield* fixture.coordination.get(fixture.group.id)).memberSessionIDs).toContain(result.sessionID)
    }), 30_000)
})
