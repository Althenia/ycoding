import { describe, expect, test } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  Model,
  SystemPart,
  ToolFailure,
  TransportReason,
  InvalidProviderOutputReason,
  InvalidRequestReason,
  RateLimitReason,
  type LLMClientShape,
  type LLMRequest,
} from "@ycoding-ai/ai"
import * as AnthropicMessages from "@ycoding-ai/ai/protocols/anthropic-messages"
import * as OpenAIChat from "@ycoding-ai/ai/protocols/openai-chat"
import * as OpenAIResponses from "@ycoding-ai/ai/protocols/openai-responses"
import { classifyProviderFailure } from "@ycoding-ai/ai/provider-error"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Database } from "@ycoding-ai/core/database/database"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Project } from "@ycoding-ai/core/project"
import { ProjectArtifactInstructions } from "@ycoding-ai/core/project-artifact/instructions"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Form } from "@ycoding-ai/core/form"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Snapshot } from "@ycoding-ai/core/snapshot"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPermissionCeiling } from "@ycoding-ai/core/session/permission-ceiling"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { ProviderRequestObserver } from "@ycoding-ai/core/session/provider-request-observer"
import { Money } from "@ycoding-ai/schema/money"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRunCoordinator } from "@ycoding-ai/core/session/run-coordinator"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import * as SessionRunnerLLM from "@ycoding-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionUsage } from "@ycoding-ai/core/session/usage"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { SystemPromptPlugin } from "@ycoding-ai/core/plugin/system-prompt"
import { QuestionTool } from "@ycoding-ai/core/tool/question"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { ConfigEfficiency } from "@ycoding-ai/core/config/efficiency"
import { Tool } from "@ycoding-ai/core/tool/tool"
import {
  InstructionStateTable,
  SessionPendingTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionProviderContinuationTable,
  SessionProviderStateBlobTable,
  SessionProviderStateLinkTable,
  SessionProviderRequestTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionSummaryToon } from "@ycoding-ai/core/session/summary-toon"
import { Instructions } from "@ycoding-ai/core/instructions"
import { InstructionBuiltIns } from "@ycoding-ai/core/instructions/builtins"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { SkillInstructions } from "@ycoding-ai/core/skill/instructions"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { ReferenceInstructions } from "@ycoding-ai/core/reference/instructions"
import { McpInstructions } from "@ycoding-ai/core/mcp/instructions"
import { ModelV2 } from "@ycoding-ai/core/model"
import { Location } from "@ycoding-ai/core/location"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { and, asc, eq, lte } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { agentHost, catalogHost, host } from "./plugin/host"
import PROMPT_DEFAULT from "../src/session/runner/prompt/base.txt"

const requests: LLMRequest[] = []
const requestKeepalive: Array<boolean | undefined> = []
const runnerDirectory = AbsolutePath.make(import.meta.dir)
type TestStreamError = LLMError | Error
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, TestStreamError> | undefined
let responseStreams: Stream.Stream<LLMEvent, TestStreamError>[] | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const observed = <E>(stream: Stream.Stream<LLMEvent, E>) =>
        Stream.unwrap(
          Effect.gen(function* () {
            requestKeepalive.push(
              Option.getOrUndefined(yield* Effect.serviceOption(FetchHttpClient.RequestInit))?.keepalive,
            )
            yield* ProviderRequestObserver.observe({
              requestID: request.id ?? "request",
              routeID: request.model.route.id,
              transport: "test-client",
              attempt: 1,
              phase: "started",
              time: 0,
            })
            return stream
          }),
        )
      if (responseStreams) return observed(responseStreams.shift() ?? Stream.empty)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return observed(stream)
      }
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return observed(events)
      return observed(
        Stream.unwrap(
          (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
            Effect.andThen(Deferred.await(streamGate)),
            Effect.as(events),
          ),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const reply = {
  silence: () => [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ],
  text: (text: string, id: string) => fragmentFixture("text", id, [text]).completeEvents,
  textWithUsage: (text: string, id: string, inputTokens: number) =>
    fragmentFixture("text", id, [text]).completeEvents.map((event) =>
      LLMEvent.is.stepFinish(event)
        ? LLMEvent.stepFinish({
            index: event.index,
            reason: event.reason,
            usage: { inputTokens, nonCachedInputTokens: inputTokens },
          })
        : event,
    ),
  textWithCache: (text: string, id: string, cacheReadInputTokens: number, cacheWriteInputTokens: number) =>
    fragmentFixture("text", id, [text]).completeEvents.map((event) =>
      LLMEvent.is.stepFinish(event)
        ? LLMEvent.stepFinish({
            index: event.index,
            reason: event.reason,
            usage: {
              inputTokens: 1_200,
              nonCachedInputTokens: Math.max(0, 1_200 - cacheReadInputTokens - cacheWriteInputTokens),
              cacheReadInputTokens,
              cacheWriteInputTokens,
            },
          })
        : event,
    ),
  textWithResponse: (text: string, id: string, responseID: string) =>
    fragmentFixture("text", id, [text]).completeEvents.map((event) =>
      LLMEvent.is.stepFinish(event)
        ? LLMEvent.stepFinish({
            index: event.index,
            reason: event.reason,
            providerMetadata: { openai: { responseId: responseID } },
          })
        : event,
    ),
  tool: (id: string, name: string, input: unknown) => [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id, name, input }),
    LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ],
  toolWithResponse: (id: string, name: string, input: unknown, responseID: string) => [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolCall({ id, name, input }),
    LLMEvent.stepFinish({
      index: 0,
      reason: "tool-calls",
      providerMetadata: { openai: { responseId: responseID } },
    }),
    LLMEvent.finish({ reason: "tool-calls" }),
  ],
}
const testLimits = { context: 262_144, output: 8_192 } as const
const model = Model.make({
  id: "fake-model",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: testLimits }),
})
const codexModel = Model.make({
  id: "gpt-5.6",
  provider: "openai",
  route: OpenAIResponses.route.with({
    id: "openai-codex-responses",
    provider: "openai",
    limits: testLimits,
  }),
})
const anthropicCacheModel = Model.make({
  id: "claude-sonnet-4-5",
  provider: "anthropic",
  route: AnthropicMessages.route.with({ limits: testLimits }),
})
const openAI56Model = Model.make({
  id: "gpt-5.6",
  provider: "openai",
  route: OpenAIChat.route.with({ limits: testLimits }),
})
const storedOpenAIResponsesModel = Model.make({
  id: "gpt-5.6",
  provider: "openai",
  route: OpenAIResponses.route.with({ limits: testLimits }),
  defaults: { providerOptions: { openai: { store: true } } },
})
const storedRecoveryResponsesModel = Model.make({
  id: "gpt-5.6",
  provider: "openai",
  route: OpenAIResponses.route.with({ limits: { context: 20_000, output: 1_000 } }),
  defaults: { providerOptions: { openai: { store: true } } },
})
const storedCopilotResponsesModel = Model.make({
  id: "gpt-5.6",
  provider: "github-copilot",
  route: OpenAIResponses.route.with({
    id: "ai-sdk:@ai-sdk/github-copilot",
    provider: "github-copilot",
    limits: testLimits,
  }),
  defaults: { providerOptions: { openai: { store: true } } },
})
const unstoredOpenAIResponsesModel = Model.make({
  id: "gpt-5.6",
  provider: "openai",
  route: OpenAIResponses.route.with({ limits: testLimits }),
})
const defaultSystem = PROMPT_DEFAULT
const withProjectArtifactGuidance = (...values: readonly string[]) =>
  [...values, ProjectArtifactInstructions.content].join("\n\n")
const replacementModel = Model.make({
  id: "replacement",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: testLimits }),
})
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const fullOutputModel = Model.make({
  id: "full-output",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 262_144, output: 262_144 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const missingOutputLimitModel = Model.make({
  id: "missing-output-limit",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000 } }),
})
const missingContextLimitModel = Model.make({ id: "missing-context-limit", provider: "fake", route: OpenAIChat.route })

test("calculates step cost using the matching context tier", () => {
  expect(
    SessionUsage.calculateCost(
      [
        {
          input: Money.USDPerMillionTokens.make(1),
          output: Money.USDPerMillionTokens.make(2),
          cache: {
            read: Money.USDPerMillionTokens.make(0.1),
            write: Money.USDPerMillionTokens.make(0.5),
          },
        },
        {
          tier: { type: "context", size: 100 },
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(4),
          cache: {
            read: Money.USDPerMillionTokens.make(0.2),
            write: Money.USDPerMillionTokens.make(0.6),
          },
        },
      ],
      { input: 80, output: 10, reasoning: 2, cache: { read: 20, write: 1 } },
    ),
  ).toBeCloseTo(0.0002926)
})

test("calculates current OpenAI and Anthropic list-price estimates including cache usage", () => {
  const usage = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 50_000, write: 10_000 } }
  expect(
    SessionUsage.calculateCost(
      [
        {
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(30),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.make(6.25),
          },
        },
      ],
      usage,
    ),
  ).toBeCloseTo(0.8875)
  expect(
    SessionUsage.calculateCost(
      [
        {
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(25),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.make(6.25),
          },
        },
      ],
      usage,
    ),
  ).toBeCloseTo(0.8375)
})

test("does not apply an ineligible tier without base pricing", () => {
  expect(
    SessionUsage.calculateCost(
      [
        {
          tier: { type: "context", size: 100 },
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(4),
          cache: {
            read: Money.USDPerMillionTokens.make(0.2),
            write: Money.USDPerMillionTokens.make(0.6),
          },
        },
      ],
      { input: 80, output: 10, reasoning: 2, cache: { read: 20, write: 0 } },
    ),
  ).toBe(Money.USD.zero)
})

const authorizations: Tool.Context[] = []
const executions: string[] = []
const permissionFail = Tool.make({
  description: "Reject a permission",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  execute: () =>
    new ToolFailure({
      message: "Permission denied: edit",
      error: new PermissionV2.BlockedError({
        rules: [],
        permission: "edit",
        resources: ["src/index.ts"],
      }),
    }),
})
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    evaluateEffective: () => Effect.die(new Error("unused PermissionV2.evaluateEffective")),
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register(
      {
        echo: Tool.make({
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: ({ text }, context) =>
            Effect.gen(function* () {
              authorizations.push(context)
              executions.push(text)
              activeToolExecutions++
              maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
              if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
                yield* Deferred.succeed(toolExecutionsStarted, undefined)
              }
              if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
              return { text }
            }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
        }),
        defect: Tool.make({
          description: "Fail unexpectedly",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            (toolExecutionGate ? Deferred.await(toolExecutionGate) : Effect.void).pipe(
              Effect.andThen(Effect.die("unexpected tool defect")),
            ),
        }),
        // BigInt output with no model content forces ToolOutputStore.bound onto its
        // JSON.stringify encode path, which fails with a typed StorageError.
        storefail: Tool.make({
          description: "Produce output that cannot be persisted",
          input: Schema.Struct({}),
          output: Schema.Any,
          execute: () => Effect.succeed({ big: 1n }),
        }),
      },
      { codemode: false },
    ),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })
let modelResolveHook = Effect.void
let currentModel = model
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(
    Effect.as(
      SessionRunnerModel.resolved(
        session.model?.id === "replacement" ? replacementModel : currentModel,
        session.model?.variant,
        [],
      ),
    ),
  ),
)
const systemContextKey = Instructions.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.mock(InstructionBuiltIns.Service, {
  load: () =>
    Effect.sync(() =>
      Instructions.make({
        key: systemContextKey,
        codec: Schema.toCodecJson(Schema.String),
        read: systemLoadHook.pipe(
          Effect.andThen(
            Effect.sync(() =>
              systemUnavailable ? Instructions.unavailable : systemRemoved ? Instructions.removed : systemBaseline,
            ),
          ),
        ),
        render: {
          initial: String,
          changed: (_previous, current) => current,
          removed: () => "System context source removed: test/context",
        },
      }),
    ),
})
const instructionContext = Layer.mock(InstructionDiscovery.Service, { load: () => Effect.succeed(Instructions.empty) })
const skillInstructions = Layer.mock(SkillInstructions.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? Instructions.make({
            key: Instructions.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            read: Effect.succeed(skillBaselines.get(agent.id)!),
            render: {
              initial: String,
              changed: (_previous, current) => current,
              removed: () => "Skill guidance removed",
            },
          })
        : Instructions.empty,
    ),
})
const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
  load: () => Effect.succeed(Instructions.empty),
})
const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const projects = Layer.mock(Project.Service, {
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
})
let efficiencyConfig: ConfigEfficiency.Info | undefined
let compactionWakeHook = Effect.void
let compactionSummary = false
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              keep_recent_messages: 20,
              context_safety_margin_tokens: 3_000,
              reserved_output_tokens: 1_000,
            }),
            ...(efficiencyConfig === undefined ? {} : { efficiency: efficiencyConfig }),
          }),
        }),
      ]),
  }),
)
const compactionExecution = Layer.effect(
  SessionCompactionExecution.Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const jobs = yield* SessionCompactionJob.Service
    const contextState = yield* SessionContextState.Service
    const guardrails = yield* SessionGuardrail.Service
    const owner = "runner-test-compaction"
    const run: SessionCompactionExecution.Interface["run"] = (input) =>
      Effect.gen(function* () {
        yield* compactionWakeHook
        const pending = yield* jobs.get(input.jobID)
        if (!pending) return yield* Effect.die(`Compaction job not found: ${input.jobID}`)
        if (pending.status === "ended" || pending.status === "failed")
          return {
            id: pending.id,
            sessionID: pending.sessionID,
            trigger: pending.trigger,
            status: pending.status,
            requestedThrough: pending.requestedThrough,
            timeCreated: DateTime.makeUnsafe(pending.timeCreated),
            ...(pending.errorCode === undefined ? {} : { failure: pending.errorCode }),
          }
        const now = Date.now()
        const job = yield* jobs.claim({ jobID: pending.id, owner, now, expiresAt: now + 30_000 })
        if (!job) return yield* Effect.die(`Compaction job is not claimable: ${pending.id}`)
        const guardrail = yield* guardrails.snapshot(job.sessionID).pipe(Effect.orDie)
        const capture = yield* SessionLiveState.captureDatabase(db, job.sessionID).pipe(Effect.orDie)
        const boundary = compactionSummary
          ? yield* db
              .select({ data: SessionMessageTable.data })
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, job.requestedThrough.messageID))
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (compactionSummary && !boundary) yield* Effect.die("Missing compaction boundary")
        const boundaryData = boundary && Schema.is(Schema.Json)(boundary.data) ? boundary.data : undefined
        if (boundary && !boundaryData) yield* Effect.die("Invalid compaction boundary")
        const coveredUserTexts = compactionSummary
          ? (yield* db
              .select({ data: SessionMessageTable.data })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, job.sessionID),
                  eq(SessionMessageTable.type, "user"),
                  lte(SessionMessageTable.seq, job.requestedThrough.seq),
                ),
              )
              .orderBy(asc(SessionMessageTable.seq))
              .all()
              .pipe(Effect.orDie)).flatMap((row) =>
              Schema.is(Schema.Json)(row.data) &&
              typeof row.data === "object" &&
              row.data !== null &&
              !Array.isArray(row.data) &&
              "text" in row.data &&
              typeof row.data.text === "string" &&
              row.data.text.trim()
                ? [row.data.text]
                : [],
            )
          : []
        const summary = compactionSummary
          ? SessionSummaryToon.encode({
              version: 2,
              through_sequence: job.requestedThrough.seq,
              objective: "Retain the completed exchange.",
              in_progress: [],
              pending: [],
              blocked: [],
              decision: [],
              current_state: "Continue with the next user request.",
              facts: coveredUserTexts.map((text) => ({ text, confidence: "confirmed" as const })),
              preferences: [],
              constraints: [],
              completed: ["The covered exchange completed."],
              unresolved: [],
              important_identifiers: [],
              continuation: "Answer the next user request.",
            })
          : undefined
        yield* contextState
          .activate({
            sessionID: job.sessionID,
            jobID: job.id,
            leaseOwner: owner,
            manifest: Object.freeze({
              schemaVersion: 1,
              baseContextRevision: job.baseContextRevision,
              coveredThrough: Object.freeze({
                messageID: job.requestedThrough.messageID,
                seq: EventV2.Seq.make(job.requestedThrough.seq),
              }),
              protectedState: Object.freeze(
                SessionLiveState.toProtectedState({ ...capture.sources, guardrails: guardrail }).map((entry) =>
                  Object.freeze(entry),
                ),
              ),
              exclusions: Object.freeze([]),
              ...(summary === undefined || boundaryData === undefined
                ? {}
                : {
                    summary: Object.freeze({
                      text: summary,
                      coveredThrough: Object.freeze({
                        messageID: job.requestedThrough.messageID,
                        seq: EventV2.Seq.make(job.requestedThrough.seq),
                      }),
                      digest: ContextManifest.payloadDigest(boundaryData),
                    }),
                  }),
              inputTokens: 100,
              retainedTokens: 50,
            }),
          })
          .pipe(Effect.orDie)
        const settled = yield* jobs.get(job.id)
        if (!settled || (settled.status !== "ended" && settled.status !== "failed"))
          return yield* Effect.die(`Compaction job did not settle: ${job.id}`)
        return {
          id: settled.id,
          sessionID: settled.sessionID,
          trigger: settled.trigger,
          status: settled.status,
          requestedThrough: settled.requestedThrough,
          timeCreated: DateTime.makeUnsafe(settled.timeCreated),
          ...(settled.errorCode === undefined ? {} : { failure: settled.errorCode }),
        }
      })
    const start: SessionCompactionExecution.Interface["start"] = (input) => run(input).pipe(Effect.asVoid)
    return SessionCompactionExecution.Service.of({ start, run })
  }),
)
let pluginFlushHook = Effect.void
const pluginSupervisor = Layer.succeed(
  PluginSupervisor.Service,
  PluginSupervisor.Service.of({
    flush: Effect.suspend(() => pluginFlushHook),
  }),
)
const promptCatalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    small: () => Effect.succeed(undefined),
  },
})
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [InstructionBuiltIns.node, systemContext],
  [InstructionDiscovery.node, instructionContext],
  [Location.node, Location.boundNode({ directory: runnerDirectory })],
  [SkillInstructions.node, skillInstructions],
  [ReferenceInstructions.node, referenceInstructions],
  [PermissionV2.node, permission],
  [Config.node, config],
  [McpInstructions.node, mcpInstructions],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [PluginSupervisor.node, pluginSupervisor],
  [
    SessionCompaction.node,
    Layer.succeed(SessionCompaction.Service, SessionCompaction.Service.of({ manifest: () => Effect.die("unused") })),
  ],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const compactionExecution = yield* SessionCompactionExecution.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) =>
        sessionRunner.drain({ sessionID, force }).pipe(SessionCompactionExecution.bind(compactionExecution)),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      Form.node,
      SessionProjector.node,
      SessionStore.node,
      SessionProviderRequest.node,
      AgentV2.node,
      Catalog.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      PluginHooks.node,
      echoNode,
      SessionRunnerModel.node,
      SessionTodo.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      InstructionEntry.node,
      SkillInstructions.node,
      ReferenceInstructions.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionCompactionJob.node,
      SessionContextState.node,
      SessionGuardrail.node,
      SessionCompactionExecution.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [Project.node, projects],
      [PermissionV2.node, permission],
      [Catalog.node, promptCatalog],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, systemContext],
      [InstructionDiscovery.node, instructionContext],
      [Location.node, Location.boundNode({ directory: runnerDirectory })],
      [SkillInstructions.node, skillInstructions],
      [ReferenceInstructions.node, referenceInstructions],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [PluginSupervisor.node, pluginSupervisor],
      [SessionCompactionExecution.node, compactionExecution],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")
const admit = (session: SessionV2.Interface, text: string) => session.prompt({ sessionID, text, resume: false })

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        directory: runnerDirectory,
        title: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* SessionContextState.initialize(db, id, Date.now())
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const agents = yield* AgentV2.Service
  const catalog = yield* Catalog.Service
  const hooks = yield* PluginHooks.Service
  const pluginHost = host({
    agent: agentHost(agents),
    catalog: catalogHost(catalog),
    session: { hook: (name, callback) => hooks.register("session", name, callback) },
  })
  yield* Effect.forEach(SystemPromptPlugin.Plugins, (plugin) => plugin.effect(pluginHost), {
    discard: true,
  })
  requests.length = 0
  requestKeepalive.length = 0
  authorizations.length = 0
  executions.length = 0
  response = reply.text("Fixture response", "text-fixture")
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  pluginFlushHook = Effect.void
  currentModel = model
  efficiencyConfig = undefined
  compactionWakeHook = Effect.void
  compactionSummary = false
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  responseStreams = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  yield* agents.transform((draft) =>
    draft.update(AgentV2.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: runnerDirectory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
  return yield* SessionV2.Service
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const streamReadFailure = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Connection reset while reading response", kind: "read" }),
  })

const invalidRequest = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new InvalidRequestReason({ message: "Invalid request" }),
  })

const contextOverflow = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new InvalidRequestReason({ message: "Prompt is too long", classification: "context-overflow" }),
  })

const invalidPreviousResponse = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: classifyProviderFailure({
      code: "invalid_previous_response_id",
      message: "Previous response ID is invalid or expired",
    }),
  })

const rateLimited = (retryAfterMs?: number) =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new RateLimitReason({ message: "Rate limited", retryAfterMs }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  const session = yield* setup
  response = reply.text("Earlier answer", "text-earlier")
  yield* admit(session, "Earlier question ".repeat(700))
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")
const nonVolatileMessages = (request: LLMRequest) => request.messages.filter((message) => message.volatile !== true)

const recordedEventTypes = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.type)),
      )
  })

const recordedStepSettlementEvents = (id: SessionV2.ID, assistantMessageID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const settlementTypes = new Set([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.success.1",
      "session.tool.failed.1",
      "session.step.ended.1",
      "session.step.failed.1",
    ])
    return (yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)).filter(
      (event) => settlementTypes.has(event.type) && event.data.assistantMessageID === assistantMessageID,
    )
  })

const hostedCall = (id: string, query: string) =>
  LLMEvent.toolCall({ id, name: "web_search", input: { query }, providerExecuted: true })

const requireAssistant = (messages: readonly SessionMessage.Info[]) => {
  const assistant = messages.find((message) => message.type === "assistant")
  if (!assistant) throw new Error("Assistant message missing")
  return assistant
}

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(InstructionStateTable).where(eq(InstructionStateTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionPendingTable).where(eq(SessionPendingTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        created: DateTime.makeUnsafe(event.created),
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"
type FragmentExpectedContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool"
      readonly id: string
      readonly state: { readonly status: "streaming"; readonly input: string }
    }

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedContent: FragmentExpectedContent
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent: FragmentExpectedContent = { type: "text", text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent: FragmentExpectedContent = { type: "reasoning", text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent: FragmentExpectedContent = { type: "tool", id, state: { status: "streaming", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    const session = yield* setup
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    yield* admit(session, prompt)
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response =
      kind === "text"
        ? fixture.completeEvents
        : [
            ...fixture.completeEvents.slice(0, kind === "reasoning" ? -2 : undefined),
            LLMEvent.textStart({ id: `text-${kind}-completion` }),
            LLMEvent.textDelta({ id: `text-${kind}-completion`, text: "Complete" }),
            LLMEvent.textEnd({ id: `text-${kind}-completion` }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ]

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(
      requireAssistant(yield* session.context(sessionID)).content.find(
        (content) => content.type === fixture.expectedContent.type,
      ),
    ).toMatchObject(fixture.expectedContent)

    yield* replaySessionProjection(sessionID)

    expect(
      requireAssistant(yield* session.context(sessionID)).content.find(
        (content) => content.type === fixture.expectedContent.type,
      ),
    ).toMatchObject(fixture.expectedContent)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    const session = yield* setup
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* admit(session, prompt)
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "provider.transport", message: "Provider unavailable" },
        content: [
          kind === "tool input"
            ? {
                type: "tool",
                id: fragmentID(kind, "partial"),
                state: {
                  status: "error",
                  error: { type: "provider.transport", message: "Provider unavailable" },
                },
              }
            : fixture.expectedContent,
        ],
      },
    ])
    expect(requests).toHaveLength(1)
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    const session = yield* setup
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* admit(session, prompt)
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.drain({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "aborted", message: "Step interrupted" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  it.effect("renders authoritative live state before other volatile context without pending content", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const db = (yield* Database.Service).db
      const hooks = yield* PluginHooks.Service
      const routeIDs: Array<string | undefined> = []
      const todos = yield* SessionTodo.Service
      yield* todos.update({
        sessionID,
        todos: [
          { content: "first", status: "in_progress", priority: "high" },
          { content: "second", status: "pending", priority: "medium" },
        ],
      })
      yield* db
        .insert(SessionPendingTable)
        .values({
          id: SessionMessage.ID.make("msg_queued_live_state_secret"),
          session_id: sessionID,
          type: "user",
          data: { text: "queued secret prompt" },
          delivery: "queue",
          admitted_seq: 10_000,
          time_created: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          routeIDs.push(event.routeID)
          event.messages.push(Message.make({ role: "user", content: "TeamView marker", volatile: true }))
        }),
      )

      yield* admit(session, "Visible prompt")
      yield* session.resume(sessionID)

      const first = requests[0]
      expect(first).toBeDefined()
      expect(routeIDs.length).toBeGreaterThan(0)
      expect(routeIDs.every((routeID) => routeID === first?.model.route.id)).toBe(true)
      const volatile = first.messages.filter((message) => message.volatile === true)
      expect(volatile.map((message) => message.role)).toEqual(["system", "user"])
      expect(volatile[0]?.content).toEqual([
        {
          type: "text",
          text: 'Authoritative current Session state (JSON):\n{"autonomy":{"mode":"normal","yolo":0},"permissionCeiling":[],"todos":[{"content":"first","priority":"high","status":"in_progress"},{"content":"second","priority":"medium","status":"pending"}]}',
        },
      ])
      expect(volatile[1]?.content).toEqual([{ type: "text", text: "TeamView marker" }])
      expect(JSON.stringify(first.messages)).not.toContain("queued secret prompt")
    }),
  )

  it.effect("executes the provider without application artifact routing", () =>
    Effect.gen(function* () {
      const session = yield* setup
      response = reply.text("Provider answer", "provider")
      yield* admit(session, "Execute the provider")

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(assistant.model).toEqual(
        ModelV2.Ref.make({ providerID: ProviderV2.ID.make("fake"), id: ModelV2.ID.make("fake-model") }),
      )
      expect(assistant.content).toEqual([{ type: "text", text: "Provider answer" }])
    }),
  )

  it.effect("persists OpenAI URL citation text through the assistant lifecycle", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const citation = "\n\nSource: Effect Documentation\nhttps://effect.website/docs"
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "citation" }),
          LLMEvent.textDelta({ id: "citation", text: "Read the documentation." }),
          LLMEvent.textDelta({ id: "citation", text: citation }),
          LLMEvent.textEnd({ id: "citation" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        reply.text("Reasoning summary", "text-reasoning-summary"),
      ]
      yield* admit(session, "Cite the Effect documentation.")

      yield* session.resume(sessionID)

      expect(requireAssistant(yield* session.context(sessionID)).content).toEqual([
        { type: "text", text: `Read the documentation.${citation}` },
      ])
    }),
  )

  it.effect("applies session context hooks without exposing unavailable tools", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.system = [SystemPart.make("Hooked system")]
          event.messages = [Message.user("Hooked message")]
          delete event.tools.echo
          event.tools.unregistered = { description: "Unavailable", input: { type: "object" } }
        }),
      )
      yield* admit(session, "Original message")
      response = reply.text("Context hook response", "text-context-hook")

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toEqual(["Hooked system"])
      expect(requests[0]?.messages).toEqual([Message.user("Hooked message")])
      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("echo")
      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("unregistered")
      expect(executions).toEqual([])
      expect(
        (yield* session.context(sessionID)).find((message) => message.type === "user")?.time.consumed,
      ).toBeUndefined()
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.input.consumed.1")
    }),
  )

  it.effect("omits tools denied by the durable session ceiling", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          permission: SessionPermissionCeiling.denyOnly([{ action: "echo", resource: "*", effect: "deny" }]),
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* admit(session, "Do not expose echo")
      response = reply.text("Fixture response", "text-fixture")

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain("echo")
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "storefail"])
    }),
  )

  it.effect("advertises and executes a location registered tool", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      const contexts: Tool.Context[] = []
      yield* registry.register(
        {
          location_context: Tool.make({
            description: "Read application context",
            input: Schema.Struct({ query: Schema.String }),
            output: Schema.Struct({ answer: Schema.String }),
            execute: ({ query }, context) =>
              Effect.gen(function* () {
                contexts.push(context)
                yield* context.progress({ structured: { phase: "reading" } })
                return { answer: query.toUpperCase() }
              }),
          }),
        },
        { codemode: false },
      )
      yield* admit(session, "Use application context")
      responses = [
        reply.tool("call-location", "location_context", { query: "hello" }),
        reply.text("Location response", "text-location-response"),
      ]
      const events = yield* EventV2.Service
      const progressFiber = yield* events.subscribe(SessionEvent.Tool.Progress).pipe(
        Stream.filter((event) => event.data.sessionID === sessionID && event.data.callID === "call-location"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("location_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          messageID: expect.stringMatching(/^msg_/),
          callID: "call-location",
          progress: expect.any(Function),
        },
      ])
      expect(Array.from(yield* Fiber.join(progressFiber))[0]?.data.structured).toEqual({ phase: "reading" })
      expect((yield* session.context(sessionID)).slice(0, 2)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-location",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("executes the tool advertised before a registry reload", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      const scope = yield* Scope.make()
      const executions: string[] = []
      yield* registry
        .register(
          {
            reloaded: Tool.make({
              description: "Record the advertised tool",
              input: Schema.Struct({}),
              output: Schema.Struct({ value: Schema.String }),
              execute: () => Effect.sync(() => executions.push("advertised")).pipe(Effect.as({ value: "advertised" })),
            }),
          },
          { codemode: false },
        )
        .pipe(Scope.provide(scope))
      yield* admit(session, "Use the reloaded tool")
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-reloaded", name: "reloaded", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Reloaded response", "text-reloaded-response"),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* Scope.close(scope, Exit.void)
      yield* registry.register(
        {
          reloaded: Tool.make({
            description: "Record the replacement tool",
            input: Schema.Struct({}),
            output: Schema.Struct({ value: Schema.String }),
            execute: () => Effect.sync(() => executions.push("replacement")).pipe(Effect.as({ value: "replacement" })),
          }),
        },
        { codemode: false },
      )
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)

      expect(executions).toEqual(["advertised"])
      expect((yield* session.context(sessionID)).slice(0, 2)).toMatchObject([
        { type: "user", text: "Use the reloaded tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-reloaded",
              state: { status: "completed", structured: { value: "advertised" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("promotes a stable Anthropic prefix from five minutes to one hour after observed reuse", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = anthropicCacheModel
      efficiencyConfig = new ConfigEfficiency.Info({
        prompt_cache: new ConfigEfficiency.PromptCache({ anthropic_ttl: "adaptive" }),
      })
      responses = [
        reply.textWithCache("First", "cache-first", 0, 1_200),
        reply.textWithCache("Second", "cache-second", 900, 0),
        reply.textWithCache("Third", "cache-third", 900, 0),
      ]

      for (const prompt of ["First cache turn", "Second cache turn", "Third cache turn"]) {
        yield* admit(session, prompt)
        yield* session.resume(sessionID)
      }

      expect(requests.map((request) => request.cache)).toEqual([
        { tools: true, system: true, messages: { tail: 2 }, ttlSeconds: 300 },
        { tools: true, system: true, messages: { tail: 2 }, ttlSeconds: 300 },
        { tools: true, system: true, messages: { tail: 2 }, ttlSeconds: 3600 },
      ])
    }),
  )

  it.effect("keeps the OpenAI cache key stable after durable low-hit steps", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = openAI56Model
      responses = Array.from({ length: 5 }, (_, index) =>
        reply.textWithCache(`Step ${index + 1}`, `cache-low-${index}`, 1, 0),
      )

      for (const prompt of ["First", "Second", "Third", "Fourth", "Fifth"]) {
        yield* admit(session, prompt)
        yield* session.resume(sessionID)
      }

      const records = yield* SessionProviderRequest.Service.pipe(Effect.flatMap((service) => service.list(sessionID)))
      expect(records.map((record) => record.cacheReadReported)).toEqual([true, true, true, true, true])
      const keys = requests
        .map((request) => request.providerOptions?.openai?.promptCacheKey)
        .filter((key): key is string => typeof key === "string")
      expect(keys.length).toBe(5)
      expect(records.map((record) => record.promptCacheKey)).toEqual(keys)
      expect(new Set(records.map((record) => record.systemDigest)).size).toBe(1)
      expect(new Set(records.map((record) => record.toolDigest)).size).toBe(1)
      expect(keys.every((key) => key === keys[0])).toBe(true)
    }),
  )

  it.effect("activates hybrid caching for direct GPT-5.6 OpenAI requests in auto mode", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = openAI56Model
      efficiencyConfig = new ConfigEfficiency.Info({
        prompt_cache: new ConfigEfficiency.PromptCache({
          openai_mode: "auto",
          openai_extended_retention: true,
        }),
      })
      response = reply.text("Fixture response", "text-fixture")
      yield* admit(session, "Use hybrid OpenAI caching")
      yield* session.resume(sessionID)

      expect(requests[0]?.providerOptions?.openai).toMatchObject({
        promptCacheOptions: { mode: "implicit", ttl: "30m" },
      })
      expect(requests[0]?.cache).toEqual({
        tools: false,
        system: true,
        messages: { tail: 50 },
      })
    }),
  )

  it.effect("retains the newest 50 cacheable message boundaries for direct GPT-5.6 OpenAI explicit caching", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = openAI56Model
      efficiencyConfig = new ConfigEfficiency.Info({
        prompt_cache: new ConfigEfficiency.PromptCache({ openai_mode: "explicit" }),
      })
      response = reply.text("Fixture response", "text-fixture")
      yield* admit(session, "Use explicit OpenAI caching")
      yield* session.resume(sessionID)

      expect(requests[0]?.providerOptions?.openai).toMatchObject({
        promptCacheOptions: { mode: "explicit", ttl: "30m" },
      })
      expect(requests[0]?.cache).toEqual({
        tools: false,
        system: true,
        messages: { tail: 50 },
      })
    }),
  )

  it.effect("continues a compatible stored OpenAI Responses tool turn", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedRecoveryResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "auto" })
      responses = [
        reply.toolWithResponse("call-continued", "echo", { text: "continued" }, "resp_first"),
        reply.textWithResponse("Done", "continued-done", "resp_second"),
      ]

      yield* admit(session, "Use the tool and continue")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      expect(requests[1]?.providerOptions?.openai).toMatchObject({
        previousResponseId: "resp_first",
        continuationInputStart: nonVolatileMessages(requests[0]).length + 1,
      })
      const records = yield* SessionProviderRequest.Service.pipe(
        Effect.flatMap((providerRequests) => providerRequests.list(sessionID)),
      )
      expect(records.map((record) => ({ attempts: record.attempts, continuation: record.continuation }))).toEqual([
        { attempts: 1, continuation: "full" },
        { attempts: 1, continuation: "continued" },
      ])
      expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("resp_first")
      expect(JSON.stringify(records)).not.toContain("resp_first")
    }),
  )

  it.effect("continues at a complete multipart boundary while the volatile suffix changes", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const hooks = yield* PluginHooks.Service
      currentModel = storedRecoveryResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      let teamView = "Stable team view"
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.messages.push(Message.make({ role: "user", content: teamView, volatile: true }))
        }),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "multipart-reasoning" }),
          LLMEvent.reasoningDelta({ id: "multipart-reasoning", text: "Thinking" }),
          LLMEvent.reasoningEnd({ id: "multipart-reasoning" }),
          LLMEvent.toolCall({ id: "multipart-tool", name: "echo", input: { text: "multipart" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            providerMetadata: { openai: { responseId: "resp_multipart" } },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.textWithResponse("Done", "multipart-done", "resp_multipart_done"),
        reply.textWithResponse("Rebased", "multipart-rebased", "resp_multipart_rebased"),
      ]

      yield* admit(session, "Use multipart output")
      yield* session.resume(sessionID)

      const continuationInputStart = requests[1]?.providerOptions?.openai?.continuationInputStart
      expect(requests[1]?.providerOptions?.openai?.previousResponseId).toBe("resp_multipart")
      expect(typeof continuationInputStart).toBe("number")
      expect(requests[1]?.messages.slice(continuationInputStart as number).map((message) => message.role)).toEqual([
        "tool",
      ])
      expect(JSON.stringify(requests[0]?.messages)).toContain("Stable team view")
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("Stable team view")

      teamView = "Changed team view"
      yield* admit(session, "Rebase after volatile change")
      yield* session.resume(sessionID)

      expect(requests[2]?.providerOptions?.openai?.previousResponseId).toBe("resp_multipart_done")
      expect(JSON.stringify(requests[2]?.messages)).not.toContain("Changed team view")
    }),
  )

  it.effect("does not continue a Copilot AI SDK Responses tool turn", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedCopilotResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "auto" })
      responses = [
        reply.toolWithResponse("call-copilot", "echo", { text: "continued" }, "resp_copilot_first"),
        reply.textWithResponse("Done", "copilot-done", "resp_copilot_second"),
      ]

      yield* admit(session, "Use the tool and continue")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      const records = yield* SessionProviderRequest.Service.pipe(
        Effect.flatMap((providerRequests) => providerRequests.list(sessionID)),
      )
      expect(records.map((record) => record.continuation)).toEqual(["full", "full"])
    }),
  )

  it.effect("forces stored OpenAI Responses state when the state mode is omitted", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = unstoredOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      responses = [
        reply.toolWithResponse("call-unstored", "echo", { text: "unstored" }, "resp_unstored"),
        reply.textWithResponse("Done", "unstored-done", "resp_unstored_done"),
      ]

      yield* admit(session, "Do not enable provider storage")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.providerOptions?.openai?.store === true)).toBe(true)
      expect(requests[1]?.providerOptions?.openai).toHaveProperty("previousResponseId", "resp_unstored")
    }),
  )

  it.effect("invalidates stored continuation when request options change after a tool", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({
        openai_responses_continuation: "auto",
        prompt_cache: new ConfigEfficiency.PromptCache({ openai_mode: "auto" }),
      })
      yield* registry.register(
        {
          change_cache_policy: Tool.make({
            description: "Change the OpenAI cache policy",
            input: Schema.Struct({}),
            output: Schema.Struct({ changed: Schema.Boolean }),
            execute: () =>
              Effect.sync(() => {
                efficiencyConfig = new ConfigEfficiency.Info({
                  openai_responses_continuation: "auto",
                  prompt_cache: new ConfigEfficiency.PromptCache({ openai_mode: "implicit" }),
                })
                return { changed: true }
              }),
          }),
        },
        { codemode: false },
      )
      responses = [
        reply.toolWithResponse("call-change-policy", "change_cache_policy", {}, "resp_policy"),
        reply.textWithResponse("Done", "policy-done", "resp_policy_done"),
      ]

      yield* admit(session, "Change policy and continue safely")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.providerOptions?.openai?.promptCacheOptions).toEqual({ mode: "implicit", ttl: "30m" })
      expect(requests[1]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      expect(requests[1]?.providerOptions?.openai).not.toHaveProperty("promptCacheOptions")
    }),
  )

  it.effect("keeps stored response state across executions", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      responses = [
        reply.textWithResponse("First", "execution-first", "resp_execution_first"),
        reply.textWithResponse("Second", "execution-second", "resp_execution_second"),
      ]

      yield* admit(session, "First execution")
      yield* session.resume(sessionID)
      yield* admit(session, "Second execution")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.providerOptions?.openai).toHaveProperty("previousResponseId", "resp_execution_first")
    }),
  )

  it.effect("falls back once from invalid stored OpenAI response state without creating another logical request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      responseStreams = [
        Stream.fromIterable(reply.toolWithResponse("call-fallback", "echo", { text: "fallback" }, "resp_first")),
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 })]).pipe(
          Stream.concat(Stream.fail(invalidPreviousResponse())),
        ),
        Stream.fromIterable(reply.textWithResponse("Recovered", "fallback-recovered", "resp_recovered")),
      ]

      yield* admit(session, "Recover stale response state")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[1]?.providerOptions?.openai).toMatchObject({ previousResponseId: "resp_first" })
      expect(requests[2]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      expect(requests[1]?.id).toBe(requests[2]?.id)
      const assistant = requireAssistant((yield* session.context(sessionID)).slice(-1))
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.step.ended.1",
      ])
      const records = yield* SessionProviderRequest.Service.pipe(
        Effect.flatMap((providerRequests) => providerRequests.list(sessionID)),
      )
      expect(records.map((record) => ({ attempts: record.attempts, continuation: record.continuation }))).toEqual([
        { attempts: 1, continuation: "full" },
        { attempts: 2, continuation: "fallback" },
      ])
    }),
  )

  it.effect("falls back from a streamed invalid stored OpenAI response error", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      responses = [
        reply.toolWithResponse("call-fallback-event", "echo", { text: "fallback" }, "resp_event"),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({
            message: "invalid_previous_response_id: Previous response ID is invalid or expired",
          }),
        ],
        reply.textWithResponse("Recovered", "fallback-event-recovered", "resp_event_recovered"),
      ]

      yield* admit(session, "Recover streamed stale response state")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[1]?.providerOptions?.openai).toMatchObject({ previousResponseId: "resp_event" })
      expect(requests[2]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      expect(requests[1]?.id).toBe(requests[2]?.id)
      const assistant = requireAssistant((yield* session.context(sessionID)).slice(-1))
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.step.ended.1",
      ])
      const records = yield* SessionProviderRequest.Service.pipe(
        Effect.flatMap((providerRequests) => providerRequests.list(sessionID)),
      )
      expect(records.map((record) => ({ attempts: record.attempts, continuation: record.continuation }))).toEqual([
        { attempts: 1, continuation: "full" },
        { attempts: 2, continuation: "fallback" },
      ])
    }),
  )

  it.effect("caps continuation fallback attempts at ten with monotonic retry events", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      const failure = providerUnavailable()
      responseStreams = [
        Stream.fromIterable(reply.toolWithResponse("call-fallback-budget", "echo", { text: "budget" }, "resp_budget")),
        Stream.fail(invalidPreviousResponse()),
        ...Array.from({ length: 9 }, () => Stream.fail(failure)),
      ]

      yield* admit(session, "Cap continuation fallback retries")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 3) yield* Effect.yieldNow
      for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000, 120_000]) {
        yield* TestClock.adjust(delay)
        while (requests.length < 3 + [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000, 120_000].indexOf(delay) + 1)
          yield* Effect.yieldNow
      }
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(11)

      const database = (yield* Database.Service).db
      const retries = yield* database
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.retry.scheduled.1"))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(retries.map((event) => event.data)).toMatchObject([
        { attempt: 3, at: 2_000 },
        { attempt: 4, at: 6_000 },
        { attempt: 5, at: 14_000 },
        { attempt: 6, at: 30_000 },
        { attempt: 7, at: 62_000 },
        { attempt: 8, at: 126_000 },
        { attempt: 9, at: 246_000 },
        { attempt: 10, at: 366_000 },
      ])
      const records = yield* SessionProviderRequest.Service.pipe(
        Effect.flatMap((providerRequests) => providerRequests.list(sessionID)),
      )
      expect(records.map((record) => ({ attempts: record.attempts, continuation: record.continuation }))).toEqual([
        { attempts: 1, continuation: "full" },
        { attempts: 10, continuation: "fallback" },
      ])
    }),
  )

  it.effect("does not retry a second invalid request after the continuation fallback", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      responseStreams = [
        Stream.fromIterable(reply.toolWithResponse("call-fallback-once", "echo", { text: "once" }, "resp_once")),
        Stream.fail(invalidPreviousResponse()),
        Stream.fail(invalidPreviousResponse()),
      ]

      yield* admit(session, "Fallback only once")
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toHaveLength(3)
      expect(requests[1]?.providerOptions?.openai).toHaveProperty("previousResponseId", "resp_once")
      expect(requests[2]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      const records = yield* SessionProviderRequest.Service.pipe(
        Effect.flatMap((providerRequests) => providerRequests.list(sessionID)),
      )
      expect(records.map((record) => ({ attempts: record.attempts, continuation: record.continuation }))).toEqual([
        { attempts: 1, continuation: "full" },
        { attempts: 2, continuation: "fallback" },
      ])
    }),
  )

  it.effect("does not treat a generic invalid request as stale continuation state", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      responseStreams = [
        Stream.fromIterable(reply.toolWithResponse("call-generic-invalid", "echo", { text: "once" }, "resp_once")),
        Stream.fail(invalidRequest()),
      ]

      yield* admit(session, "Do not rebase a generic invalid request")
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.providerOptions?.openai).toHaveProperty("previousResponseId", "resp_once")
    }),
  )

  it.effect("reports normalized cache diagnostics without treating cache hits as free context", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({
        id: "diagnostic-model",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: { context: 20_000, output: 200 } }),
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "diagnostic-text" }),
          LLMEvent.textDelta({ id: "diagnostic-text", text: "Done" }),
          LLMEvent.textEnd({ id: "diagnostic-text" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: {
              inputTokens: 1_000,
              nonCachedInputTokens: 100,
              cacheReadInputTokens: 900,
              outputTokens: 30,
              reasoningTokens: 10,
            },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        reply.text("Provider summary", "text-provider-summary"),
      ]
      yield* admit(session, "Measure cache")
      yield* session.resume(sessionID)

      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(assistant.diagnostics).toEqual({
        contextLimit: 20_000,
        providerCache: {
          mechanism: "openai-prefix-cache",
          readReported: true,
          writeReported: false,
        },
      })
      expect(
        (yield* recordedStepSettlementEvents(sessionID, assistant.id)).find(
          (event) => event.type === "session.step.ended.1",
        )?.data,
      ).toMatchObject({
        providerCache: {
          mechanism: "openai-prefix-cache",
          readReported: true,
          writeReported: false,
        },
      })
      const diagnostics = yield* session.diagnostics(sessionID)
      expect(diagnostics).toMatchObject({
        context: { total: 1_030, limit: 20_000, remaining: 18_970, percent: 5 },
        tokens: { uncachedInput: 100, output: 20, reasoning: 10, cacheRead: 900, cacheWrite: 0 },
        cache: {
          eligible: 1_000,
          hitRatio: 0.9,
          mechanism: "openai-prefix-cache",
          readReported: true,
          writeReported: false,
        },
        requests: {
          logical: 1,
          physical: 1,
          helpers: 0,
          continued: 0,
          fallback: 0,
          latestInvalidation: "stable-hit",
          tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 900, write: 0 } },
        },
      })
      expect(diagnostics && "application" in diagnostics).toBe(false)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.diagnostics(sessionID)).toEqual(diagnostics)
    }),
  )

  it.effect("publishes live cache diagnostics before settled local tools finish", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      currentModel = Model.make({
        id: "diagnostic-model",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: { context: 20_000, output: 200 } }),
      })
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-diagnostics", name: "echo", input: { text: "blocked" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 1_000,
              nonCachedInputTokens: 100,
              cacheReadInputTokens: 900,
              outputTokens: 30,
              reasoningTokens: 10,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Done", "text-after-diagnostics"),
      ]
      const live = yield* events.subscribe(SessionEvent.DiagnosticsUpdated).pipe(
        Stream.filter((event) => event.data.sessionID === sessionID),
        Stream.runHead,
        Effect.forkScoped,
      )

      yield* admit(session, "Report cache while the tool runs")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      const observed = yield* Fiber.join(live).pipe(Effect.timeout("1 second"))

      expect(observed).toMatchObject({
        _tag: "Some",
        value: {
          data: {
            sessionID,
            diagnostics: {
              context: { total: 1_030, limit: 20_000, remaining: 18_970, percent: 5 },
              tokens: { uncachedInput: 100, output: 20, reasoning: 10, cacheRead: 900, cacheWrite: 0 },
              cache: { eligible: 1_000, hitRatio: 0.9, readReported: true, writeReported: false },
            },
          },
        },
      })
      expect(yield* session.diagnostics(sessionID)).toBeUndefined()

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined
    }),
  )

  it.effect("starts a real runner step after default prompt recording", () =>
    Effect.gen(function* () {
      const session = yield* setup

      const message = yield* session.prompt({
        sessionID,
        text: "Run automatically",
      })
      yield* session.wait(sessionID)

      expect(requests).toHaveLength(1)
      expect((yield* session.messages({ sessionID })).find((item) => item.id === message.id)).toMatchObject({
        id: message.id,
        type: "user",
        text: "Run automatically",
      })
    }),
  )

  it.effect("runs a follow-up when synthetic input arrives during an active continuation", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const secondStarted = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      responseStreams = [
        Stream.fromIterable(reply.tool("call-echo", "echo", { text: "background started" })),
        Stream.unwrap(
          Deferred.succeed(secondStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSecond)),
            Effect.as(Stream.fromIterable(reply.text("Fixture response", "text-fixture"))),
          ),
        ),
        Stream.fromIterable(reply.text("Handled completion", "text-completion")),
      ]
      yield* admit(session, "Start background work")
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(secondStarted)

      yield* session.synthetic({ sessionID, text: "Background work completed" })
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* Fiber.join(running)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[2]!)).toContain("Background work completed")
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "First")
      yield* admit(session, "Second")

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "echo", "storefail"])
      expect(
        nonVolatileMessages(requests[0]).map((message) => ({ role: message.role, content: message.content })),
      ).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps durable moved-project history but excludes only ended project artifact injections", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      const artifact = (scope: "project" | "global", id: string) => ({
        scopeID: ProjectArtifact.ScopeID.make(`pas_${scope}`),
        versionID: ProjectArtifact.VersionID.make(`pav_${id}`),
        kind: "skill" as const,
        id: ProjectArtifact.ID.make(id),
        sourceScope: scope,
      })
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID,
        id: SkillV2.ID.make("project-skill"),
        name: SkillV2.Name.make("PROJECT_SKILL"),
        text: "PROJECT_SKILL",
        artifact: artifact("project", "project-skill"),
      })
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID,
        id: SkillV2.ID.make("global-skill"),
        name: SkillV2.Name.make("GLOBAL_SKILL"),
        text: "GLOBAL_SKILL",
        artifact: artifact("global", "global-skill"),
      })
      yield* session.prompt({
        sessionID,
        text: "PROJECT_COMMAND",
        metadata: { projectArtifact: { ...artifact("project", "project-command"), kind: "command" } },
        resume: false,
      })
      yield* session.prompt({
        sessionID,
        text: "GLOBAL_COMMAND",
        metadata: { projectArtifact: { ...artifact("global", "global-command"), kind: "command" } },
        resume: false,
      })
      response = reply.text("Fixture response", "text-fixture")
      yield* session.resume(sessionID)
      requests.length = 0
      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: AgentV2.ID.make("project-agent"),
        artifact: { ...artifact("project", "project-agent"), kind: "agent" },
      })
      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: AgentV2.ID.make("global-agent"),
        artifact: { ...artifact("global", "global-agent"), kind: "agent" },
      })
      yield* events.publish(SessionEvent.AgentSelected, { sessionID, agent: AgentV2.ID.make("build") })
      yield* session.synthetic({ sessionID, text: "ORDINARY_HISTORY" })
      yield* events.publish(SessionEvent.ProjectArtifactsEnded, {
        sessionID,
        oldProjectID: Project.ID.make("old-project"),
        newProjectID: Project.ID.make("new-project"),
      })
      yield* admit(session, "AFTER_MOVE")
      response = reply.text("Fixture response", "text-fixture")

      yield* session.resume(sessionID)

      const prepared = JSON.stringify(requests.at(-1)?.messages)
      expect(prepared).not.toContain("PROJECT_SKILL")
      expect(prepared).not.toContain("PROJECT_COMMAND")
      expect(prepared).not.toContain("project-agent")
      expect(prepared).toContain("GLOBAL_SKILL")
      expect(prepared).toContain("GLOBAL_COMMAND")
      expect(prepared).toContain("global-agent")
      expect(prepared).toContain("ORDINARY_HISTORY")
      expect(prepared).toContain("AFTER_MOVE")
      const durable = JSON.stringify(yield* session.context(sessionID))
      expect(durable).toContain("PROJECT_SKILL")
      expect(durable).toContain("PROJECT_COMMAND")
      expect(durable).toContain("project-agent")
    }),
  )

  it.effect("marks the initial instruction sync as baseline metadata", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      const instructionEvents: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "session.instructions.updated") instructionEvents.push(event)
        }),
      )
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* admit(session, "Second")
      yield* session.resume(sessionID)
      yield* unsubscribe

      expect(instructionEvents).toHaveLength(2)
      expect(instructionEvents[0]?.metadata).toEqual({ instructions: { initial: true } })
      expect(instructionEvents[1]?.metadata).toBeUndefined()
    }),
  )

  it.effect("retries the first request after system context becomes available", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({
        id: messageID,
        sessionID,
        text: "First",
        resume: false,
      })

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Instructions.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionPending.has(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, text: "First" })
      yield* session.wait(sessionID)

      expect(requests).toHaveLength(1)
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* admit(session, "First")
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })
      expect(
        yield* db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).get(),
      ).toBeUndefined()

      yield* admit(session, "Second")
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionPending.has(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("forks instruction values at the selected message instead of the parent's latest state", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const first = yield* admit(session, "First")
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      const second = yield* admit(session, "Second")
      yield* session.resume(sessionID)
      systemBaseline = "Latest context"
      yield* admit(session, "Third")
      yield* session.resume(sessionID)

      const forked = yield* session.fork({ sessionID, messageID: second.id })
      expect(
        yield* (yield* Database.Service).db
          .select()
          .from(InstructionStateTable)
          .where(eq(InstructionStateTable.session_id, forked.id))
          .get(),
      ).toMatchObject({
        initial_values: { "test/context": Instructions.hash("Initial context") },
        current_values: { "test/context": Instructions.hash("Changed context") },
      })
      yield* session.prompt({ sessionID: forked.id, text: "Forked", resume: false })
      yield* session.resume(forked.id)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        defaultSystem,
        withProjectArtifactGuidance("Initial context"),
      ])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
      expect(systemTexts(requests.at(-1)!)).toContain("Latest context")

      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, forked.id))
        .orderBy(asc(EventTable.seq))
        .all()
      yield* events.remove(forked.id)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, forked.id)).run()
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          created: DateTime.makeUnsafe(event.created),
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )
      expect(
        yield* db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, forked.id)).get(),
      ).toMatchObject({ current_values: { "test/context": Instructions.hash("Latest context") } })
    }),
  )

  it.effect("caps nested fork instruction ancestry at the selected message", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "First")
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      const second = yield* admit(session, "Second")
      yield* session.resume(sessionID)

      const child = yield* session.fork({ sessionID, messageID: second.id })
      const inheritedFirst = (yield* session.messages({ sessionID: child.id })).find(
        (message) => message.type === "user" && message.text === "First",
      )
      if (!inheritedFirst) return yield* Effect.die(new Error("Nested fork boundary message not found"))
      const grandchild = yield* session.fork({ sessionID: child.id, messageID: inheritedFirst.id })

      expect(
        yield* (yield* Database.Service).db
          .select()
          .from(InstructionStateTable)
          .where(eq(InstructionStateTable.session_id, grandchild.id))
          .get(),
      ).toMatchObject({
        initial_values: { "test/context": Instructions.hash("Initial context") },
        current_values: { "test/context": Instructions.hash("Initial context") },
      })
    }),
  )

  it.effect("rebuilds a missing instruction cache without admitting another delta", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      yield* admit(session, "First")
      yield* session.resume(sessionID)
      yield* db.delete(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).run()
      yield* admit(session, "Second")
      requests.length = 0

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toEqual([
        defaultSystem,
        withProjectArtifactGuidance("Initial context"),
      ])
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.instructions.updated.2"))
          .all(),
      ).toHaveLength(1)
      expect(yield* db.select().from(InstructionStateTable).get()).toMatchObject({
        initial_values: { "test/context": Instructions.hash("Initial context") },
        current_values: { "test/context": Instructions.hash("Initial context") },
      })
    }),
  )

  it.effect("keeps the initial instructions stable and derives a chronological update from values", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* admit(session, "Second")
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
      ])
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "system",
        "user",
      ])
      expect(requests[1]?.messages.at(2)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(4)
      const { db } = yield* Database.Service
      const updates = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.instructions.updated.2"))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(updates).toHaveLength(2)
      expect(updates[0]?.data).toEqual({
        sessionID,
        delta: {
          "ycoding/project-artifact-authoring": Instructions.hash(ProjectArtifactInstructions.content),
          "test/context": Instructions.hash("Initial context"),
        },
      })
      expect(updates[1]?.data).toEqual({
        sessionID,
        delta: { "test/context": Instructions.hash("Changed context") },
      })
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(4)
    }),
  )

  it.effect("uses the selected model family prompt when the agent does not override it", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({
        id: "gpt-5",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: testLimits }),
      })
      yield* admit(session, "First")

      response = reply.text("Done", "text-provider-prompt")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        expect.stringContaining("You are YCoding, You and the user share the same workspace"),
        withProjectArtifactGuidance("Initial context"),
      ])
    }),
  )

  it.effect("uses the selected model family prompt when the agent system override is empty", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({
        id: "gpt-5",
        provider: "openai",
        route: OpenAIChat.route.with({ limits: testLimits }),
      })
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = ""
          agent.mode = "primary"
        }),
      )
      yield* admit(session, "First")

      response = reply.text("Done", "text-empty-agent-system")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        expect.stringContaining("You are YCoding, You and the user share the same workspace"),
        withProjectArtifactGuidance("Initial context"),
      ])
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      yield* admit(session, "First")

      response = reply.text("Done", "text-build")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Build agent instructions",
        withProjectArtifactGuidance("Initial context"),
      ])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      yield* admit(session, "First")

      response = reply.text("Done", "text-reviewer")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Reviewer instructions",
        withProjectArtifactGuidance("Initial context"),
      ])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses only the agent prompt and initial instructions as system parts", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      yield* admit(session, "First")

      response = reply.text("Done", "text-no-system")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Build agent instructions",
        withProjectArtifactGuidance("Initial context"),
      ])
    }),
  )

  it.effect("replaces the agent system prompt after switching agents", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.update(AgentV2.ID.make("brainstorm"), (agent) => {
          agent.system = "Brainstorm agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
      })
      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("brainstorm") })
      yield* admit(session, "Design")
      response = reply.text("Designed", "text-brainstorm")
      yield* session.resume(sessionID)

      yield* session.switchAgent({ sessionID, agent: AgentV2.ID.make("build") })
      yield* admit(session, "Implement")
      response = reply.text("Built", "text-build-after-switch")
      yield* session.resume(sessionID)

      expect(requests.at(-2)?.system.map((part) => part.text)).toEqual([
        "Brainstorm agent instructions",
        withProjectArtifactGuidance("Initial context"),
      ])
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Build agent instructions",
        withProjectArtifactGuidance("Initial context"),
      ])
      expect(
        (yield* session.messages({ sessionID })).some(
          (message) => message.type === "assistant" && message.agent === "build",
        ),
      ).toBe(true)
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* admit(session, "First")

      response = reply.text("Done", "text-selected")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Reviewer instructions",
        withProjectArtifactGuidance("Initial context"),
      ])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("fails before the model request when the selected agent is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: "explore" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, text: "Inspect files", resume: false })

      requests.length = 0
      response = reply.text("Plugin response", "text-plugin-response")
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "Session.AgentNotFoundError",
        sessionID,
        agent: "explore",
      })
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("waits for initial plugin readiness before constructing the model request", () =>
    Effect.gen(function* () {
      yield* setup
      const release = yield* Deferred.make<void>()
      pluginFlushHook = Deferred.await(release)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, text: "Wait for plugins", resume: false })

      requests.length = 0
      response = reply.text("Recovered interrupted tool", "text-recovered-interrupted-tool")
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow

      expect(requests).toHaveLength(0)
      expect(running.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("updates selected-agent skill instructions after an agent switch", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.mode = "primary"
        }),
      )
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: AgentV2.ID.make("reviewer"),
      })
      yield* admit(session, "Second")
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context", "Build skills")],
        [defaultSystem, withProjectArtifactGuidance("Initial context", "Build skills")],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSelected, {
            sessionID,
            agent: AgentV2.ID.make("reviewer"),
          })
          .pipe(Effect.asVoid)
      })
      yield* admit(session, "First")

      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context", "Build skills")],
      ])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSelected, {
            sessionID,
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
      ])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      systemRemoved = true
      yield* admit(session, "Second")
      yield* session.resume(sessionID)

      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "system",
        "user",
      ])
      expect(requests[1]?.messages.at(2)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(4)
    }),
  )

  it.effect("renders API context entries through add, change, and removal", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const contextEntries = yield* InstructionEntry.Service
      yield* contextEntries.put({ sessionID, key: "deploy-target", value: "production" })
      yield* admit(session, "First")

      yield* session.resume(sessionID)

      // String values render verbatim inside the initial tagged block.
      expect(requests[0]?.system.map((part) => part.text)).toEqual([
        defaultSystem,
        [
          withProjectArtifactGuidance("Initial context"),
          "",
          '<context key="deploy-target">',
          "production",
          "</context>",
        ].join("\n"),
      ])

      // Non-string JSON pretty-prints; the change narrates as a System update.
      yield* contextEntries.put({ sessionID, key: "deploy-target", value: { region: "us-east-1" } })
      yield* admit(session, "Second")
      yield* session.resume(sessionID)

      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "system",
        "user",
      ])
      expect(requests[1]?.messages.at(2)?.content).toEqual([
        {
          type: "text",
          text: [
            'The context under "deploy-target" changed and supersedes the previous value:',
            '<context key="deploy-target">',
            "{",
            '  "region": "us-east-1"',
            "}",
            "</context>",
          ].join("\n"),
        },
      ])
      expect(yield* contextEntries.list(sessionID)).toEqual([{ key: "deploy-target", value: { region: "us-east-1" } }])

      // Deleting the row announces removal through the stored removal text.
      yield* contextEntries.remove({ sessionID, key: "deploy-target" })
      yield* admit(session, "Third")
      yield* session.resume(sessionID)

      expect(nonVolatileMessages(requests[2]).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "system",
        "user",
        "assistant",
        "system",
        "user",
      ])
      expect(nonVolatileMessages(requests[2]).at(-2)?.content).toEqual([
        { type: "text", text: 'The context under "deploy-target" no longer applies. Disregard it.' },
      ])
      expect(yield* contextEntries.list(sessionID)).toEqual([])
    }),
  )

  it.effect("retains JSON null API entries as values", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const entries = yield* InstructionEntry.Service
      yield* entries.put({ sessionID, key: "nullable", value: "present" })
      yield* admit(session, "First")
      yield* session.resume(sessionID)

      yield* entries.put({ sessionID, key: "nullable", value: null })
      yield* admit(session, "Second")
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.at(2)?.content).toEqual([
        {
          type: "text",
          text: [
            'The context under "nullable" changed and supersedes the previous value:',
            '<context key="nullable">',
            "null",
            "</context>",
          ].join("\n"),
        },
      ])
      expect(yield* entries.list(sessionID)).toEqual([{ key: "nullable", value: null }])
    }),
  )

  it.effect("rejects API instruction entries larger than 8KB", () =>
    Effect.gen(function* () {
      yield* setup
      const entries = yield* InstructionEntry.Service

      const exit = yield* entries
        .put({ sessionID, key: "oversized", value: "x".repeat(InstructionEntry.MaxValueBytes) })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(InstructionEntry.ValueTooLargeError)
      expect(yield* entries.list(sessionID)).toEqual([])
    }),
  )

  it.effect("keeps initial instructions and chronological updates after a model switch", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* admit(session, "Second")
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* admit(session, "Third")
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
      ])
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "system",
        "user",
      ])
      expect(nonVolatileMessages(requests[2]).filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "model-switched",
        "user",
        "assistant",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(7)
      yield* admit(session, "Fourth")
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves instruction values while a source is temporarily unavailable", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* admit(session, "Second")
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* admit(session, "Third")
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
      ])
    }),
  )

  it.effect("moves the epoch at compaction and narrates later changes", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.Compaction.StartedV1, {
        sessionID,
        reason: "manual",
        recent: "",
      })
      yield* events.publish(SessionEvent.Compaction.EndedV1, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* admit(session, "Second")
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
      ])
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual(["user", "system", "user"])
      expect(requests[1]?.messages.at(1)?.content).toEqual([{ type: "text", text: "Replacement context" }])
      yield* replaySessionProjection(sessionID)
      yield* admit(session, "Third")
      yield* session.resume(sessionID)
    }),
  )

  it.effect("uses epoch values after compaction while a source is unavailable", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* admit(session, "Second")
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.Compaction.StartedV1, {
        sessionID,
        reason: "manual",
        recent: "",
      })
      yield* events.publish(SessionEvent.Compaction.EndedV1, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* admit(session, "Third")
      yield* session.resume(sessionID)

      // Compaction already moved current values into the new epoch before the unavailable read.
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        defaultSystem,
        withProjectArtifactGuidance("Changed context"),
      ])
      expect(systemTexts(requests.at(-1)!)).not.toContain("Changed context")
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Use tools")

      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-1" }),
          LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
          LLMEvent.reasoningEnd({ id: "reasoning-1" }),
          LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
          LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
          LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
          LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
          LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
          LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
          LLMEvent.toolCall({
            id: "call-provider",
            name: "web_search",
            input: { query: "hello" },
            providerExecuted: true,
            providerMetadata: { openai: { source: "provider" } },
          }),
          LLMEvent.toolResult({
            id: "call-provider",
            name: "web_search",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Hello" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
              ],
            },
            providerExecuted: true,
            providerMetadata: { openai: { source: "provider" } },
          }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 10,
              nonCachedInputTokens: 8,
              outputTokens: 4,
              reasoningTokens: 1,
              cacheReadInputTokens: 2,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Reasoning summary", "text-reasoning-summary"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "echo", "storefail"])
      expect((yield* session.context(sessionID)).slice(0, 2)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "tool.execution", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              executed: true,
              providerState: { source: "provider" },
              providerResultState: { source: "provider" },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Echo this")

      responses = [reply.tool("call-echo", "echo", { text: "hello" }), reply.text("Done", "text-final")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, callID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.ended.1",
      ])
    }),
  )

  it.effect("replays durable assistant text phase on same-model continuation", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = openAI56Model
      yield* admit(session, "Explain while using the tool")
      const phase = { openai: { phase: "commentary" } }
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-phase", providerMetadata: phase }),
          LLMEvent.textDelta({ id: "text-phase", text: "Working", providerMetadata: phase }),
          LLMEvent.textEnd({ id: "text-phase", providerMetadata: phase }),
          LLMEvent.toolInputStart({ id: "call-phase", name: "echo" }),
          LLMEvent.toolInputEnd({ id: "call-phase", name: "echo" }),
          LLMEvent.toolCall({ id: "call-phase", name: "echo", input: { text: "phase" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Done", "text-phase-done"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: "Working",
              providerMetadata: { openai: { phase: "commentary" } },
            }),
          ]),
        }),
      )
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "Echo this")

      responses = [reply.tool("call-echo", "echo", { text: "hello" }), reply.text("Fixture response", "text-fixture")]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
        [defaultSystem, withProjectArtifactGuidance("Initial context")],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in the next request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Think first")

      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-anthropic",
          providerMetadata: { openai: { signature: "sig_1" }, anthropic: { ignored: true } },
        }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: {
            openai: { itemId: "rs_1", reasoningEncryptedContent: null },
            anthropic: { ignored: true },
          },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: {
            openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" },
            anthropic: { ignored: true },
          },
        }),
        LLMEvent.textStart({ id: "text-reasoning-answer" }),
        LLMEvent.textDelta({ id: "text-reasoning-answer", text: "Reasoning summary" }),
        LLMEvent.textEnd({ id: "text-reasoning-answer" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)
      requests.length = 0

      expect(
        requireAssistant((yield* session.context(sessionID)).slice(0, 2)).content.filter(
          (content) => content.type === "reasoning",
        ),
      ).toMatchObject([
        {
          type: "reasoning",
          text: "Signed thought",
          state: { signature: "sig_1" },
        },
        {
          type: "reasoning",
          text: "Encrypted thought",
          state: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" },
        },
      ])

      yield* admit(session, "Continue")
      response = reply.text("Continued", "text-reasoning-continued")
      yield* session.resume(sessionID)

      expect(requests[0]?.messages[1]?.content.filter((content) => content.type === "reasoning")).toEqual([
        {
          type: "reasoning",
          text: "Signed thought",
          providerMetadata: { openai: { signature: "sig_1" } },
        },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in the next request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Search first")

      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" }, fake: { ignored: true } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { openai: { blockType: "web_search_tool_result" }, anthropic: { ignored: true } },
        }),
        LLMEvent.textStart({ id: "text-search-answer" }),
        LLMEvent.textDelta({ id: "text-search-answer", text: "Search summary" }),
        LLMEvent.textEnd({ id: "text-search-answer" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)
      requests.length = 0

      yield* admit(session, "Continue")
      response = reply.text("Continued", "text-search-continued")
      yield* session.resume(sessionID)

      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(
        requests[0]?.messages[1]?.content.filter(
          (content) => content.type === "tool-call" || content.type === "tool-result",
        ),
      ).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { openai: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("keeps opaque provider state private and replays it only in stateless same-model requests", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_state: "stateless" })
      const reasoningOpaque = {
        type: "compaction",
        id: "cmp_reasoning",
        encrypted_content: "reasoning-secret",
        future_field: { version: 2 },
      }
      const toolCallOpaque = {
        type: "compaction",
        id: "cmp_tool_call",
        encrypted_content: "tool-call-secret",
      }
      const toolResultOpaque = {
        type: "compaction",
        id: "cmp_tool_result",
        encrypted_content: "tool-result-secret",
      }
      yield* admit(session, "Use private provider state")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "private-reasoning", providerMetadata: { openai: { signature: "sig_1" } } }),
        LLMEvent.reasoningDelta({
          id: "private-reasoning",
          text: "Private thought",
          providerMetadata: { openai: { signature: "sig_1", opaqueCompactionItem: reasoningOpaque } },
        }),
        LLMEvent.reasoningEnd({ id: "private-reasoning", providerMetadata: { openai: { signature: "sig_1" } } }),
        LLMEvent.toolCall({
          id: "private-tool",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "private-tool", opaqueCompactionItem: toolCallOpaque } },
        }),
        LLMEvent.toolResult({
          id: "private-tool",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { openai: { blockType: "web_search_tool_result", opaqueCompactionItem: toolResultOpaque } },
        }),
        LLMEvent.textStart({ id: "private-answer" }),
        LLMEvent.textDelta({ id: "private-answer", text: "Done" }),
        LLMEvent.textEnd({ id: "private-answer" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const durableEvents = yield* db.select({ data: EventTable.data }).from(EventTable).all()
      expect(JSON.stringify(context)).not.toContain("opaqueCompactionItem")
      expect(JSON.stringify(durableEvents)).not.toContain("opaqueCompactionItem")
      expect(
        yield* db
          .select({
            ordinal: SessionProviderStateLinkTable.part_ordinal,
            kind: SessionProviderStateLinkTable.part_kind,
          })
          .from(SessionProviderStateLinkTable)
          .orderBy(asc(SessionProviderStateLinkTable.part_ordinal), asc(SessionProviderStateLinkTable.part_kind))
          .all(),
      ).toEqual([
        { ordinal: 0, kind: "reasoning" },
        { ordinal: 1, kind: "tool-call" },
        { ordinal: 1, kind: "tool-result" },
      ])
      expect(yield* db.select().from(SessionProviderStateBlobTable).all()).toHaveLength(3)

      yield* admit(session, "Continue with private state")
      response = reply.text("Continued", "private-continued")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.providerOptions?.openai?.store === false)).toBe(true)
      expect(JSON.stringify(requests[1]?.messages)).toContain("reasoning-secret")
      expect(JSON.stringify(requests[1]?.messages)).toContain("tool-call-secret")
      expect(JSON.stringify(requests[1]?.messages)).toContain("tool-result-secret")
    }),
  )

  it.effect("does not persist provider state or continuation before Step.Ended commits", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      const failure = providerUnavailable()
      currentModel = storedOpenAIResponsesModel
      yield* admit(session, "Fail before provider state settlement")
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "unsettled-private" }),
          LLMEvent.reasoningDelta({
            id: "unsettled-private",
            text: "Partial",
            providerMetadata: {
              openai: {
                opaqueCompactionItem: {
                  type: "compaction",
                  id: "cmp_unsettled",
                  encrypted_content: "must-not-settle",
                },
              },
            },
          }),
          LLMEvent.reasoningEnd({ id: "unsettled-private" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            providerMetadata: { openai: { responseId: "resp_unsettled" } },
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)

      expect(yield* db.select().from(SessionProviderStateBlobTable).all()).toHaveLength(0)
      expect(yield* db.select().from(SessionProviderStateLinkTable).all()).toHaveLength(0)
      expect(yield* db.select().from(SessionProviderContinuationTable).all()).toHaveLength(0)
      expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("opaqueCompactionItem")
    }),
  )

  it.effect("starts recorded local tools eagerly and awaits settlement before continuing", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Echo five times")

      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Echo twice")

      responses = [
        reply.tool("tool_0", "echo", { text: "first" }),
        reply.tool("tool_0", "echo", { text: "second" }),
        reply.text("Repeated tool response", "text-repeated-tool-response"),
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect((yield* session.context(sessionID)).slice(0, 3)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect((yield* session.context(sessionID)).slice(0, 3)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Run once")

      response = reply.text("Once", "text-once")
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active step with newly recorded prompts", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Start working")

      responses = [reply.text("Fixture response", "text-fixture"), reply.text("Fixture response", "text-fixture")]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, text: "Change direction" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input after continuation ends", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Start working")

      responses = [
        reply.tool("call-echo", "echo", { text: "hello" }),
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        text: "Wait until continuation ends",
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
    }),
  )

  it.effect("serializes promoted queued input identically on later turns", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Start working")

      responses = [
        reply.tool("call-cache", "echo", { text: "continue" }),
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, text: "Stable queued prompt", delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      yield* session.prompt({ sessionID, text: "Later turn", resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(4)

      const queuedContent = (request: LLMRequest) =>
        request.messages.find(
          (message) =>
            message.role === "user" &&
            message.content.some((part) => part.type === "text" && part.text === "Stable queued prompt"),
        )?.content
      const firstConsumption = queuedContent(requests[2]!)
      const laterHistory = queuedContent(requests[3]!)

      expect(firstConsumption).toBeDefined()
      expect(laterHistory).toEqual(firstConsumption)
      expect(JSON.stringify(firstConsumption)).not.toContain("<system-reminder>")
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      yield* admit(session, "Interrupt current work")

      responses = [[], reply.text("Fixture response", "text-fixture")]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        text: "Run after interrupt",
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionPending.has(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      yield* admit(session, "Interrupt current work")

      responses = [[], reply.text("Fixture response", "text-fixture")]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        text: "Steer after interrupt",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionPending.has(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Start working")

      responses = [
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, text: "Queue first", delivery: "queue" })
      yield* session.prompt({ sessionID, text: "Queue second", delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Start steering")
      yield* session.prompt({
        sessionID,
        text: "Queue for later",
        delivery: "queue",
        resume: false,
      })

      responses = [reply.text("Fixture response", "text-fixture"), reply.text("Fixture response", "text-fixture")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Start working")

      responses = [
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
        reply.text("Fixture response", "text-fixture"),
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, text: "Queue first", delivery: "queue" })
      yield* session.prompt({ sessionID, text: "Queue second", delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, text: "Steer before next queued input" })
      yield* session.prompt({
        sessionID,
        text: "Also steer before next queued input",
      })
      yield* session.synthetic({ sessionID, text: "Background completion before next queued input" })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Background completion before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Background completion before next queued input",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const initial = yield* admit(session, "Start working")

      responses = [reply.text("Fixture response", "text-fixture"), reply.text("Fixture response", "text-fixture")]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const firstSteer = yield* session.prompt({ sessionID, text: "First steer" })
      const secondSteer = yield* session.prompt({ sessionID, text: "Second steer" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      const messages = yield* session.context(sessionID)
      expect(
        messages
          .filter((message) => message.type === "user")
          .map((message) => ({ id: message.id, consumed: message.time.consumed !== undefined })),
      ).toEqual([
        { id: initial.id, consumed: true },
        { id: firstSteer.id, consumed: true },
        { id: secondSteer.id, consumed: true },
      ])
      const { db } = yield* Database.Service
      const consumed = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, "session.input.consumed.1")))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(consumed).toHaveLength(2)
      expect(consumed[1]?.data).toMatchObject({ inputIDs: [firstSteer.id, secondSteer.id] })
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active step fails", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const initial = yield* admit(session, "Start working")

      streamFailure = invalidRequest()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const successorStarted = yield* Deferred.make<void>()
      const successorGate = yield* Deferred.make<void>()
      const recovery = yield* session.prompt({ sessionID, text: "Recover with this" })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = successorGate
      streamStarted = successorStarted
      response = reply.text("Fixture response", "text-fixture")
      yield* Deferred.await(successorStarted)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
      expect(
        (yield* session.context(sessionID))
          .filter((message) => message.type === "user")
          .map((message) => ({ id: message.id, consumed: message.time.consumed !== undefined })),
      ).toEqual([
        { id: initial.id, consumed: false },
        { id: recovery.id, consumed: false },
      ])
      yield* Deferred.succeed(successorGate, undefined)
      yield* session.wait(sessionID)
      streamGate = undefined
      streamStarted = undefined
      expect(
        (yield* session.context(sessionID))
          .filter((message) => message.type === "user")
          .map((message) => ({ id: message.id, consumed: message.time.consumed !== undefined })),
      ).toEqual([
        { id: initial.id, consumed: true },
        { id: recovery.id, consumed: true },
      ])
      const { db } = yield* Database.Service
      const consumed = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, "session.input.consumed.1")))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(consumed).toHaveLength(1)
      expect(consumed[0]?.data).toMatchObject({ inputIDs: [initial.id, recovery.id] })
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "Recover interrupted tool")
      yield* SessionPending.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: AgentV2.ID.make("build"),
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        callID: "call-interrupted",
        input: { text: "stale" },
        executed: false,
      })
      requests.length = 0
      response = reply.text("Recovered hosted tool", "text-recovered-hosted-tool")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect((yield* session.context(sessionID)).slice(0, 2)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: {
                status: "error",
                error: { type: "aborted", message: "Tool execution interrupted: echo" },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "Recover interrupted hosted tool")
      yield* SessionPending.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: AgentV2.ID.make("build"),
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        input: { query: "stale" },
        executed: true,
        state: { itemId: "call-hosted-interrupted" },
      })
      requests.length = 0
      response = reply.text("Recovered tool input", "text-recovered-tool-input")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* admit(session, "Recover interrupted tool input")
      yield* SessionPending.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: AgentV2.ID.make("build"),
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = reply.text("Recovered tool input", "text-recovered-pending-tool-input")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect((yield* session.context(sessionID)).slice(0, 2)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* session.prompt({
        sessionID,
        text: "Wait in queue",
        delivery: "queue",
        resume: false,
      })

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.InputPromoted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* admit(session, "Recover promoted input")

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = reply.text("Fixture response", "text-fixture")

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.InputPromoted.type
          ? Effect.die("fail after prompt promotion commits")
          : Effect.void,
      )
      yield* admit(session, "Run committed promotion")

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("adds session correlation headers to model requests", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Run correlated request")

      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers).toEqual({
        "x-session-affinity": sessionID,
        "X-Session-Id": sessionID,
        "User-Agent": `ycoding/${InstallationVersion}`,
        "x-ycoding-project": Project.ID.global,
        "x-ycoding-session": sessionID,
        "x-ycoding-client": "cli",
      })
    }),
  )

  it.effect("adds the parent session header to child model requests", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const parentID = SessionV2.ID.make("ses_runner_parent")
      const { db } = yield* Database.Service
      yield* insertSession(parentID)
      yield* db
        .update(SessionTable)
        .set({ parent_id: parentID })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* admit(session, "Run child request")

      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers?.["x-parent-session-id"]).toBe(parentID)
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* insertSession(otherSessionID)
      yield* admit(session, "Run first")
      yield* session.prompt({
        sessionID: otherSessionID,
        text: "Run second",
        resume: false,
      })

      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      streamStarted = yield* Deferred.make<void>()
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)

      expect(requests).toHaveLength(2)
      const namespaces = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(namespaces[0]).toBe(namespaces[1])
      expect(namespaces[0]).toMatch(/^[0-9a-f]{64}$/)
      const sessionIDs = requests.map((request) => request.providerOptions?.openrouter?.sessionID)
      expect(sessionIDs[0]).not.toBe(namespaces[0])
      expect(sessionIDs[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(sessionIDs[1]).toMatch(/^[0-9a-f]{64}$/)
      expect(sessionIDs[0]).not.toBe(sessionIDs[1])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("derives cache namespaces from final hooked system and tools", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* insertSession(otherSessionID)
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          if (event.sessionID !== otherSessionID) return
          event.system = [SystemPart.make("Session-specific hook output")]
          delete event.tools.echo
        }),
      )
      yield* admit(session, "Run unmodified request")
      yield* session.prompt({
        sessionID: otherSessionID,
        text: "Run hooked request",
        resume: false,
      })

      yield* session.resume(sessionID)
      yield* session.resume(otherSessionID)

      const namespaces = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(namespaces).toHaveLength(2)
      expect(namespaces[0]).not.toBe(namespaces[1])
      expect(requests[1]?.system.map((part) => part.text)).toEqual(["Session-specific hook output"])
      expect(requests[1]?.tools.map((tool) => tool.name)).not.toContain("echo")
    }),
  )

  it.effect("shares a stable cache namespace across long session IDs", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      yield* session.prompt({
        sessionID: longSessionID,
        text: "Run long session",
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        text: "Run other long session",
        resume: false,
      })

      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys[0]).toBe(keys[1])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      const sessionIDs = requests.map((request) => request.providerOptions?.openrouter?.sessionID)
      expect(sessionIDs[0]).not.toBe(keys[0])
      expect(sessionIDs[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(sessionIDs[1]).toMatch(/^[0-9a-f]{64}$/)
      expect(sessionIDs[0]).not.toBe(sessionIDs[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Retry after failure")

      streamFailure = invalidRequest()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Call missing")

      responses = [reply.tool("call-missing", "missing", {}), reply.text("Recovered", "text-after-error")]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: {
                status: "error",
                error: { type: "tool.unknown", message: "Unknown tool: missing" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns unexpected local tool defects to the model and continues", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Call defect")

      responses = [reply.tool("call-defect", "defect", {}), reply.text("Recovered", "text-after-defect")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.ended.1",
      ])
    }),
  )

  it.effect("returns tool-wrapped policy blocks to the model and continues", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      yield* registry.register(
        {
          blocked: Tool.make({
            description: "Fail because policy blocked execution",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () =>
              Effect.fail(new PermissionV2.BlockedError({ rules: [], permission: "blocked", resources: ["*"] })).pipe(
                Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
              ),
          }),
        },
        { codemode: false },
      )
      yield* admit(session, "Call blocked")

      responses = [reply.tool("call-blocked", "blocked", {}), reply.text("Fixture response", "text-fixture")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      yield* registry.register(
        {
          declined: Tool.make({
            description: "Fail because the user declined approval",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die(new PermissionV2.DeclinedError()),
          }),
        },
        { codemode: false },
      )
      yield* admit(session, "Call declined")

      response = reply.tool("call-declined", "declined", {})

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("returns permission corrections to the model and continues", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      yield* registry.register(
        {
          corrected: Tool.make({
            description: "Fail with user correction feedback",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () =>
              Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
                Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
              ),
          }),
        },
        { codemode: false },
      )
      yield* admit(session, "Call corrected")

      responses = [reply.tool("call-corrected", "corrected", {}), reply.text("Fixture response", "text-fixture")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("fails the drain when tool output persistence fails", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Call storefail")

      responses = [reply.tool("call-storefail", "storefail", {}), []]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call storefail" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-storefail",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: expect.stringContaining("Failed to encode tool output"),
                },
              },
            },
          ],
          finish: "error",
          error: { type: "unknown", message: expect.stringContaining("Failed to encode tool output") },
        },
      ])
    }),
  )

  it.effect("returns configured permission denials to the model and continues", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      yield* registry.register({ permissionfail: permissionFail }, { codemode: false })
      yield* admit(session, "Reject permission")
      responses = [
        reply.tool("call-permission", "permissionfail", {}),
        reply.text("Permission denied", "text-permission-denied"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-permission",
              state: {
                status: "error",
                error: {
                  type: "permission.rejected",
                  message: "Permission denied: edit",
                },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.failed.1")
    }),
  )

  it.effect("interrupts runner continuation when a question is cancelled", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      yield* registry.register(
        {
          question: Tool.make({
            description: "Ask the user",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die(new QuestionTool.CancelledError()),
          }),
        },
        { codemode: false },
      )
      yield* admit(session, "Ask then stop")

      responses = [reply.tool("call-question", "question", {}), []]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "aborted", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Settle before failing")
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.failed.1",
      ])
    }),
  )

  it.effect("durably fails blocked local tools when a step is interrupted", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Interrupt blocked tool")
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "aborted", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = reply.text("Recovered blocked tool", "text-recovered-blocked-tool")
      yield* session.resume(sessionID)
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("interrupts a blocked step without local tool execution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Interrupt provider")
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt provider" },
        { type: "assistant", finish: "error", error: { type: "aborted", message: "Step interrupted" } },
      ])
      expect(yield* recordedEventTypes(sessionID)).toContain("session.step.failed.1")
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Interrupt tool settlement")
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      response = reply.tool("call-await-interrupt", "echo", { text: "blocked" })

      const runner = yield* SessionRunner.Service
      const run = yield* runner.drain({ sessionID, force: true }).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "aborted", message: "Step interrupted" },
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "aborted", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes).toContain("session.step.failed.1")
      expect(eventTypes).not.toContain("session.step.ended.1")
    }),
  )

  it.effect("forces a text response on an agent's configured final step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Finish at the limit")

      responses = [
        reply.tool("call-terminal", "echo", { text: "done" }),
        reply.tool("call-forbidden", "echo", { text: "forbidden" }),
        reply.text("Terminal answer", "text-terminal-answer"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      expect(nonVolatileMessages(requests[1]).at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(requests[2]?.tools).toEqual([])
      expect(JSON.stringify(requests[2]?.messages)).not.toContain("MAXIMUM STEPS REACHED")
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
        { type: "assistant", content: [{ type: "text", text: "Terminal answer" }] },
      ])
    }),
  )

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Start work")

      responses = [
        reply.tool("call-before-steer", "echo", { text: "before" }),
        reply.tool("call-after-steer", "echo", { text: "after" }),
        reply.text("Fixture response", "text-fixture"),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, text: "Change direction" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail durably")

      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("Provider unavailable")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "provider.unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail before step")

      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("Provider unavailable")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "provider.unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects content-filter finishes as visible terminal failures", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Blocked response")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial" }),
        LLMEvent.textDelta({ id: "partial", text: "Partial" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "content-filter",
          usage: { nonCachedInputTokens: 8, outputTokens: 3, reasoningTokens: 1 },
        }),
        LLMEvent.finish({ reason: "content-filter" }),
      ]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("Provider blocked the response")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.content-filter" },
          cost: 0,
          tokens: { input: 8, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
          diagnostics: {
            providerCache: {
              mechanism: "openai-prefix-cache",
              readReported: false,
              writeReported: false,
            },
          },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
      expect(yield* session.get(sessionID)).toMatchObject({
        cost: 0,
        tokens: { input: 8, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
      })
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.ended.1")
      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(
        (yield* recordedStepSettlementEvents(sessionID, assistant.id)).find(
          (event) => event.type === "session.step.failed.1",
        )?.data,
      ).toMatchObject({
        providerCache: {
          mechanism: "openai-prefix-cache",
          readReported: false,
          writeReported: false,
        },
      })
    }),
  )

  it.effect("settles a local tool before one content-filter step failure", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Tool before blocked response")
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-content-filter", name: "echo", input: { text: "settled" } }),
        LLMEvent.stepFinish({ index: 0, reason: "content-filter" }),
        LLMEvent.finish({ reason: "content-filter" }),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect((yield* Fiber.join(run).pipe(Effect.flip)).message).toBe("Provider blocked the response")
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.failed.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
    }),
  )

  it.effect("rebases once after pre-output context overflow and retries without provider-only state", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const db = (yield* Database.Service).db
      currentModel = storedRecoveryResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      compactionSummary = true
      const opaque = {
        type: "compaction",
        id: "cmp_overflow_private",
        encrypted_content: "overflow-private-state",
      }
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "overflow-reasoning" }),
          LLMEvent.reasoningDelta({
            id: "overflow-reasoning",
            text: "Thinking",
            providerMetadata: { openai: { opaqueCompactionItem: opaque } },
          }),
          LLMEvent.reasoningEnd({ id: "overflow-reasoning" }),
          LLMEvent.toolCall({ id: "overflow-tool", name: "echo", input: { text: "overflow" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            providerMetadata: { openai: { responseId: "resp_before_overflow" } },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        Stream.fromIterable([
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ]),
        Stream.fromIterable(reply.textWithResponse("Recovered", "overflow-recovered", "resp_after_overflow")),
      ]

      yield* admit(session, "Recover from overflow")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[1]?.providerOptions?.openai).toHaveProperty("previousResponseId", "resp_before_overflow")
      expect(requests[2]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      expect(requests[2]?.providerOptions?.openai?.promptCacheKey).toBe(
        requests[1]?.providerOptions?.openai?.promptCacheKey,
      )
      expect(requests[2]?.providerOptions?.openrouter?.sessionID).toBe(
        requests[1]?.providerOptions?.openrouter?.sessionID,
      )
      expect(requests[2]?.system).toEqual(requests[1]?.system)
      expect(requests[2]?.tools).toEqual(requests[1]?.tools)
      const rebuiltInput = JSON.stringify(requests[2]?.messages)
      expect(rebuiltInput).toContain("conversation-checkpoint")
      expect(rebuiltInput).toContain("Recover from overflow")
      expect(rebuiltInput).not.toContain("overflow-private-state")
      expect(
        yield* db
          .select({ revision: SessionContextStateTable.revision })
          .from(SessionContextStateTable)
          .where(eq(SessionContextStateTable.session_id, sessionID))
          .get(),
      ).toEqual({ revision: 1 })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover from overflow" },
        { type: "assistant" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("reprepares when background compaction activates before provider execution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const hooks = yield* PluginHooks.Service
      const events = yield* EventV2.Service
      const providerRequests = yield* SessionProviderRequest.Service
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      responses = [
        reply.textWithResponse("First answer", "text-first", "resp_first"),
        reply.textWithResponse("Second answer", "text-second", "resp_second"),
      ]
      const retainedState = [
        "First user request",
        "Active skill: runner-retention; active because this request selected it; route only post-compaction requests.",
        "Objective: preserve the first request.",
        "Accepted decision: keep TOON version 2.",
        "Todo [in_progress]: send the rebased provider request.",
        "Todo [pending]: validate the response.",
        "```ts",
        'const marker = "retained-fence"',
        "```",
      ].join("\n")
      yield* admit(session, retainedState)
      yield* session.resume(sessionID)

      const compactionWakeStarted = yield* Deferred.make<void>()
      const compactionWakeGate = yield* Deferred.make<void>()
      compactionSummary = true
      compactionWakeHook = Deferred.succeed(compactionWakeStarted, undefined).pipe(
        Effect.andThen(Deferred.await(compactionWakeGate)),
      )
      const compacted = yield* session.compact({ sessionID }).pipe(Effect.forkChild)
      yield* Deferred.await(compactionWakeStarted)

      yield* insertSession(otherSessionID)
      const providerLedgerBlocked = yield* Deferred.make<void>()
      const providerLedgerGate = yield* Deferred.make<void>()
      const stopBlockingProviderLedger = yield* events.listen((event) => {
        if (event.type !== "session.provider.request.recorded") return Effect.void
        const recorded = event as EventV2.Payload<typeof SessionEvent.ProviderRequestRecorded>
        if (recorded.data.sessionID !== otherSessionID) return Effect.void
        return Deferred.succeed(providerLedgerBlocked, undefined).pipe(
          Effect.andThen(Deferred.await(providerLedgerGate)),
        )
      })
      const blocker = yield* providerRequests.next({
        sessionID: otherSessionID,
        source: "title",
        agent: AgentV2.ID.make("build"),
        model: ModelV2.Ref.make({ id: ModelV2.ID.make("gpt-5.6"), providerID: ProviderV2.ID.make("openai") }),
        routeID: "openai-responses",
        promptCacheKey: "block-provider-ownership",
        systemDigest: "system",
        toolDigest: "tools",
      })
      const blockingCompletion = yield* blocker
        .complete({
          continuation: "full",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(providerLedgerBlocked)

      const prepareStarted = yield* Deferred.make<void>()
      const prepareGate = yield* Deferred.make<void>()
      let blockPrepare = true
      yield* hooks.register("session", "context", () => {
        if (!blockPrepare) return Effect.void
        blockPrepare = false
        return Deferred.succeed(prepareStarted, undefined).pipe(Effect.andThen(Deferred.await(prepareGate)))
      })
      yield* admit(session, "Second user request")
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(prepareStarted)
      yield* Deferred.succeed(prepareGate, undefined)
      yield* Effect.yieldNow
      yield* Deferred.succeed(compactionWakeGate, undefined)
      yield* Fiber.join(compacted)
      yield* Deferred.succeed(providerLedgerGate, undefined)
      yield* Fiber.join(blockingCompletion)
      yield* stopBlockingProviderLedger
      yield* Fiber.join(resumed)

      expect(requests).toHaveLength(2)
      expect((yield* providerRequests.list(sessionID)).map((request) => request.attempts)).toEqual([1, 1])
      expect(requests[1]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      expect(requests[1]?.providerOptions?.openai?.promptCacheKey).toBe(
        requests[0]?.providerOptions?.openai?.promptCacheKey,
      )
      expect(requests[1]?.providerOptions?.openrouter?.sessionID).toBe(
        requests[0]?.providerOptions?.openrouter?.sessionID,
      )
      expect(requests[1]?.system).toEqual(requests[0]?.system)
      expect(requests[1]?.tools).toEqual(requests[0]?.tools)
      const modelInput = JSON.stringify(requests[1]?.messages)
      expect(modelInput).toContain("conversation-checkpoint")
      expect(modelInput).toContain("conversation_memory")
      expect(modelInput).toContain("Active skill: runner-retention")
      expect(modelInput).toContain("Objective: preserve the first request")
      expect(modelInput).toContain("Accepted decision: keep TOON version 2")
      expect(modelInput).toContain("Todo [in_progress]: send the rebased provider request")
      expect(modelInput).toContain("Todo [pending]: validate the response")
      expect(modelInput).toContain("retained-fence")
      expect(modelInput).toContain("Second user request")
      expect(modelInput).not.toContain("First answer")
    }),
  )

  it.effect("converts a second pre-output overflow into context.limit without a third request", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.providerError({ message: "first overflow", classification: "context-overflow" }),
        ]),
        Stream.fromIterable([
          LLMEvent.providerError({ message: "second overflow", classification: "context-overflow" }),
        ]),
      ]

      yield* admit(session, "Overflow twice")
      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toContain("after one compaction rebase")

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: expect.stringContaining("Earlier question") },
        { type: "assistant", finish: "stop" },
        { type: "user", text: "Overflow twice" },
        { type: "assistant", finish: "error", error: { type: "context.limit" } },
      ])
    }),
  )

  it.effect("rebases once after a native streamed context-overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStreams = [
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 })]).pipe(Stream.concat(Stream.fail(contextOverflow()))),
        Stream.fromIterable(reply.text("Recovered", "native-overflow-recovered")),
      ]

      yield* admit(session, "Recover native overflow")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const assistant = (yield* session.context(sessionID)).findLast((message) => message.type === "assistant")
      if (!assistant || assistant.type !== "assistant") throw new Error("Recovered assistant missing")
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.filter((event) => event.type === "session.step.started.1")).toHaveLength(1)
      expect(
        events.filter((event) => event.type === "session.step.ended.1" || event.type === "session.step.failed.1"),
      ).toHaveLength(1)
      expect(assistant).toMatchObject({ finish: "stop", content: [{ type: "text", text: "Recovered" }] })
    }),
  )

  it.effect("continues provider execution without a configured context window", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = missingContextLimitModel

      yield* admit(session, "Unprovable context limit")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("continues provider execution without a configured output limit", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = missingOutputLimitModel

      yield* admit(session, "Unprovable output limit")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("continues a started overflow step when recovery cannot prove the cap", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fromEffect(
        Effect.sync(() => {
          currentModel = missingContextLimitModel
          return LLMEvent.stepStart({ index: 0 })
        }),
      ).pipe(
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.providerError({ message: "overflow before unprovable retry", classification: "context-overflow" }),
          ]),
        ),
      )

      yield* admit(session, "Fail overflow recovery preflight")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const assistant = (yield* session.context(sessionID)).findLast((message) => message.type === "assistant")
      if (!assistant || assistant.type !== "assistant") throw new Error("Recovered assistant missing")
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.filter((event) => event.type === "session.step.started.1")).toHaveLength(1)
      expect(events.filter((event) => event.type === "session.step.failed.1")).toHaveLength(0)
      expect(events.filter((event) => event.type === "session.step.ended.1")).toHaveLength(1)
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail after output")

      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("prompt too long")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail raw stream durably")
      const failure = invalidRequest()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      const messages = yield* session.context(sessionID)
      expect(messages).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "provider.invalid-request", message: "Invalid request" } },
      ])
      expect(messages.find((message) => message.type === "user")?.time.consumed).toBeUndefined()
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.input.consumed.1")
    }),
  )

  it.effect("retries eligible pre-output failures after exponential backoff", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Retry transport")
      responseStream = Stream.fail(providerUnavailable())
      response = reply.text("Recovered", "retry-success")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("1999 millis")
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(requestKeepalive).toEqual([undefined, undefined])
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes).toContain("session.retry.scheduled.1")
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.input.consumed.1")).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", time: { consumed: expect.anything() } },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.filter((event) => event.type === "session.step.started.1")).toHaveLength(1)
      expect(
        events.filter((event) => event.type === "session.step.ended.1" || event.type === "session.step.failed.1"),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      const replayed = yield* session.context(sessionID)
      expect(replayed.filter((message) => message.type === "assistant")).toHaveLength(1)
      expect(replayed.find((message) => message.type === "user")?.time.consumed).toBeDefined()
    }),
  )

  it.effect("uses a fresh connection only when retrying a pre-output Codex stream read failure", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = codexModel
      yield* admit(session, "Retry Codex stream read")
      responseStream = Stream.fail(streamReadFailure())
      response = reply.text("Recovered", "fresh-connection-retry-success")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(requests.every((request) => request.model.route.id === "openai-codex-responses")).toBe(true)
      expect(requestKeepalive).toEqual([undefined, false])
    }),
  )

  it.effect("keeps pooling when retrying a Codex transport failure outside response reading", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = codexModel
      yield* admit(session, "Retry Codex connection failure")
      responseStream = Stream.fail(providerUnavailable())
      response = reply.text("Recovered", "pooled-connection-retry-success")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(requestKeepalive).toEqual([undefined, undefined])
    }),
  )

  it.effect("retries a plain-text OpenAI server_error before observable output", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Retry OpenAI server error")
      responseStream = Stream.fail(
        new LLMError({
          module: "OpenAIResponses",
          method: "stream",
          reason: classifyProviderFailure({
            message: "server_error: An error occurred while processing your request. You can retry your request.",
          }),
        }),
      )
      response = reply.text("Recovered", "server-error-retry-success")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(yield* recordedEventTypes(sessionID)).toContain("session.retry.scheduled.1")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("uses a larger provider retry-after delay", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Retry rate limit")
      responseStream = Stream.fail(rateLimited(5_000))
      response = reply.text("Recovered", "retry-after-success")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("4999 millis")
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(run)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("does not retry eligible failures after observable output", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Do not replay partial output")
      const failure = rateLimited()
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial-rate-limit" }),
        LLMEvent.textDelta({ id: "partial-rate-limit", text: "Partial" }),
      ]).pipe(Stream.concat(Stream.fail(failure)))

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.rate-limit" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("retries a transport failure after empty reasoning within the same logical step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = providerUnavailable()
      yield* admit(session, "Retry after empty reasoning transport failure")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-transport-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-transport-failure", text: "" }),
        ]).pipe(Stream.concat(Stream.fail(failure))),
        Stream.fromIterable(reply.text("Recovered answer", "text-after-reasoning-transport-failure")),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(0)
      expect(eventTypes.filter((type) => type === "session.step.ended.1")).toHaveLength(1)
      const assistants = (yield* session.context(sessionID)).filter(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistants).toHaveLength(1)
      expect(assistants[0]).toMatchObject({
        finish: "stop",
        content: [
          { type: "reasoning", text: "", time: { completed: expect.anything() } },
          { type: "text", text: "Recovered answer" },
        ],
      })
      expect((yield* recordedStepSettlementEvents(sessionID, assistants[0].id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.step.ended.1",
      ])
      yield* replaySessionProjection(sessionID)
      expect(requireAssistant(yield* session.context(sessionID)).content[0]).toMatchObject({
        type: "reasoning",
        text: "",
        time: { completed: expect.anything() },
      })
    }),
  )

  it.effect("completes empty text before retrying its transport failure within the same logical step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = providerUnavailable()
      yield* admit(session, "Retry after empty text transport failure")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-before-transport-failure" }),
          LLMEvent.textDelta({ id: "text-before-transport-failure", text: "" }),
        ]).pipe(Stream.concat(Stream.fail(failure))),
        Stream.fromIterable(reply.text("Recovered answer", "text-after-transport-failure")),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(0)
      expect(eventTypes.filter((type) => type === "session.step.ended.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.text.ended.1")).toHaveLength(2)
      const assistants = (yield* session.context(sessionID)).filter(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistants).toHaveLength(1)
      expect(assistants[0]).toMatchObject({
        finish: "stop",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Recovered answer" },
        ],
      })
      expect((yield* recordedStepSettlementEvents(sessionID, assistants[0].id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.step.ended.1",
      ])
      yield* replaySessionProjection(sessionID)
      expect(requireAssistant(yield* session.context(sessionID)).content).toMatchObject([
        { type: "text", text: "" },
        { type: "text", text: "Recovered answer" },
      ])
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.text.ended.1")).toHaveLength(2)
    }),
  )

  it.effect("does not retry a transport failure after non-empty reasoning", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = providerUnavailable()
      yield* admit(session, "Do not replay reasoning")
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-before-transport-failure" }),
        LLMEvent.reasoningDelta({ id: "reasoning-before-transport-failure", text: "Thinking" }),
      ]).pipe(Stream.concat(Stream.fail(failure)))

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.transport" },
          content: [{ type: "reasoning", text: "Thinking" }],
        },
      ])
    }),
  )

  it.effect("does not retry a transport failure after tool evidence", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = providerUnavailable()
      yield* admit(session, "Do not replay tool evidence")
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "tool-before-transport-failure", name: "echo" }),
      ]).pipe(Stream.concat(Stream.fail(failure)))

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.transport" },
          content: [
            {
              type: "tool",
              id: "tool-before-transport-failure",
              state: { status: "error" },
            },
          ],
        },
      ])
    }),
  )

  it.effect("does not retry a failed terminal response recovery or create a third request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const recoveryFailure = providerUnavailable()
      yield* admit(session, "Fail terminal response recovery")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-failed-recovery" }),
        ]),
        Stream.fail(recoveryFailure),
        Stream.fromIterable(reply.text("Must not run", "text-after-failed-recovery")),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      const exit = yield* Fiber.join(run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.squash(exit.cause)).toBe(recoveryFailure)
      expect(requests).toHaveLength(2)
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes).not.toContain("session.retry.scheduled.1")
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(2)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(2)
    }),
  )

  it.effect("stops after ten total retry attempts with capped exponential backoff", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Exhaust retries")
      streamFailure = providerUnavailable()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000, 120_000, 120_000].entries()) {
        yield* TestClock.adjust(delay)
        while (requests.length < index + 2) {
          if (run.pollUnsafe() !== undefined) break
          yield* Effect.yieldNow
        }
      }
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(streamFailure)
      expect(requests).toHaveLength(10)

      const database = (yield* Database.Service).db
      const retries = yield* database
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.retry.scheduled.1"))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(retries.map((event) => event.data)).toMatchObject([
        { attempt: 2, at: 2_000 },
        { attempt: 3, at: 6_000 },
        { attempt: 4, at: 14_000 },
        { attempt: 5, at: 30_000 },
        { attempt: 6, at: 62_000 },
        { attempt: 7, at: 126_000 },
        { attempt: 8, at: 246_000 },
        { attempt: 9, at: 366_000 },
        { attempt: 10, at: 486_000 },
      ])
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.started.1")).toHaveLength(1)
      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(yield* recordedStepSettlementEvents(sessionID, assistant.id)).toMatchObject([
        { type: "session.step.started.1" },
        { type: "session.step.failed.1" },
      ])
      const providerRequests = yield* SessionProviderRequest.Service
      expect(
        (yield* providerRequests.list(sessionID)).map((record) => ({
          request: record.request,
          attempts: record.attempts,
          invalidation: record.invalidation,
          continuation: record.continuation,
        })),
      ).toEqual([
        {
          request: 1,
          attempts: 10,
          invalidation: "retry-fallback",
          continuation: "fallback",
        },
      ])
    }),
  )

  it.effect("retries a physical attempt without consuming the logical agent step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Retry without consuming a step")
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)
      responses = [
        reply.tool("call-after-retry", "echo", { text: "recovered" }),
        reply.text("Fixture response", "text-fixture"),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(3)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("echo")
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools.map((tool) => tool.name)).toContain("echo")
      expect(nonVolatileMessages(requests[1]).at(-1)).not.toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[2]?.tools).toEqual([])
      expect(nonVolatileMessages(requests[2]).at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["recovered"])
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(2)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(1)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toHaveLength(2)

      const providerRequests = yield* SessionProviderRequest.Service
      expect(
        (yield* providerRequests.list(sessionID)).map((record) => ({
          request: record.request,
          attempts: record.attempts,
          source: record.source,
        })),
      ).toEqual([
        { request: 1, attempts: 2, source: "step" },
        { request: 2, attempts: 1, source: "step" },
      ])
      expect(yield* providerRequests.summary(sessionID)).toMatchObject({ logical: 2, physical: 3, helpers: 0 })
    }),
  )

  it.effect("does not retry non-eligible provider failures", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Do not retry")
      const failure = invalidRequest()
      streamFailure = failure

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
    }),
  )

  it.effect("recovers terminal silence with one text-only terminal response step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Answer the request")
      responses = [reply.silence(), reply.text("Recovered answer", "text-terminal-recovery")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("MAXIMUM STEPS REACHED")
      expect(userTexts(requests[1]!)).toEqual(["Answer the request"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Answer the request" },
        { type: "assistant", finish: "stop", content: [] },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered answer" }] },
      ])
    }),
  )

  it.effect("recovers an unstarted empty provider stream without inventing a first Step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Answer after an empty stream")
      responses = [[], reply.text("Recovered after empty stream", "text-unstarted-recovery")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type.startsWith("session.step."))).toEqual([
        "session.step.started.1",
        "session.step.ended.1",
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Answer after an empty stream" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered after empty stream" }] },
      ])
    }),
  )

  it.effect("recovers terminal silence after a settled local tool continuation", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Use a tool before answering")
      responses = [
        reply.tool("call-before-silence", "echo", { text: "settled" }),
        reply.silence(),
        reply.text("Final answer", "text-after-tool-silence"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(executions).toEqual(["settled"])
      expect(requireAssistant((yield* session.context(sessionID)).slice(-1))).toMatchObject({
        finish: "stop",
        content: [{ type: "text", text: "Final answer" }],
      })
    }),
  )

  it.effect("fails provider-executed tool-only terminal response recovery without a third request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Answer without hosted tools")
      responses = [
        reply.silence(),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-recovery",
            name: "web_search",
            input: { query: "Effect" },
            providerExecuted: true,
          }),
          LLMEvent.toolResult({
            id: "call-hosted-recovery",
            name: "web_search",
            result: { type: "json", value: [{ title: "Effect" }] },
            providerExecuted: true,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe(
        "Terminal response recovery requires non-whitespace assistant text",
      )

      expect(requests).toHaveLength(2)
      expect(requireAssistant((yield* session.context(sessionID)).slice(-1))).toMatchObject({
        finish: "error",
        content: [{ type: "tool", id: "call-hosted-recovery", executed: true, state: { status: "completed" } }],
      })
    }),
  )

  it.effect("resets terminal silence recovery after a pending steer promotes", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Initial request")
      responses = [reply.silence(), reply.silence(), reply.text("Steered answer", "text-steered-recovery")]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, text: "Steered request" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1]!)).toEqual(["Initial request", "Steered request"])
      expect(requireAssistant((yield* session.context(sessionID)).slice(-1))).toMatchObject({
        finish: "stop",
        content: [{ type: "text", text: "Steered answer" }],
      })
    }),
  )

  it.effect("promotes a steer admitted during exhausted terminal response recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const recoveryStarted = yield* Deferred.make<void>()
      const releaseRecovery = yield* Deferred.make<void>()
      yield* admit(session, "Initial request")
      responseStreams = [
        Stream.fromIterable(reply.silence()),
        Stream.unwrap(
          Deferred.succeed(recoveryStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRecovery)),
            Effect.as(Stream.fromIterable(reply.silence())),
          ),
        ),
        Stream.fromIterable(reply.text("Steered answer", "text-steered-exhausted-recovery")),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(recoveryStarted)
      yield* session.prompt({ sessionID, text: "Steered request" })
      yield* Deferred.succeed(releaseRecovery, undefined)
      yield* Fiber.join(run)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[2]!)).toEqual(["Initial request", "Steered request"])
      expect(
        (yield* session.context(sessionID)).filter(
          (message): message is SessionMessage.Assistant => message.type === "assistant",
        ),
      ).toMatchObject([
        { finish: "stop", content: [] },
        {
          finish: "error",
          error: {
            type: "provider.invalid-output",
            message: "Terminal response recovery requires non-whitespace assistant text",
          },
        },
        { finish: "stop", content: [{ type: "text", text: "Steered answer" }] },
      ])
    }),
  )

  it.effect("promotes a steer admitted during missing-settlement terminal response recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const recoveryStarted = yield* Deferred.make<void>()
      const releaseRecovery = yield* Deferred.make<void>()
      yield* admit(session, "Initial request")
      responseStreams = [
        Stream.fromIterable(reply.silence()),
        Stream.unwrap(
          Deferred.succeed(recoveryStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRecovery)),
            Effect.as(Stream.fromIterable([LLMEvent.stepStart({ index: 0 })])),
          ),
        ),
        Stream.fromIterable(reply.text("Steered answer", "text-steered-missing-settlement")),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(recoveryStarted)
      yield* session.prompt({ sessionID, text: "Steered request" })
      yield* Deferred.succeed(releaseRecovery, undefined)
      yield* Fiber.join(run)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[2]!)).toEqual(["Initial request", "Steered request"])
      expect(
        (yield* session.context(sessionID)).filter(
          (message): message is SessionMessage.Assistant => message.type === "assistant",
        ),
      ).toMatchObject([
        { finish: "stop", content: [] },
        { finish: "error", error: { type: "provider.invalid-output", message: "Provider did not settle the step" } },
        { finish: "stop", content: [{ type: "text", text: "Steered answer" }] },
      ])
    }),
  )

  it.effect("fails repeated terminal silence without a third response step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Answer once")
      responses = [reply.silence(), reply.silence()]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe(
        "Terminal response recovery requires non-whitespace assistant text",
      )

      expect(requests).toHaveLength(2)
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.started.1")).toHaveLength(2)
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.failed.1")).toHaveLength(1)
    }),
  )

  it.effect("fails a local tool emitted during terminal response recovery without executing it", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Answer without tools")
      responses = [reply.silence(), reply.tool("call-recovery-tool", "echo", { text: "must not execute" })]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe(
        "Tools are disabled for terminal response recovery",
      )

      expect(requests).toHaveLength(2)
      expect(executions).toEqual([])
      expect(requireAssistant((yield* session.context(sessionID)).slice(-1))).toMatchObject({
        finish: "error",
        error: { type: "tool.execution", message: "Tools are disabled for terminal response recovery" },
        content: [{ type: "tool", id: "call-recovery-tool", state: { status: "error" } }],
      })
    }),
  )

  it.effect("recovers reasoning-only terminal output after failing its missing settlement", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Explain the result")
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-missing-settlement" }),
          LLMEvent.reasoningDelta({ id: "reasoning-missing-settlement", text: "Thinking" }),
          LLMEvent.reasoningEnd({ id: "reasoning-missing-settlement" }),
        ],
        reply.text("Explained", "text-after-missing-settlement"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const assistants = (yield* session.context(sessionID)).filter((message) => message.type === "assistant")
      expect(assistants).toHaveLength(2)
      expect(assistants[0]).toMatchObject({
        finish: "error",
        error: { type: "provider.invalid-output", message: "Provider did not settle the step" },
      })
      expect(assistants[1]).toMatchObject({
        finish: "stop",
        content: [{ type: "text", text: "Explained" }],
      })
    }),
  )

  it.effect("fails missing step settlement after assistant text without recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Answer directly")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-unsettled" }),
        LLMEvent.textDelta({ id: "text-unsettled", text: "Partial answer" }),
        LLMEvent.textEnd({ id: "text-unsettled" }),
      ]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("Provider did not settle the step")

      expect(requests).toHaveLength(1)
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        finish: "error",
        error: { type: "provider.invalid-output", message: "Provider did not settle the step" },
        content: [{ type: "text", text: "Partial answer" }],
      })
    }),
  )

  it.effect("fails a started assistant for a non-LLM stream failure while preserving its cause", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = new Error("Unexpected stream failure")
      yield* admit(session, "Handle a stream failure")
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-non-llm-failure" }),
          LLMEvent.textDelta({ id: "text-non-llm-failure", text: "Partial" }),
        ]),
        Stream.fail(failure),
      )

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.squash(exit.cause)).toBe(failure)

      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        finish: "error",
        error: { type: "unknown", message: "Unexpected stream failure" },
        content: [{ type: "text", text: "Partial" }],
      })
    }),
  )

  it.effect("fails a started assistant for a stream defect while preserving the original defect", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = new Error("Unexpected stream defect")
      yield* admit(session, "Handle a stream defect")
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-stream-defect" }),
          LLMEvent.textDelta({ id: "text-stream-defect", text: "Partial" }),
        ]),
        Stream.die(failure),
      )

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.squash(exit.cause)).toBe(failure)

      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(assistant).toMatchObject({
        finish: "error",
        error: { type: "unknown", message: "Unexpected stream defect" },
        content: [{ type: "text", text: "Partial" }],
      })
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.step.failed.1",
      ])
    }),
  )

  it.effect("fails an unstarted assistant for a stream defect without recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = new Error("Unexpected unstarted stream defect")
      yield* admit(session, "Handle an unstarted stream defect")
      responseStream = Stream.die(failure)

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.squash(exit.cause)).toBe(failure)

      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(assistant).toMatchObject({
        finish: "error",
        error: { type: "unknown", message: "Unexpected unstarted stream defect" },
        content: [],
      })
      expect(requests).toHaveLength(1)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.step.failed.1",
      ])
    }),
  )

  it.effect("records terminal response recovery as a full OpenAI Responses request without stored continuation", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
      const silent = reply.silence().map((event) =>
        LLMEvent.is.stepFinish(event)
          ? LLMEvent.stepFinish({
              index: event.index,
              reason: event.reason,
              providerMetadata: { openai: { responseId: "resp_silent" } },
            })
          : event,
      )
      responses = [silent, reply.textWithResponse("Recovered", "text-recovered", "resp_recovered")]
      yield* admit(session, "Provide a final answer")

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
      expect(requests[1]?.providerOptions?.openai).not.toHaveProperty("continuationInputStart")
      const providerRequests = yield* SessionProviderRequest.Service
      expect((yield* providerRequests.list(sessionID)).map((record) => record.continuation)).toEqual(["full", "full"])
    }),
  )

  it.effect("settles malformed streamed tool input before the provider failure", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Call a malformed tool")
      const failure = new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidProviderOutputReason({ message: "Invalid JSON input for tool call echo" }),
      })
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-malformed", name: "echo" }),
        LLMEvent.toolInputDelta({ id: "call-malformed", name: "echo", text: '{"text":"partial' }),
      ]).pipe(Stream.concat(Stream.fail(failure)))

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      const assistant = requireAssistant(yield* session.context(sessionID))

      response = reply.text("Fixture response", "text-fixture")
      yield* admit(session, "Continue")
      yield* session.resume(sessionID)

      expect(yield* recordedStepSettlementEvents(sessionID, assistant.id)).toMatchObject([
        { type: "session.step.started.1" },
        {
          type: "session.tool.failed.1",
          data: {
            callID: "call-malformed",
            error: { type: "provider.invalid-output", message: "Invalid JSON input for tool call echo" },
          },
        },
        {
          type: "session.step.failed.1",
          data: { error: { type: "provider.invalid-output", message: "Invalid JSON input for tool call echo" } },
        },
      ])
    }),
  )

  it.effect("continues after malformed local tool input without exposing raw arguments", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Recover malformed tool input")
      const marker = "raw-malformed-marker"
      const raw = `{"text":"${marker}`
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-malformed", name: "echo" }),
          LLMEvent.toolInputDelta({ id: "call-malformed", name: "echo", text: raw }),
          LLMEvent.toolInputEnd({ id: "call-malformed", name: "echo" }),
          LLMEvent.toolInputError({
            id: "call-malformed",
            name: "echo",
            raw,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Fixture response", "text-fixture"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(executions).toEqual([])
      expect(JSON.stringify(requests[1])).not.toContain(marker)
      expect(requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "tool-call", id: "call-malformed", name: "echo", input: {} }),
            ]),
          }),
          expect.objectContaining({
            role: "tool",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "tool-result",
                id: "call-malformed",
                result: expect.objectContaining({
                  type: "error",
                  value: expect.objectContaining({
                    error: expect.objectContaining({
                      message: "Tool call arguments were malformed JSON and were not executed. Retry with valid JSON.",
                    }),
                  }),
                }),
              }),
            ]),
          }),
        ]),
      )
      const context = yield* session.context(sessionID)
      const failed = context.find(
        (message): message is SessionMessage.Assistant =>
          message.type === "assistant" && message.content.some((item) => item.type === "tool"),
      )
      expect(failed).toMatchObject({
        content: [
          {
            type: "tool",
            id: "call-malformed",
            executed: false,
            state: {
              status: "error",
              input: {},
              error: {
                type: "tool.input-json",
                message: "Tool call arguments were malformed JSON and were not executed. Retry with valid JSON.",
              },
            },
          },
        ],
      })
      if (!failed) throw new Error("Malformed tool assistant missing")
      expect(failed.error).toBeUndefined()
      expect((yield* recordedStepSettlementEvents(sessionID, failed.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.failed.1",
        "session.step.ended.1",
      ])
      const database = (yield* Database.Service).db
      const durable = yield* database
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(durable.find((event) => event.type === "session.tool.input.ended.1")?.data).toMatchObject({
        callID: "call-malformed",
        text: raw,
      })
    }),
  )

  it.effect("settles a valid sibling before recovering malformed tool input", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Run parallel tools")
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-valid", name: "echo", input: { text: "valid" } }),
          LLMEvent.toolInputError({
            id: "call-malformed",
            name: "echo",
            raw: '{"text":"partial',
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Fixture response", "text-fixture"),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(requests).toHaveLength(2)
      expect(executions).toEqual(["valid"])
      const request = requests[1]
      if (!request) throw new Error("Malformed recovery request missing")
      expect(request.messages.flatMap((message) => (message.role === "tool" ? message.content : []))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "call-valid", type: "tool-result" }),
          expect.objectContaining({ id: "call-malformed", type: "tool-result" }),
        ]),
      )
    }),
  )

  it.effect("does not recover malformed input after sibling execution is interrupted", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Interrupt malformed recovery")
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-valid", name: "echo", input: { text: "blocked" } }),
        LLMEvent.toolInputError({
          id: "call-malformed",
          name: "echo",
          raw: '{"text":"partial',
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      while (
        !(yield* session.context(sessionID)).some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((item) => item.type === "tool" && item.id === "call-malformed"),
        )
      )
        yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt malformed recovery" },
        {
          type: "assistant",
          error: { type: "aborted", message: "Step interrupted" },
          content: [
            { type: "tool", id: "call-valid", state: { status: "error", error: { type: "aborted" } } },
            { type: "tool", id: "call-malformed", state: { status: "error" } },
          ],
        },
      ])
    }),
  )

  it.effect("records malformed provider-executed input as executed", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail malformed hosted input")
      const failure = new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidProviderOutputReason({ message: "Invalid hosted tool input" }),
      })
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-hosted", name: "web_search", providerExecuted: true }),
        LLMEvent.toolInputDelta({ id: "call-hosted", name: "web_search", text: '{"query":"partial' }),
      ]).pipe(Stream.concat(Stream.fail(failure)))

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        error: { type: "provider.invalid-output", message: "Invalid hosted tool input" },
        content: [
          {
            type: "tool",
            id: "call-hosted",
            executed: true,
            state: { status: "error", error: { type: "provider.invalid-output" } },
          },
        ],
      })
    }),
  )

  it.effect("records a provider failure after malformed input", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail after malformed input")
      const failure = new LLMError({
        module: "test",
        method: "stream",
        reason: new InvalidProviderOutputReason({ message: "Provider failed after malformed input" }),
      })
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputError({
          id: "call-malformed",
          name: "echo",
          raw: '{"text":"partial',
        }),
      ]).pipe(Stream.concat(Stream.fail(failure)))

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        error: { type: "provider.invalid-output", message: "Provider failed after malformed input" },
        content: [
          {
            type: "tool",
            id: "call-malformed",
            executed: false,
            state: { status: "error", error: { type: "tool.input-json" } },
          },
        ],
      })
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("continues after repeated malformed tool input", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Keep producing malformed tools")
      const malformed = (id: string) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputError({
          id,
          name: "echo",
          raw: '{"text":"partial',
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responses = [
        malformed("call-first"),
        reply.tool("call-valid-between", "echo", { text: "valid" }),
        malformed("call-second"),
        reply.text("Fixture response", "text-fixture"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(4)
      expect(executions).toEqual(["valid"])
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.failed.1")).toHaveLength(0)
    }),
  )

  it.effect("does not continue malformed tool input past the agent step limit", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Stop malformed tools at the step limit")
      const malformed = (id: string) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputError({
          id,
          name: "echo",
          raw: '{"text":"partial',
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responses = [
        malformed("call-first"),
        malformed("call-at-limit"),
        reply.text("Malformed tool recovery", "text-malformed-recovery"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.tool.failed.1")).toHaveLength(2)
    }),
  )

  it.effect("does not continue automatically after a provider error follows a local tool call", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Do not continue failed provider")

      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect((yield* Fiber.join(run).pipe(Effect.flip)).message).toBe("Provider unavailable")
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(requests).toHaveLength(1)
      expect(executions).toEqual(["settled"])
      const context = yield* session.context(sessionID)
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.failed.1",
      ])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail hosted tool durably")

      response = [
        LLMEvent.stepStart({ index: 0 }),
        hostedCall("call-hosted-provider-error", "effect"),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("Provider unavailable")

      expect(requests).toHaveLength(1)
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
    }),
  )

  it.effect("preserves a tool defect before provider failure settlement", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Defect while provider fails")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-defect-provider-error", name: "defect", input: {} }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("Provider unavailable")

      const context = yield* session.context(sessionID)
      const assistant = requireAssistant(context)
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
      expect(events[2]?.data.error).toMatchObject({ type: "unknown", message: "unexpected tool defect" })
    }),
  )

  it.effect("preserves the provider failure when tool output persistence also fails", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Storage fails while provider fails")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-store-provider-error", name: "storefail", input: {} }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        error: { type: "provider.unknown", message: "Provider unavailable" },
      })
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail hosted tool at EOF")
      response = [LLMEvent.stepStart({ index: 0 }), hostedCall("call-hosted-eof", "effect")]

      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe("Provider did not return a tool result")
      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "tool.result-missing" },
          content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("fails an unresolved hosted tool before one clean step end", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Settle hosted tool before ending")
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          hostedCall("call-hosted-clean-end", "effect"),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        reply.text("Hosted tool summary", "text-hosted-tool-summary"),
      ]

      yield* session.resume(sessionID)

      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.ended.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
    }),
  )

  it.effect("settles unresolved local and hosted tools before one raw provider failure", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail unresolved tools")
      const failure = invalidRequest()
      const providerFailed = yield* Deferred.make<void>()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-local-raw-failure", name: "defect", input: {} }),
          hostedCall("call-hosted-raw-failure-pair", "effect"),
        ]),
        Stream.fromEffect(Deferred.succeed(providerFailed, undefined)).pipe(Stream.flatMap(() => Stream.fail(failure))),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(providerFailed)
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => ({ type: event.type, callID: event.data.callID }))).toEqual([
        { type: "session.step.started.1", callID: undefined },
        { type: "session.tool.called.1", callID: "call-local-raw-failure" },
        { type: "session.tool.called.1", callID: "call-hosted-raw-failure-pair" },
        { type: "session.tool.failed.1", callID: "call-local-raw-failure" },
        { type: "session.tool.failed.1", callID: "call-hosted-raw-failure-pair" },
        { type: "session.step.failed.1", callID: undefined },
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail hosted tool on raw failure")
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), hostedCall("call-hosted-raw-failure", "effect")]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.transport", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("rejects a second text start before the open fragment ends", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Two blocks")

      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
      ]

      const defect = yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(Error)
      if (!(defect instanceof Error)) return
      expect(defect.message).toBe("text start before end: text-2")
    }),
  )

  it.effect("projects sequential text fragments as separate content parts", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Two blocks")

      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", text: "First" },
            { type: "text", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      const session = yield* setup
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      const defect = yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(Error)
      if (!(defect instanceof Error)) return
      expect(defect.message).toBe("Duplicate text start: text-1")
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Call provider tool")

      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
          LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
          LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
          hostedCall("call-parsed", "hello"),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        reply.text("Provider tool summary", "text-provider-tool-summary"),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
        { type: "assistant", content: [{ type: "text", text: "Provider tool summary" }] },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      const session = yield* setup
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      const defect = yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(Error)
      if (!(defect instanceof Error)) return
      expect(defect.message).toBe("Tool input delta before start: call-1")
    }),
  )
})
