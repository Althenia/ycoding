import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Permission } from "@ycoding-ai/core/permission"
import { Session } from "@ycoding-ai/core/session"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { QuestionTool } from "@ycoding-ai/core/tool/question"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { toolIdentity, executeTool, registerToolPlugin, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = Session.ID.make("ses_question_tool_test")
const plan = {
  question: "Which rollout plan fits the user's request to avoid downtime?", header: "Plan",
  options: [{ label: "Fast", description: "Deploy everything at once" }, { label: "Careful", description: "Roll out gradually with health checks" }],
}
const recommendedPlan = { ...plan, options: [{ ...plan.options[0], label: "Fast (Recommended)" }, plan.options[1]] }
const assertions: Permission.AssertInput[] = []
let captured: Form.CreateInput | undefined
let reject = false
let timedOut = false
let deny = false
const capturedInput = () => captured
const questionInput = { questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }] }
const permission = Layer.mock(Permission.Service, {
  assert: (input) => Effect.sync(() => assertions.push(input)).pipe(Effect.andThen(deny
    ? Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources })) : Effect.void)),
})
const form = Layer.mock(Form.Service, {
  ask: (input: Form.CreateInput) => Effect.sync(() => { captured = input }).pipe(Effect.andThen(Effect.sync(
    (): Form.TerminalState => timedOut ? { status: "timed_out", seconds: 300 } : reject ? { status: "cancelled" } : { status: "answered", answer: { q0: "Build", q1: ["Dev"] } },
  ))),
})
const questionToolNode = makeLocationNode({
  name: "test/question-tool-plugin", layer: Layer.effectDiscard(registerToolPlugin(QuestionTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Permission.node, Form.node],
})
let decisionBehavior: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error> = () =>
  Effect.die("Questions must not request judgments")
const decisionChoice = (value: string, confidence: number) => (input: Decision.Input) =>
  Effect.succeed(
    Schema.decodeUnknownSync(Decision.Output)({
      provider: "agent",
      response: {
        model: { providerID: "test", id: "decision-model" },
        semantics: "model-estimate",
        version: 1,
        answers: input.request.questions.map((item) => ({
          name: item.name,
          type: "choice",
          answer: null,
          choice: item.type === "choice" && item.grade === true ? null : value,
          score: null,
          confidence: item.type === "choice" && item.grade === true ? 0 : confidence,
          ...(item.type === "choice" && item.grade === true ? { grades: item.choices.map((choice) => ({ choice: choice.value, confidence: choice.value === value ? confidence : 0.1, evidence: `Fixture support for ${choice.value}.` })) } : {}),
        })),
      },
    }),
  )
const overrides = [
  [Permission.node, permission],
  [Decision.node, Layer.mock(Decision.Service, { evaluate: (input: Decision.Input) => decisionBehavior(input) })],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig], [Image.node, imagePassthrough],
] as const
const configured = (info: unknown) =>
  [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)(info) })]) })] as const
const it = testEffect(AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, questionToolNode]), [...overrides, configured({}), [Form.node, form]]))
const withForms = testEffect(AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, questionToolNode, Form.node, EventRuntime.node, Decision.node]), [...overrides, configured({})]))
const autonomous = testEffect(AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, questionToolNode, Form.node, EventRuntime.node, Database.node, SessionAutonomy.node, Decision.node]), [...overrides, configured({})]))
const seedSession = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp/ycoding-question"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/tmp/ycoding-question", title: "Questions", permission: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
})

const modelFreeAssessment = (mode: "manual" | "auto") => ({ mode, sourceSessionID: sessionID, fields: [{ key: "q0", status: "not_assessed", reason: mode === "auto" ? "Auto uses only explicit defaults or a unique Recommended option; no model assessment." : "Manual answers require your decision; no model assessment." }] })
const gradedAssessment = { mode: "yolo", sourceSessionID: sessionID, fields: [{ key: "q0", status: "assessed", reason: "Unique best-supported option.", recommendation: ["Careful"], confidence: 0.9,
  grades: plan.options.map((option) => ({ choice: option.label, confidence: option.label === "Careful" ? 0.9 : 0.1, evidence: `Fixture support for ${option.label}.` })),
}] }

describe("QuestionTool", () => {
  withForms.effect("holds a blocker for human review and missing evidence until the real Form is answered", () => Effect.gen(function* () {
    deny = false
    const registry = yield* ToolRegistry.Service
    const forms = yield* Form.Service
    const events = yield* EventRuntime.Service
    const created = yield* Deferred.make<Form.Info>()
    const unsubscribe = yield* events.listen((event) => event.type === Form.Event.Created.type
      ? Deferred.succeed(created, Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form).pipe(Effect.asVoid) : Effect.void)
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* settleTool(registry, { sessionID, ...toolIdentity, call: {
      type: "tool-call", id: "call-human-review", name: "question", input: { questions: [
        { header: "Review", question: "The failure did not reproduce. Should I continue investigating or stop?", options: [{ label: "Continue", description: "Investigate the failing input" }, { label: "Stop", description: "Stop without a speculative fix" }] },
        { header: "Evidence", question: "Paste the exact failing input.", options: [] },
      ] },
    } }).pipe(Effect.forkScoped)
    const pending = yield* Deferred.await(created)
    expect(yield* forms.list({ sessionID })).toEqual([pending])
    expect(yield* forms.state(pending.id)).toEqual({ status: "pending" })
    expect(pending.metadata).toEqual({ kind: "question", tool: { messageID: toolIdentity.messageID, callID: "call-human-review" } })
    expect(pending.fields[0]).not.toHaveProperty("default")
    expect(pending.fields[1]).toMatchObject({ key: "q1", type: "string", options: [], custom: true })
    yield* forms.reply({ id: pending.id, answer: { q0: "Continue", q1: "Synthetic failing input" } })
    const settled = yield* Fiber.join(fiber)
    expect(settled.output?.structured).toEqual({ answers: [["Continue"], ["Synthetic failing input"]], assessment: modelFreeAssessment("manual") })
    expect(settled.result).toEqual({ type: "text", value: 'User has answered your questions: "The failure did not reproduce. Should I continue investigating or stop?"="Continue", "Paste the exact failing input."="Synthetic failing input". You can now continue with the user\'s answers in mind.' })
    expect(yield* forms.list({ sessionID })).toEqual([])
  }))

  it.effect("advertises self-contained questions, user-grounded recommendations and required input instead of prose-only blockers", () => Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "question")
    expect(definition?.description).toContain("When progress requires user input, a decision, or review, call this tool instead of ending with a prose-only request")
    expect(definition?.description).toContain("For required free-text input, use an empty options array")
    expect(definition?.description).toContain("Recommend the option that best matches the user's stated requirements and expectations; do not introduce new solutions or problems in the recommendation")
    expect(definition?.description).toContain("Make each question and option description self-contained")
  }))

  it.effect("omits a catalog-denied question and enforces its leaf permission", () => Effect.gen(function* () {
    captured = undefined
    deny = true
    const registry = yield* ToolRegistry.Service
    expect(yield* toolDefinitions(registry, [{ action: "question", resource: "*", effect: "deny" }])).toEqual([])
    expect(yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "call-question-denied", name: "question", input: questionInput } })).toEqual({
      result: { type: "error", value: "Permission denied: question" }, error: { type: "permission.rejected", message: "Permission denied: question" },
    })
    expect(capturedInput()).toBeUndefined()
    deny = false
  }))

  it.effect("registers question and projects string, multiselect and unanswered values with tool ownership", () => Effect.gen(function* () {
    assertions.length = 0
    captured = undefined
    reject = false
    deny = false
    const registry = yield* ToolRegistry.Service
    const questions = [
      { question: "What should happen?", header: "Action", options: [{ label: "Build", description: "Build it" }] },
      { question: "Which environment?", header: "Environment", options: [{ label: "Dev", description: "Development" }], multiple: true },
      { question: "Anything else?", header: "Optional", options: [] },
    ]
    expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["question"])
    const text = 'User has answered your questions: "What should happen?"="Build", "Which environment?"="Dev", "Anything else?"="Unanswered". You can now continue with the user\'s answers in mind.'
    expect(yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "call-question", name: "question", input: { questions } } })).toEqual({
      result: { type: "text", value: text }, output: { structured: { answers: [["Build"], ["Dev"], []] }, content: [{ type: "text", text }] },
    })
    expect(assertions).toMatchObject([{ sessionID, action: "question", resources: ["*"] }])
    expect(capturedInput()).toEqual({ sessionID, title: "Questions", metadata: { kind: "question", tool: { messageID: toolIdentity.messageID, callID: "call-question" } }, fields: [
      { key: "q0", title: "Action", description: "What should happen?", options: [{ value: "Build", label: "Build", description: "Build it" }], custom: true, type: "string" },
      { key: "q1", title: "Environment", description: "Which environment?", options: [{ value: "Dev", label: "Dev", description: "Development" }], custom: true, type: "multiselect" },
      { key: "q2", title: "Optional", description: "Anything else?", options: [], custom: true, type: "string", required: true },
    ] })
  }))

  it.effect("does not turn a closed unanswered Form into successful tool continuation", () => Effect.gen(function* () {
    timedOut = true
    const registry = yield* ToolRegistry.Service
    const exit = yield* executeTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "call-question-timeout", name: "question", input: questionInput } }).pipe(Effect.exit, Effect.ensuring(Effect.sync(() => { timedOut = false })))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(QuestionTool.CancelledError)
  }))

  it.effect("does not invent tool ownership metadata without a durable registry source", () => Effect.gen(function* () {
    captured = undefined
    reject = false
    deny = false
    const registry = yield* ToolRegistry.Service
    yield* executeTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "call-question", name: "question", input: questionInput } })
    expect(capturedInput()).toEqual({ sessionID, title: "Questions", metadata: { kind: "question", tool: { messageID: toolIdentity.messageID, callID: "call-question" } }, fields: [
      { key: "q0", title: "Continue", description: "Continue?", options: [{ value: "Yes", label: "Yes", description: "Continue" }], custom: true, type: "string" },
    ] })
  }))

  it.effect("keeps dismissed questions out of model-facing output", () => Effect.gen(function* () {
    captured = undefined
    reject = true
    deny = false
    const registry = yield* ToolRegistry.Service
    const fiber = yield* executeTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "call-question", name: "question", input: questionInput } }).pipe(Effect.forkScoped)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(QuestionTool.CancelledError)
      expect(Cause.squash(exit.cause)).toHaveProperty("message", "This question was dismissed or superseded without an answer")
    }
  }))

  it.effect("preserves explicit recommended labels without a helper default", () => Effect.gen(function* () {
    captured = undefined
    reject = false
    deny = false
    const registry = yield* ToolRegistry.Service
    yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "recommended", name: "question", input: { questions: [{ ...plan, options: [{ ...plan.options[0], label: "Fast (Recommended)" }, plan.options[1]] }] } } })
    expect(capturedInput()?.fields[0]).not.toHaveProperty("default")
    expect(capturedInput()?.fields[0]).toMatchObject({ options: [{ label: "Fast (Recommended)" }, { label: "Careful" }] })
  }))

  autonomous.effect("Auto answers select only the explicit recommendation and never calls the helper", () => Effect.gen(function* () {
    deny = false
    decisionBehavior = () => Effect.die("Auto answers must not request judgments")
    yield* seedSession
    const autonomy = yield* SessionAutonomy.Service
    const registry = yield* ToolRegistry.Service
    yield* autonomy.set({ sessionID, answers: "auto" })
    expect((yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "recommended", name: "question", input: { questions: [recommendedPlan] } } })).output?.structured).toEqual({ answers: [["Fast (Recommended)"]], automatic: true, via: "auto-answer", assessment: modelFreeAssessment("auto") })
  }))

  autonomous.effect("YOLO answers go through the evaluator and reports its model confidence", () => Effect.gen(function* () {
    deny = false
    yield* seedSession
    const autonomy = yield* SessionAutonomy.Service
    const registry = yield* ToolRegistry.Service
    yield* autonomy.set({ sessionID, answers: "yolo" })
    decisionBehavior = decisionChoice("Careful", 0.9)
    expect((yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "yolo", name: "question", input: { questions: [plan] } } })).output?.structured).toEqual({ answers: [["Careful"]], automatic: true, via: "yolo", confidence: 0.9, assessment: gradedAssessment })
  }))

  autonomous.effect("automatic answers in an active goal retain machine attribution", () => Effect.gen(function* () {
    deny = false
    yield* seedSession
    const autonomy = yield* SessionAutonomy.Service
    const registry = yield* ToolRegistry.Service
    yield* autonomy.set({ sessionID, answers: "auto" })
    yield* autonomy.setGoal({ sessionID, text: "Choose safely" })
    decisionBehavior = () => Effect.die("Auto answers must not request judgments")
    const settled = yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "goal", name: "question", input: { questions: [recommendedPlan] } } })
    const text = `Answers were selected automatically, not provided or approved by the user: "${plan.question}"="Fast (Recommended)". Continue independent work within the authorized scope and follow the active goal when one exists. Do not reopen routine choices or treat an automatic selection to wait as a new user instruction or authorization constraint. Permissions, guardrails, and explicit human-only approvals still apply.`
    expect(settled.result).toEqual({ type: "text", value: text })
    expect(settled.output?.structured).toEqual({ answers: [["Fast (Recommended)"]], automatic: true, via: "auto-answer", assessment: modelFreeAssessment("auto") })
    expect(settled.output?.content).toEqual([{ type: "text", text }])
    expect(settled.result.value).not.toContain("User has answered")
  }))

  autonomous.effect("a human reply winning automatic settlement keeps user attribution", () => Effect.gen(function* () {
    deny = false
    decisionBehavior = () => Effect.die("Questions must not request judgments")
    yield* seedSession
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, answers: "auto" })
    yield* autonomy.setGoal({ sessionID, text: "Choose safely" })
    const forms = yield* Form.Service
    const events = yield* EventRuntime.Service
    const unsubscribe = yield* events.listen((event) => event.type === Form.Event.Created.type
      ? forms.reply({ id: Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form.id, answer: { q0: "Careful" } }).pipe(Effect.orDie)
      : Effect.void)
    yield* Effect.addFinalizer(() => unsubscribe)
    const registry = yield* ToolRegistry.Service
    const text = `User has answered your questions: "${plan.question}"="Careful". You can now continue with the user's answers in mind.`
    expect(yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "human-winner", name: "question", input: { questions: [plan] } } })).toEqual({
      result: { type: "text", value: text }, output: { structured: { answers: [["Careful"]], assessment: modelFreeAssessment("auto") }, content: [{ type: "text", text }] },
    })
  }))
})
