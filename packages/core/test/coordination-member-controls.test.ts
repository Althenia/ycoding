import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { LLMClient } from "@ycoding-ai/ai"
import { Agent } from "../src/agent"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Catalog } from "../src/catalog"
import { Credential } from "../src/credential"
import { CoordinationService } from "../src/coordination/index"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
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
import { CoordinationModel } from "../src/session/coordination-model"
import { CoordinationRuntime } from "../src/session/coordination-runtime"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionStepBoundary } from "../src/session/step-boundary"
import { SessionTable } from "../src/session/sql"
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
