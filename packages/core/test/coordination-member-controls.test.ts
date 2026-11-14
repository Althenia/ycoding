import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { LLMClient } from "@ycoding-ai/ai"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Permission } from "@ycoding-ai/schema/permission"
import { Agent } from "../src/agent"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Catalog } from "../src/catalog"
import { Credential } from "../src/credential"
import { CoordinationService } from "../src/coordination/index"
import { CoordinationMemberTable } from "../src/coordination/sql"
import { Database } from "../src/database/database"
import { EventRuntime, versionedType } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Integration } from "../src/integration"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { CatalogModel } from "../src/model"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Provider } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { CoordinationDecisions } from "../src/session/coordination-decisions"
import { CoordinationModel } from "../src/session/coordination-model"
import { CoordinationRuntime } from "../src/session/coordination-runtime"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionStepBoundary } from "../src/session/step-boundary"
import { SessionTable, SessionTaskTable } from "../src/session/sql"
import { fixtureModels } from "./lib/models"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const provider = Provider.ID.make("selection-fixture")
const old = CatalogModel.Ref.make({ providerID: provider, id: CatalogModel.ID.make("original"), variant: CatalogModel.VariantID.make("high") })
const target = CatalogModel.Ref.make({ providerID: provider, id: CatalogModel.ID.make("target") })
const running = new Set<Session.ID>()
const woken: Session.ID[] = []
const interrupted: Session.ID[] = []
let boundaryAttempt: Deferred.Deferred<void> | undefined
const boundaries = Layer.sync(SessionStepBoundary.Service, () => {
  const boundary = SessionStepBoundary.make()
  return SessionStepBoundary.Service.of({
    ...boundary,
    atBoundary: (sessionID, effect) => Effect.suspend(() => boundaryAttempt === undefined
      ? boundary.atBoundary(sessionID, effect)
      : Deferred.succeed(boundaryAttempt, undefined).pipe(Effect.andThen(boundary.atBoundary(sessionID, effect)))),
  })
})
const execution = Layer.mock(SessionExecution.Service, {
  prepareTask: () => Effect.void,
  active: Effect.sync(() => new Set(running)),
  wake: sessionID => Effect.sync(() => { woken.push(sessionID) }),
  interrupt: sessionID => Effect.sync(() => { interrupted.push(sessionID) }),
  withTransition: (_sessionID, effect) => effect,
})
const client = Layer.succeed(LLMClient.Service, LLMClient.Service.of({
  prepare: () => Effect.die("Unexpected provider preparation"),
  stream: () => { throw new Error("Unexpected provider request") },
  generate: () => Effect.die("Unexpected helper request"),
}))
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Database.node, EventRuntime.node, Credential.node, LocationServiceMap.node, Session.node,
  SessionOrchestration.node, SessionExecution.node, SessionStepBoundary.node, CoordinationService.node, CoordinationRuntime.node,
]), [fixtureModels, [SessionExecution.node, execution], [SessionStepBoundary.node, boundaries], [LayerNodePlatform.llmClient, client]]))

const fixture = Effect.fn(function* () {
  running.clear()
  woken.length = 0
  interrupted.length = 0
  boundaryAttempt = undefined
  const directory = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), value => Effect.promise(() => value[Symbol.asyncDispose]()))
  const otherDirectory = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), value => Effect.promise(() => value[Symbol.asyncDispose]()))
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
  const otherLocation = Location.Ref.make({ directory: AbsolutePath.make(otherDirectory.path) })
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const db = (yield* Database.Service).db
  const locations = yield* LocationServiceMap.Service
  const coordination = yield* CoordinationService.Service
  const runtime = yield* CoordinationRuntime.Service
  yield* Effect.gen(function* () {
    const plugins = yield* PluginSupervisor.Service
    yield* plugins.flush
    const catalog = yield* Catalog.Service
    yield* catalog.transform(draft => {
      draft.provider.update(provider, item => { item.package = Provider.aisdk("@ai-sdk/openai") })
      for (const model of [old, target]) draft.model.update(provider, model.id, item => {
        item.limit = { context: 128_000, output: 4096 }
        item.capabilities = { tools: true, input: ["text"], output: ["text"] }
        item.variants = [{ id: CatalogModel.VariantID.make("high") }]
      })
      draft.model.update(provider, CatalogModel.ID.make("tiny"), item => { item.limit = { context: 1, output: 1 } })
    })
    const integrations = yield* Integration.Service
    yield* integrations.transform(draft => draft.update(Integration.ID.make(provider), info => { info.name = "Member selection fixture" }))
  }).pipe(Effect.provide(locations.get(location, [LocationServiceMap.full])))
  const credentials = yield* Credential.Service
  yield* credentials.create({ integrationID: Integration.ID.make(provider), label: "Work", value: Credential.Key.make({ type: "key", key: "synthetic-member-key" }) })
  const master = yield* sessions.create({ location, title: "Master", model: old })
  const member = yield* sessions.create({ location, title: "Member", model: old })
  const peer = yield* sessions.create({ location, title: "Peer", model: old })
  const outsider = yield* sessions.create({ location, title: "Outsider", model: old })
  const owner = yield* sessions.create({ parentID: master.id, title: "Recorded owner", model: old })
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: owner.id, change: {
    type: "launched", parentID: master.id, parentAssistantMessageID: SessionMessage.ID.create(), toolCallID: "member-owner",
    inputID: SessionMessage.ID.create(), description: "Own one member", agent: Agent.ID.make("build"), model: old,
    promptDigest: "synthetic-owner", background: true, delivery: "steer",
  } })
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: owner.id, change: { type: "started" } })
  const group = yield* coordination.create({ name: "Member controls", masterSessionID: master.id, memberSessionIDs: [member.id, peer.id] })
  yield* coordination.setOwner(group.id, { sessionID: member.id, ownerSessionID: owner.id })
  yield* db.update(ProjectTable).set({ worktree: location.directory, name: "Canonical project" }).where(eq(ProjectTable.id, master.projectID)).run().pipe(Effect.orDie)
  return { sessions, events, db, locations, coordination, runtime, master, member, peer, outsider, owner, group, location, otherLocation }
})

const unchangedExecution = () => {
  expect(woken).toEqual([])
  expect(interrupted).toEqual([])
}

type Fixture = Effect.Success<ReturnType<typeof fixture>>

const changedEvents = (f: Fixture) => f.db.select().from(EventTable)
  .where(and(eq(EventTable.aggregate_id, f.group.id), eq(EventTable.type, versionedType(Coordination.Event.Changed.type, Coordination.Event.Changed.durable.version))))
  .orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
const memberRow = (f: Fixture, sessionID: Session.ID) => f.db.select().from(CoordinationMemberTable)
  .where(and(eq(CoordinationMemberTable.group_id, f.group.id), eq(CoordinationMemberTable.session_id, sessionID))).get().pipe(Effect.orDie)
const sessionRow = (f: Fixture, sessionID: Session.ID) => f.db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
const taskState = (f: Fixture, sessionID: Session.ID) => f.db.select({ state: SessionTaskTable.state }).from(SessionTaskTable)
  .where(eq(SessionTaskTable.session_id, sessionID)).get().pipe(Effect.orDie, Effect.map(row => row?.state))

const membership = Effect.fn(function* (f: Fixture) {
  const group = yield* f.coordination.get(f.group.id)
  const rows = yield* f.db.select().from(CoordinationMemberTable).where(eq(CoordinationMemberTable.group_id, f.group.id))
    .orderBy(asc(CoordinationMemberTable.session_id)).all().pipe(Effect.orDie)
  return { revision: group.revision, updated: group.time.updated, members: group.memberSessionIDs, rows, changes: (yield* changedEvents(f)).length }
})

const masterOnly = "Only the Project's Master removes member Sessions"
const busy = (sessionID: Session.ID) => `Session ${sessionID} has active work or pending requests; wait for it to settle or interrupt it before removing it from the Project`

const refusedWithoutDetach = Effect.fn(function* (f: Fixture, removal: Effect.Effect<unknown, unknown>, message?: string) {
  const before = yield* membership(f)
  const error = yield* Effect.flip(removal)
  expect(error).toBeInstanceOf(CoordinationRuntime.RefusedError)
  if (message !== undefined) expect(error).toMatchObject({ message })
  expect(yield* membership(f)).toEqual(before)
})

const queueInput = (f: Fixture, sessionID: Session.ID) => f.events.publish(SessionEvent.InputAdmitted, {
  sessionID, inputID: SessionMessage.ID.create(),
  input: { type: "user", delivery: "queue", data: { text: "Queued work", metadata: { inputOrigin: "direct" } } },
})

const launchUnder = Effect.fn(function* (f: Fixture, parentID: Session.ID) {
  const child = yield* f.sessions.create({ parentID, title: "Background worker", model: old })
  yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: {
    type: "launched", parentID, parentAssistantMessageID: SessionMessage.ID.create(), toolCallID: `worker-${child.id}`,
    inputID: SessionMessage.ID.create(), description: "Background worker", agent: Agent.ID.make("build"), model: old,
    promptDigest: "synthetic-worker", background: true, delivery: "steer",
  } })
  yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
  return child
})

const withPending = Effect.fn(function* (f: Fixture, requests: ReadonlyArray<CoordinationDecisions.PendingSnapshot>) {
  return CoordinationRuntime.make({
    db: f.db, events: f.events, coordination: f.coordination, sessions: f.sessions,
    execution: yield* SessionExecution.Service, orchestration: yield* SessionOrchestration.Service,
    decisions: {
      pending: input => Effect.succeed(requests.filter(item => item.kind === "permission" &&
        [input.targetSessionID, ...(input.descendantSessionIDs ?? [])].includes(item.request.sessionID))),
      evaluate: () => Effect.die("Unexpected decision evaluation"),
      escalate: () => Effect.die("Unexpected escalation"),
    },
    validateModel: () => Effect.void,
    jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set<Session.ID>()) },
  })
})

const permissionRequest = (id: string, sessionID: Session.ID): CoordinationDecisions.PendingSnapshot => ({
  kind: "permission", request: { id: Permission.ID.make(id), sessionID, action: "edit", resources: ["src/a.ts"] }, fingerprint: `fp_${id}`,
})

describe("canonical project member creation", () => {
  it.effect("creates a root at the selected canonical directory and returns its saved selection", () => Effect.gen(function* () {
    const f = yield* fixture()
    const id = Session.ID.create()
    const model = CatalogModel.Ref.make({ ...target, profile: "Work" })
    const result = yield* f.runtime.create(f.master.id, { id, projectID: f.master.projectID, model, agentPermissions: [] }, () => Effect.die("Canonical creation must not create a worktree"))
    const saved = yield* f.sessions.get(id)
    expect(result).toMatchObject({ sessionID: id, location: f.location, directory: f.location.directory, model, enrollment: { groupID: f.group.id, member: true } })
    expect(result).not.toHaveProperty("branch")
    expect(saved.parentID).toBeUndefined()
    expect(saved.title).toBe("Canonical project")
    expect(saved.location).toEqual(f.location)
    expect(saved.model).toEqual(model)
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs).toContain(id)
    unchangedExecution()
  }))

  it.effect("keeps explicit worktree creation and reconciles its stable Session identity before repeating the callback", () => Effect.gen(function* () {
    const f = yield* fixture()
    const id = Session.ID.create()
    let creations = 0
    const createWorktree = () => Effect.sync(() => {
      creations++
      return { directory: f.otherLocation.directory, branch: "member-lane" }
    })
    const input = { id, name: "member-lane", model: old, title: "Explicit member", agentPermissions: [] }
    const first = yield* f.runtime.create(f.master.id, input, createWorktree)
    const second = yield* f.runtime.create(f.master.id, input, createWorktree)
    expect(first).toMatchObject({ sessionID: id, directory: f.otherLocation.directory, location: f.otherLocation, branch: "member-lane", model: old, enrollment: { member: true } })
    expect(second.sessionID).toBe(id)
    expect(creations).toBe(1)
    expect((yield* f.sessions.get(id)).parentID).toBeUndefined()
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs.filter(value => value === id)).toHaveLength(1)
    unchangedExecution()
  }))

  it.effect("rejects a missing Project or unavailable canonical directory without creating a Session", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const projectID of [Project.ID.make("missing-project"), f.master.projectID]) {
      if (projectID === f.master.projectID) yield* f.db.update(ProjectTable).set({ worktree: AbsolutePath.make(`${f.location.directory}/missing`) }).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie)
      const id = Session.ID.create()
      expect((yield* Effect.exit(f.runtime.create(f.master.id, { id, projectID, model: old, agentPermissions: [] }, () => Effect.die("Unexpected worktree"))))._tag).toBe("Failure")
      expect((yield* Effect.exit(f.sessions.get(id)))._tag).toBe("Failure")
    }
    unchangedExecution()
  }))

  it.effect("reconciles an already-created canonical Session and rejects conflicting placement", () => Effect.gen(function* () {
    const f = yield* fixture()
    const existing = yield* f.sessions.create({ location: f.location, model: old, title: "Creation already committed" })
    const result = yield* f.runtime.create(f.master.id, { id: existing.id, projectID: f.master.projectID, model: old, agentPermissions: [] })
    expect(result).toMatchObject({ sessionID: existing.id, location: f.location, enrollment: { member: true } })
    const foreign = yield* f.sessions.create({ location: f.otherLocation, model: old })
    expect((yield* Effect.exit(f.runtime.create(f.master.id, { id: foreign.id, projectID: f.master.projectID, model: old, agentPermissions: [] })))._tag).toBe("Failure")
    expect((yield* f.sessions.get(foreign.id)).location).toEqual(f.otherLocation)
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs).not.toContain(foreign.id)
    unchangedExecution()
  }))

  it.effect("returns the actual Session receipt when enrollment fails", () => Effect.gen(function* () {
    const f = yield* fixture()
    const existing = yield* f.sessions.create({ location: f.location, model: old, title: "Archived before enrollment" })
    yield* f.events.publish(SessionEvent.Archived, { sessionID: existing.id })
    const result = yield* f.runtime.create(f.master.id, { id: existing.id, projectID: f.master.projectID, model: old, agentPermissions: [] })
    expect(result).toMatchObject({ sessionID: existing.id, location: f.location, model: old, enrollment: { groupID: f.group.id, member: false } })
    expect(result.enrollment.error).toEqual(expect.any(String))
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs).not.toContain(existing.id)
    expect((yield* f.sessions.get(existing.id)).time.archived).toBeDefined()
    unchangedExecution()
  }))
})

describe("persistent project member selection", () => {
  it.effect("reads exact saved selection only for the Master and recorded owner", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const caller of [f.master.id, f.owner.id]) expect(yield* f.runtime.member(caller, { sessionID: f.member.id })).toMatchObject({ sessionID: f.member.id, location: f.location, model: old, owner: { sessionID: f.owner.id } })
    for (const caller of [f.peer.id, f.member.id, f.outsider.id]) expect((yield* Effect.exit(f.runtime.member(caller, { sessionID: f.member.id })))._tag).toBe("Failure")
    expect((yield* Effect.exit(f.runtime.member(f.master.id, { sessionID: f.outsider.id })))._tag).toBe("Failure")
    unchangedExecution()
  }))

  it.effect("replaces the whole saved reference and returns confirmed model and profile readback", () => Effect.gen(function* () {
    const f = yield* fixture()
    const named = CatalogModel.Ref.make({ ...old, profile: "Work" })
    expect((yield* f.runtime.setModel(f.owner.id, { sessionID: f.member.id, expectedModel: old, model: named })).model).toEqual(named)
    expect((yield* f.runtime.member(f.master.id, { sessionID: f.member.id })).model).toEqual(named)
    expect((yield* f.db.select({ binding: SessionTable.profile_binding }).from(SessionTable).where(eq(SessionTable.id, f.member.id)).get().pipe(Effect.orDie))?.binding).toMatchObject({ providerID: provider, profile: "Work" })
    expect((yield* f.runtime.setModel(f.master.id, { sessionID: f.member.id, expectedModel: named, model: target })).model).toEqual(target)
    expect((yield* f.sessions.get(f.member.id)).model).toEqual(target)
    expect((yield* f.db.select({ binding: SessionTable.profile_binding }).from(SessionTable).where(eq(SessionTable.id, f.member.id)).get().pipe(Effect.orDie))?.binding).toBeNull()
    expect((yield* f.sessions.pending(f.member.id))).toEqual([])
    unchangedExecution()
  }))

  it.effect("supports null compare-and-set only when no model is stored", () => Effect.gen(function* () {
    const f = yield* fixture()
    const unset = yield* f.sessions.create({ location: f.location, title: "No saved selection" })
    yield* f.coordination.addMember(f.group.id, { sessionID: unset.id })
    expect((yield* f.runtime.member(f.master.id, { sessionID: unset.id })).model).toBeNull()
    expect((yield* f.runtime.setModel(f.master.id, { sessionID: unset.id, expectedModel: null, model: target })).model).toEqual(target)
    expect((yield* Effect.exit(f.runtime.setModel(f.master.id, { sessionID: unset.id, expectedModel: null, model: old })))._tag).toBe("Failure")
    expect((yield* f.sessions.get(unset.id)).model).toEqual(target)
    unchangedExecution()
  }))

  it.effect("rejects unauthorized writes, stale references and invalid targets without changing execution", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const caller of [f.peer.id, f.member.id, f.outsider.id]) expect((yield* Effect.exit(f.runtime.setModel(caller, { sessionID: f.member.id, expectedModel: old, model: target })))._tag).toBe("Failure")
    for (const expectedModel of [target, CatalogModel.Ref.make({ ...old, variant: undefined }), CatalogModel.Ref.make({ ...old, profile: "Work" })])
      expect((yield* Effect.exit(f.runtime.setModel(f.master.id, { sessionID: f.member.id, expectedModel, model: target })))._tag).toBe("Failure")
    for (const model of [
      CatalogModel.Ref.make({ ...target, profile: "Unavailable" }),
      CatalogModel.Ref.make({ ...target, id: CatalogModel.ID.make("missing") }),
      CatalogModel.Ref.make({ ...target, variant: CatalogModel.VariantID.make("missing") }),
      CatalogModel.Ref.make({ ...target, id: CatalogModel.ID.make("tiny") }),
    ]) expect((yield* Effect.exit(f.runtime.setModel(f.master.id, { sessionID: f.member.id, expectedModel: old, model })))._tag).toBe("Failure")
    expect((yield* f.sessions.get(f.member.id)).model).toEqual(old)
    unchangedExecution()
  }))

  it.effect("does not confuse a temporary send model with the stored selection", () => Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.coordination.activate(f.group.id)
    const sent = yield* f.runtime.send(f.master.id, { sessionID: f.member.id, text: "One queued input", model: target })
    expect((yield* f.runtime.member(f.master.id, { sessionID: f.member.id })).model).toEqual(old)
    yield* f.events.publish(SessionEvent.InputPromoted, { sessionID: f.member.id, inputID: sent.messageID })
    expect(yield* CoordinationModel.override(f.db, f.member.id)).toEqual(target)
    const wakeCount = woken.length
    expect((yield* Effect.exit(f.runtime.setModel(f.master.id, { sessionID: f.member.id, expectedModel: old, model: target })))._tag).toBe("Failure")
    expect((yield* f.sessions.get(f.member.id)).model).toEqual(old)
    expect(woken).toHaveLength(wakeCount)
    expect(interrupted).toEqual([])
  }))

  it.effect("waits for the active Step boundary without interrupting or waking the member", () => Effect.gen(function* () {
    const f = yield* fixture()
    const boundary = yield* SessionStepBoundary.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const step = yield* boundary.withStep(f.member.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    running.add(f.member.id)
    boundaryAttempt = yield* Deferred.make<void>()
    const selection = yield* f.runtime.setModel(f.master.id, { sessionID: f.member.id, expectedModel: old, model: target }).pipe(Effect.forkChild)
    yield* Effect.raceFirst(Deferred.await(boundaryAttempt), Fiber.join(selection).pipe(Effect.flatMap(() => Effect.die("Selection settled before the Step boundary"))))
    expect((yield* f.sessions.get(f.member.id)).model).toEqual(old)
    unchangedExecution()
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(step)
    expect((yield* Fiber.join(selection)).model).toEqual(target)
    expect(running.has(f.member.id)).toBe(true)
    unchangedExecution()
  }).pipe(Effect.timeout("10 seconds")))

  it.effect("rechecks recorded ownership and archive state after the active Step settles", () => Effect.gen(function* () {
    const f = yield* fixture()
    const boundary = yield* SessionStepBoundary.Service
    for (const change of ["owner", "archive"] as const) {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const step = yield* boundary.withStep(f.member.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      boundaryAttempt = yield* Deferred.make<void>()
      const selection = yield* Effect.exit(f.runtime.setModel(f.owner.id, { sessionID: f.member.id, expectedModel: old, model: target })).pipe(Effect.forkChild)
      yield* Effect.raceFirst(Deferred.await(boundaryAttempt), Fiber.join(selection).pipe(Effect.flatMap(() => Effect.die("Selection settled before the Step boundary"))))
      if (change === "owner") yield* f.coordination.setOwner(f.group.id, { sessionID: f.member.id, ownerSessionID: f.master.id })
      if (change === "archive") yield* f.events.publish(SessionEvent.Archived, { sessionID: f.member.id })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(step)
      expect((yield* Fiber.join(selection))._tag).toBe("Failure")
      expect((yield* f.sessions.get(f.member.id)).model).toEqual(old)
      if (change === "owner") yield* f.coordination.setOwner(f.group.id, { sessionID: f.member.id, ownerSessionID: f.owner.id })
    }
    unchangedExecution()
  }).pipe(Effect.timeout("10 seconds")))

  it.effect("rejects a changed private binding at the boundary even when the visible model is unchanged", () => Effect.gen(function* () {
    const f = yield* fixture()
    const named = CatalogModel.Ref.make({ ...old, profile: "Work" })
    yield* f.runtime.setModel(f.master.id, { sessionID: f.member.id, expectedModel: old, model: named })
    const binding = (yield* f.db.select({ value: SessionTable.profile_binding }).from(SessionTable).where(eq(SessionTable.id, f.member.id)).get().pipe(Effect.orDie))?.value
    if (!binding) return yield* Effect.die("Named selection did not save its binding")
    const boundary = yield* SessionStepBoundary.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const step = yield* boundary.withStep(f.member.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    boundaryAttempt = yield* Deferred.make<void>()
    const selection = yield* Effect.exit(f.runtime.setModel(f.master.id, { sessionID: f.member.id, expectedModel: named, model: target })).pipe(Effect.forkChild)
    yield* Effect.raceFirst(Deferred.await(boundaryAttempt), Fiber.join(selection).pipe(Effect.flatMap(() => Effect.die("Selection settled before the Step boundary"))))
    yield* f.events.publish(SessionEvent.ProfileBound, { sessionID: f.member.id, binding: { ...binding, accountGeneration: binding.accountGeneration + 1 } })
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(step)
    expect((yield* Fiber.join(selection))._tag).toBe("Failure")
    expect((yield* f.sessions.get(f.member.id)).model).toEqual(named)
    unchangedExecution()
    return undefined
  }).pipe(Effect.timeout("10 seconds")))

  it.effect("rejects child Sessions as Project members without changing their model or execution", () => Effect.gen(function* () {
    const f = yield* fixture()
    const managed = yield* f.sessions.create({ parentID: f.master.id, title: "Managed target", model: old })
    yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: managed.id, change: {
      type: "launched", parentID: f.master.id, parentAssistantMessageID: SessionMessage.ID.create(), toolCallID: "managed-member",
      inputID: SessionMessage.ID.create(), description: "Managed member", agent: Agent.ID.make("build"), model: old,
      promptDigest: "synthetic-managed-member", background: true, delivery: "steer",
    } })
    expect((yield* Effect.exit(f.coordination.addMember(f.group.id, { sessionID: managed.id })))._tag).toBe("Failure")
    expect((yield* Effect.exit(f.runtime.setModel(f.master.id, { sessionID: managed.id, expectedModel: old, model: target })))._tag).toBe("Failure")
    expect((yield* f.sessions.get(managed.id)).model).toEqual(old)
    unchangedExecution()
  }))
})

describe("project member detach", () => {
  it.effect("detaches settled idle, completed and failed members, returning a removal receipt and leaving each Session and its history intact", () => Effect.gen(function* () {
    const f = yield* fixture()
    const completed = yield* f.sessions.create({ location: f.location, title: "Completed member", model: old })
    const failed = yield* f.sessions.create({ location: f.location, title: "Failed member", model: old })
    yield* f.coordination.addMember(f.group.id, { sessionID: completed.id })
    yield* f.coordination.addMember(f.group.id, { sessionID: failed.id })
    yield* f.events.publish(SessionEvent.Execution.Succeeded, { sessionID: completed.id })
    yield* f.events.publish(SessionEvent.Execution.Failed, { sessionID: failed.id, error: { type: "provider.error", message: "Synthetic failure" } })
    const detached = [f.peer.id, completed.id, failed.id]
    const states = (yield* f.runtime.get(f.group.id)).members
    expect(detached.map(id => states.find(member => member.sessionID === id)?.state)).toEqual(["idle", "idle", "failed"])
    for (const sessionID of detached) {
      const before = yield* f.coordination.get(f.group.id)
      const session = yield* sessionRow(f, sessionID)
      const history = yield* f.events.sequences([sessionID])
      const changes = (yield* changedEvents(f)).length
      expect(yield* f.runtime.remove(f.master.id, { sessionID })).toEqual({ sessionID, removed: true })
      const after = yield* f.coordination.get(f.group.id)
      expect(Number(after.revision)).toBe(Number(before.revision) + 1)
      expect(after.time.updated).toBeGreaterThanOrEqual(before.time.updated)
      expect(after.memberSessionIDs).toEqual(before.memberSessionIDs.filter(id => id !== sessionID))
      const recorded = yield* changedEvents(f)
      expect(recorded).toHaveLength(changes + 1)
      expect(recorded.at(-1)?.data).toMatchObject({ groupID: f.group.id, revision: after.revision, memberSessionIDs: after.memberSessionIDs })
      expect(yield* f.coordination.memberOf(sessionID)).toBeUndefined()
      expect(yield* memberRow(f, sessionID)).toBeUndefined()
      expect(yield* sessionRow(f, sessionID)).toEqual(session)
      expect(yield* f.events.sequences([sessionID])).toEqual(history)
      expect((yield* f.sessions.get(sessionID)).time.archived).toBeUndefined()
    }
    expect(yield* memberRow(f, f.member.id)).toMatchObject({ owner_session_id: f.owner.id })
    expect(woken.filter(id => detached.includes(id))).toEqual([])
    expect(interrupted).toEqual([])
  }))

  it.effect("completes a settled supervisor only after its last owned member is detached", () => Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.coordination.setOwner(f.group.id, { sessionID: f.peer.id, ownerSessionID: f.owner.id })
    const orchestration = yield* SessionOrchestration.Service
    yield* orchestration.settle(f.owner.id, { type: "completed" })
    expect(yield* taskState(f, f.owner.id)).toBe("supervising")
    expect(yield* f.runtime.remove(f.master.id, { sessionID: f.member.id })).toEqual({ sessionID: f.member.id, removed: true })
    expect(yield* taskState(f, f.owner.id)).toBe("supervising")
    expect(yield* memberRow(f, f.peer.id)).toMatchObject({ owner_session_id: f.owner.id })
    expect(yield* f.runtime.remove(f.master.id, { sessionID: f.peer.id })).toEqual({ sessionID: f.peer.id, removed: true })
    expect(yield* taskState(f, f.owner.id)).toBe("completed")
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs).toEqual([])
    expect(interrupted).toEqual([])
  }))

  it.effect("lets only the Project's Master detach a current member", () => Effect.gen(function* () {
    const f = yield* fixture()
    const executor = yield* f.sessions.create({ parentID: f.owner.id, title: "Owner executor", model: old })
    for (const caller of [f.owner.id, executor.id, f.peer.id, f.member.id, f.outsider.id])
      yield* refusedWithoutDetach(f, f.runtime.remove(caller, { sessionID: f.member.id }), masterOnly)
    for (const sessionID of [f.outsider.id, f.master.id, f.owner.id])
      yield* refusedWithoutDetach(f, f.runtime.remove(f.master.id, { sessionID }))
    expect(yield* f.runtime.remove(f.master.id, { sessionID: f.member.id })).toEqual({ sessionID: f.member.id, removed: true })
    yield* refusedWithoutDetach(f, f.runtime.remove(f.master.id, { sessionID: f.member.id }))
    unchangedExecution()
  }))

  it.effect("refuses a running, queued or background-working member without detaching it", () => Effect.gen(function* () {
    const f = yield* fixture()
    running.add(f.peer.id)
    yield* refusedWithoutDetach(f, f.runtime.remove(f.master.id, { sessionID: f.peer.id }), busy(f.peer.id))
    running.delete(f.peer.id)
    const queued = yield* f.sessions.create({ location: f.location, title: "Queued member", model: old })
    yield* f.coordination.addMember(f.group.id, { sessionID: queued.id })
    yield* queueInput(f, queued.id)
    expect(yield* f.sessions.pending(queued.id)).toHaveLength(1)
    yield* refusedWithoutDetach(f, f.runtime.remove(f.master.id, { sessionID: queued.id }), busy(queued.id))
    const delegating = yield* f.sessions.create({ location: f.location, title: "Member with a background task", model: old })
    yield* f.coordination.addMember(f.group.id, { sessionID: delegating.id })
    yield* launchUnder(f, delegating.id)
    yield* refusedWithoutDetach(f, f.runtime.remove(f.master.id, { sessionID: delegating.id }), busy(delegating.id))
    const parent = yield* f.sessions.create({ location: f.location, title: "Member with a running descendant", model: old })
    yield* f.coordination.addMember(f.group.id, { sessionID: parent.id })
    const descendant = yield* f.sessions.create({ parentID: parent.id, title: "Running descendant", model: old })
    running.add(descendant.id)
    yield* refusedWithoutDetach(f, f.runtime.remove(f.master.id, { sessionID: parent.id }), busy(parent.id))
    running.delete(descendant.id)
    expect(yield* f.runtime.remove(f.master.id, { sessionID: f.peer.id })).toEqual({ sessionID: f.peer.id, removed: true })
    unchangedExecution()
  }))

  it.effect("refuses a member while its own or a deep descendant's request is pending, then detaches it once the request settles", () => Effect.gen(function* () {
    const f = yield* fixture()
    const child = yield* f.sessions.create({ parentID: f.peer.id, title: "Member child", model: old })
    const grandchild = yield* f.sessions.create({ parentID: child.id, title: "Member grandchild", model: old })
    const unrelated = permissionRequest("per_unrelated", f.outsider.id)
    const requests = [unrelated]
    const runtime = yield* withPending(f, requests)
    for (const request of [permissionRequest("per_member", f.peer.id), permissionRequest("per_grandchild", grandchild.id)]) {
      requests.push(request)
      yield* refusedWithoutDetach(f, runtime.remove(f.master.id, { sessionID: f.peer.id }), busy(f.peer.id))
      requests.splice(1)
    }
    expect(requests).toEqual([unrelated])
    expect(yield* runtime.remove(f.master.id, { sessionID: f.peer.id })).toEqual({ sessionID: f.peer.id, removed: true })
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs).toEqual([f.member.id])
    unchangedExecution()
  }))

  it.effect("rechecks member work after waiting for the Project ownership fence", () => Effect.gen(function* () {
    const f = yield* fixture()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const attempted = yield* Deferred.make<void>()
    const holder = yield* f.coordination.withOwnership(f.group.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const removal = yield* Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.flip(f.runtime.remove(f.master.id, { sessionID: f.peer.id }))), Effect.forkChild)
    yield* Deferred.await(attempted)
    yield* queueInput(f, f.peer.id)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    expect(yield* Fiber.join(removal)).toMatchObject({ message: busy(f.peer.id) })
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs).toContain(f.peer.id)
    expect(yield* memberRow(f, f.peer.id)).toBeDefined()
    unchangedExecution()
  }).pipe(Effect.timeout("10 seconds")))
})

describe("project member removal ownership fence", () => {
  it.effect("direct service removal waits behind another holder and then removes the member", () => Effect.gen(function* () {
    const f = yield* fixture()
    const before = yield* membership(f)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const attempted = yield* Deferred.make<void>()
    const holder = yield* f.coordination.withOwnership(f.group.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const removal = yield* Deferred.succeed(attempted, undefined).pipe(Effect.andThen(f.coordination.removeMember(f.group.id, { sessionID: f.peer.id })), Effect.forkChild)
    yield* Deferred.await(attempted)
    yield* Effect.yieldNow
    expect(yield* membership(f)).toEqual(before)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    expect((yield* Fiber.join(removal)).memberSessionIDs).toEqual([f.member.id])
    expect(yield* memberRow(f, f.peer.id)).toBeUndefined()
    unchangedExecution()
  }).pipe(Effect.timeout("10 seconds")))

  it.effect("a holder removes members through the service on the same fiber without waiting on its own fence", () => Effect.gen(function* () {
    const f = yield* fixture()
    const changes = (yield* changedEvents(f)).length
    const group = yield* f.coordination.withOwnership(f.group.id, f.coordination.removeMember(f.group.id, { sessionID: f.peer.id }).pipe(
      Effect.andThen(f.coordination.withOwnership(f.group.id, f.coordination.removeMember(f.group.id, { sessionID: f.member.id }))),
    ))
    expect(group.memberSessionIDs).toEqual([])
    expect(yield* changedEvents(f)).toHaveLength(changes + 2)
    unchangedExecution()
  }).pipe(Effect.timeout("10 seconds")))

  it.effect("a fiber forked inside the fence waits for a later holder after the fenced region ends", () => Effect.gen(function* () {
    const f = yield* fixture()
    const before = yield* membership(f)
    const go = yield* Deferred.make<void>()
    const attempted = yield* Deferred.make<void>()
    const leaked = yield* f.coordination.withOwnership(f.group.id, Deferred.await(go).pipe(
      Effect.andThen(Deferred.succeed(attempted, undefined)),
      Effect.andThen(f.coordination.removeMember(f.group.id, { sessionID: f.peer.id })),
      Effect.forkDetach,
    ))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const holder = yield* f.coordination.withOwnership(f.group.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Deferred.succeed(go, undefined)
    yield* Deferred.await(attempted)
    yield* Effect.yieldNow
    expect(yield* membership(f)).toEqual(before)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    expect((yield* Fiber.join(leaked)).memberSessionIDs).toEqual([f.member.id])
    unchangedExecution()
  }).pipe(Effect.timeout("10 seconds")))

  it.effect("an interrupted holder releases the fence so the next removal proceeds", () => Effect.gen(function* () {
    const f = yield* fixture()
    const entered = yield* Deferred.make<void>()
    const holder = yield* f.coordination.withOwnership(f.group.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(holder)
    expect((yield* f.coordination.removeMember(f.group.id, { sessionID: f.peer.id })).memberSessionIDs).toEqual([f.member.id])
    expect(yield* f.runtime.remove(f.master.id, { sessionID: f.member.id })).toEqual({ sessionID: f.member.id, removed: true })
    expect((yield* f.coordination.get(f.group.id)).memberSessionIDs).toEqual([])
    unchangedExecution()
  }).pipe(Effect.timeout("10 seconds")))
})
