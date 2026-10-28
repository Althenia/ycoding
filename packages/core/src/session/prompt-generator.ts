export * as SessionPromptGenerator from "./prompt-generator"

import { LLM, LLMClient, LLMEvent, LLMRequest, Message } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Context, Effect, Fiber, FiberSet, Layer, Stream } from "effect"
import { Agent } from "../agent"
import { Config } from "../config"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventRuntime } from "../event"
import { Location } from "../location"
import { Memory } from "../memory"
import { Permission } from "../permission"
import { Money } from "@ycoding-ai/schema/money"
import { SessionEvent } from "./event"
import { SessionHelperPolicy } from "./helper-policy"
import { SessionHistory } from "./history"
import { SessionModelHeaders } from "./model-headers"
import { SessionProviderRequest } from "./provider-request"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { SessionUsageAttribution } from "./usage-attribution"
import { SessionRunnerCache } from "./runner/cache"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionUsage } from "./usage"

export type Mode = "start" | "steer" | "queue" | "goal"
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Bidi_Control}\u2028\u2029]/u
const REFUSAL = /^(?:i cannot\b|i can't\b|i can’t\b|sorry\b|as an ai\b)/iu

/** Memory search rejects queries longer than 1024 characters. */
const memoryQuery = (intent: string, user?: string, assistant?: string) => {
  const head = intent.trim()
  const tail = [user, assistant].filter((part): part is string => part !== undefined && part.length > 0).join(" ")
  if (!tail) return head.slice(0, 1024)
  const intentPart = head.slice(0, Math.min(head.length, 512))
  return `${intentPart} ${tail.slice(0, 1024 - intentPart.length - 1)}`
}

const unwrap = (value: string) => {
  const fenced = value.match(/^```[^\n`]*\n([\s\S]*)\n```$/)
  const body = (fenced ? (fenced[1] ?? "") : value).trim()
  const quoted =
    body.match(/^"([\s\S]*)"$/) ??
    body.match(/^'([\s\S]*)'$/) ??
    body.match(/^“([\s\S]*)”$/) ??
    body.match(/^‘([\s\S]*)’$/)
  return (quoted ? (quoted[1] ?? "") : body).trim()
}

export const accept = (output: string) => {
  const text = unwrap(output.trim())
  if (!text || text.length > 8000 || FORBIDDEN.test(text) || REFUSAL.test(text)) return
  return text
}

export interface Interface {
  readonly request: (
    sessionID: SessionSchema.ID,
    input: {
      readonly mode: Mode
      readonly intent: string
      readonly memory: ReadonlyArray<"repository" | "knowledge">
    },
  ) => Effect.Effect<{ readonly status: "generated"; readonly text: string } | { readonly status: "unavailable" }>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionPromptGenerator") {}

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
      const store = yield* SessionStore.Service
      const memory = yield* Memory.Service
      const permission = yield* Permission.Service
      const location = yield* Location.Service
      const unavailable = { status: "unavailable" as const }
      type Outcome = typeof unavailable | { readonly status: "generated"; readonly text: string }
      const fork = yield* FiberSet.makeRuntime<never, Outcome, never>()
      const active = new Map<SessionSchema.ID, { cancelled: boolean; fiber?: Fiber.Fiber<Outcome> }>()
      const eligible = Effect.fn("SessionPromptGenerator.eligible")(function* (sessionID: SessionSchema.ID) {
        const session = yield* store.get(sessionID)
        if (
          !session ||
          session.location.directory !== location.directory ||
          session.location.workspaceID !== location.workspaceID
        )
          return
        const history = (yield* SessionHistory.snapshotWindow(database.db, sessionID, 20)).messages
        return {
          session,
          user: history.findLast((message) => message.type === "user"),
          assistant: history.findLast((message) => message.type === "assistant"),
        }
      })
      const generate = Effect.fn("SessionPromptGenerator.generate")(function* (
        sessionID: SessionSchema.ID,
        input: {
          readonly mode: Mode
          readonly intent: string
          readonly memory: ReadonlyArray<"repository" | "knowledge">
        },
        owner: { cancelled: boolean },
      ) {
        if (owner.cancelled) return unavailable
        const usageAnchor = yield* SessionUsageAttribution.dispatch(database.db, sessionID)
        const context = yield* eligible(sessionID)
        const intent = input.intent.trim()
        if (!context || !intent || owner.cancelled) return unavailable
        const agent = yield* agents.get(Agent.ID.make("prompt"))
        if (!agent) return unavailable
        const resolved = yield* helpers.resolveModel(context.session, "prompt", agent)
        if (!resolved || owner.cancelled) return unavailable
        const recentUser =
          context.user?.type === "user" && context.user.text.trim() ? context.user.text.slice(-2000) : undefined
        const assistantText =
          context.assistant?.type === "assistant"
            ? context.assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
            : ""
        const recentAssistant = assistantText.trim() ? assistantText.slice(-4000) : undefined
        const actingAgent =
          context.session.agent ?? (context.assistant?.type === "assistant" ? context.assistant.agent : undefined)
        const snippets = yield* Effect.forEach(input.memory, (scope) =>
          Effect.gen(function* () {
            const status = yield* memory.status(scope)
            if (!status.enabled || (scope === "repository" && !status.repository)) return []
            const access = yield* permission.evaluateEffective({
              sessionID,
              agent: actingAgent,
              action: "memory_read",
              resource: status.root,
            })
            if (access !== "allow" && access !== "ask") return []
            const result = yield* memory.search(
              { scope, query: memoryQuery(intent, recentUser, recentAssistant), limit: 3 },
              status.root,
            )
            return result.hits.slice(0, 3).map((hit) => ({
              scope,
              id: hit.id,
              ...(hit.title === undefined ? {} : { title: hit.title.slice(0, 200) }),
              snippet: hit.snippet.slice(0, 600),
            }))
          }).pipe(Effect.catchCause(() => Effect.succeed([]))),
        )
        if (owner.cancelled) return unavailable
        const recent = {
          ...(recentUser === undefined ? {} : { user: recentUser }),
          ...(recentAssistant === undefined ? {} : { assistant: recentAssistant }),
        }
        const baseRequest = LLM.request({
          model: resolved.model,
          http: {
            headers: SessionModelHeaders.make(context.session, {
              ...options,
              providerID: resolved.ref.providerID,
              accountIdentityDigest: resolved.accountIdentityDigest,
            }),
          },
          system: agent.system,
          messages: [
            Message.user(
              JSON.stringify({
                mode: input.mode,
                intent,
                ...(recentUser === undefined && recentAssistant === undefined ? {} : { recent }),
                memory: snippets.flat(),
              }),
            ),
          ],
          tools: [],
        })
        const entries = yield* config.entries()
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
            modelID: resolved.model.id,
            configured: efficiency.anthropicTtl,
            interactive: false,
          }),
          openaiMode: efficiency.openaiMode,
          openaiExtendedRetention: efficiency.openaiExtendedRetention,
        })
        const tracker = yield* requests.next({
          sessionID,
          ...(context.user?.type === "user" ? { inputID: context.user.id } : {}),
          usageAnchor: usageAnchor ?? null,
          source: "prompt",
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
        let providerFailed = false
        let finished = false
        let outcome: ProviderRequest.Outcome = "cancelled"
        let usage: SessionUsage.Recorded | undefined
        let recordedCost: Money.USD | undefined
        let timing: ReturnType<typeof SessionUsage.timing>
        const settle = Effect.suspend(() =>
          Effect.gen(function* () {
            if (usage) yield* events.publish(SessionEvent.UsageRecorded, { sessionID, source: "prompt", ...usage })
            yield* tracker.complete({
              tokens: usage?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              ...(recordedCost === undefined ? {} : { cost: recordedCost }),
              continuation: "full",
              ...(timing === undefined ? {} : { timing }),
              ...(usage && usage.tokens.cache.read > 0 ? { invalidation: "stable-hit" as const } : {}),
              outcome,
            })
          }),
        )
        const streamed = yield* llm.stream(request).pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event)) {
              failed = true
              providerFailed = true
            }
            if (LLMEvent.is.finish(event)) {
              finished = true
              if (event.reason !== "stop") failed = true
            }
            if (LLMEvent.is.textDelta(event)) {
              if (chunks.join("").length + event.text.length > 8000) failed = true
              if (!failed) chunks.push(event.text)
            }
            if (LLMEvent.is.stepFinish(event)) {
              timing = SessionUsage.timing(event.usage)
              const step = SessionUsage.record(event.usage, resolved.cost)
              usage = usage ? SessionUsage.add(usage, step) : step
              if (SessionUsage.estimatedCost(resolved.cost, step.tokens, SessionUsage.oneHourCacheWrites(event.usage)) !== undefined)
                recordedCost = usage.cost
            }
            return Effect.void
          }),
          Effect.onExit((exit) => Effect.sync(() => {
            outcome = SessionProviderRequest.outcome(exit, providerFailed || !finished)
          })),
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
          Effect.ensuring(Effect.uninterruptible(settle)),
        )
        if (!streamed || failed || !finished || owner.cancelled) return unavailable
        const text = accept(chunks.join(""))
        if (!text || owner.cancelled) return unavailable
        return { status: "generated" as const, text }
      })
      const request: Interface["request"] = (sessionID, input) =>
        Effect.gen(function* () {
          const usageAnchor = yield* SessionUsageAttribution.dispatch(database.db, sessionID)
          const prior = active.get(sessionID)
          if (prior) {
            prior.cancelled = true
            if (prior.fiber) yield* Fiber.interrupt(prior.fiber)
          }
          const owner: { cancelled: boolean; fiber?: Fiber.Fiber<Outcome> } = { cancelled: false }
          active.set(sessionID, owner)
          const fiber = fork(
            SessionUsageAttribution.withAnchor(
              sessionID,
              usageAnchor,
              Effect.yieldNow.pipe(
                Effect.andThen(generate(sessionID, input, owner)),
                Effect.interruptible,
                Effect.catchCause(() => Effect.succeed(unavailable)),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (active.get(sessionID) === owner) active.delete(sessionID)
                  }),
                ),
              ),
            ),
          )
          owner.fiber = fiber
          const exit = yield* Fiber.await(fiber)
          if (exit._tag === "Success") return exit.value
          return unavailable
        })
      const stop = yield* events.listen((event) =>
        Effect.sync(() => {
          if (
            typeof event.data !== "object" ||
            event.data === null ||
            !("sessionID" in event.data) ||
            typeof event.data.sessionID !== "string"
          )
            return
          const sessionID = SessionSchema.ID.make(event.data.sessionID)
          if (["session.moved", "session.deleted", "session.archived"].includes(event.type)) {
            const owner = active.get(sessionID)
            if (owner) {
              owner.cancelled = true
              if (owner.fiber) fork(Fiber.interrupt(owner.fiber).pipe(Effect.as(unavailable)))
            }
          }
        }),
      )
      yield* Effect.addFinalizer(() => stop)
      return Service.of({ request })
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [
    EventRuntime.node,
    llmClient,
    Agent.node,
    Config.node,
    SessionHelperPolicy.node,
    SessionProviderRequest.node,
    Database.node,
    SessionStore.node,
    Memory.node,
    Permission.node,
    Location.node,
  ],
})
