import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { QuestionTool } from "@ycoding-ai/core/tool/question"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { imagePassthrough } from "./lib/image"
import { testEffect } from "./lib/effect"
import { registerToolPlugin, settleTool, toolIdentity } from "./lib/tool"

let evaluate: Decision.Interface["evaluate"] = () => Effect.die("Unexpected evaluator call")
const node = makeLocationNode({
  name: "test/graded-question-tool",
  layer: Layer.effectDiscard(registerToolPlugin(QuestionTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Permission.node, Form.node],
})
const it = testEffect(AppNodeBuilder.build(LayerNode.group([node, ToolRegistry.node, Form.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node]), [
  [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
  [Decision.node, Layer.mock(Decision.Service, { evaluate: (input, context) => evaluate(input, context) })],
  [Permission.node, Layer.mock(Permission.Service, { assert: () => Effect.void })],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [Image.node, imagePassthrough],
]))
const sessionID = SessionSchema.ID.make("ses_grading")
const questions = [{ header: "Storage", question: "Select one storage engine; SQLite and Postgres are alternatives. Backups complement either.",
  options: [
    { label: "SQLite", description: "Local database" },
    { label: "Postgres", description: "Server database, incompatible with selecting SQLite" },
    { label: "Backups", description: "Complement the chosen engine" },
  ], custom: false,
}]
const grades = questions[0].options.map((option, index) => ({ choice: option.label, confidence: [0.96, 0.93, 0.92][index], evidence: `${option.label} has supported tradeoffs.` }))
const analysis = { recommendation: ["SQLite"], compatible: true, reason: "One engine fits the local workload." }

function response(input: Decision.Input, override?: unknown) {
  return Schema.decodeUnknownSync(Decision.Output)({ provider: "agent", response: {
    model: { providerID: "test", id: "assessment" }, semantics: "model-estimate", version: 1,
    answers: input.request.questions.map((question) => question.type === "choice" && question.grade === true
      ? { name: question.name, type: "choice", answer: null, choice: null, score: null, confidence: 0, grades: override ?? grades }
      : { name: question.name, type: "text", answer: null, choice: null, score: null, confidence: 0.95, text: JSON.stringify(override ?? analysis) }),
  } })
}

const seed = Effect.fnUntraced(function* (mode: "manual" | "auto" | "yolo" = "yolo") {
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp/graded-question"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/tmp/graded-question", title: "Grading" }).onConflictDoNothing().run().pipe(Effect.orDie)
  const autonomy = yield* SessionAutonomy.Service
  yield* autonomy.set({ sessionID, answers: mode })
})

const invoke = (multiple = false) => Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  return yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "graded", name: "question", input: { questions: questions.map((question) => ({ ...question, multiple })) } } })
})

const observe = Effect.fnUntraced(function* () {
  const events = yield* EventRuntime.Service
  const created = yield* Deferred.make<Form.Info>()
  const assessed = yield* Deferred.make<unknown>()
  const published: EventRuntime.Payload[] = []
  const unsubscribe = yield* events.listen((event) => Effect.gen(function* () {
    if (event.type.startsWith("form.")) published.push(event)
    if (event.type === "form.created") yield* Deferred.succeed(created, Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form)
    if (event.type === "form.assessed") yield* Deferred.succeed(assessed, event.data)
  }))
  yield* Effect.addFinalizer(() => unsubscribe)
  return { created, assessed, published }
})

it.effect("active question tool publishes pending then exact per-option grades and the unique best recommendation in settled output", () => Effect.gen(function* () {
  yield* seed()
  const calls: Decision.Input[] = []
  evaluate = (input) => { calls.push(input); return Effect.succeed(response(input)) }
  const observed = yield* observe()
  const fiber = yield* invoke().pipe(Effect.forkScoped)
  const initial = yield* Deferred.await(observed.created)
  expect(initial).toMatchObject({ assessment: { mode: "yolo", sourceSessionID: sessionID, fields: [{ key: "q0", status: "pending" }] } })
  const result = yield* Fiber.join(fiber)
  expect(calls[0]?.request.questions[0]).toMatchObject({ type: "choice", grade: true, choices: questions[0].options.map((option) => ({ value: option.label, description: option.description })) })
  expect(result.output?.structured).toMatchObject({ answers: [["SQLite"]], automatic: true, via: "yolo", assessment: {
    mode: "yolo", sourceSessionID: sessionID, fields: [{ key: "q0", status: "assessed", recommendation: ["SQLite"],
      grades,
    }],
  } })
  expect(observed.published.map((event) => event.type)).toEqual(["form.created", "form.assessed", "form.replied"])
  expect(result.result.value).toStartWith("Answers were selected automatically:")
  expect(result.result.value).toContain("Do not reopen routine choices")
  expect(result.result.value).toContain("Permissions, guardrails, and required explicit decisions still apply.")
  expect(result.result.value).not.toContain("User has answered")
}))

it.effect("multi-choice recommends one compatible set rather than every individually high option", () => Effect.gen(function* () {
  yield* seed()
  evaluate = (input) => Effect.succeed(response(input, input.request.questions[0]?.type === "text"
    ? { ...analysis, recommendation: ["SQLite", "Backups"], reason: "One engine plus its compatible backup option." } : undefined))
  const result = yield* invoke(true)
  expect(result.output?.structured).toMatchObject({ answers: [["SQLite", "Backups"]], assessment: { fields: [{ recommendation: ["SQLite", "Backups"], grades }] } })
}))

it.effect("all active question fields are graded even when an earlier field needs a human, while inactive conditional fields are not", () => Effect.gen(function* () {
  yield* seed()
  const calls: string[] = []
  evaluate = input => {
    calls.push(input.request.questions[0].name)
    return Effect.succeed(response(input, input.request.questions[0].name === "q0" ? grades.map(grade => ({ ...grade, confidence: 0.79 })) : undefined))
  }
  const forms = yield* Form.Service
  const observed = yield* observe()
  const options = questions[0].options.map(option => ({ value: option.label, label: option.label }))
  const fiber = yield* forms.ask({ sessionID, title: "Questions", metadata: { kind: "question" }, fields: [
    { key: "q0", type: "string", options }, { key: "q1", type: "string", options },
    { key: "q2", type: "string", options, when: [{ key: "q0", op: "eq", value: "SQLite" }] },
  ] }).pipe(Effect.forkScoped)
  const created = yield* Deferred.await(observed.created)
  const event = Schema.decodeUnknownSync(Form.Event.Assessed.data)(yield* Deferred.await(observed.assessed))
  expect(calls).toEqual(["q0", "q1"])
  expect(event.assessment.fields).toMatchObject([{ key: "q0", status: "assessed" }, { key: "q1", status: "assessed", recommendation: ["SQLite"] }, { key: "q2", status: "not_assessed" }])
  yield* forms.reply({ id: created.id, answer: { q0: "Postgres", q1: "Postgres" } })
  expect(yield* Fiber.join(fiber)).toMatchObject({ status: "answered", answer: { q0: "Postgres", q1: "Postgres" }, assessment: event.assessment })
}))

it.effect("waking during sleeping question grading exposes final inconclusive evidence while preserving the unanswered human Form", () => Effect.gen(function* () {
  yield* seed()
  const forms = yield* Form.Service
  const autonomy = yield* SessionAutonomy.Service
  yield* autonomy.set({ sessionID, sleep: true })
  const authority = yield* autonomy.effectiveDecisions(sessionID)
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const revised = grades.map(grade => ({ ...grade, confidence: 0.79 }))
  const calls: Decision.Input[] = []
  evaluate = input => {
    calls.push(input)
    return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(response(input, revised)))
  }
  const observed = yield* observe()
  const running = yield* invoke().pipe(Effect.forkScoped)
  yield* Deferred.await(entered)
  expect(yield* forms.list()).toEqual([])
  yield* autonomy.set({ sessionID, sleep: false })
  yield* Deferred.succeed(release, undefined)
  const created = yield* Deferred.await(observed.created)
  expect(created.assessment).toMatchObject({ mode: "yolo", sourceSessionID: sessionID, fields: [{ key: "q0", status: "assessed", grades: revised }] })
  expect(created.assessment?.fields[0]?.reason).toContain("0.8")
  expect(created.assessment?.fields.some(field => field.status === "pending")).toBe(false)
  expect((yield* forms.list()).map(form => form.assessment)).toEqual([created.assessment])
  expect(yield* forms.state(created.id)).toEqual({ status: "pending" })
  expect(observed.published.map(event => event.type)).toEqual(["form.created"])
  expect(yield* autonomy.effectiveDecisions(sessionID)).toEqual(authority)
  expect(yield* autonomy.isAsleep(sessionID)).toBe(false)
  yield* forms.reply({ id: created.id, answer: { q0: "Postgres" } })
  const output = (yield* Fiber.join(running)).output
  expect(output?.structured).toMatchObject({ answers: [["Postgres"]], assessment: created.assessment })
  expect(output?.structured).not.toHaveProperty("automatic")
  expect(output?.structured).not.toHaveProperty("source")
  expect(calls).toHaveLength(1)
}))

for (const fault of ["missing", "duplicate", "extra", "low", "tie", "incompatible", "set-extra", "set-duplicate", "set-low", "error", "refused", "timeout"] as const) {
  it.effect(`question ${fault} leaves a bounded visible reason and accepts only the human answer`, () => Effect.gen(function* () {
    yield* seed()
    const entered = yield* Deferred.make<void>()
    evaluate = (input) => Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined)
      if (fault === "timeout") return yield* Effect.never
      if (fault === "error") return yield* Effect.fail(new Decision.Error({ reason: "provider-failed" }))
      if (fault === "refused") return Schema.decodeUnknownSync(Decision.Output)({ provider: "agent", response: {
        model: { providerID: "test", id: "assessment" }, semantics: "model-estimate", version: 1,
        answers: [{ name: input.request.questions[0].name, type: "refusal", answer: null, choice: null, score: null, confidence: 0 }],
      } })
      return response(input, input.request.questions[0]?.type === "text"
        ? fault === "incompatible" ? { ...analysis, compatible: false, recommendation: ["SQLite", "Postgres"] }
          : fault === "set-extra" ? { ...analysis, recommendation: ["Fabricated"] }
            : fault === "set-duplicate" ? { ...analysis, recommendation: ["SQLite", "SQLite"] }
              : fault === "set-low" ? { ...analysis, recommendation: ["Backups"] } : undefined
        : fault === "missing" ? grades.slice(1) : fault === "duplicate" ? [grades[0], grades[0], grades[2]]
          : fault === "extra" ? [...grades, { choice: "Fabricated", confidence: 0.99, evidence: "Not a real choice." }]
            : fault === "low" ? grades.map((grade) => ({ ...grade, confidence: 0.79 }))
              : fault === "tie" ? grades.map((grade) => ({ ...grade, confidence: 0.95 }))
                : fault === "set-low" ? grades.map((grade) => ({ ...grade, confidence: grade.choice === "Backups" ? 0.79 : grade.confidence })) : undefined)
    })
    const observed = yield* observe()
    const multiple = fault === "incompatible" || fault.startsWith("set-")
    const fiber = yield* invoke(multiple).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    if (fault === "timeout") yield* TestClock.adjust("61 seconds")
    const event = Schema.decodeUnknownSync(Form.Event.Assessed.data)(yield* Deferred.await(observed.assessed))
    expect(event.assessment.fields[0]?.status).toBe(fault === "low" || fault === "tie" || fault === "incompatible" ? "assessed" : "unavailable")
    expect(event.assessment.fields[0]?.reason.trim().length).toBeGreaterThan(0)
    expect(event.assessment.fields[0]?.reason.length).toBeLessThanOrEqual(500)
    const forms = yield* Form.Service
    const form = (yield* forms.list({ sessionID }))[0]
    expect((yield* forms.snapshot(form.id))?.form.assessment).toEqual(event.assessment)
    expect(yield* forms.state(form.id)).toEqual({ status: "pending" })
    yield* forms.reply({ id: form.id, answer: { q0: multiple ? ["Postgres"] : "Postgres" } })
    const settled = yield* Fiber.join(fiber)
    expect(settled.output?.structured).toMatchObject({ answers: [["Postgres"]] })
    expect(settled.output?.structured).not.toHaveProperty("automatic")
    expect((yield* forms.reply({ id: form.id, answer: { q0: multiple ? ["SQLite"] : "SQLite" } }).pipe(Effect.flip))._tag).toBe("Form.AlreadySettledError")
    expect(observed.published.filter(event => event.type === "form.replied")).toHaveLength(1)
  }))
}

for (const mode of ["manual", "auto"] as const) {
  it.effect(`${mode} shows not assessed and never calls the evaluator`, () => Effect.gen(function* () {
    yield* seed(mode)
    evaluate = () => Effect.die("Manual and Auto are model-free")
    const observed = yield* observe()
    const fiber = yield* invoke().pipe(Effect.forkScoped)
    const form = yield* Deferred.await(observed.created)
    expect(form.assessment?.mode).toBe(mode)
    expect(form.assessment?.fields[0]?.status).toBe("not_assessed")
    expect(form.assessment?.fields[0]?.reason.trim().length).toBeGreaterThan(0)
    const forms = yield* Form.Service
    yield* forms.reply({ id: form.id, answer: { q0: "Postgres" } })
    expect((yield* Fiber.join(fiber)).output?.structured).not.toHaveProperty("automatic")
  }))
}

for (const race of ["human", "mode", "interrupt"] as const) {
  it.effect(`${race} during grading cannot apply a late automatic answer or settle twice`, () => Effect.gen(function* () {
    yield* seed()
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    evaluate = (input) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(response(input)))
    const observed = yield* observe()
    const fiber = yield* invoke().pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const form = yield* Deferred.await(observed.created)
    const forms = yield* Form.Service
    if (race === "human") yield* forms.reply({ id: form.id, answer: { q0: "Postgres" } })
    if (race === "mode") {
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: "manual" })
    }
    if (race === "interrupt") yield* Fiber.interrupt(fiber)
    yield* Deferred.succeed(release, undefined)
    if (race === "mode") {
      yield* Deferred.await(observed.assessed)
      expect(yield* forms.state(form.id)).toEqual({ status: "pending" })
      yield* forms.reply({ id: form.id, answer: { q0: "Postgres" } })
    }
    if (race !== "interrupt") expect((yield* Fiber.join(fiber)).output?.structured).toMatchObject({ answers: [["Postgres"]] })
    expect(observed.published.filter((event) => event.type === "form.replied")).toHaveLength(race === "interrupt" ? 0 : 1)
    expect(observed.published.filter(event => event.type === "form.assessed")).toHaveLength(race === "mode" ? 1 : 0)
    expect(yield* forms.state(form.id)).toEqual(race === "interrupt" ? { status: "cancelled" } : { status: "answered", answer: { q0: "Postgres" } })
  }))
}

const coordinatorSource = { coordinatorSessionID: "ses_native_coordinator", groupID: "cgrp_native", rationale: "Evaluate the assigned storage choice." }

it.effect("native coordination regrades a pending question, refreshes inconclusive evidence and preserves terminal coordinator attribution", () => Effect.gen(function* () {
  yield* seed()
  const forms = yield* Form.Service
  const observed = yield* observe()
  const first = grades.map(grade => ({ ...grade, confidence: 0.7 }))
  evaluate = input => Effect.succeed(response(input, first))
  const running = yield* invoke().pipe(Effect.forkScoped)
  const form = yield* Deferred.await(observed.created)
  yield* Deferred.await(observed.assessed)
  const snapshot = yield* forms.snapshot(form.id)
  const input = { id: form.id, fingerprint: snapshot!.fingerprint, actor: "coordinator" as const, source: coordinatorSource, validate: () => Effect.succeed(true) }
  expect(yield* forms.reconsider({ ...input, fingerprint: "stale" })).toMatchObject({ outcome: "stale", settled: false })
  const revised = grades.map(grade => ({ ...grade, confidence: 0.75, evidence: `Regraded: ${grade.evidence}` }))
  evaluate = input => Effect.succeed(response(input, revised))
  expect(yield* forms.reconsider(input)).toMatchObject({ outcome: "escalated", settled: false, reason: "low_confidence" })
  expect((yield* forms.snapshot(form.id))?.form.assessment?.fields[0]?.grades).toEqual(revised)
  expect(yield* forms.state(form.id)).toEqual({ status: "pending" })
  evaluate = input => Effect.succeed(response(input))
  expect(yield* forms.reconsider(input)).toMatchObject({ outcome: "allowed", settled: true, via: "yolo" })
  expect((yield* forms.snapshot(form.id))?.form.assessment).toMatchObject({ mode: "yolo", sourceSessionID: sessionID, fields: [{ key: "q0", status: "assessed", grades, recommendation: ["SQLite"], confidence: 0.96 }] })
  expect(observed.published.map(event => event.type)).toEqual(["form.created", "form.assessed", "form.assessed", "form.assessed", "form.replied"])
  const replied = observed.published.find(event => event.type === "form.replied")
  expect(replied?.data).toEqual({ id: form.id, sessionID, answer: { q0: "SQLite" }, source: { kind: "coordinator", ...coordinatorSource, via: "yolo", confidence: 0.96 } })
  const output = (yield* Fiber.join(running)).output
  expect(output?.structured).toMatchObject({ answers: [["SQLite"]], source: { kind: "coordinator", ...coordinatorSource, via: "yolo", confidence: 0.96 }, assessment: { fields: [{ grades }] } })
  const text = output?.content.find(part => part.type === "text")?.text
  expect(text).toContain("coordinator")
  expect(text).not.toContain("User has answered")
}))

it.effect("an explicit native coordinator answer retains its source without invoking or claiming the evaluator", () => Effect.gen(function* () {
  yield* seed("manual")
  const forms = yield* Form.Service
  const autonomy = yield* SessionAutonomy.Service
  const observed = yield* observe()
  evaluate = () => Effect.die("An explicit coordinator answer must not invoke the evaluator")
  const running = yield* invoke().pipe(Effect.forkScoped)
  const form = yield* Deferred.await(observed.created)
  const snapshot = yield* forms.snapshot(form.id)
  yield* autonomy.set({ sessionID, answers: "yolo" })
  expect(yield* forms.reconsider({ id: form.id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource, answer: { q0: "Postgres" }, confidence: 0.95, validate: () => Effect.succeed(true) })).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
  const output = (yield* Fiber.join(running)).output
  expect(output?.structured).toMatchObject({ answers: [["Postgres"]], source: { kind: "coordinator", ...coordinatorSource, via: "coordination", confidence: 0.95 } })
  expect(output?.structured).not.toHaveProperty("automatic")
  const text = output?.content.find(part => part.type === "text")?.text
  expect(text).toContain("coordinator")
  expect(text).not.toContain("evaluator")
}))

for (const winner of ["human", "mode", "delegation"] as const) {
  it.effect(`native coordination ${winner} precedence discards a late regrade without replacing visible evidence`, () => Effect.gen(function* () {
    yield* seed()
    const forms = yield* Form.Service
    const autonomy = yield* SessionAutonomy.Service
    const observed = yield* observe()
    const first = grades.map(grade => ({ ...grade, confidence: 0.7 }))
    evaluate = input => Effect.succeed(response(input, first))
    const running = yield* invoke().pipe(Effect.forkScoped)
    const form = yield* Deferred.await(observed.created)
    yield* Deferred.await(observed.assessed)
    const snapshot = yield* forms.snapshot(form.id)
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let valid = true
    evaluate = input => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(response(input)))
    const reconsidered = yield* forms.reconsider({ id: form.id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource, validate: () => Effect.succeed(valid) }).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    if (winner === "human") yield* forms.reply({ id: form.id, answer: { q0: "Postgres" } })
    if (winner === "mode") yield* autonomy.set({ sessionID, answers: "manual" })
    if (winner === "delegation") valid = false
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(reconsidered)).toMatchObject(winner === "human"
      ? { outcome: "stale", settled: false }
      : { outcome: "escalated", settled: false, reason: winner === "mode" ? "stale-assessment" : "delegation-invalid" })
    expect((yield* forms.snapshot(form.id))?.form.assessment?.fields[0]?.grades).toEqual(first)
    expect(observed.published.filter(event => event.type === "form.assessed")).toHaveLength(1)
    if (winner === "human") {
      expect((yield* Fiber.join(running)).output?.structured).toMatchObject({ answers: [["Postgres"]] })
      expect(observed.published.filter(event => event.type === "form.replied")).toHaveLength(1)
      return
    }
    expect(yield* forms.state(form.id)).toEqual({ status: "pending" })
    yield* Fiber.interrupt(running)
  }))
}
