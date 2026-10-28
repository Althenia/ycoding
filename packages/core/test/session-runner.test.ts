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
  AuthenticationReason,
  ContentPolicyReason,
  QuotaExceededReason,
  type LLMClientShape,
  type LLMRequest,
} from "@ycoding-ai/ai"
import * as AnthropicMessages from "@ycoding-ai/ai/protocols/anthropic-messages"
import * as OpenAIChat from "@ycoding-ai/ai/protocols/openai-chat"
import * as OpenAIResponses from "@ycoding-ai/ai/protocols/openai-responses"
import { classifyProviderFailure } from "@ycoding-ai/ai/provider-error"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Database } from "@ycoding-ai/core/database/database"
import { makeGlobalNode, makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Permission } from "@ycoding-ai/core/permission"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Project } from "@ycoding-ai/core/project"
import { ProjectArtifactInstructions } from "@ycoding-ai/core/project-artifact/instructions"
import { MemoryInstructions } from "@ycoding-ai/core/memory/instructions"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Form } from "@ycoding-ai/core/form"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import type { SessionCacheDiagnostics } from "@ycoding-ai/schema/session-cache-diagnostics"
import { Snapshot } from "@ycoding-ai/core/snapshot"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPermissionCeiling } from "@ycoding-ai/core/session/permission-ceiling"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { TelemetryConsent } from "@ycoding-ai/core/telemetry-consent"
import { ProviderRequestObserver } from "@ycoding-ai/core/session/provider-request-observer"
import { Money } from "@ycoding-ai/schema/money"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { SessionHistoryPruning } from "@ycoding-ai/core/session/history-pruning"
import { SessionModelRequest } from "@ycoding-ai/core/session/model-request"
import { SessionSharedContext } from "@ycoding-ai/core/session/shared-context"
import { InstructionState } from "@ycoding-ai/core/session/instruction-state"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Job } from "@ycoding-ai/core/job"
import { TaskCompleteTool } from "@ycoding-ai/core/tool/task-complete"
import { SessionRunCoordinator } from "@ycoding-ai/core/session/run-coordinator"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import * as SessionRunnerLLM from "@ycoding-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { MAX_STEPS_RESET_PROMPT } from "@ycoding-ai/core/session/runner/max-steps"
import { renderTeamObservation } from "@ycoding-ai/core/session/orchestration-view"
import { SessionModelHeaders } from "@ycoding-ai/core/session/model-headers"
import { SessionUsage } from "@ycoding-ai/core/session/usage"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { SystemPromptPlugin } from "@ycoding-ai/core/plugin/system-prompt"
import { QuestionTool } from "@ycoding-ai/core/tool/question"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCapabilities } from "@ycoding-ai/core/config/capabilities"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { ConfigEfficiency } from "@ycoding-ai/core/config/efficiency"
import { ConfigImageAnalyzer } from "@ycoding-ai/core/config/image-analyzer"
import { Tool } from "@ycoding-ai/core/tool/tool"
import {
  InstructionStateTable,
  SessionPendingTable,
  SessionCompactionJobTable,
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
import { Skill } from "@ycoding-ai/core/skill"
import { ReferenceInstructions } from "@ycoding-ai/core/reference/instructions"
import { McpInstructions } from "@ycoding-ai/core/mcp/instructions"
import { CatalogModel } from "@ycoding-ai/core/model"
import { AppProcess } from "@ycoding-ai/core/process"
import { ModelGuidanceInstructions } from "@ycoding-ai/core/model-incident/instructions"
import { ModelIncidentTable } from "@ycoding-ai/core/model-incident/sql"
import { Location } from "@ycoding-ai/core/location"
import { Provider } from "@ycoding-ai/core/provider"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Statement } from "effect/unstable/sql"
import { and, asc, eq, lte, sql } from "drizzle-orm"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { testEffect } from "./lib/effect"
import { observationMessageData } from "./fixture/session-observations"
import { registerToolPlugin } from "./lib/tool"
import { agentHost, catalogHost, host } from "./plugin/host"
import PROMPT_DEFAULT from "../src/session/runner/prompt/base.txt"
import { fixedLocations } from "./fixture/location-map"

const requests: LLMRequest[] = []
const runnerDirectory = AbsolutePath.make(import.meta.dir)
type TestStreamError = LLMError | Error
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, TestStreamError> | undefined
let responseStreams: Stream.Stream<LLMEvent, TestStreamError>[] | undefined
let nativeResponses: string[] | undefined
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
      if (nativeResponses)
        return LLMClient.stream(request).pipe(
          Stream.provide(
            LLMClient.layer.pipe(
              Layer.provide(
                Layer.succeed(RequestExecutor.Service, {
                  execute: (request) =>
                    Effect.sync(() => {
                      const body = nativeResponses?.shift()
                      if (body === undefined) throw new Error("Unexpected provider request")
                      return HttpClientResponse.fromWeb(
                        request,
                        new Response(body, {
                          headers: { "content-type": "text/event-stream" },
                        }),
                      )
                    }),
                }),
              ),
            ),
          ),
        )
      const observed = <E>(stream: Stream.Stream<LLMEvent, E>) =>
        Stream.unwrap(
          Effect.gen(function* () {
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
  [...values, ProjectArtifactInstructions.content, MemoryInstructions.content].join("\n\n")
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

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const authorizations: Tool.Context[] = []
const executions: string[] = []
const permissionFail = Tool.make({
  description: "Reject a permission",
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  execute: () =>
    new ToolFailure({
      message: "Permission denied: edit",
      error: new Permission.BlockedError({
        rules: [],
        permission: "edit",
        resources: ["src/index.ts"],
      }),
    }),
})
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    deferPending: () => Effect.void,
    evaluateEffective: () => Effect.sync(() => skillAccess),
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    replyDelegated: () => Effect.die("unused"),
    delegatedEligible: () => Effect.die("unused"),
    snapshot: () => Effect.die("unused"),
    snapshots: () => Effect.die("unused"),
    reconsider: () => Effect.die("unused"),
    escalate: () => Effect.die("unused"),
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
        // Built-in guidance for memory and project artifacts renders only while these tools are callable.
        memory: Tool.make({
          description: "Workspace memory",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.succeed({}),
        }),
        project_artifact: Tool.make({
          description: "Project artifacts",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.succeed({}),
        }),
        // BigInt output with no model content forces ToolOutputStore.bound onto its
        // JSON.stringify encode path, which fails with a typed StorageError.
        storefail: Tool.make({
          description: "Produce output that cannot be persisted",
          input: Schema.Struct({}),
          output: Schema.Any,
          execute: () => Effect.succeed({ big: 1n }),
        }),
        snapshot: Tool.make({
          description: "Capture a window image",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          toModelOutput: () => [
            { type: "text", text: "Captured window" },
            { type: "file", data: onePixelPng, mime: "image/png", name: "window.png" },
          ],
          execute: () => Effect.succeed({}),
        }),
      },
      { codemode: false },
    ),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })
let modelResolveHook = Effect.void
let currentModel = model
let currentCost: CatalogModel.Info["cost"] = []
let currentAccountIdentityDigest = "a".repeat(64)
const fallbackModels = new Map<string, { model: Model; cost: CatalogModel.Info["cost"]; digest: string }>()
const unavailableModels = new Set<string>()
const unavailableProfiles = new Set<string>()
const profileDigests = new Map<string, string>()
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const selected = session.model
        if (selected?.profile !== undefined && unavailableProfiles.has(selected.profile))
          return yield* Effect.fail(
            new SessionRunnerModel.ProfileUnavailableError({
              providerID: selected.providerID,
              profile: selected.profile,
            }),
          )
        if (selected && unavailableModels.has(selected.id))
          return yield* Effect.fail(
            new SessionRunnerModel.ModelUnavailableError({ providerID: selected.providerID, modelID: selected.id }),
          )
        const fallback = selected ? fallbackModels.get(selected.id) : undefined
        return SessionRunnerModel.resolved(
          selected?.id === "replacement" ? replacementModel : (fallback?.model ?? currentModel),
          selected?.variant,
          fallback?.cost ?? currentCost,
          fallback?.digest ??
            (selected?.profile ? profileDigests.get(selected.profile) : undefined) ??
            currentAccountIdentityDigest,
        )
      }),
    ),
  ),
)
const systemContextKey = Instructions.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<Agent.ID, string>()
let skillAccess: "allow" | "deny" = "allow"
const registerExplicitSkill = (id: string, content: string, location = `${runnerDirectory}/${id}.md`) =>
  Effect.gen(function* () {
    const skills = yield* Skill.Service
    const locations = yield* LocationServiceMap.Service
    const local = yield* Skill.Service.pipe(
      Effect.provide(locations.get(Location.Ref.make({ directory: runnerDirectory }), [LocationServiceMap.full])),
    )
    yield* Effect.forEach(
      [skills, local],
      (service) =>
        service.transform((draft) =>
          draft.source({
            type: "embedded",
            skill: Skill.Info.make({
              id: Skill.ID.make(id),
              name: Skill.Name.make(id),
              autoinvoke: false,
              location: AbsolutePath.make(location),
              content,
            }),
          }),
        ),
      { discard: true },
    )
  })
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
let imageAnalyzerConfig: ConfigImageAnalyzer.Info | undefined
let capabilitiesConfig: ConfigCapabilities.Info | undefined
let modelFallbacks: Config.Info["model_fallbacks"]
let catalogModel: CatalogModel.Info | undefined
let compactionWakeHook = Effect.void
let compactionSummary = false
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    diagnostics: () => Effect.succeed([]),
    reload: () => Effect.void,
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
            ...(imageAnalyzerConfig === undefined ? {} : { image_analyzer: imageAnalyzerConfig }),
            ...(capabilitiesConfig === undefined ? {} : { capabilities: capabilitiesConfig }),
            ...(modelFallbacks === undefined ? {} : { model_fallbacks: modelFallbacks }),
          }),
        }),
      ]),
  }),
)
const guardrailLayer = AppNodeBuilder.build(SessionGuardrail.node, [
  [Config.node, config],
  [Permission.node, permission],
  [Location.node, Location.boundNode({ directory: runnerDirectory })],
])
const contextState = makeGlobalNode({
  name: SessionContextState.node.name,
  layer: Layer.unwrap(Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const guardrails = yield* SessionGuardrail.Service
    const locations = yield* fixedLocations(
      (_location: Location.Ref) => Layer.succeed(SessionGuardrail.Service, guardrails) as unknown as Layer.Layer<LocationServices>,
    )
    return AppNodeBuilder.build(SessionContextState.node, [
      [Database.node, Layer.succeed(Database.Service, database)],
      [EventRuntime.node, Layer.succeed(EventRuntime.Service, events)],
      [LocationServiceMap.node, Layer.succeed(LocationServiceMap.Service, locations)],
    ])
  })).pipe(Layer.provide(guardrailLayer)),
  deps: [Database.node, EventRuntime.node],
})
const compactionExecution = makeGlobalNode({
  service: SessionCompactionExecution.Service,
  layer: Layer.effect(
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
                seq: EventRuntime.Seq.make(job.requestedThrough.seq),
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
                        seq: EventRuntime.Seq.make(job.requestedThrough.seq),
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
  ).pipe(Layer.provide(guardrailLayer)),
  deps: [Database.node, SessionCompactionJob.node, SessionContextState.node],
})
let pluginFlushHook = Effect.void
const pluginSupervisor = Layer.succeed(
  PluginSupervisor.Service,
  PluginSupervisor.Service.of({
    flush: Effect.suspend(() => pluginFlushHook),
    settled: Effect.void,
  }),
)
let defaultSelectionRef: CatalogModel.Ref | undefined
const promptCatalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    defaultSelection: () => Effect.sync(() => defaultSelectionRef),
    forConnection: (model) => Effect.succeed(model),
    get: (providerID, modelID) =>
      Effect.succeed(catalogModel?.providerID === providerID && catalogModel.id === modelID ? catalogModel : undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    small: () => Effect.succeed(undefined),
  },
})
let snapshotCapture: Snapshot.ID | undefined
const snapshotLayer = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    capture: () => Effect.sync(() => snapshotCapture),
    files: () => Effect.succeed([]),
    fingerprints: (input) => Effect.succeed(input.paths.map((path) => ({ path, digest: "missing" }))),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)
class FixtureRunner extends Context.Service<FixtureRunner, Deferred.Deferred<SessionRunner.Interface>>()("test/SessionRunner") {}
const fixtureRunner = makeGlobalNode({
  service: FixtureRunner,
  layer: Layer.effect(FixtureRunner, Deferred.make<SessionRunner.Interface>()),
  deps: [],
})
const execution = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const ready = yield* FixtureRunner
    const compactionExecution = yield* SessionCompactionExecution.Service
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
      drain: (sessionID, force) =>
        Deferred.await(ready).pipe(
          Effect.flatMap((sessionRunner) => sessionRunner.drain({ sessionID, force })),
          SessionCompactionExecution.bind(compactionExecution),
        ),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      awaitIdle: coordinator.awaitIdle,
      shutdown: coordinator.shutdown(),
      withTransition: coordinator.withTransition,
    })
  }),
  ),
  deps: [fixtureRunner, compactionExecution],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      fixtureRunner,
      Database.node,
      Job.node,
      EventRuntime.node,
      Form.node,
      SessionProjector.node,
      SessionStore.node,
      SessionProviderRequest.node,
      Agent.node,
      Catalog.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      PluginHooks.node,
      echoNode,
      SessionRunnerModel.node,
      SessionTodo.node,
      SessionAutonomy.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      InstructionEntry.node,
      SkillInstructions.node,
      Skill.node,
      LocationServiceMap.node,
      ReferenceInstructions.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionCompactionJob.node,
      SessionContextState.node,
      SessionLiveState.node,
      SessionGuardrail.node,
      SessionCompactionExecution.node,
      SessionExecution.node,
      Session.node,
      AttachmentStore.node,
      SessionContext.node,
      SessionModelRequest.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [Project.node, projects],
      [Permission.node, permission],
      [SessionGuardrail.node, guardrailLayer],
      [SessionContextState.node, contextState],
      [Catalog.node, promptCatalog],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, systemContext],
      [InstructionDiscovery.node, instructionContext],
      [Location.node, Location.boundNode({ directory: runnerDirectory })],
      [SkillInstructions.node, skillInstructions],
      [ReferenceInstructions.node, referenceInstructions],
      [Snapshot.node, snapshotLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [PluginSupervisor.node, pluginSupervisor],
      [SessionCompactionExecution.node, compactionExecution],
    ],
  ),
)
const sessionID = Session.ID.make("ses_runner_test")
const sessionAffinity = SessionModelHeaders.make(
  { id: sessionID, projectID: Project.ID.global },
  { accountIdentityDigest: "a".repeat(64) },
)["X-Session-Id"]
const otherSessionID = Session.ID.make("ses_runner_other")
const admit = (session: Session.Interface, text: string) => session.prompt({ sessionID, text, resume: false })

const insertSession = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        agent: Agent.ID.make("build"),
        directory: runnerDirectory,
        title: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* SessionContextState.initialize(db, id, Date.now())
  })

const setup = Effect.gen(function* () {
  const ready = yield* FixtureRunner
  const sessionRunner = yield* SessionRunner.Service
  yield* Deferred.succeed(ready, sessionRunner)
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
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
  defaultSelectionRef = undefined
  currentCost = []
  currentAccountIdentityDigest = "a".repeat(64)
  fallbackModels.clear()
  unavailableModels.clear()
  unavailableProfiles.clear()
  snapshotCapture = undefined
  profileDigests.clear()
  modelFallbacks = undefined
  efficiencyConfig = undefined
  imageAnalyzerConfig = undefined
  catalogModel = undefined
  compactionWakeHook = Effect.void
  compactionSummary = false
  skillBaselines.clear()
  skillAccess = "allow"
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  responseStreams = undefined
  nativeResponses = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  yield* agents.transform((draft) =>
    draft.update(Agent.ID.make("build"), (agent) => {
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
  return yield* Session.Service
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const realExecution = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const store = yield* SessionStore.Service
  const autonomy = yield* SessionAutonomy.Service
  const jobs = yield* Job.Service
  const compaction = yield* SessionCompactionExecution.Service
  const runner = yield* SessionRunner.Service
  const scope = yield* Scope.Scope
  const locations = yield* fixedLocations(
    (_ref: Location.Ref) => Layer.succeed(SessionRunner.Service, runner) as unknown as Layer.Layer<LocationServices>,
  )
  const context = yield* Layer.buildWithScope(
    SessionExecution.layer.pipe(
      Layer.provide(Layer.succeed(Database.Service, database)),
      Layer.provide(Layer.succeed(EventRuntime.Service, events)),
      Layer.provide(Layer.succeed(SessionStore.Service, store)),
      Layer.provide(Layer.succeed(SessionAutonomy.Service, autonomy)),
      Layer.provide(Layer.succeed(Job.Service, jobs)),
      Layer.provide(Layer.succeed(SessionCompactionExecution.Service, compaction)),
      Layer.provide(Layer.succeed(LocationServiceMap.Service, locations)),
      Layer.provide(LayerNode.compile(AppProcess.node)),
    ),
    scope,
  )
  return Context.get(context, SessionExecution.Service)
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

const bareInvalidPrompt = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: classifyProviderFailure({
      code: "invalid_prompt",
      message: "invalid_prompt: The prompt is invalid.",
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

const recordedEventTypes = (id: Session.ID) =>
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

const recordedStepSettlementEvents = (id: Session.ID, assistantMessageID: SessionMessage.ID) =>
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

const sessionStateNotice = {
  type: "system",
  metadata: { contextSource: "session-state" },
  text: expect.stringContaining("Authoritative current Session state (JSON):"),
}

const replaySessionProjection = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
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
      readonly state:
        | { readonly status: "streaming"; readonly input: string }
        | { readonly status: "error"; readonly error: { readonly type: string } }
    }

type FragmentFixture = {
  readonly delta: EventRuntime.Definition
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
    const events = yield* EventRuntime.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    const completed =
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
    if (kind === "tool input") responses = [completed, reply.text("Recovered", "text-tool-input-recovery")]
    else response = completed

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventRuntime.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    const expectedContent: FragmentExpectedContent =
      fixture.expectedContent.type === "tool"
        ? {
            type: "tool",
            id: fixture.expectedContent.id,
            state: { status: "error", error: { type: "tool.input-json" } },
          }
        : fixture.expectedContent
    expect(
      requireAssistant(yield* session.context(sessionID)).content.find(
        (content) => content.type === expectedContent.type,
      ),
    ).toMatchObject(expectedContent)

    yield* replaySessionProjection(sessionID)

    expect(
      requireAssistant(yield* session.context(sessionID)).content.find(
        (content) => content.type === expectedContent.type,
      ),
    ).toMatchObject(expectedContent)
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
      sessionStateNotice,
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
      sessionStateNotice,
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
  it.effect("does not report throughput for a single received chunk", () =>
    Effect.gen(function* () {
      const session = yield* setup
      response = reply.text("single chunk", "single-chunk")
      yield* admit(session, "Respond")
      yield* session.resume(sessionID)
      expect((yield* session.diagnostics(sessionID))?.generationSpeed?.latest).toBeUndefined()
      const tracker = yield* SessionProviderRequest.Service
      expect((yield* tracker.list(sessionID)).at(-1)?.timing?.receivedOutput).toBeUndefined()
    }),
  )

  it.effect("clears live generation when interrupted during the initial placeholder", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const ledger = yield* SessionProviderRequest.Service
      const placeholder = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) => Effect.gen(function* () {
        if (event.type !== SessionEvent.DiagnosticsUpdated.type) return
        const data = (event as EventRuntime.Payload<typeof SessionEvent.DiagnosticsUpdated>).data
        if (data.sessionID !== sessionID || !data.diagnostics.generationSpeed?.live) return
        if (yield* Deferred.isDone(placeholder)) return
        yield* Deferred.succeed(placeholder, undefined)
        yield* Effect.never
      }))
      responseStream = Stream.never
      yield* admit(session, "Interrupt before provider output")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(placeholder)
      expect((yield* ledger.generation(sessionID))?.live).toMatchObject({ attempt: 1 })
      expect((yield* session.snapshot(sessionID)).generationSpeed?.live).toMatchObject({ attempt: 1 })
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(yield* ledger.generation(sessionID)).toBeUndefined()
      expect((yield* ledger.activeRequests).filter((request) => request.sessionID === sessionID)).toEqual([])
      expect((yield* ledger.recentSteps(sessionID)).at(-1)?.timing?.receivedOutput).toBeUndefined()
      const snapshot = yield* session.snapshot(sessionID)
      expect(snapshot.generationSpeed?.live).toBeUndefined()
      expect(snapshot.generationSpeed?.latest).toBeUndefined()
      expect(snapshot.generationSpeed?.recent).toEqual([])
      expect((yield* session.diagnostics(sessionID))?.generationSpeed?.live).toBeUndefined()
      yield* unsubscribe
    }),
  )

  it.effect(
    "uses a coordination message's model override on its first request and restores defaults for a later human input",
    () =>
      Effect.gen(function* () {
        const session = yield* setup
        const { db } = yield* Database.Service
        const original = CatalogModel.Ref.make({
          providerID: Provider.ID.make("fake"),
          id: CatalogModel.ID.make("fake-model"),
          variant: CatalogModel.VariantID.make("low"),
        })
        const override = CatalogModel.Ref.make({
          providerID: Provider.ID.make("fake"),
          id: CatalogModel.ID.make("replacement"),
          variant: CatalogModel.VariantID.make("high"),
        })
        yield* db
          .update(SessionTable)
          .set({ agent: Agent.ID.make("build"), model: original })
          .where(eq(SessionTable.id, sessionID))
          .run()
        const events = yield* EventRuntime.Service
        const inputID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.InputAdmitted, {
          sessionID,
          inputID,
          input: {
            type: "user",
            delivery: "steer",
            data: {
              text: "Do the assigned work",
              metadata: {
                inputOrigin: "coordination",
                coordination: {
                  groupID: "cgrp_runner",
                  senderSessionID: "ses_master",
                  messageID: inputID,
                  model: override,
                },
              },
            },
          },
        })
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(1)
        expect(String(requests[0]?.model.id)).toBe("replacement")
        const first = (yield* session.messages({ sessionID })).find((message) => message.type === "assistant")
        expect(first).toMatchObject({ agent: "build", model: override })
        expect(yield* session.get(sessionID)).toMatchObject({ agent: "build", model: original })
        yield* session.prompt({ sessionID, text: "Now do my separate request", resume: false })
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(2)
        expect(String(requests[1]?.model.id)).toBe("fake-model")
        const last = (yield* session.messages({ sessionID, order: "desc" })).find(
          (message) => message.type === "assistant",
        )
        expect(last).toMatchObject({ agent: "build", model: original })
        expect(yield* session.get(sessionID)).toMatchObject({ agent: "build", model: original })
      }),
  )

  it.effect("loads every explicit skill in one prompt before the first model request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* registerExplicitSkill("first-audit", "Inspect the first boundary.")
      yield* registerExplicitSkill("second-audit", "Inspect the second boundary.")
      yield* registerExplicitSkill("third-audit", "Inspect the third boundary.")
      const input = yield* session.prompt({
        sessionID,
        text: "Use $first-audit $second-audit $third-audit $first-audit, then report.",
        resume: false,
      })
      expect(input.data.metadata).toMatchObject({
        skills: [{ id: "first-audit" }, { id: "second-audit" }, { id: "third-audit" }],
      })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      const prompt = JSON.stringify(requests[0]!.messages)
      expect(prompt).toContain("Inspect the first boundary.")
      expect(prompt).toContain("Inspect the second boundary.")
      expect(prompt).toContain("Inspect the third boundary.")
      expect(
        (yield* session.context(sessionID)).flatMap((message) => (message.type === "skill" ? [message.skill] : [])),
      ).toEqual(["first-audit", "second-audit", "third-audit"].map((id) => Skill.ID.make(id)))
    }),
  )

  it.effect("loads explicit skill instructions before the first model request without a tool decision", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* registerExplicitSkill("explicit-audit", "Inspect every changed boundary before implementation.")
      const input = yield* session.prompt({ sessionID, text: "Use $explicit-audit, then report", resume: false })
      expect(input.data.metadata).toMatchObject({ skills: [{ id: "explicit-audit", name: "explicit-audit" }] })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0]!.messages)).toContain("Inspect every changed boundary before implementation.")
      expect((yield* session.context(sessionID)).filter((message) => message.type === "skill")).toHaveLength(1)
      yield* session.prompt({ sessionID, id: input.id, text: "A retry cannot replace $another-skill", resume: false })
      yield* session.prompt({ sessionID, text: "$explicit-audit again", resume: false })
      yield* session.resume(sessionID)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "skill")).toHaveLength(1)
    }),
  )

  it.effect("loads an explicit skill with its identity, base directory, and supporting files", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), "ycoding-explicit-skill-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      )
      const checklist = path.join(directory, "references", "checklist.md")
      yield* Effect.promise(async () => {
        await mkdir(path.dirname(checklist))
        await writeFile(
          path.join(directory, "SKILL.md"),
          "---\nname: directory-audit\n---\nRead references/checklist.md first.\n",
        )
        await writeFile(checklist, "1. Measure before changing code.\n")
      })
      yield* registerExplicitSkill(
        "directory-audit",
        "Read references/checklist.md first.",
        path.join(directory, "SKILL.md"),
      )
      yield* session.prompt({ sessionID, text: "Use $directory-audit now", resume: false })
      yield* session.resume(sessionID)
      const skill = (yield* session.context(sessionID)).find(
        (message): message is Extract<SessionMessage.Info, { type: "skill" }> => message.type === "skill",
      )
      expect(skill?.text).toContain('<skill_content name="directory-audit">')
      expect(skill?.text).toContain("Read references/checklist.md first.")
      expect(skill?.text).toContain(`Base directory for this skill: ${directory}`)
      expect(skill?.text).toContain(`<file>${checklist}</file>`)
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0]!.messages)).toContain(`Base directory for this skill: ${directory}`)
      const order = (messages: ReadonlyArray<SessionMessage.Info>) =>
        messages.flatMap((message) => (message.type === "user" || message.type === "skill" ? [message.type] : []))
      expect(order(yield* session.context(sessionID))).toEqual(["user", "skill"])
      expect(order(yield* session.messages({ sessionID, order: "asc" }))).toEqual(["user", "skill"])
      const prompt = JSON.stringify(requests[0]!.messages)
      expect(prompt.indexOf("Use $directory-audit now")).toBeLessThan(
        prompt.indexOf('<skill_content name=\\"directory-audit\\">'),
      )
    }),
  )

  it.effect("does not duplicate client preactivation and reactivates after an agent switch", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* registerExplicitSkill("client-audit", "Client audit full instructions")
      yield* session.skill({ sessionID, skill: Skill.ID.make("client-audit"), resume: false })
      yield* session.prompt({ sessionID, text: "$client-audit", resume: false })
      yield* session.resume(sessionID)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "skill")).toHaveLength(1)
      yield* session.switchAgent({ sessionID, agent: Agent.ID.make("build") })
      yield* session.prompt({ sessionID, text: "$client-audit", resume: false })
      yield* session.resume(sessionID)
      const messages = yield* session.context(sessionID)
      expect(messages.filter((message) => message.type === "skill")).toHaveLength(2)
      expect(messages.findLastIndex((message) => message.type === "skill")).toBeGreaterThan(
        messages.findLastIndex((message) => message.type === "agent-switched"),
      )
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Client audit full instructions")
    }),
  )

  it.effect("rejects denied explicit skills without activating them or starting a model request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* registerExplicitSkill("denied-audit", "Denied audit instructions")
      skillAccess = "deny"
      const input = yield* session.prompt({
        sessionID,
        text: "Audit this change",
        resume: false,
        metadata: { skills: [{ id: "denied-audit", name: "Denied audit" }] },
      })
      const error = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(error).toMatchObject({
        error: { type: "permission.rejected", message: "Permission denied: skill (denied-audit)" },
      })
      expect(requests).toEqual([])
      expect((yield* session.pending(sessionID)).map((pending) => pending.id)).toEqual([input.id])
      expect((yield* session.context(sessionID)).filter((message) => message.type === "skill")).toEqual([])
    }),
  )

  it.effect("reactivates a requested skill after completed compaction without restoring other skills", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* registerExplicitSkill("compacted-audit", "Compacted audit full instructions")
      yield* registerExplicitSkill("other-audit", "Other audit instructions")
      yield* session.prompt({ sessionID, text: "$compacted-audit $other-audit", resume: false })
      yield* session.resume(sessionID)
      compactionSummary = true
      yield* session.compact({ sessionID })
      yield* session.prompt({ sessionID, text: "$compacted-audit", resume: false })
      yield* session.resume(sessionID)
      const messages = yield* session.context(sessionID)
      const compaction = messages.findLastIndex(
        (message) => message.type === "compaction" && message.status === "completed",
      )
      expect(compaction).toBeGreaterThanOrEqual(0)
      expect(
        messages
          .slice(compaction + 1)
          .filter((message) => message.type === "skill")
          .map((message) => message.skill),
      ).toEqual([Skill.ID.make("compacted-audit")])
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Compacted audit full instructions")
      expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("Other audit instructions")
    }),
  )

  const compactedConversation = (session: Session.Interface, image = false) =>
    Effect.gen(function* () {
      responses = [
        reply.text("First answer", "text-first"),
        reply.text("Second answer", "text-second"),
        reply.text("Third answer", "text-third"),
      ]
      yield* admit(session, "First user request")
      yield* session.resume(sessionID)
      yield* admit(session, "Second user request")
      yield* session.resume(sessionID)
      if (image) {
        const events = yield* EventRuntime.Service
        const boundary = (yield* session.messages({ sessionID, order: "desc", limit: 1 }))[0]
        yield* events.publish(SessionEvent.Execution.Started, { sessionID })
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          sessionID,
          assistantMessageID: boundary.id,
          callID: "boundary-image",
          name: "snapshot",
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID,
          assistantMessageID: boundary.id,
          callID: "boundary-image",
          input: {},
          executed: true,
        })
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID: boundary.id,
          callID: "boundary-image",
          structured: {},
          executed: true,
          content: [{ type: "file", mime: "image/png", uri: `data:image/png;base64,${onePixelPng}` }],
        })
        yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
      }
      compactionSummary = true
      yield* session.compact({ sessionID })
    })

  it.effect("prunes compacted history without changing the next provider request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      yield* compactedConversation(session)
      const context = yield* SessionContext.Service
      const modelRequests = yield* SessionModelRequest.Service
      const nextRequest = Effect.gen(function* () {
        const loaded = yield* context.load(yield* context.select(sessionID))
        return JSON.stringify((yield* modelRequests.prepare({ context: loaded, step: 1 })).request)
      })
      const unpruned = yield* nextRequest
      expect(unpruned).toContain("conversation-checkpoint")
      expect(unpruned).not.toContain("First answer")

      const pruned = yield* SessionHistoryPruning.make(db, Effect.succeed(new Set())).prune(sessionID)
      expect(pruned.messages).toBeGreaterThan(0)
      expect(yield* nextRequest).toBe(unpruned)

      yield* admit(session, "Third user request")
      yield* session.resume(sessionID)
      const sent = JSON.stringify(requests.at(-1)!.messages)
      expect(sent).toContain("conversation-checkpoint")
      expect(sent).toContain("Third user request")
      expect(sent).not.toContain("First answer")
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.execution.failed.1")
    }),
  )

  it.effect("preserves an image checkpoint boundary and rebuilds the next request byte-identically after pruning", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      yield* compactedConversation(session, true)
      const checkpoint = yield* SessionContextState.checkpoint(db, sessionID)
      expect(checkpoint).toBeDefined()
      const boundary = () =>
        db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, checkpoint!.coveredThrough.messageID))
          .get()
          .pipe(Effect.orDie)
      const originalBoundary = yield* boundary()
      expect(JSON.stringify(originalBoundary)).toContain(onePixelPng)
      const context = yield* SessionContext.Service
      const modelRequests = yield* SessionModelRequest.Service
      const nextRequest = Effect.gen(function* () {
        const loaded = yield* context.load(yield* context.select(sessionID))
        return JSON.stringify((yield* modelRequests.prepare({ context: loaded, step: 1 })).request)
      })
      const before = yield* nextRequest
      expect(before).toContain("conversation-checkpoint")
      yield* TestClock.adjust(SessionHistoryPruning.IMAGE_IDLE)
      const pruned = yield* SessionHistoryPruning.make(db, Effect.succeed(new Set())).prune(sessionID)
      expect(pruned.messages).toBeGreaterThan(0)
      expect(pruned.events).toBeGreaterThan(0)
      expect(pruned.images).toBe(0)
      expect(yield* SessionContextState.checkpoint(db, sessionID)).toEqual(checkpoint)
      expect(yield* boundary()).toEqual(originalBoundary)
      expect(yield* nextRequest).toBe(before)
      yield* admit(session, "Third user request")
      yield* session.resume(sessionID)
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain("conversation-checkpoint")
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.execution.failed.1")
    }),
  )

  it.effect("prunes a settled execution without changing the continuation request or its provider state", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      const execution = yield* realExecution
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_state: "stateless" })
      yield* admit(session, "Use private provider state")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({
          id: "settled-reasoning",
          providerMetadata: { openai: { signature: "sig_settled" } },
        }),
        LLMEvent.reasoningDelta({
          id: "settled-reasoning",
          text: "Private thought",
          providerMetadata: {
            openai: {
              signature: "sig_settled",
              opaqueCompactionItem: { type: "compaction", id: "cmp_reasoning", encrypted_content: "reasoning-secret" },
            },
          },
        }),
        LLMEvent.reasoningEnd({ id: "settled-reasoning", providerMetadata: { openai: { signature: "sig_settled" } } }),
        LLMEvent.toolCall({
          id: "settled-tool",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: {
            openai: {
              itemId: "settled-tool",
              opaqueCompactionItem: { type: "compaction", id: "cmp_tool_call", encrypted_content: "tool-call-secret" },
            },
          },
        }),
        LLMEvent.toolResult({
          id: "settled-tool",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: {
            openai: {
              blockType: "web_search_tool_result",
              opaqueCompactionItem: {
                type: "compaction",
                id: "cmp_tool_result",
                encrypted_content: "tool-result-secret",
              },
            },
          },
        }),
        LLMEvent.textStart({ id: "settled-answer" }),
        LLMEvent.textDelta({ id: "settled-answer", text: "Done" }),
        LLMEvent.textEnd({ id: "settled-answer" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* execution.resume(sessionID)
      const context = yield* SessionContext.Service
      const modelRequests = yield* SessionModelRequest.Service
      const nextRequest = Effect.gen(function* () {
        const loaded = yield* context.load(yield* context.select(sessionID))
        return JSON.stringify((yield* modelRequests.prepare({ context: loaded, step: 1 })).request)
      })
      const unpruned = yield* nextRequest
      for (const secret of ["reasoning-secret", "tool-call-secret", "tool-result-secret", "sig_settled"])
        expect(unpruned).toContain(secret)
      const before = yield* recordedEventTypes(sessionID)
      expect(before).toEqual(
        expect.arrayContaining([
          "session.reasoning.ended.1",
          "session.tool.called.1",
          "session.tool.success.1",
          "session.provider.request.recorded.1",
        ]),
      )

      yield* TestClock.adjust(SessionHistoryPruning.SETTLED_GRACE)
      const pruned = yield* SessionHistoryPruning.make(db, execution.active).prune(sessionID)
      expect(pruned.events).toBeGreaterThan(0)
      const after = yield* recordedEventTypes(sessionID)
      for (const type of [
        "session.reasoning.started.1",
        "session.reasoning.ended.1",
        "session.text.ended.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.provider.request.recorded.1",
      ])
        expect(after).not.toContain(type)
      expect(after).toContain("session.execution.succeeded.1")
      expect(yield* nextRequest).toBe(unpruned)

      yield* admit(session, "Continue with private state")
      response = reply.text("Continued", "settled-continued")
      yield* execution.resume(sessionID)
      const sent = JSON.stringify(requests.at(-1)!.messages)
      for (const secret of [
        "reasoning-secret",
        "tool-call-secret",
        "tool-result-secret",
        "Continue with private state",
      ])
        expect(sent).toContain(secret)
    }),
  )

  it.effect("skips a running session and prunes it after the run settles without failing execution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      const execution = yield* SessionExecution.Service
      yield* compactedConversation(session)
      const pruning = SessionHistoryPruning.make(db, execution.active)
      yield* admit(session, "Third user request")
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      expect(yield* pruning.prune(sessionID)).toEqual({ messages: 0, events: 0, images: 0 })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(running)
      expect((yield* pruning.prune(sessionID)).messages).toBeGreaterThan(0)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.execution.failed.1")
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Third user request")
      expect((yield* session.messages({ sessionID, order: "desc", limit: 1 }))[0]).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "Third answer" }],
      })
    }),
  )

  it.effect("keeps requested skill content in the first request after mandatory history compaction", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      yield* registerExplicitSkill("mandatory-audit", "Mandatory audit full instructions")
      currentModel = Model.make({
        id: "history-recovery",
        provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: 7_000, output: 500 } }),
      })
      compactionSummary = true
      yield* session.prompt({ sessionID, text: "$mandatory-audit continue after history", resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).toContain("session.compaction.admitted.2")
      expect(JSON.stringify(requests[0]!.messages)).toContain("Mandatory audit full instructions")
    }),
  )

  it.effect("keeps queued skill activation at its own idle promotion boundary", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* registerExplicitSkill("queue-audit", "Queued audit instructions")
      yield* session.prompt({
        sessionID,
        text: "Audit when idle",
        delivery: "queue",
        resume: false,
        metadata: { skills: [{ id: "queue-audit", name: "Queued audit" }] },
      })
      yield* session.prompt({ sessionID, text: "Steer first", resume: false })
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[0]!.messages)).not.toContain("Queued audit instructions")
      expect(JSON.stringify(requests[1]!.messages)).toContain("Queued audit instructions")
    }),
  )

  it.effect("fails an unavailable explicitly selected skill before promotion or model execution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const input = yield* session.prompt({
        sessionID,
        text: "Audit this change",
        resume: false,
        metadata: { skills: [{ id: "unavailable-audit", name: "Unavailable audit" }] },
      })
      const error = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(error.message).toContain("unavailable-audit")
      expect(requests).toEqual([])
      expect((yield* session.pending(sessionID)).map((pending) => pending.id)).toEqual([input.id])
      expect((yield* session.context(sessionID)).filter((message) => message.type === "skill")).toEqual([])
    }),
  )

  for (const delivery of ["steer", "queue"] as const)
    it.effect(`loads a metadata-only skill ${delivery} only at its active drain promotion boundary`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        yield* registerExplicitSkill("safe-audit", "Safe boundary audit instructions")
        yield* admit(session, "Start ordinary work")
        responses = [
          reply.tool("call-before-skill", "echo", { text: "ordinary work" }),
          reply.text("Ordinary continuation", "text-ordinary"),
          reply.text("Skill response", "text-skill"),
        ]
        streamGate = yield* Deferred.make<void>()
        streamStarted = yield* Deferred.make<void>()
        const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
        yield* Deferred.await(streamStarted)
        yield* session.prompt({
          sessionID,
          text: "Audit this change",
          delivery,
          metadata: { skills: [{ id: "safe-audit", name: "Safe audit" }] },
        })
        expect((yield* session.context(sessionID)).filter((message) => message.type === "skill")).toEqual([])
        expect(JSON.stringify(requests[0]!.messages)).not.toContain("Safe boundary audit instructions")
        yield* Deferred.succeed(streamGate, undefined)
        yield* Fiber.join(running)
        expect(requests).toHaveLength(delivery === "queue" ? 3 : 2)
        if (delivery === "queue")
          expect(JSON.stringify(requests[1]!.messages)).not.toContain("Safe boundary audit instructions")
        expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Safe boundary audit instructions")
        expect((yield* session.context(sessionID)).filter((message) => message.type === "skill")).toHaveLength(1)
      }),
    )

  it.effect("accepts verified work through the real runner, tool settlement and execution coordinator", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* registerToolPlugin(TaskCompleteTool.Plugin)
      const database = yield* Database.Service
      const execution = yield* realExecution
      responses = [
        reply.tool("call-work-complete", "task_complete", {}),
        reply.text("Implemented and verified.", "work-final"),
      ]
      const input = yield* session.prompt({ sessionID, text: "Implement and verify the accepted work", resume: false })
      yield* execution.resume(sessionID)
      expect(requests).toHaveLength(2)
      const history = yield* database.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const completed = history.filter((event) => event.type === "session.work.completed.1")
      expect(completed).toHaveLength(1)
      const final = history.findLast((event) => event.type === "session.step.ended.1")!
      expect(completed[0].data).toEqual({
        sessionID,
        inputID: input.id,
        assistantMessageID: final.data.assistantMessageID,
      })
      expect(completed[0].seq).toBeGreaterThan(final.seq)
      expect(completed[0].seq).toBeGreaterThan(
        history.findLast((event) => event.type === "session.execution.succeeded.1")!.seq,
      )
      const declaration = history.find((event) => event.type === "session.tool.success.1")!
      expect(declaration.data.structured).toEqual({ recorded: true })
      expect(declaration.data.executed).toBe(false)
      expect(
        history.some(
          (event) => event.type === "session.text.ended.1" && event.data.text === "Implemented and verified.",
        ),
      ).toBe(true)
      expect((yield* session.completions({ limit: 200 })).data).toHaveLength(1)
      expect([...(yield* execution.active)]).toEqual([])
    }),
  )
  it.effect("does not read full message payloads for observation deduplication", () =>
    Effect.gen(function* () {
      const session = yield* setup
      response = reply.text("Complete answer", "payload-read")
      yield* admit(session, "Preserve the complete prompt")
      const runner = yield* SessionRunner.Service
      const queries: string[] = []
      yield* runner.drain({ sessionID, force: true }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            queries.push(statement.compile()[0])
            return statement
          }),
        ),
      )
      const payloadReads = queries.filter(
        (query) =>
          query.startsWith("select ") &&
          query.includes('from "session_message"') &&
          query.slice(0, query.indexOf(" from ")).includes('"data"') &&
          query.endsWith('order by "session_message"."seq" asc') &&
          !query.includes('"type" in') &&
          !query.includes(" limit "),
      )
      expect(payloadReads).toHaveLength(2)
      expect(requests).toHaveLength(1)
      expect(requests[0].messages).toMatchObject([
        { role: "user", content: [{ type: "text", text: "Preserve the complete prompt" }] },
        {
          role: "system",
          content: [{ type: "text", text: expect.stringContaining("Authoritative current Session state") }],
        },
      ])
    }),
  )

  it.effect("bounds observation deduplication pages and finds trusted values behind forged latest candidates", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const db = (yield* Database.Service).db
      const live = yield* SessionLiveState.Service
      const state = yield* live.load(sessionID)
      const sources = ["session-state", "team-view", "step-limit"] as const
      const latest = [state.text, renderTeamObservation([]).text, MAX_STEPS_RESET_PROMPT]
      const observations = Array.from({ length: 1253 }, (_, index) => {
        const source = index < 1003 ? sources[index % 3] : "team-view"
        const text =
          index >= 1000 && index < 1003 ? latest[index % 3] : `Distinct observation ${index}: ${"x".repeat(2048)}`
        return { source, text }
      })
      const rows = observations.map((observation, index) => {
        return {
          id: SessionMessage.ID.make(`msg_many_observation_${index}`),
          session_id: sessionID,
          type: observation.source === "team-view" ? ("synthetic" as const) : ("system" as const),
          seq: 1000 + index,
          time_created: index,
          time_updated: index,
          data: observationMessageData({
            id: SessionMessage.ID.make(`msg_many_observation_${index}`),
            type: observation.source === "team-view" ? "synthetic" : "system",
            text: observation.text,
            metadata: { contextSource: observation.source },
            ...(observation.source === "team-view" ? { description: "TeamView update" } : {}),
            time: { created: index },
          }),
        }
      })
      yield* EventRuntime.reserveSequence(db, sessionID, rows.at(-1)!.seq)
      for (let offset = 0; offset < rows.length; offset += 50) {
        yield* db
          .insert(SessionMessageTable)
          .values(rows.slice(offset, offset + 50))
          .run()
        if (offset < 1003)
          yield* db
            .insert(EventTable)
            .values(
              rows.slice(offset, Math.min(offset + 50, 1003)).map((row) => ({
                id: EventRuntime.ID.make(String(row.id).replace(/^msg_/, "evt_")),
                aggregate_id: sessionID,
                seq: row.seq,
                created: row.time_created,
                type: EventRuntime.versionedType(
                  SessionEvent.ContextObserved.type,
                  SessionEvent.ContextObserved.durable.version,
                ),
                data: {
                  sessionID,
                  source: observations[row.seq - 1000].source,
                  text: observations[row.seq - 1000].text,
                },
              })),
            )
            .run()
      }
      response = reply.text("Complete answer", "many-observations")
      yield* admit(session, "Keep every historical observation in model context")
      const queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []
      const runner = yield* SessionRunner.Service
      yield* runner.drain({ sessionID, force: true }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            const [sql, params] = statement.compile()
            queries.push({ sql, params })
            return statement
          }),
        ),
      )
      const pages = queries.filter(
        (query) =>
          query.sql.includes('from "session_message"') &&
          query.sql.includes('"type" in') &&
          query.sql.slice(0, query.sql.indexOf(" from ")).includes('"data"'),
      )
      expect(pages).toHaveLength(3)
      expect(
        pages.every(
          (query) => query.sql.includes('order by "session_message"."seq" desc limit ?') && query.params.at(-1) === 100,
        ),
      ).toBe(true)
      const trust = queries.filter(
        (query) => query.sql.includes('from "event"') && query.sql.includes('"event"."id" in'),
      )
      expect(trust.every((query) => query.params.length <= 102)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0].messages)).toContain(observations[0].text)
      expect(JSON.stringify(requests[0].messages)).toContain(observations.at(-1)!.text)
      expect(
        (yield* session.context(sessionID)).filter((message) => message.metadata?.contextSource !== undefined),
      ).toHaveLength(rows.length)
      yield* db.run(sql`UPDATE session_message SET data = json_set(data, '$.text', 1) WHERE id = ${rows[0].id}`)
      yield* admit(session, "Reject corrupt historical context before contacting the model")
      expect(Exit.isFailure(yield* runner.drain({ sessionID, force: true }).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("retains delivered Session state as visible append-only history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      response = reply.text("First answer", "state-first")
      yield* admit(session, "First prompt")
      yield* session.resume(sessionID)

      const first = requests[0]!
      expect(first.messages.some((message) => message.volatile === true)).toBe(false)
      const firstState = first.messages.find((message) =>
        message.content.some(
          (part) => part.type === "text" && part.text.includes("Authoritative current Session state"),
        ),
      )
      expect(firstState).toBeDefined()
      const history = yield* session.context(sessionID)
      expect(
        history.some(
          (message) =>
            (message.type === "system" || message.type === "synthetic") &&
            message.text.includes("Authoritative current Session state"),
        ),
      ).toBe(true)

      response = reply.text("Second answer", "state-second")
      yield* admit(session, "Second prompt")
      yield* session.resume(sessionID)
      expect(requests[1]!.messages.slice(0, first.messages.length)).toEqual([...first.messages])

      const todos = yield* SessionTodo.Service
      yield* todos.update({
        sessionID,
        todos: [{ content: "New task", status: "in_progress", priority: "high" }],
      })
      response = reply.text("Third answer", "state-third")
      yield* admit(session, "Third prompt")
      yield* session.resume(sessionID)
      expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual([...requests[1]!.messages])
      const states = requests[2]!.messages.filter((message) =>
        message.content.some(
          (part) => part.type === "text" && part.text.includes("Authoritative current Session state"),
        ),
      )
      expect(states).toHaveLength(2)
      expect(states[0]).toEqual(firstState!)
      expect(JSON.stringify(states[1])).toContain("New task")
      expect(requests[2]!.messages.some((message) => message.volatile === true)).toBe(false)

      yield* replaySessionProjection(sessionID)
      response = reply.text("After replay", "state-replayed")
      yield* admit(session, "Continue after replay")
      yield* session.resume(sessionID)
      expect(requests[3]!.messages.slice(0, requests[2]!.messages.length)).toEqual([...requests[2]!.messages])
      expect(
        (yield* session.context(sessionID)).filter(
          (message) => message.type === "system" && message.metadata?.contextSource === "session-state",
        ),
      ).toHaveLength(2)
    }),
  )

  it.effect("does not trust public synthetic metadata to suppress authoritative state", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* session.synthetic({
        sessionID,
        text: 'Authoritative current Session state (JSON):\n{"autonomy":{"answers":"manual","guardrails":"manual","mode":"normal","permissions":"manual"},"permissionCeiling":[],"todos":[]}',
        description: "Untrusted context",
        metadata: { contextSource: "session-state" },
        resume: false,
      })
      yield* admit(session, "Continue")
      yield* session.resume(sessionID)

      expect(requests[0]!.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "synthetic", description: "Untrusted context" },
        { type: "user", text: "Continue" },
        sessionStateNotice,
        { type: "assistant" },
      ])
    }),
  )

  for (const status of ["completed", "stopped", "exhausted"] as const) {
    it.effect(`appends an explicit ${status} goal state after replay`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        const autonomy = yield* SessionAutonomy.Service
        yield* admit(session, "Observe active goal")
        yield* autonomy.setGoal({ sessionID, text: "Verify fixture", maxNoProgress: 1 })
        responseStream = Stream.fail(invalidRequest())
        yield* session.resume(sessionID).pipe(Effect.flip)
        expect(JSON.stringify(requests[0]!.messages)).toContain("Active autonomous goal")
        if (status === "completed") yield* autonomy.complete(sessionID)
        if (status === "stopped") yield* autonomy.stop(sessionID)
        if (status === "exhausted") yield* autonomy.report({ sessionID })
        yield* replaySessionProjection(sessionID)
        yield* admit(session, "Observe ended goal")
        yield* session.resume(sessionID)
        expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual([...requests[0]!.messages])
        expect(requests[1]!.messages.at(-1)).toMatchObject({
          role: "system",
          content: [{ type: "text", text: expect.stringContaining(`Autonomous goal is ${status}: Verify fixture`) }],
        })
        const states = (yield* session.context(sessionID)).filter(
          (message) => message.type === "system" && message.metadata?.contextSource === "session-state",
        )
        expect(states).toHaveLength(2)
        yield* admit(session, "Observe unchanged ended goal")
        yield* session.resume(sessionID)
        expect(
          (yield* session.context(sessionID)).filter(
            (message) => message.type === "system" && message.metadata?.contextSource === "session-state",
          ),
        ).toEqual(states)
      }),
    )
  }

  it.effect("retains TeamView lifecycle updates and clears deleted children once", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const db = (yield* Database.Service).db
      const teamMessages = (request: LLMRequest) =>
        request.messages.filter((message) =>
          message.content.some(
            (part) => part.type === "text" && part.text.startsWith("Internal orchestration context (JSON)."),
          ),
        )
      yield* admit(session, "Before children")
      yield* session.resume(sessionID)
      expect(teamMessages(requests[0]!)).toHaveLength(0)

      yield* insertSession(otherSessionID)
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: otherSessionID,
        change: {
          type: "launched",
          parentID: sessionID,
          parentAssistantMessageID: requireAssistant(yield* session.context(sessionID)).id,
          toolCallID: "call-team-fixture",
          inputID: SessionMessage.ID.make("msg_team_input"),
          description: "Review fixture",
          agent: Agent.ID.make("build"),
          model: { id: CatalogModel.ID.make("fake-model"), providerID: Provider.ID.make("fake") },
          promptDigest: "fixture-digest",
          background: true,
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.Task.Updated, { sessionID: otherSessionID, change: { type: "started" } })
      yield* admit(session, "Observe child")
      yield* session.resume(sessionID)
      const firstTeam = teamMessages(requests[1]!)[0]!
      expect(firstTeam).toMatchObject({ role: "user" })
      expect(firstTeam.volatile).not.toBe(true)
      expect(JSON.stringify(firstTeam.content)).toContain('\\"state\\":\\"running\\"')
      const forked = yield* session.fork({ sessionID })

      yield* replaySessionProjection(sessionID)
      yield* admit(session, "Observe unchanged child after replay")
      yield* session.resume(sessionID)
      expect(teamMessages(requests[2]!)).toEqual([firstTeam])

      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: otherSessionID,
        change: { type: "progressed", progress: { text: "Checked fixture", time: 1 } },
      })
      yield* admit(session, "Observe progress")
      yield* session.resume(sessionID)
      expect(JSON.stringify(requests[3]!.messages.at(-1)?.content)).toContain("Checked fixture")

      yield* events.publish(SessionEvent.Task.Updated, { sessionID: otherSessionID, change: { type: "completed" } })
      yield* admit(session, "Observe completion")
      yield* session.resume(sessionID)
      expect(JSON.stringify(requests[4]!.messages.at(-1)?.content)).toContain('\\"state\\":\\"completed\\"')
      expect(requests[4]!.messages.slice(0, requests[3]!.messages.length)).toEqual([...requests[3]!.messages])

      yield* db.delete(SessionTable).where(eq(SessionTable.id, otherSessionID)).run().pipe(Effect.orDie)
      yield* admit(session, "Observe removal")
      yield* session.resume(sessionID)
      const cleared = requests[5]!.messages.at(-1)!
      expect(cleared).toMatchObject({ role: "user" })
      expect(JSON.stringify(cleared.content)).toContain('\\"children\\":[]')
      yield* admit(session, "Observe unchanged empty team")
      yield* session.resume(sessionID)
      expect(teamMessages(requests[6]!)).toHaveLength(4)
      expect(requests[6]!.messages.slice(0, requests[5]!.messages.length)).toEqual([...requests[5]!.messages])
      expect(
        (yield* session.context(sessionID)).filter(
          (message) => message.type === "synthetic" && message.description === "TeamView update",
        ),
      ).toHaveLength(4)

      yield* session.prompt({ sessionID: forked.id, text: "Observe inherited team", resume: false })
      yield* session.resume(forked.id)
      const inherited = teamMessages(requests[7]!)
      expect(inherited).toHaveLength(2)
      expect(inherited[0]!.content).toEqual(firstTeam.content)
      expect(inherited[1]!.content).toEqual(cleared.content)
      yield* session.prompt({ sessionID: forked.id, text: "Observe unchanged fork", resume: false })
      yield* session.resume(forked.id)
      expect(teamMessages(requests[8]!)).toEqual(inherited)
    }),
  )

  it.effect("does not append TeamView observations for repeated progress metadata", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const db = (yield* Database.Service).db
      yield* admit(session, "Start review")
      yield* session.resume(sessionID)
      yield* insertSession(otherSessionID)
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: otherSessionID,
        change: {
          type: "launched",
          parentID: sessionID,
          parentAssistantMessageID: requireAssistant(yield* session.context(sessionID)).id,
          toolCallID: "call-team-churn",
          inputID: SessionMessage.ID.make("msg_team_churn"),
          description: "Review fixture",
          agent: Agent.ID.make("build"),
          model: { id: CatalogModel.ID.make("fake-model"), providerID: Provider.ID.make("fake") },
          promptDigest: "fixture-digest",
          background: true,
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.Task.Updated, { sessionID: otherSessionID, change: { type: "started" } })
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: otherSessionID,
        change: { type: "progressed", progress: { text: "Checking fixture", time: 1 } },
      })
      yield* admit(session, "Observe review")
      yield* session.resume(sessionID)
      const before = yield* session.context(sessionID)
      const publicBefore = yield* SessionOrchestration.readTeamView(db, sessionID)
      const protectedBefore = yield* SessionLiveState.captureDatabase(db, sessionID)
      const observations = before.filter(
        (message) => message.type === "synthetic" && message.metadata?.contextSource === "team-view",
      )
      expect(observations).toHaveLength(1)

      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: otherSessionID,
        change: { type: "progressed", progress: { text: "Checking fixture", time: 2 } },
      })
      const publicAfter = yield* SessionOrchestration.readTeamView(db, sessionID)
      expect(publicAfter!.view.children[0]!.revision).toBeGreaterThan(publicBefore!.view.children[0]!.revision)
      expect(publicAfter!.view.children[0]!.progress?.time).toBe(2)
      expect((yield* SessionLiveState.captureDatabase(db, sessionID)).sources.orchestration.digest).not.toBe(
        protectedBefore.sources.orchestration.digest,
      )
      yield* admit(session, "Observe unchanged review")
      yield* session.resume(sessionID)
      expect(
        (yield* session.context(sessionID)).filter(
          (message) => message.type === "synthetic" && message.metadata?.contextSource === "team-view",
        ),
      ).toEqual(observations)
      expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual([...requests[1]!.messages])

      yield* replaySessionProjection(sessionID)
      yield* admit(session, "Observe after replay")
      yield* session.resume(sessionID)
      expect(
        (yield* session.context(sessionID)).filter(
          (message) => message.type === "synthetic" && message.metadata?.contextSource === "team-view",
        ),
      ).toEqual(observations)

      const question = {
        id: QuestionID.make("qst_team_scope"),
        text: "Which scope?",
        data: { choices: ["core", "all"] },
        time: 3,
      }
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: otherSessionID,
        change: { type: "question_asked", question },
      })
      yield* admit(session, "Observe question")
      yield* session.resume(sessionID)
      expect(requests[4]!.messages.slice(0, requests[3]!.messages.length)).toEqual([...requests[3]!.messages])
      const questionText = requests[4]!.messages.at(-1)!.content.find((part) => part.type === "text")!
      expect(questionText.text).toContain('"state":"waiting"')
      expect(questionText.text).toContain('"id":"qst_team_scope"')
      expect(questionText.text).toContain('"choices":["core","all"]')
      expect(questionText.text).not.toContain('"time"')

      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: otherSessionID,
        change: { type: "question_answered", answer: { questionID: question.id, text: "core" } },
      })
      yield* admit(session, "Observe answered question")
      yield* session.resume(sessionID)
      const answeredText = requests[5]!.messages.at(-1)!.content.find((part) => part.type === "text")!
      expect(answeredText.text).toContain('"state":"running"')
      expect(answeredText.text).not.toContain('"question"')
      expect(requests[5]!.messages.slice(0, requests[4]!.messages.length)).toEqual([...requests[4]!.messages])
    }),
  )

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
      const state = first.messages.find((message) =>
        message.content.some(
          (part) => part.type === "text" && part.text.includes("Authoritative current Session state"),
        ),
      )
      expect(volatile.map((message) => message.role)).toEqual(["user"])
      expect(state?.volatile).not.toBe(true)
      expect(state?.content).toEqual([
        {
          type: "text",
          text: 'Authoritative current Session state (JSON):\n{"autonomy":{"answers":"manual","guardrails":"manual","mode":"normal","permissions":"manual"},"permissionCeiling":[],"todos":[{"content":"first","priority":"high","status":"in_progress"},{"content":"second","priority":"medium","status":"pending"}]}',
        },
      ])
      expect(volatile[0]?.content).toEqual([{ type: "text", text: "TeamView marker" }])
      expect(first.messages.indexOf(state!)).toBeLessThan(first.messages.indexOf(volatile[0]!))
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
        CatalogModel.Ref.make({ providerID: Provider.ID.make("fake"), id: CatalogModel.ID.make("fake-model") }),
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

  it.effect("keeps the hooked provider tool prefix ordered across discovery order changes", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const hooks = yield* PluginHooks.Service
      let reverse = false
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          reverse = !reverse
          if (reverse) event.tools = Object.fromEntries(Object.entries(event.tools).reverse())
        }),
      )
      yield* admit(session, "First")
      response = reply.text("First reply", "first-tool-order")
      yield* session.resume(sessionID)
      yield* admit(session, "Second")
      response = reply.text("Second reply", "second-tool-order")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
        "defect",
        "echo",
        "execute",
        "memory",
        "project_artifact",
        "snapshot",
        "storefail",
      ])
      expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(requests[0]?.tools.map((tool) => tool.name))
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
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
        "defect",
        "execute",
        "memory",
        "project_artifact",
        "snapshot",
        "storefail",
      ])
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
      const events = yield* EventRuntime.Service
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
          agent: Agent.ID.make("build"),
          messageID: expect.stringMatching(/^msg_/),
          callID: "call-location",
          progress: expect.any(Function),
        },
      ])
      expect(Array.from(yield* Fiber.join(progressFiber))[0]?.data.structured).toEqual({ phase: "reading" })
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.tool.progress.1")
      expect((yield* session.context(sessionID)).slice(0, 3)).toMatchObject([
        { type: "user", text: "Use application context" },
        sessionStateNotice,
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
      expect((yield* session.context(sessionID)).slice(0, 3)).toMatchObject([
        { type: "user", text: "Use the reloaded tool" },
        sessionStateNotice,
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

  it.effect("records the one-hour Anthropic cache-write price for a step and its provider request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = anthropicCacheModel
      currentCost = [
        {
          input: Money.USDPerMillionTokens.make(2),
          output: Money.USDPerMillionTokens.zero,
          cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.make(2.5) },
        },
      ]
      const input = yield* admit(session, "Price one-hour writes")
      response = reply.text("Done", "hourly-cost").map((event) =>
        LLMEvent.is.stepFinish(event)
          ? LLMEvent.stepFinish({
              index: event.index,
              reason: event.reason,
              usage: {
                cacheWriteInputTokens: 1_000,
                providerMetadata: { anthropic: { cache_creation: { ephemeral_1h_input_tokens: 1_000 } } },
              },
            })
          : event,
      )
      yield* session.resume(sessionID)
      expect(requireAssistant(yield* session.context(sessionID)).cost).toBe(Money.USD.make(0.004))
      const records = yield* (yield* SessionProviderRequest.Service).list(sessionID)
      expect(records[0]?.cost).toBe(Money.USD.make(0.004))
      const costs = yield* session.promptCosts({ sessionID, inputIDs: [input.id] })
      expect(costs.units[0]).toMatchObject({
        anchor: { sessionID, inputID: input.id },
        attribution: "complete",
        total: {
          requests: 1,
          cost: { known: 0.004, pricedRequests: 1, unpricedRequests: 0 },
          tokens: { cache: { write: 1_000 } },
        },
        main: { requests: 1 },
      })
      expect(costs.units[0]!.total.tokens).toEqual((yield* session.usage(sessionID)).tokens)
      expect(costs.unattributed.requests).toBe(0)
      expect(JSON.stringify(requests[0]?.messages)).not.toContain("usageAnchor")
      expect(JSON.stringify(requests[0]?.messages)).not.toContain("causedBy")
    }),
  )

  it.effect("keeps the one-hour Anthropic TTL for every request of an adaptive root Session", () =>
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

      expect(requests.map((request) => request.cache)).toEqual(
        Array.from({ length: 3 }, () => ({ tools: true, system: true, messages: { tail: 2 }, ttlSeconds: 3600 })),
      )
    }),
  )

  it.effect("keeps the five-minute Anthropic TTL for every request of an adaptive child Session", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const parentID = Session.ID.make("ses_runner_cache_parent")
      const { db } = yield* Database.Service
      yield* insertSession(parentID)
      yield* db
        .update(SessionTable)
        .set({ parent_id: parentID })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      currentModel = anthropicCacheModel
      efficiencyConfig = new ConfigEfficiency.Info({
        prompt_cache: new ConfigEfficiency.PromptCache({ anthropic_ttl: "adaptive" }),
      })
      responses = [
        reply.textWithCache("First", "cache-child-first", 0, 1_200),
        reply.textWithCache("Second", "cache-child-second", 900, 0),
        reply.textWithCache("Third", "cache-child-third", 900, 0),
      ]

      for (const prompt of ["First child turn", "Second child turn", "Third child turn"]) {
        yield* admit(session, prompt)
        yield* session.resume(sessionID)
      }

      expect(requests.map((request) => request.cache)).toEqual(
        Array.from({ length: 3 }, () => ({ tools: true, system: true, messages: { tail: 2 }, ttlSeconds: 300 })),
      )
    }),
  )

  it.effect("prepares opt-in family keys from stored ancestry while preserving default request identity", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const contexts = yield* SessionContext.Service
      const modelRequests = yield* SessionModelRequest.Service
      const otherRoot = Session.ID.make("ses_cache_other_root")
      const intermediate = Session.ID.make("ses_cache_intermediate")
      const children = [
        Session.ID.make("ses_cache_child_a"),
        Session.ID.make("ses_cache_child_b"),
        Session.ID.make("ses_cache_child_c"),
      ]
      yield* insertSession(otherRoot)
      yield* insertSession(intermediate)
      yield* database.db
        .update(SessionTable)
        .set({ parent_id: sessionID })
        .where(eq(SessionTable.id, intermediate))
        .run()
        .pipe(Effect.orDie)
      const sourceID = SessionMessage.ID.make("msg_cache_evidence")
      const snapshot = yield* SessionSharedContext.resolve(sessionID, { messageIDs: [sourceID] }, () =>
        Effect.succeed(
          SessionMessage.User.make({
            id: sourceID,
            type: "user",
            text: "Selected evidence for related work.",
            files: [],
            agents: [],
            time: { created: DateTime.makeUnsafe(0) },
          }),
        ),
      )
      for (const [index, childID] of children.entries()) {
        yield* insertSession(childID)
        yield* database.db
          .update(SessionTable)
          .set({ parent_id: index === 2 ? otherRoot : index === 1 ? intermediate : sessionID })
          .where(eq(SessionTable.id, childID))
          .run()
          .pipe(Effect.orDie)
        yield* session.prompt({
          sessionID: childID,
          text: `Task ${index}`,
          origin: "subagent",
          sharedContext: snapshot,
          metadata: { rootSessionID: sessionID, familyRoot: sessionID },
          resume: false,
        })
        yield* SessionPending.promoteSteers(database.db, events, childID)
      }
      const prepare = (childID: Session.ID) =>
        Effect.gen(function* () {
          const selected = yield* contexts.select(childID)
          yield* InstructionState.prepare(database.db, events, selected.instructions, childID)
          const loaded = yield* contexts.load(selected)
          return yield* modelRequests.prepare({ context: loaded, step: 1 })
        })
      const isolated = yield* Effect.forEach(children, prepare)
      expect(new Set(isolated.map((item) => item.request.providerOptions?.openai?.promptCacheKey)).size).toBe(3)
      efficiencyConfig = new ConfigEfficiency.Info({
        prompt_cache: new ConfigEfficiency.PromptCache({ family_scope: "family-experiment" }),
      })
      const shared = yield* Effect.forEach(children, prepare)
      expect(shared[0]!.request.providerOptions?.openai?.promptCacheKey).toBeDefined()
      expect(shared[0]!.request.providerOptions?.openai?.promptCacheKey).toBe(
        shared[1]!.request.providerOptions?.openai?.promptCacheKey,
      )
      expect(shared[0]!.request.providerOptions?.openai?.promptCacheKey).not.toBe(
        shared[2]!.request.providerOptions?.openai?.promptCacheKey,
      )
      expect(shared.map((item) => item.cache)).toEqual(isolated.map((item) => item.cache))
      expect(shared.map((item) => item.continuation)).toEqual(isolated.map((item) => item.continuation))
      expect(shared.map((item) => item.request.messages)).toEqual(isolated.map((item) => item.request.messages))
      efficiencyConfig = undefined
      const restored = yield* Effect.forEach(children, prepare)
      expect(restored.map((item) => item.request)).toEqual(isolated.map((item) => item.request))
      currentModel = Model.update(storedOpenAIResponsesModel, {
        route: storedOpenAIResponsesModel.route.with({
          endpoint: { ...storedOpenAIResponsesModel.route.endpoint, baseURL: "https://gateway.example/v1" },
        }),
      })
      const gatewayIsolated = yield* Effect.forEach(children, prepare)
      efficiencyConfig = new ConfigEfficiency.Info({
        prompt_cache: new ConfigEfficiency.PromptCache({ family_scope: "family-experiment" }),
      })
      const gatewayExperiment = yield* Effect.forEach(children, prepare)
      expect(gatewayExperiment.map((item) => item.request)).toEqual(gatewayIsolated.map((item) => item.request))
      expect(new Set(gatewayExperiment.map((item) => item.request.providerOptions?.openai?.promptCacheKey)).size).toBe(
        3,
      )
    }),
  )

  it.effect("retains the experimental family key when applying stored response continuation", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = storedOpenAIResponsesModel
      efficiencyConfig = new ConfigEfficiency.Info({
        prompt_cache: new ConfigEfficiency.PromptCache({ family_scope: "family-experiment" }),
      })
      const sourceID = SessionMessage.ID.make("msg_family_continuation_source")
      const snapshot = yield* SessionSharedContext.resolve(sessionID, { messageIDs: [sourceID] }, () =>
        Effect.succeed(
          SessionMessage.User.make({
            id: sourceID,
            type: "user",
            text: "Shared evidence retained across continuation.",
            files: [],
            agents: [],
            time: { created: DateTime.makeUnsafe(0) },
          }),
        ),
      )
      responses = [
        reply.textWithResponse("First", "family-first", "resp_family_first"),
        reply.textWithResponse("Second", "family-second", "resp_family_second"),
      ]
      yield* session.prompt({
        sessionID,
        text: "First task",
        sharedContext: snapshot,
        origin: "subagent",
        resume: false,
      })
      yield* session.resume(sessionID)
      yield* admit(session, "Continue the task")
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(requests[1]?.providerOptions?.openai?.previousResponseId).toBe("resp_family_first")
      expect(requests[1]?.providerOptions?.openai?.promptCacheKey).toBe(
        requests[0]?.providerOptions?.openai?.promptCacheKey,
      )
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
      expect(new Set(records.map((record) => record.promptCacheKey)).size).toBe(1)
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

  const staleStateFailures = [
    {
      name: "invalid_previous_response_id",
      thrown: invalidPreviousResponse,
      message: "invalid_previous_response_id: Previous response ID is invalid or expired",
    },
    { name: "bare invalid_prompt", thrown: bareInvalidPrompt, message: "invalid_prompt: The prompt is invalid." },
  ]
  const continuationRecords = Effect.gen(function* () {
    const providerRequests = yield* SessionProviderRequest.Service
    return (yield* providerRequests.list(sessionID)).map((record) => ({
      attempts: record.attempts,
      continuation: record.continuation,
    }))
  })

  for (const failure of staleStateFailures)
    for (const delivery of ["thrown", "streamed"] as const)
      it.effect(`falls back once from ${delivery} ${failure.name} without creating another logical request`, () =>
        Effect.gen(function* () {
          const session = yield* setup
          currentModel = storedOpenAIResponsesModel
          efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
          responseStreams = [
            Stream.fromIterable(reply.toolWithResponse("call-fallback", "echo", { text: "fallback" }, "resp_first")),
            Stream.fromIterable([LLMEvent.stepStart({ index: 0 })]).pipe(
              Stream.concat(
                delivery === "thrown"
                  ? Stream.fail(failure.thrown())
                  : Stream.make(LLMEvent.providerError({ message: failure.message })),
              ),
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
          expect(yield* continuationRecords).toEqual([
            { attempts: 1, continuation: "full" },
            { attempts: 2, continuation: "fallback" },
          ])
        }),
      )

  for (const failure of staleStateFailures)
    it.effect(`does not retry a second ${failure.name} after the continuation fallback`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        currentModel = storedOpenAIResponsesModel
        efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
        responseStreams = [
          Stream.fromIterable(reply.toolWithResponse("call-fallback-once", "echo", { text: "once" }, "resp_once")),
          Stream.fail(failure.thrown()),
          Stream.fail(failure.thrown()),
        ]

        yield* admit(session, "Fallback only once")
        expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

        expect(requests).toHaveLength(3)
        expect(requests[1]?.providerOptions?.openai).toHaveProperty("previousResponseId", "resp_once")
        expect(requests[2]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
        expect(yield* continuationRecords).toEqual([
          { attempts: 1, continuation: "full" },
          { attempts: 2, continuation: "fallback" },
        ])
      }),
    )

  it.effect("caps continuation fallback attempts at three with monotonic retry events", () =>
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
      yield* TestClock.adjust("2 seconds")
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(4)

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
      ])
      const records = yield* SessionProviderRequest.Service.pipe(
        Effect.flatMap((providerRequests) => providerRequests.list(sessionID)),
      )
      expect(records.map((record) => ({ attempts: record.attempts, continuation: record.continuation }))).toEqual([
        { attempts: 1, continuation: "full" },
        { attempts: 3, continuation: "fallback" },
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
              promptEvalDurationNs: 4_000_000,
              generationDurationNs: 5_000_000,
              loadDurationNs: 6_000_000,
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
        contextBreakdown: expect.objectContaining({
          system: expect.any(Number),
          tools: expect.any(Number),
          user: expect.any(Number),
          assistant: expect.any(Number),
          reasoning: expect.any(Number),
          toolCalls: expect.any(Number),
          other: expect.any(Number),
        }),
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
        contextBreakdown: assistant.diagnostics?.contextBreakdown,
        providerCache: {
          mechanism: "openai-prefix-cache",
          readReported: true,
          writeReported: false,
        },
      })
      const diagnostics = yield* session.diagnostics(sessionID)
      expect(diagnostics?.generationSpeed?.latest).toBeUndefined()
      expect((yield* session.snapshot(sessionID)).generationSpeed).toEqual(diagnostics?.generationSpeed)
      expect(diagnostics).toMatchObject({
        contextBreakdown: assistant.diagnostics?.contextBreakdown,
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
          latestTiming: { promptEvalDurationNs: 4_000_000, generationDurationNs: 5_000_000, loadDurationNs: 6_000_000 },
          tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 900, write: 0 } },
        },
      })
      expect(diagnostics && "application" in diagnostics).toBe(false)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.diagnostics(sessionID)).toEqual(diagnostics)
    }),
  )

  it.effect("publishes matched received-output speed before delayed usage and finish", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const received = yield* Deferred.make<void>()
      const delayFinish = yield* Deferred.make<void>()
      const delayed = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const live: SessionCacheDiagnostics.Info[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
        if (event.type === SessionEvent.DiagnosticsUpdated.type)
          live.push((event as EventRuntime.Payload<typeof SessionEvent.DiagnosticsUpdated>).data.diagnostics)
      }))
      currentModel = Model.make({ id: "arrival-speed", provider: "openai", route: OpenAIChat.route })
      const chunk = (after: number, text: string) => Stream.fromEffect(TestClock.adjust(after)).pipe(
        Stream.flatMap(() => Stream.succeed(LLMEvent.textDelta({ id: "chunky-output", text }))),
      )
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "chunky-output" }),
      ]).pipe(
        Stream.concat(chunk(10_000, "a".repeat(4_000))),
        Stream.concat(chunk(1_000, "b".repeat(160))),
        Stream.concat(chunk(1_000, "c".repeat(160))),
        Stream.concat(Stream.fromEffect(Effect.gen(function* () {
          yield* Deferred.succeed(received, undefined)
          yield* Deferred.await(delayFinish)
          yield* TestClock.adjust("88 seconds")
          yield* Deferred.succeed(delayed, undefined)
          yield* Deferred.await(finish)
        })).pipe(Stream.flatMap(() => Stream.fromIterable([
          LLMEvent.textEnd({ id: "chunky-output" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { outputTokens: 21_080, reasoningTokens: 20_000 } }),
          LLMEvent.finish({ reason: "stop" }),
        ])))),
      )
      yield* admit(session, "Measure received output")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(received)
      const active = (yield* session.snapshot(sessionID, { limit: 1 })).generationSpeed
      expect(active?.live).toMatchObject({
        requestID: expect.stringMatching(/^prq_/),
        attempt: 1,
        sample: { estimated: true, tokens: 80, durationNs: 2_000_000_000, tokensPerSecond: 40 },
      })
      expect(active?.latest).toBeUndefined()
      expect(active?.recent).toEqual([])
      expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(active)
      expect(live.at(-1)?.generationSpeed).toEqual(active)
      expect(live.flatMap((value) => value.generationSpeed?.live?.sample ? [value.generationSpeed.live.sample] : []))
        .toMatchObject([
          { estimated: true, tokens: 40, durationNs: 1_000_000_000, tokensPerSecond: 40 },
          { estimated: true, tokens: 80, durationNs: 2_000_000_000, tokensPerSecond: 40 },
        ])
      const updatesBeforeDelay = live.length
      yield* Deferred.succeed(delayFinish, undefined)
      yield* Deferred.await(delayed)
      expect((yield* session.snapshot(sessionID)).generationSpeed).toEqual(active)
      expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(active)
      expect(live.at(-1)?.generationSpeed).toEqual(active)
      expect(live).toHaveLength(updatesBeforeDelay)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(run)
      const ledger = yield* SessionProviderRequest.Service
      expect(yield* ledger.recentSteps(sessionID)).toMatchObject([{
        attempts: 1,
        tokens: { output: 1_080, reasoning: 20_000 },
        timing: {
          generatedTokens: 21_080,
          observedGenerationDurationNs: 90_000_000_000,
          receivedOutput: { estimatedTokens: 80, durationNs: 2_000_000_000 },
        },
      }])
      const settled = (yield* session.snapshot(sessionID)).generationSpeed
      expect(settled?.live).toBeUndefined()
      expect(settled?.recent).toHaveLength(1)
      expect(settled?.latest).toMatchObject({ estimated: true, tokens: 80, durationNs: 2_000_000_000, tokensPerSecond: 40 })
      expect(live.at(-1)?.generationSpeed).toEqual(settled)
      yield* replaySessionProjection(sessionID)
      expect((yield* session.snapshot(sessionID)).generationSpeed).toEqual(settled)
      expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(settled)
      yield* unsubscribe
    }),
  )

  it.effect("rolls received-output endpoints and flushes throttled final output", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const received = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const updates: { at: bigint; diagnostics: SessionCacheDiagnostics.Info }[] = []
      const unsubscribe = yield* events.listen((event) => Effect.gen(function* () {
        if (event.type !== SessionEvent.DiagnosticsUpdated.type) return
        updates.push({
          at: yield* Clock.currentTimeNanos,
          diagnostics: (event as EventRuntime.Payload<typeof SessionEvent.DiagnosticsUpdated>).data.diagnostics,
        })
      }))
      const chunk = (after: number, text: string) => Stream.fromEffect(TestClock.adjust(after)).pipe(
        Stream.flatMap(() => Stream.succeed(LLMEvent.textDelta({ id: "rolling-output", text }))),
      )
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "rolling-output" }),
        LLMEvent.textDelta({ id: "rolling-output", text: "a".repeat(4_000) }),
      ]).pipe(
        Stream.concat(Stream.fromIterable(Array.from({ length: 6 }, () => undefined)).pipe(
          Stream.flatMap(() => chunk(1_000, "b".repeat(160))),
        )),
        Stream.concat(Stream.fromIterable(Array.from({ length: 4 }, () => undefined)).pipe(
          Stream.flatMap(() => chunk(50, "cccccccc")),
        )),
        Stream.concat(Stream.fromEffect(Effect.gen(function* () {
          yield* Deferred.succeed(received, undefined)
          yield* Deferred.await(finish)
        })).pipe(Stream.flatMap(() => Stream.fromIterable([
          LLMEvent.textEnd({ id: "rolling-output" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ])))),
      )
      yield* admit(session, "Measure rolling output")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(received)
      const contentUpdates = updates.filter((value) => value.diagnostics.generationSpeed?.live?.sample !== undefined)
      expect(contentUpdates.length).toBeGreaterThan(0)
      expect(contentUpdates.every((value, index) => index === 0 || value.at - contentUpdates[index - 1]!.at >= 250_000_000n)).toBe(true)
      expect(contentUpdates.at(-1)?.diagnostics.generationSpeed?.live?.sample).toMatchObject({
        tokens: 200, durationNs: 5_000_000_000, tokensPerSecond: 40,
      })
      expect((yield* session.snapshot(sessionID)).generationSpeed?.live?.sample).toMatchObject({
        estimated: true, tokens: 168, durationNs: 4_200_000_000, tokensPerSecond: 40,
      })
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(run)
      const ledger = yield* SessionProviderRequest.Service
      expect((yield* ledger.recentSteps(sessionID)).at(-1)?.timing?.receivedOutput)
        .toEqual({ estimatedTokens: 168, durationNs: 4_200_000_000 })
      const settled = (yield* session.snapshot(sessionID)).generationSpeed
      expect(settled?.recent).toHaveLength(1)
      expect(settled?.latest).toMatchObject({ estimated: true, tokens: 168, durationNs: 4_200_000_000, tokensPerSecond: 40 })
      expect(updates.at(-1)?.diagnostics.generationSpeed).toEqual(settled)
      yield* unsubscribe
    }),
  )

  for (const later of [false, true])
    it.effect(`handles equal initial output timestamps ${later ? "with a later full-baseline delta" : "without fabricating an interval"}`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        responseStream = Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "equal-output" }),
            LLMEvent.textDelta({ id: "equal-output", text: "base" }),
            LLMEvent.textDelta({ id: "equal-output", text: "same" }),
          ]),
          Stream.fromEffect(TestClock.adjust("1 second")).pipe(Stream.flatMap(() => Stream.fromIterable([
            ...(later ? [LLMEvent.textDelta({ id: "equal-output", text: "last" })] : []),
            LLMEvent.textEnd({ id: "equal-output" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ]))),
        )
        yield* admit(session, "Measure equal timestamps")
        yield* session.resume(sessionID)
        const ledger = yield* SessionProviderRequest.Service
        expect((yield* ledger.recentSteps(sessionID)).at(-1)?.timing?.receivedOutput)
          .toEqual(later ? { estimatedTokens: 1, durationNs: 1_000_000_000 } : undefined)
        expect((yield* session.snapshot(sessionID)).generationSpeed?.latest)
          .toEqual(later ? expect.objectContaining({ estimated: true, tokens: 1, durationNs: 1_000_000_000, tokensPerSecond: 1 }) : undefined)
      }),
    )

  it.effect("weights received-output windows without provider-counted hidden reasoning", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({ id: "speed-model", provider: "openai", route: OpenAIChat.route })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "speed-reasoning" }),
          LLMEvent.reasoningDelta({ id: "speed-reasoning", text: "Think" }),
          LLMEvent.reasoningEnd({ id: "speed-reasoning" }),
        ]),
        Stream.fromEffect(TestClock.adjust("2 seconds")).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable([
              LLMEvent.textStart({ id: "speed-text" }),
              LLMEvent.textDelta({ id: "speed-text", text: "Done" }),
              LLMEvent.textEnd({ id: "speed-text" }),
              LLMEvent.stepFinish({
                index: 0,
                reason: "stop",
                usage: {
                  outputTokens: 12,
                },
              }),
              LLMEvent.finish({ reason: "stop" }),
            ]),
          ),
        ),
      )
      responses = [reply.text("Title", "speed-title")]
      yield* admit(session, "Measure generation")
      yield* session.resume(sessionID)
      const measured = yield* session.diagnostics(sessionID)
      expect(measured?.generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 1,
        durationNs: 2_000_000_000,
        tokensPerSecond: 0.5,
      })
      expect((yield* session.snapshot(sessionID)).generationSpeed).toEqual(measured?.generationSpeed)
      const requests = yield* SessionProviderRequest.Service
      expect((yield* requests.recentSteps(sessionID)).at(-1)?.timing).toMatchObject({
        generatedTokens: 12,
        observedGenerationDurationNs: 2_000_000_000,
        receivedOutput: { estimatedTokens: 1, durationNs: 2_000_000_000 },
      })

      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "speed-hidden-summary" }),
          LLMEvent.reasoningDelta({ id: "speed-hidden-summary", text: "Summary" }),
          LLMEvent.reasoningEnd({ id: "speed-hidden-summary" }),
        ]),
        Stream.fromEffect(TestClock.adjust("2 seconds")).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable([
              LLMEvent.textStart({ id: "speed-hidden-text" }),
              LLMEvent.textDelta({ id: "speed-hidden-text", text: "Answer" }),
              LLMEvent.textEnd({ id: "speed-hidden-text" }),
              LLMEvent.stepFinish({
                index: 0,
                reason: "stop",
                usage: {
                  outputTokens: 15,
                  outputMayIncludeUnreportedReasoning: true,
                },
              }),
              LLMEvent.finish({ reason: "stop" }),
            ]),
          ),
        ),
      )
      responses = [reply.text("Title", "speed-hidden-title")]
      yield* admit(session, "Hidden thinking")
      yield* session.resume(sessionID)
      const hidden = yield* session.diagnostics(sessionID)
      expect(hidden?.generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 2,
        durationNs: 4_000_000_000,
        tokensPerSecond: 0.5,
      })
      expect(hidden?.generationSpeed?.recent).toHaveLength(2)
      expect((yield* session.snapshot(sessionID)).generationSpeed).toEqual(hidden?.generationSpeed)
      expect((yield* requests.recentSteps(sessionID)).at(-1)?.timing).toMatchObject({
        generatedTokens: 15,
        observedGenerationDurationNs: 2_000_000_000,
        receivedOutput: { estimatedTokens: 1, durationNs: 2_000_000_000 },
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "speed-openai-text" }),
          LLMEvent.textDelta({ id: "speed-openai-text", text: "Visible" }),
          LLMEvent.textEnd({ id: "speed-openai-text" }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: {
              outputTokens: 12,
              reasoningTokens: 4,
              generationDurationNs: 2_000_000_000,
            },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* admit(session, "Unstreamed separate reasoning")
      yield* session.resume(sessionID)
      const separate = yield* session.diagnostics(sessionID)
      expect(separate?.generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 2,
        durationNs: 4_000_000_000,
      })
      expect(separate?.generationSpeed?.latest?.tokensPerSecond).toBe(0.5)
      expect(separate?.generationSpeed?.recent).toHaveLength(2)
      expect((yield* requests.recentSteps(sessionID)).at(-1)?.timing?.receivedOutput).toBeUndefined()
      const events = yield* EventRuntime.Service
      yield* events.publish(SessionEvent.Compaction.StartedV1, { sessionID, reason: "manual", recent: "" })
      yield* events.publish(SessionEvent.Compaction.EndedV1, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "",
      })
      expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(separate?.generationSpeed)
      expect((yield* session.snapshot(sessionID)).generationSpeed).toEqual(separate?.generationSpeed)
    }),
  )

  it.effect("times received tool-call output independently of reported reasoning tokens", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({ id: "speed-model", provider: "openai", route: OpenAIChat.route })
      responseStream = Stream.concat(
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 })]),
        Stream.fromEffect(TestClock.adjust("40 seconds")).pipe(
          Stream.flatMap(() =>
            Stream.concat(
              Stream.fromIterable([
                LLMEvent.reasoningStart({ id: "summary" }),
                LLMEvent.reasoningDelta({ id: "summary", text: "Plan the edit" }),
                LLMEvent.reasoningEnd({ id: "summary" }),
                LLMEvent.toolInputStart({ id: "call-1", name: "unknown_tool" }),
                LLMEvent.toolInputDelta({ id: "call-1", name: "unknown_tool", text: '{"path":' }),
              ]),
              Stream.fromEffect(TestClock.adjust("4 seconds")).pipe(
                Stream.flatMap(() =>
                  Stream.fromIterable([
                    LLMEvent.toolInputDelta({ id: "call-1", name: "unknown_tool", text: '"a.ts"}' }),
                    LLMEvent.toolInputEnd({ id: "call-1", name: "unknown_tool" }),
                    LLMEvent.stepFinish({
                      index: 0,
                      reason: "stop",
                      usage: { outputTokens: 4_200, reasoningTokens: 4_000 },
                    }),
                    LLMEvent.finish({ reason: "stop" }),
                  ]),
                ),
              ),
            ),
          ),
        ),
      )
      responses = [reply.text("Title", "speed-title")]
      yield* admit(session, "Tool call speed")
      yield* session.resume(sessionID)
      const requests = yield* SessionProviderRequest.Service
      expect((yield* requests.recentSteps(sessionID))[0]?.timing).toEqual({
        generatedTokens: 4_200,
        observedGenerationDurationNs: 4_000_000_000,
        receivedOutput: { estimatedTokens: 2, durationNs: 4_000_000_000 },
      })
    }),
  )

  it.effect("records streamed tool-input estimates without a provider token count", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({ id: "speed-model", provider: "openai", route: OpenAIChat.route })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "estimated-tool", name: "unknown_tool" }),
          LLMEvent.toolInputDelta({ id: "estimated-tool", name: "unknown_tool", text: '{"path":' }),
        ]),
        Stream.fromEffect(TestClock.adjust("2 seconds")).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable([
              LLMEvent.toolInputDelta({ id: "estimated-tool", name: "unknown_tool", text: '"a.ts"}' }),
              LLMEvent.toolInputEnd({ id: "estimated-tool", name: "unknown_tool" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop" }),
              LLMEvent.finish({ reason: "stop" }),
            ]),
          ),
        ),
      )
      responses = [reply.text("Title", "speed-title")]
      yield* admit(session, "Estimate tool output")
      yield* session.resume(sessionID)
      const requests = yield* SessionProviderRequest.Service
      expect((yield* requests.recentSteps(sessionID))[0]?.timing).toMatchObject({
        receivedOutput: { estimatedTokens: 2, durationNs: 2_000_000_000 },
      })
      expect(yield* requests.recentSteps(sessionID)).toHaveLength(2)
      expect((yield* session.snapshot(sessionID)).generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 2,
        durationNs: 2_000_000_000,
      })
      expect((yield* session.snapshot(sessionID)).generationSpeed?.latest?.tokensPerSecond).toBe(1)
    }),
  )

  for (const streamed of [false, true])
    it.effect(
      `estimates complete provider tool calls ${streamed ? "without counting arguments twice" : "only with an observed output interval"}`,
      () =>
        Effect.gen(function* () {
          const session = yield* setup
          currentModel = Model.make({ id: "tool-speed", provider: "openai", route: OpenAIChat.route })
          responseStream = Stream.concat(
            Stream.fromIterable([
              LLMEvent.stepStart({ index: 0 }),
              ...(streamed
                ? [
                    LLMEvent.toolInputStart({ id: "provider-call", name: "provider_search" }),
                    LLMEvent.toolInputDelta({ id: "provider-call", name: "provider_search", text: '{"path":' }),
                  ]
                : []),
            ]),
            Stream.fromEffect(TestClock.adjust("1 second")).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable([
                  ...(streamed
                    ? [LLMEvent.toolInputDelta({ id: "provider-call", name: "provider_search", text: '"a.ts"}' })]
                    : []),
                  LLMEvent.toolCall({
                    id: "provider-call",
                    name: "provider_search",
                    input: { path: "a.ts" },
                    providerExecuted: true,
                  }),
                  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                  LLMEvent.finish({ reason: "stop" }),
                ]),
              ),
            ),
          )
          responses = [reply.text("Done", "tool-speed-recovery")]
          yield* admit(session, "Measure tool-only output")
          yield* session.resume(sessionID)
          const ledger = yield* SessionProviderRequest.Service
          expect((yield* ledger.recentSteps(sessionID))[0]?.timing?.receivedOutput).toEqual(
            streamed ? { estimatedTokens: 2, durationNs: 1_000_000_000 } : undefined,
          )
        }),
    )

  it.effect("withholds short received-output windows despite provider counts", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({ id: "speed-model", provider: "anthropic", route: OpenAIChat.route })
      responseStream = Stream.concat(
        Stream.fromIterable([LLMEvent.stepStart({ index: 0 })]),
        Stream.fromEffect(TestClock.adjust("30 seconds")).pipe(
          Stream.flatMap(() =>
            Stream.concat(
              Stream.fromIterable([
                LLMEvent.reasoningStart({ id: "burst-reasoning" }),
                LLMEvent.reasoningDelta({ id: "burst-reasoning", text: "Think" }),
                LLMEvent.reasoningEnd({ id: "burst-reasoning" }),
              ]),
              Stream.fromEffect(TestClock.adjust("50 millis")).pipe(
                Stream.flatMap(() =>
                  Stream.concat(
                    Stream.fromIterable([
                      LLMEvent.textStart({ id: "burst-text" }),
                      LLMEvent.textDelta({ id: "burst-text", text: "Done" }),
                      LLMEvent.textEnd({ id: "burst-text" }),
                    ]),
                    Stream.fromEffect(TestClock.adjust("20 millis")).pipe(
                      Stream.flatMap(() =>
                        Stream.fromIterable([
                          LLMEvent.stepFinish({
                            index: 0,
                            reason: "stop",
                            usage: {
                              outputTokens: 2_355,
                            },
                          }),
                          LLMEvent.finish({ reason: "stop" }),
                        ]),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
      responses = [reply.text("Title", "speed-title")]
      yield* admit(session, "Buffered output")
      yield* session.resume(sessionID)
      expect((yield* session.diagnostics(sessionID))?.generationSpeed?.latest).toBeUndefined()
      expect((yield* session.snapshot(sessionID)).generationSpeed?.recent).toEqual([])
      const requests = yield* SessionProviderRequest.Service
      expect((yield* requests.recentSteps(sessionID)).at(-1)?.timing).toMatchObject({ generatedTokens: 2_355 })
      expect((yield* requests.recentSteps(sessionID)).at(-1)?.timing?.observedGenerationDurationNs).toBe(70_000_000)
      expect((yield* requests.recentSteps(sessionID)).at(-1)?.timing?.receivedOutput).toBeUndefined()
    }),
  )

  it.effect("estimates whitespace and split deltas once from the first received character", () =>
    Effect.gen(function* () {
      const session = yield* setup
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "split-speed" }),
          LLMEvent.textDelta({ id: "split-speed", text: " " }),
        ]),
        Stream.fromEffect(TestClock.adjust("1 second")).pipe(
          Stream.flatMap(() =>
            Stream.concat(
              Stream.fromIterable(
                ["a", "b", "c", "d", "e", "f", " "].map((text) => LLMEvent.textDelta({ id: "split-speed", text })),
              ),
              Stream.fromEffect(TestClock.adjust("1 second")).pipe(
                Stream.flatMap(() =>
                  Stream.fromIterable([
                    LLMEvent.textEnd({ id: "split-speed" }),
                    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                    LLMEvent.finish({ reason: "stop" }),
                  ]),
                ),
              ),
            ),
          ),
        ),
      )
      yield* admit(session, "Measure split output")
      yield* session.resume(sessionID)
      const ledger = yield* SessionProviderRequest.Service
      expect((yield* ledger.recentSteps(sessionID)).at(-1)?.timing).toMatchObject({
        receivedOutput: { estimatedTokens: 2, durationNs: 1_000_000_000 },
      })
      expect((yield* session.snapshot(sessionID)).generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 2,
        tokensPerSecond: 2,
      })
    }),
  )

  it.effect("retains generation samples across compaction completion independently of message position", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      responseStream = Stream.fromEffect(
        events.publish(SessionEvent.Compaction.StartedV1, {
          sessionID,
          reason: "manual",
          recent: "",
        }),
      ).pipe(
        Stream.flatMap(() =>
          Stream.concat(
            Stream.fromIterable([
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "pre-compaction-speed" }),
              LLMEvent.textDelta({ id: "pre-compaction-speed", text: "Done" }),
            ]),
            Stream.fromEffect(TestClock.adjust("1 second")).pipe(
              Stream.flatMap(() => Stream.fromIterable([
                LLMEvent.textDelta({ id: "pre-compaction-speed", text: " now" }),
                LLMEvent.textEnd({ id: "pre-compaction-speed" }),
                LLMEvent.stepFinish({
                  index: 0,
                  reason: "stop",
                  usage: { outputTokens: 80, generationDurationNs: 1_000_000_000 },
                }),
                LLMEvent.finish({ reason: "stop" }),
              ])),
            ),
          ),
        ),
      )
      yield* admit(session, "Measure before compaction settles")
      yield* session.resume(sessionID)
      const speed = (yield* session.snapshot(sessionID)).generationSpeed
      expect(speed?.latest).toMatchObject({ estimated: true, tokens: 1, durationNs: 1_000_000_000, tokensPerSecond: 1 })
      yield* events.publish(SessionEvent.Compaction.EndedV1, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "",
      })
      expect((yield* session.snapshot(sessionID)).generationSpeed).toEqual(speed)
      expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(speed)
    }),
  )

  it.effect("resets speed output and its observation window after a pre-output retry", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const scheduled = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === SessionEvent.RetryScheduled.type ? Deferred.succeed(scheduled, undefined) : Effect.void,
      )
      responseStreams = [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "retry-whitespace" }),
            LLMEvent.textDelta({ id: "retry-whitespace", text: "                " }),
            LLMEvent.textEnd({ id: "retry-whitespace" }),
          ]),
          Stream.fromEffect(TestClock.adjust("5 seconds")).pipe(
            Stream.flatMap(() => Stream.fail(providerUnavailable())),
          ),
        ),
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "retry-speed" }),
            LLMEvent.textDelta({ id: "retry-speed", text: "12345678" }),
          ]),
          Stream.fromEffect(TestClock.adjust("2 seconds")).pipe(
            Stream.flatMap(() =>
              Stream.fromIterable([
                LLMEvent.textDelta({ id: "retry-speed", text: "abcdefgh" }),
                LLMEvent.textEnd({ id: "retry-speed" }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                LLMEvent.finish({ reason: "stop" }),
              ]),
            ),
          ),
        ),
      ]
      yield* admit(session, "Measure retried output")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(scheduled)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)
      yield* unsubscribe
      expect(requests).toHaveLength(2)
      const ledger = yield* SessionProviderRequest.Service
      expect((yield* ledger.recentSteps(sessionID)).at(-1)).toMatchObject({
        attempts: 2,
        timing: { receivedOutput: { estimatedTokens: 2, durationNs: 2_000_000_000 } },
      })
      expect((yield* session.snapshot(sessionID)).generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 2,
        tokensPerSecond: 1,
      })
      expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(
        (yield* session.snapshot(sessionID)).generationSpeed,
      )
    }),
  )

  it.effect("uses only the overflow-recovery second attempt for generation speed", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStreams = [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "overflow-whitespace" }),
            LLMEvent.textDelta({ id: "overflow-whitespace", text: "                " }),
            LLMEvent.textEnd({ id: "overflow-whitespace" }),
          ]),
          Stream.fromEffect(TestClock.adjust("5 seconds")).pipe(
            Stream.flatMap(() =>
              Stream.succeed(
                LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
              ),
            ),
          ),
        ),
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "overflow-speed" }),
            LLMEvent.textDelta({ id: "overflow-speed", text: "12345678" }),
          ]),
          Stream.fromEffect(TestClock.adjust("2 seconds")).pipe(
            Stream.flatMap(() =>
              Stream.fromIterable([
                LLMEvent.textDelta({ id: "overflow-speed", text: "abcdefgh" }),
                LLMEvent.textEnd({ id: "overflow-speed" }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                LLMEvent.finish({ reason: "stop" }),
              ]),
            ),
          ),
        ),
      ]
      yield* admit(session, "Measure recovered output")
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      const ledger = yield* SessionProviderRequest.Service
      expect((yield* ledger.recentSteps(sessionID)).at(-1)).toMatchObject({
        attempts: 2,
        timing: { receivedOutput: { estimatedTokens: 2, durationNs: 2_000_000_000 } },
      })
      expect((yield* session.snapshot(sessionID)).generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 2,
        tokensPerSecond: 1,
      })
      expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(
        (yield* session.snapshot(sessionID)).generationSpeed,
      )
    }),
  )

  it.effect("retains received-output history after a raw no-output failed Step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const live: SessionCacheDiagnostics.Info[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionEvent.DiagnosticsUpdated.type)
            live.push((event as EventRuntime.Payload<typeof SessionEvent.DiagnosticsUpdated>).data.diagnostics)
        }),
      )
      currentModel = Model.make({ id: "speed-model", provider: "openai", route: OpenAIChat.route })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "measured-before-failure" }),
          LLMEvent.textDelta({ id: "measured-before-failure", text: "Done" }),
        ]),
        Stream.fromEffect(TestClock.adjust("1 second")).pipe(
          Stream.flatMap(() => Stream.fromIterable([
            LLMEvent.textDelta({ id: "measured-before-failure", text: " now" }),
            LLMEvent.textEnd({ id: "measured-before-failure" }),
            LLMEvent.stepFinish({
              index: 0,
              reason: "stop",
              usage: { outputTokens: 80, generationDurationNs: 1_000_000_000 },
            }),
            LLMEvent.finish({ reason: "stop" }),
          ])),
        ),
      )
      yield* admit(session, "Measure before failure")
      yield* session.resume(sessionID)
      expect(live.at(-1)?.generationSpeed?.latest?.tokensPerSecond).toBe(1)
      responseStream = Stream.fail(invalidRequest())
      yield* admit(session, "Fail without output")
      yield* session.resume(sessionID).pipe(Effect.exit)
      const snapshot = yield* session.snapshot(sessionID)
      expect(snapshot.generationSpeed?.latest).toMatchObject({
        estimated: true,
        tokens: 1,
        durationNs: 1_000_000_000,
        tokensPerSecond: 1,
      })
      expect(live.at(-1)?.generationSpeed?.latest).toEqual(snapshot.generationSpeed?.latest)
      expect(live.at(-1)?.generationSpeed).toEqual(snapshot.generationSpeed)
      yield* unsubscribe
    }),
  )

  for (const terminal of ["failure", "provider-error", "interruption", "missing-settlement"] as const)
    it.effect(`records received-output estimate at ${terminal}`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        const events = yield* EventRuntime.Service
        const live: SessionCacheDiagnostics.Info[] = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === SessionEvent.DiagnosticsUpdated.type)
              live.push((event as EventRuntime.Payload<typeof SessionEvent.DiagnosticsUpdated>).data.diagnostics)
          }),
        )
        currentModel = Model.make({ id: "speed-model", provider: "openai", route: OpenAIChat.route })
        const received = yield* Deferred.make<void>()
        responseStream = Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: `partial-${terminal}` }),
            LLMEvent.textDelta({ id: `partial-${terminal}`, text: "12345678" }),
          ]),
          Stream.fromEffect(TestClock.adjust("2 seconds")).pipe(
            Stream.flatMap(() =>
              Stream.concat(
                Stream.succeed(LLMEvent.textDelta({ id: `partial-${terminal}`, text: "abcdefgh" })),
                Stream.fromEffect(TestClock.adjust("7 seconds")).pipe(
                  Stream.flatMap(() =>
                    terminal === "failure"
                      ? Stream.fail(invalidRequest())
                      : terminal === "provider-error"
                        ? Stream.succeed(LLMEvent.providerError({ message: "Invalid request" }))
                        : terminal === "interruption"
                          ? Stream.fromEffect(Deferred.succeed(received, undefined)).pipe(Stream.flatMap(() => Stream.never))
                          : Stream.empty,
                  ),
                ),
              ),
            ),
          ),
        )
        yield* admit(session, terminal)
        if (terminal === "interruption") {
          const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
          yield* Deferred.await(received)
          yield* session.interrupt(sessionID)
          const exit = yield* Fiber.await(run)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        if (terminal !== "interruption") yield* session.resume(sessionID).pipe(Effect.exit)
        const requests = yield* SessionProviderRequest.Service
        expect((yield* requests.recentSteps(sessionID)).at(-1)?.timing).toMatchObject({
          receivedOutput: { estimatedTokens: 2, durationNs: 2_000_000_000 },
        })
        const snapshot = yield* session.snapshot(sessionID)
        expect(snapshot.generationSpeed?.latest).toMatchObject({
          estimated: true,
          tokens: 2,
          durationNs: 2_000_000_000,
          tokensPerSecond: 1,
        })
        expect(live.at(-1)?.generationSpeed).toEqual(snapshot.generationSpeed)
        expect((yield* session.diagnostics(sessionID))?.generationSpeed).toEqual(snapshot.generationSpeed)
        yield* unsubscribe
      }),
    )

  it.effect("publishes live cache diagnostics before settled local tools finish", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
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
          LLMEvent.textStart({ id: "live-speed-text" }),
          LLMEvent.textDelta({ id: "live-speed-text", text: "Working" }),
          LLMEvent.textEnd({ id: "live-speed-text" }),
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
              generationDurationNs: 5_000_000,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Done", "text-after-diagnostics"),
      ]
      const live = yield* events.subscribe(SessionEvent.DiagnosticsUpdated).pipe(
        Stream.filter((event) => event.data.sessionID === sessionID && event.data.diagnostics.cache.readReported),
        Stream.runHead,
        Effect.forkScoped,
      )

      yield* admit(session, "Report cache while the tool runs")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      const observed = yield* Fiber.join(live).pipe(Effect.timeout("1 second"))
      expect(Option.isSome(observed)).toBe(true)
      expect(observed).toMatchObject({
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
      expect(Option.isSome(observed) && observed.value.data.diagnostics.generationSpeed?.latest).toBeUndefined()
      expect((yield* session.diagnostics(sessionID))?.generationSpeed?.live?.sample).toBeUndefined()

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

  it.effect("streams one request with registry definitions from chronological user history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "First")
      yield* admit(session, "Second")

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
        "defect",
        "echo",
        "execute",
        "memory",
        "project_artifact",
        "snapshot",
        "storefail",
      ])
      expect(
        nonVolatileMessages(requests[0]).map((message) => ({ role: message.role, content: message.content })),
      ).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
        {
          role: "system",
          content: [{ type: "text", text: sessionStateNotice.text }],
        },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(4)
    }),
  )

  it.effect("keeps durable moved-project history but excludes only ended project artifact injections", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const artifact = (scope: "project" | "global", id: string) => ({
        scopeID: ProjectArtifact.ScopeID.make(`pas_${scope}`),
        versionID: ProjectArtifact.VersionID.make(`pav_${id}`),
        kind: "skill" as const,
        id: ProjectArtifact.ID.make(id),
        sourceScope: scope,
      })
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID,
        id: Skill.ID.make("project-skill"),
        name: Skill.Name.make("PROJECT_SKILL"),
        text: "PROJECT_SKILL",
        artifact: artifact("project", "project-skill"),
      })
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID,
        id: Skill.ID.make("global-skill"),
        name: Skill.Name.make("GLOBAL_SKILL"),
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
        agent: Agent.ID.make("project-agent"),
        artifact: { ...artifact("project", "project-agent"), kind: "agent" },
      })
      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: Agent.ID.make("global-agent"),
        artifact: { ...artifact("global", "global-agent"), kind: "agent" },
      })
      yield* events.publish(SessionEvent.AgentSelected, { sessionID, agent: Agent.ID.make("build") })
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
      const events = yield* EventRuntime.Service
      const instructionEvents: EventRuntime.Payload[] = []
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
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "system"])
    }),
  )

  it.effect("returns the admitted record for a prompt wake that resends a retained folder attachment", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const messageID = SessionMessage.ID.create()
      const first = yield* session.prompt({
        id: messageID,
        sessionID,
        text: "Inspect this folder",
        files: [{ uri: `file://${runnerDirectory}`, name: "test" }],
        resume: false,
      })
      // The wake resends the retained managed attachment (projectedPromptInput form),
      // whose re-derived mime differs from the admitted record for a directory mention.
      const admitted = yield* session.prompt({
        id: messageID,
        sessionID,
        text: "Inspect this folder",
        files: [
          {
            uri: `ycoding-attachment://sha256/${first.data.files?.[0]?.content.digest}`,
            name: first.data.files?.[0]?.name,
          },
        ],
        resume: true,
      })
      yield* session.wait(sessionID)
      expect(admitted.id).toBe(messageID)
    }),
  )

  it.effect("keeps running Steps after a stored attachment is modified outside YCoding", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const store = yield* AttachmentStore.Service
      const attached = yield* session.prompt({
        sessionID,
        text: "Update the attached notes",
        files: [
          { uri: `data:text/plain;base64,${Buffer.from("original notes\n").toString("base64")}`, name: "notes.txt" },
        ],
        resume: false,
      })
      const file = attached.data.files?.[0]
      expect(file).toBeDefined()
      if (!file) return
      const stored = store.absolutePath(file.content)
      yield* Effect.promise(() => chmod(stored, 0o600))
      yield* Effect.promise(() => writeFile(stored, "notes edited by a tool\n"))

      yield* session.resume(sessionID)
      yield* admit(session, "continue")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      for (const request of requests) {
        const text = userTexts(request).join("\n")
        expect(text).toContain(
          `Attached file unavailable: notes.txt\nMIME: text/plain\nSHA-256: ${file.content.digest}`,
        )
        expect(text).not.toContain(stored)
        expect(text).not.toContain("notes edited by a tool")
      }
      expect(userTexts(requests[1]!)).toContain("continue")
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
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
      const events = yield* EventRuntime.Service
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
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual([
        "user",
        "system",
        "assistant",
        "user",
      ])
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
        "system",
        "assistant",
        "system",
        "user",
      ])
      expect(requests[1]?.messages.at(3)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(5)
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
          "ycoding/workspace-memory": Instructions.hash(MemoryInstructions.content),
          "test/context": Instructions.hash("Initial context"),
        },
      })
      expect(updates[1]?.data).toEqual({
        sessionID,
        delta: { "test/context": Instructions.hash("Changed context") },
      })
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(5)
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
      const agent = yield* Agent.Service
      yield* agent.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
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
      const agent = yield* Agent.Service
      yield* agent.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
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

  it.effect("omits guidance and tools that capability toggles turn off", () =>
    Effect.gen(function* () {
      capabilitiesConfig = new ConfigCapabilities.Info({
        tools: { deny: ["project_artifact"] },
        builtin_instructions: { deny: ["memory"] },
      })
      const session = yield* setup
      const agent = yield* Agent.Service
      yield* agent.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      yield* admit(session, "First")

      response = reply.text("Done", "text-build")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
      expect(requests.at(-1)?.tools.map((tool) => tool.name)).toEqual([
        "defect",
        "echo",
        "execute",
        "memory",
        "snapshot",
        "storefail",
      ])
    }).pipe(Effect.ensuring(Effect.sync(() => (capabilitiesConfig = undefined)))),
  )

  it.effect("omits memory guidance when the selected agent cannot call the memory tool", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agent = yield* Agent.Service
      yield* agent.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
          agent.permissions.push({ action: "memory", resource: "*", effect: "deny" })
        }),
      )
      yield* admit(session, "First")

      response = reply.text("Done", "text-build")
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual([
        "Build agent instructions",
        ["Initial context", ProjectArtifactInstructions.content].join("\n\n"),
      ])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agent = yield* Agent.Service
      yield* agent.transform((editor) => {
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(Agent.ID.make("reviewer"))
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

  it.effect("replaces the agent system prompt after switching agents", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("brainstorm"), (agent) => {
          agent.system = "Brainstorm agent instructions"
          agent.mode = "primary"
        })
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
      })
      yield* session.switchAgent({ sessionID, agent: Agent.ID.make("brainstorm") })
      yield* admit(session, "Design")
      response = reply.text("Designed", "text-brainstorm")
      yield* session.resume(sessionID)

      yield* session.switchAgent({ sessionID, agent: Agent.ID.make("build") })
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
      const agent = yield* Agent.Service
      yield* agent.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
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
      const session = yield* Session.Service
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
      const session = yield* Session.Service
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
      const events = yield* EventRuntime.Service
      const agents = yield* Agent.Service
      yield* agents.transform((draft) =>
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "primary"
        }),
      )
      skillBaselines.set(Agent.ID.make("build"), "Build skills")
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      skillBaselines.set(Agent.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: Agent.ID.make("reviewer"),
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
      const events = yield* EventRuntime.Service
      skillBaselines.set(Agent.ID.make("build"), "Build skills")
      skillBaselines.set(Agent.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSelected, {
            sessionID,
            agent: Agent.ID.make("reviewer"),
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
      const events = yield* EventRuntime.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSelected, {
            sessionID,
            model: { id: CatalogModel.ID.make("replacement"), providerID: Provider.ID.make("fake") },
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
        "system",
        "assistant",
        "system",
        "user",
      ])
      expect(requests[1]?.messages.at(3)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(5)
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
        "system",
        "assistant",
        "system",
        "user",
      ])
      expect(requests[1]?.messages.at(3)?.content).toEqual([
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
        "system",
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

      expect(requests[1]?.messages.at(3)?.content).toEqual([
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
      const events = yield* EventRuntime.Service
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* admit(session, "Second")
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: CatalogModel.ID.make("replacement"), providerID: Provider.ID.make("fake") },
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
        "system",
        "assistant",
        "system",
        "user",
      ])
      expect(nonVolatileMessages(requests[2]).filter((message) => message.role === "system")).toHaveLength(3)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "system",
        "assistant",
        "user",
        "assistant",
        "model-switched",
        "user",
        "assistant",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(8)
      yield* admit(session, "Fourth")
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves instruction values while a source is temporarily unavailable", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      yield* admit(session, "First")

      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: CatalogModel.ID.make("replacement"), providerID: Provider.ID.make("fake") },
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
      const events = yield* EventRuntime.Service
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
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual([
        "user",
        "system",
        "user",
        "system",
      ])
      expect(requests[1]?.messages.at(1)?.content).toEqual([{ type: "text", text: "Replacement context" }])
      yield* replaySessionProjection(sessionID)
      yield* admit(session, "Third")
      yield* session.resume(sessionID)
    }),
  )

  it.effect("uses epoch values after compaction while a source is unavailable", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
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
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
        "defect",
        "echo",
        "execute",
        "memory",
        "project_artifact",
        "snapshot",
        "storefail",
      ])
      expect((yield* session.context(sessionID)).slice(0, 3)).toMatchObject([
        { type: "user", text: "Use tools" },
        sessionStateNotice,
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

  const fakeCatalogModel = (input: readonly string[]) =>
    CatalogModel.Info.make({
      id: CatalogModel.ID.make("fake-model"),
      modelID: CatalogModel.ID.make("fake-model"),
      providerID: Provider.ID.make("fake"),
      name: "Fake model",
      package: "@ycoding-ai/ai/providers/openai-compatible",
      settings: {},
      headers: {},
      body: {},
      capabilities: { tools: true, input: [...input], output: ["text"] },
      variants: [],
      status: "active",
      enabled: true,
      limit: testLimits,
      cost: [],
      time: { released: 0 },
    })

  const snapshotToolContent = Effect.gen(function* () {
    const session = yield* Session.Service
    const tool = requireAssistant(yield* session.context(sessionID)).content.find(
      (item) => item.type === "tool" && item.id === "call-snapshot",
    )
    if (tool?.type !== "tool" || tool.state.status !== "completed") throw new Error("Snapshot tool result missing")
    return tool.state.content
  })

  it.effect("analyzes local tool-result images through the analyzer for a text-only model on the wire", () =>
    Effect.gen(function* () {
      const session = yield* setup
      catalogModel = fakeCatalogModel(["text"])
      imageAnalyzerConfig = new ConfigImageAnalyzer.Info({ model: "openai/gpt-6-luna#high" })
      yield* admit(session, "Capture the window")
      responses = [reply.tool("call-snapshot", "snapshot", {}), reply.text("Seen", "text-snapshot")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const body = (yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(requests[1])).body
      expect(JSON.stringify(body.messages)).not.toContain("image_url")
      const toolMessage = body.messages.find((message) => message.role === "tool")
      expect(toolMessage).toMatchObject({ role: "tool", tool_call_id: "call-snapshot" })
      expect(toolMessage?.content).toContain("Captured window")
      expect(toolMessage?.content).toContain("[Image Analysis: window.png (image/png) — FAILED]")
      expect(toolMessage?.content).toContain(
        "Automated vision analysis failed: vision model not configured or unavailable",
      )
      expect(yield* snapshotToolContent).toEqual([
        { type: "text", text: "Captured window" },
        { type: "file", uri: expect.stringMatching(/^data:image\/png;base64,/), mime: "image/png", name: "window.png" },
      ])
    }),
  )

  it.effect("passes local tool-result images natively to a multimodal model on the wire", () =>
    Effect.gen(function* () {
      const session = yield* setup
      catalogModel = fakeCatalogModel(["text", "image"])
      imageAnalyzerConfig = new ConfigImageAnalyzer.Info({ model: "openai/gpt-6-luna#high" })
      yield* admit(session, "Capture the window")
      responses = [reply.tool("call-snapshot", "snapshot", {}), reply.text("Seen", "text-snapshot")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const body = (yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(requests[1])).body
      expect(body.messages.find((message) => message.role === "tool")).toEqual({
        role: "tool",
        tool_call_id: "call-snapshot",
        content: "Captured window",
      })
      expect(JSON.stringify(body.messages)).toContain("image_url")
      expect(JSON.stringify(body.messages)).not.toContain("[Image Analysis:")
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Echo this")

      responses = [reply.tool("call-echo", "echo", { text: "hello" }), reply.text("Done", "text-final")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual([
        "user",
        "system",
        "assistant",
        "tool",
      ])
      expect(authorizations).toMatchObject([{ sessionID, callID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Echo this" },
        sessionStateNotice,
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
      const events = yield* EventRuntime.Service
      yield* admit(session, "Echo this")

      responses = [reply.tool("call-echo", "echo", { text: "hello" }), reply.text("Fixture response", "text-fixture")]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: CatalogModel.ID.make("replacement"), providerID: Provider.ID.make("fake") },
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
        requireAssistant((yield* session.context(sessionID)).slice(0, 3)).content.filter(
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

      expect(requests[0]?.messages[2]?.content.filter((content) => content.type === "reasoning")).toEqual([
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

      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual([
        "user",
        "system",
        "assistant",
        "user",
      ])
      expect(
        requests[0]?.messages[2]?.content.filter(
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

  it.effect("materializes Codex opaque state from effective store false even under stored configuration", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = codexModel
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_state: "stored" })
      yield* admit(session, "Codex first input")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "codex-opaque" }),
        LLMEvent.reasoningEnd({
          id: "codex-opaque",
          providerMetadata: {
            openai: {
              opaqueCompactionItem: { type: "compaction", id: "cmp_codex", encrypted_content: "codex-private-state" },
            },
          },
        }),
        LLMEvent.textStart({ id: "codex-first" }),
        LLMEvent.textDelta({ id: "codex-first", text: "Continue" }),
        LLMEvent.textEnd({ id: "codex-first" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* admit(session, "Codex next input")
      response = reply.text("Done", "codex-next")
      yield* session.resume(sessionID)
      expect(requests[1]?.model.route.defaults.providerOptions?.openai?.store).toBe(false)
      expect(JSON.stringify(requests[1]?.messages)).toContain("codex-private-state")
    }),
  )

  it.effect("materializes catalog Copilot Responses opaque state from effective store false", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({
        id: "gpt-5.5",
        provider: "github-copilot",
        route: {
          ...OpenAIResponses.route.with({
            id: "ai-sdk:@ai-sdk/github-copilot",
            provider: "github-copilot",
            providerOptions: { openai: { store: true }, copilot: { store: false } },
            limits: testLimits,
          }),
          providerMetadataKey: "copilot",
        },
      })
      efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_state: "stored" })
      yield* admit(session, "First Copilot input")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "copilot-opaque" }),
        LLMEvent.reasoningEnd({
          id: "copilot-opaque",
          providerMetadata: {
            copilot: {
              opaqueCompactionItem: {
                type: "compaction",
                id: "cmp_copilot",
                encrypted_content: "copilot-private-state",
              },
            },
          },
        }),
        LLMEvent.textStart({ id: "copilot-first" }),
        LLMEvent.textDelta({ id: "copilot-first", text: "Continue" }),
        LLMEvent.textEnd({ id: "copilot-first" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* admit(session, "Second Copilot input")
      response = reply.text("Done", "copilot-next")
      yield* session.resume(sessionID)
      expect(JSON.stringify(requests[1]?.messages)).toContain("copilot-private-state")
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
        sessionStateNotice,
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

  it.effect("publishes a fast tool's durable success while a parallel sibling remains running", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-slow", name: "echo", input: { text: "blocked sibling" } }),
          LLMEvent.toolCall({ id: "call-fast", name: "snapshot", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        reply.text("Done", "text-after-parallel"),
      ]
      const success = yield* events.subscribe(SessionEvent.Tool.Success).pipe(
        Stream.filter((event) => event.data.sessionID === sessionID && event.data.callID === "call-fast"),
        Stream.runHead,
        Effect.forkScoped,
      )
      yield* admit(session, "Settle independent tools")
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      expect(yield* Fiber.join(success).pipe(Effect.timeout("2 seconds"))).toMatchObject({
        _tag: "Some",
        value: { data: { callID: "call-fast" } },
      })
      const messages = yield* session.messages({ sessionID })
      const tools = messages.flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      )
      expect(tools.find((part) => part.id === "call-fast")?.state.status).toBe("completed")
      expect(tools.find((part) => part.id === "call-slow")?.state.status).toBe("running")
      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined
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
      expect((yield* session.context(sessionID)).slice(0, 4)).toMatchObject([
        { type: "user", text: "Echo twice" },
        sessionStateNotice,
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

      expect((yield* session.context(sessionID)).slice(0, 4)).toMatchObject([
        { type: "user", text: "Echo twice" },
        sessionStateNotice,
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

  it.effect("ends a tool continuation request with the provider-issued tool result and session header", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Read through a held provider run")
      const callID = `cursor_${sessionID}_3`

      responses = [reply.tool(callID, "echo", { text: "held" }), reply.text("Done", "text-held-done")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.http?.headers?.["X-Session-Id"]).toBe(sessionAffinity)
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        content: [{ type: "tool-result", id: callID, result: { type: "text", value: "held" } }],
      })
    }),
  )

  it.effect("executes and carries each of several identical repeated tool calls into the next request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Read the same thing repeatedly")

      responses = [
        reply.tool("call-repeat-1", "echo", { text: "same" }),
        reply.tool("call-repeat-2", "echo", { text: "same" }),
        reply.text("Saw both reads", "text-repeat-done"),
      ]

      yield* session.resume(sessionID)

      // Two distinct provider calls with byte-identical input must both execute; the
      // runtime suppresses nothing, so a deliberate repeated read still reaches the tool.
      expect(executions).toEqual(["same", "same"])
      expect(requests).toHaveLength(3)
      // The second request must carry the first result so the model can see what it read.
      expect(requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "tool-result",
                id: "call-repeat-1",
                result: { type: "text", value: "same" },
              }),
            ]),
          }),
        ]),
      )
      expect(requests[2]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "tool-result",
                id: "call-repeat-2",
                result: { type: "text", value: "same" },
              }),
            ]),
          }),
        ]),
      )
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
        sessionStateNotice,
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
        "system",
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
      const events = yield* EventRuntime.Service
      yield* admit(session, "Recover interrupted tool")
      yield* SessionPending.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: { id: CatalogModel.ID.make("fake-model"), providerID: Provider.ID.make("fake") },
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
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "system",
      ])
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
      const events = yield* EventRuntime.Service
      yield* admit(session, "Recover interrupted hosted tool")
      yield* SessionPending.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: { id: CatalogModel.ID.make("fake-model"), providerID: Provider.ID.make("fake") },
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
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual(["user", "assistant", "system"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: undefined,
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      yield* admit(session, "Recover interrupted tool input")
      yield* SessionPending.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: { id: CatalogModel.ID.make("fake-model"), providerID: Provider.ID.make("fake") },
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
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "system",
      ])
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
      const events = yield* EventRuntime.Service
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
      const events = yield* EventRuntime.Service
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
        "x-session-affinity": sessionAffinity,
        "X-Session-Id": sessionAffinity,
        "User-Agent": `ycoding/${InstallationVersion}`,
        "x-ycoding-project": Project.ID.global,
        "x-ycoding-session": sessionID,
        "x-ycoding-client": "cli",
      })
    }),
  )

  it.effect("adds the provider session header only to that provider's model requests", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({
        id: "big-pickle",
        provider: Provider.ID.opencode,
        route: OpenAIChat.route.with({ limits: testLimits }),
      })
      yield* admit(session, "Run provider-scoped request")

      yield* session.resume(sessionID)

      expect(requests[0]?.http?.headers).toMatchObject({
        "x-opencode-session": sessionAffinity,
        "User-Agent": `ycoding/${InstallationVersion}`,
      })
      // The request for another provider in "adds session correlation headers to model requests"
      // asserts the exact header map, so it is the no-leak proof for this header.
    }),
  )

  it.effect("adds the parent session header to child model requests", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const parentID = Session.ID.make("ses_runner_parent")
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
      // Concurrent Sessions never pool their request rate under one provider key.
      expect(namespaces[0]).not.toBe(namespaces[1])
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

  it.effect("preserves explicit raw OpenRouter Messages effort across variant changes on the final wire", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const entry = CatalogModel.Info.make({
        id: CatalogModel.ID.make("anthropic/claude-opus-5"),
        modelID: CatalogModel.ID.make("anthropic/claude-opus-5"),
        providerID: Provider.ID.make("anthropic"),
        name: "Raw effort fixture",
        package: Provider.aisdk("@ai-sdk/anthropic"),
        settings: { apiKey: "fixture", baseURL: "https://openrouter.ai/api/v1" },
        headers: {},
        body: { output_config: { effort: "low" } },
        variants: ["low", "high"].map((id) => ({ id: CatalogModel.VariantID.make(id), settings: { effort: id } })),
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        status: "active",
        enabled: true,
        limit: testLimits,
        cost: [],
        time: { released: 0 },
      })
      catalogModel = entry
      const wires: Record<string, unknown>[] = []
      for (const variant of ["low", "high"] as const) {
        const ref = CatalogModel.Ref.make({
          id: entry.id,
          providerID: entry.providerID,
          variant: CatalogModel.VariantID.make(variant),
        })
        currentModel = yield* SessionRunnerModel.fromCatalogModel(
          yield* SessionRunnerModel.withVariant(entry, ref.variant),
        )
        yield* events.publish(SessionEvent.ModelSelected, { sessionID, model: ref })
        yield* admit(session, `Input ${variant}`)
        yield* session.resume(sessionID)
        yield* LLMClient.generate(requests.at(-1)!).pipe(
          Effect.provide(LLMClient.configured()),
          Effect.provideService(RequestExecutor.Service, {
            execute: (request) =>
              Effect.gen(function* () {
                const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
                expect(web.url).toBe("https://openrouter.ai/api/v1/messages")
                const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                  yield* Effect.promise(() => web.json()),
                )
                wires.push(body)
                expect(body.output_config).toEqual({ effort: "low" })
                expect(
                  (body.messages as Record<string, unknown>[]).some(
                    (message) => message.role === "system" && "output_config" in message,
                  ),
                ).toBe(false)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
                    { headers: { "content-type": "text/event-stream" } },
                  ),
                )
              }),
          }),
        )
      }
      expect(wires).toHaveLength(2)
    }),
  )

  it.effect("defers Anthropic tool-only effort changes to new user input and preserves an omitted baseline", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const events = yield* EventRuntime.Service
      const entry = CatalogModel.Info.make({
        id: CatalogModel.ID.make("claude-opus-5-5"),
        modelID: CatalogModel.ID.make("claude-opus-5-5"),
        providerID: Provider.ID.make("anthropic"),
        name: "Effort fixture",
        package: Provider.aisdk("@ai-sdk/anthropic"),
        settings: { apiKey: "fixture-key" },
        headers: {},
        body: {},
        variants: [{ id: CatalogModel.VariantID.make("low"), settings: { effort: "low" } }],
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        status: "active",
        enabled: true,
        limit: testLimits,
        cost: [],
        time: { released: 0 },
      })
      catalogModel = entry
      const select = (variant?: "low") =>
        Effect.gen(function* () {
          const ref = CatalogModel.Ref.make({
            providerID: entry.providerID,
            id: entry.id,
            ...(variant === undefined ? {} : { variant: CatalogModel.VariantID.make(variant) }),
          })
          const selected = yield* SessionRunnerModel.withVariant(entry, ref.variant)
          currentModel = yield* SessionRunnerModel.fromCatalogModel(selected)
          yield* events.publish(SessionEvent.ModelSelected, { sessionID, model: ref })
        })
      yield* select()
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      responses = [reply.tool("call-effort", "echo", { text: "Result" }), reply.text("Tool complete", "tool-done")]
      yield* admit(session, "Use a tool")
      const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)
      yield* select("low")
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(running)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined
      const toolOnly = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(requests.at(-1)!)
      expect(toolOnly.body.output_config).toBeUndefined()
      expect(
        toolOnly.body.messages.filter((message) => message.role === "system" && message.output_config),
      ).toHaveLength(0)
      responses = undefined
      yield* admit(session, "New input at low effort")
      yield* session.resume(sessionID)
      const changed = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(requests.at(-1)!)
      expect(changed.body.output_config).toBeUndefined()
      expect(changed.body.messages.filter((message) => message.role === "system" && message.output_config)).toEqual([
        { role: "system", content: [], output_config: { effort: "low" } },
      ])
      yield* select()
      yield* admit(session, "Return to model default")
      yield* session.resume(sessionID)
      const reset = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(requests.at(-1)!)
      expect(reset.body.output_config).toBeUndefined()
      expect(reset.body.messages.filter((message) => message.role === "system" && message.output_config)).toEqual([
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "system", content: [], output_config: { effort: "medium" } },
      ])
      expect(new Set(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).size).toBe(1)
    }),
  )

  for (const scenario of [
    {
      provider: "openai",
      id: "gpt-6.1-sol",
      package: "@ai-sdk/openai",
      option: "reasoningEffort",
      mechanism: "configuration_update",
    },
    {
      provider: "openai",
      id: "gpt-6-astra",
      package: "@ai-sdk/openai",
      option: "reasoningEffort",
      mechanism: "configuration_update",
    },
    {
      provider: "anthropic",
      id: "claude-opus-5-5",
      package: "@ai-sdk/anthropic",
      option: "effort",
      mechanism: "output_config",
    },
    {
      provider: "anthropic",
      id: "claude-opus-4-8",
      package: "@ai-sdk/anthropic",
      option: "effort",
      mechanism: undefined,
    },
    {
      provider: "openrouter",
      id: "openai/gpt-6-sol",
      package: "@ycoding-ai/ai/providers/openrouter",
      option: "effort",
      mechanism: "configuration_update",
    },
    {
      provider: "openrouter",
      id: "anthropic/claude-opus-5",
      package: "@ycoding-ai/ai/providers/openrouter",
      option: "effort",
      mechanism: "configuration_update",
    },
  ])
    it.effect(`keeps ${scenario.id} Session cache identity across durable effort changes and replay`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        const events = yield* EventRuntime.Service
        catalogModel = CatalogModel.Info.make({
          id: CatalogModel.ID.make(scenario.id),
          modelID: CatalogModel.ID.make(scenario.id),
          providerID: Provider.ID.make(scenario.provider),
          name: "Effort fixture",
          package: scenario.package.startsWith("@ycoding-ai/") ? scenario.package : Provider.aisdk(scenario.package),
          settings: { apiKey: "fixture-key" },
          headers: {},
          body: {},
          variants: ["low", "high"].map((id) => ({
            id: CatalogModel.VariantID.make(id),
            settings: scenario.provider === "openrouter" ? { reasoning: { effort: id } } : { [scenario.option]: id },
          })),
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          status: "active",
          enabled: true,
          limit: testLimits,
          cost: [],
          time: { released: 0 },
        })
        const select = (variant: "low" | "high" | undefined) =>
          Effect.gen(function* () {
            const ref = CatalogModel.Ref.make({
              providerID: catalogModel!.providerID,
              id: catalogModel!.id,
              ...(variant === undefined ? {} : { variant: CatalogModel.VariantID.make(variant) }),
            })
            currentModel = yield* SessionRunnerModel.fromCatalogModel(
              yield* SessionRunnerModel.withVariant(catalogModel!, ref.variant),
            )
            yield* events.publish(SessionEvent.ModelSelected, { sessionID, model: ref })
          })
        const bodies: Record<string, unknown>[] = []
        const controls: Record<string, unknown>[] = []
        for (const [index, variant] of (["low", "high", "high", "low"] as const).entries()) {
          response = reply.textWithResponse(`Answer ${index}`, `effort-answer-${index}`, `resp_effort_${index}`)
          yield* select(variant)
          yield* admit(session, `Input ${index}`)
          if (index === 1) {
            streamGate = yield* Deferred.make<void>()
            streamStarted = yield* Deferred.make<void>()
            const running = yield* session.resume(sessionID).pipe(Effect.forkChild)
            yield* Deferred.await(streamStarted)
            const context = yield* SessionContext.Service
            const modelRequests = yield* SessionModelRequest.Service
            const loaded = yield* context.load(yield* context.select(sessionID))
            const selected = yield* SessionRunnerModel.withVariant(catalogModel!, CatalogModel.VariantID.make("low"))
            const lowModel = yield* SessionRunnerModel.fromCatalogModel(selected)
            const control = yield* modelRequests.prepare({
              context: loaded,
              step: 1,
              disableContinuation: true,
              model: {
                ...loaded.model,
                model: lowModel,
                ref: { ...loaded.model.ref, variant: CatalogModel.VariantID.make("low") },
              },
            })
            controls.push((yield* LLMClient.prepare(control.request)).body as Record<string, unknown>)
            yield* Deferred.succeed(streamGate, undefined)
            yield* Fiber.join(running)
            streamGate = undefined
            streamStarted = undefined
          }
          if (index !== 1) yield* session.resume(sessionID)
          const request = requests.at(-1)!
          const body = (yield* LLMClient.prepare(request)).body as Record<string, unknown>
          bodies.push(body)
          const serialized = JSON.stringify(body)
          if (index > 0 && !body.previous_response_id) expect(serialized).toContain(scenario.mechanism ?? '"effort"')
          const options = body[scenario.provider === "anthropic" ? "output_config" : "reasoning"]
          expect(options).toMatchObject({ effort: scenario.mechanism === undefined ? variant : "low" })
        }
        expect(new Set(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).size).toBe(1)
        const ledger = yield* SessionProviderRequest.Service
        expect(new Set((yield* ledger.list(sessionID)).map((record) => record.promptCacheKey)).size).toBe(1)
        const controlMessages = controls[0]![scenario.provider === "anthropic" ? "messages" : "input"] as Record<
          string,
          unknown
        >[]
        const changedMessages = bodies[1]![scenario.provider === "anthropic" ? "messages" : "input"] as Record<
          string,
          unknown
        >[]
        const change = changedMessages.findIndex(
          (item) => item.type === "configuration_update" || "output_config" in item,
        )
        const prefixLength = change === -1 ? controlMessages.length : change
        expect(JSON.stringify(changedMessages.slice(0, prefixLength))).toBe(
          JSON.stringify(controlMessages.slice(0, prefixLength)),
        )
        if (scenario.mechanism !== undefined) {
          const final = bodies[3]![scenario.provider === "anthropic" ? "messages" : "input"] as Record<
            string,
            unknown
          >[]
          const updates = final.filter((item) =>
            scenario.provider === "anthropic"
              ? item.role === "system" && "output_config" in item
              : item.type === "configuration_update",
          )
          expect(updates).toHaveLength(2)
          expect(updates[0]).toMatchObject(
            scenario.provider === "anthropic"
              ? { output_config: { effort: "high" } }
              : { reasoning: { effort: "high" } },
          )
          expect(updates[1]).toMatchObject(
            scenario.provider === "anthropic" ? { output_config: { effort: "low" } } : { reasoning: { effort: "low" } },
          )
        }
        if (scenario.provider === "openai") {
          expect(bodies[2]?.previous_response_id).toBe("resp_effort_1")
          expect(JSON.stringify(bodies[2]?.input)).toContain("Input 2")
          expect(JSON.stringify(bodies[2]?.input)).not.toContain("Input 1")
        }
        yield* replaySessionProjection(sessionID)
        const context = yield* SessionContext.Service
        const modelRequests = yield* SessionModelRequest.Service
        const loaded = yield* context.load(yield* context.select(sessionID))
        const reconstructed = yield* modelRequests.prepare({ context: loaded, step: 1, disableContinuation: true })
        const replayed = yield* LLMClient.prepare(reconstructed.request)
        expect(JSON.stringify(replayed.body)).toContain('"effort":"low"')
        if (scenario.mechanism !== undefined) {
          const body = replayed.body as Record<string, unknown>
          const messages = body[scenario.provider === "anthropic" ? "messages" : "input"] as Record<string, unknown>[]
          expect(
            messages.filter((item) => item.type === "configuration_update" || "output_config" in item),
          ).toHaveLength(2)
        }
        catalogModel = {
          ...catalogModel!,
          variants: catalogModel!.variants?.map((variant) =>
            variant.id === "low"
              ? {
                  ...variant,
                  settings:
                    scenario.provider === "openrouter"
                      ? { reasoning: { effort: "medium" } }
                      : { [scenario.option]: "medium" },
                }
              : variant,
          ),
        }
        yield* select("low")
        yield* admit(session, "Use the edited catalog effort")
        yield* session.resume(sessionID)
        const edited = (yield* LLMClient.prepare(requests.at(-1)!)).body as Record<string, unknown>
        const editedMessages = edited[scenario.provider === "anthropic" ? "messages" : "input"] as Record<
          string,
          unknown
        >[]
        const latest = editedMessages.findLast(
          (item) => item.type === "configuration_update" || "output_config" in item,
        )
        const selectedEffort =
          latest?.[scenario.provider === "anthropic" ? "output_config" : "reasoning"] ??
          edited[scenario.provider === "anthropic" ? "output_config" : "reasoning"]
        expect(selectedEffort).toMatchObject({ effort: "medium" })
        if (scenario.id === "gpt-6-astra") {
          yield* select(undefined)
          yield* admit(session, "Use the provider default without guessing it")
          yield* session.resume(sessionID)
          const omitted = (yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(requests.at(-1)!)).body
          expect(omitted.reasoning?.effort).toBeUndefined()
          expect(omitted.input.some((item) => "type" in item && item.type === "configuration_update")).toBe(false)
        }
        yield* select("high")
        compactionSummary = true
        yield* session.compact({ sessionID })
        yield* admit(session, "After compaction")
        yield* session.resume(sessionID)
        const compacted = (yield* LLMClient.prepare(requests.at(-1)!)).body as Record<string, unknown>
        expect(compacted[scenario.provider === "anthropic" ? "output_config" : "reasoning"]).toMatchObject({
          effort: "high",
        })
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

      const ledger = yield* SessionProviderRequest.Service
      const namespaces = [
        ...(yield* ledger.list(sessionID)).map((record) => record.promptCacheKey),
        ...(yield* ledger.list(otherSessionID)).map((record) => record.promptCacheKey),
      ]
      expect(namespaces).toHaveLength(2)
      expect(namespaces[0]).not.toBe(namespaces[1])
      expect(requests[1]?.system.map((part) => part.text)).toEqual(["Session-specific hook output"])
      expect(requests[1]?.tools.map((tool) => tool.name)).not.toContain("echo")
    }),
  )

  it.effect("shares a stable cache namespace across long session IDs with Session-scoped wire keys", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const longSessionID = Session.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = Session.ID.make(`ses_${"b".repeat(64)}`)
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

      const ledger = yield* SessionProviderRequest.Service
      const namespaces = [
        ...(yield* ledger.list(longSessionID)).map((record) => record.promptCacheKey),
        ...(yield* ledger.list(otherLongSessionID)).map((record) => record.promptCacheKey),
      ]
      expect(namespaces).toHaveLength(2)
      expect(namespaces[0]).toBe(namespaces[1])
      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys[0]).not.toBe(keys[1])
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
        sessionStateNotice,
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
      expect(nonVolatileMessages(requests[1]).map((message) => message.role)).toEqual([
        "user",
        "system",
        "assistant",
        "tool",
      ])
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Call defect" },
        sessionStateNotice,
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
              Effect.fail(new Permission.BlockedError({ rules: [], permission: "blocked", resources: ["*"] })).pipe(
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
        sessionStateNotice,
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

  it.effect("returns a request-local permission rejection and continues execution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      yield* registry.register(
        {
          declined: Tool.make({
            description: "Reject one permission request",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die(new Permission.DeclinedError()),
          }),
        },
        { codemode: false },
      )
      yield* admit(session, "Call declined")

      responses = [reply.tool("call-declined", "declined", {}), reply.text("Fixture response", "text-fixture")]

      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        sessionStateNotice,
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Permission request was rejected. This action did not run." } },
            },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("returns a delegated permission decline to the model and continues", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const registry = yield* ToolRegistry.Service
      yield* registry.register(
        {
          delegated_declined: Tool.make({
            description: "Fail because the delegated external client declined approval",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () =>
              Effect.die(new Permission.DeclinedError({
                source: { kind: "dots-delegation", anchorSessionID: sessionID, delegationID: "runner_delegation", revision: 1, exchangeID: "runner_decision" },
              })),
          }),
        },
        { codemode: false },
      )
      yield* admit(session, "Call delegated declined")

      responses = [reply.tool("call-delegated-declined", "delegated_declined", {}), reply.text("Fixture response", "text-fixture")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call delegated declined" },
        sessionStateNotice,
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-delegated-declined",
              state: { status: "error", error: { message: "Permission request was rejected. This action did not run." } },
            },
          ],
        },
        { type: "assistant", finish: "stop" },
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
              Effect.fail(new Permission.CorrectedError({ feedback: "Use another tool" })).pipe(
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
        sessionStateNotice,
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
        sessionStateNotice,
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
        sessionStateNotice,
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

  it.effect("returns a cancelled question outcome and continues execution", () =>
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
      yield* admit(session, "Ask then continue independent work")

      responses = [reply.tool("call-question", "question", {}), reply.text("Fixture response", "text-fixture")]

      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then continue independent work" },
        sessionStateNotice,
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { message: "This question was dismissed or superseded without an answer" } },
            },
          ],
        },
        { type: "assistant", finish: "stop" },
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
        sessionStateNotice,
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
        sessionStateNotice,
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
        sessionStateNotice,
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = reply.text("Recovered blocked tool", "text-recovered-blocked-tool")
      yield* session.resume(sessionID)
      expect(nonVolatileMessages(requests[0]).map((message) => message.role)).toEqual([
        "user",
        "system",
        "assistant",
        "tool",
      ])
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
        sessionStateNotice,
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
        sessionStateNotice,
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
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
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
        role: "system",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(requests[2]?.tools).toEqual([])
      expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual([...requests[1]!.messages])
      expect(
        requests[2]!.messages.filter((message) =>
          message.content.some((part) => part.type === "text" && part.text.includes("MAXIMUM STEPS REACHED")),
        ),
      ).toHaveLength(1)
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        sessionStateNotice,
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        {
          type: "system",
          metadata: { contextSource: "step-limit" },
          text: expect.stringContaining("MAXIMUM STEPS REACHED"),
        },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
        { type: "assistant", content: [{ type: "text", text: "Terminal answer" }] },
      ])
    }),
  )

  for (const boundary of ["none", "compaction", "fork"] as const) {
    it.effect(`appends a step-limit reset after new input (${boundary})`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        const agents = yield* Agent.Service
        const events = yield* EventRuntime.Service
        yield* agents.transform((editor) =>
          editor.update(Agent.ID.make("build"), (agent) => {
            agent.steps = 2
          }),
        )
        responses = [reply.tool("call-limit", "echo", { text: "done" }), reply.text("At limit", "text-at-limit")]
        yield* admit(session, "Reach limit")
        yield* session.resume(sessionID)
        expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain("MAXIMUM STEPS REACHED")
        if (boundary === "compaction") {
          yield* events.publish(SessionEvent.Compaction.StartedV1, { sessionID, reason: "manual", recent: "" })
          yield* events.publish(SessionEvent.Compaction.EndedV1, {
            sessionID,
            reason: "manual",
            recent: "",
            text: "Prior work reached the maximum-step constraint.",
          })
        }
        yield* replaySessionProjection(sessionID)
        const targetID = boundary === "fork" ? (yield* session.fork({ sessionID })).id : sessionID
        responses = [reply.text("New work", "text-new-work")]
        yield* session.prompt({ sessionID: targetID, text: "New task", resume: false })
        yield* session.resume(targetID)
        expect(requests[2]!.tools.map((tool) => tool.name)).toContain("echo")
        expect(requests[2]!.messages.at(-1)).toMatchObject({
          role: "system",
          content: [
            { type: "text", text: expect.stringContaining("newly promoted user input reset the step allowance") },
          ],
        })
        if (boundary === "none")
          expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual([...requests[1]!.messages])
        expect(
          (yield* session.context(targetID)).filter(
            (message) => message.type === "system" && message.metadata?.contextSource === "step-limit",
          ),
        ).toMatchObject([
          ...(boundary !== "compaction" ? [{ text: expect.stringContaining("MAXIMUM STEPS REACHED") }] : []),
          { text: expect.stringContaining("newly promoted user input reset the step allowance") },
        ])
      }),
    )
  }

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
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

  const dotsPeer = (itemID: string) => ({
    origin: "dots-peer",
    profile: "synthetic-profile",
    dotID: "dot_synthetic",
    threadID: "thread_synthetic",
    itemID,
  })

  const promoteDuringFirstStep = (session: Session.Interface, inputs: ReadonlyArray<Effect.Effect<unknown, unknown>>) =>
    Effect.gen(function* () {
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      for (const input of inputs) yield* input
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined
    })

  it.effect("keeps the configured step allowance when only Dots peer input promotes", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Start work")
      responses = [
        reply.tool("call-before-peer", "echo", { text: "before" }),
        reply.tool("call-after-peer", "echo", { text: "after" }),
        reply.text("Terminal answer", "text-peer-terminal"),
      ]

      yield* promoteDuringFirstStep(session, [
        session.synthetic({
          sessionID,
          text: "Peer reply one",
          description: "Dots message from Synthetic Dot",
          metadata: { dots: dotsPeer("peer-item-one") },
          delivery: "steer",
        }),
        session.synthetic({
          sessionID,
          text: "Peer reply two",
          description: "Dots message from Synthetic Dot",
          metadata: { dots: dotsPeer("peer-item-two") },
          delivery: "steer",
        }),
      ])

      expect(requests).toHaveLength(3)
      expect(JSON.stringify(requests[1]!.messages)).toContain("Peer reply two")
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      expect(nonVolatileMessages(requests[1]).at(-1)).toMatchObject({
        role: "system",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(JSON.stringify(requests[1]!.messages)).not.toContain("reset the step allowance")
      expect(requests[2]?.tools).toEqual([])
      expect(executions).toEqual(["before"])
      expect(yield* session.context(sessionID)).toContainEqual(
        expect.objectContaining({
          type: "assistant",
          content: [
            expect.objectContaining({
              type: "tool",
              id: "call-after-peer",
              state: expect.objectContaining({ status: "error" }),
            }),
          ],
        }),
      )
    }),
  )

  it.effect("resets the step allowance when Dots peer input promotes with user steering", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Start work")
      responses = [
        reply.tool("call-before-mixed", "echo", { text: "before" }),
        reply.tool("call-after-mixed", "echo", { text: "after" }),
        reply.text("Fixture response", "text-mixed"),
      ]

      yield* promoteDuringFirstStep(session, [
        session.synthetic({
          sessionID,
          text: "Peer reply",
          description: "Dots message from Synthetic Dot",
          metadata: { dots: dotsPeer("peer-item-mixed") },
          delivery: "steer",
        }),
        session.prompt({ sessionID, text: "Change direction" }),
      ])

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("resets the step allowance when an ordinary synthetic input promotes without Dots attribution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Start work")
      responses = [
        reply.tool("call-before-synthetic", "echo", { text: "before" }),
        reply.tool("call-after-synthetic", "echo", { text: "after" }),
        reply.text("Fixture response", "text-synthetic"),
      ]

      yield* promoteDuringFirstStep(session, [
        session.synthetic({ sessionID, text: "Background work completed", delivery: "steer" }),
      ])

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
        sessionStateNotice,
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
        sessionStateNotice,
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
        sessionStateNotice,
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.content-filter" },
          cost: 0,
          tokens: { input: 8, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
          diagnostics: {
            contextBreakdown: expect.objectContaining({ user: expect.any(Number), system: expect.any(Number) }),
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
        contextBreakdown: assistant.diagnostics?.contextBreakdown,
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

  it.effect("withholds mixed-account Step provenance after empty signed reasoning overflow recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = Model.make({
        id: "fake-model",
        provider: "openai",
        route: OpenAIResponses.route.with({ limits: testLimits }),
      })
      yield* admit(session, "Establish completed context for recovery")
      yield* session.resume(sessionID)
      requests.length = 0
      compactionSummary = true
      modelResolveHook = Effect.sync(() => {
        if (requests.length > 0) currentAccountIdentityDigest = "b".repeat(64)
      })
      const reasoning = (id: string, text: string, ciphertext: string) => [
        LLMEvent.reasoningStart({ id }),
        LLMEvent.reasoningDelta({
          id,
          text,
          providerMetadata: { openai: { itemId: id, reasoningEncryptedContent: ciphertext } },
        }),
        LLMEvent.reasoningEnd({ id }),
      ]
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          ...reasoning("rs_account_a", "", "cipher-account-a"),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ]),
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          ...reasoning("rs_account_b", "Second account reasoning", "cipher-account-b"),
          ...reply
            .text("Recovered across the safe boundary", "recovered-account")
            .filter((event) => event.type !== "step-start"),
        ]),
      ]
      yield* admit(session, "Recover with account-aware provenance")
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      const records = yield* (yield* SessionProviderRequest.Service).list(sessionID)
      expect(records.filter((record) => record.source === "step")).toHaveLength(2)
      expect(records.filter((record) => record.source === "step").at(-1)?.connectionIdentityDigest).toBeUndefined()
      const history = JSON.stringify(yield* session.context(sessionID))
      expect(history).toContain("Second account reasoning")
      expect(history).toContain("cipher-account-a")
      expect(history).toContain("cipher-account-b")
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
        sessionStateNotice,
        { type: "assistant" },
        { type: "compaction", status: "completed" },
        sessionStateNotice,
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("reprepares when background compaction activates before provider execution", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const hooks = yield* PluginHooks.Service
      const events = yield* EventRuntime.Service
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
        const recorded = event as EventRuntime.Payload<typeof SessionEvent.ProviderRequestRecorded>
        if (recorded.data.sessionID !== otherSessionID) return Effect.void
        return Deferred.succeed(providerLedgerBlocked, undefined).pipe(
          Effect.andThen(Deferred.await(providerLedgerGate)),
        )
      })
      const blocker = yield* providerRequests.next({
        sessionID: otherSessionID,
        source: "title",
        agent: Agent.ID.make("build"),
        model: CatalogModel.Ref.make({ id: CatalogModel.ID.make("gpt-5.6"), providerID: Provider.ID.make("openai") }),
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
        sessionStateNotice,
        { type: "assistant", finish: "stop" },
        { type: "user", text: "Overflow twice" },
        { type: "compaction", status: "completed" },
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

  it.effect("does not admit mandatory compaction when fixed request input alone exceeds its target", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = recoveryModel
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.system = [SystemPart.make("S".repeat(120_000))]
        }),
      )
      yield* admit(session, "Current request")
      yield* session.resume(sessionID)

      const db = (yield* Database.Service).db
      expect(requests).toHaveLength(1)
      expect(yield* db.select({ id: SessionCompactionJobTable.id }).from(SessionCompactionJobTable).all()).toEqual([])
      expect(
        yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.parent_id, sessionID)).all(),
      ).toEqual([])
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.compaction.admitted.2")
    }),
  )

  it.effect("surfaces provider overflow without futile compaction or retry", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = recoveryModel
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.system = [SystemPart.make("S".repeat(120_000))]
        }),
      )
      response = [LLMEvent.providerError({ message: "Prompt too long", classification: "context-overflow" })]
      yield* admit(session, "Current request")
      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toContain("Prompt too long")

      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.compaction.admitted.2")
      expect((yield* session.context(sessionID)).findLast((message) => message.type === "assistant")).toMatchObject({
        finish: "error",
        error: { type: "provider.unknown" },
      })
    }),
  )

  it.effect("does not recover provider overflow when there is no compactable history", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = recoveryModel
      response = [LLMEvent.providerError({ message: "Prompt too long", classification: "context-overflow" })]
      yield* admit(session, "First prompt")
      expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toContain("Prompt too long")
      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.compaction.admitted.2")
    }),
  )

  it.effect("admits mandatory compaction when earlier conversation history can reduce the request", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      currentModel = Model.make({
        id: "history-recovery",
        provider: "fake",
        route: OpenAIChat.route.with({ limits: { context: 7_000, output: 500 } }),
      })
      compactionSummary = true
      yield* admit(session, "Continue after history")
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).toContain("session.compaction.admitted.2")
      expect(
        (yield* session.context(sessionID)).some(
          (message) => message.type === "compaction" && message.status === "completed",
        ),
      ).toBe(true)
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
        sessionStateNotice,
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
        sessionStateNotice,
        { type: "assistant", finish: "error", error: { type: "provider.invalid-request", message: "Invalid request" } },
      ])
      expect(messages.find((message) => message.type === "user")?.time.consumed).toBeUndefined()
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.input.consumed.1")
    }),
  )

  it.effect("interrupting the retry backoff publishes the pending step terminal", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const eventRuntime = yield* EventRuntime.Service
      const scheduled = yield* Deferred.make<void>()
      const diagnostics: SessionCacheDiagnostics.Info[] = []
      const unsubscribe = yield* eventRuntime.listen((event) =>
        Effect.gen(function* () {
          if (event.type === SessionEvent.DiagnosticsUpdated.type)
            diagnostics.push((event as EventRuntime.Payload<typeof SessionEvent.DiagnosticsUpdated>).data.diagnostics)
          if (event.type === SessionEvent.RetryScheduled.type) yield* Deferred.succeed(scheduled, undefined)
        }),
      )
      yield* admit(session, "Interrupt retry backoff")
      responseStream = Stream.fail(providerUnavailable())

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(scheduled)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)

      // Every published Step.Started owes exactly one terminal step event, even when the retry
      // that owns it is interrupted before the attempt settles. This harness stubs the
      // execution layer, so the interrupted execution event itself is covered by
      // session-execution.test.ts and the TUI header reads durable status from here.
      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(assistant.time.completed).toBeDefined()
      expect((yield* session.snapshot(sessionID)).generationSpeed?.latest).toBeUndefined()
      expect((yield* session.snapshot(sessionID)).generationSpeed?.recent).toEqual([])
      expect(diagnostics.length).toBeGreaterThan(0)
      expect(diagnostics.every((value) => value.generationSpeed?.live?.sample === undefined)).toBe(true)
      expect(diagnostics.at(-1)?.generationSpeed).toEqual((yield* session.snapshot(sessionID)).generationSpeed)
      yield* unsubscribe
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.filter((event) => event.type === "session.step.started.1")).toHaveLength(1)
      expect(
        events.filter((event) => event.type === "session.step.ended.1" || event.type === "session.step.failed.1"),
      ).toHaveLength(1)
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
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes).toContain("session.retry.scheduled.1")
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.input.consumed.1")).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", time: { consumed: expect.anything() } },
        sessionStateNotice,
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

  for (const enabled of [true, false])
    it.effect(`records logical provider latency only with consent ${enabled}`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        const database = yield* Database.Service
        const events = yield* EventRuntime.Service
        const scheduled = yield* Deferred.make<void>()
        const unsubscribe = yield* events.listen((event) =>
          event.type === SessionEvent.RetryScheduled.type ? Deferred.succeed(scheduled, undefined) : Effect.void,
        )
        const consent = yield* TelemetryConsent.make(database.db)
        yield* consent.set({ enabled, noticeVersion: 1 })
        yield* admit(session, "Measure delayed retry")
        responseStreams = [
          Stream.fail(providerUnavailable()),
          Stream.fromEffect(TestClock.adjust("50 millis")).pipe(
            Stream.flatMap(() =>
              Stream.concat(
                Stream.fromIterable([
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.textStart({ id: "latency-text" }),
                  LLMEvent.textDelta({ id: "latency-text", text: "Done" }),
                  LLMEvent.textEnd({ id: "latency-text" }),
                ]),
                Stream.fromEffect(TestClock.adjust("1500 millis")).pipe(
                  Stream.flatMap(() =>
                    Stream.fromIterable([
                      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { outputTokens: 10 } }),
                      LLMEvent.finish({ reason: "stop" }),
                    ]),
                  ),
                ),
              ),
            ),
          ),
        ]
        const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
        yield* Deferred.await(scheduled)
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(run)
        yield* unsubscribe
        const ledger = yield* SessionProviderRequest.Service
        const timing = (yield* ledger.recentSteps(sessionID)).at(-1)?.timing
        expect(timing?.generatedTokens).toBe(10)
        expect(timing?.observedGenerationDurationNs).toBe(1_500_000_000)
        expect(timing?.receivedOutput).toBeUndefined()
        if (enabled) {
          expect(timing).toMatchObject({ firstOutputMs: 2050, totalMs: 3550, retryWaitMs: 2000 })
          return
        }
        expect(timing).not.toHaveProperty("firstOutputMs")
        expect(timing).not.toHaveProperty("totalMs")
        expect(timing).not.toHaveProperty("retryWaitMs")
      }),
    )

  it.effect("preserves logical request identity for pre-output Codex read retries", () =>
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
      expect(requests[1]?.id).toBe(requests[0]?.id)
    }),
  )

  it.effect("retries Codex transport failures outside response reading", () =>
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
        sessionStateNotice,
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

  it.effect("keeps exponential backoff when the provider delay is shorter", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Retry with a short provider delay")
      responseStream = Stream.fail(rateLimited(1_000))
      response = reply.text("Recovered", "short-retry-after-success")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("1999 millis")
      expect(requests).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(run)
      expect(requests).toHaveLength(2)
    }),
  )

  for (const delay of [120_000, 120_001])
    it.effect(`handles a provider retry-after of ${delay} milliseconds`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        yield* admit(session, "Respect the provider retry ceiling")
        const failure = rateLimited(delay)
        responseStream = Stream.fail(failure)
        response = reply.text("Recovered", "ceiling-retry-after-success")

        const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
        while (requests.length < 1) yield* Effect.yieldNow
        if (delay > 120_000) {
          expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
          expect(requests).toHaveLength(1)
        } else {
          yield* TestClock.adjust("119999 millis")
          expect(requests).toHaveLength(1)
          yield* TestClock.adjust("1 millis")
          yield* Fiber.join(run)
          expect(requests).toHaveLength(2)
        }
      }),
    )

  it.effect("retries a recognized provider error event before observable output", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Recover the server error")
      responses = [
        [LLMEvent.providerError({ message: "server_error: Please retry the request" })],
        reply.text("Recovered", "event-recovery"),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.id).toBe(requests[0]?.id)
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        finish: "stop",
        content: [{ type: "text", text: "Recovered" }],
      })
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.failed.1")).toHaveLength(0)
    }),
  )

  for (const kind of ["read", "internal", "event"] as const) {
    it.effect(`continues from durable tool results after a post-output ${kind} failure`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        currentModel = kind === "read" ? anthropicCacheModel : storedOpenAIResponsesModel
        efficiencyConfig = new ConfigEfficiency.Info({ openai_responses_continuation: "on" })
        yield* admit(session, "Finish the interrupted response")
        const failure =
          kind === "read"
            ? streamReadFailure()
            : new LLMError({
                module: "openai-responses",
                method: "stream",
                reason: classifyProviderFailure({ message: "server_error: Please retry the request" }),
              })
        responseStreams = [
          Stream.fromIterable(
            reply
              .tool("completed-before-failure", "echo", { text: "run once" })
              .filter((event) => !LLMEvent.is.stepFinish(event) && !LLMEvent.is.finish(event)),
          ).pipe(
            Stream.concat(
              kind === "event"
                ? Stream.make(LLMEvent.providerError({ message: failure.reason.message }))
                : Stream.fail(failure),
            ),
          ),
          Stream.fromIterable(reply.text("Recovered answer", "after-provider-failure")),
        ]

        yield* session.resume(sessionID)

        expect(requests).toHaveLength(2)
        expect(requests[1]?.id).not.toBe(requests[0]?.id)
        expect(requests[1]?.providerOptions?.openai).not.toHaveProperty("previousResponseId")
        expect(userTexts(requests[1])).toEqual(["Finish the interrupted response"])
        expect(requests[1]?.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "tool",
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "tool-result",
                  id: "completed-before-failure",
                  result: expect.objectContaining({ type: "text", value: "run once" }),
                }),
              ]),
            }),
          ]),
        )
        expect(executions).toEqual(["run once"])
        const assistants = (yield* session.context(sessionID)).filter((message) => message.type === "assistant")
        expect(assistants).toMatchObject([
          { finish: "error", error: { type: kind === "read" ? "provider.transport" : "provider.internal" } },
          { finish: "stop", content: [{ type: "text", text: "Recovered answer" }] },
        ])
        const providerRequests = yield* SessionProviderRequest.Service
        expect(yield* providerRequests.summary(sessionID)).toMatchObject({ logical: 2, physical: 2, helpers: 0 })
        expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
      }),
    )
  }

  it.effect("stops repeated post-output internal failures without a third logical request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Recover once")
      const failure = new LLMError({
        module: "openai-responses",
        method: "stream",
        reason: classifyProviderFailure({ message: "server_error: Please retry the request" }),
      })
      responseStreams = ["first", "recovery"].map((id) =>
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id }),
          LLMEvent.reasoningDelta({ id, text: "Thinking" }),
        ]).pipe(Stream.concat(Stream.fail(failure))),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(2)
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(2)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(2)
    }),
  )

  for (const outcome of ["resume", "interrupt", "retry-interrupt"] as const) {
    it.effect(`honors logical provider recovery backoff with ${outcome}`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        const runner = yield* SessionRunner.Service
        const clock = yield* Clock.Clock
        const sleeping = yield* Deferred.make<void>()
        const retrySleeping = yield* Deferred.make<void>()
        yield* admit(session, "Respect provider backoff")
        responseStreams = [
          ...(outcome === "retry-interrupt" ? [Stream.fail(providerUnavailable())] : []),
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.reasoningStart({ id: "before-backoff" }),
            LLMEvent.reasoningDelta({ id: "before-backoff", text: "Thinking" }),
          ]).pipe(
            Stream.concat(
              Stream.fail(
                new LLMError({
                  module: "test",
                  method: "stream",
                  reason: classifyProviderFailure({ message: "server_error: Retry later", retryAfterMs: 5000 }),
                }),
              ),
            ),
          ),
          Stream.fromIterable(reply.text("Recovered", "after-backoff")),
        ]

        const run = yield* runner.drain({ sessionID, force: true }).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            sleep: (duration) =>
              Duration.toMillis(duration) === 5000
                ? Deferred.succeed(sleeping, undefined).pipe(Effect.andThen(clock.sleep(duration)))
                : Deferred.succeed(retrySleeping, undefined).pipe(Effect.andThen(clock.sleep(duration))),
          }),
          Effect.forkChild,
        )
        if (outcome === "retry-interrupt") {
          yield* Deferred.await(retrySleeping)
          yield* TestClock.adjust("2 seconds")
        }
        const boundary = yield* Effect.raceFirst(
          Deferred.await(sleeping).pipe(Effect.as("sleeping")),
          Fiber.join(run).pipe(Effect.as("completed")),
        )
        expect(boundary).toBe("sleeping")
        if (outcome !== "resume") {
          yield* Fiber.interrupt(run)
          const exit = yield* Fiber.await(run)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(requests).toHaveLength(outcome === "retry-interrupt" ? 2 : 1)
          const eventTypes = yield* recordedEventTypes(sessionID)
          expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(1)
          expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
          return
        }
        yield* TestClock.adjust("4999 millis")
        expect(requests).toHaveLength(1)
        yield* TestClock.adjust("1 millis")
        yield* Fiber.join(run)
        expect(requests).toHaveLength(2)
        expect(requireAssistant((yield* session.context(sessionID)).slice(-1))).toMatchObject({ finish: "stop" })
      }),
    )
  }

  it.effect("does not recover a post-output internal failure beyond the retry-after ceiling", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Respect the retry ceiling")
      const failure = new LLMError({
        module: "test",
        method: "stream",
        reason: classifyProviderFailure({ message: "server_error: Retry later", retryAfterMs: 120_001 }),
      })
      responseStream = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "before-long-backoff" }),
        LLMEvent.reasoningDelta({ id: "before-long-backoff", text: "Thinking" }),
      ]).pipe(Stream.concat(Stream.fail(failure)))

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        finish: "error",
        error: { type: "provider.internal" },
      })
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
        sessionStateNotice,
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
        sessionStateNotice,
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
        sessionStateNotice,
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

  it.effect("continues once in a new logical Step after a Codex read failure with tool evidence", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const prompt = "Recover the interrupted Codex tool response"
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 3
        }),
      )
      currentModel = codexModel
      yield* admit(session, prompt)
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "tool-before-codex-read-failure", name: "echo" }),
          LLMEvent.toolInputDelta({
            id: "tool-before-codex-read-failure",
            name: "echo",
            text: '{"text":"partial',
          }),
        ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
        Stream.fromIterable(reply.tool("call-codex-recovery", "echo", { text: "recovered" })),
        Stream.fromIterable(reply.text("Recovered after tool continuation", "text-after-codex-recovery")),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(requests.every((request) => request.model.route.id === "openai-codex-responses")).toBe(true)
      expect(new Set(requests.map((request) => request.id)).size).toBe(3)
      expect(requests[1]?.tools.map((tool) => tool.name)).toContain("echo")
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(userTexts(requests[1])).toEqual([prompt])
      expect(requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "tool-call",
                id: "tool-before-codex-read-failure",
                name: "echo",
              }),
            ]),
          }),
          expect.objectContaining({
            role: "tool",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "tool-result",
                id: "tool-before-codex-read-failure",
                result: expect.objectContaining({
                  type: "error",
                  value: expect.objectContaining({
                    error: expect.objectContaining({ type: "provider.transport" }),
                  }),
                }),
              }),
            ]),
          }),
        ]),
      )
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("MAXIMUM STEPS REACHED")
      expect(requests[2]?.tools).toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(JSON.stringify(requests[2]?.messages)).toContain("MAXIMUM STEPS REACHED")
      expect(executions).toEqual(["recovered"])

      const assistants = (yield* session.context(sessionID)).filter(
        (message): message is SessionMessage.Assistant => message.type === "assistant",
      )
      expect(assistants).toHaveLength(3)
      expect(assistants[0]).toMatchObject({
        finish: "error",
        error: { type: "provider.transport" },
        content: [
          {
            type: "tool",
            id: "tool-before-codex-read-failure",
            state: { status: "error", error: { type: "provider.transport" } },
          },
        ],
      })
      expect((yield* recordedStepSettlementEvents(sessionID, assistants[0].id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(0)
      expect(eventTypes.filter((type) => type === "session.input.consumed.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(3)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.ended.1")).toHaveLength(2)

      const providerRequests = yield* SessionProviderRequest.Service
      expect(
        (yield* providerRequests.list(sessionID)).map((record) => ({
          request: record.request,
          attempts: record.attempts,
          continuation: record.continuation,
        })),
      ).toEqual([
        { request: 1, attempts: 1, continuation: "full" },
        { request: 2, attempts: 1, continuation: "full" },
        { request: 3, attempts: 1, continuation: "full" },
      ])
      expect(yield* providerRequests.summary(sessionID)).toMatchObject({ logical: 3, physical: 3, helpers: 0 })
    }),
  )

  it.effect("applies the configured step limit to Codex transport recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      currentModel = codexModel
      yield* admit(session, "Recover at the configured final step")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-capped-codex-recovery" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-capped-codex-recovery", text: "Interrupted" }),
        ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
        Stream.fromIterable(reply.text("Recovered at the cap", "text-capped-codex-recovery")),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(nonVolatileMessages(requests[1]).at(-1)).toMatchObject({
        role: "system",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
    }),
  )

  it.effect("does not chain a second Codex logical read recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const recoveryFailure = streamReadFailure()
      currentModel = codexModel
      yield* admit(session, "Stop after a consecutive Codex recovery failure")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-codex-read-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-codex-read-failure", text: "First attempt" }),
        ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-codex-recovery-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-codex-recovery-failure", text: "Recovery attempt" }),
        ]).pipe(Stream.concat(Stream.fail(recoveryFailure))),
        Stream.fromIterable(reply.text("Must not run", "text-after-consecutive-codex-failure")),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.squash(exit.cause)).toBe(recoveryFailure)
      expect(requests).toHaveLength(2)
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(0)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(2)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(2)
      const providerRequests = yield* SessionProviderRequest.Service
      expect(yield* providerRequests.summary(sessionID)).toMatchObject({ logical: 2, physical: 2, helpers: 0 })
    }),
  )

  it.effect("does not recover a Codex read failure combined with interruption", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failure = streamReadFailure()
      currentModel = codexModel
      yield* admit(session, "Interrupt the failing Codex stream")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-interrupted-codex-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-interrupted-codex-failure", text: "Interrupted" }),
        ]).pipe(Stream.concat(Stream.failCause(Cause.combine(Cause.fail(failure), Cause.interrupt())))),
        Stream.fromIterable(reply.text("Must not run", "text-after-interrupted-codex-failure")),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt the failing Codex stream" },
        sessionStateNotice,
        {
          type: "assistant",
          finish: "error",
          error: { type: "aborted", message: "Step interrupted" },
          content: [{ type: "reasoning", text: "Interrupted" }],
        },
      ])
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.ended.1")).toHaveLength(0)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(0)
    }),
  )

  it.effect("rearms Codex logical read recovery after a successful recovery Step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = codexModel
      yield* admit(session, "Recover distinct Codex failures")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-first-codex-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-first-codex-failure", text: "First failure" }),
        ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
        Stream.fromIterable(reply.tool("call-after-first-codex-recovery", "echo", { text: "continue" })),
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-second-codex-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-second-codex-failure", text: "Second failure" }),
        ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
        Stream.fromIterable(reply.text("Recovered twice", "text-after-second-codex-recovery")),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(4)
      expect(new Set(requests.map((request) => request.id)).size).toBe(4)
      expect(executions).toEqual(["continue"])
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(0)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(4)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(2)
      expect(eventTypes.filter((type) => type === "session.step.ended.1")).toHaveLength(2)
      const providerRequests = yield* SessionProviderRequest.Service
      expect(yield* providerRequests.summary(sessionID)).toMatchObject({ logical: 4, physical: 4, helpers: 0 })
    }),
  )

  it.effect("promotes a pending steer before Codex logical read recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const failingStreamStarted = yield* Deferred.make<void>()
      const releaseFailure = yield* Deferred.make<void>()
      currentModel = codexModel
      yield* admit(session, "Initial Codex request")
      responseStreams = [
        Stream.unwrap(
          Deferred.succeed(failingStreamStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFailure)),
            Effect.as(
              Stream.fromIterable([
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.reasoningStart({ id: "reasoning-before-steered-codex-failure" }),
                LLMEvent.reasoningDelta({ id: "reasoning-before-steered-codex-failure", text: "Interrupted" }),
              ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
            ),
          ),
        ),
        Stream.fromIterable(reply.text("Answered the steer", "text-after-steered-codex-failure")),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(failingStreamStarted)
      yield* session.prompt({ sessionID, text: "Steered Codex request" })
      yield* Deferred.succeed(releaseFailure, undefined)
      yield* Fiber.join(run)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1])).toEqual(["Initial Codex request", "Steered Codex request"])
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.step.ended.1")).toHaveLength(1)
    }),
  )

  it.effect("promotes a steer admitted during a failing Codex transport recovery", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const recoveryStarted = yield* Deferred.make<void>()
      const releaseRecovery = yield* Deferred.make<void>()
      currentModel = codexModel
      yield* admit(session, "Initial Codex request")
      responseStreams = [
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-initial-codex-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-initial-codex-failure", text: "Initial failure" }),
        ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
        Stream.unwrap(
          Deferred.succeed(recoveryStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRecovery)),
            Effect.as(
              Stream.fromIterable([
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.reasoningStart({ id: "reasoning-before-failing-codex-recovery" }),
                LLMEvent.reasoningDelta({ id: "reasoning-before-failing-codex-recovery", text: "Recovery failure" }),
              ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
            ),
          ),
        ),
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-before-steered-codex-failure" }),
          LLMEvent.reasoningDelta({ id: "reasoning-before-steered-codex-failure", text: "Steered failure" }),
        ]).pipe(Stream.concat(Stream.fail(streamReadFailure()))),
        Stream.fromIterable(reply.text("Recovered the steered request", "text-after-steered-codex-recovery")),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(recoveryStarted)
      yield* session.prompt({ sessionID, text: "Steered during recovery" })
      yield* Deferred.succeed(releaseRecovery, undefined)
      yield* Fiber.join(run)

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[1])).toEqual(["Initial Codex request"])
      expect(userTexts(requests[2])).toEqual(["Initial Codex request", "Steered during recovery"])
      expect(new Set(requests.map((request) => request.id)).size).toBe(4)
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.input.consumed.1")).toHaveLength(2)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(4)
      expect(eventTypes.filter((type) => type === "session.step.failed.1")).toHaveLength(3)
      expect(eventTypes.filter((type) => type === "session.step.ended.1")).toHaveLength(1)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(0)
      const providerRequests = yield* SessionProviderRequest.Service
      expect(yield* providerRequests.summary(sessionID)).toMatchObject({ logical: 4, physical: 4, helpers: 0 })
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

  it.effect("stops after three total retry attempts with exponential backoff", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Exhaust retries")
      streamFailure = providerUnavailable()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      for (const [index, delay] of [2_000, 4_000].entries()) {
        yield* TestClock.adjust(delay)
        while (requests.length < index + 2) yield* Effect.yieldNow
      }
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(streamFailure)
      expect(requests).toHaveLength(3)

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
          attempts: 3,
          invalidation: "retry-fallback",
          continuation: "fallback",
        },
      ])
    }),
  )

  it.effect("retries a physical attempt without consuming the logical agent step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
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
        role: "system",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[2]?.tools).toEqual([])
      expect(nonVolatileMessages(requests[2]).at(-1)).toMatchObject({
        role: "system",
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
        sessionStateNotice,
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
        sessionStateNotice,
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered after empty stream" }] },
      ])
    }),
  )

  it.effect("excludes whitespace-only output from the terminal recovery provider request", () =>
    Effect.gen(function* () {
      const session = yield* setup
      currentModel = anthropicCacheModel
      yield* admit(session, "Answer after blank output")
      responses = [reply.text(" \n\t", "blank-response"), reply.text("Recovered answer", "after-blank-response")]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(requests[1])
      expect(prepared.body.messages.some((message) => message.role === "assistant")).toBe(false)
      expect(requireAssistant((yield* session.context(sessionID)).slice(-1))).toMatchObject({
        finish: "stop",
        content: [{ type: "text", text: "Recovered answer" }],
      })
    }),
  )

  for (const recovery of [false, true]) {
    it.effect(
      `persists native completion-only answer text without false silence${recovery ? " during recovery" : ""}`,
      () =>
        Effect.gen(function* () {
          const session = yield* setup
          currentModel = recovery
            ? yield* SessionRunnerModel.fromCatalogModel(
                CatalogModel.Info.make({
                  id: CatalogModel.ID.make("deepseek/deepseek-v4.1-flash"),
                  modelID: CatalogModel.ID.make("deepseek/deepseek-v4.1-flash"),
                  providerID: Provider.ID.make("openrouter"),
                  name: "Reasoning model",
                  package: "@ycoding-ai/ai/providers/openrouter",
                  settings: { apiKey: "fixture-key", reasoning: { effort: "high" } },
                  headers: {},
                  body: {},
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  variants: [],
                  status: "active",
                  enabled: true,
                  limit: testLimits,
                  cost: [],
                  time: { released: 0 },
                }),
              )
            : storedOpenAIResponsesModel
          yield* admit(session, "Give the final answer")
          nativeResponses = [
            ...(recovery
              ? [
                  [
                    { type: "response.reasoning_text.delta", item_id: "rs_thinking", delta: "Thinking" },
                    { type: "response.completed", response: { id: "resp_silent" } },
                  ],
                ]
              : []),
            [
              {
                type: "response.completed",
                response: {
                  id: "resp_answer",
                  output: [
                    {
                      type: "message",
                      id: "msg_answer",
                      phase: "final_answer",
                      content: [{ type: "output_text", text: "The final answer" }],
                    },
                  ],
                  usage: { input_tokens: 12, output_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } },
                },
              },
            ],
          ].map((events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))

          yield* session.resume(sessionID)

          expect(requests).toHaveLength(recovery ? 2 : 1)
          expect(requests.at(-1)?.model.route.id).toBe(recovery ? "openrouter-responses" : "openai-responses")
          expect(requireAssistant((yield* session.context(sessionID)).slice(-1))).toMatchObject({
            finish: "stop",
            content: [{ type: "text", text: "The final answer", phase: "final_answer" }],
            tokens: { input: 12, output: 4, reasoning: 1 },
          })
          expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.failed.1")
          expect(executions).toEqual([])
        }),
    )
  }

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
        "The provider returned no answer after text-only recovery. Retry the request or choose another model.",
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
            message:
              "The provider returned no answer after text-only recovery. Retry the request or choose another model.",
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

  for (const content of ["empty", "reasoning-only"] as const) {
    it.effect(`fails repeated ${content} responses without a third response step`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        yield* admit(session, "Answer once")
        responses = ["initial", "recovery"].map((id) =>
          content === "empty" ? reply.silence() : fragmentFixture("reasoning", id, ["Thinking"]).completeEvents,
        )

        expect((yield* session.resume(sessionID).pipe(Effect.flip)).message).toBe(
          "The provider returned no answer after text-only recovery. Retry the request or choose another model.",
        )

        expect(requests).toHaveLength(2)
        expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.started.1")).toHaveLength(
          2,
        )
        expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.failed.1")).toHaveLength(
          1,
        )
        expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toMatchObject([
          { finish: "stop", content: content === "empty" ? [] : [{ type: "reasoning", text: "Thinking" }] },
          { finish: "error", content: content === "empty" ? [] : [{ type: "reasoning", text: "Thinking" }] },
        ])
      }),
    )
  }

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
        sessionStateNotice,
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
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
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

  const incompleteToolInputMessage =
    "Tool call arguments were incomplete when the provider ended the step and were not executed. Retry the call."
  const incompleteToolInput = (name: string, deltas: readonly string[], id = "call-incomplete") => [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.toolInputStart({ id, name }),
    ...deltas.map((text) => LLMEvent.toolInputDelta({ id, name, text })),
    LLMEvent.stepFinish({ index: 0, reason: "length" }),
    LLMEvent.finish({ reason: "length" }),
  ]
  const toolResultMessages = (request: LLMRequest | undefined) =>
    request?.messages.flatMap((message) =>
      message.content.flatMap((part) => (message.role === "tool" && part.type === "tool-result" ? [part] : [])),
    ) ?? []

  for (const input of [
    { name: "empty", deltas: [] },
    { name: "partial", deltas: ['{"text":"par'] },
  ])
    it.effect(`fails ${input.name} local tool input left open by a length-limited step and continues`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        yield* admit(session, "Recover incomplete tool input")
        responses = [incompleteToolInput("echo", input.deltas), reply.text("Recovered", "text-incomplete-recovery")]

        yield* session.resume(sessionID)

        expect(requests).toHaveLength(2)
        expect(executions).toEqual([])
        const types = yield* recordedEventTypes(sessionID)
        const firstStep = types.slice(0, types.indexOf("session.step.ended.1") + 1)
        expect(
          firstStep.filter((type) => type === "session.tool.input.ended.1" || type === "session.tool.failed.1"),
        ).toEqual(["session.tool.input.ended.1", "session.tool.failed.1"])
        expect(types.filter((type) => type === "session.tool.failed.1")).toHaveLength(1)
        expect(types.filter((type) => type === "session.step.failed.1")).toHaveLength(0)
        expect(requests[1]?.tools.map((tool) => tool.name)).toContain("echo")
        expect(requests[1]?.toolChoice).toBeUndefined()
        expect(requests[1]?.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              content: expect.arrayContaining([
                expect.objectContaining({ type: "tool-call", id: "call-incomplete", name: "echo", input: {} }),
              ]),
            }),
          ]),
        )
        expect(toolResultMessages(requests[1])).toEqual([
          expect.objectContaining({
            id: "call-incomplete",
            result: expect.objectContaining({
              type: "error",
              value: expect.objectContaining({
                error: expect.objectContaining({ message: incompleteToolInputMessage }),
              }),
            }),
          }),
        ])
        const failed = (yield* session.context(sessionID)).find(
          (message): message is SessionMessage.Assistant =>
            message.type === "assistant" && message.content.some((item) => item.type === "tool"),
        )
        expect(failed).toMatchObject({
          content: [
            {
              type: "tool",
              id: "call-incomplete",
              executed: false,
              state: { status: "error", error: { type: "tool.input-json", message: incompleteToolInputMessage } },
            },
          ],
        })
        if (!failed) throw new Error("Incomplete tool assistant missing")
        expect(failed.error).toBeUndefined()
        expect((yield* recordedStepSettlementEvents(sessionID, failed.id)).map((event) => event.type)).toEqual([
          "session.step.started.1",
          "session.tool.failed.1",
          "session.step.ended.1",
        ])
      }),
    )

  it.effect("runs a complete sibling call and fails the incomplete one in the same step", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Run complete call beside incomplete input")
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-valid", name: "echo", input: { text: "valid" } }),
          LLMEvent.toolInputStart({ id: "call-incomplete", name: "echo" }),
          LLMEvent.toolInputDelta({ id: "call-incomplete", name: "echo", text: '{"text":"par' }),
          LLMEvent.stepFinish({ index: 0, reason: "length" }),
          LLMEvent.finish({ reason: "length" }),
        ],
        reply.text("Recovered", "text-sibling-recovery"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(executions).toEqual(["valid"])
      expect(toolResultMessages(requests[1]).map((result) => [result.id, result.result.type === "error"])).toEqual([
        ["call-valid", false],
        ["call-incomplete", true],
      ])
    }),
  )

  it.effect("fails incomplete input once tools are disabled by the step limit and recovers with text only", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* admit(session, "Stop incomplete tool input at the step limit")
      responses = [
        incompleteToolInput("echo", ['{"text":"par'], "call-first"),
        incompleteToolInput("echo", ['{"text":"par'], "call-at-limit"),
        reply.text("Text recovery", "text-limit-recovery"),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(executions).toEqual([])
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(toolResultMessages(requests[2]).map((result) => result.id)).toEqual(["call-first", "call-at-limit"])
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.tool.failed.1")).toHaveLength(2)
      expect(types.filter((type) => type === "session.step.failed.1")).toHaveLength(0)
    }),
  )

  it.effect("fails an open local tool input once when the stream fails", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Fail open tool input with the stream")
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-incomplete", name: "echo" }),
          LLMEvent.toolInputDelta({ id: "call-incomplete", name: "echo", text: '{"text":"par' }),
        ]),
        Stream.fail(invalidRequest()),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(1)
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.tool.failed.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1")).toHaveLength(0)
      expect(requireAssistant(yield* session.context(sessionID)).content).toMatchObject([
        {
          type: "tool",
          id: "call-incomplete",
          state: { status: "error", error: { type: "provider.invalid-request" } },
        },
      ])
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
        sessionStateNotice,
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
        sessionStateNotice,
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
        sessionStateNotice,
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
        sessionStateNotice,
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
        sessionStateNotice,
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

  it.effect("an owned subagent answer wakes the real runner and completes the waiting child", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const autonomy = yield* SessionAutonomy.Service
      const execution = yield* realExecution
      const scope = yield* Scope.Scope
      const context = yield* Layer.buildWithScope(
        AppNodeBuilder.build(SessionOrchestration.node, [
          [Database.node, Layer.succeed(Database.Service, database)],
          [EventRuntime.node, Layer.succeed(EventRuntime.Service, events)],
          [SessionAutonomy.node, Layer.succeed(SessionAutonomy.Service, autonomy)],
          [SessionExecution.node, Layer.succeed(SessionExecution.Service, execution)],
          [Session.node, Layer.succeed(Session.Service, session)],
        ]),
        scope,
      )
      const orchestration = Context.get(context, SessionOrchestration.Service)
      const child = yield* session.create({ parentID: sessionID, title: "Waiting boundary check" })
      yield* events.publish(SessionEvent.Task.Updated, {
        sessionID: child.id,
        change: {
          type: "launched",
          parentID: sessionID,
          parentAssistantMessageID: SessionMessage.ID.make("msg_question_parent"),
          toolCallID: "call_question_child",
          inputID: SessionMessage.ID.make("msg_question_child"),
          description: "Check the selected boundary",
          agent: Agent.ID.make("build"),
          model: { id: CatalogModel.ID.make("fake-model"), providerID: Provider.ID.make("fake") },
          promptDigest: "question-fixture",
          background: true,
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
      const question = yield* orchestration.question(child.id, "Which boundary should I check?")
      expect(question.autoAnswered).toBe(false)
      expect(yield* orchestration.get(sessionID, child.id)).toMatchObject({ state: "waiting" })
      response = reply.text("Selected boundary checked and verified.", "text-question-resumed")
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      yield* orchestration.answer({
        parentID: sessionID,
        childID: child.id,
        questionID: question.question.id,
        text: "/goal stays literal in this answer",
      })
      yield* Deferred.await(streamStarted)
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests[0]!.messages)).toContain("/goal stays literal in this answer")
      expect(yield* session.pending(child.id)).toEqual([])
      yield* Deferred.succeed(streamGate, undefined)
      yield* execution.awaitIdle(child.id)
      expect(yield* orchestration.get(sessionID, child.id)).toMatchObject({ state: "completed", question: undefined })
      expect((yield* session.context(child.id)).filter((message) => message.type === "assistant")).toMatchObject([
        { finish: "stop", content: [{ type: "text", text: "Selected boundary checked and verified." }] },
      ])
      expect([...(yield* execution.active)]).toEqual([])
    }),
  )
})

const backupModel = Model.make({
  id: "backup",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: testLimits }),
})
const narrowModel = Model.make({
  id: "narrow",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 3_500, output: 100 } }),
})
const backupCost: CatalogModel.Info["cost"] = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
  },
]
const backupDigest = "b".repeat(64)
const quotaExceeded = () =>
  new LLMError({ module: "test", method: "stream", reason: new QuotaExceededReason({ message: "Quota exhausted" }) })
const configureFallbacks = (chain: ReadonlyArray<string>) => {
  modelFallbacks = Schema.decodeUnknownSync(Config.Info)({
    model_fallbacks: { "fake/fake-model": chain },
  }).model_fallbacks
  fallbackModels.set("backup", { model: backupModel, cost: backupCost, digest: backupDigest })
  fallbackModels.set("narrow", { model: narrowModel, cost: [], digest: backupDigest })
}
const eventData = (type: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, type)))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.data as Record<string, unknown>)),
      )
  })
const providerRecords = SessionProviderRequest.Service.pipe(Effect.flatMap((service) => service.list(sessionID)))

describe("SessionRunnerLLM model fallback", () => {
  for (const failure of ["quota", "unavailable"] as const)
    it.effect(`keeps a coordination message on its overridden model after ${failure} failure`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        configureFallbacks(["fake/backup"])
        if (failure === "unavailable") unavailableModels.add("fake-model")
        responseStreams =
          failure === "quota"
            ? [Stream.fail(quotaExceeded()), Stream.fromIterable(reply.text("Unused backup", "dispatch-backup"))]
            : [Stream.fromIterable(reply.text("Unused backup", "dispatch-backup"))]
        const inputID = SessionMessage.ID.create()
        const events = yield* EventRuntime.Service
        yield* events.publish(SessionEvent.InputAdmitted, {
          sessionID,
          inputID,
          input: {
            type: "user",
            delivery: "steer",
            data: {
              text: "Complete the assignment",
              metadata: {
                inputOrigin: "coordination",
                coordination: {
                  groupID: "cgrp_runner",
                  senderSessionID: "ses_master",
                  messageID: inputID,
                  model: { providerID: "fake", id: "fake-model", variant: "high" },
                },
              },
            },
          },
        })
        expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
        expect(requests.map((request) => String(request.model.id))).toEqual(failure === "quota" ? ["fake-model"] : [])
        expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.rerouted.1")
      }),
    )

  it.effect("reruns the Step on the next configured model after the retry schedule is exhausted", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      responseStreams = [
        ...Array.from({ length: 3 }, () => Stream.fail(rateLimited())),
        Stream.fromIterable(reply.textWithUsage("Answered by backup", "text-backup", 1_000)),
      ]
      yield* admit(session, "Fall back after retries")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      for (const [index, delay] of [2_000, 4_000].entries()) {
        yield* TestClock.adjust(delay)
        while (requests.length < index + 2) yield* Effect.yieldNow
      }
      yield* Fiber.join(run)

      expect(requests).toHaveLength(4)
      expect(requests.slice(0, 3).map((request) => String(request.model.id))).toEqual(Array(3).fill("fake-model"))
      expect(String(requests[3]?.model.id)).toBe("backup")
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.rerouted.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1")).toHaveLength(1)
      expect(types).not.toContain("session.step.failed.1")
      const assistant = requireAssistant(yield* session.context(sessionID))
      expect(yield* eventData("session.step.rerouted.1")).toEqual([
        {
          sessionID,
          assistantMessageID: assistant.id,
          model: { providerID: "fake", id: "backup" },
          error: { type: "provider.rate-limit", message: "Rate limited" },
        },
      ])
      expect(assistant).toMatchObject({
        model: { providerID: "fake", id: "backup" },
        reroutes: [
          {
            from: { providerID: "fake", id: "fake-model" },
            model: { providerID: "fake", id: "backup" },
            error: { type: "provider.rate-limit" },
          },
        ],
        finish: "stop",
        content: [{ type: "text", text: "Answered by backup" }],
      })
      expect(assistant.cost).toBeCloseTo(SessionUsage.calculateCost(backupCost, assistant.tokens!))
      expect(assistant.cost).toBeGreaterThan(0)
      const records = yield* providerRecords
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({
        model: { providerID: "fake", id: "fake-model" },
        attempts: 3,
        invalidation: "retry-fallback",
        tokens: { input: 0, output: 0 },
      })
      expect(records[0]?.connectionIdentityDigest).toBeUndefined()
      expect(records[1]).toMatchObject({
        model: { providerID: "fake", id: "backup" },
        attempts: 1,
        connectionIdentityDigest: backupDigest,
        assistantMessageID: assistant.id,
      })
    }),
  )

  it.effect("switches at once when the model's quota is exhausted", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      responseStreams = [Stream.fail(quotaExceeded()), Stream.fromIterable(reply.text("Backup answer", "text-quota"))]
      yield* admit(session, "Fall back on quota")
      yield* session.resume(sessionID)

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model", "backup"])
      const types = yield* recordedEventTypes(sessionID)
      expect(types).not.toContain("session.retry.scheduled.1")
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1")).toHaveLength(1)
      expect((yield* eventData("session.step.rerouted.1")).map((data) => data.error)).toEqual([
        { type: "provider.quota", message: "Quota exhausted" },
      ])
    }),
  )

  it.effect("switches when the selected model cannot be resolved", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          model: CatalogModel.Ref.make({
            providerID: Provider.ID.make("fake"),
            id: CatalogModel.ID.make("fake-model"),
          }),
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      unavailableModels.add("fake-model")
      response = reply.text("Resolved backup", "text-resolved")
      yield* admit(session, "Fall back on an unavailable model")
      yield* session.resume(sessionID)

      expect(requests.map((request) => String(request.model.id))).toEqual(["backup"])
      expect((yield* eventData("session.step.started.1")).map((data) => data.model)).toEqual([
        { providerID: "fake", id: "fake-model" },
      ])
      expect(
        (yield* eventData("session.step.rerouted.1")).map((data) => [
          data.model,
          (data.error as SessionMessage.Assistant["error"])?.type,
        ]),
      ).toEqual([[{ providerID: "fake", id: "backup" }, "provider.no-route"]])
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        model: { providerID: "fake", id: "backup" },
        finish: "stop",
      })
    }),
  )

  for (const failure of [
    {
      name: "authentication",
      error: () =>
        new LLMError({
          module: "test",
          method: "stream",
          reason: new AuthenticationReason({ message: "Expired", kind: "expired" }),
        }),
    },
    {
      name: "content policy",
      error: () =>
        new LLMError({ module: "test", method: "stream", reason: new ContentPolicyReason({ message: "Blocked" }) }),
    },
    { name: "invalid request", error: invalidRequest },
  ])
    it.effect(`does not switch models on ${failure.name} failures`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        configureFallbacks(["fake/backup"])
        responseStreams = [Stream.fail(failure.error()), Stream.fromIterable(reply.text("Unused", "text-unused"))]
        yield* admit(session, `No fallback on ${failure.name}`)
        expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

        expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model"])
        const types = yield* recordedEventTypes(sessionID)
        expect(types).not.toContain("session.step.rerouted.1")
        expect(types.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
      }),
    )

  it.effect("fails with the last model's error once every configured model has been tried", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      const last = quotaExceeded()
      responseStreams = [Stream.fail(quotaExceeded()), Stream.fail(last)]
      yield* admit(session, "Exhaust the fallback chain")
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(last)

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model", "backup"])
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.rerouted.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        model: { providerID: "fake", id: "backup" },
        error: { type: "provider.quota" },
      })
    }),
  )

  it.effect("keeps later Steps of the drain on the fallback and starts the next drain on the selected model", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      responseStreams = [
        Stream.fail(quotaExceeded()),
        Stream.fromIterable(reply.tool("call-sticky", "echo", { text: "sticky" })),
        Stream.fromIterable(reply.text("Finished on backup", "text-sticky")),
      ]
      yield* admit(session, "Stay on the fallback")
      yield* session.resume(sessionID)

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model", "backup", "backup"])
      expect((yield* eventData("session.step.started.1")).map((data) => data.model)).toEqual([
        { providerID: "fake", id: "fake-model" },
        { providerID: "fake", id: "backup" },
      ])
      expect(yield* eventData("session.step.rerouted.1")).toHaveLength(1)

      responseStreams = [Stream.fromIterable(reply.text("Selected model again", "text-primary"))]
      yield* admit(session, "Next drain")
      yield* session.resume(sessionID)
      expect(String(requests[3]?.model.id)).toBe("fake-model")
    }),
  )

  it.effect("skips a fallback whose context window cannot hold the request without compacting", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/narrow", "fake/backup"])
      responseStreams = [Stream.fail(quotaExceeded()), Stream.fromIterable(reply.text("Wide backup", "text-wide"))]
      yield* admit(session, "Skip the narrow fallback")
      yield* session.resume(sessionID)

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model", "backup"])
      expect(
        (yield* eventData("session.step.rerouted.1")).map((data) => [
          (data.model as { id: string }).id,
          (data.error as { type: string }).type,
        ]),
      ).toEqual([
        ["narrow", "provider.quota"],
        ["backup", "context.limit"],
      ])
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.compaction.admitted.2")
      expect(
        requireAssistant(yield* session.context(sessionID)).reroutes?.map((reroute) => String(reroute.from.id)),
      ).toEqual(["fake-model", "narrow"])
    }),
  )

  it.effect("records the start snapshot on the Step when the selected model cannot be resolved", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      snapshotCapture = Snapshot.ID.make("snapshot-before-fallback")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          model: CatalogModel.Ref.make({
            providerID: Provider.ID.make("fake"),
            id: CatalogModel.ID.make("fake-model"),
          }),
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      unavailableModels.add("fake-model")
      response = reply.text("Resolved backup", "text-snapshot-fallback")
      yield* admit(session, "Snapshot before an unresolved primary")
      yield* session.resume(sessionID)

      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1" || type === "session.step.failed.1")).toEqual([
        "session.step.ended.1",
      ])
      expect((yield* eventData("session.step.started.1")).map((data) => data.snapshot)).toEqual([
        "snapshot-before-fallback",
      ])
      expect(requireAssistant(yield* session.context(sessionID)).snapshot?.start).toBe(snapshotCapture)
    }),
  )

  it.effect("fails the Step without further rerouting when a fallback candidate's profile is unavailable", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["Work#fake/fake-model", "fake/backup"])
      unavailableProfiles.add("Work")
      responseStreams = [Stream.fail(quotaExceeded()), Stream.fromIterable(reply.text("Unused", "text-profile-unused"))]
      yield* admit(session, "Fallback profile unavailable")
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(
        SessionRunnerModel.ProfileUnavailableError,
      )

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model"])
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.rerouted.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1" || type === "session.step.failed.1")).toEqual([
        "session.step.failed.1",
      ])
    }),
  )

  it.effect("settles the Step once when the last fallback cannot be resolved", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      unavailableModels.add("backup")
      responseStreams = [Stream.fail(quotaExceeded())]
      yield* admit(session, "Last fallback unavailable")
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(
        SessionRunnerModel.ModelUnavailableError,
      )

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model"])
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.rerouted.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1" || type === "session.step.failed.1")).toEqual([
        "session.step.failed.1",
      ])
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        model: { providerID: "fake", id: "backup" },
        finish: "error",
        error: { type: "provider.no-route" },
      })
    }),
  )

  it.effect("settles the Step once when every model in the chain is unavailable", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          model: CatalogModel.Ref.make({
            providerID: Provider.ID.make("fake"),
            id: CatalogModel.ID.make("fake-model"),
          }),
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      unavailableModels.add("fake-model")
      unavailableModels.add("backup")
      yield* admit(session, "Whole chain unavailable")
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(
        SessionRunnerModel.ModelUnavailableError,
      )

      expect(requests).toHaveLength(0)
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.rerouted.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1" || type === "session.step.failed.1")).toEqual([
        "session.step.failed.1",
      ])
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        finish: "error",
        error: { type: "provider.no-route" },
      })
    }),
  )

  it.effect("interrupting an actively streaming fallback publishes the Step terminal once", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      responseStreams = [
        Stream.fail(quotaExceeded()),
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text-streaming-fallback" }),
            LLMEvent.textDelta({ id: "text-streaming-fallback", text: "Partial answer" }),
          ]),
          Stream.never,
        ),
      ]
      yield* admit(session, "Interrupt the streaming fallback")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (!(yield* recordedEventTypes(sessionID)).includes("session.text.started.1")) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model", "backup"])
      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1" || type === "session.step.failed.1")).toEqual([
        "session.step.failed.1",
      ])
    }),
  )

  for (const target of [
    { name: "another model and account", chain: "fake/backup" },
    { name: "the same model on another profile", chain: "Work#fake/fake-model" },
  ])
    it.effect(`does not replay the failed model's signed reasoning on ${target.name}`, () =>
      Effect.gen(function* () {
        const session = yield* setup
        configureFallbacks([target.chain])
        profileDigests.set("Work", "c".repeat(64))
        responseStreams = [
          Stream.concat(
            Stream.fromIterable([
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.reasoningStart({
                id: "reasoning-primary",
                providerMetadata: { openai: { signature: "sig_primary" } },
              }),
              LLMEvent.reasoningEnd({
                id: "reasoning-primary",
                providerMetadata: { openai: { signature: "sig_primary" } },
              }),
            ]),
            Stream.fail(quotaExceeded()),
          ),
          Stream.fromIterable(reply.tool("call-signed-fallback", "echo", { text: "signed" })),
          Stream.fromIterable(reply.text("Finished without foreign state", "text-signed-fallback")),
        ]
        yield* admit(session, `Fall back to ${target.name}`)
        yield* session.resume(sessionID)

        expect(requests).toHaveLength(3)
        expect(requests.slice(1).map((request) => JSON.stringify(request.messages).includes("sig_primary"))).toEqual([
          false,
          false,
        ])
        expect(
          JSON.stringify((yield* session.context(sessionID)).filter((message) => message.type === "assistant")),
        ).not.toContain("sig_primary")
      }),
    )

  it.effect("interrupting a fallback's retry backoff publishes the Step terminal once", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      responseStreams = [Stream.fail(quotaExceeded()), Stream.fail(rateLimited())]
      yield* admit(session, "Interrupt the fallback backoff")

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* TestClock.adjust("1 millis")
      while (!(yield* recordedEventTypes(sessionID)).includes("session.retry.scheduled.1")) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)

      const types = yield* recordedEventTypes(sessionID)
      expect(types.filter((type) => type === "session.step.started.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.rerouted.1")).toHaveLength(1)
      expect(types.filter((type) => type === "session.step.ended.1" || type === "session.step.failed.1")).toHaveLength(
        1,
      )
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        model: { providerID: "fake", id: "backup" },
        error: { type: "aborted" },
      })
    }),
  )
})

const incidentRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(ModelIncidentTable)
    .orderBy(asc(ModelIncidentTable.time_created), asc(ModelIncidentTable.id))
    .all()
    .pipe(Effect.orDie)
})
const fallbackSummary = (rows: ReadonlyArray<typeof ModelIncidentTable.$inferSelect>) =>
  rows.map((row) => [row.kind, row.provider_id, row.model_id, row.agent, row.session_id, row.category, row.target])

describe("SessionRunnerLLM model fallback incidents", () => {
  it.effect(
    "records one fallback incident with the abandoned model, selected agent, error category and target in the reroute transaction",
    () =>
      Effect.gen(function* () {
        const session = yield* setup
        configureFallbacks(["fake/backup"])
        responseStreams = [
          Stream.fail(quotaExceeded()),
          Stream.fromIterable(reply.text("Answered by backup", "text-incident")),
        ]
        yield* admit(session, "Record the fallback")
        yield* session.resume(sessionID)

        const rows = yield* incidentRows
        expect(fallbackSummary(rows)).toEqual([
          [
            "fallback",
            "fake",
            "fake-model",
            "build",
            sessionID,
            "provider.quota",
            { providerID: Provider.ID.make("fake"), id: CatalogModel.ID.make("backup") },
          ],
        ])
        expect(rows[0]).toMatchObject({ request_id: null, rule_ids: [], decided_by: null, project_id: "global" })
        expect(rows).toHaveLength((yield* eventData("session.step.rerouted.1")).length)
      }),
  )

  it.effect("records every hop of a chain from the model that actually failed", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/narrow", "fake/backup"])
      responseStreams = [Stream.fail(quotaExceeded()), Stream.fromIterable(reply.text("Wide backup", "text-hops"))]
      yield* admit(session, "Record each hop")
      yield* session.resume(sessionID)

      expect(
        fallbackSummary(yield* incidentRows).map((row) => [row[2], row[5], (row[6] as { id: string }).id]),
      ).toEqual([
        ["fake-model", "provider.quota", "narrow"],
        ["narrow", "context.limit", "backup"],
      ])
    }),
  )

  it.effect("records nothing for sticky Steps, later drains, or failures that do not switch models", () =>
    Effect.gen(function* () {
      const session = yield* setup
      configureFallbacks(["fake/backup"])
      responseStreams = [
        Stream.fail(quotaExceeded()),
        Stream.fromIterable(reply.tool("call-sticky-incident", "echo", { text: "sticky" })),
        Stream.fromIterable(reply.text("Finished on backup", "text-sticky-incident")),
      ]
      yield* admit(session, "Stay on the fallback")
      yield* session.resume(sessionID)
      expect(yield* incidentRows).toHaveLength(1)

      responseStreams = [Stream.fromIterable(reply.text("Selected model again", "text-primary-incident"))]
      yield* admit(session, "Next drain")
      yield* session.resume(sessionID)
      expect(yield* incidentRows).toHaveLength(1)

      responseStreams = [
        Stream.fail(
          new LLMError({ module: "test", method: "stream", reason: new ContentPolicyReason({ message: "Blocked" }) }),
        ),
      ]
      yield* admit(session, "No switch")
      yield* session.resume(sessionID).pipe(Effect.exit)
      expect(yield* incidentRows).toHaveLength(1)
    }),
  )

  it.effect("attributes a child Session's reroute to the child and its selected agent", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const agent = yield* Agent.Service
      const { db } = yield* Database.Service
      configureFallbacks(["fake/backup"])
      yield* insertSession(otherSessionID)
      yield* agent.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (item) => {
          item.system = "Reviewer instructions"
          item.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer", parent_id: otherSessionID })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      responseStreams = [
        Stream.fail(quotaExceeded()),
        Stream.fromIterable(reply.text("Child answered", "text-child-incident")),
      ]
      yield* admit(session, "Child fallback")
      yield* session.resume(sessionID)

      expect((yield* incidentRows).map((row) => [row.session_id, row.agent, row.model_id])).toEqual([
        [sessionID, "reviewer", "fake-model"],
      ])
    }),
  )

  it.effect("rolls the reroute back with its incident row when the row cannot be written", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      configureFallbacks(["fake/backup"])
      responseStreams = [Stream.fail(quotaExceeded()), Stream.fromIterable(reply.text("Unused", "text-rollback"))]
      yield* db.run(sql`DROP TABLE model_incident`).pipe(Effect.orDie)
      yield* admit(session, "Fail the incident write")
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)

      expect(yield* eventData("session.step.rerouted.1")).toEqual([])
      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model"])
      expect(requireAssistant(yield* session.context(sessionID))).toMatchObject({
        model: { providerID: "fake", id: "fake-model" },
      })
    }),
  )
})

const guidanceRule = "standard.review.force-push"
const guidanceModel = CatalogModel.Ref.make({
  providerID: Provider.ID.make("fake"),
  id: CatalogModel.ID.make("fake-model"),
})
const guidanceNote = ModelGuidanceInstructions.render([
  { requestID: "req_a", ruleIDs: [guidanceRule] },
  { requestID: "req_b", ruleIDs: [guidanceRule] },
])!
const guidanceEnabled = Effect.gen(function* () {
  yield* TestClock.setTime(1_000_000)
})
const putGuardrailIncidents = (input: {
  readonly model?: string
  readonly requests: ReadonlyArray<string>
  readonly time?: number
  readonly rule?: string
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* Effect.forEach(
      input.requests,
      (request) =>
        db
          .run(
            sql`
            INSERT INTO model_incident
              (id, time_created, kind, provider_id, model_id, agent, project_id, session_id, request_id, category, rule_ids)
            VALUES (${`inc_${input.model ?? "fake-model"}_${request}`}, ${input.time ?? 999_000}, 'guardrail-escalated', 'fake',
              ${input.model ?? "fake-model"}, 'build', 'global', 'ses_elsewhere', ${request}, 'hard', ${JSON.stringify([input.rule ?? guidanceRule])})
          `,
          )
          .pipe(Effect.orDie),
      { discard: true },
    )
  })
const selectSessionModel = (model: CatalogModel.Ref | undefined) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ model: model ?? null })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })
const systemText = (request: LLMRequest | undefined) => request?.system.map((part) => part.text).join("\n") ?? ""

describe("SessionRunnerLLM model guidance", () => {
  it.effect("adds the selected model's notes to the initial instructions", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* guidanceEnabled
      yield* selectSessionModel(guidanceModel)
      yield* putGuardrailIncidents({ requests: ["req_a", "req_b"] })
      yield* putGuardrailIncidents({
        model: "backup",
        requests: ["req_x", "req_y"],
        rule: "standard.review.git-destructive",
      })
      yield* admit(session, "First")
      yield* session.resume(sessionID)

      expect(systemText(requests[0])).toContain(guidanceNote)
      expect(systemText(requests[0])).not.toContain("git-destructive")
    }),
  )

  it.effect("gives a Session without a selected model the notes of the catalog default selection", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* guidanceEnabled
      defaultSelectionRef = CatalogModel.Ref.make({
        providerID: Provider.ID.make("fake"),
        id: CatalogModel.ID.make("fake-model"),
        variant: CatalogModel.VariantID.make("high"),
      })
      yield* putGuardrailIncidents({ requests: ["req_a", "req_b"] })
      yield* admit(session, "First")
      yield* session.resume(sessionID)

      expect(systemText(requests[0])).toContain(guidanceNote)
    }),
  )

  it.effect("adds no notes when neither the Session nor the catalog selects a model", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* guidanceEnabled
      yield* putGuardrailIncidents({ requests: ["req_a", "req_b"] })
      yield* admit(session, "First")
      yield* session.resume(sessionID)

      expect(systemText(requests[0])).not.toContain("<model-guidance>")
    }),
  )

  it.effect("omits the notes when the capability is denied", () =>
    Effect.gen(function* () {
      capabilitiesConfig = new ConfigCapabilities.Info({ builtin_instructions: { deny: ["model-guidance"] } })
      const session = yield* setup
      yield* guidanceEnabled
      yield* selectSessionModel(guidanceModel)
      yield* putGuardrailIncidents({ requests: ["req_a", "req_b"] })
      yield* admit(session, "First")
      yield* session.resume(sessionID)

      expect(systemText(requests[0])).not.toContain("<model-guidance>")
    }).pipe(Effect.ensuring(Effect.sync(() => (capabilitiesConfig = undefined)))),
  )

  it.effect("publishes later changes and removals as chronological updates while the initial blob stays stable", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const { db } = yield* Database.Service
      yield* guidanceEnabled
      yield* selectSessionModel(guidanceModel)
      yield* putGuardrailIncidents({ requests: ["req_a", "req_b"] })
      yield* admit(session, "First")
      yield* session.resume(sessionID)
      const initial = systemText(requests[0])
      expect(initial).toContain(guidanceNote)

      yield* putGuardrailIncidents({ requests: ["req_c", "req_d"], rule: "standard.review.outside-repo" })
      yield* admit(session, "Second")
      yield* session.resume(sessionID)
      const changed = ModelGuidanceInstructions.render([
        { requestID: "req_a", ruleIDs: [guidanceRule] },
        { requestID: "req_b", ruleIDs: [guidanceRule] },
        { requestID: "req_c", ruleIDs: ["standard.review.outside-repo"] },
        { requestID: "req_d", ruleIDs: ["standard.review.outside-repo"] },
      ])!
      expect(systemText(requests[1])).toBe(initial)
      expect(systemTexts(requests[1]!).filter((text) => text.includes(changed))).toHaveLength(1)

      yield* db
        .run(
          sql`INSERT INTO model_guidance_clear (provider_id, model_id, cleared_at) VALUES ('fake', 'fake-model', 999500)`,
        )
        .pipe(Effect.orDie)
      yield* admit(session, "Third")
      yield* session.resume(sessionID)
      expect(systemText(requests[2])).toBe(initial)
      expect(
        systemTexts(requests[2]!).filter((text) => text.includes(ModelGuidanceInstructions.retraction)),
      ).toHaveLength(1)
    }),
  )

  it.effect("retracts the notes when the capability is denied later", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* guidanceEnabled
      yield* selectSessionModel(guidanceModel)
      yield* putGuardrailIncidents({ requests: ["req_a", "req_b"] })
      yield* admit(session, "First")
      yield* session.resume(sessionID)
      capabilitiesConfig = new ConfigCapabilities.Info({ builtin_instructions: { deny: ["model-guidance"] } })
      yield* admit(session, "Second")
      yield* session.resume(sessionID)

      expect(systemText(requests[1])).toBe(systemText(requests[0]))
      expect(
        systemTexts(requests[1]!).filter((text) => text.includes(ModelGuidanceInstructions.retraction)),
      ).toHaveLength(1)
    }).pipe(Effect.ensuring(Effect.sync(() => (capabilitiesConfig = undefined)))),
  )

  it.effect("keeps the selected model's notes for a fallback attempt without a mid-Step update", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* guidanceEnabled
      configureFallbacks(["fake/backup"])
      yield* selectSessionModel(guidanceModel)
      yield* putGuardrailIncidents({ requests: ["req_a", "req_b"] })
      yield* putGuardrailIncidents({
        model: "backup",
        requests: ["req_x", "req_y"],
        rule: "standard.review.git-destructive",
      })
      responseStreams = [
        Stream.fail(quotaExceeded()),
        Stream.fromIterable(reply.text("Answered by backup", "text-guidance-fallback")),
      ]
      yield* admit(session, "Fallback keeps the primary notes")
      yield* session.resume(sessionID)

      expect(requests.map((request) => String(request.model.id))).toEqual(["fake-model", "backup"])
      expect(systemText(requests[1])).toBe(systemText(requests[0]))
      expect(systemText(requests[1])).toContain(guidanceNote)
      expect(systemText(requests[1])).not.toContain("git-destructive")
      expect(yield* eventData("session.instructions.updated.2")).toHaveLength(1)
    }),
  )
})
