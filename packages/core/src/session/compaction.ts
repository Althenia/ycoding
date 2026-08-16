export * as SessionCompaction from "./compaction"

import { LLM, LLMClient, LLMError, LLMEvent, LLMRequest, Message, SystemPart, type Model } from "@ycoding-ai/ai"
import { CACHE_POLICY_REVISION } from "@ycoding-ai/ai/cache-policy"
import { SessionError } from "@ycoding-ai/schema/session-error"
import { Cause, Context, DateTime, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { Money } from "@ycoding-ai/schema/money"
import { and, asc, count, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm"
import { AgentV2 } from "../agent"
import { Config } from "../config"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { assembleCompactionConstraints } from "./compaction-constraints"
import { SessionContextBudget } from "./context-budget"
import { SessionEvent } from "./event"
import { SessionHelperPolicy } from "./helper-policy"
import { SessionMessage } from "./message"
import { SessionModelHeaders } from "./model-headers"
import { SessionPending } from "./pending"
import { SessionProviderRequest } from "./provider-request"
import { SessionRunnerCache } from "./runner/cache"
import { SessionCacheRuntime } from "./runner/cache-runtime"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"
import { SessionStore } from "./store"
import { SessionSummaryToon } from "./summary-toon"
import { toSessionError } from "./to-session-error"
import { Token } from "../util/token"
import { ModelV2 } from "../model"
import { SessionUsage } from "./usage"

const DEFAULT_KEEP_RECENT_MESSAGES = 20
const DEFAULT_SAFETY_MARGIN_TOKENS = 4_096
const DEFAULT_MAX_SUMMARY_BYTES = 65_536
const DEFAULT_MAX_INTERNAL_PASSES = 8
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PROMPT_FRAMING_TOKENS = 512

/**
 * Durable event types that produce `session_message` projection rows. This is the
 * runtime mirror of the `MessageEvent` type in `session/projector.ts`, which is
 * `Exclude<CurrentDurableEvent, Created | Forked | Deleted | InstructionsUpdated |
 * Task.Updated | ProviderRequestRecorded>`. Deleting only these events keeps the
 * instruction epoch and permission-ceiling folds intact because the excluded
 * envelopes never reach the message projection.
 */
type MessageEventDefinition = {
  readonly type: string
  readonly durability?: string
  readonly durable?: { readonly version: number; readonly aggregate: string }
}
const MESSAGE_EVENT_DEFINITIONS = [
  SessionEvent.AgentSelected,
  SessionEvent.ModelSelected,
  SessionEvent.ProjectArtifactsEnded,
  SessionEvent.Moved,
  SessionEvent.Renamed,
  SessionEvent.UsageRecorded,
  SessionEvent.InputPromoted,
  SessionEvent.InputAdmitted,
  SessionEvent.InputConsumed,
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Synthetic,
  SessionEvent.Skill.Activated,
  SessionEvent.Skill.Deactivated,
  SessionEvent.Shell.Started,
  SessionEvent.Shell.Ended,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
  SessionEvent.Text.Started,
  SessionEvent.Text.Ended,
  SessionEvent.Reasoning.Started,
  SessionEvent.Reasoning.Ended,
  SessionEvent.Tool.Input.Started,
  SessionEvent.Tool.Input.Ended,
  SessionEvent.Tool.Called,
  SessionEvent.Tool.Progress,
  SessionEvent.Tool.Success,
  SessionEvent.Tool.Failed,
  SessionEvent.RetryScheduled,
  SessionEvent.Compaction.Started,
  SessionEvent.Compaction.Ended,
  SessionEvent.Compaction.Failed,
  SessionEvent.RevertEvent.Staged,
  SessionEvent.RevertEvent.Cleared,
  SessionEvent.RevertEvent.Committed,
] as const satisfies readonly MessageEventDefinition[]

const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set(
  MESSAGE_EVENT_DEFINITIONS.map((definition) => EventV2.versionedType(definition.type, definition.durable!.version)),
)

const SUMMARY_TEMPLATE = `Output exactly one TOON document, and nothing else, that encodes the current conversation memory.

The document MUST be a single TOON value whose root element is \`conversation_memory\`. The TOON encodes a conversation checkpoint and MUST include:
- \`version: 1\`, exactly,
- \`through_sequence\`: the exact sequence number of the last message this memory covers, as a plain non-negative integer scalar,
- \`objective\`, \`current_state\`, and \`continuation\` as string scalars,
- \`facts\` as an array of \`{ text, confidence }\`, where \`confidence\` is \`confirmed\`, \`likely\`, or \`uncertain\`,
- \`decisions\` as an array of \`{ text, status }\`, where \`status\` is \`accepted\`, \`rejected\`, or \`superseded\`,
- \`preferences\`, \`constraints\`, \`completed\`, \`pending\`, \`blockers\`, \`unresolved\`, and \`important_identifiers\` as arrays of strings,
- no Markdown code fences, no explanatory prose around the TOON, and no leading or trailing commentary.

Rules:
- The summary body is terse and factual.
- Merge the previous summary (when present) with the new material; drop stale details only when the new material supersedes them.
- Do not mention the summarization process, the messages that were removed, or this instruction.`

type Settings = {
  readonly keepRecentMessages: number
  readonly reservedOutputTokens: number
  readonly contextSafetyMarginTokens: number
  readonly timeoutSeconds: number
  readonly maxOutputTokens: number
  readonly maxSummaryBytes: number
  readonly maxInternalPasses: number
}

type Dependencies = {
  readonly db: Database.Interface["db"]
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
  readonly store: SessionStore.Interface
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

export type SummarizeInput = {
  readonly sessionID: SessionSchema.ID
  readonly boundaryMessageID: SessionMessage.ID
  readonly system?: readonly SystemPart[]
}

export type SummarizeResult = {
  readonly summaryMessageID: SessionMessage.ID
  readonly summaryRevision: number
  readonly through: number
  readonly deletedMessageCount: number
  readonly remainingMessageCount: number
  readonly providerID: string
  readonly modelID: string
}

export type SummarizeFailure =
  | { readonly type: "summarize.unknown-session"; readonly message: string }
  | { readonly type: "summarize.unknown-boundary"; readonly message: string }
  | { readonly type: "summarize.cross-session"; readonly message: string }
  | { readonly type: "summarize.already-covered"; readonly message: string }
  | { readonly type: "summarize.keep-recent-floor"; readonly message: string }
  | { readonly type: "summarize.empty-range"; readonly message: string }
  | { readonly type: "summarize.invalid-model"; readonly message: string }
  | { readonly type: "summarize.invalid-config"; readonly message: string }
  | { readonly type: "summarize.pass-limit"; readonly message: string }
  | { readonly type: "summarize.concurrent"; readonly message: string }
  | { readonly type: "summarize.conflict"; readonly message: string }
  | { readonly type: "summarize.context-overflow"; readonly message: string }
  | { readonly type: "summarize.timeout"; readonly message: string }
  | { readonly type: "summarize.invalid-toon"; readonly message: string }
  | { readonly type: "summarize.failed"; readonly message: string }

/**
 * TOON validation contract used by the explicit summarizer. `summary-toon.ts`
 * owns the `conversation_memory` schema, `encode`, and `parse`; the caller
 * narrows `Memory | ParseError` itself.
 */

export type Outcome =
  | Pick<SessionMessage.CompactionCompleted, "status">
  | Pick<SessionMessage.CompactionFailed, "status" | "error">

export interface Interface {
  readonly required: (input: AutoInput, request?: LLMRequest) => boolean
  readonly compact: (input: AutoInput) => Effect.Effect<Outcome>
  readonly compactManual: (input: ManualInput) => Effect.Effect<Outcome>
  readonly summarize: (input: SummarizeInput) => Effect.Effect<SummarizeResult, SummarizeFailure>
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
      keepRecentMessages: current.keep_recent_messages ?? result.keepRecentMessages,
      reservedOutputTokens: current.reserved_output_tokens ?? result.reservedOutputTokens,
      contextSafetyMarginTokens: current.context_safety_margin_tokens ?? result.contextSafetyMarginTokens,
      timeoutSeconds: current.timeout_seconds ?? result.timeoutSeconds,
      maxOutputTokens: current.max_output_tokens ?? result.maxOutputTokens,
      maxSummaryBytes: current.max_summary_bytes ?? result.maxSummaryBytes,
      maxInternalPasses: current.max_internal_passes ?? result.maxInternalPasses,
    }),
    {
      keepRecentMessages: DEFAULT_KEEP_RECENT_MESSAGES,
      reservedOutputTokens: 0,
      contextSafetyMarginTokens: DEFAULT_SAFETY_MARGIN_TOKENS,
      timeoutSeconds: 0,
      maxOutputTokens: 0,
      maxSummaryBytes: DEFAULT_MAX_SUMMARY_BYTES,
      maxInternalPasses: DEFAULT_MAX_INTERNAL_PASSES,
    },
  )
}

export const buildSummarizePrompt = (input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
  readonly through: number
}) =>
  [
    input.previousSummary
      ? `Update the conversation memory below using the new material.\nPreserve still-true details, remove stale details, and merge in only the new facts.\n<previous-conversation-memory>\n${input.previousSummary}\n</previous-conversation-memory>`
      : "Create a conversation memory from the conversation history.",
    `The new material covers message sequences up to and including ${input.through}.`,
    SUMMARY_TEMPLATE,
    "The following is the conversation material:",
    ...input.context,
  ].join("\n\n")

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
  const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
  const decodeRow = (row: typeof SessionMessageTable.$inferSelect): SessionMessage.Info =>
    decodeMessage({ ...row.data, id: row.id, type: row.type })

  const readRowsUpTo = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, through: number) {
    return yield* dependencies.db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), lte(SessionMessageTable.seq, through)))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
  })

  const latestCompletedCompaction = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    return yield* dependencies.db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sessionID),
          eq(SessionMessageTable.type, "compaction"),
          sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
        ),
      )
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
  })

  const runningCompactionRow = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const rows = yield* readRowsUpTo(sessionID, Number.MAX_SAFE_INTEGER)
    return rows.some(
      (row) =>
        row.type === "compaction" &&
        (typeof row.data === "object" && row.data !== null ? (row.data as Record<string, unknown>) : {}).status ===
          "running",
    )
  })

  const revisionOf = (row: typeof SessionMessageTable.$inferSelect | undefined) => {
    if (!row || typeof row.data !== "object" || row.data === null) return 0
    const metadata = (row.data as Record<string, unknown>).metadata as Record<string, unknown> | undefined
    const revision = metadata?.summary_revision
    return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : 0
  }

  const summarizeTextOf = (row: typeof SessionMessageTable.$inferSelect | undefined) => {
    if (!row || typeof row.data !== "object" || row.data === null) return undefined
    const summary = (row.data as Record<string, unknown>).summary
    return typeof summary === "string" ? summary : undefined
  }

  const runPass = Effect.fn("SessionCompaction.runPass")(function* (input: {
    readonly session: SessionSchema.Info
    readonly system: readonly SystemPart[]
    readonly resolved: SessionRunnerModel.Resolved
    readonly prompt: string
    readonly through: number
  }) {
    const modelRef = input.resolved.ref
    const baseRequest = LLM.request({
      model: input.resolved.model,
      http: { headers: SessionModelHeaders.make(input.session, dependencies.headers) },
      system: input.system,
      messages: [Message.user(input.prompt)],
      tools: [],
    })
    const namespaceInput = {
      scope: "summarizer" as const,
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
    let failure: SummarizeFailure | undefined
    const completeRequest = Effect.suspend(() => {
      const recorded = usage ?? {
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      return Effect.all(
        [
          tracker.complete({
            tokens: recorded.tokens,
            ...(usage === undefined || SessionUsage.estimatedCost(input.resolved.cost, recorded.tokens) === undefined
              ? {}
              : { cost: SessionUsage.estimatedCost(input.resolved.cost, recorded.tokens)! }),
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
    const streamedEffect = startStreamed(dependencies, request, {
      cost: input.resolved.cost,
      chunks,
      updateUsage: (step) => {
        usage = usage ? SessionUsage.add(usage, step) : step
      },
      setFailure: (value) => {
        failure = value
      },
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          completeRequest.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to record summarizer request", { cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
    )
    const streamed =
      config.timeoutSeconds > 0
        ? yield* streamedEffect.pipe(Effect.timeoutOption(Duration.seconds(config.timeoutSeconds)))
        : yield* streamedEffect.pipe(Effect.as(Option.some<void>(undefined)))
    if (Option.isNone(streamed) && failure === undefined)
      return yield* Effect.fail({ type: "summarize.timeout", message: "Summarizer timed out" })
    const summary = chunks.join("")
    if (failure) return yield* Effect.fail(failure)
    if (!summary.trim()) return yield* Effect.fail({ type: "summarize.failed", message: "Summarizer produced no summary" })
    const parsed = SessionSummaryToon.parse(summary, {
      throughSequence: input.through,
      maxSummaryBytes: config.maxSummaryBytes,
    })
    if ("_tag" in parsed)
      return yield* Effect.fail({ type: "summarize.invalid-toon", message: parsed.message })
    return { text: summary, usage, through: parsed.through_sequence }
  })

  const summarizeCore = Effect.fn("SessionCompaction.summarizeCore")(function* (input: SummarizeInput) {
    const session = yield* dependencies.store.get(input.sessionID)
    if (!session)
      return yield* Effect.fail({ type: "summarize.unknown-session", message: `Unknown session: ${input.sessionID}` })
    const boundary = yield* dependencies.db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, input.boundaryMessageID))
      .get()
      .pipe(Effect.orDie)
    if (!boundary)
      return yield* Effect.fail({
        type: "summarize.unknown-boundary",
        message: `Unknown boundary message: ${input.boundaryMessageID}`,
      })
    if (boundary.session_id !== session.id)
      return yield* Effect.fail({
        type: "summarize.cross-session",
        message: `Boundary message ${input.boundaryMessageID} belongs to another session`,
      })
    if (yield* SessionPending.compaction(dependencies.db, session.id))
      return yield* Effect.fail({
        type: "summarize.concurrent",
        message: "A compaction is already pending for this session",
      })
    if (yield* runningCompactionRow(session.id))
      return yield* Effect.fail({
        type: "summarize.concurrent",
        message: "A compaction is already running for this session",
      })

    const coveredRows = yield* readRowsUpTo(session.id, boundary.seq)
    const previous = coveredRows.findLast(
      (row) =>
        row.type === "compaction" &&
        typeof row.data === "object" &&
        row.data !== null &&
        (row.data as Record<string, unknown>).status === "completed",
    )
    if (previous && boundary.seq <= previous.seq)
      return yield* Effect.fail({
        type: "summarize.already-covered",
        message: `Boundary message is already covered by an earlier summary (through sequence ${previous.seq})`,
      })
    const firstSeq = previous?.seq ?? coveredRows[0]?.seq
    if (firstSeq === undefined)
      return yield* Effect.fail({ type: "summarize.empty-range", message: "There is no message range to summarize" })
    const covered = coveredRows.filter((row) => row.seq >= firstSeq)
    const eligible = covered.flatMap((row) => {
      const message = decodeRow(row)
      if (message.type === "compaction" || message.type === "system") return []
      const text = serialize(message)
      return text.length > 0 ? [{ seq: row.seq, text }] : []
    })
    if (eligible.length === 0)
      return yield* Effect.fail({
        type: "summarize.empty-range",
        message: "There is no conversation material in the requested range",
      })
    const remaining = yield* dependencies.db
      .select({ total: count() })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, session.id), gt(SessionMessageTable.seq, boundary.seq)))
      .get()
      .pipe(Effect.orDie)
    if ((remaining?.total ?? 0) < config.keepRecentMessages)
      return yield* Effect.fail({
        type: "summarize.keep-recent-floor",
        message: `Summarization must leave at least ${config.keepRecentMessages} recent messages after the boundary`,
      })

    const agent = yield* dependencies.agents.get(AgentV2.ID.make("compaction"))
    const resolved = yield* dependencies.helpers.resolveModel(session, "compaction", agent)
    if (!resolved)
      return yield* Effect.fail({
        type: "summarize.invalid-model",
        message: "No summarizer model is configured for compaction",
      })
    const context = resolved.model.route.defaults.limits?.context
    if (context === undefined || context <= 0)
      return yield* Effect.fail({
        type: "summarize.invalid-model",
        message: "The summarizer model has no usable context window",
      })
    const modelOutput = Math.min(resolved.model.route.defaults.limits?.output ?? 0, OUTPUT_TOKEN_MAX)
    const cappedOutput =
      config.maxOutputTokens > 0 && modelOutput > 0
        ? Math.min(config.maxOutputTokens, modelOutput)
        : config.maxOutputTokens > 0
          ? config.maxOutputTokens
          : modelOutput
    const reservedOutput = Math.max(cappedOutput, config.reservedOutputTokens)
    const safeInput =
      SessionContextBudget.safeInputBudget({
        contextWindowTokens: context,
        maxOutputTokens: reservedOutput,
        contextSafetyMarginTokens: config.contextSafetyMarginTokens,
      }) - PROMPT_FRAMING_TOKENS
    if (safeInput <= 0)
      return yield* Effect.fail({
        type: "summarize.invalid-config",
        message: "The configured summarizer budget leaves no room for input",
      })

    const system = assembleCompactionConstraints((input.system ?? []).map((part) => part.text)).map((text) =>
      SystemPart.make(text),
    )

    const totalTokens = eligible.reduce((total, item) => total + Token.estimate(item.text), 0)
    const batchBudget = Math.max(1, Math.floor(safeInput / 2))
    const estimatedPasses = Math.max(1, Math.ceil(totalTokens / batchBudget))
    if (estimatedPasses > config.maxInternalPasses)
      return yield* Effect.fail({
        type: "summarize.pass-limit",
        message: `This range needs ${estimatedPasses} internal passes, exceeding max_internal_passes (${config.maxInternalPasses})`,
      })

    const previousSummaryText = summarizeTextOf(previous)
    const previousRevision = revisionOf(previous)
    const fingerprint = {
      boundarySeq: boundary.seq,
      firstSeq,
      rowCount: covered.length,
      previousRevision,
      previousId: previous?.id,
    }

    let rolling = previousSummaryText
    let cursor = 0
    let finalText: string | undefined
    let finalThrough: number | undefined
    let passes = 0
    let totalUsage: SessionUsage.Recorded | undefined
    while (cursor < eligible.length) {
      passes += 1
      if (passes > config.maxInternalPasses)
        return yield* Effect.fail({
          type: "summarize.pass-limit",
          message: `This range needs more than max_internal_passes (${config.maxInternalPasses}) internal passes`,
        })
      const prefix = fitPrefix(eligible, cursor, rolling, safeInput)
      if (prefix.count === 0)
        return yield* Effect.fail({
          type: "summarize.context-overflow",
          message: "The rolling summary plus the next batch does not fit the summarizer budget",
        })
      const last = eligible[cursor + prefix.count - 1]
      if (!last) return yield* Effect.fail({ type: "summarize.context-overflow", message: "No batch material remains" })
      const through = cursor + prefix.count === eligible.length ? boundary.seq : last.seq
      const passResult = yield* runPass({
        session,
        system,
        resolved,
        prompt: buildSummarizePrompt({
          ...(rolling === undefined ? {} : { previousSummary: rolling }),
          context: [prefix.text],
          through,
        }),
        through,
      })
      rolling = passResult.text
      finalText = passResult.text
      finalThrough = passResult.through
      if (passResult.usage) totalUsage = totalUsage ? SessionUsage.add(totalUsage, passResult.usage) : passResult.usage
      cursor += prefix.count
    }
    if (finalText === undefined || finalThrough !== boundary.seq)
      return yield* Effect.fail({ type: "summarize.invalid-toon", message: "The final summary does not cover the requested boundary" })

    const summaryID = SessionMessage.ID.create()
    const revision = previousRevision + 1
    const now = Date.now()
    const rollbackAndFail = (cause: Cause.Cause<unknown>) =>
      dependencies.db.run("ROLLBACK").pipe(
        Effect.orDie,
        Effect.andThen(Effect.fail(transactionFailure(cause))),
      )
    const committed = yield* Effect.gen(function* () {
      yield* dependencies.db.run("BEGIN IMMEDIATE").pipe(
        Effect.catchCause(() =>
          Effect.fail({ type: "summarize.failed", message: "Failed to begin the summarization transaction" }),
        ),
      )
      // Any conflict, SQLite failure, or defect rolls back and deletes nothing.
      const outcome = yield* Effect.gen(function* () {
        const currentBoundary = yield* dependencies.db
          .select({ sessionID: SessionMessageTable.session_id, seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, input.boundaryMessageID))
          .get()
          .pipe(Effect.orDie)
        if (
          !currentBoundary ||
          currentBoundary.sessionID !== session.id ||
          currentBoundary.seq !== fingerprint.boundarySeq
        )
          return yield* Effect.fail({ type: "summarize.conflict", message: "The boundary changed" })
        const currentCount = yield* dependencies.db
          .select({ total: count() })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, session.id),
              gte(SessionMessageTable.seq, fingerprint.firstSeq),
              lte(SessionMessageTable.seq, fingerprint.boundarySeq),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if ((currentCount?.total ?? 0) !== fingerprint.rowCount)
          return yield* Effect.fail({ type: "summarize.conflict", message: "The covered range changed" })
        const currentPrevious = yield* latestCompletedCompaction(session.id)
        if (
          currentPrevious?.id !== fingerprint.previousId ||
          revisionOf(currentPrevious) !== fingerprint.previousRevision
        )
          return yield* Effect.fail({ type: "summarize.conflict", message: "The summary revision changed" })
        if (yield* SessionPending.compaction(dependencies.db, session.id))
          return yield* Effect.fail({ type: "summarize.conflict", message: "A compaction became pending" })
        const messageEvents = yield* dependencies.db
          .select({ seq: EventTable.seq })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, session.id),
              inArray(EventTable.type, Array.from(MESSAGE_EVENT_TYPES)),
              gte(EventTable.seq, fingerprint.firstSeq),
              lte(EventTable.seq, fingerprint.boundarySeq),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const eventSequences = new Set(messageEvents.map((event) => event.seq))
        const projectionRows = yield* dependencies.db
          .select({ id: SessionMessageTable.id, seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, session.id),
              gte(SessionMessageTable.seq, fingerprint.firstSeq),
              lte(SessionMessageTable.seq, fingerprint.boundarySeq),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const projectionIDs = projectionRows
          .filter((row) => row.id === fingerprint.previousId || eventSequences.has(row.seq))
          .map((row) => row.id)
        // Do not delete rows projected by protected durable events. The old direct summary is
        // the only row without a message-producing event that may be removed here.
        if (projectionIDs.length > 0)
          yield* dependencies.db
            .delete(SessionMessageTable)
            .where(inArray(SessionMessageTable.id, projectionIDs))
            .run()
            .pipe(Effect.orDie)
        yield* dependencies.db
          .delete(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, session.id),
              inArray(EventTable.type, Array.from(MESSAGE_EVENT_TYPES)),
              gte(EventTable.seq, fingerprint.firstSeq),
              lte(EventTable.seq, fingerprint.boundarySeq),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        const remainingTotal = yield* dependencies.db
          .select({ total: count() })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie)
        // Encode through the canonical message schema (like the projector) so the row
        // data stays decodable by every reader, including the summary revision carried
        // in metadata.
        const encoded = Schema.encodeSync(SessionMessage.Info)(
          SessionMessage.CompactionCompleted.make({
            id: summaryID,
            type: "compaction",
            status: "completed",
            reason: "manual",
            summary: finalText,
            recent: "",
            messages: eligible.length,
            ...(totalUsage === undefined ? {} : { tokens: totalUsage.tokens }),
            time: { created: DateTime.makeUnsafe(now) },
            metadata: { summary_revision: revision },
          }),
        )
        const { id: encodedID, type: encodedType, ...encodedData } = encoded
        yield* dependencies.db
          .insert(SessionMessageTable)
          .values({
            id: SessionMessage.ID.make(encodedID),
            session_id: session.id,
            type: encodedType,
            seq: fingerprint.boundarySeq,
            time_created: now,
            data: encodedData,
          })
          .run()
          .pipe(Effect.orDie)
        return {
          deletedMessageCount: projectionIDs.length,
          remainingMessageCount: (remainingTotal?.total ?? 0) + 1,
        }
      }).pipe(Effect.catchCause(rollbackAndFail))
      yield* dependencies.db.run("COMMIT").pipe(Effect.catchCause(rollbackAndFail))
      return outcome
    })

    return {
      summaryMessageID: summaryID,
      summaryRevision: revision,
      through: boundary.seq,
      deletedMessageCount: committed.deletedMessageCount,
      remainingMessageCount: committed.remainingMessageCount,
      providerID: String(resolved.ref.providerID),
      modelID: String(resolved.ref.id),
    }
  })

  const summarize = Effect.fn("SessionCompaction.summarize")(function* (input: SummarizeInput) {
    return yield* summarizeCore(input).pipe(Effect.mapError(toSummarizeFailure))
  })

  const compact = Effect.fn("SessionCompaction.compact")(function* (input: AutoInput) {
    // Automatic summarization is removed: no threshold, overflow, or resume path may
    // start a summarization without an explicit conversation_summarize tool call.
    const error = { type: "compaction.unavailable" as const, message: "Automatic compaction is disabled" }
    return { status: "failed" as const, error }
  })

  const required = (input: AutoInput, request?: LLMRequest) => false

  const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: ManualInput) {
    // The legacy durable manual-compaction resume path is retired; the only
    // summarization entry point is the conversation_summarize tool. Publishing
    // Compaction.Failed settles the admitted pending row so drains proceed.
    const error = {
      type: "compaction.unavailable" as const,
      message: "Manual compaction must use the conversation_summarize tool",
    }
    return yield* failed({
      sessionID: input.session.id,
      reason: "manual",
      error,
      inputID: input.inputID,
    })
  })

  return Service.of({
    required,
    compact,
    compactManual,
    summarize,
  })
}

function transactionFailure(cause: Cause.Cause<unknown>): SummarizeFailure {
  const failed = cause.reasons.find(Cause.isFailReason)
  const error = failed?.error
  if (error !== undefined && typeof error === "object" && error !== null && "type" in error)
    return error as SummarizeFailure
  const defect = cause.reasons.find(Cause.isDieReason)
  if (defect !== undefined && defect.defect instanceof Error && defect.defect.message)
    return { type: "summarize.failed", message: defect.defect.message }
  return { type: "summarize.failed", message: "The summarization transaction failed" }
}

function startStreamed(
  dependencies: Dependencies,
  request: LLMRequest,
  hooks: {
    readonly cost: ModelV2.Info["cost"]
    readonly chunks: string[]
    readonly updateUsage: (step: SessionUsage.Recorded) => void
    readonly setFailure: (failure: SummarizeFailure) => void
  },
) {
  return dependencies.llm.stream(request).pipe(
    Stream.runForEach((event) => {
      if (LLMEvent.is.providerError(event))
        hooks.setFailure({
          type: event.classification === "context-overflow" ? "summarize.context-overflow" : "summarize.failed",
          message: event.message,
        })
      if (LLMEvent.is.textDelta(event)) hooks.chunks.push(event.text)
      if (LLMEvent.is.stepFinish(event)) hooks.updateUsage(SessionUsage.record(event.usage, hooks.cost))
      return Effect.void
    }),
    Effect.catchTag("LLM.Error", (error) =>
      Effect.sync(() => {
        const sessionError = toSessionError(error)
        hooks.setFailure({ type: "summarize.failed", message: sessionError.message })
      }),
    ),
  )
}

function fitPrefix(
  source: readonly { readonly seq: number; readonly text: string }[],
  cursor: number,
  rolling: string | undefined,
  safeInput: number,
) {
  const remaining = source.slice(cursor)
  let lower = 0
  let upper = remaining.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    const tokens = estimateSourceTokens(rolling, remaining.slice(0, middle))
    if (tokens <= safeInput) lower = middle
    else upper = middle - 1
  }
  return {
    count: lower,
    text: remaining
      .slice(0, lower)
      .map((item) => item.text)
      .join("\n\n"),
  }
}

const estimateSourceTokens = (rolling: string | undefined, items: readonly { readonly text: string }[]) =>
  (rolling === undefined ? 0 : Token.estimate(rolling)) +
  items.reduce((total, item) => total + Token.estimate(item.text), 0)

function toSummarizeFailure(error: unknown): SummarizeFailure {
  if (typeof error === "object" && error !== null && "type" in error && typeof (error as { type?: unknown }).type === "string")
    return error as SummarizeFailure
  if (error instanceof Error && error.message) return { type: "summarize.failed", message: error.message }
  return { type: "summarize.failed", message: "Summarization failed" }
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
      const store = yield* SessionStore.Service
      const { db } = yield* Database.Service
      return make({
        db,
        events,
        llm,
        agents,
        helpers,
        requests,
        cacheRuntime,
        config: settings(yield* config.entries()),
        configService: config,
        store,
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
      SessionStore.node,
      Database.node,
    ],
  })
}

export const node = configured()
