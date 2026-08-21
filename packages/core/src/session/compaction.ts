export * as SessionCompaction from "./compaction"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message, type Model } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { Money } from "@ycoding-ai/schema/money"
import type { FailureCode } from "@ycoding-ai/schema/session-compaction"
import { and, asc, eq, lte } from "drizzle-orm"
import { Cause, Clock, Context, Data, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { ConfigCompaction } from "../config/compaction"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { Hash } from "../util/hash"
import { Token } from "../util/token"
import { SessionCompactionJob } from "./compaction-job"
import { SessionContextBudget } from "./context-budget"
import { ContextManifest } from "./context-manifest"
import { SessionEvent } from "./event"
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
import { SessionMessage } from "./message"
import { SessionSkillStatus } from "./skill-status"
import { SessionSummaryToon } from "./summary-toon"
import { SessionUsage } from "./usage"

const OUTPUT_TOKEN_MAX = 32_000
const SOURCE_TEXT_MAX_CHARS = 8_192
const SOURCE_CAPSULE_MAX_CHARS = 384
const SKILL_TEXT_MAX_CHARS = 2_048
const SUMMARY_SCALAR_MAX_CHARS = 2_048
const SUMMARY_TEMPLATE = `Output exactly one TOON document, and nothing else, rooted at conversation_memory.

Use this exact field schema and order:

conversation_memory:
  version: 2
  through_sequence: 0
  objective: ""
  in_progress: []
  pending: []
  blocked: []
  decision: []
  skill: []
  requirements: []
  acceptance_criteria: []
  current_state: ""
  facts: []
  preferences: []
  constraints: []
  completed: []
  unresolved: []
  important_identifiers: []
  continuation: ""

Replace through_sequence with the exact supplied sequence. decision rows have { text, status }, where status is accepted, rejected, or superseded. facts rows have { text, confidence }, where confidence is confirmed, likely, or uncertain. Every other collection is a string array; use [] when there is no value. in_progress contains work actively underway, pending contains not-started next work, blocked contains work that cannot proceed and why, and skill contains active skill names plus any practices that must continue.

Keep the memory terse and factual. Preserve still-true goals, constraints, decisions, exact facts, identifiers, paths, commands, errors, validation state, and remaining risks. Merge a supplied conversation_memory document with newer material and remove only details superseded by newer evidence. Emit no Markdown fences, prose, or commentary.`

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
  readonly events: EventV2.Interface
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
      system: SUMMARY_TEMPLATE,
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
      sessionID: input.session.id,
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
    yield* streamed
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
    const helperSession = resolved ? yield* ensureHelperSession(dependencies, session, job, resolved.ref) : undefined
    const targetMaxInputTokens = job.targetMaxInputTokens ?? 0
    const maxInputTokens = resolved
      ? selectedInputBudget(job, resolved.model, dependencies.config)
      : targetMaxInputTokens
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
          tokens: Token.estimateJson(row.data),
        },
      ]
    })
    const liveState = yield* dependencies.liveState
      .load(job.sessionID)
      .pipe(Effect.mapError(() => new ManifestError({ code: "migration_failed" })))
    const decodedMessages = rows.flatMap((row) => {
      if (!Schema.is(Schema.Json)(row.data) || !jsonObject(row.data)) return []
      const decoded = Schema.decodeUnknownOption(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type })
      return Option.isSome(decoded) ? [{ seq: row.seq, message: decoded.value }] : []
    })
    const decodedByID = new Map(decodedMessages.map((entry) => [entry.message.id, entry.message]))
    const selectedBefore = yield* SessionHistory.entriesForModelThrough(
      dependencies.db,
      job.sessionID,
      job.requestedThrough.seq,
    ).pipe(Effect.mapError(() => new ManifestError({ code: "migration_failed" })))
    const previousMemory = selectedBefore.flatMap((entry) => checkpointMemory(entry.seq, entry.message)).at(-1)
    const uncoveredItems = items.filter((item) => item.terminalSeq > (previousMemory?.through_sequence ?? 0))
    const recentTailCount =
      job.trigger === "mandatory" ? 0 : Math.min(dependencies.config.keepRecentMessages, uncoveredItems.length)
    const source = (recentTailCount === 0 ? uncoveredItems : uncoveredItems.slice(0, -recentTailCount)).map((item) => {
      const extract = sourceText(decodedByID.get(item.messageID), item.payload)
      return {
        item,
        prompt: JSON.stringify({ sequence: item.terminalSeq, kind: item.inputKind, content: extract }),
        extract,
        capsule: sourceCapsule(item, extract),
      }
    })
    if (source.length === 0) return yield* new ManifestError({ code: "context_limit_unresolved" })
    const summaryThrough = source.at(-1)!.item.terminalSeq
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
      recentTail: recentTailCount === 0 ? [] : uncoveredItems.slice(-recentTailCount).map(ContextManifest.selector),
      protectedTargets: [],
      providerLinks: [],
      protectedState: SessionLiveState.toProtectedState(liveState.sources),
    }
    const activeSkills = SessionSkillStatus.list(
      decodedMessages.filter((entry) => entry.seq <= summaryThrough).map((entry) => entry.message),
      [],
    ).filter((skill) => skill.state === "active")
    const requiredSkills = activeSkills.map((skill) =>
      boundedText(
        [
          `Active skill: ${skill.name} (${skill.id}).`,
          `Active because: activated by ${skill.activatedBy} at message ${skill.activationMessageID}.`,
          "Current practices and routing boundaries:",
          skill.content,
        ].join("\n"),
        SKILL_TEXT_MAX_CHARS,
      ),
    )
    const requiredTexts = messageText(liveState.rendered)
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
    const acceptsModelInput = (summary: string, through: number) => {
      const retained = retainedTokens(summary, through)
      return retained < inputTokens
    }
    const generation = {
      attempt,
      session: helperSession ?? session,
      resolved,
      source,
      maxCalls: dependencies.config.maxInternalPasses,
      maxBytes: dependencies.config.maxManifestBytes,
      maxInputTokens,
      acceptsModelInput,
      requiredTexts,
      requiredSkills,
      previousMemory,
    }
    const generated =
      dependencies.config.timeoutSeconds > 0
        ? yield* generateCheckpoint(generation).pipe(
            Effect.timeoutOption(Duration.seconds(dependencies.config.timeoutSeconds)),
          )
        : Option.some(yield* generateCheckpoint(generation))
    const summary = Option.isSome(generated)
      ? generated.value
      : yield* generateCheckpoint({ ...generation, resolved: undefined })

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
  readonly capsule: string
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
  readonly acceptsModelInput: (summary: string, through: number) => boolean
  readonly requiredTexts: ReadonlyArray<string>
  readonly requiredSkills: ReadonlyArray<string>
  readonly previousMemory?: SessionSummaryToon.Memory
}) {
  let cursor = 0
  let memory: SessionSummaryToon.Memory | undefined = input.previousMemory
    ? { ...input.previousMemory, skill: [] }
    : undefined
  let summary = memory ? SessionSummaryToon.encode(memory) : undefined
  let calls = 0
  while (cursor < input.source.length) {
    const prefix = fitSummaryPrefix(input.source, cursor, summary, input.maxInputTokens)
    if (prefix.count === 0) {
      const remaining = input.source.slice(cursor)
      const candidate = fallbackCheckpoint(
        remaining.map((entry) => entry.extract),
        remaining.at(-1)!.item.terminalSeq,
        input.maxBytes,
        input.acceptsModelInput,
        memory,
      )
      const finalized = finalizeCheckpoint(input, candidate)
      if (finalized) return finalized
      return yield* new ManifestError({ code: "context_limit_unresolved" })
    }
    const batch = input.source.slice(cursor, cursor + prefix.count)
    const fallback = fallbackCheckpoint(
      batch.map((entry) => entry.extract),
      prefix.through,
      input.maxBytes,
      input.acceptsModelInput,
      memory,
    )
    if (!input.resolved || calls >= input.maxCalls) {
      memory = parsedMemory(fallback, prefix.through, input.maxBytes) ?? memory
      summary = memory ? SessionSummaryToon.encode(memory) : fallback
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
      const finalized = localCheckpoint(input, memory)
      if (finalized) return finalized
      return yield* new ManifestError({ code: "context_limit_unresolved" })
    }
    const parsed = SessionSummaryToon.parse(generated.value, {
      throughSequence: prefix.through,
      maxSummaryBytes: input.maxBytes,
    })
    const next = "_tag" in parsed ? parsedMemory(fallback, prefix.through, input.maxBytes) : parsed
    memory = next ? mergeMemory(memory, next, prefix.through) : memory
    summary = memory ? SessionSummaryToon.encode(memory) : fallback
    cursor += prefix.count
  }
  const candidate =
    summary ??
    fallbackCheckpoint(
      [],
      input.source.at(-1)!.item.terminalSeq,
      input.maxBytes,
      input.acceptsModelInput,
      input.previousMemory,
    )
  const finalized = finalizeCheckpoint(input, candidate)
  if (finalized) return finalized
  return yield* new ManifestError({ code: "context_limit_unresolved" })
})

function localCheckpoint(
  input: {
    readonly source: ReadonlyArray<SummarySource>
    readonly maxBytes: number
    readonly acceptsModelInput: (summary: string, through: number) => boolean
    readonly requiredTexts: ReadonlyArray<string>
    readonly requiredSkills: ReadonlyArray<string>
    readonly previousMemory?: SessionSummaryToon.Memory
  },
  memory = input.previousMemory,
) {
  return finalizeCheckpoint(
    input,
    fallbackCheckpoint(
      input.source.map((entry) => entry.extract),
      input.source.at(-1)!.item.terminalSeq,
      input.maxBytes,
      input.acceptsModelInput,
      memory,
    ),
  )
}

function parsedMemory(text: string, through: number, maxBytes: number) {
  const parsed = SessionSummaryToon.parse(text, { throughSequence: through, maxSummaryBytes: maxBytes })
  return "_tag" in parsed ? undefined : parsed
}

function mergeMemory(
  previous: SessionSummaryToon.Memory | undefined,
  current: SessionSummaryToon.Memory,
  through: number,
): SessionSummaryToon.Memory {
  if (!previous) return { ...current, through_sequence: through, skill: [] }
  const strings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => [...new Set([...left, ...right])]
  const facts = [...previous.facts, ...current.facts].filter(
    (fact, index, all) => all.findIndex((candidate) => candidate.text === fact.text) === index,
  )
  const decisions = [...previous.decision, ...current.decision].filter(
    (decision, index, all) => all.findLastIndex((candidate) => candidate.text === decision.text) === index,
  )
  return {
    version: 2,
    through_sequence: through,
    objective: mergeMeaningfulScalar(previous.objective, current.objective),
    requirements: strings(previous.requirements, current.requirements),
    acceptance_criteria: strings(previous.acceptance_criteria, current.acceptance_criteria),
    in_progress: strings(previous.in_progress, current.in_progress),
    current_state: mergeScalar(previous.current_state, current.current_state),
    facts,
    decision: decisions,
    preferences: strings(previous.preferences, current.preferences),
    constraints: strings(previous.constraints, current.constraints),
    completed: strings(previous.completed, current.completed),
    pending: strings(previous.pending, current.pending),
    blocked: strings(previous.blocked, current.blocked),
    skill: [],
    unresolved: strings(previous.unresolved, current.unresolved),
    important_identifiers: strings(previous.important_identifiers, current.important_identifiers),
    continuation: usefulScalar(current.continuation) ? current.continuation : previous.continuation,
  }
}

function mergeScalar(previous: string, current: string) {
  if (!previous.trim()) return current
  if (!current.trim() || previous === current) return previous
  return `${previous}\n${current}`
}

function mergeMeaningfulScalar(previous: string, current: string) {
  if (!usefulScalar(previous)) return current
  if (!usefulScalar(current)) return previous
  return boundedText(mergeScalar(previous, current), SUMMARY_SCALAR_MAX_CHARS)
}

function usefulScalar(value: string) {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.length > 0 &&
    normalized !== "…" &&
    !/^continue (?:the )?(?:current )?session/.test(normalized) &&
    !/^use the checkpoint/.test(normalized)
  )
}

function finalizeCheckpoint(
  input: {
    readonly source: ReadonlyArray<SummarySource>
    readonly maxBytes: number
    readonly requiredTexts: ReadonlyArray<string>
    readonly requiredSkills: ReadonlyArray<string>
    readonly acceptsModelInput: (summary: string, through: number) => boolean
    readonly previousMemory?: SessionSummaryToon.Memory
  },
  candidate: string,
) {
  const through = input.source.at(-1)!.item.terminalSeq
  const parsed = SessionSummaryToon.parse(candidate, {
    throughSequence: through,
    maxSummaryBytes: input.maxBytes,
  })
  if (!("_tag" in parsed)) {
    const repaired = validateCheckpoint(input, parsed, through)
    if (repaired) return repaired
  }
  return validateCheckpoint(input, input.previousMemory, through)
}

function validateCheckpoint(
  input: {
    readonly source: ReadonlyArray<SummarySource>
    readonly maxBytes: number
    readonly acceptsModelInput: (summary: string, through: number) => boolean
    readonly requiredTexts: ReadonlyArray<string>
    readonly requiredSkills: ReadonlyArray<string>
  },
  memory: SessionSummaryToon.Memory | undefined,
  through: number,
): string | undefined {
  const continuity = retainLocalContinuity(
    input.source.map((entry) => entry.extract),
    through,
    input.maxBytes,
    input.acceptsModelInput,
    memory ? { ...memory, skill: [] } : undefined,
  )
  const required = SessionSummaryToon.retainRequiredTexts(continuity, input.requiredTexts)
  const coverage = input.source.map((entry) => ({ text: entry.capsule, confidence: "confirmed" as const }))
  const encoded = SessionSummaryToon.encode({
    ...required,
    facts: [...required.facts.filter((fact) => !coverage.some((item) => item.text === fact.text)), ...coverage],
    skill: [...new Set(input.requiredSkills)],
  })
  const parsed = SessionSummaryToon.parse(encoded, {
    throughSequence: through,
    maxSummaryBytes: input.maxBytes,
  })
  if ("_tag" in parsed) return undefined
  const canonical = SessionSummaryToon.encode(parsed)
  if (!input.acceptsModelInput(canonical, through)) return undefined
  return canonical
}

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
    if (summaryInputTokens(previous, text, through) <= maxInputTokens) lower = middle
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
    "The following is the conversation material:",
    material,
  ].join("\n\n")
}

function summaryInputTokens(previous: string | undefined, material: string, through: number) {
  return Token.estimate([SUMMARY_TEMPLATE, summaryPrompt(previous, material, through)].join("\n\n"))
}

function fallbackCheckpoint(
  source: ReadonlyArray<string>,
  through: number,
  maxBytes: number,
  reducesModelInput: (summary: string, through: number) => boolean,
  previousMemory?: SessionSummaryToon.Memory,
) {
  const memory = retainLocalContinuity(source, through, maxBytes, reducesModelInput, previousMemory)
  const minimal = SessionSummaryToon.encode(memory)
  if (Buffer.byteLength(minimal, "utf8") > maxBytes || !reducesModelInput(minimal, through)) return minimal
  const newest = source.findLast((value) => value.trim()) ?? ""
  const characters = Array.from(newest)
  const currentState = (tail: string) => [memory.current_state, tail].filter(Boolean).join("\n")
  let lower = 0
  let upper = characters.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    const encoded = SessionSummaryToon.encode({
      ...memory,
      current_state: currentState(characters.slice(-middle).join("")),
    })
    if (Buffer.byteLength(encoded, "utf8") <= maxBytes && reducesModelInput(encoded, through)) lower = middle
    else upper = middle - 1
  }
  return SessionSummaryToon.encode({
    ...memory,
    current_state: currentState(lower === 0 ? "" : characters.slice(-lower).join("")),
  })
}

function retainLocalContinuity(
  source: ReadonlyArray<string>,
  through: number,
  maxBytes: number,
  reducesModelInput: (summary: string, through: number) => boolean,
  previousMemory?: SessionSummaryToon.Memory,
) {
  const lines = source
    .flatMap((text) => text.split(/(?<=[.!?])\s+|\r?\n/))
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 && line.length <= 512 && all.indexOf(line) === index)
  const objective = lines.findLast((line) => /^objective\s*:/i.test(line)) ?? lines[0]
  const currentState = lines.findLast((line) => line !== "…")
  const requirements = lines
    .filter(
      (line) => /^requirements?\s*:/i.test(line) || /\b(?:must|shall|required?|never|do not|should)\b/i.test(line),
    )
    .slice(-8)
  const acceptanceCriteria = lines
    .filter(
      (line) =>
        /^accept(?:ance)?[ _-]?criteria\s*:/i.test(line) ||
        /\b(?:accepted only when|acceptance criteria|expected behavior|passes?|verified?)\b/i.test(line),
    )
    .slice(-8)
  const progress = lines
    .filter(
      (line) =>
        /^(?:progress|completed|validation|todo\s*\[in[_ -]?progress\])\s*:/i.test(line) ||
        /\b(?:in progress|implemented|investigated|confirmed|completed|passed|validated)\b/i.test(line),
    )
    .slice(-8)
  const pending = lines
    .filter(
      (line) =>
        /^(?:pending|todo(?:\s*\[pending\])?|next action)\s*:/i.test(line) ||
        /\b(?:next|pending|remaining|awaits?|still needs?)\b/i.test(line),
    )
    .slice(-8)
  const blockers = lines
    .filter((line) => /^blockers?\s*:/i.test(line) || /\b(?:blocked|blocker|broke|failed|error)\b/i.test(line))
    .slice(-8)
  const skills = lines.filter((line) => /^active skill\s*:/i.test(line)).slice(-4)
  const decisions = lines
    .flatMap((line) => {
      const match = line.match(/^(accepted|rejected|superseded) decision\s*:/i)
      const inferred = /\b(?:we |was )?(?:chose|decided|selected)\b/i.test(line) ? "accepted" : undefined
      if (!match && !inferred) return []
      const status = match?.[1]?.toLowerCase() ?? inferred
      if (status !== "accepted" && status !== "rejected" && status !== "superseded") return []
      return [{ text: line, status }] satisfies SessionSummaryToon.Memory["decision"]
    })
    .slice(-8)
  const constraints = lines
    .filter((line) => /\b(?:constraint|without|do not|never|must not|no external)\b/i.test(line))
    .slice(-8)
  const completed = lines.filter((line) => /\b(?:completed|passed|confirmed|validated)\b/i.test(line)).slice(-8)
  const unresolved = lines.filter((line) => /\b(?:unresolved|unknown|unclear|question)\b/i.test(line)).slice(-8)
  const identifiers = [
    ...new Set(
      source.flatMap((text) => [
        ...(text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []),
        ...(text.match(/(?:^|\s)(\/(?:[^\s"'`,]+\/?)+)/g) ?? []).map((value) => value.trim()),
      ]),
    ),
  ].slice(-16)
  const append = (values: ReadonlyArray<string>, value: string) =>
    values.includes(value) ? values : [...values, value]
  const candidates: ReadonlyArray<(memory: SessionSummaryToon.Memory) => SessionSummaryToon.Memory> = [
    ...(objective
      ? [
          (memory: SessionSummaryToon.Memory) => ({
            ...memory,
            objective: mergeMeaningfulScalar(memory.objective, objective),
          }),
        ]
      : []),
    ...(currentState
      ? [
          (memory: SessionSummaryToon.Memory) => ({
            ...memory,
            current_state: mergeScalar(memory.current_state, currentState),
          }),
        ]
      : []),
    ...requirements.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      requirements: append(memory.requirements, text),
    })),
    ...acceptanceCriteria.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      acceptance_criteria: append(memory.acceptance_criteria, text),
    })),
    ...pending.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      pending: append(memory.pending, text),
    })),
    ...decisions.map((decision) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      decision: memory.decision.some(
        (existing) => existing.text === decision.text && existing.status === decision.status,
      )
        ? memory.decision
        : [...memory.decision, decision],
    })),
    ...blockers.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      blocked: append(memory.blocked, text),
    })),
    ...skills.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      skill: append(memory.skill, text),
    })),
    ...progress.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      in_progress: append(memory.in_progress, text),
    })),
    ...constraints.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      constraints: append(memory.constraints, text),
    })),
    ...completed.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      completed: append(memory.completed, text),
    })),
    ...unresolved.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      unresolved: append(memory.unresolved, text),
    })),
    ...identifiers.map((text) => (memory: SessionSummaryToon.Memory) => ({
      ...memory,
      important_identifiers: append(memory.important_identifiers, text),
    })),
    ...((pending.findLast((text) => /\bnext\b/i.test(text)) ?? pending.at(-1))
      ? [
          (memory: SessionSummaryToon.Memory) => ({
            ...memory,
            continuation: pending.findLast((text) => /\bnext\b/i.test(text)) ?? pending.at(-1)!,
          }),
        ]
      : []),
  ]
  const previous = previousMemory ? { ...previousMemory, through_sequence: through } : undefined
  const previousEncoded = previous ? SessionSummaryToon.encode(previous) : undefined
  const initial = previous
    ? Buffer.byteLength(previousEncoded!, "utf8") <= maxBytes
      ? previous
      : emptyCheckpoint(through)
    : emptyCheckpoint(through)
  return candidates.reduce((memory, include) => {
    const candidate = include(memory)
    const encoded = SessionSummaryToon.encode(candidate)
    return Buffer.byteLength(encoded, "utf8") <= maxBytes && reducesModelInput(encoded, through) ? candidate : memory
  }, initial)
}

function checkpointMemory(seq: number, message: SessionMessage.Info): ReadonlyArray<SessionSummaryToon.Memory> {
  if (message.type !== "synthetic" || !message.id.startsWith("msg_compaction_")) return []
  const summary = message.text.match(/<summary>\n([\s\S]*)\n<\/summary>/)?.[1]
  if (!summary) return []
  const parsed = SessionSummaryToon.parse(summary, {
    throughSequence: seq,
    maxSummaryBytes: Buffer.byteLength(summary, "utf8"),
  })
  return "_tag" in parsed ? [] : [parsed]
}

function emptyCheckpoint(through: number): SessionSummaryToon.Memory {
  return {
    version: 2,
    through_sequence: through,
    objective: "Continue the current session from the retained state.",
    requirements: [],
    acceptance_criteria: [],
    in_progress: [],
    current_state: "",
    facts: [],
    decision: [],
    preferences: [],
    constraints: [],
    completed: [],
    pending: [],
    blocked: [],
    skill: [],
    unresolved: [],
    important_identifiers: [],
    continuation: "Use the checkpoint and later messages; ask the user if omitted detail is required.",
  }
}

function messageText(message: Message) {
  return message.content.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text] : []))
}

function sourceText(message: SessionMessage.Info | undefined, payload: Schema.Json) {
  if (!message) return boundedText(semanticValues(payload).join("\n"), SOURCE_TEXT_MAX_CHARS)
  if (message.type === "skill") return `Skill activation: ${message.name} (${message.skill}).`
  if (message.type === "user" || message.type === "synthetic" || message.type === "system")
    return boundedText(message.text, SOURCE_TEXT_MAX_CHARS)
  if (message.type === "assistant")
    return boundedText(
      message.content
        .flatMap((part) => {
          if (part.type === "text" || part.type === "reasoning") return [part.text]
          const state = part.state
          return [
            `Tool ${part.name}: ${state.status}.`,
            ...semanticValues(state.input),
            ...(state.status === "streaming"
              ? []
              : [
                  ...state.content.flatMap((content) =>
                    content.type === "text" ? [content.text] : [`Artifact ${content.name ?? content.uri}`],
                  ),
                  ...semanticValues(state.structured),
                  ...(state.status === "completed" || state.status === "error"
                    ? state.result === undefined
                      ? []
                      : semanticValues(state.result)
                    : []),
                  ...(state.status === "error" ? [state.error.message] : []),
                ]),
          ]
        })
        .join("\n"),
      SOURCE_TEXT_MAX_CHARS,
    )
  if (message.type === "shell")
    return boundedText(
      [
        `Command: ${message.command}`,
        `Status: ${message.status}`,
        ...(message.exit === undefined ? [] : [`Exit: ${message.exit}`]),
      ].join("\n"),
      SOURCE_TEXT_MAX_CHARS,
    )
  return boundedText(semanticValues(payload).join("\n"), SOURCE_TEXT_MAX_CHARS)
}

function semanticValues(value: unknown, key?: string, depth = 0): string[] {
  if (depth > 3 || value === undefined || value === null) return []
  if (typeof value === "string") {
    if (looksBinary(value) || ["state", "providerState", "providerResultState"].includes(key ?? "")) return []
    const text = boundedText(value, 2_048)
    return text.trim() ? [key ? `${key}: ${text}` : text] : []
  }
  if (typeof value === "number" || typeof value === "boolean") return key ? [`${key}: ${value}`] : []
  if (Array.isArray(value)) return value.flatMap((item) => semanticValues(item, key, depth + 1)).slice(0, 24)
  if (typeof value !== "object") return []
  return Object.entries(value)
    .filter(
      ([name]) => !["metadata", "tokens", "diagnostics", "time", "providerState", "providerResultState"].includes(name),
    )
    .flatMap(([name, item]) => semanticValues(item, name, depth + 1))
    .slice(0, 32)
}

function looksBinary(value: string) {
  if (/^data:[^;]+;base64,/i.test(value)) return true
  return value.length > 1_024 && /^[A-Za-z0-9+/=\s]+$/.test(value)
}

function boundedText(value: string, maxCharacters: number) {
  const sanitized = value
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=\s]+/gi, "[binary omitted]")
    .replace(/\0/g, "")
    .trim()
  const characters = Array.from(sanitized)
  if (characters.length <= maxCharacters) return sanitized
  if (maxCharacters <= 3) return characters.slice(0, maxCharacters).join("")
  const contentCharacters = maxCharacters - 3
  const head = Math.floor(contentCharacters * 0.75)
  const tail = contentCharacters - head
  return `${characters.slice(0, head).join("")}\n…\n${characters.slice(-tail).join("")}`
}

function sourceCapsule(item: ContextManifest.ContextItem, extract: string) {
  const normalized = extract.replace(/\s+/g, " ")
  const prefix = `[source sequence=${item.terminalSeq} kind=${item.inputKind}]`
  const contentBudget = SOURCE_CAPSULE_MAX_CHARS - Array.from(prefix).length - 1
  const digest = `sha256=${Hash.sha256(normalized)}`
  const content =
    Array.from(normalized).length > contentBudget
      ? `${boundedText(salientSourceText(normalized), contentBudget - Array.from(digest).length - 1)} ${digest}`
      : normalized || "No textual payload."
  return `${prefix} ${content}`
}

function salientSourceText(value: string) {
  const sentences = value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence, index, all) => sentence.length > 0 && all.indexOf(sentence) === index)
    .filter((sentence) => {
      const words = sentence.toLowerCase().match(/[a-z0-9_-]+/g) ?? []
      return words.length < 8 || new Set(words).size / words.length >= 0.25
    })
  return sentences.join(" ") || "Repetitive source payload omitted."
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

const ensureHelperSession = Effect.fnUntraced(function* (
  dependencies: Dependencies,
  owner: SessionSchema.Info,
  job: SessionCompactionJob.Job,
  model: ModelV2.Ref,
) {
  const id = SessionSchema.ID.make(`ses_compaction_${Hash.sha256(job.id).slice(0, 24)}`)
  const existing = yield* dependencies.store.get(id)
  if (existing) return existing
  const created = yield* Clock.currentTimeMillis
  yield* dependencies.events.publish(SessionEvent.Created, {
    sessionID: id,
    projectID: owner.projectID,
    location: owner.location,
    parentID: owner.id,
    agent: AgentV2.ID.make("compaction"),
    model,
    permissionCeiling: owner.permissionCeiling,
    title: `Compaction ${job.id}`,
    subpath: owner.subpath,
    created,
  })
  const helper = yield* dependencies.store.get(id)
  if (!helper) return yield* new ManifestError({ code: "migration_failed" })
  return helper
})

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
      const events = yield* EventV2.Service
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
        events,
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
      EventV2.node,
      Database.node,
    ],
  })
}

export const node = configured()
