import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { CoordinationRuntime } from "../src/session/coordination-runtime"
import { CoordinationService } from "../src/coordination/index"
import { CoordinationDispatchSelection } from "../src/coordination/selection"
import { CatalogModel } from "../src/model"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { ProjectTable } from "../src/project/sql"
import { Project } from "../src/project"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { SessionPending } from "../src/session/pending"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"

const selection: Coordination.DispatchSelection = {
  agent: Agent.ID.make("occam"),
  model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("model-a"), variant: Model.VariantID.make("medium") }),
  reason: "Bounded fixture work with settled behavior",
}
const fixtureSelections = CoordinationDispatchSelection.layerWith((_target, chosen) =>
  Effect.gen(function* () {
    const problem = CoordinationDispatchSelection.check({
      agent: chosen.agent === "occam" ? { ...Agent.Info.empty(chosen.agent), mode: "subagent" as const, hidden: false } : undefined,
      model: chosen.model.providerID === "fixture" && chosen.model.id === "model-a"
        ? ({ ...CatalogModel.Info.empty(chosen.model.providerID, CatalogModel.ID.make("model-a")), variants: ["low", "medium", "high"].map((id) => ({ id: Model.VariantID.make(id) })) } as CatalogModel.Info)
        : undefined,
      selection: chosen,
    })
    if (problem !== undefined) return yield* new CoordinationDispatchSelection.InvalidSelectionError({ message: problem })
  }),
)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, CoordinationService.node, CoordinationDispatchSelection.node]), [[CoordinationDispatchSelection.node, fixtureSelections]]))

const zeus: Coordination.DispatchSelection = {
  agent: Agent.ID.make("zeus"),
  model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("model-a"), variant: Model.VariantID.make("high") }),
  reason: "Complex fixture work from verified evidence",
}
const retired = new Set<string>()
const wokenSessions: SessionSchema.ID[] = []
const switchableSelections = CoordinationDispatchSelection.layerWith((_target, chosen) =>
  Effect.gen(function* () {
    const problem = CoordinationDispatchSelection.check({
      agent: (chosen.agent === "occam" || chosen.agent === "zeus") && !retired.has(chosen.agent)
        ? { ...Agent.Info.empty(chosen.agent), mode: "subagent" as const, hidden: false }
        : undefined,
      model: chosen.model.providerID === "fixture" && chosen.model.id === "model-a"
        ? ({ ...CatalogModel.Info.empty(chosen.model.providerID, CatalogModel.ID.make("model-a")), variants: ["low", "medium", "high"].map((id) => ({ id: Model.VariantID.make(id) })) } as CatalogModel.Info)
        : undefined,
      selection: chosen,
    })
    if (problem !== undefined) return yield* new CoordinationDispatchSelection.InvalidSelectionError({ message: problem })
  }),
)
const withRuntime = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, CoordinationService.node, CoordinationDispatchSelection.node, CoordinationRuntime.node]),
  [
    [CoordinationDispatchSelection.node, switchableSelections],
    [SessionExecution.node, Layer.mock(SessionExecution.Service, { wake: (sessionID) => Effect.sync(() => { wokenSessions.push(sessionID) }) })],
  ],
))

const coordinationInput = (dispatchID: Coordination.DispatchID) => SessionMessage.ID.make(`msg_coord_${dispatchID}`)

const statuses = (dispatches: ReadonlyArray<Coordination.DispatchInfo>) =>
  Object.fromEntries(dispatches.map((dispatch) => [dispatch.id, dispatch.status]))

const seedGroup = (name: string, concurrency: number, workers: ReadonlyArray<{ readonly id: SessionSchema.ID; readonly leaseMs?: number }>) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const coordination = yield* CoordinationService.Service
    const coordinatorSessionID = SessionSchema.ID.make(`ses_${name}_coordinator`)
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values([
      { id: coordinatorSessionID, project_id: Project.ID.global, directory: "/project", title: "Coordinator" },
      ...workers.map((worker) => ({ id: worker.id, project_id: Project.ID.global, directory: "/project/worktree", title: "Worker" })),
    ]).run()
    const created = yield* coordination.create({ kind: "human" }, { name, policy: { concurrency, queueCapacity: 5 }, members: [
      { sessionID: coordinatorSessionID, role: "coordinator" },
      ...workers.map((worker) => ({ sessionID: worker.id, role: "worker" as const })),
    ] })
    yield* coordination.arm({ kind: "human" }, { groupID: created.id, expectedRevision: created.revision })
    const actor = { kind: "coordinator" as const, sessionID: coordinatorSessionID }
    const generations = new Map<SessionSchema.ID, number>()
    for (const worker of workers) {
      const current = yield* coordination.get(created.id)
      const claim = yield* coordination.claim(actor, {
        groupID: created.id, expectedRevision: current.revision, targetSessionID: worker.id,
        ...(worker.leaseMs === undefined ? {} : { leaseMs: worker.leaseMs }),
      })
      generations.set(worker.id, claim.generation)
    }
    const dispatch = (targetSessionID: SessionSchema.ID, chosen: Coordination.DispatchSelection, text: string) =>
      Effect.gen(function* () {
        const current = yield* coordination.get(created.id)
        return yield* coordination.dispatch(actor, {
          groupID: created.id, expectedRevision: current.revision, generation: generations.get(targetSessionID)!, targetSessionID, text, selection: chosen,
        })
      })
    return { groupID: created.id, dispatch }
  })

const until = (groupID: Coordination.GroupID, done: (dispatches: ReadonlyArray<Coordination.DispatchInfo>) => boolean) =>
  Effect.gen(function* () {
    const coordination = yield* CoordinationService.Service
    for (let attempt = 0; attempt < 400; attempt++) {
      const current = yield* coordination.dispatches({ groupID })
      if (done(current)) return current
      yield* Effect.yieldNow
    }
    return yield* coordination.dispatches({ groupID })
  })

describe("coordination input admission", () => {
  it.effect("commits a real dispatch receipt with the input before waking its worker", () => Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
    const coordination = yield* CoordinationService.Service
    const coordinatorSessionID = SessionSchema.ID.make("ses_real_coord")
    const targetSessionID = SessionSchema.ID.make("ses_real_worker")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values([
      { id: coordinatorSessionID, project_id: Project.ID.global, directory: "/project", title: "Coordinator" },
      { id: targetSessionID, project_id: Project.ID.global, directory: "/project/worktree", title: "Worker" },
    ]).run()
    const created = yield* coordination.create({ kind: "human" }, { name: "Real admission", policy: { concurrency: 1, queueCapacity: 5 }, members: [
      { sessionID: coordinatorSessionID, role: "coordinator" }, { sessionID: targetSessionID, role: "worker" },
    ] })
    const armed = yield* coordination.arm({ kind: "human" }, { groupID: created.id, expectedRevision: created.revision })
    const actor = { kind: "coordinator" as const, sessionID: coordinatorSessionID }
    const claim = yield* coordination.claim(actor, { groupID: armed.id, expectedRevision: armed.revision, targetSessionID })
    const group = yield* coordination.get(armed.id)
    const dispatch = yield* coordination.dispatch(actor, { groupID: group.id, expectedRevision: group.revision, generation: claim.generation, targetSessionID, text: "Inspect assigned files", selection })
    let wakes = 0
    const runtime = CoordinationRuntime.make({ db, events, coordination,
      wake: () => Effect.gen(function* () {
        const receipts = yield* coordination.receipts({ groupID: group.id }).pipe(Effect.orDie)
        const receipt = receipts.find((entry) => entry.kind === "admitted")
        expect(receipt?.messageID).toBeDefined()
        expect(receipt?.selection).toEqual(selection)
        expect(yield* SessionPending.find(db, receipt!.messageID!)).toMatchObject({ sessionID: targetSessionID, type: "user" })
        wakes += 1
      }),
    })
    expect((yield* runtime.admit(dispatch)).status).toBe("admitted")
    expect((yield* coordination.dispatches({ groupID: group.id }))[0]?.status).toBe("admitted")
    expect(wakes).toBe(1)
    yield* runtime.admit(dispatch)
    expect(wakes).toBe(1)
  }))
  it.effect("admits one trusted input and wakes once after its receipt commits", () => Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
    const targetSessionID = SessionSchema.ID.make("ses_coord_target")
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: targetSessionID, project_id: Project.ID.global, directory: "/project/other", title: "Worker" }).run()
    const dispatch = Coordination.DispatchInfo.make({
      id: Coordination.DispatchID.make("cdsp_one"), groupID: Coordination.GroupID.make("cgrp_one"),
      coordinatorSessionID: SessionSchema.ID.make("ses_coord"), targetSessionID, generation: 1,
      text: "Inspect the assigned source", selection, status: "pending", time: { created: 1, updated: 1 },
    })
    let committed = 0
    let woken = 0
    const runtime = CoordinationRuntime.make({ db, events, coordination: {
      prepareAdmission: (_actor, input) => Effect.succeed({ snapshot: { groupID: dispatch.groupID, dispatchID: dispatch.id, messageID: input.messageID, generation: 1, targetSessionID }, commit: () => Effect.sync(() => { committed += 1 }) }),
      get: () => Effect.succeed(Coordination.Info.make({ id: dispatch.groupID, name: "Group", status: "armed", revision: Coordination.Revision.make(1), fencingGeneration: 1, members: [], policy: { concurrency: 1, queueCapacity: 5 }, time: { created: 1, updated: 1 } })),
      dispatches: () => Effect.die(new Error("Admission must not reread dispatches after a successful preparation")),
      claims: () => Effect.die(new Error("Admission must not reread claims after a successful preparation")),
      settleDispatch: () => Effect.die(new Error("Admission must not settle after a successful preparation")),
    },
      wake: (sessionID) => Effect.sync(() => { expect(sessionID).toBe(targetSessionID); expect(committed).toBe(1); woken += 1 }),
    })
    const first = yield* runtime.admit(dispatch)
    expect(first.status).toBe("admitted")
    const input = yield* SessionPending.find(db, first.messageID!)
    expect(input?.type === "user" && input.data.metadata).toMatchObject({ inputOrigin: "coordination", coordination: { groupID: "cgrp_one", dispatchID: "cdsp_one", coordinatorSessionID: "ses_coord" } })
    yield* runtime.admit(dispatch)
    expect(committed).toBe(1)
    expect(woken).toBe(1)
  }))

  for (const status of ["armed", "waiting"] as const)
  it.effect(`a pending dispatch whose claim expired settles failed while ${status} and frees its capacity`, () => Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
    const coordination = yield* CoordinationService.Service
    const stale = SessionSchema.ID.make("ses_stale_worker")
    const fresh = SessionSchema.ID.make("ses_fresh_worker")
    const group = yield* seedGroup("expired-claim", 2, [{ id: stale, leaseMs: 1000 }, { id: fresh }])
    const expired = yield* group.dispatch(stale, selection, "Inspect the stale target")
    const valid = yield* group.dispatch(fresh, selection, "Inspect the fresh target")
    expect([expired.status, valid.status]).toEqual(["pending", "pending"])
    yield* TestClock.adjust("2 seconds")
    const admittedSessions: SessionSchema.ID[] = []
    const runtime = CoordinationRuntime.make({ db, events, coordination: {
      ...coordination,
      get: (groupID) => coordination.get(groupID).pipe(Effect.map((group) => ({ ...group, status }))),
    }, wake: (sessionID) => Effect.sync(() => { admittedSessions.push(sessionID) }) })
    expect((yield* runtime.admit(expired)).status).toBe("failed")
    expect((yield* runtime.admit(valid)).status).toBe("admitted")
    expect(statuses(yield* coordination.dispatches({ groupID: group.groupID }))).toEqual({ [expired.id]: "failed", [valid.id]: "admitted" })
    const failure = (yield* coordination.receipts({ groupID: group.groupID })).find((receipt) => receipt.dispatchID === expired.id && receipt.kind === "failed")
    expect(failure?.detail).toMatch(/claim/i)
    expect(failure?.selection).toEqual(selection)
    expect(yield* SessionPending.find(db, coordinationInput(expired.id))).toBeUndefined()
    expect(yield* SessionPending.find(db, coordinationInput(valid.id))).toMatchObject({ sessionID: fresh, type: "user" })
    expect(admittedSessions).toEqual([fresh])
    expect((yield* coordination.capacity(group.groupID)).active).toBe(1)
  }))

  withRuntime.effect("a selection that became unavailable while queued settles failed after promotion and the next dispatch is admitted", () => Effect.gen(function* () {
    retired.clear()
    wokenSessions.length = 0
    const { db } = yield* Database.Service
    const coordination = yield* CoordinationService.Service
    for (let attempt = 0; attempt < 10; attempt++) yield* Effect.yieldNow
    const first = SessionSchema.ID.make("ses_first_worker")
    const retiring = SessionSchema.ID.make("ses_retiring_worker")
    const next = SessionSchema.ID.make("ses_next_worker")
    const group = yield* seedGroup("selection-promotion", 1, [{ id: first }, { id: retiring }, { id: next }])
    const running = yield* group.dispatch(first, selection, "Run the first assignment")
    yield* until(group.groupID, (dispatches) => dispatches.some((dispatch) => dispatch.id === running.id && dispatch.status === "admitted"))
    const blocked = yield* group.dispatch(retiring, zeus, "Run with the retiring profile")
    const later = yield* group.dispatch(next, selection, "Run the next assignment")
    expect([blocked.status, later.status]).toEqual(["queued", "queued"])
    retired.add("zeus")
    yield* coordination.settleDispatch({ kind: "system" }, { groupID: group.groupID, dispatchID: running.id, outcome: "completed" })
    const settled = yield* until(group.groupID, (dispatches) => dispatches.some((dispatch) => dispatch.id === later.id && dispatch.status === "admitted"))
    expect(statuses(settled)).toEqual({ [running.id]: "completed", [blocked.id]: "failed", [later.id]: "admitted" })
    const failure = (yield* coordination.receipts({ groupID: group.groupID })).find((receipt) => receipt.dispatchID === blocked.id && receipt.kind === "failed")
    expect(failure?.detail).toContain("zeus")
    expect(failure?.selection).toEqual(zeus)
    expect(yield* SessionPending.find(db, coordinationInput(blocked.id))).toBeUndefined()
    expect(yield* SessionPending.find(db, coordinationInput(later.id))).toMatchObject({ sessionID: next, type: "user" })
    expect(wokenSessions).toEqual([first, next])
    expect((yield* coordination.capacity(group.groupID)).active).toBe(1)
  }))

  withRuntime.effect("a queued dispatch whose claim expired settles visibly instead of holding the queue", () => Effect.gen(function* () {
    retired.clear()
    wokenSessions.length = 0
    const { db } = yield* Database.Service
    const coordination = yield* CoordinationService.Service
    for (let attempt = 0; attempt < 10; attempt++) yield* Effect.yieldNow
    const first = SessionSchema.ID.make("ses_queue_first_worker")
    const stale = SessionSchema.ID.make("ses_queue_stale_worker")
    const next = SessionSchema.ID.make("ses_queue_next_worker")
    const group = yield* seedGroup("queued-expired-claim", 1, [{ id: first }, { id: stale, leaseMs: 1000 }, { id: next }])
    const running = yield* group.dispatch(first, selection, "Run the first assignment")
    yield* until(group.groupID, (dispatches) => dispatches.some((dispatch) => dispatch.id === running.id && dispatch.status === "admitted"))
    const expired = yield* group.dispatch(stale, selection, "Run on the target whose claim expires")
    yield* TestClock.adjust("10 millis")
    const later = yield* group.dispatch(next, selection, "Run the next assignment")
    expect([expired.status, later.status]).toEqual(["queued", "queued"])
    yield* TestClock.adjust("2 seconds")
    yield* coordination.settleDispatch({ kind: "system" }, { groupID: group.groupID, dispatchID: running.id, outcome: "completed" })
    const settled = yield* until(group.groupID, (dispatches) =>
      dispatches.some((dispatch) => dispatch.id === later.id && dispatch.status === "admitted") &&
      dispatches.some((dispatch) => dispatch.id === expired.id && dispatch.status !== "queued"))
    expect(statuses(settled)[later.id]).toBe("admitted")
    expect(statuses(settled)[expired.id]).toBe("failed")
    const terminal = (yield* coordination.receipts({ groupID: group.groupID }))
      .find((receipt) => receipt.dispatchID === expired.id && (receipt.kind === "failed" || receipt.kind === "cancelled"))
    expect(terminal?.detail).toMatch(/claim/i)
    expect(terminal?.selection).toEqual(selection)
    expect(yield* SessionPending.find(db, coordinationInput(expired.id))).toBeUndefined()
    expect(wokenSessions).toEqual([first, next])
    const capacity = yield* coordination.capacity(group.groupID)
    expect([capacity.active, capacity.queued]).toEqual([1, 0])
  }))
})
