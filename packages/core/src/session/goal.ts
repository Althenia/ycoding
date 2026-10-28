export * as SessionGoal from "./goal"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Agent } from "../agent"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventRuntime } from "../event"
import { Money } from "@ycoding-ai/schema/money"
import { ToolInvocation } from "@ycoding-ai/schema/tool-invocation"
import { SessionEvent } from "./event"
import { SessionAutonomy } from "./autonomy"
import { SessionHelperPolicy } from "./helper-policy"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionModelHeaders } from "./model-headers"
import { SessionProviderRequest } from "./provider-request"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { SessionUsageAttribution } from "./usage-attribution"
import { SessionRunnerCache } from "./runner/cache"
import { SessionSchema } from "./schema"
import { SessionUsage } from "./usage"

const MAX_CONTEXT_CHARS = 6_000

export const ErrorCode = Schema.Literals([
  "goal.no_retained_goal",
  "goal.model_unavailable",
  "goal.calculation_failed",
  "goal.stale_calculation",
])
export type ErrorCode = typeof ErrorCode.Type

export class Error extends Schema.TaggedErrorClass<Error>()("SessionGoal.Error", {
  code: ErrorCode,
}) {
  override get message() {
    return this.code
  }
}

type Dependencies = {
  readonly headers?: SessionModelHeaders.Options
  readonly events: EventRuntime.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly agents: Agent.Interface
  readonly config: Config.Interface
  readonly helpers: SessionHelperPolicy.Interface
  readonly requests: SessionProviderRequest.Interface
  readonly autonomy: SessionAutonomy.Interface
}

export interface Interface {
  readonly synthesize: (input: { session: SessionSchema.Info; text: string }) => Effect.Effect<string, Error>
  readonly steer: (input: {
    session: SessionSchema.Info
    goal: SessionAutonomy.Goal
    phase: "start" | "continue"
    latestAssistantText?: string
  }) => Effect.Effect<string, Error>
  readonly continuation: (input: {
    session: SessionSchema.Info
    goal: SessionAutonomy.Goal
    latestAssistantText?: string
  }) => Effect.Effect<{ readonly action: "continue"; readonly steer: string }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionGoal") {}

const make = (dependencies: Dependencies) => {
  const generate = Effect.fn("SessionGoal.generate")(
    function* (
      db: Database.Interface["db"],
      input: {
        readonly session: SessionSchema.Info
        readonly request: string | ((assistant: SessionMessage.Assistant | undefined) => string)
      },
    ) {
      const usageAnchor = yield* SessionUsageAttribution.dispatch(db, input.session.id)
      const agent = yield* dependencies.agents.get(Agent.ID.make("goal"))
      if (!agent) return yield* Effect.fail(new Error({ code: "goal.model_unavailable" }))
      const resolved = yield* dependencies.helpers.resolveModel(input.session, "goal", agent)
      if (!resolved) return yield* Effect.fail(new Error({ code: "goal.model_unavailable" }))
      const latestUser = yield* SessionHistory.latest(db, input.session.id, "user")
      const requestText =
        typeof input.request === "string"
          ? input.request
          : input.request(yield* SessionHistory.latest(db, input.session.id, "assistant"))
      const context = (yield* SessionHistory.recent(db, input.session.id, 12))
        .flatMap((message) => {
          if (message.type === "user") return [`User: ${message.text}`]
          if (message.type === "assistant")
            return [
              `Assistant: ${message.content
                .flatMap((part) => {
                  if (part.type === "text" || part.type === "reasoning") return [part.text]
                  return ToolInvocation.list(part).flatMap((call) => {
                    if (call.name !== "question" || call.status !== "completed" || typeof call.input !== "object" || call.input === null || typeof call.structured !== "object" || call.structured === null) return []
                    const input = call.input as Record<string, unknown>
                    const result = call.structured as Record<string, unknown>
                    const origin = result.automatic === true ? "automatic" : "source unreported"
                    return [`Question details (bounded): ${JSON.stringify({ questions: input.questions }).slice(0, 1_000)}\nQuestion tool result (${origin}): ${JSON.stringify({ answers: result.answers }).slice(0, 1_000)}`]
                  })
                })
                .join("\n")}`,
            ]
          if (message.type === "synthetic") return [`Synthetic observation (not a human reply): ${message.text}`]
          if (message.type === "system" || message.type === "skill")
            return [`Context: ${message.text}`]
          return []
        })
        .join("\n")
        .slice(-MAX_CONTEXT_CHARS)
      const baseRequest = LLM.request({
        model: resolved.model,
        http: {
          headers: SessionModelHeaders.make(input.session, {
            ...dependencies.headers,
            providerID: resolved.ref.providerID,
            accountIdentityDigest: resolved.accountIdentityDigest,
          }),
        },
        system: agent.system,
        messages: [Message.user(["Recent conversation context:", context || "(none)", "", requestText].join("\n"))],
        tools: [],
      })
      const namespaceInput = {
        projectID: input.session.projectID,
        directory: input.session.location.directory,
        workspaceID: input.session.location.workspaceID,
        providerID: resolved.ref.providerID,
        modelID: resolved.ref.id,
        variant: resolved.ref.variant,
        accountIdentityDigest: resolved.accountIdentityDigest,
        policyRevision: CACHE_POLICY_REVISION,
        permissions: agent.permissions,
        system: baseRequest.system,
        tools: baseRequest.tools,
      }
      const efficiency = SessionRunnerCache.efficiencySettings(
        Config.latest(yield* dependencies.config.entries(), "efficiency"),
      )
      const cache = SessionRunnerCache.providerOptions({
        ...namespaceInput,
        apiModelID: resolved.model.id,
        sessionID: input.session.id,
        routeID: resolved.model.route.id,
        anthropicTtlSeconds: SessionRunnerCache.anthropicTtlSeconds({
          modelID: resolved.model.id,
          configured: efficiency.anthropicTtl,
          interactive: false,
        }),
        openaiMode: efficiency.openaiMode,
        openaiExtendedRetention: efficiency.openaiExtendedRetention,
      })
      const tracker = yield* dependencies.requests.next({
        sessionID: input.session.id,
        inputID: latestUser?.id,
        usageAnchor: usageAnchor ?? null,
        source: "goal",
        agent: agent.id,
        model: resolved.ref,
        connectionIdentityDigest: resolved.accountIdentityDigest,
        routeID: resolved.model.route.id,
        promptCacheKey: cache.promptCacheKey,
        systemDigest: cache.systemDigest,
        toolDigest: cache.toolDigest,
      })
      const request = LLMRequest.update(baseRequest, {
        id: tracker.requestID,
        providerOptions: cache.providerOptions,
        cache: cache.cache,
      })
      const chunks: string[] = []
      let failed = false
      let settled = false
      let usage: SessionUsage.Recorded | undefined
      let recordedCost: Money.USD | undefined
      let timing: ReturnType<typeof SessionUsage.timing>
      const recordUsage = Effect.suspend(() =>
        usage
          ? dependencies.events.publish(SessionEvent.UsageRecorded, {
              sessionID: input.session.id,
              source: "goal",
              ...usage,
            })
          : Effect.void,
      )
      const completeRequest = (outcome: ProviderRequest.Outcome) => Effect.suspend(() => {
        const recorded = usage ?? {
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        return tracker.complete({
          tokens: recorded.tokens,
          ...(recordedCost === undefined ? {} : { cost: recordedCost }),
          continuation: "full",
          ...(timing === undefined ? {} : { timing }),
          ...(usage && usage.tokens.cache.read > 0 ? { invalidation: "stable-hit" as const } : {}),
          outcome,
        })
      })
      const streamed = yield* dependencies.llm.stream(request).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.finish(event)) settled = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          if (LLMEvent.is.stepFinish(event)) {
            timing = SessionUsage.timing(event.usage)
            const step = SessionUsage.record(event.usage, resolved.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
            if (SessionUsage.estimatedCost(resolved.cost, step.tokens, SessionUsage.oneHourCacheWrites(event.usage)) !== undefined)
              recordedCost = usage.cost
          }
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        Effect.onInterrupt(() => recordUsage.pipe(Effect.andThen(completeRequest("cancelled")), Effect.asVoid)),
      )
      yield* recordUsage
      yield* completeRequest(!streamed || failed || !settled ? "failed" : "completed")
      if (!streamed || failed || !settled) return yield* Effect.fail(new Error({ code: "goal.calculation_failed" }))
      const synthesized = chunks.join("").trim().replace(/\s+/g, " ")
      if (!synthesized) return yield* Effect.fail(new Error({ code: "goal.calculation_failed" }))
      return synthesized
    },
    (effect, db, input) => SessionUsageAttribution.contribute(db, input.session.id, effect),
  )
  const synthesize = Effect.fn("SessionGoal.synthesize")(
    (db: Database.Interface["db"], input: Parameters<Interface["synthesize"]>[0]) =>
      generate(db, { session: input.session, request: `Goal synthesis request:\n${input.text}` }),
  )
  const steer = Effect.fn("SessionGoal.steer")(
    function* (db: Database.Interface["db"], input: Parameters<Interface["steer"]>[0]) {
      const answers = yield* dependencies.autonomy
        .decisionMode(input.session.id, "answers")
        .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed("manual" as const)))
      return yield* generate(db, {
        session: input.session,
        request: (assistant) => {
          const latestAssistantText =
            input.latestAssistantText ??
            assistant?.content
              .filter(
                (part): part is Extract<(typeof assistant.content)[number], { type: "text" }> => part.type === "text",
              )
              .map((part) => part.text)
              .join("")
          return [
            "User-proxy steer request:",
            `Active goal: ${input.goal.text}`,
            `Phase: ${input.phase}`,
            `Current iteration: ${input.goal.iteration}`,
            `Answers decision mode: ${answers}`,
            `Latest assistant response: ${latestAssistantText?.trim().slice(-2_000) || "(none)"}`,
            "Preserve the active goal and produce only the next concise user-proxy steer.",
          ].join("\n")
        },
      })
    },
  )
  const continuation = Effect.fn("SessionGoal.continuation")(function* (
    db: Database.Interface["db"],
    input: Parameters<Interface["continuation"]>[0],
  ) {
    return {
      action: "continue" as const,
      steer: yield* steer(db, { ...input, phase: "continue" }),
    }
  })
  return { synthesize, steer, continuation }
}

export const layer = (options?: SessionModelHeaders.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const llm = yield* LLMClient.Service
      const agents = yield* Agent.Service
      const config = yield* Config.Service
      const helpers = yield* SessionHelperPolicy.Service
      const requests = yield* SessionProviderRequest.Service
      const database = yield* Database.Service
      const autonomy = yield* SessionAutonomy.Service
      const goal = make({ events, llm, agents, config, helpers, requests, autonomy, headers: options })
      return Service.of({
        synthesize: (input) =>
          goal
            .synthesize(database.db, input)
            .pipe(
              Effect.catchTag("Session.MessageDecodeError", () =>
                Effect.fail(new Error({ code: "goal.calculation_failed" })),
              ),
            ),
        steer: (input) =>
          goal
            .steer(database.db, input)
            .pipe(
              Effect.catchTag("Session.MessageDecodeError", () =>
                Effect.fail(new Error({ code: "goal.calculation_failed" })),
              ),
            ),
        continuation: (input) =>
          goal
            .continuation(database.db, input)
            .pipe(
              Effect.catchTag("Session.MessageDecodeError", () =>
                Effect.fail(new Error({ code: "goal.calculation_failed" })),
              ),
            ),
      })
    }),
  )

export function configured(options?: SessionModelHeaders.Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      EventRuntime.node,
      llmClient,
      Agent.node,
      Config.node,
      SessionHelperPolicy.node,
      SessionProviderRequest.node,
      Database.node,
      SessionAutonomy.node,
    ],
  })
}

export const node = configured()
