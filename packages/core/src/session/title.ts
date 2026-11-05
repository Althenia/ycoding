export * as SessionTitle from "./title"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Context, Effect, Layer, Stream } from "effect"
import { Agent } from "../agent"
import { Config } from "../config"
import { StandaloneConfig } from "../config/standalone"
import { StandaloneAgent } from "../plugin/standalone-agent"
import { Database } from "../database/database"
import { EventRuntime } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { Money } from "@ycoding-ai/schema/money"
import { SessionEvent } from "./event"
import { SessionHelperPolicy } from "./helper-policy"
import { StandaloneHelperPolicy } from "./standalone-helper-policy"
import { SessionHistory } from "./history"
import { SessionModelHeaders } from "./model-headers"
import { SessionProviderRequest } from "./provider-request"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { SessionUsageAttribution } from "./usage-attribution"
import { SessionRunnerCache } from "./runner/cache"
import type { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionUsage } from "./usage"

const MAX_LENGTH = 100
const REFUSAL =
  /^(?:["'“‘`]\s*)?(?:unfortunately[,:]?\s+)?(?:(?:i|we)\s+(?:cannot|can['’]t|won['’]t|will not|(?:am|are)\s+(?:unable|not able)|(?:(?:must|have to)\s+)?(?:decline|refuse))\b|(?:i['’]m|we['’]re|i am|we are)\s+(?:sorry|unable|not able)\b|sorry\b|as an (?:ai|assistant)\b)/iu

type Dependencies<E> = {
  readonly headers?: SessionModelHeaders.Options
  readonly events: EventRuntime.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly agents: Agent.Interface
  readonly entries: () => Effect.Effect<ReadonlyArray<Config.Entry>, E>
  readonly helpers: {
    readonly settings: () => Effect.Effect<SessionHelperPolicy.Settings, E>
    readonly localTitle: SessionHelperPolicy.Interface["localTitle"]
    readonly resolveModel: (session: SessionSchema.Info, role: SessionHelperPolicy.Role, agent?: Agent.Info) => Effect.Effect<SessionRunnerModel.Resolved | undefined, E>
  }
  readonly check?: Effect.Effect<void, E>
  readonly rename: (sessionID: SessionSchema.ID, title: string) => Effect.Effect<void, E>
  readonly requests: SessionProviderRequest.Interface
}

export interface Interface {
  /** Generates a title from the session's first user message and renames the session. Runs at most once per session. */
  readonly generateForFirstPrompt: (session: SessionSchema.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionTitle") {}

const UNTITLED = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)

const make = <E>(dependencies: Dependencies<E>) => {
  const generateForFirstPrompt = Effect.fn("SessionTitle.generateForFirstPrompt")(function* (
    db: Database.Interface["db"],
    session: SessionSchema.Info,
  ) {
    if (session.parentID || !UNTITLED.test(session.title)) return
    const firstUser = yield* SessionHistory.firstUserMessageIfOnly(db, session.id)
    if (!firstUser) return
    const anchor = yield* SessionUsageAttribution.resolve(db, { sessionID: session.id, inputID: firstUser.id })
    return yield* SessionUsageAttribution.withAnchor(
      session.id,
      anchor,
      Effect.gen(function* () {
        const mode =
          Config.latest(yield* dependencies.entries(), "efficiency")?.title ??
          (yield* dependencies.helpers.settings()).titleMode
        if (mode === "off") return
        if (mode === "local") {
          yield* dependencies.rename(session.id, dependencies.helpers.localTitle(firstUser.text))
          return
        }
        const agent = yield* dependencies.agents.get(Agent.ID.make("title"))
        if (!agent) {
          yield* dependencies.rename(session.id, dependencies.helpers.localTitle(firstUser.text))
          return
        }
        const resolved = yield* dependencies.helpers.resolveModel(session, "title", agent)
        if (!resolved) {
          yield* dependencies.rename(session.id, dependencies.helpers.localTitle(firstUser.text))
          return
        }
        const baseRequest = LLM.request({
          model: resolved.model,
          http: {
            headers: SessionModelHeaders.make(session, {
              ...dependencies.headers,
              providerID: resolved.ref.providerID,
              accountIdentityDigest: resolved.accountIdentityDigest,
            }),
          },
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
          variant: resolved.ref.variant,
          accountIdentityDigest: resolved.accountIdentityDigest,
          policyRevision: CACHE_POLICY_REVISION,
          permissions: agent.permissions,
          system: baseRequest.system,
          tools: baseRequest.tools,
        }
        const efficiency = SessionRunnerCache.efficiencySettings(
          Config.latest(yield* dependencies.entries(), "efficiency"),
        )
        const cache = SessionRunnerCache.providerOptions({
          ...namespaceInput,
          apiModelID: resolved.model.id,
          sessionID: session.id,
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
          sessionID: session.id,
          inputID: firstUser.id,
          source: "title",
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
        const blocks = new Map<string, { readonly chunks: string[]; commentary: boolean }>()
        let failed = false
        let providerFailed = false
        let usage: SessionUsage.Recorded | undefined
        let recordedCost: Money.USD | undefined
        let timing: ReturnType<typeof SessionUsage.timing>
        const recordUsage = Effect.suspend(() =>
          usage
            ? dependencies.events.publish(SessionEvent.UsageRecorded, {
                sessionID: session.id,
                source: "title",
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
        if (dependencies.check) yield* dependencies.check
        const streamed = yield* dependencies.llm.stream(request).pipe(
          Stream.tap(tracker.observeEvent),
          Stream.onExit(() => tracker.settle()),
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event)) {
              failed = true
              providerFailed = true
              return Effect.logWarning("Session title provider request failed", {
                sessionID: session.id,
                message: event.message,
              })
            }
            if ((LLMEvent.is.stepFinish(event) || LLMEvent.is.finish(event)) && event.reason === "content-filter")
              failed = true
            if (LLMEvent.is.textDelta(event) || LLMEvent.is.textEnd(event)) {
              const block = blocks.get(event.id) ?? { chunks: [], commentary: false }
              blocks.set(event.id, block)
              if (event.providerMetadata?.openai?.phase === "commentary") block.commentary = true
              if (LLMEvent.is.textDelta(event)) block.chunks.push(event.text)
            }
            if (LLMEvent.is.stepFinish(event)) {
              timing = SessionUsage.timing(event.usage)
              const step = SessionUsage.record(event.usage, resolved.cost)
              usage = usage ? SessionUsage.add(usage, step) : step
              if (
                SessionUsage.estimatedCost(resolved.cost, step.tokens, SessionUsage.oneHourCacheWrites(event.usage)) !==
                undefined
              )
                recordedCost = usage.cost
            }
            return Effect.void
          }),
          Effect.as(true),
          Effect.catchTag("LLM.Error", (error) =>
            Effect.logWarning("Session title provider request failed", {
              sessionID: session.id,
              reason: error.reason._tag,
              message: error.reason.message,
            }).pipe(Effect.as(false)),
          ),
          Effect.onInterrupt(() => recordUsage.pipe(Effect.andThen(completeRequest("cancelled")), Effect.asVoid)),
        )
        yield* recordUsage
        yield* completeRequest(!streamed || providerFailed ? "failed" : "completed")
        if (!streamed || failed) {
          yield* dependencies.rename(session.id, dependencies.helpers.localTitle(firstUser.text))
          return
        }
        const title = [...blocks.values()]
          .filter((block) => !block.commentary)
          .flatMap((block) => block.chunks)
          .join("")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        if (!title || REFUSAL.test(title)) {
          yield* dependencies.rename(session.id, dependencies.helpers.localTitle(firstUser.text))
          return
        }
        yield* dependencies.rename(session.id, truncate(title))
      }),
    )
  })
  return { generateForFirstPrompt }
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
      const title = make({ events, llm, agents, entries: () => config.entries(), helpers: { ...helpers, settings: () => Effect.succeed(helpers.settings) }, requests, headers: options, rename: (sessionID, title) => events.publish(SessionEvent.Renamed, { sessionID, title }).pipe(Effect.asVoid) })
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
      EventRuntime.node,
      llmClient,
      Agent.node,
      Config.node,
      SessionHelperPolicy.node,
      SessionProviderRequest.node,
      Database.node,
    ],
  })
}

export const node = configured()

export class StandaloneService extends Context.Service<StandaloneService, {
  readonly generateForFirstPrompt: (session: SessionSchema.Info) => Effect.Effect<void, StandaloneConfig.InvalidError>
}>()("@ycoding/SessionTitle.Standalone") {}

export const standaloneNode = makeLocationNode({
  service: StandaloneService,
  layer: Layer.effect(StandaloneService, Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const llm = yield* LLMClient.Service
    const agents = yield* Agent.Service
    const agentState = yield* StandaloneAgent.Service
    const config = yield* StandaloneConfig.Service
    const helpers = yield* StandaloneHelperPolicy.Service
    const requests = yield* SessionProviderRequest.Service
    const database = yield* Database.Service
    return StandaloneService.of({ generateForFirstPrompt: (session) => Effect.gen(function* () {
      const current = yield* config.snapshot()
      yield* agentState.refresh()
      const title = make({
        events, llm, agents, helpers: { ...helpers, localTitle: SessionHelperPolicy.localTitle }, requests,
        entries: () => config.snapshot().pipe(Effect.map((snapshot) => snapshot.entries)),
        check: config.assert(current.generation),
        rename: (sessionID, title) => config.withCurrent(current.generation, () => events.publish(SessionEvent.Renamed, { sessionID, title }).pipe(Effect.asVoid)),
      })
      return yield* title.generateForFirstPrompt(database.db, session)
    }) })
  })),
  deps: [EventRuntime.node, llmClient, Agent.node, StandaloneAgent.node, StandaloneConfig.node, StandaloneHelperPolicy.node, SessionProviderRequest.node, Database.node],
})
