import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Agent } from "@ycoding-ai/core/agent"
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
import { TestClock } from "effect/testing"
import { imagePassthrough } from "./lib/image"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { ConfigDecisions } from "@ycoding-ai/core/config/decisions"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { Project } from "@ycoding-ai/core/project"
import { Location } from "@ycoding-ai/core/location"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionPermissionCeiling } from "@ycoding-ai/core/session/permission-ceiling"
import { toolIdentity, executeTool, registerToolPlugin, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = Session.ID.make("ses_question_tool_test")
const suggestions: {
  settings?: ConfigDecisions.Info
  choose: (input: Decision.ChoiceInput) => Effect.Effect<Decision.Choice, Decision.Error>
  calls: Decision.ChoiceInput[]
} = { choose: () => Effect.die("Questions must not request a suggestion without a configured policy"), calls: [] }
const decision = Layer.mock(Decision.Service, {
  settings: () => Effect.sync(() => suggestions.settings),
  choose: (input) => Effect.sync(() => suggestions.calls.push(input)).pipe(Effect.andThen(suggestions.choose(input))),
})
const suggest = (settings: ConfigDecisions.Info, choose: typeof suggestions.choose) => {
  suggestions.settings = settings
  suggestions.choose = choose
  suggestions.calls.length = 0
}
const plan = {
  question: "Which rollout plan fits the user's request to avoid downtime?",
  header: "Plan",
  options: [
    { label: "Fast", description: "Deploy everything at once" },
    { label: "Careful", description: "Roll out gradually with health checks" },
  ],
}
const assertions: Permission.AssertInput[] = []
let captured: Form.CreateInput | undefined
let reject = false
let deny = false
let denyDecision = false
const capturedInput = () => captured
const questionInput = {
  questions: [
    {
      question: "Continue?",
      header: "Continue",
      options: [{ label: "Yes", description: "Continue" }],
    },
  ],
}
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    evaluateEffective: () => Effect.succeed(denyDecision ? "deny" : "ask"),
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          deny
            ? Effect.fail(
                new Permission.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                }),
              )
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const form = Layer.succeed(
  Form.Service,
  Form.Service.of({
    ask: (input: Form.CreateInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(
        Effect.andThen(
          Effect.sync(
            (): Form.TerminalState =>
              reject ? { status: "cancelled" } : { status: "answered", answer: { q0: "Build", q1: ["Dev"] } },
          ),
        ),
      ),
    create: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    state: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
  }),
)
const questionToolNode = makeLocationNode({
  name: "test/question-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(QuestionTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Permission.node, Form.node, Decision.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, questionToolNode]), [
    [Permission.node, permission],
    [Form.node, form],
    [Decision.node, decision],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ]),
)
const withForms = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, questionToolNode, Form.node, EventRuntime.node]),
    [
      [Permission.node, permission],
      [Decision.node, decision],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)
const autonomous = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      questionToolNode,
      Form.node,
      EventRuntime.node,
      Database.node,
      SessionAutonomy.node,
    ]),
    [
      [Permission.node, permission],
      [Decision.node, decision],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)
const withPermissions = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      questionToolNode,
      Form.node,
      EventRuntime.node,
      Database.node,
      SessionAutonomy.node,
      Permission.node,
      Agent.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make("/tmp/ycoding-question"),
            project: { id: Project.ID.global, directory: AbsolutePath.make("/tmp/ycoding-question") },
          }),
        ),
      ],
      [Decision.node, decision],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)

const seedSession = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({
      id: Project.ID.global,
      worktree: AbsolutePath.make("/tmp/ycoding-question"),
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory: AbsolutePath.make("/tmp/ycoding-question"),
      path: "",
      title: "Question suggestions",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("QuestionTool", () => {
  withPermissions.effect(
    "retains an inherited provider deny despite configured suggestions and autonomous permission",
    () =>
      Effect.gen(function* () {
        yield* seedSession
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            suggestions.settings = undefined
          }),
        )
        const agents = yield* Agent.Service
        yield* agents.transform((draft) =>
          draft.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
          }),
        )
        const database = yield* Database.Service
        yield* database.db
          .update(SessionTable)
          .set({
            permission: SessionPermissionCeiling.inherit(undefined, [
              { action: "decision", resource: "typesafe", effect: "deny" },
            ]),
          })
          .run()
          .pipe(Effect.orDie)
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.setGoal({ sessionID, text: "Choose safely" })
        suggest(
          new ConfigDecisions.Info({
            questions: new ConfigDecisions.Policy({ provider: "typesafe", min_probability: 0.7 }),
          }),
          () => Effect.succeed({ choice: "Careful", probability: 0.9, refused: false }),
        )
        const registry = yield* ToolRegistry.Service
        const permissions = yield* Permission.Service
        const settled = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-ceiling", name: "question", input: { questions: [plan] } },
        })
        expect(suggestions.calls).toEqual([])
        expect(settled.output?.structured).toEqual({ answers: [["Fast"]] })
        expect(yield* permissions.list()).toEqual([])
      }),
  )

  autonomous.effect("normal mode retains suggested wire defaults but requires a human reply", () =>
    Effect.gen(function* () {
      deny = false
      yield* seedSession
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          suggestions.settings = undefined
        }),
      )
      suggest(
        new ConfigDecisions.Info({
          questions: new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.7 }),
        }),
        () => Effect.succeed({ choice: "Careful", confidence: 0.9, refused: false }),
      )
      const registry = yield* ToolRegistry.Service
      const forms = yield* Form.Service
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === Form.Event.Created.type
          ? Deferred.succeed(created, Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form).pipe(
              Effect.asVoid,
            )
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-question-normal-suggested",
          name: "question",
          input: { questions: [plan] },
        },
      }).pipe(Effect.forkScoped)
      const wire = Schema.decodeUnknownSync(Form.Info)(JSON.parse(JSON.stringify(yield* Deferred.await(created))))
      expect(wire.fields[0]).toMatchObject({ key: "q0", type: "string", default: "Careful" })
      expect(yield* forms.state(wire.id)).toEqual({ status: "pending" })
      expect(yield* forms.list({ sessionID })).toHaveLength(1)
      yield* forms.reply({ id: wire.id, answer: { q0: "Fast" } })
      expect((yield* Fiber.join(fiber)).output?.structured).toEqual({
        answers: [["Fast"]],
        suggestions: [{ index: 0, label: "Careful", metric: "confidence", value: 0.9 }],
      })
    }),
  )

  it.effect("skips inference on an effective decision-provider deny without blocking the question", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      denyDecision = true
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          denyDecision = false
          suggestions.settings = undefined
        }),
      )
      suggest(
        new ConfigDecisions.Info({
          questions: new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.7 }),
        }),
        () => Effect.succeed({ choice: "Careful", confidence: 0.9, refused: false }),
      )
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-question-decision-denied",
          name: "question",
          input: { questions: [plan] },
        },
      })
      expect(suggestions.calls).toEqual([])
      expect(capturedInput()?.fields[0]).not.toHaveProperty("default")
      expect(settled.output?.structured).toEqual({ answers: [["Build"]] })
    }),
  )

  it.effect("preserves an explicit recommended option without replacing it with helper advice", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          suggestions.settings = undefined
        }),
      )
      suggest(
        new ConfigDecisions.Info({
          questions: new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.7 }),
        }),
        () => Effect.succeed({ choice: "Careful", confidence: 0.9, refused: false }),
      )
      const registry = yield* ToolRegistry.Service
      const recommended = { ...plan, options: [{ ...plan.options[0], label: "Fast (Recommended)" }, plan.options[1]] }
      yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-question-recommended",
          name: "question",
          input: { questions: [recommended] },
        },
      })
      expect(suggestions.calls).toEqual([])
      expect(capturedInput()?.fields[0]).not.toHaveProperty("default")
      expect(capturedInput()?.fields[0]).toMatchObject({
        options: [{ label: "Fast (Recommended)" }, { label: "Careful" }],
      })
    }),
  )

  it.effect("bounds concurrent suggestions and interrupts queued work within one preparation timeout", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          suggestions.settings = undefined
        }),
      )
      const entered = yield* Deferred.make<void>()
      const interrupted: string[] = []
      let started = 0
      suggest(
        new ConfigDecisions.Info({
          timeout_ms: 100,
          questions: new ConfigDecisions.Policy({ provider: "openai", min_probability: 0.7 }),
        }),
        (input) =>
          Effect.gen(function* () {
            started++
            if (started === 4) yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          }).pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.push(JSON.stringify(input.state))))),
      )
      const registry = yield* ToolRegistry.Service
      const fiber = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-question-time-budget",
          name: "question",
          input: { questions: Array.from({ length: 9 }, (_, index) => ({ ...plan, header: `Plan ${index}` })) },
        },
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      expect(suggestions.calls).toHaveLength(4)
      yield* TestClock.adjust("100 millis")
      const settled = yield* Fiber.join(fiber)
      expect(suggestions.calls).toHaveLength(4)
      expect(interrupted).toHaveLength(4)
      expect(capturedInput()?.fields).toHaveLength(9)
      expect(capturedInput()?.fields.some((field) => "default" in field)).toBe(false)
      expect(settled.output?.structured).not.toHaveProperty("suggestions")
    }),
  )

  withForms.effect("propagates interruption during suggestions without publishing a form or fabricated answer", () =>
    Effect.gen(function* () {
      deny = false
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          suggestions.settings = undefined
        }),
      )
      const entered = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      suggest(
        new ConfigDecisions.Info({
          questions: new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.7 }),
        }),
        () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      )
      const registry = yield* ToolRegistry.Service
      const forms = yield* Form.Service
      const fiber = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question-interrupted", name: "question", input: { questions: [plan] } },
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Deferred.await(interrupted)
      expect(yield* forms.list({ sessionID })).toEqual([])
    }),
  )

  it.effect("agent question suggestions wait beyond the native budget and retain their result", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      yield* Effect.addFinalizer(() => Effect.sync(() => { suggestions.settings = undefined }))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      suggest(new ConfigDecisions.Info({ timeout_ms: 100,
        questions: new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.7 }),
      }), () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)),
        Effect.as({ choice: "Careful", confidence: 0.9, refused: false })))
      const registry = yield* ToolRegistry.Service
      const fiber = yield* settleTool(registry, { sessionID, ...toolIdentity, call: {
        type: "tool-call", id: "call-agent-question-no-deadline", name: "question", input: { questions: [plan] },
      } }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* TestClock.adjust("1 minute")
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(capturedInput()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result.output?.structured).toMatchObject({ suggestions: [{ label: "Careful", metric: "confidence", value: 0.9 }] })
      expect(suggestions.calls).toHaveLength(1)
    }),
  )

  withForms.effect("holds a blocker for human review and missing evidence until the real Form is answered", () =>
    Effect.gen(function* () {
      deny = false
      const registry = yield* ToolRegistry.Service
      const forms = yield* Form.Service
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === Form.Event.Created.type
          ? Deferred.succeed(created, Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form).pipe(
              Effect.asVoid,
            )
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-human-review",
          name: "question",
          input: {
            questions: [
              {
                header: "Review",
                question: "The failure did not reproduce. Should I continue investigating or stop?",
                options: [
                  { label: "Continue", description: "Investigate the failing input" },
                  { label: "Stop", description: "Stop without a speculative fix" },
                ],
              },
              { header: "Evidence", question: "Paste the exact failing input.", options: [] },
            ],
          },
        },
      }).pipe(Effect.forkScoped)
      const pending = yield* Deferred.await(created)
      expect(yield* forms.list({ sessionID })).toEqual([pending])
      expect(yield* forms.state(pending.id)).toEqual({ status: "pending" })
      expect(pending.metadata).toEqual({
        kind: "question",
        tool: { messageID: toolIdentity.messageID, callID: "call-human-review" },
      })
      expect(pending.fields[1]).toMatchObject({ key: "q1", type: "string", options: [], custom: true })
      yield* forms.reply({ id: pending.id, answer: { q0: "Continue", q1: "Synthetic failing input" } })
      expect(yield* Fiber.join(fiber)).toMatchObject({
        output: { structured: { answers: [["Continue"], ["Synthetic failing input"]] } },
      })
      expect(yield* forms.list({ sessionID })).toEqual([])
    }),
  )

  it.effect("advertises required input, decisions, and review instead of prose-only blockers", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "question")
      expect(definition?.description).toContain(
        "When progress requires user input, a decision, or review, call this tool instead of ending with a prose-only request",
      )
      expect(definition?.description).toContain("For required free-text input, use an empty options array")
    }),
  )

  it.effect("advertises recommendations that follow the user's stated requirements", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "question")

      expect(definition?.description).toContain(
        "Recommend the option that best matches the user's stated requirements and expectations; do not introduce new solutions or problems in the recommendation",
      )
    }),
  )

  it.effect("omits a catalog-denied question and enforces its leaf permission", () =>
    Effect.gen(function* () {
      captured = undefined
      deny = true
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry, [{ action: "question", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-denied", name: "question", input: questionInput },
        }),
      ).toEqual({
        result: { type: "error", value: "Permission denied: question" },
        error: {
          type: "permission.rejected",
          message: "Permission denied: question",
        },
      })
      expect(capturedInput()).toBeUndefined()
      deny = false
    }),
  )

  it.effect("registers question and projects user answers without a permission assertion", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      deny = false
      const registry = yield* ToolRegistry.Service
      const questions = [
        {
          question: "What should happen?",
          header: "Action",
          options: [{ label: "Build", description: "Build it" }],
        },
        {
          question: "Which environment?",
          header: "Environment",
          options: [{ label: "Dev", description: "Development" }],
          multiple: true,
        },
        {
          question: "Anything else?",
          header: "Optional",
          options: [],
        },
      ]

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["question"])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question", name: "question", input: { questions } },
        }),
      ).toEqual({
        result: {
          type: "text",
          value:
            'User has answered your questions: "What should happen?"="Build", "Which environment?"="Dev", "Anything else?"="Unanswered". You can now continue with the user\'s answers in mind.',
        },
        output: {
          structured: { answers: [["Build"], ["Dev"], []] },
          content: [
            {
              type: "text",
              text: 'User has answered your questions: "What should happen?"="Build", "Which environment?"="Dev", "Anything else?"="Unanswered". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "question", resources: ["*"] }])
      expect(capturedInput()).toEqual({
        sessionID,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: toolIdentity.messageID, callID: "call-question" } },
        fields: [
          {
            key: "q0",
            title: "Action",
            description: "What should happen?",
            options: [{ value: "Build", label: "Build", description: "Build it" }],
            custom: true,
            type: "string",
          },
          {
            key: "q1",
            title: "Environment",
            description: "Which environment?",
            options: [{ value: "Dev", label: "Dev", description: "Development" }],
            custom: true,
            type: "multiselect",
          },
          {
            key: "q2",
            title: "Optional",
            description: "Anything else?",
            options: [],
            custom: true,
            type: "string",
          },
        ],
      })
    }),
  )

  it.effect("does not invent tool ownership metadata without a durable registry source", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      const registryService = yield* ToolRegistry.Service

      yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "question", input: questionInput },
      })
      expect(capturedInput()).toEqual({
        sessionID,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: toolIdentity.messageID, callID: "call-question" } },
        fields: [
          {
            key: "q0",
            title: "Continue",
            description: "Continue?",
            options: [{ value: "Yes", label: "Yes", description: "Continue" }],
            custom: true,
            type: "string",
          },
        ],
      })
    }),
  )

  it.effect("keeps dismissed questions out of model-facing output", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = true
      deny = false
      const registryService = yield* ToolRegistry.Service
      const fiber = yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "question", input: questionInput },
      }).pipe(Effect.forkScoped)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(QuestionTool.CancelledError)
        expect(error).toHaveProperty("message", "The user dismissed this question")
      }
    }),
  )

  it.effect("advertises self-contained question text for configured decision suggestions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definition = (yield* toolDefinitions(registry)).find((tool) => tool.name === "question")
      expect(definition?.description).toContain(
        "Make each question and option description self-contained; a configured decision helper may suggest an option from that text alone",
      )
    }),
  )

  it.effect("preselects and labels a confident decision suggestion for the user and reports it to the agent", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      deny = false
      suggest(
        new ConfigDecisions.Info({
          questions: new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.7 }),
        }),
        () => Effect.succeed({ choice: "Careful", confidence: 0.9, refused: false }),
      )
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-question-suggested",
          name: "question",
          input: {
            questions: [
              plan,
              {
                question: "Which environments?",
                header: "Environments",
                options: [
                  { label: "Dev", description: "Development" },
                  { label: "Prod", description: "Production" },
                ],
                multiple: true,
              },
              { question: "Anything else?", header: "Optional", options: [] },
              { question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] },
              {
                question: "Which region?",
                header: "Region",
                options: [
                  { label: "EU", description: "Frankfurt" },
                  { label: "EU", description: "Dublin" },
                ],
              },
            ],
          },
        },
      })

      expect(suggestions.calls).toEqual([
        {
          context: { sessionID, agent: toolIdentity.agent },
          provider: "agent",
          state: { header: plan.header, question: plan.question },
          instructions: expect.stringContaining("untrusted data"),
          choices: { Fast: "Deploy everything at once", Careful: "Roll out gradually with health checks" },
        },
      ])
      expect(capturedInput()?.fields[0]).toEqual({
        key: "q0",
        title: "Plan",
        description: plan.question,
        type: "string",
        custom: true,
        default: "Careful",
        options: [
          { value: "Fast", label: "Fast", description: "Deploy everything at once" },
          {
            value: "Careful",
            label: "Careful",
            description:
              "Roll out gradually with health checks (Suggested by the decision helper: model confidence 0.90, uncalibrated)",
          },
        ],
      })
      expect(
        capturedInput()
          ?.fields.slice(1)
          .some((field) => "default" in field),
      ).toBe(false)
      expect(settled).toMatchObject({
        output: {
          structured: {
            answers: [["Build"], ["Dev"], [], [], []],
            suggestions: [{ index: 0, label: "Careful", metric: "confidence", value: 0.9 }],
          },
        },
      })
      expect(settled.result).toMatchObject({
        type: "text",
        value: expect.stringContaining(
          `Decision helper suggestions shown to the user, not their answers: "${plan.question}"="Careful" (model confidence 0.90, uncalibrated).`,
        ),
      })
    }),
  )

  it.effect("asks unchanged when no policy applies or the suggestion is uncertain, refused, or unavailable", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const policy = new ConfigDecisions.Info({
        questions: new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.7 }),
      })
      const outcomes: Array<[ConfigDecisions.Info | undefined, Effect.Effect<Decision.Choice, Decision.Error>]> = [
        [undefined, Effect.die("Unconfigured questions must not request a suggestion")],
        [policy, Effect.succeed({ choice: "Careful", confidence: 0.69, refused: false })],
        [policy, Effect.succeed({ choice: "Careful", probability: 0.99, refused: false })],
        [policy, Effect.succeed({ refused: true })],
        [policy, Effect.fail(new Decision.Error({ reason: "timeout" }))],
      ]
      for (const [settings, outcome] of outcomes) {
        captured = undefined
        reject = false
        deny = false
        suggest(policy, () => outcome)
        suggestions.settings = settings
        const settled = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-uncertain", name: "question", input: { questions: [plan] } },
        })
        expect(suggestions.calls).toHaveLength(settings === undefined ? 0 : 1)
        expect(capturedInput()?.fields[0]).toEqual({
          key: "q0",
          title: "Plan",
          description: plan.question,
          type: "string",
          custom: true,
          options: plan.options.map((option) => ({
            value: option.label,
            label: option.label,
            description: option.description,
          })),
        })
        expect(settled.output?.structured).toEqual({ answers: [["Build"]] })
      }
      suggestions.settings = undefined
    }),
  )

  autonomous.effect("autonomous questions take a confident suggestion instead of the first option", () =>
    Effect.gen(function* () {
      deny = false
      yield* seedSession
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID, yolo: 1 })
      const registry = yield* ToolRegistry.Service
      const ask = (id: string) =>
        settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id, name: "question", input: { questions: [plan] } },
        })

      suggestions.settings = undefined
      expect((yield* ask("call-question-baseline")).output?.structured).toEqual({ answers: [["Fast"]] })

      suggest(
        new ConfigDecisions.Info({
          questions: new ConfigDecisions.Policy({ provider: "openai", min_probability: 0.8 }),
        }),
        () => Effect.succeed({ choice: "Careful", probability: 0.85, confidence: 0.1, refused: false }),
      )
      const suggested = yield* ask("call-question-autonomous")
      expect(suggested.output?.structured).toEqual({
        answers: [["Careful"]],
        suggestions: [{ index: 0, label: "Careful", metric: "probability", value: 0.85 }],
      })
      expect(suggested.result).toMatchObject({
        value: expect.stringContaining(`"${plan.question}"="Careful" (native probability 0.85)`),
      })
      yield* autonomy.setMode({ sessionID, mode: "normal" })
      yield* autonomy.setGoal({ sessionID, text: "Choose safely" })
      expect((yield* ask("call-question-goal")).output?.structured).toEqual({
        answers: [["Careful"]],
        suggestions: [{ index: 0, label: "Careful", metric: "probability", value: 0.85 }],
      })
      suggestions.settings = undefined
    }),
  )
})
