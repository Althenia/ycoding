import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { SessionV2 } from "@ycoding-ai/core/session"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { QuestionTool } from "@ycoding-ai/core/tool/question"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Image } from "@ycoding-ai/core/image"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { toolIdentity, executeTool, registerToolPlugin, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_question_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let captured: Form.CreateInput | undefined
let reject = false
let deny = false
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
  PermissionV2.Service,
  PermissionV2.Service.of({
    evaluateEffective: () => Effect.die(new Error("unused PermissionV2.evaluateEffective")),
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          deny
            ? Effect.fail(
                new PermissionV2.BlockedError({
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
  deps: [ToolRegistry.toolsNode, PermissionV2.node, Form.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, questionToolNode]), [
    [PermissionV2.node, permission],
    [Form.node, form],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Image.node, imagePassthrough],
  ]),
)
const withForms = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, questionToolNode, Form.node, EventV2.node]),
    [
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)

describe("QuestionTool", () => {
  withForms.effect("holds a blocker for human review and missing evidence until the real Form is answered", () =>
    Effect.gen(function* () {
      deny = false
      const registry = yield* ToolRegistry.Service
      const forms = yield* Form.Service
      const events = yield* EventV2.Service
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
})
