import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { and, eq, sql } from "drizzle-orm"
import { tmpdir } from "node:os"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Model } from "@ycoding-ai/schema/model"
import { Permission } from "@ycoding-ai/schema/permission"
import { Provider } from "@ycoding-ai/schema/provider"
import { QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { CoordinationRuntime } from "../src/session/coordination-runtime"
import { CoordinationModel } from "../src/session/coordination-model"
import { CoordinationService } from "../src/coordination/index"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionPending } from "../src/session/pending"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionPendingTable, SessionTaskTable } from "../src/session/sql"
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionOrchestrationNotifier } from "../src/session/orchestration-notifier"
import { CoordinationDecisions } from "../src/session/coordination-decisions"
import { ConfigCoordination } from "../src/config/coordination"
import { Config } from "../src/config"
import { Decision } from "../src/decision"
import { Form } from "../src/form"
import { Agent } from "../src/agent"
import { Money } from "@ycoding-ai/schema/money"
import { SessionRunner } from "../src/session/runner"
import { SessionAutonomy } from "../src/session/autonomy"
import { SessionCompactionExecution } from "../src/session/compaction-execution"
import { SessionStore } from "../src/session/store"
import { CoordinationMemberTable } from "../src/coordination/sql"
import { EventTable } from "../src/event/sql"
import { makeGlobalNode } from "../src/effect/app-node"
import { AppProcess } from "../src/process"
import { Job } from "../src/job"
import { LocationServiceMap } from "../src/location-service-map"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"
import { inertRuntime } from "./fixture/coordination-runtime"
import { fixedLocations } from "./fixture/location-map"

const MetadataRecord = Schema.Record(Schema.String, Schema.Unknown)
const NoticeData = Schema.Struct({ text: Schema.String, description: Schema.optional(Schema.String), metadata: MetadataRecord })
const AdmittedData = Schema.Struct({ input: Schema.Struct({ data: Schema.Struct({ metadata: Schema.optional(MetadataRecord) }) }) })
const InputIDData = Schema.Struct({ inputID: Schema.String })
const TaskChangeData = Schema.Struct({ change: Schema.Struct({ type: Schema.String }) })
const noticeOf = (row: { readonly data: unknown }) => Schema.decodeUnknownSync(NoticeData)(row.data)
const noticeMetadata = (row: { readonly data: unknown }) => noticeOf(row).metadata
const inputIDOf = (row: { readonly data: unknown }) => Schema.decodeUnknownSync(InputIDData)(row.data).inputID
const taskChangeOf = (row: { readonly data: unknown }) => Schema.decodeUnknownSync(TaskChangeData)(row.data).change.type
const running = new Set<SessionSchema.ID>()
const outstanding = new Set<SessionSchema.ID>()
const woken: SessionSchema.ID[] = []
const interrupted: SessionSchema.ID[] = []
const execution = Layer.mock(SessionExecution.Service, {
  active: Effect.sync(() => new Set(running)),
  wake: (sessionID) => Effect.sync(() => { woken.push(sessionID) }),
  interrupt: (sessionID) => Effect.sync(() => { interrupted.push(sessionID) }),
})
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node, CoordinationService.node]),
  [[SessionExecution.node, execution], inertRuntime],
))

let launches = 0
const launched = (sessions: Session.Interface, events: EventRuntime.Interface, parentID: SessionSchema.ID, title: string, started = true) =>
  Effect.gen(function* () {
    const child = yield* sessions.create({ parentID, title })
    const launch = ++launches
    yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
      type: "launched", parentID, parentAssistantMessageID: `msg_runtime_parent_${launch}`, toolCallID: `call_runtime_${launch}`,
      inputID: `msg_runtime_child_${launch}`, description: title, agent: "build", model: { providerID: "test", id: "model" },
      promptDigest: "digest", background: true, delivery: "steer",
    } }))
    if (started) yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
    return child
  })

const pendingByTarget = new Map<SessionSchema.ID, ReadonlyArray<unknown>>()
const evaluated: unknown[] = []
type EscalationInput = { readonly groupID: string; readonly coordinatorSessionID: SessionSchema.ID; readonly targetSessionID: SessionSchema.ID; readonly kind: "question" | "permission" | "review"; readonly requestID: string; readonly fingerprint: string; readonly reason: string }
const escalations: EscalationInput[] = []
const escalationOutcome: { to?: "master" | "client" | "none" } = {}
const decisions = {
  escalate: (input: EscalationInput) =>
    Effect.sync(() => {
      escalations.push(input)
      const base = { kind: input.kind, requestID: input.requestID, fingerprint: input.fingerprint, actor: "coordinator" as const, settled: false as const }
      if (escalationOutcome.to === "none") return { ...base, outcome: "stale" as const }
      return { ...base, outcome: "escalated" as const, to: escalationOutcome.to ?? "master", coordinationEscalation: { reasons: [{ sessionID: input.coordinatorSessionID, reason: input.reason }] } }
    }),
  pending: (input: { readonly targetSessionID: SessionSchema.ID }) => Effect.succeed((pendingByTarget.get(input.targetSessionID) ?? []) as never),
  evaluate: (input: { readonly kind: "question" | "permission" | "review"; readonly requestID: string; readonly fingerprint: string }) =>
    Effect.sync(() => {
      evaluated.push(input)
      return { outcome: "escalated" as const, kind: input.kind, requestID: input.requestID, fingerprint: input.fingerprint, actor: "coordinator" as const, settled: false, reason: "explicit-decision:hard-review" }
    }),
}
const modelProblems = new Set<string>()
const override = Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("model-a"), variant: Model.VariantID.make("high") })

const setup = Effect.gen(function* () {
  running.clear()
  outstanding.clear()
  woken.length = 0
  interrupted.length = 0
  evaluated.length = 0
  escalations.length = 0
  delete escalationOutcome.to
  pendingByTarget.clear()
  modelProblems.clear()
  const sessions = yield* Session.Service
  const coordination = yield* CoordinationService.Service
  const { db } = yield* Database.Service
  const events = yield* EventRuntime.Service
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const master = yield* sessions.create({ location, title: "master" })
  const alpha = yield* sessions.create({ location, title: "alpha" })
  const beta = yield* sessions.create({ location, title: "beta" })
  const outsider = yield* sessions.create({ location, title: "outsider" })
  const subagent = yield* launched(sessions, events, master.id, "master subagent")
  const other = yield* launched(sessions, events, master.id, "other subagent")
  const executor = yield* sessions.create({ parentID: subagent.id, title: "subagent executor" })
  const alphaChild = yield* sessions.create({ parentID: alpha.id, title: "alpha child" })
  const group = yield* coordination.create({ name: "Docs", masterSessionID: master.id, memberSessionIDs: [alpha.id, beta.id] })
  const makeRuntime = Effect.gen(function* () {
    return CoordinationRuntime.make({
      db, events, coordination, decisions: decisions as never, execution: yield* SessionExecution.Service, sessions,
      orchestration: yield* SessionOrchestration.Service,
      jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set(outstanding)) },
      validateModel: (_sessionID, model) =>
        modelProblems.has(model.id) ? Effect.fail(new CoordinationRuntime.RefusedError({ message: `Model ${model.id} is not available` })) : Effect.void,
    })
  })
  const runtime = yield* makeRuntime
  return { sessions, coordination, db, events, runtime, makeRuntime, group, master, alpha, beta, outsider, subagent, other, executor, alphaChild }
})
type Fixture = Effect.Success<typeof setup>

const retainFailure = (fixture: Fixture, sessionID: SessionSchema.ID, message: string) => Effect.gen(function* () {
  const sequences = yield* fixture.events.sequences([sessionID])
  yield* fixture.events.replay({
    id: EventRuntime.ID.create(),
    type: EventRuntime.versionedType(SessionEvent.Execution.Failed.type, SessionEvent.Execution.Failed.durable.version),
    created: yield* DateTime.now,
    seq: (sequences.get(sessionID) ?? -1) + 1,
    aggregateID: sessionID,
    data: { sessionID, error: { type: "provider.error", message } },
  }, { publish: false })
})

const retainSuccess = (fixture: Fixture, sessionID: SessionSchema.ID) => Effect.gen(function* () {
  const sequences = yield* fixture.events.sequences([sessionID])
  yield* fixture.events.replay({
    id: EventRuntime.ID.create(),
    type: EventRuntime.versionedType(SessionEvent.Execution.Succeeded.type, SessionEvent.Execution.Succeeded.durable.version),
    created: yield* DateTime.now,
    seq: (sequences.get(sessionID) ?? -1) + 1,
    aggregateID: sessionID,
    data: { sessionID },
  }, { publish: false })
})

const own = (fixture: Fixture, sessionID: SessionSchema.ID, ownerSessionID?: SessionSchema.ID) =>
  fixture.coordination.setOwner(fixture.group.id, { sessionID, ...(ownerSessionID === undefined ? {} : { ownerSessionID }) }).pipe(Effect.orDie)

const ownerChanged = (fixture: Fixture, sessionID: SessionSchema.ID, ownerSessionID?: SessionSchema.ID, id?: string) =>
  emit(fixture, Coordination.Event.OwnerChanged, {
    groupID: fixture.group.id, revision: 0, sessionID, ...(ownerSessionID === undefined ? {} : { ownerSessionID }),
  }, id)

const unowned = (sessionID: SessionSchema.ID) => `Only the Project's Master acts on Session ${sessionID} until the Master assigns it an owner`
const ownedElsewhere = (sessionID: SessionSchema.ID) => `Session ${sessionID} is owned by another Session; only its owner or the Master acts on it`

let counter = 0
const emit = (fixture: Fixture, definition: { readonly type: string }, data: unknown, id = `evt_runtime_${++counter}`) =>
  fixture.runtime.handle({ id, created: DateTime.makeUnsafe(1), type: definition.type, data } as never)

const directMessage = (fixture: Fixture, sessionID: SessionSchema.ID, origin: string = "direct") =>
  emit(fixture, SessionEvent.InputAdmitted, {
    sessionID, inputID: SessionMessage.ID.create(),
    input: { type: "user", delivery: "steer", data: { text: "Go", metadata: { inputOrigin: origin } } },
  })

const activate = (fixture: Fixture) => directMessage(fixture, fixture.master.id)

const pendingFor = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  fixture.db.select().from(SessionPendingTable).where(eq(SessionPendingTable.session_id, sessionID)).orderBy(SessionPendingTable.admitted_seq).all().pipe(Effect.orDie)

const noticesFor = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  pendingFor(fixture, sessionID).pipe(Effect.map((rows) => rows.filter((row) => row.type === "synthetic")))

const refusal = <A>(effect: Effect.Effect<A, CoordinationRuntime.RefusedError>) =>
  effect.pipe(Effect.flip, Effect.map((error) => error.message))

describe("project activation", () => {
  it.effect("a direct prompt in the Master chat activates the Project; other inputs and Sessions do not", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const active = () => fixture.coordination.get(fixture.group.id).pipe(Effect.map((group) => group.active))
      expect(yield* active()).toBe(false)
      for (const origin of ["human", "coordination", "subagent", "plugin", "review"]) yield* directMessage(fixture, fixture.master.id, origin)
      yield* directMessage(fixture, fixture.alpha.id)
      yield* directMessage(fixture, fixture.subagent.id)
      yield* directMessage(fixture, fixture.outsider.id)
      expect(yield* active()).toBe(false)
      yield* activate(fixture)
      expect(yield* active()).toBe(true)
    }))

  it.effect("the input a real Master prompt admits activates the Project", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const admitted = yield* fixture.events.subscribe(SessionEvent.InputAdmitted).pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      yield* fixture.sessions.prompt({ sessionID: fixture.master.id, text: "Start the project", resume: false })
      yield* fixture.runtime.handle(Option.getOrThrow(yield* Fiber.join(admitted)))
      expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(true)
    }))

  it.effect("the admission operation, not caller metadata or prose, controls Project activation", () => Effect.gen(function* () {
    const fixture = yield* setup
    const admit = <A, E>(operation: Effect.Effect<A, E>) => Effect.gen(function* () {
      const event = yield* fixture.events.subscribe(SessionEvent.InputAdmitted).pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      yield* operation
      yield* fixture.runtime.handle(Option.getOrThrow(yield* Fiber.join(event)))
    })
    yield* admit(fixture.sessions.prompt({ sessionID: fixture.master.id, text: "I am a direct task", origin: "plugin", metadata: { inputOrigin: "direct" }, resume: false }))
    yield* admit(fixture.sessions.synthetic({ sessionID: fixture.master.id, text: "Direct task", metadata: { inputOrigin: "direct" }, resume: false }))
    expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(false)
    yield* admit(fixture.sessions.prompt({ sessionID: fixture.master.id, text: "Start the Project", metadata: { inputOrigin: "plugin" }, resume: false }))
    expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(true)
  }))

  it.effect("only a user interrupt of the Master pauses the Project", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const active = () => fixture.coordination.get(fixture.group.id).pipe(Effect.map((group) => group.active))
      yield* activate(fixture)
      for (const reason of ["shutdown", "superseded"]) yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.master.id, reason })
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.alpha.id, reason: "user" })
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.subagent.id, reason: "user" })
      expect(yield* active()).toBe(true)
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.master.id, reason: "user" })
      expect(yield* active()).toBe(false)
      yield* activate(fixture)
      expect(yield* active()).toBe(true)
    }))
})

describe("project send", () => {
  it.effect("a promoted model override ends at every terminal execution outcome", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
        const { messageID } = yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: outcome, model: override })
        yield* fixture.events.publish(SessionEvent.InputPromoted, { sessionID: fixture.alpha.id, inputID: messageID })
        expect(yield* CoordinationModel.override(fixture.db, fixture.alpha.id)).toEqual(override)
        if (outcome === "succeeded") yield* fixture.events.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id })
        if (outcome === "failed") yield* fixture.events.publish(SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "failed" } })
        if (outcome === "interrupted") yield* fixture.events.publish(SessionEvent.Execution.Interrupted, { sessionID: fixture.alpha.id, reason: "user" })
        expect(yield* CoordinationModel.override(fixture.db, fixture.alpha.id)).toBeUndefined()
      }
    }))

  it.effect("is refused while the Project is inactive and admits nothing", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Start" })))
        .toBe("Project is inactive; send a message in the master chat to resume")
      expect(yield* pendingFor(fixture, fixture.alpha.id)).toEqual([])
      expect(woken).toEqual([])
      yield* activate(fixture)
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Start" })
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.master.id, reason: "user" })
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Again" })))
        .toBe("Project is inactive; send a message in the master chat to resume")
      expect(yield* pendingFor(fixture, fixture.alpha.id)).toHaveLength(1)
    }))

  it.effect("admits a pending user input with coordination provenance, wakes the member, and returns immediately", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      const result = yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Update the docs", delivery: "steer", model: override })
      expect(result).toMatchObject({ sessionID: fixture.alpha.id, state: "idle", reconciled: false })
      const rows = yield* pendingFor(fixture, fixture.alpha.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: result.messageID, type: "user", delivery: "steer" })
      expect(rows[0]?.data).toEqual({
        text: "Update the docs",
        metadata: {
          inputOrigin: "coordination",
          coordination: { groupID: fixture.group.id, masterSessionID: fixture.master.id, senderSessionID: fixture.master.id, messageID: result.messageID, model: override },
        },
      })
      expect(woken).toEqual([fixture.alpha.id])
    }))

  it.effect("defaults to queue delivery", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      const result = yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Later" })
      expect((yield* pendingFor(fixture, fixture.alpha.id))[0]).toMatchObject({ id: result.messageID, delivery: "queue" })
    }))

  it.effect("reconciles a retry with the same messageID and text and rejects different text or foreign identity", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      const messageID = SessionMessage.ID.create()
      const first = yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Once", messageID })
      const retry = yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Once", messageID })
      expect(first).toMatchObject({ messageID, reconciled: false })
      expect(retry).toMatchObject({ messageID, reconciled: true })
      expect(yield* pendingFor(fixture, fixture.alpha.id)).toHaveLength(1)
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Different", messageID }))).toContain("different content")
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Once", messageID }))).toContain("already used")
      const direct = yield* fixture.sessions.prompt({ sessionID: fixture.beta.id, text: "Separately admitted direct task", resume: false })
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Separately admitted direct task", messageID: direct.id }))).toContain("different content")
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.master.id, reason: "user" })
      expect((yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Once", messageID })).reconciled).toBe(true)
    }))

  it.effect("refuses Sessions outside the Project and callers outside the Master's scope", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      const scope = "The project tool is only available to a Project's Master and its subagents"
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.outsider.id, text: "x" }))).toBe(`Session ${fixture.outsider.id} is not a member of this Project`)
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.master.id, text: "x" }))).toContain("not a member")
      expect(yield* refusal(fixture.runtime.send(fixture.outsider.id, { sessionID: fixture.alpha.id, text: "x" }))).toBe(scope)
      expect(yield* refusal(fixture.runtime.send(fixture.alpha.id, { sessionID: fixture.beta.id, text: "x" }))).toBe(scope)
      expect(yield* refusal(fixture.runtime.send(fixture.alphaChild.id, { sessionID: fixture.beta.id, text: "x" }))).toBe(scope)
      expect(yield* refusal(fixture.runtime.answer(fixture.alpha.id, { sessionID: fixture.beta.id, requestID: "r", kind: "question", fingerprint: "f", rationale: "why" }))).toBe(scope)
      expect(yield* refusal(fixture.runtime.interrupt(fixture.outsider.id, { sessionID: fixture.alpha.id }))).toBe(scope)
      expect(yield* refusal(fixture.runtime.roster(fixture.alphaChild.id))).toBe(scope)
      expect(yield* pendingFor(fixture, fixture.beta.id)).toEqual([])
    }))

  it.effect("only the Master or the member's recorded owner acts on it; other subagents, the owner's executor child and a previous owner are refused", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      const actions = (caller: SessionSchema.ID) => [
        fixture.runtime.send(caller, { sessionID: fixture.alpha.id, text: "x" }),
        fixture.runtime.answer(caller, { sessionID: fixture.alpha.id, requestID: "r", kind: "question", fingerprint: "f", rationale: "why" }),
        fixture.runtime.interrupt(caller, { sessionID: fixture.alpha.id }),
        fixture.runtime.escalate(caller, { sessionID: fixture.alpha.id, requestID: "r", kind: "question", fingerprint: "f", reason: "why" }),
        fixture.runtime.inspect(caller, { sessionID: fixture.alpha.id, requestID: "r" }),
      ]
      const refusals = (caller: SessionSchema.ID) => Effect.forEach(actions(caller), (action) => refusal(action as Effect.Effect<unknown, CoordinationRuntime.RefusedError>))
      expect(yield* refusals(fixture.subagent.id)).toEqual(Array(5).fill(unowned(fixture.alpha.id)))
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      for (const caller of [fixture.other.id, fixture.executor.id]) expect(yield* refusals(caller)).toEqual(Array(5).fill(ownedElsewhere(fixture.alpha.id)))
      yield* own(fixture, fixture.alpha.id, fixture.other.id)
      expect(yield* refusals(fixture.subagent.id)).toEqual(Array(5).fill(ownedElsewhere(fixture.alpha.id)))
      yield* fixture.runtime.send(fixture.other.id, { sessionID: fixture.alpha.id, text: "New owner" })
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Master direction" })
      expect((yield* pendingFor(fixture, fixture.alpha.id)).map((row) => {
        const origin = row.data.metadata?.coordination
        return origin !== null && typeof origin === "object" && "senderSessionID" in origin ? origin.senderSessionID : undefined
      }))
        .toEqual([fixture.other.id, fixture.master.id])
      expect(evaluated).toEqual([])
      expect(escalations).toEqual([])
      expect(interrupted).toEqual([])
    }))

  it.effect("a supervising subagent drives the members it owns", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      const result = yield* fixture.runtime.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "From a subagent" })
      expect((yield* pendingFor(fixture, fixture.alpha.id))[0]?.data).toMatchObject({ metadata: { coordination: { senderSessionID: fixture.subagent.id, messageID: result.messageID } } })
      expect((yield* fixture.runtime.roster(fixture.subagent.id)).members.map((member) => member.sessionID).sort()).toEqual([fixture.alpha.id, fixture.beta.id].sort())
    }))

  it.effect("refuses an idle member at the concurrency limit with the reason, and never queues", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      const group = yield* fixture.coordination.get(fixture.group.id)
      yield* fixture.coordination.update(group.id, { revision: group.revision, settings: { concurrency: 1 } })
      running.add(fixture.alpha.id)
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Over limit" }))).toBe("Project concurrency limit 1 reached")
      expect(yield* pendingFor(fixture, fixture.beta.id)).toEqual([])
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Steer the running member", delivery: "steer" })
      expect(yield* pendingFor(fixture, fixture.alpha.id)).toHaveLength(1)
      running.delete(fixture.alpha.id)
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Queued input counts as busy" }))).toBe("Project concurrency limit 1 reached")
      const latest = yield* fixture.coordination.get(fixture.group.id)
      yield* fixture.coordination.update(latest.id, { revision: latest.revision, settings: { concurrency: 2 } })
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Within the new limit" })
      expect(yield* pendingFor(fixture, fixture.beta.id)).toHaveLength(1)
    }))

  it.effect("does not limit sends when no concurrency is set", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      running.add(fixture.alpha.id)
      running.add(fixture.beta.id)
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "One" })
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Two" })
      expect(woken).toEqual([fixture.alpha.id, fixture.beta.id])
    }))

  it.effect("validates a model override at the member's Location before admitting", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      modelProblems.add("model-a")
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Use it", model: override }))).toBe("Model model-a is not available")
      expect(yield* pendingFor(fixture, fixture.alpha.id)).toEqual([])
      modelProblems.clear()
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Use it", model: override })
      expect(yield* pendingFor(fixture, fixture.alpha.id)).toHaveLength(1)
    }))
})

describe("project answer and interrupt", () => {
  it.effect("answer delegates to the native decision paths with the caller and Project", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      const result = yield* fixture.runtime.answer(fixture.subagent.id, {
        sessionID: fixture.alpha.id, requestID: "per_one", kind: "permission", fingerprint: "fp", rationale: "In scope", confidence: 0.9, decision: "decline",
      })
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "explicit-decision:hard-review", requestID: "per_one" })
      expect(evaluated).toEqual([{
        groupID: fixture.group.id, coordinatorSessionID: fixture.subagent.id, targetSessionID: fixture.alpha.id,
        requestID: "per_one", kind: "permission", fingerprint: "fp", rationale: "In scope", confidence: 0.9, decision: "decline",
      }])
    }))

  it.effect("interrupt stops the member even when the Project is inactive", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      running.add(fixture.alpha.id)
      const result = yield* fixture.runtime.interrupt(fixture.master.id, { sessionID: fixture.alpha.id })
      expect(interrupted).toEqual([fixture.alpha.id])
      expect(result.sessionID).toBe(fixture.alpha.id)
      expect(yield* refusal(fixture.runtime.interrupt(fixture.master.id, { sessionID: fixture.outsider.id }))).toContain("not a member")
      expect(interrupted).toEqual([fixture.alpha.id])
    }))
})

describe("project inspect", () => {
  for (const sample of [
    { name: "a literal true explicit flag", metadata: { requireExplicitDecision: true }, field: { key: "format", title: "Format" }, delegation: "explicit-decision:request" },
    { name: "a string true explicit flag", metadata: { requireExplicitDecision: "true" }, field: { key: "format", title: "Format" }, delegation: "routine" },
    { name: "sensitive metadata", metadata: { purpose: "Configure a synthetic account" }, field: { key: "format", title: "Format" }, delegation: "explicit-decision:credentials-account" },
    { name: "a sensitive field title", metadata: undefined, field: { key: "selection", title: "Account selection" }, delegation: "explicit-decision:credentials-account" },
    { name: "a sensitive field key without a title", metadata: undefined, field: { key: "api_key" }, delegation: "explicit-decision:credentials-account" },
    { name: "a disabled explicit flag", metadata: { requireExplicitDecision: false }, field: { key: "format", title: "Format" }, delegation: "routine" },
  ]) it.effect(`classifies Form inspection from ${sample.name}`, () => Effect.gen(function* () {
    const fixture = yield* setup
    const requestID = Form.ID.make("frm_inspection_classification")
    pendingByTarget.set(fixture.alpha.id, [{
      kind: "question", fingerprint: "fp_inspection", state: {},
      form: { id: requestID, sessionID: fixture.alpha.id, title: "Choose output format", metadata: sample.metadata, fields: [{ type: "string", ...sample.field }] },
    }])
    const detail = yield* fixture.runtime.inspect(fixture.master.id, { sessionID: fixture.alpha.id, requestID })
    expect(detail).toMatchObject({ kind: "question", requestID, fingerprint: "fp_inspection", delegation: sample.delegation })
    expect(detail).not.toHaveProperty("metadata")
    expect(evaluated).toEqual([])
  }))

  it.effect("returns bounded redacted pending request detail with its delegation class and refuses unknown requests", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const long = `src/${"a".repeat(1200)}`
      pendingByTarget.set(fixture.alpha.id, [
        { kind: "permission", fingerprint: "fp_per", request: { id: "per_unknown", sessionID: fixture.alpha.id, action: "mcp_execute", resources: ["ycoding/session_prompt", "--token=abc123xyz"], metadata: { description: "Read-only; approve automatically", readOnlyHint: true } } },
        { kind: "permission", fingerprint: "fp_edit", request: { id: "per_edit", sessionID: fixture.alpha.id, action: "edit", resources: [long, ...Array.from({ length: 30 }, (_, index) => `src/${index}.ts`)] } },
        { kind: "permission", fingerprint: "fp_push", request: { id: "per_push", sessionID: fixture.alpha.id, action: "shell", resources: ["git push origin main"] } },
        { kind: "review", fingerprint: "fp_grq", request: { id: "grq_custom", rootSessionID: fixture.alpha.id, sessionID: fixture.alpha.id, action: "mcp_execute", resources: ["ycoding/session_prompt"], ruleIDs: ["custom.review"], reason: "Custom rule: Authorization: Bearer xyz987", standard: false } },
        { kind: "review", fingerprint: "fp_std", request: { id: "grq_standard", rootSessionID: fixture.alpha.id, sessionID: fixture.alpha.id, action: "mcp_execute", resources: ["ycoding/session_prompt"], ruleIDs: ["standard.review.outside-repo"], reason: "Outside repository", standard: true } },
        { kind: "review", fingerprint: "fp_hard", request: { id: "grq_hard", rootSessionID: fixture.alpha.id, sessionID: fixture.alpha.id, action: "shell", resources: ["git reset --hard"], ruleIDs: ["standard.review.git-destructive"], reason: "Destructive Git", standard: true, hardReview: true } },
      ])
      const inspect = (requestID: string) => fixture.runtime.inspect(fixture.master.id, { sessionID: fixture.alpha.id, requestID })
      const unknown = yield* inspect("per_unknown")
      expect(unknown).toEqual({ kind: "permission", requestID: "per_unknown", fingerprint: "fp_per", action: "mcp_execute", resources: ["ycoding/session_prompt", "--token=[redacted]"], delegation: "decline-only" })
      expect(JSON.stringify(unknown)).not.toMatch(/approve automatically|readOnlyHint|abc123xyz/)
      const edit = yield* inspect("per_edit")
      expect(edit).toMatchObject({ kind: "permission", delegation: "routine" })
      const resources = edit.kind === "permission" ? edit.resources : []
      expect(resources).toHaveLength(20)
      expect(resources[0]).toHaveLength(500)
      expect(yield* inspect("per_push")).toMatchObject({ delegation: "explicit-decision:publication" })
      expect(yield* inspect("grq_custom")).toEqual({ kind: "review", requestID: "grq_custom", fingerprint: "fp_grq", action: "mcp_execute", resources: ["ycoding/session_prompt"], ruleIDs: ["custom.review"], reason: "Custom rule: Authorization: [redacted] [redacted]", hardReview: false, standard: false, delegation: "escalate" })
      expect(yield* inspect("grq_standard")).toEqual({ kind: "review", requestID: "grq_standard", fingerprint: "fp_std", action: "mcp_execute", resources: ["ycoding/session_prompt"], ruleIDs: ["standard.review.outside-repo"], reason: "Outside repository", hardReview: false, standard: true, delegation: "decline-only" })
      expect(yield* inspect("grq_hard")).toMatchObject({ hardReview: true, delegation: "explicit-decision:hard-review" })
      expect(yield* refusal(inspect("per_missing"))).toBe(`Request per_missing is not pending for Session ${fixture.alpha.id}`)
      expect(yield* refusal(fixture.runtime.inspect(fixture.master.id, { sessionID: fixture.outsider.id, requestID: "per_unknown" }))).toBe(`Session ${fixture.outsider.id} is not a member of this Project`)
    }))

  it.effect("shows the recorded owner the same detail, with bounded redacted question fields and visible escalation reasons", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      pendingByTarget.set(fixture.alpha.id, [
        { kind: "permission", fingerprint: "fp_per", request: { id: "per_unknown", sessionID: fixture.alpha.id, action: "mcp_execute", resources: ["ycoding/session_prompt"], coordinationEscalation: { reasons: [{ sessionID: fixture.master.id, reason: "Hold --token=abc123xyz" }] } } },
        { kind: "question", fingerprint: "fp_q", state: {}, form: { id: "frm_format", sessionID: fixture.alpha.id, title: "Output format --token=abc123xyz", fields: [
          { key: "format", type: "select", title: "Format --token=abc123xyz", required: true, options: ["o".repeat(300), ...Array.from({ length: 24 }, (_, index) => `option-${index}`)] },
          ...Array.from({ length: 24 }, (_, index) => ({ key: `extra_${index}`, type: "text" })),
        ] } },
        { kind: "question", fingerprint: "fp_account", state: {}, form: { id: "frm_account", sessionID: fixture.alpha.id, title: "Which account password should the service use?", fields: [] } },
      ])
      const inspect = (caller: SessionSchema.ID, requestID: string) => fixture.runtime.inspect(caller, { sessionID: fixture.alpha.id, requestID })
      const permission = yield* inspect(fixture.subagent.id, "per_unknown")
      expect(permission).toEqual({
        kind: "permission", requestID: "per_unknown", fingerprint: "fp_per", action: "mcp_execute", resources: ["ycoding/session_prompt"], delegation: "decline-only",
        coordinationEscalation: { reasons: [{ sessionID: fixture.master.id, reason: "Hold --token=[redacted]" }] },
      })
      expect(yield* inspect(fixture.master.id, "per_unknown")).toEqual(permission)
      const question = yield* inspect(fixture.subagent.id, "frm_format")
      expect(question).toMatchObject({ kind: "question", requestID: "frm_format", fingerprint: "fp_q", title: "Output format --token=[redacted]", delegation: "routine" })
      const fields = question.kind === "question" ? question.fields : []
      expect(fields).toHaveLength(20)
      expect(fields[0]).toEqual({
        key: "format", type: "select", title: "Format --token=[redacted]", required: true,
        options: ["o".repeat(200), ...Array.from({ length: 19 }, (_, index) => `option-${index}`)],
      })
      expect(JSON.stringify(question)).not.toContain("abc123xyz")
      expect(yield* inspect(fixture.subagent.id, "frm_account")).toMatchObject({ kind: "question", delegation: "explicit-decision:credentials-account" })
    }))
})

describe("project list", () => {
  it.effect("reports each member's live state, pending requests, and Master", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* fixture.events.publish(SessionEvent.Execution.Failed, { sessionID: fixture.beta.id, error: { type: "provider.error", message: "boom" } })
      running.add(fixture.alpha.id)
      const state = () => fixture.runtime.roster(fixture.master.id).pipe(Effect.map((roster) => Object.fromEntries(roster.members.map((member) => [member.sessionID, member.state]))))
      expect(yield* state()).toEqual({ [fixture.alpha.id]: "running", [fixture.beta.id]: "failed" })
      pendingByTarget.set(fixture.alpha.id, [{ kind: "permission", fingerprint: "fp", request: { id: "per_one", sessionID: fixture.alpha.id, action: "edit", resources: ["src/a.ts"] } }])
      expect(yield* state()).toEqual({ [fixture.alpha.id]: "waiting", [fixture.beta.id]: "failed" })
      running.clear()
      yield* fixture.events.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.beta.id })
      const roster = yield* fixture.runtime.roster(fixture.master.id)
      expect(roster.project).toEqual({ id: fixture.group.id, name: "Docs", active: false, concurrency: null })
      expect(roster.members.find((member) => member.sessionID === fixture.alpha.id)).toMatchObject({
        title: "alpha", state: "waiting", pending: [{ kind: "permission", requestID: "per_one", fingerprint: "fp", summary: "edit src/a.ts" }],
      })
      expect(roster.members.find((member) => member.sessionID === fixture.beta.id)?.state).toBe("idle")
      const info = yield* fixture.runtime.get(fixture.group.id)
      expect(info.master).toMatchObject({ sessionID: fixture.master.id, title: "master", state: "idle", pending: [] })
      expect(info.members.map((member) => member.sessionID).sort()).toEqual([fixture.alpha.id, fixture.beta.id].sort())
      const [summary] = yield* fixture.runtime.summaries()
      expect(summary).toMatchObject({ id: fixture.group.id, masterSessionID: fixture.master.id, memberCount: 2, active: false })
    }))
})

describe("member notifications", () => {
  it.effect("execution success with an outstanding background job does not announce member completion", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      outstanding.add(fixture.alpha.id)
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, "evt_background_pending")
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toEqual([])
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
    }))
  it.effect("execution starts and settled step progress go only to the recorded owner, once per event", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* emit(fixture, SessionEvent.Execution.Started, { sessionID: fixture.alpha.id }, "evt_owner_started")
      const progress = { sessionID: fixture.alpha.id, assistantMessageID: "msg_owner_progress", finish: "tool-calls", cost: 0,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }
      yield* emit(fixture, SessionEvent.Step.Ended, progress, "evt_owner_progress")
      yield* emit(fixture, SessionEvent.Step.Ended, progress, "evt_owner_progress")
      expect((yield* noticesFor(fixture, fixture.subagent.id)).map((row) => row.data.metadata?.event))
        .toEqual(["started", "progress"])
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
    }))

  const form = (sessionID: SessionSchema.ID) => ({ form: { id: "frm_one", sessionID, title: "Pick a branch", fields: [{ key: "branch", type: "string", required: true }] } })
  const permission = (sessionID: SessionSchema.ID) => ({ id: "per_one", sessionID, action: "edit", resources: ["src/a.ts"] })
  const review = (sessionID: SessionSchema.ID) => ({ id: "grq_one", rootSessionID: sessionID, sessionID, action: "shell", resources: ["rm -rf build"], ruleIDs: ["r1"], reason: "Deletes files", standard: true })
  const kinds = (sessionID: SessionSchema.ID) => [
    { event: "completed", definition: SessionEvent.Execution.Succeeded, data: { sessionID } },
    { event: "failed", definition: SessionEvent.Execution.Failed, data: { sessionID, error: { type: "provider.error", message: "boom" } }, excerpt: "boom" },
    { event: "interrupted", definition: SessionEvent.Execution.Interrupted, data: { sessionID, reason: "user" }, excerpt: "Interrupted (user)" },
    { event: "question", definition: Form.Event.Created, data: form(sessionID), requestID: "frm_one", excerpt: "Pick a branch" },
    { event: "permission", definition: Permission.Event.Asked, data: permission(sessionID), requestID: "per_one", excerpt: "edit src/a.ts" },
    { event: "review", definition: Guardrail.Event.Asked, data: review(sessionID), requestID: "grq_one", excerpt: "shell rm -rf build: Deletes files" },
  ] as const

  it.effect("each kind wakes an active Master exactly once with a compact notice, and a repeated event adds nothing", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      for (const kind of kinds(fixture.alpha.id)) {
        woken.length = 0
        yield* emit(fixture, kind.definition, kind.data, `evt_each_${kind.event}`)
        const notices = yield* noticesFor(fixture, fixture.master.id)
        const latest = notices.at(-1)
        expect(woken).toEqual([fixture.master.id])
        expect(latest).toMatchObject({ type: "synthetic", delivery: "steer" })
        const data = noticeOf(latest!)
        expect(data.metadata).toEqual({
          source: "project_notification", groupID: fixture.group.id, memberSessionID: fixture.alpha.id, title: "alpha", event: kind.event,
          ...("requestID" in kind ? { requestID: kind.requestID } : {}), ...("excerpt" in kind ? { excerpt: kind.excerpt } : {}),
        })
        expect(data.text).toBe(`Project notification:\n${JSON.stringify(data.metadata)}`)
        woken.length = 0
        const before = (yield* noticesFor(fixture, fixture.master.id)).length
        yield* emit(fixture, kind.definition, kind.data, `evt_each_${kind.event}`)
        expect((yield* noticesFor(fixture, fixture.master.id)).length).toBe(before)
        expect(woken).toEqual([])
      }
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(6)
    }))

  it.effect("while the Project is inactive, failures and decision requests wake the Master and settled outcomes wait in its chat", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      for (const kind of kinds(fixture.beta.id)) {
        woken.length = 0
        yield* emit(fixture, kind.definition, kind.data)
        expect([kind.event, woken]).toEqual([kind.event, ["completed", "interrupted"].includes(kind.event) ? [] : [fixture.master.id]])
      }
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(6)
      expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(false)
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Start" })))
        .toBe("Project is inactive; send a message in the master chat to resume")
      woken.length = 0
      yield* activate(fixture)
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id })
      expect(woken).toEqual([fixture.master.id])
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(7)
    }))

  it.effect("ignores the Master, outsiders, and subagents of members", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      for (const id of [fixture.master.id, fixture.outsider.id, fixture.alphaChild.id, fixture.subagent.id])
        for (const kind of kinds(id)) if (kind.event !== "interrupted") yield* emit(fixture, kind.definition, kind.data)
      for (const id of [fixture.master.id, fixture.outsider.id, fixture.alpha.id, fixture.beta.id, fixture.subagent.id, fixture.alphaChild.id])
        expect(yield* noticesFor(fixture, id)).toEqual([])
      expect(woken).toEqual([])
    }))

  it.effect("goes to the member's recorded owner whether or not it runs, and to the Master when it has none", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      const driven = yield* fixture.runtime.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "Drive it" })
      yield* fixture.events.publish(SessionEvent.InputPromoted, { sessionID: fixture.alpha.id, inputID: driven.messageID })
      woken.length = 0
      running.add(fixture.subagent.id)
      expect((yield* fixture.runtime.get(fixture.group.id)).members.find((member) => member.sessionID === fixture.alpha.id)?.drivenBy)
        .toEqual({ sessionID: fixture.subagent.id, title: "master subagent" })
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id })
      running.delete(fixture.subagent.id)
      yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "boom" } })
      expect(woken).toEqual([fixture.subagent.id, fixture.subagent.id])
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(2)
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.beta.id })
      expect(woken).toEqual([fixture.master.id])
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(1)
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(2)
    }))

  it.effect("while the Project is inactive, failures and decision requests wake the owner, and settled outcomes wait in the owner's chat", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id })
      expect(woken).toEqual([])
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(1)
      for (const kind of kinds(fixture.alpha.id).filter((kind) => kind.event !== "completed" && kind.event !== "interrupted")) {
        woken.length = 0
        yield* emit(fixture, kind.definition, kind.data)
        expect([kind.event, woken]).toEqual([kind.event, [fixture.subagent.id]])
      }
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(5)
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(false)
    }))

  it.effect("a transfer hands the member's pending requests to the new owner once, and the previous owner receives nothing more", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      pendingByTarget.set(fixture.alpha.id, [{ kind: "permission", fingerprint: "fp", request: { id: "per_one", sessionID: fixture.alpha.id, action: "edit", resources: ["src/a.ts"] } }])
      const events = (sessionID: SessionSchema.ID) =>
        noticesFor(fixture, sessionID).pipe(Effect.map((rows) => rows.map(noticeMetadata)))
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* ownerChanged(fixture, fixture.alpha.id, fixture.subagent.id, "evt_owner_first")
      yield* ownerChanged(fixture, fixture.alpha.id, fixture.subagent.id, "evt_owner_first")
      expect(yield* events(fixture.subagent.id)).toEqual([
        { source: "project_notification", groupID: fixture.group.id, memberSessionID: fixture.alpha.id, title: "alpha", event: "permission", requestID: "per_one", excerpt: "edit src/a.ts" },
      ])
      yield* own(fixture, fixture.alpha.id, fixture.other.id)
      woken.length = 0
      yield* ownerChanged(fixture, fixture.alpha.id, fixture.other.id, "evt_owner_second")
      expect(woken).toEqual([fixture.other.id])
      expect((yield* events(fixture.other.id)).map((data) => [data.event, data.requestID])).toEqual([["permission", "per_one"]])
      yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "late" } }, "evt_late_failure")
      yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "late" } }, "evt_late_failure")
      expect((yield* events(fixture.other.id)).map((data) => data.event)).toEqual(["permission", "failed"])
      expect(yield* events(fixture.subagent.id)).toHaveLength(1)
      expect(yield* events(fixture.master.id)).toEqual([])
      yield* own(fixture, fixture.alpha.id)
      yield* ownerChanged(fixture, fixture.alpha.id, undefined, "evt_owner_released")
      expect((yield* events(fixture.master.id)).map((data) => [data.event, data.requestID])).toEqual([["permission", "per_one"]])
      expect(yield* events(fixture.other.id)).toHaveLength(2)
    }))

  it.effect("owner routing comes from the durable record after a runtime restart", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      const restarted = yield* fixture.makeRuntime
      yield* restarted.handle({ id: "evt_after_restart", created: DateTime.makeUnsafe(1), type: SessionEvent.Execution.Succeeded.type, data: { sessionID: fixture.alpha.id } } as never)
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(1)
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      yield* restarted.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "Still mine" })
      expect(yield* refusal(restarted.send(fixture.other.id, { sessionID: fixture.alpha.id, text: "Not mine" }))).toBe(ownedElsewhere(fixture.alpha.id))
    }))

  it.effect("startup recovers an undelivered retained member event to its current owner without waking it or replaying work", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* retainFailure(fixture, fixture.alpha.id, "Retained failure")
      const restarted = yield* fixture.makeRuntime
      yield* restarted.recover()
      yield* restarted.recover()
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(1)
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      expect(woken).toEqual([])
    }))

  it.effect("startup notification recovery excludes work before a Session joined the Project", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* retainFailure(fixture, fixture.outsider.id, "Before membership")
      yield* adjust(1)
      yield* fixture.coordination.update(fixture.group.id, { revision: fixture.group.revision, memberSessionIDs: [...fixture.group.memberSessionIDs, fixture.outsider.id] })
      yield* own(fixture, fixture.outsider.id, fixture.subagent.id)
      yield* retainFailure(fixture, fixture.outsider.id, "After membership")
      const restarted = yield* fixture.makeRuntime
      yield* restarted.recover()
      const notices = yield* noticesFor(fixture, fixture.subagent.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]?.data).toMatchObject({ metadata: { excerpt: "After membership" } })
      expect(woken).toEqual([])
    }))

  it.effect("startup notification recovery starts at the current membership after removal and rejoining", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* adjust(1)
      const removed = yield* fixture.coordination.update(fixture.group.id, { revision: fixture.group.revision, memberSessionIDs: [fixture.beta.id] })
      yield* retainFailure(fixture, fixture.alpha.id, "Outside membership")
      yield* adjust(1)
      yield* fixture.coordination.update(fixture.group.id, { revision: removed.revision, memberSessionIDs: [fixture.alpha.id, fixture.beta.id] })
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* retainFailure(fixture, fixture.alpha.id, "Current membership")
      const restarted = yield* fixture.makeRuntime
      yield* restarted.recover()
      const notices = yield* noticesFor(fixture, fixture.subagent.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]?.data).toMatchObject({ metadata: { excerpt: "Current membership" } })
      expect(woken).toEqual([])
    }))

  it.effect("an escalation from the owning subagent wakes the inactive Master once with the reason and caller, and never activates the Project", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      const input = { sessionID: fixture.alpha.id, requestID: "per_one", kind: "permission" as const, fingerprint: "fp_per", reason: "Deletes the release branch" }
      const first = yield* fixture.runtime.escalate(fixture.subagent.id, input)
      expect(first).toMatchObject({
        sessionID: fixture.alpha.id, requestID: "per_one", delivered: true,
        decision: { outcome: "escalated", to: "master", coordinationEscalation: { reasons: [{ sessionID: fixture.subagent.id, reason: "Deletes the release branch" }] } },
      })
      expect(escalations[0]).toEqual({
        groupID: fixture.group.id, coordinatorSessionID: fixture.subagent.id, targetSessionID: fixture.alpha.id,
        requestID: "per_one", kind: "permission", fingerprint: "fp_per", reason: "Deletes the release branch",
      })
      expect(woken).toEqual([fixture.master.id])
      const [notice] = yield* noticesFor(fixture, fixture.master.id)
      expect(notice).toMatchObject({ id: first.messageID, type: "synthetic", delivery: "steer" })
      const data = noticeOf(notice!)
      expect(data.metadata).toEqual({
        source: "project_notification", groupID: fixture.group.id, memberSessionID: fixture.alpha.id, title: "alpha", event: "escalated",
        requestID: "per_one", kind: "permission", excerpt: "Deletes the release branch", escalatedBy: { sessionID: fixture.subagent.id, title: "master subagent" },
      })
      expect(data.text).toBe(`Project notification:\n${JSON.stringify(data.metadata)}`)
      woken.length = 0
      expect(yield* fixture.runtime.escalate(fixture.subagent.id, input)).toEqual(first)
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(1)
      expect(woken).toEqual([])
      expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(false)
    }))

  it.effect("a stale or unappended escalation from the owning subagent delivers nothing to the Master", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      escalationOutcome.to = "none"
      const result = yield* fixture.runtime.escalate(fixture.subagent.id, { sessionID: fixture.alpha.id, requestID: "per_one", kind: "permission", fingerprint: "old", reason: "Changed" })
      expect(result).toMatchObject({ delivered: false, decision: { outcome: "stale" } })
      expect(result.messageID).toBeUndefined()
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      expect(woken).toEqual([])
    }))

  it.effect("an escalation by the Master itself hands off natively and admits nothing, and callers outside the Project are refused", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      escalationOutcome.to = "client"
      const input = { sessionID: fixture.alpha.id, requestID: "frm_one", kind: "question" as const, fingerprint: "fp_frm", reason: "Needs a person" }
      expect(yield* fixture.runtime.escalate(fixture.master.id, input)).toMatchObject({ requestID: "frm_one", delivered: false, decision: { to: "client" } })
      expect(escalations.map((item) => item.coordinatorSessionID)).toEqual([fixture.master.id])
      expect(yield* refusal(fixture.runtime.escalate(fixture.outsider.id, input))).toBe("The project tool is only available to a Project's Master and its subagents")
      expect(yield* refusal(fixture.runtime.escalate(fixture.subagent.id, { ...input, sessionID: fixture.outsider.id }))).toBe(`Session ${fixture.outsider.id} is not a member of this Project`)
      expect(escalations).toHaveLength(1)
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      expect(woken).toEqual([])
    }))

  it.effect("a deterministic notice identity survives a lookup after promotion", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id })
      const [notice] = yield* noticesFor(fixture, fixture.master.id)
      yield* fixture.events.publish(SessionEvent.InputPromoted, { sessionID: fixture.master.id, inputID: notice!.id })
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(0)
      expect(yield* SessionPending.lookup(fixture.db, fixture.master.id, notice!.id)).toMatchObject({ type: "synthetic" })
    }))
})

const transition = (fixture: Fixture, sessionID: SessionSchema.ID, ...changes: ReadonlyArray<unknown>) =>
  Effect.forEach(changes, (change) =>
    fixture.events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID, change })), { discard: true })

const settleTaskRow = (fixture: Fixture, sessionID: SessionSchema.ID, state: "cancelling" | "cancelled" | "failed" | "lost") =>
  fixture.db.update(SessionTaskTable).set({ state }).where(eq(SessionTaskTable.session_id, sessionID)).run().pipe(Effect.orDie)

const taskState = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  fixture.db.select({ state: SessionTaskTable.state }).from(SessionTaskTable).where(eq(SessionTaskTable.session_id, sessionID)).get()
    .pipe(Effect.orDie, Effect.map((row) => row?.state))

const recordedOwner = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  fixture.db.select({ owner: CoordinationMemberTable.owner_session_id }).from(CoordinationMemberTable)
    .where(and(eq(CoordinationMemberTable.group_id, fixture.group.id), eq(CoordinationMemberTable.session_id, sessionID))).get()
    .pipe(Effect.orDie, Effect.map((row) => row?.owner ?? undefined))

const ownerChanges = (fixture: Fixture) =>
  fixture.db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable).where(eq(EventTable.aggregate_id, fixture.group.id)).orderBy(EventTable.seq).all()
    .pipe(Effect.orDie, Effect.map((rows) => rows.filter((row) => row.type.startsWith(Coordination.Event.OwnerChanged.type)).map((row) => row.data)))

const noticeDetails = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  noticesFor(fixture, sessionID).pipe(Effect.map((rows) => rows.map((row) => {
    const metadata = noticeMetadata(row)
    return [metadata.event, metadata.requestID]
  })))

const noticeEvents = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  noticesFor(fixture, sessionID).pipe(Effect.map((rows) => rows.map((row) => noticeMetadata(row).event)))

describe("owner-routed delivery", () => {
  const progress = (sessionID: SessionSchema.ID) => ({ sessionID, assistantMessageID: "msg_routed_progress", finish: "tool-calls", cost: 0,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })
  const allKinds = (sessionID: SessionSchema.ID) => [
    { event: "started", definition: SessionEvent.Execution.Started, data: { sessionID } },
    { event: "progress", definition: SessionEvent.Step.Ended, data: progress(sessionID) },
    { event: "completed", definition: SessionEvent.Execution.Succeeded, data: { sessionID } },
    { event: "failed", definition: SessionEvent.Execution.Failed, data: { sessionID, error: { type: "provider.error", message: "boom" } } },
    { event: "question", definition: Form.Event.Created, data: { form: { id: "frm_routed", sessionID, title: "Pick", fields: [{ key: "branch", type: "string", required: true }] } } },
    { event: "permission", definition: Permission.Event.Asked, data: { id: "per_routed", sessionID, action: "edit", resources: ["src/a.ts"] } },
    { event: "review", definition: Guardrail.Event.Asked, data: { id: "grq_routed", rootSessionID: sessionID, sessionID, action: "shell", resources: ["rm -rf build"], ruleIDs: ["r1"], reason: "Deletes files", standard: true } },
  ] as const

  for (const owner of ["delegated", "master"] as const)
    it.effect(`every member event reaches only the ${owner} owner and no other Session`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        const receiver = owner === "master" ? fixture.master.id : fixture.subagent.id
        yield* own(fixture, fixture.alpha.id, receiver)
        for (const kind of allKinds(fixture.alpha.id)) yield* emit(fixture, kind.definition, kind.data, `evt_routed_${owner}_${kind.event}`)
        expect(yield* noticeEvents(fixture, receiver)).toEqual(allKinds(fixture.alpha.id).map((kind) => kind.event))
        for (const id of [fixture.master.id, fixture.subagent.id, fixture.other.id, fixture.outsider.id, fixture.beta.id, fixture.alphaChild.id, fixture.executor.id].filter((id) => id !== receiver))
          expect(yield* noticesFor(fixture, id)).toEqual([])
        expect(yield* recordedOwner(fixture, fixture.alpha.id)).toBe(receiver)
      }))

  const settledOwners = ["delegated", "master"] as const
  const ownerFor = (fixture: Fixture, owner: (typeof settledOwners)[number]) => (owner === "master" ? fixture.master.id : fixture.subagent.id)
  const otherThan = (fixture: Fixture, receiver: SessionSchema.ID) => (receiver === fixture.master.id ? fixture.subagent.id : fixture.master.id)

  for (const owner of settledOwners)
    it.effect(`a member whose turn settles with queued inputs is not reported as completed to its ${owner} owner`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        const receiver = ownerFor(fixture, owner)
        yield* own(fixture, fixture.alpha.id, receiver)
        yield* fixture.runtime.send(receiver, { sessionID: fixture.alpha.id, text: "Queued after the failure" })
        expect((yield* pendingFor(fixture, fixture.alpha.id)).length).toBeGreaterThan(0)
        yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, `evt_queued_settled_${owner}`)
        expect(yield* noticeEvents(fixture, fixture.master.id)).toEqual([])
        expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual([])
      }))

  for (const owner of settledOwners)
    it.effect(`a member whose only pending row is a compaction barrier is not reported as completed to its ${owner} owner`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        const receiver = ownerFor(fixture, owner)
        yield* own(fixture, fixture.alpha.id, receiver)
        yield* SessionPending.admitCompaction(fixture.db, fixture.events, { id: SessionMessage.ID.create(), sessionID: fixture.alpha.id })
        expect((yield* pendingFor(fixture, fixture.alpha.id)).map((row) => row.type)).toEqual(["compaction"])
        expect([yield* SessionPending.has(fixture.db, fixture.alpha.id, "steer"), yield* SessionPending.has(fixture.db, fixture.alpha.id, "queue")]).toEqual([false, false])
        yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, `evt_compaction_settled_${owner}`)
        expect(yield* noticeEvents(fixture, fixture.master.id)).toEqual([])
        expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual([])
      }))

  for (const owner of settledOwners)
    for (const barrier of ["queued input", "compaction barrier"] as const)
      it.effect(`once its ${barrier} drains, the member's next settle reports exactly one completed notice to its ${owner} owner only`, () =>
        Effect.gen(function* () {
          const fixture = yield* setup
          yield* activate(fixture)
          const receiver = ownerFor(fixture, owner)
          yield* own(fixture, fixture.alpha.id, receiver)
          const queued = barrier === "queued input"
            ? yield* fixture.runtime.send(receiver, { sessionID: fixture.alpha.id, text: "Queued after the failure" })
            : yield* SessionPending.admitCompaction(fixture.db, fixture.events, { id: SessionMessage.ID.create(), sessionID: fixture.alpha.id })
          yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, `evt_drain_first_${owner}_${barrier}`)
          expect(yield* noticeEvents(fixture, receiver)).toEqual([])
          if (barrier === "queued input") yield* fixture.events.publish(SessionEvent.InputPromoted, { sessionID: fixture.alpha.id, inputID: "messageID" in queued ? queued.messageID : queued.id })
          else yield* SessionPending.settleCompaction(fixture.db, { sessionID: fixture.alpha.id })
          expect(yield* pendingFor(fixture, fixture.alpha.id)).toEqual([])
          for (const _repeat of [1, 2]) yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, `evt_drain_second_${owner}_${barrier}`)
          expect(yield* noticeEvents(fixture, receiver)).toEqual(["completed"])
          expect(yield* noticesFor(fixture, otherThan(fixture, receiver))).toEqual([])
        }))

  for (const mode of ["before admission", "after admission"] as const)
    it.effect(`a completed notice interrupted ${mode} and retried reaches the owner once`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
        const real = yield* SessionOrchestration.Service
        let attempts = 0
        const interruptible = CoordinationRuntime.make({
          db: fixture.db, events: fixture.events, coordination: fixture.coordination, decisions: decisions as never, execution: yield* SessionExecution.Service, sessions: fixture.sessions,
          orchestration: { notice: (input) => (++attempts === 1 ? (mode === "after admission" ? real.notice(input).pipe(Effect.andThen(Effect.interrupt)) : Effect.interrupt) : real.notice(input)) },
          jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set(outstanding)) },
          validateModel: () => Effect.void,
        })
        const settled = { id: "evt_interrupted_completed", created: DateTime.makeUnsafe(1), type: SessionEvent.Execution.Succeeded.type, data: { sessionID: fixture.alpha.id } }
        const first = yield* Effect.exit(interruptible.handle(settled as never))
        expect(Exit.hasInterrupts(first)).toBe(true)
        yield* interruptible.handle(settled as never)
        yield* interruptible.handle(settled as never)
        expect(attempts).toBe(mode === "after admission" ? 1 : 2)
        expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual(["completed"])
        expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      }))

  it.effect("an unassigned member's events reach only the Master", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      for (const kind of allKinds(fixture.beta.id)) yield* emit(fixture, kind.definition, kind.data, `evt_unassigned_${kind.event}`)
      expect(yield* noticeEvents(fixture, fixture.master.id)).toEqual(allKinds(fixture.beta.id).map((kind) => kind.event))
      for (const id of [fixture.subagent.id, fixture.other.id, fixture.outsider.id, fixture.alpha.id, fixture.alphaChild.id, fixture.executor.id])
        expect(yield* noticesFor(fixture, id)).toEqual([])
    }))

  it.effect("an interrupted member that is sent new work reports interrupted then started to its owner only", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.alpha.id, reason: "user" }, "evt_stop_interrupted")
      yield* fixture.runtime.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "Continue" })
      yield* emit(fixture, SessionEvent.Execution.Started, { sessionID: fixture.alpha.id }, "evt_stop_restarted")
      expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual(["interrupted", "started"])
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
    }))

  it.effect("after the Master pauses the Project, routine notices reach the owner without waking it and urgent ones wake it", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.master.id, reason: "user" })
      expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(false)
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, "evt_paused_completed")
      expect(woken).toEqual([])
      yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "boom" } }, "evt_paused_failed")
      expect(woken).toEqual([fixture.subagent.id])
      expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual(["completed", "failed"])
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
    }))

  it.effect("a notice revives a completed owner task so its next settlement reports to the Master", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* transition(fixture, fixture.subagent.id, { type: "completed" })
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, "evt_revive_completed")
      expect(yield* taskState(fixture, fixture.subagent.id)).toBe("running")
      expect(woken).toEqual([fixture.subagent.id])
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
    }))

  it.effect("while the Project is paused a routine notice leaves a completed owner settled and an urgent one revives it", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* transition(fixture, fixture.subagent.id, { type: "completed" })
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, "evt_quiet_completed")
      expect(yield* taskState(fixture, fixture.subagent.id)).toBe("completed")
      expect(woken).toEqual([])
      yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "boom" } }, "evt_quiet_failed")
      expect(yield* taskState(fixture, fixture.subagent.id)).toBe("running")
      expect(woken).toEqual([fixture.subagent.id])
    }))

  for (const stale of [
    { name: "cancelled", change: { type: "cancelled" } },
    { name: "failed", change: { type: "failed", error: "crashed" } },
    { name: "lost", change: { type: "lost" } },
  ] as const)
    it.effect(`a ${stale.name} owner task releases its members to the Master with their pending requests`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        pendingByTarget.set(fixture.alpha.id, [{ kind: "permission", fingerprint: "fp", request: { id: "per_stale", sessionID: fixture.alpha.id, action: "edit", resources: ["src/a.ts"] } }])
        yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
        yield* settleTaskRow(fixture, fixture.subagent.id, stale.name)
        yield* emit(fixture, SessionEvent.Task.Updated, { sessionID: fixture.subagent.id, change: stale.change }, `evt_stale_${stale.name}`)
        expect(yield* recordedOwner(fixture, fixture.alpha.id)).toBeUndefined()
        expect((yield* ownerChanges(fixture)).at(-1)).toEqual({ groupID: fixture.group.id, revision: 0, sessionID: fixture.alpha.id, reason: "released" })
        expect(yield* noticeEvents(fixture, fixture.master.id)).toEqual(["permission"])
        yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "late" } }, `evt_stale_late_${stale.name}`)
        expect(yield* noticeEvents(fixture, fixture.master.id)).toEqual(["permission", "failed"])
        expect(yield* noticesFor(fixture, fixture.subagent.id)).toEqual([])
      }))

  for (const stale of ["cancelling", "cancelled", "failed", "archived", "unmanaged"] as const)
    it.effect(`a member notice whose recorded owner is ${stale} goes to the Master and releases the owner`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        pendingByTarget.set(fixture.alpha.id, [{ kind: "permission", fingerprint: "fp", request: { id: "per_stale", sessionID: fixture.alpha.id, action: "edit", resources: ["src/a.ts"] } }])
        const plain = yield* fixture.sessions.create({ parentID: fixture.master.id, title: "plain child" })
        const owner = stale === "unmanaged" ? plain.id : fixture.subagent.id
        yield* own(fixture, fixture.alpha.id, owner)
        if (stale === "cancelling" || stale === "cancelled" || stale === "failed") yield* settleTaskRow(fixture, owner, stale)
        if (stale === "archived") yield* fixture.db.run(sql`UPDATE session SET time_archived = 1 WHERE id = ${owner}`).pipe(Effect.orDie)
        woken.length = 0
        yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, `evt_stale_notice_${stale}`)
        expect(yield* recordedOwner(fixture, fixture.alpha.id)).toBeUndefined()
        expect(yield* noticeEvents(fixture, fixture.master.id)).toEqual(["permission", "completed"])
        expect(yield* noticesFor(fixture, owner)).toEqual([])
        expect(woken).not.toContain(owner)
      }))

  it.effect("startup recovery with a lost owner hands its surviving pending request to the Master once and wakes no Session", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      pendingByTarget.set(fixture.alpha.id, [{ kind: "permission", fingerprint: "fp", request: { id: "per_survive", sessionID: fixture.alpha.id, action: "edit", resources: ["src/a.ts"] } }])
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      yield* retainFailure(fixture, fixture.alpha.id, "Failed while the server was down")
      yield* transition(fixture, fixture.subagent.id, { type: "lost" })
      woken.length = 0
      const restarted = yield* fixture.makeRuntime
      yield* restarted.recover()
      yield* restarted.recover()
      expect(woken).toEqual([])
      expect(yield* recordedOwner(fixture, fixture.alpha.id)).toBeUndefined()
      expect(yield* noticeDetails(fixture, fixture.master.id)).toEqual([["permission", "per_survive"], ["failed", undefined]])
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toEqual([])
    }))

  for (const barrier of ["steer", "queue", "compaction barrier"] as const)
    it.effect(`startup recovery of a retained settle reports no completed notice while a ${barrier} is pending, and the next settle after it drains reports exactly one`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
        const pending = barrier === "compaction barrier"
          ? yield* SessionPending.admitCompaction(fixture.db, fixture.events, { id: SessionMessage.ID.create(), sessionID: fixture.alpha.id })
          : yield* fixture.runtime.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "Queued behind the settle", delivery: barrier })
        yield* retainSuccess(fixture, fixture.alpha.id)
        expect((yield* pendingFor(fixture, fixture.alpha.id)).map((row) => row.type === "compaction" ? "compaction" : row.delivery)).toEqual([barrier === "compaction barrier" ? "compaction" : barrier])
        woken.length = 0
        const restarted = yield* fixture.makeRuntime
        yield* restarted.recover()
        yield* restarted.recover()
        expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual([])
        expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
        expect(woken).toEqual([])
        if (barrier === "compaction barrier") yield* SessionPending.settleCompaction(fixture.db, { sessionID: fixture.alpha.id })
        else yield* fixture.events.publish(SessionEvent.InputPromoted, { sessionID: fixture.alpha.id, inputID: "messageID" in pending ? pending.messageID : pending.id })
        expect(yield* pendingFor(fixture, fixture.alpha.id)).toEqual([])
        for (const _repeat of [1, 2]) yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id }, `evt_recover_next_${barrier}`)
        expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual(["completed"])
        expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      }))

  const requests = (sessionID: SessionSchema.ID) => [
    {
      event: "permission", requestID: "per_trigger", definition: Permission.Event.Asked,
      data: { id: "per_trigger", sessionID, action: "edit", resources: ["src/a.ts"] },
      pending: { kind: "permission", fingerprint: "fp", request: { id: "per_trigger", sessionID, action: "edit", resources: ["src/a.ts"] } },
    },
    {
      event: "question", requestID: "frm_trigger", definition: Form.Event.Created,
      data: { form: { id: "frm_trigger", sessionID, title: "Pick", fields: [{ key: "branch", type: "string", required: true }] } },
      pending: { kind: "question", fingerprint: "fp", form: { id: "frm_trigger", sessionID, title: "Pick", fields: [{ key: "branch", type: "string", required: true }] } },
    },
    {
      event: "review", requestID: "grq_trigger", definition: Guardrail.Event.Asked,
      data: { id: "grq_trigger", rootSessionID: sessionID, sessionID, action: "shell", resources: ["rm -rf build"], ruleIDs: ["r1"], reason: "Deletes files", standard: true },
      pending: { kind: "review", fingerprint: "fp", request: { id: "grq_trigger", sessionID, action: "shell", resources: ["rm -rf build"], ruleIDs: ["r1"], reason: "Deletes files", standard: true } },
    },
  ] as const

  for (const kind of ["permission", "question", "review"] as const)
    it.effect(`a ${kind} request that finds its owner stale reaches the Master exactly once, including after the release is handled`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        const request = requests(fixture.alpha.id).find((item) => item.event === kind)!
        pendingByTarget.set(fixture.alpha.id, [request.pending])
        yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
        yield* transition(fixture, fixture.subagent.id, { type: "cancel_requested" })
        yield* emit(fixture, request.definition, request.data, `evt_trigger_${kind}`)
        expect(yield* noticeDetails(fixture, fixture.master.id)).toEqual([[kind, request.requestID]])
        const released = (yield* ownerChanges(fixture)).at(-1)
        expect(released).toEqual({ groupID: fixture.group.id, revision: 0, sessionID: fixture.alpha.id, reason: "released" })
        yield* emit(fixture, Coordination.Event.OwnerChanged, released, `evt_trigger_released_${kind}`)
        expect(yield* noticeDetails(fixture, fixture.master.id)).toEqual([[kind, request.requestID]])
        expect(yield* noticesFor(fixture, fixture.subagent.id)).toEqual([])
      }))

  for (const first of ["per_a", "per_b"] as const)
    it.effect(`two pending requests of a member whose owner is stale reach the Master exactly once each when the ${first} event arrives first`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup
        yield* activate(fixture)
        const pending = (id: string) => ({ kind: "permission", fingerprint: `fp_${id}`, request: { id, sessionID: fixture.alpha.id, action: "edit", resources: [`src/${id}.ts`] } })
        const asked = (id: string) => ({ id, sessionID: fixture.alpha.id, action: "edit", resources: [`src/${id}.ts`] })
        pendingByTarget.set(fixture.alpha.id, [pending("per_a"), pending("per_b")])
        yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
        yield* transition(fixture, fixture.subagent.id, { type: "cancel_requested" })
        const order = first === "per_a" ? ["per_a", "per_b"] : ["per_b", "per_a"]
        for (const id of order) yield* emit(fixture, Permission.Event.Asked, asked(id), `evt_two_${first}_${id}`)
        expect((yield* noticeDetails(fixture, fixture.master.id)).slice().sort()).toEqual([["permission", "per_a"], ["permission", "per_b"]])
        for (const id of order) yield* emit(fixture, Permission.Event.Asked, asked(id), `evt_two_${first}_${id}`)
        yield* emit(fixture, Coordination.Event.OwnerChanged, (yield* ownerChanges(fixture)).at(-1), `evt_two_${first}_released`)
        expect((yield* noticeDetails(fixture, fixture.master.id)).slice().sort()).toEqual([["permission", "per_a"], ["permission", "per_b"]])
        expect(yield* noticesFor(fixture, fixture.subagent.id)).toEqual([])
      }))

  it.effect("handling the same event twice and recovering at startup leave one notice per receiver", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      const failed = yield* fixture.events.publish(SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "once" } })
      const succeeded = yield* fixture.events.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.beta.id })
      for (const event of [failed, failed, succeeded, succeeded]) yield* fixture.runtime.handle(event as never)
      const restarted = yield* fixture.makeRuntime
      yield* restarted.recover()
      yield* restarted.recover()
      expect(yield* noticeEvents(fixture, fixture.subagent.id)).toEqual(["failed"])
      expect(yield* noticeEvents(fixture, fixture.master.id)).toEqual(["completed"])
    }))
})

describe("test stack isolation", () => {
  it.live("with the Location graph's CoordinationRuntime node inert, a published owner loss and member failure change nothing until the runtime under test handles them", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      pendingByTarget.set(fixture.alpha.id, [{ kind: "permission", fingerprint: "fp", request: { id: "per_guard", sessionID: fixture.alpha.id, action: "edit", resources: ["src/a.ts"] } }])
      yield* own(fixture, fixture.alpha.id, fixture.subagent.id)
      const lost = yield* fixture.events.publish(SessionEvent.Task.Updated, { sessionID: fixture.subagent.id, change: { type: "lost" } })
      const failed = yield* fixture.events.publish(SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "boom" } })
      woken.length = 0
      const observed = Effect.gen(function* () {
        return {
          owner: yield* recordedOwner(fixture, fixture.alpha.id),
          master: yield* noticeDetails(fixture, fixture.master.id),
          subagent: yield* noticeDetails(fixture, fixture.subagent.id),
          woken: [...woken],
        }
      })
      for (let attempt = 0; attempt < 20; attempt++) {
        expect(yield* observed).toEqual({ owner: fixture.subagent.id, master: [], subagent: [], woken: [] })
        yield* Effect.sleep("25 millis")
      }
      yield* fixture.runtime.handle(lost as never)
      yield* fixture.runtime.handle(failed as never)
      expect(yield* observed).toEqual({ owner: undefined, master: [["permission", "per_guard"], ["failed", undefined]], subagent: [], woken: [fixture.master.id, fixture.master.id] })
    }), 30_000)
})

const drained: SessionSchema.ID[] = []
const holds = new Map<SessionSchema.ID, Deferred.Deferred<void>>()
const fixtureModel = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") })
const liveExecutionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.unwrap(Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const db = (yield* Database.Service).db
    const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({
      drain: (input) => Effect.gen(function* () {
        drained.push(input.sessionID)
        const promoted = yield* SessionPending.promoteSteers(db, events, input.sessionID)
        const hold = holds.get(input.sessionID)
        if (hold !== undefined) {
          holds.delete(input.sessionID)
          yield* Deferred.await(hold)
        }
        if (promoted === 0 && !input.force) return
        const assistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, { sessionID: input.sessionID, assistantMessageID, agent: Agent.ID.make("build"), model: fixtureModel })
        yield* events.publish(SessionEvent.Step.Ended, { sessionID: input.sessionID, assistantMessageID, finish: "stop", cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
      }),
    }))
    return SessionExecution.layer.pipe(Layer.provide(Layer.effect(LocationServiceMap.Service, fixedLocations(() => runner))))
  })),
  deps: [AppProcess.node, Database.node, SessionAutonomy.node, SessionCompactionExecution.node, SessionStore.node, EventRuntime.node, Job.node],
})
const live = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node,
    SessionOrchestrationNotifier.node, CoordinationService.node]),
  [[SessionExecution.node, liveExecutionNode], inertRuntime],
))

const psAttempts: string[] = []
const psFailingProcess = Layer.effect(AppProcess.Service, Effect.gen(function* () {
  const real = yield* AppProcess.Service
  return AppProcess.Service.of({
    ...real,
    run: (command, options) => {
      if (command._tag !== "StandardCommand" || command.command !== "ps") return real.run(command, options)
      psAttempts.push(command.args.join(" "))
      return Effect.fail(new AppProcess.AppProcessError({ command: "ps", exitCode: 1, stderr: "ps: process listing unavailable" }))
    },
  })
})).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
const psFailing = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node,
    SessionOrchestrationNotifier.node, CoordinationService.node]),
  [[SessionExecution.node, liveExecutionNode], [AppProcess.node, psFailingProcess], inertRuntime],
))

const versioned = (definition: { readonly type: string; readonly durable: { readonly version: number } }) => EventRuntime.versionedType(definition.type, definition.durable.version)

const liveSetup = (ownership: "recorded" | "assigned" = "recorded") => Effect.gen(function* () {
  drained.length = 0
  holds.clear()
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const coordination = yield* CoordinationService.Service
  const db = (yield* Database.Service).db
  const execution = yield* SessionExecution.Service
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const master = yield* sessions.create({ location, title: "master", model: fixtureModel })
  const alpha = yield* sessions.create({ location, title: "alpha", model: fixtureModel })
  const owner = yield* launched(sessions, events, master.id, "owner")
  const group = yield* coordination.create({ name: "Live", masterSessionID: master.id, memberSessionIDs: [alpha.id] })
  yield* coordination.activate(group.id)
  const runtime = CoordinationRuntime.make({
    db, events, coordination, decisions: decisions as never, execution, sessions, orchestration: yield* SessionOrchestration.Service,
    jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set<SessionSchema.ID>()) },
    validateModel: () => Effect.void,
  })
  if (ownership === "assigned") yield* runtime.assign(master.id, { sessionID: alpha.id, ownerSessionID: owner.id })
  if (ownership === "recorded") yield* coordination.setOwner(group.id, { sessionID: alpha.id, ownerSessionID: owner.id })
  const memberSucceeded = { id: "evt_live_member_completed", created: DateTime.makeUnsafe(1), type: SessionEvent.Execution.Succeeded.type, data: { sessionID: alpha.id } }
  const history = (sessionID: SessionSchema.ID) =>
    db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).orderBy(EventTable.seq).all().pipe(Effect.orDie)
  const subagentNotices = history(master.id).pipe(Effect.map((rows) => rows.flatMap((row) => {
    if (row.type !== versioned(SessionEvent.InputAdmitted)) return []
    const metadata = Schema.decodeUnknownSync(AdmittedData)(row.data).input.data.metadata
    return metadata?.source === "subagent_notification" && metadata.childID === owner.id ? [metadata] : []
  })))
  const taskRow = db.select({ state: SessionTaskTable.state, ownerPid: SessionTaskTable.owner_pid, ownerStarted: SessionTaskTable.owner_started })
    .from(SessionTaskTable).where(eq(SessionTaskTable.session_id, owner.id)).get().pipe(Effect.orDie)
  return { sessions, events, db, execution, master, alpha, owner, runtime, memberSucceeded, history, subagentNotices, taskRow }
})

describe("owner revival through real execution", () => {
  live.live("completed-owner drain: the member event's notice is admitted, starts the owner task, runs a Step, settles it, and notifies the Master", () =>
    Effect.gen(function* () {
      const fixture = yield* liveSetup()
      const notifier = yield* SessionOrchestrationNotifier.Service
      yield* fixture.events.publish(SessionEvent.Task.Updated, { sessionID: fixture.owner.id, change: { type: "completed" } })
      yield* notifier.dispatch
      yield* fixture.execution.awaitIdle(fixture.master.id)
      expect((yield* fixture.subagentNotices).map((notice) => notice.type)).toEqual(["completed"])
      const before = (yield* fixture.history(fixture.owner.id)).length
      drained.length = 0

      yield* fixture.runtime.handle(fixture.memberSucceeded as never)
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      yield* notifier.dispatch
      yield* fixture.execution.awaitIdle(fixture.master.id)

      const chain = (yield* fixture.history(fixture.owner.id)).slice(before)
      const position = (label: string, match: (row: { readonly type: string; readonly data: unknown }) => boolean) => {
        const index = chain.findIndex(match)
        expect([label, index >= 0]).toEqual([label, true])
        return index
      }
      const noticeID = (chain.find((row) => row.type === versioned(SessionEvent.InputAdmitted))?.data as { inputID?: string } | undefined)?.inputID
      expect(noticeID).toMatch(/^msg_project_notice_/)
      const change = (type: string) => (row: { readonly type: string; readonly data: unknown }) =>
        row.type === versioned(SessionEvent.Task.Updated) && taskChangeOf(row) === type
      const order = [
        position("notice admitted", (row) => row.type === versioned(SessionEvent.InputAdmitted) && inputIDOf(row) === noticeID),
        position("task started", change("started")),
        position("execution started", (row) => row.type === versioned(SessionEvent.Execution.Started)),
        position("notice promoted", (row) => row.type === versioned(SessionEvent.InputPromoted) && inputIDOf(row) === noticeID),
        position("step started", (row) => row.type === versioned(SessionEvent.Step.Started)),
        position("step ended", (row) => row.type === versioned(SessionEvent.Step.Ended)),
        position("execution succeeded", (row) => row.type === versioned(SessionEvent.Execution.Succeeded)),
        position("task completed", change("completed")),
      ]
      expect(order).toEqual(order.slice().sort((left, right) => left - right))
      expect(drained).toContain(fixture.owner.id)
      expect((yield* fixture.db.select({ state: SessionTaskTable.state }).from(SessionTaskTable).where(eq(SessionTaskTable.session_id, fixture.owner.id)).get().pipe(Effect.orDie))?.state).toBe("completed")
      expect(yield* fixture.db.select().from(SessionPendingTable).where(eq(SessionPendingTable.session_id, fixture.owner.id)).all().pipe(Effect.orDie)).toEqual([])
      expect((yield* fixture.subagentNotices).map((notice) => notice.type)).toEqual(["completed", "completed"])
    }), 30_000)

  live.live("a notice admitted while the owner is mid-turn stays pending through an interrupt and is consumed once on the next wake", () =>
    Effect.gen(function* () {
      const fixture = yield* liveSetup()
      const hold = yield* Deferred.make<void>()
      holds.set(fixture.owner.id, hold)
      yield* fixture.sessions.synthetic({ sessionID: fixture.owner.id, text: "Work on the assignment", resume: true })
      for (let attempt = 0; attempt < 400 && holds.has(fixture.owner.id); attempt++) yield* Effect.sleep("5 millis")
      expect(holds.has(fixture.owner.id)).toBe(false)

      yield* fixture.runtime.handle(fixture.memberSucceeded as never)
      const pendingNotices = fixture.db.select({ id: SessionPendingTable.id }).from(SessionPendingTable).where(eq(SessionPendingTable.session_id, fixture.owner.id)).all()
        .pipe(Effect.orDie, Effect.map((rows) => rows.map((row) => row.id).filter((id) => id.startsWith("msg_project_notice_"))))
      const [noticeID] = yield* pendingNotices
      expect(noticeID).toBeDefined()
      yield* fixture.execution.interrupt(fixture.owner.id)
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      const history = yield* fixture.history(fixture.owner.id)
      expect(history.some((row) => row.type === versioned(SessionEvent.Execution.Interrupted))).toBe(true)
      expect(yield* pendingNotices).toEqual([noticeID])
      expect((yield* fixture.db.select({ state: SessionTaskTable.state }).from(SessionTaskTable).where(eq(SessionTaskTable.session_id, fixture.owner.id)).get().pipe(Effect.orDie))?.state).toBe("running")

      yield* fixture.execution.wake(fixture.owner.id)
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      yield* fixture.runtime.handle(fixture.memberSucceeded as never)
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      const after = yield* fixture.history(fixture.owner.id)
      const about = (definition: { readonly type: string; readonly durable: { readonly version: number } }) =>
        after.filter((row) => row.type === versioned(definition) && (row.data as { inputID?: string }).inputID === noticeID)
      expect(about(SessionEvent.InputAdmitted)).toHaveLength(1)
      expect(about(SessionEvent.InputPromoted)).toHaveLength(1)
      expect(yield* pendingNotices).toEqual([])
    }), 30_000)
})

describe("owner revival without a process identity", () => {
  psFailing.live("when ps fails the owner task records no process owner, and a member notice still revives it, runs a Step, and reports its completion to the Master", () =>
    Effect.gen(function* () {
      const fixture = yield* liveSetup("assigned")
      const notifier = yield* SessionOrchestrationNotifier.Service
      expect(psAttempts.length).toBeGreaterThan(0)
      expect(yield* fixture.taskRow).toEqual({ state: "running", ownerPid: null, ownerStarted: null })

      yield* fixture.sessions.synthetic({ sessionID: fixture.owner.id, text: "Begin the assignment", resume: true })
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      yield* notifier.dispatch
      yield* fixture.execution.awaitIdle(fixture.master.id)
      expect((yield* fixture.taskRow)?.state).toBe("completed")
      expect((yield* fixture.subagentNotices).map((notice) => notice.type)).toEqual(["completed"])
      const before = (yield* fixture.history(fixture.owner.id)).length
      drained.length = 0

      yield* fixture.runtime.handle(fixture.memberSucceeded as never)
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      yield* notifier.dispatch
      yield* fixture.execution.awaitIdle(fixture.master.id)

      const chain = (yield* fixture.history(fixture.owner.id)).slice(before)
      const noticeID = (chain.find((row) => row.type === versioned(SessionEvent.InputAdmitted))?.data as { inputID?: string } | undefined)?.inputID
      expect(noticeID).toMatch(/^msg_project_notice_/)
      const change = (type: string) => chain.findIndex((row) =>
        row.type === versioned(SessionEvent.Task.Updated) && taskChangeOf(row) === type)
      const order = [
        chain.findIndex((row) => row.type === versioned(SessionEvent.InputAdmitted) && inputIDOf(row) === noticeID),
        change("started"),
        chain.findIndex((row) => row.type === versioned(SessionEvent.InputPromoted) && inputIDOf(row) === noticeID),
        chain.findIndex((row) => row.type === versioned(SessionEvent.Step.Started)),
        chain.findIndex((row) => row.type === versioned(SessionEvent.Step.Ended)),
        change("completed"),
      ]
      expect(order.every((index) => index >= 0)).toBe(true)
      expect(order).toEqual(order.slice().sort((left, right) => left - right))
      expect(drained).toContain(fixture.owner.id)
      expect(yield* fixture.taskRow).toEqual({ state: "completed", ownerPid: null, ownerStarted: null })
      expect((yield* fixture.subagentNotices).map((notice) => notice.type)).toEqual(["completed", "completed"])
    }), 30_000)
})

const questions = testEffect(AppNodeBuilder.build(
  LayerNode.group([Config.node, Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node,
    CoordinationService.node, SessionAutonomy.node, Decision.node, Form.node]),
  [
    [SessionExecution.node, execution],
    [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.die("coordinator-selected answers must not call the hidden evaluator") })],
    [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]) })],
  ],
))

const questionSetup = (answers: "yolo" | "manual") => Effect.gen(function* () {
  running.clear()
  woken.length = 0
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const coordination = yield* CoordinationService.Service
  const form = yield* Form.Service
  const autonomy = yield* SessionAutonomy.Service
  const db = (yield* Database.Service).db
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const master = yield* sessions.create({ location, title: "master", model: fixtureModel })
  const alpha = yield* sessions.create({ location, title: "alpha", model: fixtureModel })
  const outsider = yield* sessions.create({ location, title: "outsider", model: fixtureModel })
  const owner = yield* launched(sessions, events, master.id, "owner")
  const sibling = yield* launched(sessions, events, master.id, "sibling")
  const group = yield* coordination.create({ name: "Questions", masterSessionID: master.id, memberSessionIDs: [alpha.id] })
  yield* coordination.setOwner(group.id, { sessionID: alpha.id, ownerSessionID: owner.id })
  yield* autonomy.set({ sessionID: alpha.id, answers })
  const runtime = CoordinationRuntime.make({
    db, events, coordination, execution: yield* SessionExecution.Service, sessions, orchestration: yield* SessionOrchestration.Service,
    decisions: CoordinationDecisions.make({
      policy: () => Effect.succeed(ConfigCoordination.resolve()),
      accessOf: coordination.accessOf,
      form,
      permission: { snapshots: () => Effect.succeed([]) } as never,
      guardrail: { requestSnapshots: () => Effect.succeed([]) } as never,
    }),
    jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set<SessionSchema.ID>()) },
    validateModel: () => Effect.void,
  })
  const id = Form.ID.create("frm_member_branch")
  const created = yield* events.subscribe(Form.Event.Created).pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
  yield* form.create({ id, sessionID: alpha.id, title: "Choose the branch", fields: [{ key: "branch", type: "string", required: true, options: [{ value: "safe", label: "Safe" }] }] })
  yield* runtime.handle(Option.getOrThrow(yield* Fiber.join(created)))
  const notices = (sessionID: SessionSchema.ID) =>
    db.select().from(SessionPendingTable).where(eq(SessionPendingTable.session_id, sessionID)).all().pipe(Effect.orDie,
      Effect.map((rows) => rows.filter((row) => row.type === "synthetic").map((row) => noticeMetadata(row).event)))
  return { form, coordination, runtime, group, master, alpha, outsider, owner, sibling, id, notices }
})

describe("member questions", () => {
  questions.effect("a member question reaches only its owner, wakes it while the Project is inactive, and the owner settles it under native policy", () =>
    Effect.gen(function* () {
      const fixture = yield* questionSetup("yolo")
      expect((yield* fixture.coordination.get(fixture.group.id)).active).toBe(false)
      expect(yield* fixture.notices(fixture.owner.id)).toEqual(["question"])
      expect(woken).toEqual([fixture.owner.id])
      for (const id of [fixture.master.id, fixture.sibling.id, fixture.outsider.id, fixture.alpha.id]) expect(yield* fixture.notices(id)).toEqual([])
      const detail = yield* fixture.runtime.inspect(fixture.owner.id, { sessionID: fixture.alpha.id, requestID: fixture.id })
      expect(detail).toMatchObject({ kind: "question", requestID: fixture.id, delegation: "routine" })
      const result = yield* fixture.runtime.answer(fixture.owner.id, {
        sessionID: fixture.alpha.id, requestID: fixture.id, kind: "question", fingerprint: detail.fingerprint,
        rationale: "The assignment names the safe branch", confidence: 0.95, answer: { branch: "safe" },
      })
      expect(result).toMatchObject({ outcome: "allowed", settled: true })
      expect(yield* fixture.form.state(fixture.id)).toEqual({ status: "answered", answer: { branch: "safe" } })
      expect(yield* refusal(fixture.runtime.answer(fixture.sibling.id, {
        sessionID: fixture.alpha.id, requestID: fixture.id, kind: "question", fingerprint: detail.fingerprint, rationale: "Not mine", answer: { branch: "safe" },
      }))).toBe(ownedElsewhere(fixture.alpha.id))
    }), 30_000)

  questions.effect("under Manual answers the owner's answer is refused without settling and its escalation reaches only the Master", () =>
    Effect.gen(function* () {
      const fixture = yield* questionSetup("manual")
      expect(yield* fixture.notices(fixture.owner.id)).toEqual(["question"])
      const detail = yield* fixture.runtime.inspect(fixture.owner.id, { sessionID: fixture.alpha.id, requestID: fixture.id })
      const result = yield* fixture.runtime.answer(fixture.owner.id, {
        sessionID: fixture.alpha.id, requestID: fixture.id, kind: "question", fingerprint: detail.fingerprint,
        rationale: "The assignment names the safe branch", confidence: 0.95, answer: { branch: "safe" },
      })
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "explicit-decision:manual-answers" })
      expect(yield* fixture.form.state(fixture.id)).toEqual({ status: "pending" })
      woken.length = 0
      const escalated = yield* fixture.runtime.escalate(fixture.owner.id, {
        sessionID: fixture.alpha.id, requestID: fixture.id, kind: "question", fingerprint: detail.fingerprint, reason: "Manual answers need the Master",
      })
      expect(escalated).toMatchObject({ delivered: true, decision: { outcome: "escalated", to: "master" } })
      expect(yield* fixture.notices(fixture.master.id)).toEqual(["escalated"])
      expect(woken).toEqual([fixture.master.id])
      expect(yield* fixture.form.state(fixture.id)).toEqual({ status: "pending" })
      for (const id of [fixture.sibling.id, fixture.outsider.id]) expect(yield* fixture.notices(id)).toEqual([])
    }), 30_000)
})

const ownerStates = testEffect(AppNodeBuilder.build(
  LayerNode.group([Config.node, Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, SessionOrchestration.node,
    CoordinationService.node, SessionAutonomy.node, Decision.node, Form.node]),
  [
    [SessionExecution.node, liveExecutionNode],
    inertRuntime,
    [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.die("coordinator-selected answers must not call the hidden evaluator") })],
    [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]) })],
  ],
))

let ownerQuestions = 0
const ownerStateSetup = (initial: "waiting" | "starting" | "cancelling") => Effect.gen(function* () {
  drained.length = 0
  holds.clear()
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const coordination = yield* CoordinationService.Service
  const form = yield* Form.Service
  const autonomy = yield* SessionAutonomy.Service
  const execution = yield* SessionExecution.Service
  const orchestration = yield* SessionOrchestration.Service
  const db = (yield* Database.Service).db
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const master = yield* sessions.create({ location, title: "master", model: fixtureModel })
  const alpha = yield* sessions.create({ location, title: "alpha", model: fixtureModel })
  const owner = yield* launched(sessions, events, master.id, "owner", initial !== "starting")
  const questionID = QuestionID.make(`qst_owner_${++ownerQuestions}`)
  const change = (value: unknown) =>
    events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: owner.id, change: value }))
  if (initial === "waiting") yield* change({ type: "question_asked", question: { id: questionID, text: "Which lane?", time: 1 } })
  if (initial === "cancelling") yield* change({ type: "cancel_requested" })
  const group = yield* coordination.create({ name: "Owner states", masterSessionID: master.id, memberSessionIDs: [alpha.id] })
  yield* coordination.setOwner(group.id, { sessionID: alpha.id, ownerSessionID: owner.id })
  yield* autonomy.set({ sessionID: alpha.id, answers: "manual" })
  const runtime = CoordinationRuntime.make({
    db, events, coordination, execution, sessions, orchestration,
    decisions: CoordinationDecisions.make({
      policy: () => Effect.succeed(ConfigCoordination.resolve()),
      accessOf: coordination.accessOf,
      form,
      permission: { snapshots: () => Effect.succeed([]) } as never,
      guardrail: { requestSnapshots: () => Effect.succeed([]) } as never,
    }),
    jobs: { list: () => Effect.succeed([]), outstandingSessions: () => Effect.succeed(new Set<SessionSchema.ID>()) },
    validateModel: () => Effect.void,
  })
  const formID = Form.ID.create("frm_member_decision")
  const created = yield* events.subscribe(Form.Event.Created).pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
  yield* form.create({ id: formID, sessionID: alpha.id, title: "Approve the migration", fields: [{ key: "approve", type: "string", required: true }] })
  yield* runtime.handle(Option.getOrThrow(yield* Fiber.join(created)))
  const history = (sessionID: SessionSchema.ID) =>
    db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).orderBy(EventTable.seq).all().pipe(Effect.orDie)
  const noticeRows = (sessionID: SessionSchema.ID, definition: { readonly type: string; readonly durable: { readonly version: number } }) =>
    history(sessionID).pipe(Effect.map((rows) => rows.flatMap((row) => {
      const data = row.data as { inputID?: string; input?: { data?: { metadata?: Record<string, unknown> } } }
      return row.type === versioned(definition) && data.inputID?.startsWith("msg_project_notice_") === true ? [{ id: data.inputID, event: data.input?.data?.metadata?.event }] : []
    })))
  const pendingNotices = db.select({ id: SessionPendingTable.id }).from(SessionPendingTable).where(eq(SessionPendingTable.session_id, owner.id)).all()
    .pipe(Effect.orDie, Effect.map((rows) => rows.map((row) => row.id).filter((id) => id.startsWith("msg_project_notice_"))))
  const taskState = db.select({ state: SessionTaskTable.state }).from(SessionTaskTable).where(eq(SessionTaskTable.session_id, owner.id)).get()
    .pipe(Effect.orDie, Effect.map((row) => row?.state))
  const recorded = db.select({ owner: CoordinationMemberTable.owner_session_id }).from(CoordinationMemberTable)
    .where(and(eq(CoordinationMemberTable.group_id, group.id), eq(CoordinationMemberTable.session_id, alpha.id))).get()
    .pipe(Effect.orDie, Effect.map((row) => row?.owner ?? undefined))
  const decision = form.state(formID)
  return { events, execution, orchestration, master, alpha, owner, questionID, noticeRows, pendingNotices, taskState, recorded, decision }
})

describe("member notices for a waiting, starting or cancelling owner", () => {
  ownerStates.live("a waiting owner keeps the member's urgent notice pending and consumes it once after its own question is answered; the Manual member decision stays pending", () =>
    Effect.gen(function* () {
      const fixture = yield* ownerStateSetup("waiting")
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      const pending = yield* fixture.pendingNotices
      expect(pending).toHaveLength(1)
      expect(yield* fixture.taskState).toBe("waiting")
      expect(drained).not.toContain(fixture.owner.id)
      expect(yield* fixture.decision).toEqual({ status: "pending" })

      yield* fixture.orchestration.answer({ parentID: fixture.master.id, childID: fixture.owner.id, questionID: fixture.questionID, text: "lane-one" })
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      expect(drained).toContain(fixture.owner.id)
      expect(yield* fixture.noticeRows(fixture.owner.id, SessionEvent.InputAdmitted)).toEqual([{ id: pending[0], event: "question" }])
      expect((yield* fixture.noticeRows(fixture.owner.id, SessionEvent.InputPromoted)).map((row) => row.id)).toEqual(pending)
      expect(yield* fixture.pendingNotices).toEqual([])
      expect(yield* fixture.decision).toEqual({ status: "pending" })
    }), 30_000)

  ownerStates.live("a starting owner keeps the member's urgent notice pending and consumes it once after it starts; the Manual member decision stays pending", () =>
    Effect.gen(function* () {
      const fixture = yield* ownerStateSetup("starting")
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      const pending = yield* fixture.pendingNotices
      expect(pending).toHaveLength(1)
      expect(yield* fixture.taskState).toBe("starting")
      expect(drained).not.toContain(fixture.owner.id)
      expect(yield* fixture.decision).toEqual({ status: "pending" })

      yield* fixture.events.publish(SessionEvent.Task.Updated, { sessionID: fixture.owner.id, change: { type: "started" } })
      yield* fixture.execution.wake(fixture.owner.id)
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      expect(drained).toContain(fixture.owner.id)
      expect(yield* fixture.noticeRows(fixture.owner.id, SessionEvent.InputAdmitted)).toEqual([{ id: pending[0], event: "question" }])
      expect((yield* fixture.noticeRows(fixture.owner.id, SessionEvent.InputPromoted)).map((row) => row.id)).toEqual(pending)
      expect(yield* fixture.pendingNotices).toEqual([])
      expect(yield* fixture.decision).toEqual({ status: "pending" })
    }), 30_000)

  ownerStates.live("a cancelling owner never receives the member's notice: the Master receives it once and the owner is released; the Manual member decision stays pending", () =>
    Effect.gen(function* () {
      const fixture = yield* ownerStateSetup("cancelling")
      yield* fixture.execution.awaitIdle(fixture.owner.id)
      yield* fixture.execution.awaitIdle(fixture.master.id)
      expect(yield* fixture.noticeRows(fixture.owner.id, SessionEvent.InputAdmitted)).toEqual([])
      expect(drained).not.toContain(fixture.owner.id)
      expect(yield* fixture.taskState).toBe("cancelling")
      expect(yield* fixture.recorded).toBeUndefined()
      expect((yield* fixture.noticeRows(fixture.master.id, SessionEvent.InputAdmitted)).map((row) => row.event)).toEqual(["question"])
      expect(yield* fixture.decision).toEqual({ status: "pending" })
    }), 30_000)
})
