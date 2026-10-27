export * as SessionCacheDiagnostics from "./cache-diagnostics"

import { cacheProfile } from "@ycoding-ai/ai/cache-profile"
import { Effect, Schema } from "effect"
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { Session } from "@ycoding-ai/schema/session"
import type { ContextBreakdown } from "@ycoding-ai/schema/session-cache-diagnostics"
import { Money } from "@ycoding-ai/schema/money"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { SessionCacheDiagnostics as DiagnosticsSchema } from "@ycoding-ai/schema/session-cache-diagnostics"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { CatalogModel } from "../model"
import { OpenAICodex } from "../plugin/provider/openai-codex"
import { SessionMessage } from "./message"
import { SessionUsage } from "./usage"
import type { Database } from "../database/database"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"
import { SessionMessageTable, SessionProviderRequestTable, SessionTable } from "./sql"
import { MessageDecodeError } from "./error"

export interface CalculateInput {
  readonly model: CatalogModel.Ref
  readonly tokens: TokenUsage.Info
  readonly estimatedCost: Money.USD
  readonly contextLimit?: number
  readonly contextBreakdown?: ContextBreakdown
  readonly routeID?: string
  readonly providerCache?: Session.ProviderCacheDiagnostics
  readonly generationSpeed?: DiagnosticsSchema.GenerationSpeedHistory
}

const safe = (value: number) => Math.max(0, Number.isFinite(value) ? value : 0)

// Route id → cache mechanism. Native protocol routes (`anthropic-messages`,
// `openrouter`, `google-vertex-*`, …) and the AI SDK adapter routes both land
// here, so a provider added on one path does not silently report `none` on the
// other. Keep in sync with `@ycoding-ai/ai`'s cache-policy route sets.
const ROUTE_MECHANISMS: Record<string, Session.CacheMechanism | undefined> = {
  "anthropic-messages": "anthropic-cache-control",
  "google-vertex-messages": "anthropic-cache-control",
  "ai-sdk:@ai-sdk/anthropic": "anthropic-cache-control",
  "ai-sdk:@ai-sdk/google-vertex/anthropic": "anthropic-cache-control",
  openrouter: "openrouter-cache-control",
  "openrouter-responses": "openrouter-cache-control",
  "ai-sdk:@openrouter/ai-sdk-provider": "openrouter-cache-control",
  "bedrock-converse": "bedrock-cache-point",
  "ai-sdk:@ai-sdk/amazon-bedrock": "bedrock-cache-point",
  "openai-chat": "openai-prefix-cache",
  "openai-responses": "openai-prefix-cache",
  "openai-responses-websocket": "openai-prefix-cache",
  "github-copilot-chat": "openai-prefix-cache",
  "github-copilot-responses": "openai-prefix-cache",
  "ai-sdk:@ai-sdk/github-copilot": "openai-prefix-cache",
  "ai-sdk:cursor-opencode-provider": "provider-reported",
  [OpenAICodex.routeID]: "openai-prefix-cache",
  [OpenAICodex.webSocketRouteID]: "openai-prefix-cache",
  "openai-compatible-chat": "openai-prefix-cache",
  "openai-compatible-responses": "openai-prefix-cache",
  "azure-openai-chat": "openai-prefix-cache",
  "azure-openai-responses": "openai-prefix-cache",
  "google-vertex-chat": "openai-prefix-cache",
  "google-vertex-responses": "openai-prefix-cache",
  "cloudflare-ai-gateway": "openai-prefix-cache",
  "cloudflare-workers-ai": "openai-prefix-cache",
  "ai-sdk:@ai-sdk/openai": "openai-prefix-cache",
  "ai-sdk:@ai-sdk/azure": "openai-prefix-cache",
  gemini: "gemini-prefix-cache",
  "google-vertex-gemini": "gemini-prefix-cache",
  "ai-sdk:@ai-sdk/google": "gemini-prefix-cache",
  "ai-sdk:@ai-sdk/google-vertex": "gemini-prefix-cache",
  "runpod-ollama": "provider-reported",
  "runpod-vllm": "provider-reported",
}

export function mechanism(
  routeID: string,
  model: CatalogModel.Ref,
  tokens: TokenUsage.Info,
): Session.CacheMechanism {
  const known = ROUTE_MECHANISMS[routeID]
  if (known) return known
  if (routeID === "unknown") {
    switch (model.providerID) {
      case "openai":
      case "azure":
      case "github-copilot":
      case "ycoding":
      case "meta":
        return "openai-prefix-cache"
      case "openrouter":
        return "openrouter-cache-control"
      case "anthropic":
        return "anthropic-cache-control"
      case "amazon-bedrock":
        return "bedrock-cache-point"
      case "google":
      case "google-vertex":
      case "antigravity":
        return "gemini-prefix-cache"
      case "cursor":
        return "provider-reported"
    }
  }
  return tokens.cache.read > 0 || tokens.cache.write > 0 ? "provider-reported" : "none"
}

export function calculate(input: CalculateInput): Session.CacheDiagnostics {
  const uncachedInput = safe(input.tokens.input)
  const output = safe(input.tokens.output)
  const reasoning = safe(input.tokens.reasoning)
  const cacheRead = safe(input.tokens.cache.read)
  const cacheWrite = safe(input.tokens.cache.write)
  const total = uncachedInput + output + reasoning + cacheRead + cacheWrite
  const eligible = uncachedInput + cacheRead + cacheWrite
  const limit = input.contextLimit !== undefined && input.contextLimit > 0 ? Math.trunc(input.contextLimit) : undefined
  const readReported = input.providerCache?.readReported ?? cacheRead > 0
  const writeReported = input.providerCache?.writeReported ?? cacheWrite > 0
  const selectedMechanism =
    input.providerCache?.mechanism ?? mechanism(input.routeID ?? "unknown", input.model, input.tokens)
  // A prefix below the model's minimum is accepted and then ignored by the
  // provider, so surface the threshold instead of reporting a bare 0% ratio.
  const minimumTokens = cacheProfile(input.model.id)?.minimumTokens

  return {
    model: input.model,
    ...(input.contextBreakdown === undefined ? {} : { contextBreakdown: input.contextBreakdown }),
    context: {
      total,
      ...(limit === undefined
        ? {}
        : {
            limit,
            remaining: Math.max(0, limit - total),
            percent: Math.round((total / limit) * 100),
          }),
    },
    tokens: { uncachedInput, output, reasoning, cacheRead, cacheWrite },
    cache: {
      eligible,
      ...(readReported && eligible > 0 ? { hitRatio: cacheRead / eligible } : {}),
      mechanism: selectedMechanism,
      readReported,
      writeReported,
      ...(minimumTokens === undefined ? {} : { minimumTokens, belowMinimum: eligible < minimumTokens }),
    },
    estimatedCost: input.estimatedCost,
    ...(input.generationSpeed === undefined ? {} : { generationSpeed: input.generationSpeed }),
  }
}

export function generationSpeed(
  records: readonly Pick<ProviderRequest.Record, "model" | "timing">[],
  current?: Pick<ProviderRequest.Record, "model" | "timing">,
): DiagnosticsSchema.GenerationSpeedHistory | undefined {
  const recentRecords = [...records, ...(current === undefined ? [] : [current])]
  const newest = recentRecords.at(-1)?.model
  if (!newest) return undefined
  const recent = recentRecords.flatMap((record) => {
    if (record.model.providerID !== newest.providerID || record.model.id !== newest.id) return []
    const sample = generationSample(record.timing)
    return sample === undefined ? [] : [{ model: record.model, ...sample }]
  }).slice(-8)
  const tokens = recent.reduce((sum, sample) => sum + sample.tokens, 0)
  const durationNs = recent.reduce((sum, sample) => sum + sample.durationNs, 0)
  return { model: newest, recent, ...(recent.length === 0 ? {} : { latest: {
    model: newest, tokens, durationNs, tokensPerSecond: tokens * 1_000_000_000 / durationNs,
    ...(recent.some((sample) => sample.estimated) ? { estimated: true } : {}),
  } }) }
}

export function generationSample(timing: ProviderRequest.Timing | undefined) {
  const tokens = timing?.receivedOutput?.estimatedTokens
  const durationNs = timing?.receivedOutput?.durationNs
  if (!Number.isSafeInteger(tokens) || !tokens || tokens <= 0 ||
    !Number.isSafeInteger(durationNs) || !durationNs || durationNs < 1_000_000_000) return undefined
  const tokensPerSecond = tokens * 1_000_000_000 / durationNs
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return undefined
  return { tokens, durationNs, tokensPerSecond, estimated: true as const }
}

export const recentGenerationRecords = Effect.fn("SessionCacheDiagnostics.recentGenerationRecords")(function* (
  db: Database.Interface["db"],
  sessionID: Session.ID,
  model: CatalogModel.Ref,
  before = Number.MAX_SAFE_INTEGER,
) {
  const samples: (typeof SessionProviderRequestTable.$inferSelect)[] = []
  let cursor = before
  while (samples.length < 8) {
    const rows = yield* db.select().from(SessionProviderRequestTable).where(and(
      eq(SessionProviderRequestTable.session_id, sessionID), lt(SessionProviderRequestTable.request, cursor),
    )).orderBy(desc(SessionProviderRequestTable.request)).limit(10_000).all().pipe(Effect.orDie)
    for (const row of rows) {
      if (row.source !== "step" || row.model.providerID !== model.providerID || row.model.id !== model.id ||
        !generationSample(row.timing ?? undefined)) continue
      samples.push(row)
      if (samples.length === 8) break
    }
    if (rows.length < 10_000 || samples.length === 8) break
    cursor = rows[rows.length - 1].request
    yield* Effect.yieldNow
  }
  return samples.toReversed()
})

export function latestAssistant(
  messages: ReadonlyArray<SessionMessage.Info>,
  boundary?: SessionMessage.ID,
): SessionMessage.Assistant | undefined {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  return messages.findLast(
    (message, index): message is SessionMessage.Assistant =>
      message.type === "assistant" && (message.tokens !== undefined || message.time.completed !== undefined) &&
      index > compactionIndex && index < end,
  )
}

export const read = Effect.fn("SessionCacheDiagnostics.read")(function* (
  db: Database.Interface["db"],
  sessionID: Session.ID,
  boundary?: SessionMessage.ID,
) {
  const anchor = boundary ? yield* db.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, boundary)))
    .get().pipe(Effect.orDie) : undefined
  if (boundary && !anchor) return undefined
  const row = yield* db.get<{ id: string; data: string }>(sql`
    WITH checkpoint AS MATERIALIZED (
      SELECT coalesce(max(seq), -1) AS seq FROM ${EventTable}
      WHERE aggregate_id = ${sessionID} AND type IN (
        ${EventRuntime.versionedType(SessionEvent.Compaction.EndedV1.type, SessionEvent.Compaction.EndedV1.durable.version)},
        ${EventRuntime.versionedType(SessionEvent.Compaction.Ended.type, SessionEvent.Compaction.Ended.durable.version)})
    ), candidates AS (
      SELECT * FROM (
        SELECT seq, json_extract(data, '$.assistantMessageID') AS assistantMessageID FROM ${EventTable} INDEXED BY event_aggregate_type_seq_idx
        WHERE aggregate_id = ${sessionID}
          AND type = ${EventRuntime.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.durable.version)}
          AND seq > (SELECT seq FROM checkpoint) AND seq < ${anchor?.seq ?? Number.MAX_SAFE_INTEGER}
        ORDER BY seq DESC LIMIT 1
      ) UNION ALL SELECT * FROM (
        SELECT seq, json_extract(data, '$.assistantMessageID') AS assistantMessageID FROM ${EventTable} INDEXED BY event_aggregate_type_seq_idx
        WHERE aggregate_id = ${sessionID}
          AND type = ${EventRuntime.versionedType(SessionEvent.Step.Failed.type, SessionEvent.Step.Failed.durable.version)}
          AND seq > (SELECT seq FROM checkpoint) AND seq < ${anchor?.seq ?? Number.MAX_SAFE_INTEGER}
        ORDER BY seq DESC LIMIT 1
      )
    ), settlement AS MATERIALIZED (
      SELECT assistantMessageID FROM candidates ORDER BY seq DESC LIMIT 1
    )
    SELECT message.id, json_patch('{}', json_object('id', message.id,
      'model', json_extract(message.data, '$.model'), 'tokens', json_extract(message.data, '$.tokens'),
      'cost', json_extract(message.data, '$.cost'), 'diagnostics', json_extract(message.data, '$.diagnostics'))) AS data
    FROM settlement JOIN ${SessionMessageTable} AS message ON message.id = settlement.assistantMessageID
    WHERE message.session_id = ${sessionID} AND message.type = 'assistant'
  `).pipe(Effect.orDie)
  const assistant = row ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
    id: SessionMessage.ID,
    model: SessionMessage.Assistant.fields.model,
    tokens: SessionMessage.Assistant.fields.tokens,
    cost: SessionMessage.Assistant.fields.cost,
    diagnostics: SessionMessage.Assistant.fields.diagnostics,
  })))(row.data).pipe(Effect.mapError(() => new MessageDecodeError({ sessionID, messageID: SessionMessage.ID.make(row.id) }))) : undefined
  const selected = boundary ? undefined : yield* db.select({ model: SessionTable.model }).from(SessionTable)
    .where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  const newest = !selected?.model && !assistant ? yield* db.select({ model: SessionProviderRequestTable.model })
    .from(SessionProviderRequestTable).where(and(eq(SessionProviderRequestTable.session_id, sessionID),
      eq(SessionProviderRequestTable.source, "step")))
    .orderBy(desc(SessionProviderRequestTable.request)).limit(1).get().pipe(Effect.orDie) : undefined
  const model = selected?.model ?? assistant?.model ?? newest?.model
  if (!model) return undefined
  const bound = boundary && assistant ? yield* db.select({ request: SessionProviderRequestTable.request })
    .from(SessionProviderRequestTable).where(and(eq(SessionProviderRequestTable.session_id, sessionID),
      eq(SessionProviderRequestTable.assistant_message_id, assistant.id)))
    .orderBy(desc(SessionProviderRequestTable.request)).get().pipe(Effect.orDie) : undefined
  const records = yield* recentGenerationRecords(db, sessionID, model, boundary ? (bound?.request ?? 0) + 1 : undefined)
  return calculate({
    model: assistant?.model ?? model,
    tokens: assistant?.tokens ?? SessionUsage.tokens(undefined),
    estimatedCost: assistant?.cost ?? Money.USD.zero,
    contextLimit: assistant?.diagnostics?.contextLimit,
    contextBreakdown: assistant?.diagnostics?.contextBreakdown,
    providerCache: assistant?.diagnostics?.providerCache,
    generationSpeed: generationSpeed(
      records.map((record) => ({ model: record.model, timing: record.timing ?? undefined })),
      { model },
    ),
  })
})

export function fromMessages(
  messages: ReadonlyArray<SessionMessage.Info>,
  boundary?: SessionMessage.ID,
): Session.CacheDiagnostics | undefined {
  const last = latestAssistant(messages, boundary)
  if (!last) return undefined
  return calculate({
    model: last.model,
    tokens: last.tokens ?? SessionUsage.tokens(undefined),
    estimatedCost: last.cost ?? Money.USD.zero,
    contextLimit: last.diagnostics?.contextLimit,
    contextBreakdown: last.diagnostics?.contextBreakdown,
    providerCache: last.diagnostics?.providerCache,
  })
}
