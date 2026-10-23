import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { tmpdir } from "node:os"
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
const decisions = {
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
  woken.length = 0
  interrupted.length = 0
  evaluated.length = 0
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
  const alphaChild = yield* sessions.create({ parentID: alpha.id, title: "alpha child" })
  const group = yield* coordination.create({ name: "Docs", masterSessionID: master.id, memberSessionIDs: [alpha.id, beta.id] })
  const runtime = CoordinationRuntime.make({
    db, events, coordination, decisions: decisions as never, execution: yield* SessionExecution.Service, sessions,
    validateModel: (_sessionID, model) =>
      modelProblems.has(model.id) ? Effect.fail(new CoordinationRuntime.RefusedError({ message: `Model ${model.id} is not available` })) : Effect.void,
  })
  return { sessions, coordination, db, events, runtime, group, master, alpha, beta, outsider, subagent, alphaChild }
})
type Fixture = Effect.Success<typeof setup>

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

  it.effect("a Master subagent may drive members with the same authority", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
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
      const result = yield* fixture.runtime.answer(fixture.subagent.id, {
        sessionID: fixture.alpha.id, requestID: "per_one", kind: "permission", fingerprint: "fp", rationale: "In scope", confidence: 0.9,
      })
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "human-only:hard-review", requestID: "per_one" })
      expect(evaluated).toEqual([{
        groupID: fixture.group.id, coordinatorSessionID: fixture.subagent.id, targetSessionID: fixture.alpha.id,
        requestID: "per_one", kind: "permission", fingerprint: "fp", rationale: "In scope", confidence: 0.9,
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

  it.effect("holds notifications in the Master chat without waking while the Project is inactive, and a later user turn finds them", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      for (const kind of kinds(fixture.beta.id)) yield* emit(fixture, kind.definition, kind.data)
      expect(woken).toEqual([])
      const held = yield* noticesFor(fixture, fixture.master.id)
      expect(held).toHaveLength(6)
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

  it.effect("goes to the Session that last sent to the member while it runs, and falls back to the Master otherwise", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* fixture.runtime.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "Drive it" })
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.beta.id, text: "Master drives beta" })
      woken.length = 0
      running.add(fixture.subagent.id)
      expect((yield* fixture.runtime.get(fixture.group.id)).members.find((member) => member.sessionID === fixture.alpha.id)?.drivenBy)
        .toEqual({ sessionID: fixture.subagent.id, title: "master subagent" })
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id })
      expect(woken).toEqual([fixture.subagent.id])
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(1)
      expect(yield* noticesFor(fixture, fixture.master.id)).toEqual([])
      woken.length = 0
      running.delete(fixture.subagent.id)
      expect((yield* fixture.runtime.get(fixture.group.id)).members.find((member) => member.sessionID === fixture.alpha.id)?.drivenBy).toBeUndefined()
      yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "boom" } })
      expect(woken).toEqual([fixture.master.id])
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(1)
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(1)
      woken.length = 0
      running.add(fixture.subagent.id)
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.beta.id })
      expect(woken).toEqual([fixture.master.id])
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(2)
      yield* fixture.runtime.send(fixture.master.id, { sessionID: fixture.alpha.id, text: "Master takes over" })
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.alpha.id, reason: "user" })
      expect(woken).toEqual([fixture.master.id])
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(1)
    }))

  it.effect("an inactive Project holds notifications in the Master chat even with a running sender", () =>
    Effect.gen(function* () {
      const fixture = yield* setup
      yield* activate(fixture)
      yield* fixture.runtime.send(fixture.subagent.id, { sessionID: fixture.alpha.id, text: "Drive it" })
      yield* emit(fixture, SessionEvent.Execution.Interrupted, { sessionID: fixture.master.id, reason: "user" })
      running.add(fixture.subagent.id)
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Succeeded, { sessionID: fixture.alpha.id })
      expect(woken).toEqual([])
      expect(yield* noticesFor(fixture, fixture.subagent.id)).toHaveLength(0)
      running.clear()
      woken.length = 0
      yield* emit(fixture, SessionEvent.Execution.Failed, { sessionID: fixture.alpha.id, error: { type: "provider.error", message: "boom" } })
      expect(woken).toEqual([])
      expect(yield* noticesFor(fixture, fixture.master.id)).toHaveLength(2)
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
