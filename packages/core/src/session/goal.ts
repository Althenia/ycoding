export * as SessionGoal from "./goal"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Context, Effect, Layer, Stream } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventV2 } from "../event"
import { Money } from "@ycoding-ai/schema/money"
import { SessionEvent } from "./event"
import { SessionHelperPolicy } from "./helper-policy"
import { SessionHistory } from "./history"
import { SessionModelHeaders } from "./model-headers"
import { SessionProviderRequest } from "./provider-request"
import { SessionRunnerCache } from "./runner/cache"
import { SessionCacheRuntime } from "./runner/cache-runtime"
import { SessionSchema } from "./schema"
import { SessionUsage } from "./usage"

const MAX_CONTEXT_CHARS = 6_000

type Dependencies = {
  readonly headers?: SessionModelHeaders.Options
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly agents: AgentV2.Interface
  readonly config: Config.Interface
  readonly helpers: SessionHelperPolicy.Interface
  readonly requests: SessionProviderRequest.Interface
  readonly cacheRuntime: SessionCacheRuntime.Interface
}

export interface Interface {
  readonly synthesize: (input: { session: SessionSchema.Info; text: string }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionGoal") {}

const make = (dependencies: Dependencies) => {
  const synthesize = Effect.fn("SessionGoal.synthesize")(function* (
    db: Database.Interface["db"],
    input: Parameters<Interface["synthesize"]>[0],
  ) {
    if (dependencies.helpers.settings.goalMode === "local")
      return dependencies.helpers.localGoal(input.text) || undefined
    const agent = yield* dependencies.agents.get(AgentV2.ID.make("goal"))
    if (!agent) return
    const resolved = yield* dependencies.helpers.resolveModel(input.session, "goal", agent)
    if (!resolved) return
    const history = yield* SessionHistory.load(db, input.session.id)
    const context = history
      .slice(-12)
      .flatMap((message) => {
        if (message.type === "user") return [`User: ${message.text}`]
        if (message.type === "assistant")
          return [
            `Assistant: ${message.content
              .filter((part) => part.type === "text" || part.type === "reasoning")
              .map((part) => part.text)
              .join("\n")}`,
          ]
        if (message.type === "system" || message.type === "synthetic" || message.type === "skill")
          return [`Context: ${message.text}`]
        return []
      })
      .join("\n")
      .slice(-MAX_CONTEXT_CHARS)
    const baseRequest = LLM.request({
      model: resolved.model,
      http: { headers: SessionModelHeaders.make(input.session, dependencies.headers) },
      system: agent.system,
      messages: [
        Message.user(["Recent conversation context:", context || "(none)", "", "User request:", input.text].join("\n")),
      ],
      tools: [],
    })
    const namespaceInput = {
      projectID: input.session.projectID,
      directory: input.session.location.directory,
      workspaceID: input.session.location.workspaceID,
      providerID: resolved.ref.providerID,
      modelID: resolved.ref.id,
      variant: resolved.ref.variant ?? "default",
      policyRevision: CACHE_POLICY_REVISION,
      permissions: agent.permissions,
      system: baseRequest.system,
      tools: baseRequest.tools,
    }
    const efficiency = SessionRunnerCache.efficiencySettings(
      Config.latest(yield* dependencies.config.entries(), "efficiency"),
    )
    const ttl = yield* dependencies.cacheRuntime.policy({
      namespace: SessionRunnerCache.promptCacheNamespace(namespaceInput),
      modelID: resolved.model.id,
      configured: efficiency.anthropicTtl,
    })
    const cache = SessionRunnerCache.providerOptions({
      ...namespaceInput,
      apiModelID: resolved.model.id,
      sessionID: input.session.id,
      routeID: resolved.model.route.id,
      anthropicTtlSeconds: ttl.ttlSeconds,
      openaiMode: efficiency.openaiMode,
      openaiExtendedRetention: efficiency.openaiExtendedRetention,
    })
    const tracker = yield* dependencies.requests.next({
      sessionID: input.session.id,
      inputID: history.findLast((message) => message.type === "user")?.id,
      source: "goal",
      agent: agent.id,
      model: resolved.ref,
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
    let usage: SessionUsage.Recorded | undefined
    const recordUsage = Effect.suspend(() =>
      usage
        ? dependencies.events.publish(SessionEvent.UsageRecorded, {
            sessionID: input.session.id,
            source: "goal",
            ...usage,
          })
        : Effect.void,
    )
    const completeRequest = Effect.suspend(() => {
      const recorded = usage ?? {
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      return Effect.all(
        [
          tracker.complete({
            tokens: recorded.tokens,
            ...(usage === undefined || SessionUsage.estimatedCost(resolved.cost, recorded.tokens) === undefined
              ? {}
              : { cost: SessionUsage.estimatedCost(resolved.cost, recorded.tokens)! }),
            continuation: "full",
            ...(usage && usage.tokens.cache.read > 0 ? { invalidation: "stable-hit" as const } : {}),
          }),
          dependencies.cacheRuntime.observe({
            namespace: cache.promptCacheKey,
            cacheRead: recorded.tokens.cache.read,
            cacheWrite: recorded.tokens.cache.write,
            eligible: recorded.tokens.input + recorded.tokens.cache.read + recorded.tokens.cache.write,
          }),
        ],
        { discard: true },
      )
    })
    const streamed = yield* dependencies.llm.stream(request).pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event)) failed = true
        if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
        if (LLMEvent.is.stepFinish(event)) {
          const step = SessionUsage.record(event.usage, resolved.cost)
          usage = usage ? SessionUsage.add(usage, step) : step
        }
        return Effect.void
      }),
      Effect.as(true),
      Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      Effect.onInterrupt(() => recordUsage.pipe(Effect.andThen(completeRequest), Effect.asVoid)),
    )
    yield* recordUsage
    yield* completeRequest
    if (!streamed || failed) return
    return chunks.join("").trim().replace(/\s+/g, " ") || undefined
  })
  return { synthesize }
}

export const layer = (options?: SessionModelHeaders.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const llm = yield* LLMClient.Service
      const agents = yield* AgentV2.Service
      const config = yield* Config.Service
      const helpers = yield* SessionHelperPolicy.Service
      const requests = yield* SessionProviderRequest.Service
      const cacheRuntime = yield* SessionCacheRuntime.Service
      const database = yield* Database.Service
      const goal = make({ events, llm, agents, config, helpers, requests, cacheRuntime, headers: options })
      return Service.of({
        synthesize: (input) => goal.synthesize(database.db, input).pipe(Effect.catch(() => Effect.succeed(undefined))),
      })
    }),
  )

export function configured(options?: SessionModelHeaders.Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      EventV2.node,
      llmClient,
      AgentV2.node,
      Config.node,
      SessionHelperPolicy.node,
      SessionProviderRequest.node,
      SessionCacheRuntime.node,
      Database.node,
    ],
  })
}

export const node = configured()
