import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Option, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { tmpdir } from "node:os"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Form } from "@ycoding-ai/schema/form"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Model } from "@ycoding-ai/schema/model"
import { Permission } from "@ycoding-ai/schema/permission"
import { Provider } from "@ycoding-ai/schema/provider"
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
import { SessionPendingTable } from "../src/session/sql"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"

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
  LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, Session.node, SessionExecution.node, CoordinationService.node]),
  [[SessionExecution.node, execution]],
))

const pendingByTarget = new Map<SessionSchema.ID, ReadonlyArray<unknown>>()
const evaluated: unknown[] = []
type EscalationInput = { readonly groupID: string; readonly coordinatorSessionID: SessionSchema.ID; readonly targetSessionID: SessionSchema.ID; readonly kind: "question" | "permission" | "review"; readonly requestID: string; readonly fingerprint: string; readonly reason: string }
const escalations: EscalationInput[] = []
const escalationOutcome: { to?: "master" | "human" | "none" } = {}
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
      return { outcome: "escalated" as const, kind: input.kind, requestID: input.requestID, fingerprint: input.fingerprint, actor: "coordinator" as const, settled: false, reason: "human-only:hard-review" }
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
  const subagent = yield* sessions.create({ parentID: master.id, title: "master subagent" })
  const other = yield* sessions.create({ parentID: master.id, title: "other subagent" })
  const executor = yield* sessions.create({ parentID: subagent.id, title: "subagent executor" })
  const alphaChild = yield* sessions.create({ parentID: alpha.id, title: "alpha child" })
  const group = yield* coordination.create({ name: "Docs", masterSessionID: master.id, memberSessionIDs: [alpha.id, beta.id] })
  const makeRuntime = Effect.gen(function* () {
    return CoordinationRuntime.make({
      db, events, coordination, decisions: decisions as never, execution: yield* SessionExecution.Service, sessions,
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

const humanMessage = (fixture: Fixture, sessionID: SessionSchema.ID, origin: string = "human") =>
  emit(fixture, SessionEvent.InputAdmitted, {
    sessionID, inputID: SessionMessage.ID.create(),
    input: { type: "user", delivery: "steer", data: { text: "Go", metadata: { inputOrigin: origin } } },
  })

const activate = (fixture: Fixture) => humanMessage(fixture, fixture.master.id)

const pendingFor = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  fixture.db.select().from(SessionPendingTable).where(eq(SessionPendingTable.session_id, sessionID)).all().pipe(Effect.orDie)

const noticesFor = (fixture: Fixture, sessionID: SessionSchema.ID) =>
  pendingFor(fixture, sessionID).pipe(Effect.map((rows) => rows.filter((row) => row.type === "synthetic")))

const refusal = <A>(effect: Effect.Effect<A, CoordinationRuntime.RefusedError>) =>
  effect.pipe(Effect.flip, Effect.map((error) => error.message))

describe("project activation", () => {
  it.effect("a human message in the Master chat activates the Project; other inputs and Sessions do not", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      const active = () => fixture.coordination.get(fixture.group.id).pipe(Effect.map((group) => group.active))
      expect(yield* active()).toBe(false)
      for (const origin of ["coordination", "subagent", "plugin", "review"]) yield* humanMessage(fixture, fixture.master.id, origin)
      yield* humanMessage(fixture, fixture.alpha.id)
      yield* humanMessage(fixture, fixture.subagent.id)
      yield* humanMessage(fixture, fixture.outsider.id)
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
      const human = yield* fixture.sessions.prompt({ sessionID: fixture.beta.id, text: "Typed by a person", resume: false })
      expect(yield* refusal(fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Typed by a person", messageID: human.id }))).toContain("different content")
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
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "human-only:hard-review", requestID: "per_one" })
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
      expect(yield* inspect("per_push")).toMatchObject({ delegation: "human-only:publication" })
      expect(yield* inspect("grq_custom")).toEqual({ kind: "review", requestID: "grq_custom", fingerprint: "fp_grq", action: "mcp_execute", resources: ["ycoding/session_prompt"], ruleIDs: ["custom.review"], reason: "Custom rule: Authorization: [redacted] [redacted]", hardReview: false, standard: false, delegation: "escalate" })
      expect(yield* inspect("grq_standard")).toEqual({ kind: "review", requestID: "grq_standard", fingerprint: "fp_std", action: "mcp_execute", resources: ["ycoding/session_prompt"], ruleIDs: ["standard.review.outside-repo"], reason: "Outside repository", hardReview: false, standard: true, delegation: "decline-only" })
      expect(yield* inspect("grq_hard")).toMatchObject({ hardReview: true, delegation: "human-only:hard-review" })
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
      expect(yield* inspect(fixture.subagent.id, "frm_account")).toMatchObject({ kind: "question", delegation: "human-only:credentials-account" })
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
        const data = latest?.data as { text: string; description?: string; metadata: Record<string, unknown> }
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
      yield* fixture.runtime.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "Drive it" })
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
        noticesFor(fixture, sessionID).pipe(Effect.map((rows) => rows.map((row) => (row.data as { metadata: Record<string, unknown> }).metadata)))
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
      const data = notice?.data as { text: string; metadata: Record<string, unknown> }
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
      escalationOutcome.to = "human"
      const input = { sessionID: fixture.alpha.id, requestID: "frm_one", kind: "question" as const, fingerprint: "fp_frm", reason: "Needs a person" }
      expect(yield* fixture.runtime.escalate(fixture.master.id, input)).toMatchObject({ requestID: "frm_one", delivered: false, decision: { to: "human" } })
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
