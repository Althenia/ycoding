export * as SessionPrediction from "./prediction"

import { LLM, LLMClient, LLMEvent, LLMRequest, Message } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Context, Effect, Fiber, FiberSet, Layer, Stream } from "effect"
import { Agent } from "../agent"
import { Config } from "../config"
import { ConfigPrediction } from "../config/prediction"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventRuntime } from "../event"
import { Location } from "../location"
import { Memory } from "../memory"
import { Permission } from "../permission"
import { Money } from "@ycoding-ai/schema/money"
import { SessionEvent } from "./event"
import { SessionAutonomy } from "./autonomy"
import { SessionHelperPolicy } from "./helper-policy"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionModelHeaders } from "./model-headers"
import { SessionPending } from "./pending"
import { SessionProviderRequest } from "./provider-request"
import { SessionRunnerCache } from "./runner/cache"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionUsage } from "./usage"

export const accept = (output: string, previous: string) => {
  const text = output.trim()
  const words = text.split(/\s+/).length
  if (
    !text || words < 2 || words > 20 || text.length > 200 ||
    /[\r\n\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(text)
  ) return
  if (/^["'“”‘’`#>{\[]|^(?:(?:suggested )?(?:suggestion|prediction|prompt|message)|next (?:message|prompt)|user)\s*[:\-]/iu.test(text)) return
  if (/^(?:(?:an? )?(?:error|exception|failure)\b|failed\b|traceback\b|http\s*\d{3}\b|no (?:\w+ )?(?:suggestion|prediction)|nothing\b|none\b|n\/a\b|(?:i|we) (?:cannot|can't|can’t|am unable)|sorry\b|as an (?:ai|assistant)|there (?:is|are) no\b|(?:the )?user (?:might|may|will|would)|(?:the )?next (?:message|prompt) (?:is|could|might))/iu.test(text)) return
  if (text.toLocaleLowerCase().replace(/\s+/g, " ") === previous.trim().toLocaleLowerCase().replace(/\s+/g, " ")) return
  return text
}

export interface Interface {
  readonly generateForReply: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionPrediction") {}

export const layer = (options?: SessionModelHeaders.Options) => Layer.effect(Service, Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const llm = yield* LLMClient.Service
  const agents = yield* Agent.Service
  const config = yield* Config.Service
  const helpers = yield* SessionHelperPolicy.Service
  const requests = yield* SessionProviderRequest.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const memory = yield* Memory.Service
  const permission = yield* Permission.Service
  const location = yield* Location.Service
  const autonomy = yield* SessionAutonomy.Service
  const fork = yield* FiberSet.makeRuntime<never, void, never>()
  const active = new Map<SessionSchema.ID, { cancelled: boolean; fiber?: Fiber.Fiber<void> }>()
  const attempted = new Map<SessionSchema.ID, SessionMessage.ID>()
  const eligible = Effect.fn("SessionPrediction.eligible")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (
      !session || session.parentID || session.location.directory !== location.directory ||
      session.location.workspaceID !== location.workspaceID
    ) return
    if ((yield* autonomy.snapshot(sessionID)).state.goal?.status === "active") return
    if (
      (yield* SessionPending.list(database.db, sessionID)).length ||
      (yield* SessionPending.compaction(database.db, sessionID))
    ) return
    const history = (yield* SessionHistory.snapshotWindow(database.db, sessionID, 20)).messages
    const assistant = history.findLast(message => message.type === "assistant")
    const user = history.findLast(message => message.type === "user")
    if (
      !assistant || !user || !assistant.time.completed || assistant.error ||
      history.indexOf(user) > history.indexOf(assistant)
    ) return
    const text = assistant.content.flatMap(part => part.type === "text" ? [part.text] : []).join("")
    if (!text.trim() || !user.text.trim()) return
    return { session, user, assistant, text }
  })
  const generate = Effect.fn("SessionPrediction.generate")(function* (sessionID: SessionSchema.ID, owner: { cancelled: boolean }) {
    const entries = yield* config.entries()
    const settings = ConfigPrediction.resolve(
      entries.flatMap(entry => entry.type === "document" && entry.info.prediction ? [entry.info.prediction] : []),
    )
    if (!settings.enabled || owner.cancelled) return
    const context = yield* eligible(sessionID)
    if (!context || owner.cancelled || attempted.get(sessionID) === context.assistant.id) return
    attempted.set(sessionID, context.assistant.id)
    const agent = yield* agents.get(Agent.ID.make("prediction"))
    if (!agent) return
    const resolved = yield* helpers.resolveModel(context.session, "prediction", agent)
    if (!resolved || owner.cancelled) return
    const recent = { user: context.user.text.slice(-2000), assistant: context.text.slice(-4000) }
    const snippets = settings.memory
      ? yield* Effect.forEach(["repository", "knowledge"] as const, scope => Effect.gen(function* () {
          const status = yield* memory.status(scope)
          if (!status.enabled || (scope === "repository" && !status.repository)) return []
          const access = yield* permission.evaluateEffective({
            sessionID, agent: context.session.agent ?? context.assistant.agent,
            action: "memory_read", resource: status.root,
          })
          if (access !== "allow") return []
          const result = yield* memory.search(
            { scope, query: `${recent.user.slice(0, 512)} ${recent.assistant.slice(0, 511)}`, limit: 3 }, status.root,
          )
          return result.hits.slice(0, 3).map(hit => ({
            scope, id: hit.id,
            ...(hit.title === undefined ? {} : { title: hit.title.slice(0, 200) }),
            snippet: hit.snippet.slice(0, 600),
          }))
        }).pipe(Effect.catchCause(() => Effect.succeed([]))))
      : []
    if (owner.cancelled) return
    const baseRequest = LLM.request({
      model: resolved.model,
      http: { headers: SessionModelHeaders.make(context.session, {
        ...options, providerID: resolved.ref.providerID, accountIdentityDigest: resolved.accountIdentityDigest,
      }) },
      system: agent.system,
      messages: [Message.user(JSON.stringify({ ...recent, memory: snippets.flat() }))],
      tools: [],
    })
    const efficiency = SessionRunnerCache.efficiencySettings(Config.latest(entries, "efficiency"))
    const cache = SessionRunnerCache.providerOptions({
      projectID: context.session.projectID,
      directory: context.session.location.directory,
      workspaceID: context.session.location.workspaceID,
      providerID: resolved.ref.providerID,
      modelID: resolved.ref.id,
      variant: resolved.ref.variant,
      accountIdentityDigest: resolved.accountIdentityDigest,
      policyRevision: CACHE_POLICY_REVISION,
      permissions: agent.permissions,
      system: baseRequest.system,
      tools: baseRequest.tools,
      apiModelID: resolved.model.id,
      sessionID,
      routeID: resolved.model.route.id,
      anthropicTtlSeconds: SessionRunnerCache.anthropicTtlSeconds({
        modelID: resolved.model.id, configured: efficiency.anthropicTtl, interactive: false,
      }),
      openaiMode: efficiency.openaiMode,
      openaiExtendedRetention: efficiency.openaiExtendedRetention,
    })
    const tracker = yield* requests.next({
      sessionID, inputID: context.user.id, source: "prediction", agent: agent.id, model: resolved.ref,
      connectionIdentityDigest: resolved.accountIdentityDigest,
      routeID: resolved.model.route.id,
      promptCacheKey: cache.promptCacheKey,
      systemDigest: cache.systemDigest,
      toolDigest: cache.toolDigest,
    })
    const request = LLMRequest.update(baseRequest, {
      id: tracker.requestID, providerOptions: cache.providerOptions, cache: cache.cache,
    })
    const chunks: string[] = []
    let failed = false
    let finished = false
    let usage: SessionUsage.Recorded | undefined
    let recordedCost: Money.USD | undefined
    let timing: ReturnType<typeof SessionUsage.timing>
    const settle = Effect.suspend(() => Effect.gen(function* () {
      if (usage) yield* events.publish(SessionEvent.UsageRecorded, { sessionID, source: "prediction", ...usage })
      yield* tracker.complete({
        tokens: usage?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        ...(recordedCost === undefined ? {} : { cost: recordedCost }),
        continuation: "full",
        ...(timing === undefined ? {} : { timing }),
        ...(usage && usage.tokens.cache.read > 0 ? { invalidation: "stable-hit" as const } : {}),
      })
    }))
    const streamed = yield* llm.stream(request).pipe(
      Stream.runForEach(event => {
        if (LLMEvent.is.providerError(event)) failed = true
        if (LLMEvent.is.finish(event)) {
          finished = true
          if (event.reason !== "stop") failed = true
        }
        if (LLMEvent.is.textDelta(event)) {
          if (chunks.join("").length + event.text.length > 200) failed = true
          if (!failed) chunks.push(event.text)
        }
        if (LLMEvent.is.stepFinish(event)) {
          timing = SessionUsage.timing(event.usage)
          const step = SessionUsage.record(event.usage, resolved.cost)
          usage = usage ? SessionUsage.add(usage, step) : step
          if (SessionUsage.estimatedCost(resolved.cost, step.tokens, SessionUsage.oneHourCacheWrites(event.usage)))
            recordedCost = usage.cost
        }
        return Effect.void
      }),
      Effect.as(true), Effect.catchCause(() => Effect.succeed(false)), Effect.ensuring(settle),
    )
    if (!streamed || failed || !finished || owner.cancelled) return
    const text = accept(chunks.join(""), context.user.text)
    if (!text) return
    const current = yield* eligible(sessionID)
    if (
      !current || current.assistant.id !== context.assistant.id ||
      current.user.id !== context.user.id || owner.cancelled
    ) return
    yield* events.publish(
      SessionEvent.PredictionUpdated,
      { sessionID, sourceMessageID: context.assistant.id, text },
      { location: context.session.location },
    )
  })
  const generateForReply = (sessionID: SessionSchema.ID) => Effect.gen(function* () {
    const prior = active.get(sessionID)
    if (prior) return
    const owner: { cancelled: boolean; fiber?: Fiber.Fiber<void> } = { cancelled: false }
    active.set(sessionID, owner)
    const fiber = fork(Effect.yieldNow.pipe(
      Effect.andThen(generate(sessionID, owner)),
      Effect.interruptible,
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(Effect.sync(() => { if (active.get(sessionID) === owner) active.delete(sessionID) })),
    ))
    owner.fiber = fiber
    yield* Fiber.await(fiber)
  })
  const stop = yield* events.listen(event => Effect.sync(() => {
    if (typeof event.data !== "object" || event.data === null || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = SessionSchema.ID.make(event.data.sessionID)
    if (["session.input.admitted", "session.execution.started", "session.moved", "session.deleted", "session.archived"].includes(event.type)) {
      const owner = active.get(sessionID)
      if (owner) {
        owner.cancelled = true
        if (owner.fiber) fork(Fiber.interrupt(owner.fiber))
      }
    }
    if (event.type === "session.deleted") attempted.delete(sessionID)
    if (event.type === "session.execution.succeeded") fork(generateForReply(sessionID))
  }))
  yield* Effect.addFinalizer(() => stop)
  return Service.of({ generateForReply })
}))

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [
    EventRuntime.node, llmClient, Agent.node, Config.node, SessionHelperPolicy.node,
    SessionProviderRequest.node, Database.node, SessionStore.node, Memory.node,
    Permission.node, Location.node, SessionAutonomy.node,
  ],
})
