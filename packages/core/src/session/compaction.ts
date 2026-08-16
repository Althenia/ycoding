export * as SessionCompaction from "./compaction"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message, type Model } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Money } from "@ycoding-ai/schema/money"
import type { FailureCode } from "@ycoding-ai/schema/session-compaction"
import { and, asc, eq, lte } from "drizzle-orm"
import { Cause, Context, Data, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigCompaction } from "../config/compaction"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { Token } from "../util/token"
import { SessionCompactionJob } from "./compaction-job"
import { SessionContextBudget } from "./context-budget"
import { ContextManifest } from "./context-manifest"
import { SessionHelperPolicy } from "./helper-policy"
import { SessionHistory } from "./history"
import { SessionLiveState } from "./live-state"
import { SessionModelHeaders } from "./model-headers"
import { SessionProviderRequest } from "./provider-request"
import { SessionRunnerCache } from "./runner/cache"
import { SessionCacheRuntime } from "./runner/cache-runtime"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"
import { SessionStore } from "./store"
import { SessionSummaryToon } from "./summary-toon"
import { SessionUsage } from "./usage"

const OUTPUT_TOKEN_MAX = 32_000
const SUMMARY_TEMPLATE = `Output exactly one TOON document, and nothing else, rooted at conversation_memory.

The document must contain version: 1; through_sequence as the exact supplied sequence; objective, current_state, and continuation strings; facts as { text, confidence } rows where confidence is confirmed, likely, or uncertain; decisions as { text, status } rows where status is accepted, rejected, or superseded; and preferences, constraints, completed, pending, blockers, unresolved, and important_identifiers as string arrays.

Keep the memory terse and factual. Preserve still-true goals, constraints, decisions, exact facts, identifiers, paths, commands, and errors. Merge the previous memory when supplied and remove only details superseded by newer material. Emit no Markdown fences, prose, or commentary.`

export interface Interface {
  readonly manifest: (job: SessionCompactionJob.Job) => Effect.Effect<ContextManifest.Manifest, ManifestError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionCompaction") {}

export class ManifestError extends Data.TaggedError("SessionCompaction.ManifestError")<{
  readonly code: FailureCode
}> {}

type Dependencies = {
  readonly db: Database.Interface["db"]
  readonly headers?: SessionModelHeaders.Options
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly agents: AgentV2.Interface
  readonly helpers: SessionHelperPolicy.Interface
  readonly requests: SessionProviderRequest.Interface
  readonly cacheRuntime: SessionCacheRuntime.Interface
  readonly config: ConfigCompaction.Resolved
  readonly configService: Config.Interface
  readonly store: SessionStore.Interface
  readonly liveState: SessionLiveState.Interface
}

const make = (dependencies: Dependencies): Interface => {
  const attempt = Effect.fn("SessionCompaction.attempt")(function* (input: {
    readonly session: SessionSchema.Info
    readonly resolved: SessionRunnerModel.Resolved
    readonly messages: readonly Message[]
  }) {
    const modelRef = input.resolved.ref
    const baseRequest = LLM.request({
      model: input.resolved.model,
      http: { headers: SessionModelHeaders.make(input.session, dependencies.headers) },
      system: [],
      messages: [...input.messages],
      tools: [],
    })
    const namespaceInput = {
      scope: "compaction" as const,
      projectID: input.session.projectID,
      directory: input.session.location.directory,
      workspaceID: input.session.location.workspaceID,
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
      modelID: input.resolved.model.id,
      configured: efficiency.anthropicTtl,
    })
    const cache = SessionRunnerCache.providerOptions({
      ...namespaceInput,
      apiModelID: input.resolved.model.id,
      sessionID: input.session.id,
      routeID: input.resolved.model.route.id,
      anthropicTtlSeconds: ttl.ttlSeconds,
      openaiMode: efficiency.openaiMode,
      openaiExtendedRetention: efficiency.openaiExtendedRetention,
    })
    const tracker = yield* dependencies.requests.next({
      sessionID: input.session.id,
      source: "compaction",
      agent: AgentV2.ID.make("compaction"),
      model: modelRef,
      routeID: input.resolved.model.route.id,
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
    let usage: SessionUsage.Recorded | undefined
    let failure: FailureCode | undefined
    const completeRequest = Effect.suspend(() => {
      const recorded = usage ?? {
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const cost = SessionUsage.estimatedCost(input.resolved.cost, recorded.tokens)
      return Effect.all(
        [
          tracker.complete({
            tokens: recorded.tokens,
            ...(cost === undefined ? {} : { cost }),
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
    const streamed = startStreamed(dependencies, request, {
      cost: input.resolved.cost,
      chunks,
      updateUsage: (recorded) => {
        usage = usage ? SessionUsage.add(usage, recorded) : recorded
      },
      setFailure: (code) => {
        failure = code
      },
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          completeRequest.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to record compaction helper request", { cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
    )
    const completed =
      dependencies.config.timeoutSeconds > 0
        ? yield* streamed.pipe(Effect.timeoutOption(Duration.seconds(dependencies.config.timeoutSeconds)))
        : yield* streamed.pipe(Effect.as(Option.some<void>(undefined)))
    if (Option.isNone(completed)) return yield* new ManifestError({ code: "provider_failed" })
    if (failure) return yield* new ManifestError({ code: failure })
    const text = chunks.join("")
    if (!text.trim()) return yield* new ManifestError({ code: "invalid_manifest" })
    return text
  })

  const manifest = Effect.fn("SessionCompaction.manifest")(function* (job: SessionCompactionJob.Job) {
    const session = yield* dependencies.store.get(job.sessionID)
    if (!session) return yield* new ManifestError({ code: "migration_failed" })
    const agent = yield* dependencies.agents.get(AgentV2.ID.make("compaction"))
    const resolved = yield* dependencies.helpers.resolveModel(session, "compaction", agent)
    const maxInputTokens = resolved
      ? selectedInputBudget(job, resolved.model, dependencies.config)
      : (job.targetMaxInputTokens ?? 0)
    if (maxInputTokens <= 0) return yield* new ManifestError({ code: "context_limit_unresolved" })

    const rows = yield* dependencies.db
      .select({
        id: SessionMessageTable.id,
        seq: SessionMessageTable.seq,
        type: SessionMessageTable.type,
        data: SessionMessageTable.data,
      })
      .from(SessionMessageTable)
      .where(
        and(eq(SessionMessageTable.session_id, job.sessionID), lte(SessionMessageTable.seq, job.requestedThrough.seq)),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    if (!rows.some((row) => row.id === job.requestedThrough.messageID && row.seq === job.requestedThrough.seq))
      return yield* new ManifestError({ code: "context_limit_unresolved" })

    const items = rows.flatMap((row, position): ReadonlyArray<ContextManifest.ContextItem> => {
      if (!Schema.is(Schema.Json)(row.data)) return []
      return [
        {
          kind: "message",
          messageID: row.id,
          position,
          terminalSeq: EventV2.Seq.make(row.seq),
          inputKind: row.type,
          payload: row.data,
          tokens: Token.estimate(JSON.stringify(row.data)),
        },
      ]
    })
    const liveState = yield* dependencies.liveState
      .load(job.sessionID)
      .pipe(Effect.mapError(() => new ManifestError({ code: "migration_failed" })))
    const recentTailCount =
      job.trigger === "mandatory" ? 0 : Math.min(dependencies.config.keepRecentMessages, items.length)
    const source = (recentTailCount === 0 ? items : items.slice(0, -recentTailCount)).map((item) => ({
      item,
      prompt: JSON.stringify({
        sequence: item.terminalSeq,
        kind: item.inputKind,
        payload: item.payload,
      }),
      extract: sourceText(item.payload),
    }))
    if (source.length === 0) return yield* new ManifestError({ code: "context_limit_unresolved" })
    const evidence: ContextManifest.RuntimeEvidence = {
      baseContextRevision: job.baseContextRevision,
      coveredThrough: {
        messageID: job.requestedThrough.messageID,
        seq: EventV2.Seq.make(job.requestedThrough.seq),
      },
      items,
      settlements: [],
      authorities: [],
      resourceAuthorities: [],
      toolResults: [],
      recentTail: recentTailCount === 0 ? [] : items.slice(-recentTailCount).map(ContextManifest.selector),
      protectedTargets: [],
      providerLinks: [],
      protectedState: SessionLiveState.toProtectedState(liveState.sources),
    }
    const selectedBefore = yield* SessionHistory.entriesForModelThrough(
      dependencies.db,
      job.sessionID,
      job.requestedThrough.seq,
    ).pipe(Effect.mapError(() => new ManifestError({ code: "migration_failed" })))
    const inputTokens = SessionHistory.modelTokens(selectedBefore)
    const retainedTokens = (summary: string, through: number) =>
      SessionHistory.modelTokens([
        SessionHistory.checkpointEntry({
          text: summary,
          coveredThrough: { seq: through },
          manifestDigest: "0".repeat(64),
          timeActivated: 1_000_000_000_000,
        }),
        ...selectedBefore.filter((entry) => entry.seq > through),
      ])
    const reducesModelInput = (summary: string, through: number) => retainedTokens(summary, through) < inputTokens
    const summary = yield* generateCheckpoint({
      attempt,
      session,
      resolved,
      source,
      maxCalls: dependencies.config.maxInternalPasses,
      maxBytes: dependencies.config.maxManifestBytes,
      maxInputTokens,
      reducesModelInput,
    })
    const summaryThrough = source.at(-1)!.item.terminalSeq

    const currentLiveState = yield* dependencies.liveState
      .load(job.sessionID)
      .pipe(Effect.mapError(() => new ManifestError({ code: "migration_failed" })))
    const validated = ContextManifest.validate({
      candidate: {
        schemaVersion: 1,
        baseContextRevision: evidence.baseContextRevision,
        coveredThrough: evidence.coveredThrough,
        protectedState: evidence.protectedState,
        exclusions: [],
      },
      summary: {
        text: summary,
        coveredThrough: {
          messageID: source.at(-1)!.item.messageID,
          seq: summaryThrough,
        },
        digest: ContextManifest.selector(source.at(-1)!.item).digest,
      },
      evidence: {
        ...evidence,
        protectedState: SessionLiveState.toProtectedState(currentLiveState.sources),
      },
      modelTokens: {
        before: inputTokens,
        after: retainedTokens(summary, summaryThrough),
      },
    })
    if (validated.valid) return validated.manifest
    if (validated.issues.some((issue) => issue.code === "protected_state_changed"))
      return yield* new ManifestError({ code: "protected_state_changed" })
    if (validated.issues.every((issue) => issue.code === "no_token_reduction"))
      return yield* new ManifestError({ code: "context_limit_unresolved" })
    return yield* new ManifestError({ code: "invalid_manifest" })
  })

  return Service.of({ manifest })
}

type SummarySource = {
  readonly item: ContextManifest.ContextItem
  readonly prompt: string
  readonly extract: string
}

const generateCheckpoint = Effect.fn("SessionCompaction.generateCheckpoint")(function* (input: {
  readonly attempt: (input: {
    readonly session: SessionSchema.Info
    readonly resolved: SessionRunnerModel.Resolved
    readonly messages: readonly Message[]
  }) => Effect.Effect<string, ManifestError>
  readonly session: SessionSchema.Info
  readonly resolved?: SessionRunnerModel.Resolved
  readonly source: ReadonlyArray<SummarySource>
  readonly maxCalls: number
  readonly maxBytes: number
  readonly maxInputTokens: number
  readonly reducesModelInput: (summary: string, through: number) => boolean
}) {
  let cursor = 0
  let summary: string | undefined
  let calls = 0
  while (cursor < input.source.length) {
    const prefix = fitSummaryPrefix(input.source, cursor, summary, input.maxInputTokens)
    if (prefix.count === 0) {
      const remaining = input.source.slice(cursor)
      return fallbackCheckpoint(
        remaining.map((entry) => entry.extract),
        remaining.at(-1)!.item.terminalSeq,
        input.maxBytes,
        input.reducesModelInput,
      )
    }
    const batch = input.source.slice(cursor, cursor + prefix.count)
    const fallback = fallbackCheckpoint(
      batch.map((entry) => entry.extract),
      prefix.through,
      input.maxBytes,
      input.reducesModelInput,
    )
    if (!input.resolved || calls >= input.maxCalls) {
      summary = fallback
      cursor += prefix.count
      continue
    }
    calls += 1
    const generated = yield* input
      .attempt({
        session: input.session,
        resolved: input.resolved,
        messages: [Message.user(summaryPrompt(summary, prefix.text, prefix.through))],
      })
      .pipe(Effect.option)
    if (Option.isNone(generated)) {
      summary = fallback
      cursor += prefix.count
      continue
    }
    const parsed = SessionSummaryToon.parse(generated.value, {
      throughSequence: prefix.through,
      maxSummaryBytes: input.maxBytes,
    })
    const encoded = "_tag" in parsed ? fallback : SessionSummaryToon.encode(parsed)
    summary = input.reducesModelInput(encoded, prefix.through) ? encoded : fallback
    cursor += prefix.count
  }
  return (
    summary ??
    fallbackCheckpoint(
      [],
      input.source.at(-1)!.item.terminalSeq,
      input.maxBytes,
      input.reducesModelInput,
    )
  )
})

function fitSummaryPrefix(
  source: ReadonlyArray<SummarySource>,
  cursor: number,
  previous: string | undefined,
  maxInputTokens: number,
) {
  const remaining = source.slice(cursor)
  let lower = 0
  let upper = remaining.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    const items = remaining.slice(0, middle)
    const text = items.map((entry) => entry.prompt).join("\n\n")
    const through = items.at(-1)?.item.terminalSeq ?? 0
    if (Token.estimate(summaryPrompt(previous, text, through)) <= maxInputTokens) lower = middle
    else upper = middle - 1
  }
  const items = remaining.slice(0, lower)
  return {
    count: lower,
    text: items.map((entry) => entry.prompt).join("\n\n"),
    through: items.at(-1)?.item.terminalSeq ?? 0,
  }
}

function summaryPrompt(previous: string | undefined, material: string, through: number) {
  return [
    previous
      ? `Update the conversation memory below with the new material.\n<previous-conversation-memory>\n${previous}\n</previous-conversation-memory>`
      : "Create a conversation memory from the conversation history.",
    `The new material covers message sequences up to and including ${through}.`,
    SUMMARY_TEMPLATE,
    "The following is the conversation material:",
    material,
  ].join("\n\n")
}

function fallbackCheckpoint(
  source: ReadonlyArray<string>,
  through: number,
  maxBytes: number,
  reducesModelInput: (summary: string, through: number) => boolean,
) {
  const memory: SessionSummaryToon.Memory = {
    version: 1,
    through_sequence: through,
    objective: "Continue the current session from the retained state.",
    current_state: "",
    facts: [],
    decisions: [],
    preferences: [],
    constraints: [],
    completed: [],
    pending: [],
    blockers: [],
    unresolved: [],
    important_identifiers: [],
    continuation: "Use the checkpoint and later messages; ask the user if omitted detail is required.",
  }
  const minimal = SessionSummaryToon.encode(memory)
  if (Buffer.byteLength(minimal, "utf8") > maxBytes || !reducesModelInput(minimal, through)) return minimal
  const newest = source.findLast((value) => value.trim()) ?? ""
  const characters = Array.from(newest)
  let lower = 0
  let upper = characters.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    const encoded = SessionSummaryToon.encode({
      ...memory,
      current_state: characters.slice(-middle).join(""),
    })
    if (Buffer.byteLength(encoded, "utf8") <= maxBytes && reducesModelInput(encoded, through)) lower = middle
    else upper = middle - 1
  }
  return SessionSummaryToon.encode({
    ...memory,
    current_state: lower === 0 ? "" : characters.slice(-lower).join(""),
  })
}

function sourceText(payload: Schema.Json) {
  if (jsonObject(payload) && typeof payload.text === "string") return payload.text
  return ContextManifest.canonicalJSON(payload)
}

function jsonObject(value: Schema.Json): value is { readonly [key: string]: Schema.Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function selectedInputBudget(job: SessionCompactionJob.Job, model: Model, config: ConfigCompaction.Resolved) {
  const contextWindowTokens = model.route.defaults.limits?.context ?? 0
  const routeOutputTokens = Math.min(model.route.defaults.limits?.output ?? 0, OUTPUT_TOKEN_MAX)
  const configuredOutputTokens =
    config.maxOutputTokens > 0 && routeOutputTokens > 0
      ? Math.min(config.maxOutputTokens, routeOutputTokens)
      : config.maxOutputTokens > 0
        ? config.maxOutputTokens
        : routeOutputTokens
  const modelBudget = SessionContextBudget.safeInputBudget({
    contextWindowTokens,
    maxOutputTokens: Math.max(configuredOutputTokens, config.reservedOutputTokens),
    contextSafetyMarginTokens: config.contextSafetyMarginTokens,
  })
  return Math.min(job.targetMaxInputTokens ?? 0, modelBudget)
}

function startStreamed(
  dependencies: Dependencies,
  request: LLMRequest,
  hooks: {
    readonly cost: ModelV2.Info["cost"]
    readonly chunks: string[]
    readonly updateUsage: (step: SessionUsage.Recorded) => void
    readonly setFailure: (code: FailureCode) => void
  },
) {
  return dependencies.llm.stream(request).pipe(
    Stream.runForEach((event) => {
      if (LLMEvent.is.providerError(event))
        hooks.setFailure(event.classification === "context-overflow" ? "context_limit_unresolved" : "provider_failed")
      if (LLMEvent.is.textDelta(event)) hooks.chunks.push(event.text)
      if (LLMEvent.is.stepFinish(event)) hooks.updateUsage(SessionUsage.record(event.usage, hooks.cost))
      return Effect.void
    }),
    Effect.catchTag("LLM.Error", () =>
      Effect.sync(() => {
        hooks.setFailure("provider_failed")
      }),
    ),
  )
}

export const layer = (options?: SessionModelHeaders.Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const llm = yield* LLMClient.Service
      const config = yield* Config.Service
      const agents = yield* AgentV2.Service
      const helpers = yield* SessionHelperPolicy.Service
      const requests = yield* SessionProviderRequest.Service
      const cacheRuntime = yield* SessionCacheRuntime.Service
      const store = yield* SessionStore.Service
      const liveState = yield* SessionLiveState.Service
      const { db } = yield* Database.Service
      return make({
        db,
        llm,
        agents,
        helpers,
        requests,
        cacheRuntime,
        config: ConfigCompaction.resolve(
          (yield* config.entries())
            .filter((entry): entry is Config.Document => entry.type === "document")
            .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : [])),
        ),
        configService: config,
        store,
        liveState,
        headers: options,
      })
    }),
  )

export function configured(options?: SessionModelHeaders.Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      llmClient,
      Config.node,
      AgentV2.node,
      SessionHelperPolicy.node,
      SessionProviderRequest.node,
      SessionCacheRuntime.node,
      SessionStore.node,
      SessionLiveState.node,
      Database.node,
    ],
  })
}

export const node = configured()
