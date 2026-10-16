export * as ModelIncident from "./index"

import type { Agent } from "@ycoding-ai/schema/agent"
import type { Model } from "@ycoding-ai/schema/model"
import { ModelIncident } from "@ycoding-ai/schema/model-incident"
import type { Provider } from "@ycoding-ai/schema/provider"
import { Clock, Context, Duration, Effect, Layer, Schedule, Schema } from "effect"
import { and, desc, eq, sql, type SQL } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { RetentionSettings } from "../retention-settings"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import { ModelGuidanceInstructions } from "./instructions"
import { ModelGuidanceClearTable, ModelIncidentTable } from "./sql"

type Db = Pick<Database.Interface["db"], "get" | "all" | "run">

export const SLICE_ROWS = 10_000
export const BATCH_ROWS = 1_000
export const REPORT_LIMIT = 200
export const RECENT_LIMIT = 50

const rulePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/
const categoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("ModelIncident.InvalidInputError", {
  message: Schema.String,
}) {}

export interface FallbackInput {
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly from: Model.Ref
  readonly to: Model.Ref
  readonly category: string
  readonly time: number
}

export interface GuardrailInput {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly messageID?: SessionMessage.ID
  readonly ruleIDs: ReadonlyArray<string>
  readonly hardReview: boolean
  readonly time: number
}

export interface RejectionInput extends GuardrailInput {
  readonly decidedBy: ModelIncident.DecidedBy
}

interface Attribution {
  readonly agent: Agent.ID
  readonly providerID: Provider.ID
  readonly modelID: Model.ID
  readonly variant: Model.VariantID | null
  readonly profile: Model.ProfileName | null
  readonly projectID: string
}

export const recordFallback = Effect.fn("ModelIncident.recordFallback")(function* (db: Db, input: FallbackInput) {
  const session = yield* db
    .get<{ projectID: string }>(sql`SELECT project_id AS projectID FROM session WHERE id = ${input.sessionID}`)
    .pipe(Effect.orDie)
  if (!session) return
  yield* insert(db, {
    kind: "fallback",
    time: input.time,
    attribution: {
      agent: input.agent,
      providerID: input.from.providerID,
      modelID: input.from.id,
      variant: input.from.variant ?? null,
      profile: input.from.profile ?? null,
      projectID: session.projectID,
    },
    sessionID: input.sessionID,
    requestID: null,
    category: categoryPattern.test(input.category) ? input.category : "unknown",
    ruleIDs: [],
    target: input.to,
    decidedBy: null,
  })
})

export const recordEscalation = Effect.fn("ModelIncident.recordEscalation")(function* (db: Db, input: GuardrailInput) {
  if (input.messageID === undefined) return
  const attribution = yield* assistant(db, input.sessionID, input.messageID)
  if (!attribution) return
  yield* guardrail(db, "guardrail-escalated", input, attribution, null)
})

export const recordRejection = Effect.fn("ModelIncident.recordRejection")(function* (db: Db, input: RejectionInput) {
  const attribution =
    (input.messageID === undefined ? undefined : yield* assistant(db, input.sessionID, input.messageID)) ??
    (yield* escalation(db, input.sessionID, input.requestID))
  if (!attribution) return
  yield* guardrail(db, "guardrail-rejected", input, attribution, input.decidedBy)
})

const guardrail = Effect.fnUntraced(function* (
  db: Db,
  kind: ModelIncident.Kind,
  input: GuardrailInput,
  attribution: Attribution,
  decidedBy: ModelIncident.DecidedBy | null,
) {
  const existing = yield* db
    .get<{ id: string }>(
      sql`SELECT id FROM model_incident WHERE request_id = ${input.requestID} AND kind = ${kind} AND session_id = ${input.sessionID} LIMIT 1`,
    )
    .pipe(Effect.orDie)
  if (existing) return
  yield* insert(db, {
    kind,
    time: input.time,
    attribution,
    sessionID: input.sessionID,
    requestID: input.requestID,
    category: input.hardReview ? "hard" : "ordinary",
    ruleIDs: sanitizeRules(input.ruleIDs),
    target: null,
    decidedBy,
  })
})

const assistant = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID, messageID: SessionMessage.ID) {
  const row = yield* db
    .get<{
      agent: Agent.ID | null
      providerID: Provider.ID | null
      modelID: Model.ID | null
      variant: Model.VariantID | null
      profile: Model.ProfileName | null
      projectID: string
    }>(
      sql`
    SELECT json_extract(m.data, '$.agent') AS agent, json_extract(m.data, '$.model.providerID') AS providerID,
      json_extract(m.data, '$.model.id') AS modelID, json_extract(m.data, '$.model.variant') AS variant,
      json_extract(m.data, '$.model.profile') AS profile, s.project_id AS projectID
    FROM session_message AS m JOIN session AS s ON s.id = m.session_id
    WHERE m.session_id = ${sessionID} AND m.id = ${messageID} AND m.type = 'assistant'
  `,
    )
    .pipe(Effect.orDie)
  if (!row?.agent || !row.providerID || !row.modelID) return undefined
  return {
    agent: row.agent,
    providerID: row.providerID,
    modelID: row.modelID,
    variant: row.variant,
    profile: row.profile,
    projectID: row.projectID,
  } satisfies Attribution
})

const escalation = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID, requestID: string) {
  const row = yield* db
    .get<{
      agent: Agent.ID
      providerID: Provider.ID
      modelID: Model.ID
      variant: Model.VariantID | null
      profile: Model.ProfileName | null
      projectID: string
    }>(
      sql`
    SELECT agent, provider_id AS providerID, model_id AS modelID, variant, profile, project_id AS projectID
    FROM model_incident INDEXED BY model_incident_request_id_idx
    WHERE request_id = ${requestID} AND session_id = ${sessionID} AND kind = 'guardrail-escalated'
    ORDER BY id LIMIT 1
  `,
    )
    .pipe(Effect.orDie)
  return row satisfies Attribution | undefined
})

const insert = Effect.fnUntraced(function* (
  db: Db,
  row: {
    readonly kind: ModelIncident.Kind
    readonly time: number
    readonly attribution: Attribution
    readonly sessionID: string
    readonly requestID: string | null
    readonly category: string
    readonly ruleIDs: ReadonlyArray<string>
    readonly target: Model.Ref | null
    readonly decidedBy: ModelIncident.DecidedBy | null
  },
) {
  yield* db
    .run(
      sql`
    INSERT INTO model_incident
      (id, time_created, kind, provider_id, model_id, variant, profile, agent, project_id, session_id, request_id, category, rule_ids, target, decided_by)
    VALUES (${ModelIncident.ID.create()}, ${row.time}, ${row.kind}, ${row.attribution.providerID}, ${row.attribution.modelID},
      ${row.attribution.variant}, ${row.attribution.profile}, ${row.attribution.agent}, ${row.attribution.projectID},
      ${row.sessionID}, ${row.requestID}, ${row.category}, ${JSON.stringify(row.ruleIDs)},
      ${row.target === null ? null : JSON.stringify(row.target)}, ${row.decidedBy})
  `,
    )
    .pipe(Effect.orDie)
})

function sanitizeRules(ruleIDs: ReadonlyArray<string>) {
  return [...new Set(ruleIDs.map((ruleID) => (rulePattern.test(ruleID) ? ruleID : "custom")))]
}

export interface ReportInput {
  readonly group: ModelIncident.Group
  readonly from?: number
  readonly to?: number
  readonly offset?: number
  readonly limit?: number
}

export interface RecentInput {
  readonly provider: Provider.ID
  readonly model: Model.ID
  readonly agent?: Agent.ID
  readonly limit?: number
}

export interface ModelQuery {
  readonly provider: Provider.ID
  readonly model: Model.ID
}

export interface Interface {
  readonly report: (input: ReportInput) => Effect.Effect<ModelIncident.Report, InvalidInputError>
  readonly recent: (input: RecentInput) => Effect.Effect<ModelIncident.Recent, InvalidInputError>
  readonly guidance: (input: ModelQuery, enabled: boolean) => Effect.Effect<ModelIncident.Guidance>
  readonly clear: (input: ModelQuery) => Effect.Effect<number>
  readonly cleanup: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ModelIncident") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const settings = yield* RetentionSettings.Service
    const reader = database.reader ?? database.db

    return Service.of({
      report: Effect.fn("ModelIncident.report")(function* (input) {
        const offset = input.offset ?? 0
        const limit = input.limit ?? REPORT_LIMIT
        const from = input.from ?? 0
        if (!Number.isSafeInteger(offset) || offset < 0)
          return yield* new InvalidInputError({ message: "Incident report offset must be a nonnegative integer" })
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPORT_LIMIT)
          return yield* new InvalidInputError({ message: `Incident report limit must be 1 to ${REPORT_LIMIT}` })
        if (
          !Number.isSafeInteger(from) ||
          from < 0 ||
          (input.to !== undefined && (!Number.isSafeInteger(input.to) || input.to < from))
        )
          return yield* new InvalidInputError({ message: "Incident report range must be ordered millisecond times" })
        const to = input.to === undefined ? sql`` : sql`AND time_created < ${input.to}`
        const groups = yield* reader.transaction(() =>
          Effect.gen(function* () {
            const groups = new Map<string, ModelIncident.ReportRow>()
            let after: { readonly time: number; readonly id: string } | undefined
            while (true) {
              const page = yield* reader
                .all<{
                  id: string
                  time: number
                  kind: ModelIncident.Kind
                  providerID: Provider.ID
                  modelID: Model.ID
                  agent: Agent.ID
                }>(
                  sql`
                SELECT id, time_created AS time, kind, provider_id AS providerID, model_id AS modelID, agent
                FROM model_incident INDEXED BY model_incident_time_created_id_idx
                WHERE ${after === undefined ? sql`time_created >= ${from}` : sql`(time_created, id) > (${after.time}, ${after.id})`} ${to}
                ORDER BY time_created, id LIMIT ${SLICE_ROWS}
              `,
                )
                .pipe(Effect.orDie)
              for (const row of page) {
                const agent = input.group === "agent" ? row.agent : undefined
                const key = JSON.stringify([row.providerID, row.modelID, agent])
                const current = groups.get(key)
                groups.set(key, {
                  providerID: row.providerID,
                  modelID: row.modelID,
                  ...(agent === undefined ? {} : { agent }),
                  fallbacks: (current?.fallbacks ?? 0) + (row.kind === "fallback" ? 1 : 0),
                  escalated: (current?.escalated ?? 0) + (row.kind === "guardrail-escalated" ? 1 : 0),
                  rejected: (current?.rejected ?? 0) + (row.kind === "guardrail-rejected" ? 1 : 0),
                  last: Math.max(current?.last ?? 0, row.time),
                })
              }
              yield* Effect.yieldNow
              if (page.length < SLICE_ROWS) return groups
              after = page.at(-1)
            }
          }),
        ).pipe(Effect.orDie)
        const rows = [...groups.values()].toSorted(
          (left, right) =>
            right.fallbacks +
              right.escalated +
              right.rejected -
              (left.fallbacks + left.escalated + left.rejected) ||
            right.last - left.last ||
            compare(left.providerID, right.providerID) ||
            compare(left.modelID, right.modelID) ||
            compare(left.agent ?? "", right.agent ?? ""),
        )
        return { rows: rows.slice(offset, offset + limit), groups: rows.length }
      }),

      recent: Effect.fn("ModelIncident.recent")(function* (input) {
        const limit = input.limit ?? 20
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECENT_LIMIT)
          return yield* new InvalidInputError({ message: `Recent incident limit must be 1 to ${RECENT_LIMIT}` })
        const filters: ReadonlyArray<SQL | undefined> = [
          eq(ModelIncidentTable.provider_id, input.provider),
          eq(ModelIncidentTable.model_id, input.model),
          input.agent === undefined ? undefined : eq(ModelIncidentTable.agent, input.agent),
        ]
        const rows = yield* reader
          .select()
          .from(ModelIncidentTable)
          .where(and(...filters))
          .orderBy(desc(ModelIncidentTable.time_created), desc(ModelIncidentTable.id))
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return {
          items: rows.map((row) => ({
            id: row.id,
            time: row.time_created,
            kind: row.kind,
            category: row.category,
            ruleIDs: row.rule_ids,
            agent: row.agent,
            ...(row.variant === null ? {} : { variant: row.variant }),
            ...(row.profile === null ? {} : { profile: row.profile }),
            ...(row.target === null ? {} : { target: row.target }),
            ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
          })),
        }
      }),

      guidance: Effect.fn("ModelIncident.guidance")(function* (input, enabled) {
        const model = { providerID: input.provider, id: input.model }
        const snapshot = yield* reader
          .transaction(() =>
            Effect.gen(function* () {
              const text = yield* ModelGuidanceInstructions.text(reader, model)
              const cleared = yield* reader
                .select({ clearedAt: ModelGuidanceClearTable.cleared_at })
                .from(ModelGuidanceClearTable)
                .where(
                  and(
                    eq(ModelGuidanceClearTable.provider_id, input.provider),
                    eq(ModelGuidanceClearTable.model_id, input.model),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              return { text, cleared }
            }),
          )
          .pipe(Effect.orDie)
        return {
          enabled,
          ...(snapshot.text === undefined ? {} : { text: snapshot.text }),
          ...(snapshot.cleared === undefined ? {} : { clearedAt: snapshot.cleared.clearedAt }),
        }
      }),

      clear: Effect.fn("ModelIncident.clear")(function* (input) {
        const now = yield* Clock.currentTimeMillis
        const stored = yield* database.db
          .get<{ clearedAt: number }>(
            sql`
          INSERT INTO model_guidance_clear (provider_id, model_id, cleared_at) VALUES (${input.provider}, ${input.model}, ${now})
          ON CONFLICT (provider_id, model_id) DO UPDATE SET cleared_at = max(cleared_at, excluded.cleared_at)
          RETURNING cleared_at AS clearedAt
        `,
          )
          .pipe(Effect.orDie)
        return stored?.clearedAt ?? now
      }),

      cleanup: Effect.fn("ModelIncident.cleanup")(function* (now) {
        const days = (yield* settings.read()).incidentDays
        const cutoff = (now ?? (yield* Clock.currentTimeMillis)) - Duration.toMillis(Duration.days(days))
        let deleted = 0
        while (true) {
          const rows = yield* database.db
            .all<{ id: string }>(
              sql`
            DELETE FROM model_incident WHERE id IN (
              SELECT id FROM model_incident INDEXED BY model_incident_time_created_id_idx
              WHERE time_created < ${cutoff}
              ORDER BY time_created, id LIMIT ${BATCH_ROWS}
            ) RETURNING id
          `,
            )
            .pipe(Effect.orDie)
          deleted += rows.length
          yield* Effect.yieldNow
          if (rows.length < BATCH_ROWS) return deleted
        }
      }),
    })
  }),
)

function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const incidents = yield* Service
    yield* incidents.cleanup()
    yield* incidents
      .cleanup()
      .pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.delay(Duration.hours(1)), Effect.forkScoped)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [Database.node, RetentionSettings.node],
})
