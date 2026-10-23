import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { tmpdir } from "node:os"
import { Agent } from "@ycoding-ai/schema/agent"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { eq } from "drizzle-orm"
import { CoordinationService } from "../src/coordination/index"
import { CoordinationDispatchSelection } from "../src/coordination/selection"
import { CatalogModel } from "../src/model"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"

let runtimeCapacity: { hardLimit?: number; usedExternal?: number } = {}
const selection: Coordination.DispatchSelection = {
  agent: Agent.ID.make("occam"),
  model: Model.Ref.make({
    providerID: Provider.ID.make("fixture"),
    id: Model.ID.make("model-a"),
    variant: Model.VariantID.make("medium"),
  }),
  reason: "Bounded fixture work with settled behavior",
}
const fixtureSelections = CoordinationDispatchSelection.layerWith((_target, chosen) =>
  Effect.gen(function* () {
    const agent =
      chosen.agent === "occam" || chosen.agent === "build"
        ? { ...Agent.Info.empty(chosen.agent), mode: "subagent" as const, hidden: false }
        : undefined
    const model =
      chosen.model.providerID === "fixture" && chosen.model.id === "model-a"
        ? ({
            ...CatalogModel.Info.empty(chosen.model.providerID, CatalogModel.ID.make("model-a")),
            variants: ["low", "medium", "high"].map((id) => ({ id: Model.VariantID.make(id) })),
          } as CatalogModel.Info)
        : chosen.model.providerID === "fixture" && chosen.model.id === "plain"
          ? (CatalogModel.Info.empty(chosen.model.providerID, CatalogModel.ID.make("plain")) as CatalogModel.Info)
          : undefined
    const problem = CoordinationDispatchSelection.check({ agent, model, selection: chosen })
    if (problem !== undefined) return yield* new CoordinationDispatchSelection.InvalidSelectionError({ message: problem })
  }),
)
const runtime = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, Session.node, CoordinationService.node, CoordinationDispatchSelection.node]),
  [
    [SessionExecution.node, SessionExecution.noopLayer],
    [CoordinationDispatchSelection.node, fixtureSelections],
  ],
)
const limitedRuntime = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, Session.node, CoordinationService.node, CoordinationDispatchSelection.node]),
  [
    [SessionExecution.node, SessionExecution.noopLayer],
    [
      CoordinationService.node,
      CoordinationService.layerWith({ capacity: () => Effect.sync(() => runtimeCapacity) }).pipe(Layer.provide(fixtureSelections)),
    ],
    [CoordinationDispatchSelection.node, fixtureSelections],
  ],
)

type Services = Database.Service | EventRuntime.Service | Session.Service | CoordinationService.Service
const run = <A, E>(body: Effect.Effect<A, E, Services>, layer: Layer.Layer<Services, unknown> = runtime) =>
  Effect.runPromise(body.pipe(Effect.provide(layer), Effect.scoped))

const human = { kind: "human" } as const
const system = { kind: "system" } as const

const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const coordinator = yield* sessions.create({ location, title: "coordinator" })
  const worker = yield* sessions.create({ location, title: "worker" })
  const worker2 = yield* sessions.create({ location, title: "worker2" })
  const observer = yield* sessions.create({ location, title: "observer" })
  return { coordinator, worker, worker2, observer, location }
})

const createGroup = Effect.fnUntraced(function* (
  ids: Effect.Success<typeof setup>,
  policy: Coordination.Policy = { concurrency: 2, queueCapacity: 10 },
) {
  const service = yield* CoordinationService.Service
  return yield* service.create(human, {
    name: "Team",
    policy,
    members: [
      { sessionID: ids.coordinator.id, role: "coordinator" },
      { sessionID: ids.worker.id, role: "worker", allowedTools: ["read", "edit"], resourceScopes: ["src/*"] },
      { sessionID: ids.worker2.id, role: "worker" },
      { sessionID: ids.observer.id, role: "observer" },
    ],
  })
})

const armedGroup = Effect.fnUntraced(function* (
  ids: Effect.Success<typeof setup>,
  policy: Coordination.Policy = { concurrency: 2, queueCapacity: 10 },
) {
  const service = yield* CoordinationService.Service
  const group = yield* createGroup(ids, policy)
  return yield* service.arm(human, { groupID: group.id, expectedRevision: group.revision })
})

const claimWorker = Effect.fnUntraced(function* (
  ids: Effect.Success<typeof setup>,
  group: Coordination.Info,
  target = ids.worker.id,
) {
  const service = yield* CoordinationService.Service
  return yield* service.claim(
    { kind: "coordinator", sessionID: ids.coordinator.id },
    { groupID: group.id, expectedRevision: group.revision, targetSessionID: target, leaseMs: 60_000 },
  )
})

describe("coordination groups", () => {
  test("creates a disarmed group with resolved member locations and role access", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const group = yield* createGroup(ids)
        expect(group.id.startsWith("cgrp_")).toBe(true)
        expect(group.status).toBe("disarmed")
        expect(group.revision).toBe(Coordination.Revision.make(0))
        expect(group.members).toHaveLength(4)
        expect(group.members.find((member) => member.sessionID === ids.worker.id)?.location.directory).toBe(AbsolutePath.make(tmpdir()))
        expect(yield* service.get(group.id)).toEqual(group)
        expect(yield* service.list({})).toMatchObject([{ id: group.id, status: "disarmed", memberCount: 4 }])

        expect(yield* service.roleFor(ids.worker.id)).toMatchObject({
          groupID: group.id,
          revision: 0,
          role: "worker",
          allowedTools: ["read", "edit"],
          resourceScopes: ["src/*"],
        })
        expect(yield* service.roleFor(ids.coordinator.id)).toMatchObject({ role: "coordinator" })
        expect(yield* service.roleFor(ids.observer.id)).toMatchObject({ role: "observer" })
        const stranger = yield* Session.Service.pipe(
          Effect.flatMap((sessions) => sessions.create({ location: ids.location, title: "stranger" })),
        )
        expect(yield* service.roleFor(stranger.id)).toBeUndefined()
        expect(yield* service.get(Coordination.GroupID.make("cgrp_missing")).pipe(Effect.flip)).toBeInstanceOf(
          CoordinationService.NotFoundError,
        )
      }),
    ))

  test("rejects unknown, child, archived, and duplicate roster sessions", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const sessions = yield* Session.Service
        const service = yield* CoordinationService.Service
        const database = yield* Database.Service
        const child = yield* sessions.create({ parentID: ids.worker.id, title: "child" })
        const archived = yield* sessions.create({ location: ids.location, title: "archived" })
        yield* database.db.run(sql`UPDATE session SET time_archived = 1 WHERE id = ${archived.id}`).pipe(Effect.orDie)
        const base = { name: "Bad", policy: { concurrency: 1, queueCapacity: 4 } as Coordination.Policy }
        const coordinatorMember = { sessionID: ids.coordinator.id, role: "coordinator" as const }

        for (const bad of [
          [{ sessionID: Session.ID.make("ses_missing"), role: "worker" as const }],
          [{ sessionID: child.id, role: "worker" as const }],
          [{ sessionID: archived.id, role: "worker" as const }],
          [
            { sessionID: ids.worker.id, role: "worker" as const },
            { sessionID: ids.worker.id, role: "observer" as const },
          ],
        ]) {
          const error = yield* service.create(human, { ...base, members: [coordinatorMember, ...bad] }).pipe(Effect.flip)
          expect(error).toBeInstanceOf(CoordinationService.IneligibleSessionError)
        }
        const noCoordinator = yield* service
          .create(human, { ...base, members: [{ sessionID: ids.worker.id, role: "worker" }] })
          .pipe(Effect.flip)
        expect(noCoordinator).toBeInstanceOf(CoordinationService.InvalidInputError)

        yield* createGroup(ids)
        expect(yield* service.list({})).toHaveLength(1)
      }),
    ))

  test("lifecycle is human-only and revision fenced; observers cannot mutate", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const coordinatorActor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        expect(
          yield* service
            .create(coordinatorActor as never, {
              name: "Nope",
              policy: { concurrency: 1, queueCapacity: 4 },
              members: [{ sessionID: ids.coordinator.id, role: "coordinator" }],
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ForbiddenError)

        const group = yield* createGroup(ids)
        expect(
          yield* service.arm(coordinatorActor as never, { groupID: group.id, expectedRevision: group.revision }).pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ForbiddenError)
        expect(
          yield* service.arm(human, { groupID: group.id, expectedRevision: Coordination.Revision.make(99) }).pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)
        const armed = yield* service.arm(human, { groupID: group.id, expectedRevision: group.revision })
        expect(armed.status).toBe("armed")
        expect(armed.revision).toBe(Coordination.Revision.make(group.revision + 1))

        const observerActor = { kind: "coordinator", sessionID: ids.observer.id } as const
        expect(
          yield* service
            .claim(observerActor, { groupID: group.id, expectedRevision: armed.revision, targetSessionID: ids.worker.id })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ForbiddenError)
        const workerActor = { kind: "coordinator", sessionID: ids.worker.id } as const
        expect(
          yield* service
            .claim(workerActor, { groupID: group.id, expectedRevision: armed.revision, targetSessionID: ids.worker2.id })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ForbiddenError)
      }),
    ))

  test("claims fence one writer per target with lease expiry, renewal, and release", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const database = yield* Database.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        let group = yield* armedGroup(ids)

        const claim = yield* claimWorker(ids, group)
        expect(claim).toMatchObject({ holderSessionID: ids.coordinator.id, targetSessionID: ids.worker.id, generation: 1, status: "active" })
        expect(yield* service.claims({ groupID: group.id })).toMatchObject([
          { targetSessionID: ids.worker.id, holderSessionID: ids.coordinator.id, generation: 1, status: "active" },
        ])
        expect(yield* service.claims({ groupID: group.id, limit: 0 }).pipe(Effect.flip)).toBeInstanceOf(
          CoordinationService.InvalidInputError,
        )
        group = yield* service.get(group.id)
        const renewed = yield* claimWorker(ids, group)
        expect(renewed.generation).toBe(1)

        group = yield* service.get(group.id)
        expect(
          yield* service
            .release(actor, { groupID: group.id, expectedRevision: group.revision, targetSessionID: ids.worker.id, generation: 99 })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)

        yield* database.db
          .run(sql`UPDATE coordination_claim SET lease_expires_at = 0 WHERE group_id = ${group.id}`)
          .pipe(Effect.orDie)
        group = yield* service.get(group.id)
        const reclaimed = yield* claimWorker(ids, group)
        expect(reclaimed.generation).toBe(2)
        expect((yield* service.roleFor(ids.coordinator.id))?.fencingGeneration).toBe(2)

        group = yield* service.get(group.id)
        const released = yield* service.release(actor, {
          groupID: group.id,
          expectedRevision: group.revision,
          targetSessionID: ids.worker.id,
          generation: 2,
        })
        expect(released.status).toBe("released")
        group = yield* service.get(group.id)
        const again = yield* claimWorker(ids, group)
        expect(again.generation).toBe(3)
      }),
    ))

  test("dispatch requires an armed group, roster target, and the live claim generation", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        let group = yield* createGroup(ids)
        expect(
          yield* service
            .dispatch(actor, { groupID: group.id, expectedRevision: group.revision, generation: 1, targetSessionID: ids.worker.id, text: "work", selection })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)

        group = yield* service.arm(human, { groupID: group.id, expectedRevision: group.revision })
        expect(
          yield* service
            .dispatch(actor, { groupID: group.id, expectedRevision: group.revision, generation: 1, targetSessionID: ids.worker.id, text: "work", selection })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)

        const claim = yield* claimWorker(ids, group)
        group = yield* service.get(group.id)
        expect(
          yield* service
            .dispatch(actor, {
              groupID: group.id,
              expectedRevision: group.revision,
              generation: claim.generation,
              targetSessionID: ids.coordinator.id,
              text: "self", selection,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.IneligibleSessionError)
        expect(
          yield* service
            .dispatch(actor, {
              groupID: group.id,
              expectedRevision: group.revision,
              generation: claim.generation + 1,
              targetSessionID: ids.worker.id,
              text: "stale", selection,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)

        const dispatch = yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: group.revision,
          generation: claim.generation,
          dispatchID: Coordination.DispatchID.make("cdsp_first"),
          targetSessionID: ids.worker.id,
          text: "implement the thing", selection,
          resourceScope: "src/*",
        })
        expect(dispatch).toMatchObject({ id: "cdsp_first", status: "pending", generation: claim.generation })
        group = yield* service.get(group.id)
        expect(
          yield* service
            .dispatch(actor, {
              groupID: group.id,
              expectedRevision: group.revision,
              generation: claim.generation,
              dispatchID: Coordination.DispatchID.make("cdsp_first"),
              targetSessionID: ids.worker.id,
              text: "duplicate", selection: { ...selection, reason: "A different reason must not replace the first" },
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)
        expect((yield* service.get(group.id)).revision).toBe(group.revision)
        expect((yield* service.dispatches({ groupID: group.id }))[0]?.selection).toEqual(selection)
      }),
    ))

  test("dispatch rejects an unconfigured selection before writing any record", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const claim = yield* claimWorker(ids, group)
        const before = yield* service.get(group.id)
        for (const bad of [
          { ...selection, agent: Agent.ID.make("missing") },
          {
            ...selection,
            model: Model.Ref.make({
              providerID: Provider.ID.make("fixture"),
              id: Model.ID.make("model-a"),
              variant: Model.VariantID.make("max"),
            }),
          },
          {
            ...selection,
            model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("plain"), variant: Model.VariantID.make("low") }),
          },
        ]) {
          expect(
            yield* service
              .dispatch(actor, {
                groupID: group.id,
                expectedRevision: (yield* service.get(group.id)).revision,
                generation: claim.generation,
                targetSessionID: ids.worker.id,
                text: "invalid selection",
                selection: bad,
              })
              .pipe(Effect.flip),
          ).toBeInstanceOf(CoordinationDispatchSelection.InvalidSelectionError)
        }
        expect(yield* service.dispatches({ groupID: group.id })).toEqual([])
        expect((yield* service.get(group.id)).revision).toBe(before.revision)
        const plain = yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          generation: claim.generation,
          targetSessionID: ids.worker.id,
          text: "plain model work",
          selection: {
            agent: Agent.ID.make("build"),
            model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("plain") }),
            reason: "No advertised variants exist for this route",
          },
        })
        expect(plain.selection.model.variant).toBeUndefined()
        expect(plain.selection.agent).toBe(Agent.ID.make("build"))
      }),
    ))

  test("capacity, backpressure, admission, settlement, and advance preserve hard caps", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        let group = yield* armedGroup(ids, { concurrency: 1, queueCapacity: 2 })
        const claim = yield* claimWorker(ids, group)
        const claim2 = yield* service.claim(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          targetSessionID: ids.worker2.id,
          leaseMs: 60_000,
        })

        const dispatch = (target: typeof ids.worker.id, generation: number, text: string) =>
          Effect.gen(function* () {
            const current = yield* service.get(group.id)
            return yield* service.dispatch(actor, {
              groupID: group.id,
              expectedRevision: current.revision,
              generation,
              targetSessionID: target,
              text,
              selection,
            })
          })

        const first = yield* dispatch(ids.worker.id, claim.generation, "first")
        expect(first.status).toBe("pending")
        const second = yield* dispatch(ids.worker2.id, claim2.generation, "second")
        expect(second).toMatchObject({ status: "queued", reason: "capacity" })
        const overflow = yield* dispatch(ids.worker.id, claim.generation, "third").pipe(Effect.flip)
        expect(overflow).toBeInstanceOf(CoordinationService.CapacityError)

        expect(yield* service.capacity(group.id)).toMatchObject({
          concurrency: 1,
          hardLimit: null,
          effectiveLimit: 1,
          active: 1,
          queued: 1,
          available: 0,
        })

        const messageID = SessionMessage.ID.make("msg_coord_first")
        const admitted = yield* service.recordAdmission(system, { groupID: group.id, dispatchID: first.id, messageID })
        expect(admitted).toMatchObject({ status: "admitted", messageID })
        expect(yield* service.dispatchForInput({ messageID })).toMatchObject({ id: first.id })
        expect(yield* service.admittedFor({ targetSessionID: ids.worker.id })).toMatchObject([{ id: first.id }])
        expect(yield* service.dispatches({ groupID: group.id, status: "queued" })).toMatchObject([{ id: second.id }])

        expect(yield* service.advance(system, { groupID: group.id })).toEqual([])
        yield* service.settleDispatch(system, { groupID: group.id, dispatchID: first.id, outcome: "completed" })
        const promoted = yield* service.advance(system, { groupID: group.id })
        expect(promoted).toMatchObject([{ id: second.id, status: "pending" }])
        expect(yield* service.receipts({ groupID: group.id })).toMatchObject([
          { dispatchID: first.id, kind: "dispatched" },
          { dispatchID: second.id, kind: "dispatched" },
          { dispatchID: first.id, kind: "admitted", messageID },
          { dispatchID: first.id, kind: "completed" },
        ])
        for (const receipt of yield* service.receipts({ groupID: group.id })) expect(receipt.selection).toEqual(selection)
        expect(first.selection).toEqual(selection)
        group = yield* service.get(group.id)
        expect(group.status).toBe("armed")
      }),
    ))

  test("dependencies queue until settled and unknown dependencies are rejected", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids, { concurrency: 2, queueCapacity: 10 })
        const claim = yield* claimWorker(ids, group)
        const dispatch = (text: string, dependsOn?: readonly Coordination.DispatchID[]) =>
          Effect.gen(function* () {
            const current = yield* service.get(group.id)
            return yield* service.dispatch(actor, {
              groupID: group.id,
              expectedRevision: current.revision,
              generation: claim.generation,
              targetSessionID: ids.worker.id,
              text,
              selection,
              ...(dependsOn ? { dependsOn } : {}),
            })
          })
        expect(
          yield* dispatch("bad", [Coordination.DispatchID.make("cdsp_missing")]).pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.InvalidInputError)
        const first = yield* dispatch("first")
        const second = yield* dispatch("second", [first.id])
        expect(second).toMatchObject({ status: "queued", reason: "dependency" })
        expect(yield* service.capacity(group.id)).toMatchObject({
          concurrency: 2,
          hardLimit: null,
          effectiveLimit: 2,
          available: 1,
          active: 1,
          queued: 1,
        })
        yield* service.recordAdmission(system, { groupID: group.id, dispatchID: first.id, messageID: SessionMessage.ID.make("msg_dep") })
        yield* service.settleDispatch(system, { groupID: group.id, dispatchID: first.id, outcome: "completed" })
        expect(yield* service.advance(system, { groupID: group.id })).toMatchObject([{ id: second.id, status: "pending" }])
      }),
    ))

  test("runtime hard limits queue even uncapped groups and report effective bounds", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids, { concurrency: null, queueCapacity: 10 })
        const claim = yield* claimWorker(ids, group)
        runtimeCapacity = { hardLimit: 1, usedExternal: 1 }
        const current = yield* service.get(group.id)
        const queued = yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: current.revision,
          generation: claim.generation,
          targetSessionID: ids.worker.id,
          text: "bounded by runtime", selection,
        })
        expect(queued).toMatchObject({ status: "queued", reason: "hard-limit" })
        expect(yield* service.capacity(group.id)).toMatchObject({
          concurrency: null,
          hardLimit: 1,
          effectiveLimit: 1,
          available: 0,
          runtimeUsed: 1,
        })
        runtimeCapacity = { hardLimit: 1, usedExternal: 0 }
        expect(yield* service.advance(system, { groupID: group.id })).toMatchObject([{ id: queued.id, status: "pending" }])
        runtimeCapacity = {}
      }),
      limitedRuntime,
    ))

  test("an uncapped policy with no reported runtime bound queues instead of authorizing work", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids, { concurrency: null, queueCapacity: 10 })
        const claim = yield* claimWorker(ids, group)
        const current = yield* service.get(group.id)
        const queued = yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: current.revision,
          generation: claim.generation,
          targetSessionID: ids.worker.id,
          text: "needs a known bound", selection,
        })
        expect(queued).toMatchObject({ status: "queued", reason: "hard-limit" })
        expect(yield* service.capacity(group.id)).toMatchObject({
          concurrency: null,
          hardLimit: null,
          effectiveLimit: null,
          available: null,
          active: 0,
          queued: 1,
        })
        expect(yield* service.advance(system, { groupID: group.id })).toEqual([])
      }),
    ))

  test("observer membership overlaps groups while competing writer claims on one root conflict", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const sessions = yield* Session.Service
        const coordinator2 = yield* sessions.create({ location: ids.location, title: "coordinator2" })
        const first = yield* armedGroup(ids)
        const claim = yield* claimWorker(ids, first)

        const second = yield* service.create(human, {
          name: "Overlap",
          policy: { concurrency: 1, queueCapacity: 4 },
          members: [
            { sessionID: coordinator2.id, role: "coordinator" },
            { sessionID: ids.worker.id, role: "worker" },
            { sessionID: ids.observer.id, role: "observer" },
          ],
        })
        const armedSecond = yield* service.arm(human, { groupID: second.id, expectedRevision: second.revision })
        expect(
          yield* service
            .claim(
              { kind: "coordinator", sessionID: coordinator2.id },
              { groupID: second.id, expectedRevision: armedSecond.revision, targetSessionID: ids.worker.id, leaseMs: 60_000 },
            )
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)

        yield* service.release(actor, {
          groupID: first.id,
          expectedRevision: (yield* service.get(first.id)).revision,
          targetSessionID: ids.worker.id,
          generation: claim.generation,
        })
        const won = yield* service.claim(
          { kind: "coordinator", sessionID: coordinator2.id },
          {
            groupID: second.id,
            expectedRevision: (yield* service.get(second.id)).revision,
            targetSessionID: ids.worker.id,
            leaseMs: 60_000,
          },
        )
        expect(won).toMatchObject({ holderSessionID: coordinator2.id, status: "active" })
        expect(yield* service.roleFor(ids.observer.id)).toMatchObject({ role: "observer" })
      }),
    ))

  test("budget blocks dispatch once roster spend reaches the policy budget", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const database = yield* Database.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids, { concurrency: 2, queueCapacity: 10, budget: 5 as never })
        const claim = yield* claimWorker(ids, group)
        yield* database.db.run(sql`UPDATE session SET cost = 5 WHERE id = ${ids.worker.id}`).pipe(Effect.orDie)
        expect(yield* service.capacity(group.id)).toMatchObject({ budget: 5, spent: 5, budgetRemaining: 0 })
        const current = yield* service.get(group.id)
        expect(
          yield* service
            .dispatch(actor, {
              groupID: group.id,
              expectedRevision: current.revision,
              generation: claim.generation,
              targetSessionID: ids.worker.id,
              text: "too expensive", selection,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.CapacityError)
      }),
    ))

  test("wait returns assigned Session events once with durable cursors and event identity", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const events = yield* EventRuntime.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const claim = yield* claimWorker(ids, group)
        const current = yield* service.get(group.id)
        yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: current.revision,
          generation: claim.generation,
          targetSessionID: ids.worker.id,
          text: "watched work", selection,
        })

        const published = yield* events.publish(SessionEvent.AgentSelected, {
          sessionID: ids.worker.id,
          agent: Agent.ID.make("review"),
        })
        const waitID = Coordination.WaitID.make("cwait_first")
        const fresh = yield* service.get(group.id)
        const first = yield* service.wait(actor, {
          groupID: group.id,
          expectedRevision: fresh.revision,
          waitID,
          targets: [ids.worker.id],
          timeoutMs: 0,
        })
        expect(first.status).toBe("active")
        expect(first.observations).toContainEqual(
          expect.objectContaining({ sessionID: ids.worker.id, eventID: published.id, type: "session.agent.selected" }),
        )
        expect(first.cursors[ids.worker.id]).toBeGreaterThanOrEqual(0)

        const again = yield* service.wait(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          waitID,
          timeoutMs: 0,
        })
        expect(again.observations).toEqual([])

        const second = yield* events.publish(SessionEvent.AgentSelected, {
          sessionID: ids.worker.id,
          agent: Agent.ID.make("build"),
        })
        const next = yield* service.wait(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          waitID,
          timeoutMs: 0,
        })
        expect(next.observations.map((observation) => observation.eventID)).toContain(second.id)
        expect(next.observations.map((observation) => observation.eventID)).not.toContain(published.id)

        expect(
          yield* service
            .wait(actor, {
              groupID: group.id,
              expectedRevision: (yield* service.get(group.id)).revision,
              targets: [ids.coordinator.id],
              timeoutMs: 0,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.IneligibleSessionError)

        const cancelled = yield* service.cancelWait(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          waitID,
        })
        expect(cancelled.status).toBe("cancelled")
        expect(
          yield* service
            .wait(actor, { groupID: group.id, expectedRevision: (yield* service.get(group.id)).revision, waitID, timeoutMs: 0 })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)
      }),
    ))

  test("wait recovers from a cursor beyond the Session log with an explicit gap observation", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const database = yield* Database.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const waitID = Coordination.WaitID.make("cwait_gap")
        yield* service.wait(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          waitID,
          targets: [ids.worker.id],
          timeoutMs: 0,
        })
        yield* database.db
          .run(sql`UPDATE coordination_wait SET cursors = ${JSON.stringify({ [ids.worker.id]: 9999 })} WHERE id = ${waitID}`)
          .pipe(Effect.orDie)
        const recovered = yield* service.wait(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          waitID,
          timeoutMs: 0,
        })
        expect(recovered.observations).toContainEqual(expect.objectContaining({ gap: true, sessionID: ids.worker.id }))
        expect(recovered.cursors[ids.worker.id]).toBeLessThan(9999)
      }),
    ))

  test("stop releases claims and waits, cancels queued work, and never touches admitted input", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids, { concurrency: 1, queueCapacity: 10 })
        const claim = yield* claimWorker(ids, group)
        const dispatch = (text: string) =>
          Effect.gen(function* () {
            const current = yield* service.get(group.id)
            return yield* service.dispatch(actor, {
              groupID: group.id,
              expectedRevision: current.revision,
              generation: claim.generation,
              targetSessionID: ids.worker.id,
              text,
              selection,
            })
          })
        const first = yield* dispatch("admitted stays")
        const second = yield* dispatch("queued goes")
        yield* service.recordAdmission(system, { groupID: group.id, dispatchID: first.id, messageID: SessionMessage.ID.make("msg_stop") })
        const waitID = Coordination.WaitID.make("cwait_stop")
        yield* service.wait(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          waitID,
          targets: [ids.worker.id],
          timeoutMs: 0,
        })

        const stopped = yield* service.stop(human, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
        })
        expect(stopped.status).toBe("stopped")
        expect(yield* service.dispatches({ groupID: group.id })).toMatchObject([
          { id: first.id, status: "admitted" },
          { id: second.id, status: "cancelled" },
        ])
        expect(
          yield* service
            .dispatch(actor, {
              groupID: group.id,
              expectedRevision: stopped.revision,
              generation: claim.generation,
              targetSessionID: ids.worker.id,
              text: "after stop", selection,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)
        const claimAfter = yield* service
          .claim(actor, { groupID: group.id, expectedRevision: stopped.revision, targetSessionID: ids.worker.id })
          .pipe(Effect.flip)
        expect(claimAfter).toBeInstanceOf(CoordinationService.ConflictError)
      }),
    ))

  test("completion refuses outstanding dispatches, claims, and open reviews", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const events = yield* EventRuntime.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const claim = yield* claimWorker(ids, group)
        const current = yield* service.get(group.id)
        const work = yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: current.revision,
          generation: claim.generation,
          targetSessionID: ids.worker.id,
          text: "must finish", selection,
        })
        const complete = () =>
          Effect.gen(function* () {
            const fresh = yield* service.get(group.id)
            return yield* service.complete(human, { groupID: group.id, expectedRevision: fresh.revision })
          })
        expect(yield* complete().pipe(Effect.flip)).toBeInstanceOf(CoordinationService.OutstandingError)
        yield* service.recordAdmission(system, { groupID: group.id, dispatchID: work.id, messageID: SessionMessage.ID.make("msg_done") })
        yield* service.settleDispatch(system, { groupID: group.id, dispatchID: work.id, outcome: "completed" })
        expect(yield* complete().pipe(Effect.flip)).toBeInstanceOf(CoordinationService.OutstandingError)

        yield* service.release(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          targetSessionID: ids.worker.id,
          generation: claim.generation,
        })
        yield* events.publish(SessionEvent.Review.Deferred, {
          sessionID: ids.worker.id,
          itemID: SessionReview.ID.create(),
          kind: "question",
          reason: "free_text",
          origin: { requestID: "frm_coord" },
          payload: { type: "form", title: "Plan", fields: [{ key: "plan", type: "string", required: true }] },
        })
        expect(yield* complete().pipe(Effect.flip)).toBeInstanceOf(CoordinationService.OutstandingError)
      }),
    ))

  test("completion succeeds once work settles and claims release in a review-free group", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const claim = yield* claimWorker(ids, group)
        yield* service.release(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          targetSessionID: ids.worker.id,
          generation: claim.generation,
        })
        const completed = yield* service.complete(human, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
        })
        expect(completed.status).toBe("completed")
        expect(yield* service.roleFor(ids.worker.id)).toBeUndefined()
      }),
    ))

  test("recover marks armed groups needs-rearm and expires waits without waking work", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const waitID = Coordination.WaitID.make("cwait_boot")
        yield* service.wait(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          waitID,
          targets: [ids.worker.id],
          timeoutMs: 0,
        })
        expect(yield* service.recover()).toBe(1)
        const recovered = yield* service.get(group.id)
        expect(recovered.status).toBe("needs-rearm")
        expect(
          yield* service.wait(actor, { groupID: group.id, expectedRevision: recovered.revision, waitID, timeoutMs: 0 }).pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ConflictError)
        const rearmed = yield* service.arm(human, { groupID: group.id, expectedRevision: recovered.revision })
        expect(rearmed.status).toBe("armed")
        expect(yield* service.recover()).toBe(1)
      }),
    ))

  test("roster updates replace the per-group delegation narrowing and read it back raw", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const group = yield* createGroup(ids)
        const members = group.members.map((member) => ({
          sessionID: member.sessionID,
          role: member.role,
          ...(member.allowedTools ? { allowedTools: member.allowedTools } : {}),
          ...(member.resourceScopes ? { resourceScopes: member.resourceScopes } : {}),
        }))
        const delegated = { categories: ["question" as const], actions: ["read"], expiresAt: Date.now() + 60_000 }
        const updated = yield* service.updateRoster(human, {
          groupID: group.id,
          expectedRevision: group.revision,
          members,
          policy: { concurrency: 3, queueCapacity: 8, delegatedDecisions: delegated },
        })
        expect(updated.policy).toMatchObject({ concurrency: 3, delegatedDecisions: delegated })
        expect((yield* service.roleFor(ids.coordinator.id))?.delegatedDecisions).toMatchObject(delegated)

        const expired = yield* service.updateRoster(human, {
          groupID: group.id,
          expectedRevision: updated.revision,
          members,
          policy: { concurrency: 3, queueCapacity: 8, delegatedDecisions: { categories: ["review"], expiresAt: 1 } },
        })
        expect(expired.policy.delegatedDecisions).toMatchObject({ categories: ["review"] })
        expect((yield* service.roleFor(ids.coordinator.id))?.delegatedDecisions).toMatchObject({
          categories: ["review"],
          expiresAt: 1,
        })

        const disabled = yield* service.updateRoster(human, {
          groupID: group.id,
          expectedRevision: expired.revision,
          members,
          policy: { concurrency: 3, queueCapacity: 8, delegatedDecisions: { categories: [] } },
        })
        expect((yield* service.roleFor(ids.coordinator.id))?.delegatedDecisions).toEqual({ categories: [] })

        const revoked = yield* service.updateRoster(human, {
          groupID: group.id,
          expectedRevision: disabled.revision,
          members,
          policy: { concurrency: 3, queueCapacity: 8 },
        })
        expect(revoked.policy.delegatedDecisions).toBeUndefined()
        expect((yield* service.roleFor(ids.coordinator.id))?.delegatedDecisions).toBeUndefined()
        expect(
          yield* service
            .updateRoster({ kind: "coordinator", sessionID: ids.coordinator.id } as never, {
              groupID: group.id,
              expectedRevision: revoked.revision,
              members,
            })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.ForbiddenError)
      }),
    ))

  test("prepareAdmission commit rolls back the Session event when the fence moved", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const events = yield* EventRuntime.Service
        const database = yield* Database.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const claim = yield* claimWorker(ids, group)
        const current = yield* service.get(group.id)
        const work = yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: current.revision,
          generation: claim.generation,
          targetSessionID: ids.worker.id,
          text: "atomic admission", selection,
        })
        const prepared = yield* service.prepareAdmission(system, {
          groupID: group.id,
          dispatchID: work.id,
          messageID: SessionMessage.ID.make("msg_atomic"),
        })
        expect(prepared.snapshot).toMatchObject({ generation: claim.generation, targetSessionID: ids.worker.id })
        yield* service.release(actor, {
          groupID: group.id,
          expectedRevision: (yield* service.get(group.id)).revision,
          targetSessionID: ids.worker.id,
          generation: claim.generation,
        })
        const before = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, ids.worker.id)).all().pipe(Effect.orDie)
        const exit = yield* events
          .publish(
            SessionEvent.AgentSelected,
            { sessionID: ids.worker.id, agent: Agent.ID.make("review") },
            { commit: prepared.commit },
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        const after = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, ids.worker.id)).all().pipe(Effect.orDie)
        expect(after).toHaveLength(before.length)
        expect(yield* service.dispatches({ groupID: group.id })).toMatchObject([{ id: work.id, status: "pending" }])
        expect((yield* service.receipts({ groupID: group.id })).map((receipt) => receipt.kind)).toEqual(["dispatched"])
      }),
    ))

  test("committed mutations emit one live Updated invalidation and reads emit none", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const events = yield* EventRuntime.Service
        const seen: Array<{ groupID: string; revision: number }> = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === "coordination.updated") seen.push(event.data as { groupID: string; revision: number })
          }),
        )
        const group = yield* createGroup(ids)
        yield* service.get(group.id)
        yield* service.list({})
        yield* service.capacity(group.id)
        yield* service.arm(human, { groupID: group.id, expectedRevision: group.revision })
        yield* unsubscribe
        expect(seen).toEqual([
          { groupID: group.id, revision: 0 },
          { groupID: group.id, revision: 1 },
        ])
      }),
    ))

  test("accessForInput narrows only the promoted admitted assignment", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const database = yield* Database.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids, { concurrency: 1, queueCapacity: 10 })
        const claim = yield* claimWorker(ids, group)
        const dispatch = (text: string, extra?: { allowedTools?: string[]; resourceScope?: string }) =>
          Effect.gen(function* () {
            const current = yield* service.get(group.id)
            return yield* service.dispatch(actor, {
              groupID: group.id,
              expectedRevision: current.revision,
              generation: claim.generation,
              targetSessionID: ids.worker.id,
              text,
              selection,
              ...(extra ?? {}),
            })
          })
        const first = yield* dispatch("assigned", { allowedTools: ["edit", "shell"], resourceScope: "src/api/*" })
        const second = yield* dispatch("queued later")
        expect(second.status).toBe("queued")
        const messageID = SessionMessage.ID.make("msg_coord_assign")
        yield* service.recordAdmission(system, { groupID: group.id, dispatchID: first.id, messageID })

        expect(yield* service.accessForInput({ sessionID: ids.worker.id, messageID })).toBeUndefined()

        const promote = (id: SessionMessage.ID, seq: number, metadata: unknown) =>
          database.db
            .run(
              sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
                VALUES (${id}, ${ids.worker.id}, 'user', ${seq}, 0, 0,
                  ${JSON.stringify({ text: "assigned", files: [], agents: [], time: { created: 0 }, metadata })})`,
            )
            .pipe(Effect.orDie)
        yield* promote(messageID, 9001, {
          inputOrigin: "coordination",
          coordination: {
            groupID: group.id,
            dispatchID: first.id,
            coordinatorSessionID: ids.coordinator.id,
            generation: claim.generation,
          },
        })
        const access = yield* service.accessForInput({ sessionID: ids.worker.id, messageID })
        expect(access).toMatchObject({
          groupID: group.id,
          role: "worker",
          dispatchID: first.id,
          coordinatorSessionID: ids.coordinator.id,
          generation: claim.generation,
          allowedTools: ["edit"],
          resourceScopes: ["src/*"],
          assignmentResourceScope: "src/api/*",
        })
        expect(access?.selection).toEqual(selection)

        const mismatched = SessionMessage.ID.make("msg_coord_mismatch")
        yield* promote(mismatched, 9002, {
          inputOrigin: "coordination",
          coordination: {
            groupID: group.id,
            dispatchID: second.id,
            coordinatorSessionID: ids.coordinator.id,
            generation: claim.generation,
          },
        })
        expect(yield* service.accessForInput({ sessionID: ids.worker.id, messageID: mismatched })).toBeUndefined()
        const humanMessage = SessionMessage.ID.make("msg_human_later")
        yield* promote(humanMessage, 9003, { inputOrigin: "human" })
        expect(yield* service.accessForInput({ sessionID: ids.worker.id, messageID: humanMessage })).toBeUndefined()
        expect(yield* service.accessForInput({ sessionID: ids.worker.id, messageID })).toMatchObject({ dispatchID: first.id })
        expect(
          yield* service.accessForInput({ sessionID: ids.worker.id, messageID: SessionMessage.ID.make("msg_coord_later") }),
        ).toBeUndefined()

        yield* service.settleDispatch(system, { groupID: group.id, dispatchID: first.id, outcome: "completed" })
        expect(yield* service.accessForInput({ sessionID: ids.worker.id, messageID })).toBeUndefined()
      }),
    ))

  test("stopped groups retain admitted assignment bounds until settlement", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const database = yield* Database.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids)
        const claim = yield* claimWorker(ids, group)
        const current = yield* service.get(group.id)
        const work = yield* service.dispatch(actor, {
          groupID: group.id,
          expectedRevision: current.revision,
          generation: claim.generation,
          targetSessionID: ids.worker.id,
          text: "survives stop", selection,
          allowedTools: ["edit"],
        })
        const messageID = SessionMessage.ID.make("msg_coord_stopped")
        yield* service.recordAdmission(system, { groupID: group.id, dispatchID: work.id, messageID })
        yield* database.db
          .run(
            sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
              VALUES (${messageID}, ${ids.worker.id}, 'user', 9001, 0, 0,
                ${JSON.stringify({
                  text: "survives stop",
                  files: [],
                  agents: [],
                  time: { created: 0 },
                  metadata: {
                    inputOrigin: "coordination",
                    coordination: {
                      groupID: group.id,
                      dispatchID: work.id,
                      coordinatorSessionID: ids.coordinator.id,
                      generation: claim.generation,
                    },
                  },
                })})`,
          )
          .pipe(Effect.orDie)
        yield* service.stop(human, { groupID: group.id, expectedRevision: (yield* service.get(group.id)).revision })
        expect(yield* service.accessForInput({ sessionID: ids.worker.id, messageID })).toMatchObject({
          dispatchID: work.id,
          status: "stopped",
          allowedTools: ["edit"],
        })
        yield* service.settleDispatch(system, { groupID: group.id, dispatchID: work.id, outcome: "completed" })
        expect(yield* service.accessForInput({ sessionID: ids.worker.id, messageID })).toBeUndefined()
      }),
    ))

  test("standingRoles returns every armed membership and excludes disarmed or stopped groups", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const sessions = yield* Session.Service
        const coordinator2 = yield* sessions.create({ location: ids.location, title: "coordinator2" })
        const first = yield* armedGroup(ids)
        const second = yield* service.create(human, {
          name: "Second",
          policy: { concurrency: 1, queueCapacity: 4 },
          members: [
            { sessionID: coordinator2.id, role: "coordinator" },
            { sessionID: ids.worker.id, role: "observer" },
          ],
        })
        expect(yield* service.standingRoles(ids.worker.id)).toMatchObject([{ groupID: first.id, role: "worker" }])
        yield* service.arm(human, { groupID: second.id, expectedRevision: second.revision })
        const roles = yield* service.standingRoles(ids.worker.id)
        expect(roles.map((role) => [role.groupID, role.role]).toSorted()).toEqual(
          [
            [first.id, "worker" as const],
            [second.id, "observer" as const],
          ].toSorted(),
        )
        yield* service.stop(human, { groupID: second.id, expectedRevision: (yield* service.get(second.id)).revision })
        expect(yield* service.standingRoles(ids.worker.id)).toMatchObject([{ groupID: first.id, role: "worker" }])
        expect(yield* service.standingRoles(ids.coordinator.id)).toMatchObject([{ groupID: first.id, role: "coordinator" }])
      }),
    ))

  test("at most one pending or admitted dispatch per target preserves each execution choice", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const actor = { kind: "coordinator", sessionID: ids.coordinator.id } as const
        const group = yield* armedGroup(ids, { concurrency: 2, queueCapacity: 10 })
        const claim = yield* claimWorker(ids, group)
        const otherSelection: Coordination.DispatchSelection = {
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({
            providerID: Provider.ID.make("fixture"),
            id: Model.ID.make("model-a"),
            variant: Model.VariantID.make("high"),
          }),
          reason: "Riskier follow-up needs deeper reasoning",
        }
        const dispatch = (text: string, chosen: Coordination.DispatchSelection) =>
          Effect.gen(function* () {
            const current = yield* service.get(group.id)
            return yield* service.dispatch(actor, {
              groupID: group.id,
              expectedRevision: current.revision,
              generation: claim.generation,
              targetSessionID: ids.worker.id,
              text,
              selection: chosen,
            })
          })
        const first = yield* dispatch("first choice", selection)
        expect(first.status).toBe("pending")
        const second = yield* dispatch("second choice", otherSelection)
        expect(second).toMatchObject({ status: "queued", reason: "capacity" })
        expect(second.selection).toEqual(otherSelection)
        yield* service.recordAdmission(system, {
          groupID: group.id,
          dispatchID: first.id,
          messageID: SessionMessage.ID.make("msg_coord_fence"),
        })
        expect(yield* service.advance(system, { groupID: group.id })).toEqual([])
        yield* service.settleDispatch(system, { groupID: group.id, dispatchID: first.id, outcome: "completed" })
        const promoted = yield* service.advance(system, { groupID: group.id })
        expect(promoted).toMatchObject([{ id: second.id, status: "pending" }])
        expect(promoted[0]?.selection).toEqual(otherSelection)
        const receipts = yield* service.receipts({ groupID: group.id })
        for (const receipt of receipts.filter((entry) => entry.dispatchID === first.id)) expect(receipt.selection).toEqual(selection)
        expect(receipts.find((receipt) => receipt.dispatchID === second.id)?.selection).toEqual(otherSelection)
      }),
    ))

  test("roster updates rename the group atomically and preserve the name when omitted", () =>
    run(
      Effect.gen(function* () {
        const ids = yield* setup
        const service = yield* CoordinationService.Service
        const database = yield* Database.Service
        const group = yield* createGroup(ids)
        const members = group.members.map((member) => ({
          sessionID: member.sessionID,
          role: member.role,
          ...(member.allowedTools ? { allowedTools: member.allowedTools } : {}),
          ...(member.resourceScopes ? { resourceScopes: member.resourceScopes } : {}),
        }))
        expect(
          yield* service
            .updateRoster(human, { groupID: group.id, expectedRevision: group.revision, members, name: "" })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.InvalidInputError)
        expect(
          yield* service
            .updateRoster(human, { groupID: group.id, expectedRevision: group.revision, members, name: "x".repeat(121) })
            .pipe(Effect.flip),
        ).toBeInstanceOf(CoordinationService.InvalidInputError)
        const renamed = yield* service.updateRoster(human, {
          groupID: group.id,
          expectedRevision: group.revision,
          members,
          name: "Renamed team",
        })
        expect(renamed.name).toBe("Renamed team")
        expect(renamed.revision).toBe(Coordination.Revision.make(group.revision + 1))
        const stored = yield* database.db
          .get<{ name: string }>(
            sql`SELECT json_extract(data, '$.name') AS name FROM event WHERE aggregate_id = ${group.id} AND type = 'coordination.group.roster-updated.1' ORDER BY seq DESC LIMIT 1`,
          )
          .pipe(Effect.orDie)
        expect(stored?.name).toBe("Renamed team")
        const preserved = yield* service.updateRoster(human, {
          groupID: group.id,
          expectedRevision: renamed.revision,
          members,
        })
        expect(preserved.name).toBe("Renamed team")
      }),
    ))
})
