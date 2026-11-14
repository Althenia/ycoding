import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CoordinationRuntime } from "../src/session/coordination-runtime"
import { CoordinationService } from "../src/coordination/index"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { Session } from "../src/session"
import { SessionAutonomy } from "../src/session/autonomy"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionOrchestration } from "../src/session/orchestration"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"
import { inertRuntime } from "./fixture/coordination-runtime"
import { tmpdir } from "./fixture/tmpdir"

const execution = Layer.mock(SessionExecution.Service, {
  active: Effect.sync(() => new Set<SessionSchema.ID>()),
  wake: () => Effect.void,
  interrupt: () => Effect.void,
})
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node, SessionAutonomy.node, CoordinationService.node]),
  [[SessionExecution.node, execution], inertRuntime],
))

const masterModes = { permissions: "auto", guardrails: "auto", answers: "yolo" } as const

const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const autonomy = yield* SessionAutonomy.Service
  const coordination = yield* CoordinationService.Service
  const location = { directory: AbsolutePath.make(os.tmpdir()) }
  const master = yield* sessions.create({ location, title: "master" })
  const alpha = yield* sessions.create({ location, title: "alpha" })
  const beta = yield* sessions.create({ location, title: "beta" })
  const gamma = yield* sessions.create({ location, title: "gamma" })
  return { sessions, autonomy, coordination, master, alpha, beta, gamma }
})

const modesOf = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const autonomy = yield* SessionAutonomy.Service
    return yield* autonomy.effectiveDecisions(sessionID)
  })

const makeRuntime = Effect.gen(function* () {
  const database = yield* Database.Service
  return CoordinationRuntime.make({
    db: database.db,
    events: yield* EventRuntime.Service,
    coordination: yield* CoordinationService.Service,
    sessions: yield* Session.Service,
    execution: yield* SessionExecution.Service,
    orchestration: yield* SessionOrchestration.Service,
    decisions: { pending: () => Effect.succeed([]) } as never,
    validateModel: () => Effect.void,
    jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set<SessionSchema.ID>()) },
  })
})

const worktree = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir("ycoding-member-autonomy-")),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )
  return (name: string) =>
    Effect.promise(() => fs.mkdir(path.join(root.path, name))).pipe(
      Effect.as({ directory: AbsolutePath.make(path.join(root.path, name)), branch: name }),
    )
})

const managedChild = (parentID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventRuntime.Service
    const child = yield* sessions.create({ parentID, title: "member subagent" })
    yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
      type: "launched", parentID, parentAssistantMessageID: "msg_member_autonomy_parent", toolCallID: "call_member_autonomy",
      inputID: "msg_member_autonomy_child", description: "member subagent", agent: "build", model: { providerID: "test", id: "model" },
      promptDigest: "digest", background: true, delivery: "steer",
    } }))
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
    return child
  })

describe("Project members take the Master's autonomy modes on joining", () => {
  it.effect("a member created by the Master starts with the Master's effective modes", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const group = yield* fixture.coordination.create({ name: "Docs", masterSessionID: fixture.master.id, memberSessionIDs: [] })
      yield* fixture.autonomy.set({ sessionID: fixture.master.id, ...masterModes })
      const runtime = yield* makeRuntime
      const created = yield* runtime.create(fixture.master.id, { id: Session.ID.create(), agentPermissions: [], name: "lane-member" }, yield* worktree)
      expect((yield* fixture.coordination.get(group.id)).memberSessionIDs).toContain(created.sessionID)
      expect(yield* modesOf(created.sessionID)).toEqual({ ...masterModes, inherited: {} })
    }), 30_000)

  it.effect("updating a Project gives only newly added members the Master's modes and keeps an existing member's later choice", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const group = yield* fixture.coordination.create({ name: "Docs", masterSessionID: fixture.master.id, memberSessionIDs: [fixture.alpha.id] })
      yield* fixture.autonomy.set({ sessionID: fixture.master.id, ...masterModes })
      const added = yield* fixture.coordination.update(group.id, { revision: group.revision, memberSessionIDs: [fixture.alpha.id, fixture.beta.id] })
      expect(yield* modesOf(fixture.beta.id)).toEqual({ ...masterModes, inherited: {} })
      expect(yield* modesOf(fixture.alpha.id)).toEqual({ permissions: "manual", guardrails: "manual", answers: "manual", inherited: {} })
      yield* fixture.autonomy.set({ sessionID: fixture.beta.id, permissions: "manual", guardrails: "manual", answers: "manual" })
      yield* fixture.coordination.update(group.id, { revision: added.revision, memberSessionIDs: [fixture.alpha.id, fixture.beta.id, fixture.gamma.id] })
      expect(yield* modesOf(fixture.beta.id)).toEqual({ permissions: "manual", guardrails: "manual", answers: "manual", inherited: {} })
      expect(yield* modesOf(fixture.gamma.id)).toEqual({ ...masterModes, inherited: {} })
    }))

  it.effect("creating a Project with members gives each member the Master's modes", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.autonomy.set({ sessionID: fixture.master.id, ...masterModes })
      yield* fixture.coordination.create({ name: "Docs", masterSessionID: fixture.master.id, memberSessionIDs: [fixture.alpha.id, fixture.beta.id] })
      expect(yield* modesOf(fixture.alpha.id)).toEqual({ ...masterModes, inherited: {} })
      expect(yield* modesOf(fixture.beta.id)).toEqual({ ...masterModes, inherited: {} })
    }))

  it.effect("a member's managed subagent inherits the modes the member took from the Master", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.autonomy.set({ sessionID: fixture.master.id, ...masterModes })
      yield* fixture.coordination.create({ name: "Docs", masterSessionID: fixture.master.id, memberSessionIDs: [fixture.alpha.id] })
      const subagent = yield* managedChild(fixture.alpha.id)
      expect(yield* modesOf(subagent.id)).toEqual({
        ...masterModes,
        inherited: { permissions: fixture.alpha.id, guardrails: fixture.alpha.id, answers: fixture.alpha.id },
      })
    }))
})
