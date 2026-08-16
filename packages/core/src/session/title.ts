export * as SessionTitle from "./title"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Context, Effect, Layer, Stream } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
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

const MAX_LENGTH = 100

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
  /** Generates a title from the session's first user message and renames the session. Runs at most once per session. */
  readonly generateForFirstPrompt: (session: SessionSchema.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionTitle") {}

const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)

const make = (dependencies: Dependencies) => {
  const generateForFirstPrompt = Effect.fn("SessionTitle.generateForFirstPrompt")(function* (
    db: Database.Interface["db"],
    session: SessionSchema.Info,
  ) {
    if (session.parentID) return
    const firstUser = yield* SessionHistory.firstUserMessageIfOnly(db, session.id)
    if (!firstUser) return
    const mode = dependencies.helpers.settings.titleMode
    if (mode === "off") return
    if (mode === "local") {
      yield* dependencies.events.publish(SessionEvent.Renamed, {
        sessionID: session.id,
        title: dependencies.helpers.localTitle(firstUser.text),
      })
      return
    }
    const agent = yield* dependencies.agents.get(AgentV2.ID.make("title"))
    if (!agent) return
    const resolved = yield* dependencies.helpers.resolveModel(session, "title", agent)
    if (!resolved) return
    const baseRequest = LLM.request({
      model: resolved.model,
      http: { headers: SessionModelHeaders.make(session, dependencies.headers) },
      system: agent.system,
      messages: [Message.user(firstUser.text)],
      tools: [],
    })
    const namespaceInput = {
      projectID: session.projectID,
      directory: session.location.directory,
      workspaceID: session.location.workspaceID,
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
      sessionID: session.id,
      routeID: resolved.model.route.id,
      anthropicTtlSeconds: ttl.ttlSeconds,
      openaiMode: efficiency.openaiMode,
      openaiExtendedRetention: efficiency.openaiExtendedRetention,
    })
    const tracker = yield* dependencies.requests.next({
      sessionID: session.id,
      inputID: firstUser.id,
      source: "title",
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
            sessionID: session.id,
            source: "title",
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
    const title = chunks
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (!title) return
    yield* dependencies.events.publish(SessionEvent.Renamed, {
      sessionID: session.id,
      title: truncate(title),
    })
  })
  return { generateForFirstPrompt }
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
      const title = make({ events, llm, agents, config, helpers, requests, cacheRuntime, headers: options })
      return Service.of({
        generateForFirstPrompt: (session) => title.generateForFirstPrompt(database.db, session),
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
