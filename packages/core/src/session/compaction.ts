export * as SessionCompaction from "./compaction"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message, SystemPart, type Model } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { SessionError } from "@ycoding-ai/schema/session-error"
import { Context, Effect, Layer, Stream } from "effect"
import { Money } from "@ycoding-ai/schema/money"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { assembleCompactionConstraints } from "./compaction-constraints"
import { SessionEvent } from "./event"
import { SessionHelperPolicy } from "./helper-policy"
import type { SessionMessage } from "./message"
import { SessionModelHeaders } from "./model-headers"
import { SessionProviderRequest } from "./provider-request"
import { SessionRunnerCache } from "./runner/cache"
import { SessionCacheRuntime } from "./runner/cache-runtime"
import { SessionSchema } from "./schema"
import { toSessionError } from "./to-session-error"
import { Token } from "../util/token"
import { ModelV2 } from "../model"
import { SessionUsage } from "./usage"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly headers?: SessionModelHeaders.Options
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly agents: AgentV2.Interface
  readonly helpers: SessionHelperPolicy.Interface
  readonly requests: SessionProviderRequest.Interface
  readonly cacheRuntime: SessionCacheRuntime.Interface
  readonly config: Settings
  readonly configService: Config.Interface
}

export type AutoInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly model: Model
  readonly cost: ModelV2.Info["cost"]
  readonly system: readonly SystemPart[]
}

export type ManualInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly inputID: SessionMessage.ID
  readonly system?: readonly SystemPart[]
}

type Plan = {
  readonly session: SessionSchema.Info
  readonly model: Model
  readonly modelRef: ModelV2.Ref
  readonly cost: ModelV2.Info["cost"]
  readonly reason: SessionMessage.Compaction["reason"]
  readonly prompt: string
  readonly recent: string
  readonly messages: number
  readonly inputID?: SessionMessage.ID
  readonly system: readonly SystemPart[]
}

export type Outcome =
  | Pick<SessionMessage.CompactionCompleted, "status">
  | Pick<SessionMessage.CompactionFailed, "status" | "error">

export interface Interface {
  readonly required: (input: AutoInput, request?: LLMRequest) => boolean
  readonly compact: (input: AutoInput) => Effect.Effect<Outcome>
  readonly compactManual: (input: ManualInput) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionCompaction") {}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Info) => {
  if (message.type === "user") {
    const files =
      message.files?.map(
        (file) =>
          `[Attached ${file.mime}: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}]`,
      ) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "skill") return `[Skill activated: ${message.name}]\n${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output?.output ?? "")}`
  return ""
}

export const available = (messages: readonly SessionMessage.Info[]) =>
  messages.some(
    (message) => message.type !== "compaction" && message.type !== "system" && serialize(message).length > 0,
  )

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  messages: readonly SessionMessage.Info[],
  tokens: number,
): { readonly head: string; readonly recent: string; readonly headMessages: number; readonly recentMessages: number } | undefined => {
  const conversation = messages
    .filter((message) => message.type !== "compaction" && message.type !== "system")
    .flatMap((message) => {
      const text = serialize(message)
      return text ? [{ message, text }] : []
    })
  if (conversation.length === 0) return undefined
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (split < conversation.length && next > tokens) break
    total = next
    split = index
  }
  while (split > 0 && conversation[split].message.type !== "user") split--
  if (split === 0) {
    const latestUser = conversation.findLastIndex((item) => item.message.type === "user")
    if (latestUser > 0) split = latestUser
  }
  return {
    head: conversation
      .slice(0, split)
      .map((item) => item.text)
      .join("\n\n"),
    recent: conversation
      .slice(split)
      .map((item) => item.text)
      .join("\n\n"),
    headMessages: split,
    recentMessages: conversation.length - split,
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    "The following is the conversation history:",
    ...input.context,
  ].join("\n\n")

const planContent = (messages: readonly SessionMessage.Info[], tokens: number) => {
  const selected = select(messages, tokens)
  if (!selected) return undefined
  const previousSummary = messages.findLast((message) => message.type === "compaction" && message.status === "completed")
  const previousRecent = previousSummary?.type === "compaction" ? previousSummary.recent : ""
  const summarizeRecent = !previousRecent && !selected.head
  return {
    prompt: buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: summarizeRecent ? [selected.recent] : [previousRecent, selected.head].filter(Boolean),
    }),
    recent: summarizeRecent ? "" : selected.recent,
    messages: summarizeRecent ? selected.recentMessages : selected.headMessages,
  }
}

const make = (dependencies: Dependencies) => {
  const config = dependencies.config
  const failed = Effect.fnUntraced(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly reason: SessionMessage.Compaction["reason"]
    readonly error: SessionError.Error
    readonly inputID?: SessionMessage.ID
  }) {
    yield* dependencies.events.publish(SessionEvent.Compaction.Failed, input)
    return { status: "failed" as const, error: input.error }
  })
  const execute = Effect.fn("SessionCompaction.execute")(function* (plan: Plan) {
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: plan.session.id,
      reason: plan.reason,
      recent: plan.recent,
      inputID: plan.inputID,
    })

    const modelRef = plan.modelRef
    const baseRequest = LLM.request({
      model: plan.model,
      http: { headers: SessionModelHeaders.make(plan.session, dependencies.headers) },
      system: plan.system,
      messages: [Message.user(plan.prompt)],
      tools: [],
    })
    const namespaceInput = {
      projectID: plan.session.projectID,
      directory: plan.session.location.directory,
      workspaceID: plan.session.location.workspaceID,
      providerID: modelRef.providerID,
      modelID: modelRef.id,
      variant: modelRef.variant ?? "default",
      policyRevision: CACHE_POLICY_REVISION,
      permissions: [],
      system: baseRequest.system,
      tools: baseRequest.tools,
    }
    const efficiency = SessionRunnerCache.efficiencySettings(
      Config.latest(yield* dependencies.configService.entries(), "efficiency"),
    )
    const ttl = yield* dependencies.cacheRuntime.policy({
      namespace: SessionRunnerCache.promptCacheNamespace(namespaceInput),
      modelID: modelRef.id,
      configured: efficiency.anthropicTtl,
    })
    const cache = SessionRunnerCache.providerOptions({
      ...namespaceInput,
      sessionID: plan.session.id,
      routeID: plan.model.route.id,
      anthropicTtlSeconds: ttl.ttlSeconds,
      openaiMode: efficiency.openaiMode,
      openaiExtendedRetention: efficiency.openaiExtendedRetention,
    })
    const tracker = yield* dependencies.requests.next({
      sessionID: plan.session.id,
      inputID: plan.inputID,
      source: "compaction",
      agent: AgentV2.ID.make("compaction"),
      model: modelRef,
      routeID: plan.model.route.id,
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
    let failure: SessionError.Error | undefined
    let usage: SessionUsage.Recorded | undefined
    const recordUsage = Effect.suspend(() =>
      usage
        ? dependencies.events.publish(SessionEvent.UsageRecorded, {
            sessionID: plan.session.id,
            source: "compaction",
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
            ...(usage === undefined || SessionUsage.estimatedCost(plan.cost, recorded.tokens) === undefined
              ? {}
              : { cost: SessionUsage.estimatedCost(plan.cost, recorded.tokens)! }),
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
    yield* dependencies.llm.stream(request).pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event))
          failure = {
            type: event.classification === "context-overflow" ? "provider.invalid-request" : "provider.error",
            message: event.message,
          }
        if (LLMEvent.is.textDelta(event)) {
          chunks.push(event.text)
          return dependencies.events.publish(SessionEvent.Compaction.Delta, {
            sessionID: plan.session.id,
            text: event.text,
          })
        }
        if (LLMEvent.is.stepFinish(event)) {
          const step = SessionUsage.record(event.usage, plan.cost)
          usage = usage ? SessionUsage.add(usage, step) : step
        }
        return Effect.void
      }),
      Effect.catchTag("LLM.Error", (error) =>
        Effect.sync(() => {
          failure = toSessionError(error)
        }),
      ),
      Effect.onInterrupt(() =>
        recordUsage.pipe(
          Effect.andThen(completeRequest),
          Effect.andThen(
            plan.reason === "auto"
              ? failed({
                  sessionID: plan.session.id,
                  reason: plan.reason,
                  error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
                  inputID: plan.inputID,
                }).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
    )
    yield* recordUsage
    yield* completeRequest
    const summary = chunks.join("")
    if (failure || !summary.trim()) {
      const error = failure ?? { type: "compaction.failed" as const, message: "Compaction produced no summary" }
      return yield* failed({
        sessionID: plan.session.id,
        reason: plan.reason,
        error,
        inputID: plan.inputID,
      })
    }
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: plan.session.id,
      reason: plan.reason,
      text: summary,
      recent: plan.recent,
      messages: plan.messages,
      ...(usage ? { tokens: usage.tokens } : {}),
    })
    return { status: "completed" as const }
  })
  const compact = Effect.fn("SessionCompaction.compact")(function* (input: AutoInput) {
    const content = planContent(input.messages, config.tokens)
    if (content) {
      const agent = yield* dependencies.agents.get(AgentV2.ID.make("compaction"))
      const resolved = yield* dependencies.helpers.resolveModel(input.session, agent)
      if (!resolved)
        return yield* failed({
          sessionID: input.session.id,
          reason: "auto",
          error: { type: "compaction.failed", message: "No model is available for compaction" },
        })
      return yield* execute({
        session: input.session,
        model: resolved.model,
        modelRef: resolved.ref,
        cost: resolved.cost,
        reason: "auto",
        system: assembleCompactionConstraints(input.system.map((part) => part.text)).map(SystemPart.make),
        ...content,
      })
    }
    const error = { type: "compaction.unavailable" as const, message: "Nothing to compact yet" }
    return yield* failed({
      sessionID: input.session.id,
      reason: "auto",
      error,
    })
  })
  const required = (input: AutoInput, request?: LLMRequest) => {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = Math.min(input.model.route.defaults.limits?.output ?? 0, OUTPUT_TOKEN_MAX)
    const threshold = context - (output || config.buffer)
    const last = input.messages.findLast(
      (message): message is SessionMessage.Assistant & { tokens: NonNullable<SessionMessage.Assistant["tokens"]> } =>
        message.type === "assistant" && message.tokens !== undefined,
    )
    if (!last) return false
    const used =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (used <= 0) return false
    return used >= threshold || (request !== undefined && estimateRequestTokens(request) >= threshold)
  }
  const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: ManualInput) {
    const content = planContent(input.messages, config.tokens)
    if (!content)
      return yield* failed({
        sessionID: input.session.id,
        reason: "manual",
        error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
        inputID: input.inputID,
      })
    const agent = yield* dependencies.agents.get(AgentV2.ID.make("compaction"))
    const resolved = yield* dependencies.helpers.resolveModel(input.session, agent)
    if (!resolved)
      return yield* failed({
        sessionID: input.session.id,
        reason: "manual",
        error: { type: "compaction.failed", message: "No model is available for compaction" },
        inputID: input.inputID,
      })
    return yield* execute({
      session: input.session,
      model: resolved.model,
      modelRef: resolved.ref,
      cost: resolved.cost,
      reason: "manual",
      inputID: input.inputID,
      system: assembleCompactionConstraints((input.system ?? []).map((part) => part.text)).map(SystemPart.make),
      ...content,
    })
  })
  return Service.of({
    required,
    compact,
    compactManual,
  })
}

function estimateRequestTokens(request: LLMRequest) {
  return Token.estimate(
    JSON.stringify({
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat,
    }),
  )
}

export const layer = (options?: SessionModelHeaders.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const llm = yield* LLMClient.Service
      const config = yield* Config.Service
      const agents = yield* AgentV2.Service
      const helpers = yield* SessionHelperPolicy.Service
      const requests = yield* SessionProviderRequest.Service
      const cacheRuntime = yield* SessionCacheRuntime.Service
      return make({
        events,
        llm,
        agents,
        helpers,
        requests,
        cacheRuntime,
        config: settings(yield* config.entries()),
        configService: config,
        headers: options,
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
      Config.node,
      AgentV2.node,
      SessionHelperPolicy.node,
      SessionProviderRequest.node,
      SessionCacheRuntime.node,
    ],
  })
}

export const node = configured()
