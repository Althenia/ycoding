import { asc, eq, inArray, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { SessionSchema } from "./schema"
import type { Location } from "@ycoding-ai/schema/location"
import type { Provider } from "@ycoding-ai/schema/provider"
import type { Model } from "@ycoding-ai/schema/model"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import { SessionProviderRequestTable, SessionTable } from "./sql"
import { UsageAnalyticsRequestTable } from "../usage-analytics.sql"
import { SessionUsageAttribution } from "./usage-attribution"

export type Aggregate = {
  key: string
  sessionID: string
  title: string
  projectID: string
  model: string
  agent: string
  time: number
  logical: number
  physical: number
  helpers: number
  continued: number
  fallback: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  priced: number
  cacheReadReported: number
  currentCatalog?: number
}

export type PricingRef = {
  key: string
  directory: string
  workspaceID: string | null
  provider: string
  model: string
  profile: string | null
}

export const pricingRefs = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  after?: string,
  sessionID?: SessionSchema.ID,
  range?: Range,
) {
  const page = yield* pricingBoundary(db, after, sliceRows, sessionID, range)
  const selected = source(sessionID !== undefined)
  const key = sql`json_array(${selected.directory}, ${selected.workspaceID}, json_extract(r.model, '$.providerID'), json_extract(r.model, '$.id'), json_extract(r.model, '$.profile'))`
  const refs = yield* db
    .all<PricingRef>(
      sql`
    SELECT DISTINCT ${key} AS key, ${selected.directory} AS directory, ${selected.workspaceID} AS workspaceID,
      json_extract(r.model, '$.providerID') AS provider, json_extract(r.model, '$.id') AS model,
      json_extract(r.model, '$.profile') AS profile
    FROM ${selected.name} AS r INDEXED BY ${selected.unpricedIndex} ${selected.join}
    WHERE ${where} AND r.cost IS NULL AND r.source <> 'decision'
      ${sliceWhere(page.slice)}
  `,
    )
    .pipe(Effect.orDie)
  yield* Effect.yieldNow
  return { refs, after: page.after }
})

const aggregate = sql`count(*) AS logical, coalesce(sum(r.attempts), 0) AS physical, coalesce(sum(r.source <> 'step'), 0) AS helpers,
  coalesce(sum(r.continuation = 'continued'), 0) AS continued, coalesce(sum(r.continuation = 'fallback'), 0) AS fallback,
  coalesce(sum(json_extract(r.tokens, '$.input')), 0) AS input,
  coalesce(sum(json_extract(r.tokens, '$.output')), 0) AS output,
  coalesce(sum(json_extract(r.tokens, '$.reasoning')), 0) AS reasoning,
  coalesce(sum(json_extract(r.tokens, '$.cache.read')), 0) AS cacheRead,
  coalesce(sum(json_extract(r.tokens, '$.cache.write')), 0) AS cacheWrite,
  min(coalesce(r.cache_read_reported, 0)) AS cacheReadReported`

const rollup = sql`sum(logical) AS logical, sum(physical) AS physical, sum(helpers) AS helpers, sum(continued) AS continued,
  sum(fallback) AS fallback, sum(input) AS input, sum(output) AS output, sum(reasoning) AS reasoning,
  sum(cacheRead) AS cacheRead, sum(cacheWrite) AS cacheWrite, sum(cost) AS cost, sum(priced) AS priced,
  min(cacheReadReported) AS cacheReadReported`

export type ReportGroup = ProviderRequest.ReportGroup

export interface LocalUsageInput {
  readonly from: number
  readonly to: number
  readonly scope: { readonly type: "backend" } | { readonly type: "location"; readonly location: Location.Ref }
}

export interface LocalUsageBin {
  readonly providerID: Provider.ID
  readonly profile?: string
  readonly modelID: Model.ID
  readonly start: number
  readonly requests: number
  readonly tokens: TokenUsage.Info
  readonly knownUSD?: number
  readonly pricedRequests: number
  readonly unpricedRequests: number
}

export const localUsage = (
  database: Database.Interface,
  input: LocalUsageInput,
): Effect.Effect<ReadonlyArray<LocalUsageBin>, Error> => {
  const db = database.reader ?? database.db
  return db.transaction(() =>
    Effect.gen(function* () {
      const groups = new Map<
        string,
        {
          providerID: Provider.ID
          profile: string | null
          modelID: Model.ID
          bins: Array<{
            start: number
            requests: number
            tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
            known: number
            pricedRequests: number
            unpricedRequests: number
          }>
        }
      >()
      yield* localRequests<{
        providerID: Provider.ID
        profile: string | null
        modelID: Model.ID
        directory: string
        workspaceID: string | null
        input: number
        output: number
        reasoning: number
        cacheRead: number
        cacheWrite: number
        cost: number | null
      }>(
        db,
        input,
        sql`
      json_extract(r.model, '$.providerID') AS providerID, json_extract(r.model, '$.profile') AS profile,
      json_extract(r.model, '$.id') AS modelID, r.directory, r.workspace_id AS workspaceID,
      json_extract(r.tokens, '$.input') AS input, json_extract(r.tokens, '$.output') AS output,
      json_extract(r.tokens, '$.reasoning') AS reasoning, json_extract(r.tokens, '$.cache.read') AS cacheRead,
      json_extract(r.tokens, '$.cache.write') AS cacheWrite, r.cost
    `,
        (row) => {
          if (
            input.scope.type === "location" &&
            (row.directory !== input.scope.location.directory ||
              row.workspaceID !== (input.scope.location.workspaceID ?? null))
          )
            return
          const key = JSON.stringify([row.providerID, row.profile, row.modelID])
          const group = groups.get(key) ?? {
            providerID: row.providerID,
            profile: row.profile,
            modelID: row.modelID,
            bins: Array.from({ length: Math.ceil((input.to - input.from) / 300_000) }, (_, index) => ({
              start: input.from + index * 300_000,
              requests: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              known: 0,
              pricedRequests: 0,
              unpricedRequests: 0,
            })),
          }
          groups.set(key, group)
          const bin = group.bins[Math.floor((row.time - input.from) / 300_000)]!
          bin.requests += 1
          bin.tokens.input += row.input
          bin.tokens.output += row.output
          bin.tokens.reasoning += row.reasoning
          bin.tokens.cache.read += row.cacheRead
          bin.tokens.cache.write += row.cacheWrite
          if (row.cost !== null && Number.isFinite(row.cost) && row.cost >= 0) {
            bin.known += row.cost
            bin.pricedRequests += 1
            return
          }
          bin.unpricedRequests += 1
        },
      )
      return [...groups]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .flatMap(([, group]) =>
          group.bins.map((bin) => ({
            providerID: group.providerID,
            ...(group.profile === null ? {} : { profile: group.profile }),
            modelID: group.modelID,
            start: bin.start,
            requests: bin.requests,
            tokens: bin.tokens,
            ...(bin.pricedRequests === 0 ? {} : { knownUSD: bin.known }),
            pricedRequests: bin.pricedRequests,
            unpricedRequests: bin.unpricedRequests,
          })),
        )
    }),
  )
}

export interface LocalSpendInput {
  readonly dayStart: number
  readonly dayEnd: number
}

export interface LocalSpend {
  readonly providerID: Provider.ID
  readonly knownUSD?: number
  readonly pricedRequests: number
  readonly unpricedRequests: number
}

export const localSpend = (
  database: Database.Interface,
  input: LocalSpendInput,
): Effect.Effect<ReadonlyArray<LocalSpend>, Error> => {
  const db = database.reader ?? database.db
  return db.transaction(() =>
    Effect.gen(function* () {
      const groups = new Map<Provider.ID, { known: number; pricedRequests: number; unpricedRequests: number }>()
      yield* localRequests<{ providerID: Provider.ID; cost: number | null }>(
        db,
        { from: input.dayStart, to: input.dayEnd },
        sql`json_extract(r.model, '$.providerID') AS providerID, r.cost`,
        (row) => {
          const group = groups.get(row.providerID) ?? { known: 0, pricedRequests: 0, unpricedRequests: 0 }
          groups.set(row.providerID, group)
          if (row.cost !== null && Number.isFinite(row.cost) && row.cost >= 0) {
            group.known += row.cost
            group.pricedRequests += 1
            return
          }
          group.unpricedRequests += 1
        },
      )
      return [...groups]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([providerID, group]) => ({
          providerID,
          ...(group.pricedRequests === 0 ? {} : { knownUSD: group.known }),
          pricedRequests: group.pricedRequests,
          unpricedRequests: group.unpricedRequests,
        }))
    }),
  )
}

const localRequests = Effect.fnUntraced(function* <A>(
  db: Db,
  range: { readonly from: number; readonly to: number },
  fields: SQL,
  consume: (row: A & Cursor) => void,
) {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from >= range.to)
    return yield* Effect.fail(new Error("Local usage requires an ordered finite millisecond range"))
  let after: Cursor | undefined
  while (true) {
    const page = yield* db.all<A & Cursor>(sql`
      SELECT r.time_created AS time, r.id, ${fields}
      FROM ${source(false).name} AS r INDEXED BY ${source(false).index}
      WHERE ${after === undefined ? sql`r.time_created >= ${range.from}` : sql`(r.time_created, r.id) > (${after.time}, ${after.id})`}
        AND r.time_created < ${range.to}
      ORDER BY r.time_created, r.id LIMIT ${sliceRows}
    `)
    page.forEach(consume)
    yield* Effect.yieldNow
    if (page.length < sliceRows) return
    after = page.at(-1)!
  }
})

export type ReportRow = Aggregate & { speed?: ProviderRequest.Speed }

export type Fact = {
  record: Pick<
    typeof SessionProviderRequestTable.$inferSelect,
    | "id"
    | "session_id"
    | "input_id"
    | "usage_anchor"
    | "request"
    | "source"
    | "model"
    | "agent"
    | "tokens"
    | "cost"
    | "time_created"
  >
  sessionID: SessionSchema.ID
  projectID: string
  directory: string
  workspaceID: string | null
}

export const each = Effect.fnUntraced(function* (
  db: Db,
  sessions: ReadonlyArray<SessionSchema.ID>,
  consume: (row: Fact) => Effect.Effect<void>,
) {
  for (const sessionID of sessions) {
    let after = 0
    while (true) {
      const request = alias(SessionProviderRequestTable, "r")
      const session = alias(SessionTable, "s")
      const rows = yield* db
        .select({
          record: {
            id: request.id,
            session_id: request.session_id,
            input_id: request.input_id,
            usage_anchor: request.usage_anchor,
            request: request.request,
            source: request.source,
            model: request.model,
            agent: request.agent,
            tokens: request.tokens,
            cost: request.cost,
            time_created: request.time_created,
          },
          sessionID: request.session_id,
          projectID: session.project_id,
          directory: session.directory,
          workspaceID: session.workspace_id,
        })
        .from(request)
        .innerJoin(session, eq(session.id, request.session_id))
        .where(sql`${request.session_id} = ${sessionID} AND ${request.request} > ${after}`)
        .orderBy(asc(request.request))
        .limit(sliceRows)
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) yield* consume(row)
      yield* Effect.yieldNow
      if (rows.length < sliceRows) break
      after = rows.at(-1)!.record.request
    }
    yield* Effect.yieldNow
  }
})

type Db = Database.Interface["db"]

type Cursor = { readonly time: number; readonly id: string }
const source = (sessionScoped: boolean) => ({
  table: sessionScoped ? SessionProviderRequestTable : UsageAnalyticsRequestTable,
  name: sql.raw(sessionScoped ? "session_provider_request" : "usage_analytics_request"),
  index: sql.raw(
    sessionScoped ? "session_provider_request_session_request_idx" : "usage_analytics_request_time_created_id_idx",
  ),
  scanIndex: sql.raw(
    sessionScoped ? "session_provider_request_session_request_idx" : "usage_analytics_request_metrics_idx",
  ),
  unpricedIndex: sql.raw(
    sessionScoped
      ? "session_provider_request_session_request_idx"
      : "usage_analytics_request_unpriced_time_created_id_idx",
  ),
  join: sessionScoped ? sql`JOIN session AS s ON s.id = r.session_id` : sql``,
  sessionID: sql<SessionSchema.ID>`r.session_id`,
  title: sessionScoped ? sql<string>`s.title` : sql<string>`r.session_id`,
  projectID: sessionScoped ? sql<string>`s.project_id` : sql<string>`r.project_id`,
  directory: sessionScoped ? sql<string>`s.directory` : sql<string>`r.directory`,
  workspaceID: sessionScoped ? sql<string | null>`s.workspace_id` : sql<string | null>`r.workspace_id`,
  updated: sessionScoped ? sql<number>`s.time_updated` : sql<number>`r.session_updated`,
  taskPath: sessionScoped
    ? sql<string>`(WITH RECURSIVE path(id, parent_id, task_id) AS (
    SELECT session.id, session.parent_id, task.session_id FROM session
    LEFT JOIN session_task AS task ON task.session_id = session.id WHERE session.id = r.session_id
    UNION SELECT session.id, session.parent_id, task.session_id FROM session
    JOIN path ON session.id = path.parent_id LEFT JOIN session_task AS task ON task.session_id = session.id
  ) SELECT json_group_array(task_id) FROM path WHERE task_id IS NOT NULL)`
    : sql<string>`r.task_path`,
})
type Range = { readonly from?: number | undefined; readonly to?: number | undefined }
type Slice =
  | ({ readonly sessionID?: undefined; readonly after?: Cursor; readonly before?: Cursor } & Range)
  | { readonly sessionID: SessionSchema.ID; readonly after?: number; readonly before?: number }

const sliceRows = 10_000

const metricRows = 500

const sliceWhere = (slice: Slice) => {
  if (slice.sessionID !== undefined)
    return sql`AND r.session_id = ${slice.sessionID}
    ${slice.after === undefined ? sql`` : sql`AND r.request > ${slice.after}`}
    ${slice.before === undefined ? sql`` : sql`AND r.request <= ${slice.before}`}`
  return sql`${
    slice.after !== undefined
      ? sql`AND (r.time_created, r.id) > (${slice.after.time}, ${slice.after.id})`
      : slice.from === undefined
        ? sql``
        : sql`AND (r.time_created, r.id) >= (${slice.from}, '')`
  }
    ${
      slice.before !== undefined
        ? sql`AND (r.time_created, r.id) <= (${slice.before.time}, ${slice.before.id})`
        : slice.to === undefined
          ? sql``
          : sql`AND (r.time_created, r.id) < (${slice.to}, '')`
    }`
}

const sliceIndex = (slice: Slice) => source(slice.sessionID !== undefined).index

const sliceScanIndex = (slice: Slice) => source(slice.sessionID !== undefined).scanIndex

const slices = Effect.fnUntraced(function* (db: Db, sessions?: ReadonlyArray<SessionSchema.ID>, range: Range = {}) {
  if (sessions !== undefined) {
    const ranges: Slice[] = []
    for (const sessionID of sessions) {
      let after: number | undefined
      while (true) {
        const next = yield* db
          .get<{ request: number }>(
            sql`
          SELECT r.request FROM session_provider_request AS r INDEXED BY session_provider_request_session_request_idx
          WHERE r.session_id = ${sessionID} ${after === undefined ? sql`` : sql`AND r.request > ${after}`}
          ORDER BY r.request LIMIT 1 OFFSET ${sliceRows - 1}
        `,
          )
          .pipe(Effect.orDie)
        ranges.push({ sessionID, after, before: next?.request })
        yield* Effect.yieldNow
        if (!next) break
        after = next.request
      }
    }
    return ranges
  }
  const bounds: Cursor[] = []
  while (true) {
    const next = yield* db
      .get<Cursor>(
        sql`
      SELECT r.time_created AS time, r.id FROM ${source(false).name} AS r INDEXED BY ${source(false).index}
      WHERE 1 ${sliceWhere({ after: bounds.at(-1), ...range })}
      ORDER BY r.time_created, r.id LIMIT 1 OFFSET ${sliceRows - 1}
    `,
      )
      .pipe(Effect.orDie)
    if (!next) break
    bounds.push(next)
    yield* Effect.yieldNow
  }
  return [undefined, ...bounds].map((after, index): Slice => ({ after, before: bounds[index], ...range }))
})

const stage = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  raw: SQL,
  sessions?: ReadonlyArray<SessionSchema.ID>,
  group: ReportGroup = "model",
  range?: Range,
) {
  const attribution = group === "prompt"
  yield* db.run(sql`DROP TABLE IF EXISTS temp.usage_partial`).pipe(Effect.orDie)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_partial (raw TEXT, sessionID TEXT, title TEXT, projectID TEXT,
        model TEXT, agent TEXT, time INTEGER, logical INTEGER, physical INTEGER, helpers INTEGER, continued INTEGER,
        fallback INTEGER, input INTEGER, output INTEGER, reasoning INTEGER, cacheRead INTEGER, cacheWrite INTEGER,
        cacheReadReported INTEGER, cost REAL, priced INTEGER)`,
    )
    .pipe(Effect.orDie)
  const ranges = yield* slices(db, sessions, range)
  if (attribution && sessions) {
    yield* db.run(sql`CREATE TEMP TABLE usage_anchor_hint (id TEXT PRIMARY KEY, anchor TEXT)`).pipe(Effect.orDie)
    yield* each(db, sessions, (row) =>
      Effect.gen(function* () {
        if (row.record.usage_anchor !== null || row.record.input_id === null) return
        const anchor = yield* SessionUsageAttribution.resolve(db, {
          sessionID: row.sessionID,
          inputID: row.record.input_id,
        })
        if (anchor)
          yield* db
            .run(sql`INSERT INTO temp.usage_anchor_hint VALUES (${row.record.id}, ${JSON.stringify(anchor)})`)
            .pipe(Effect.orDie)
      }),
    )
  }
  for (const slice of ranges) {
    const selected = source(slice.sessionID !== undefined)
    yield* db
      .run(
        sql`
      INSERT INTO temp.usage_partial
      SELECT ${raw}, ${selected.sessionID}, ${selected.title}, ${selected.projectID}, ${group === "model" ? sql`NULL` : sql`r.model`}, r.agent, r.time_created,
        ${aggregate}, coalesce(sum(r.cost), 0), count(r.cost)
      FROM ${selected.name} AS r INDEXED BY ${sliceScanIndex(slice)} ${selected.join}
      ${attribution && sessions ? sql`LEFT JOIN temp.usage_anchor_hint AS h ON h.id = r.id` : sql``}
      WHERE ${where} ${sliceWhere(slice)} GROUP BY 1
    `,
      )
      .pipe(Effect.orDie)
    yield* Effect.yieldNow
  }
  return ranges
})

const release = (db: Db, table: string) => db.run(sql.raw(`DROP TABLE IF EXISTS temp.${table}`)).pipe(Effect.orDie)

export const models = Effect.fn("SessionUsageRead.models")(
  function* (db: Db, where: SQL, sessions?: ReadonlyArray<SessionSchema.ID>) {
    yield* stage(db, where, sql`r.model`, sessions)
    const result: Aggregate[] = []
    while (true) {
      const page = yield* db
        .all<Aggregate>(
          sql`
    WITH keyed AS MATERIALIZED (
      SELECT CAST(json_array(json_extract(raw, '$.providerID'), json_extract(raw, '$.id'), json_extract(raw, '$.variant'),
          json_extract(raw, '$.profile')) AS TEXT) AS key,
        sessionID, title, projectID, raw AS model, agent, time, ${rollup}
      FROM temp.usage_partial GROUP BY key
    )
    SELECT * FROM keyed ${result.length === 0 ? sql`` : sql`WHERE key > ${result.at(-1)!.key}`} ORDER BY key ASC LIMIT 200
  `,
        )
        .pipe(Effect.orDie)
      result.push(...page)
      if (page.length < 200) return result
      yield* Effect.yieldNow
    }
  },
  (effect, db) => Effect.ensuring(effect, release(db, "usage_partial")),
)

type ReportInput = {
  where: SQL
  group: ReportGroup
  from?: number
  to?: number
  timeZone?: string
  order: SQL
  offset: number
  limit: number
  corrections: Readonly<Record<string, { readonly cost: number; readonly requests: number }>>
  sessions?: ReadonlyArray<SessionSchema.ID>
}

function encode(value: SQL) {
  return sql`(WITH RECURSIVE encoded(remaining, value) AS (
    SELECT coalesce(${value}, ''), ''
    UNION ALL SELECT substr(remaining, 2), value || CASE
      WHEN instr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*''()', substr(remaining, 1, 1)) > 0 THEN substr(remaining, 1, 1)
      ELSE '%' || substr(hex(substr(remaining, 1, 1)), 1, 2)
        || CASE WHEN length(hex(substr(remaining, 1, 1))) > 2 THEN '%' || substr(hex(substr(remaining, 1, 1)), 3, 2) ELSE '' END
        || CASE WHEN length(hex(substr(remaining, 1, 1))) > 4 THEN '%' || substr(hex(substr(remaining, 1, 1)), 5, 2) ELSE '' END
        || CASE WHEN length(hex(substr(remaining, 1, 1))) > 6 THEN '%' || substr(hex(substr(remaining, 1, 1)), 7, 2) ELSE '' END END
    FROM encoded WHERE remaining <> '') SELECT value FROM encoded WHERE remaining = '')`
}

const dayMs = 86_400_000

export function timeZoneOffsets(timeZone: string, first: number, last: number) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
  const label = (time: number) =>
    formatter
      .formatToParts(time)
      .find((part) => part.type === "timeZoneName")!
      .value.replace("GMT", "") || "+00:00"
  const offset = (start: number, text: string) => {
    const parts = text.slice(1).split(":").map(Number)
    return {
      start,
      label: text,
      seconds: (text.startsWith("-") ? -1 : 1) * (parts[0] * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)),
    }
  }
  const offsets = [offset(first, label(first))]
  let start = first
  while (start < last) {
    const end = Math.min(start + dayMs, last)
    if (label(end) === offsets.at(-1)!.label) {
      start = end
      continue
    }
    let before = start
    let after = end
    while (after - before > 1) {
      const middle = before + Math.floor((after - before) / 2)
      if (label(middle) === offsets.at(-1)!.label) before = middle
      else after = middle
    }
    offsets.push(offset(after, label(after)))
    start = after
  }
  return offsets
}

const groupKey = Effect.fnUntraced(function* (
  db: Db,
  group: ReportGroup,
  range: { from?: number; to?: number },
  timeZone?: string,
  sessions?: ReadonlyArray<SessionSchema.ID>,
) {
  if (group === "model") {
    const field = (name: string) => sql.raw(`json_extract(raw, '$.${name}')`)
    return {
      raw: sql`r.model`,
      key: sql`${encode(field("providerID"))} || '/' || ${encode(field("id"))}
    || CASE WHEN ${field("variant")} IS NULL THEN '' ELSE '/' || ${encode(field("variant"))} END
    || CASE WHEN ${field("profile")} IS NULL THEN '' ELSE '/' || ${encode(field("profile"))} END`,
    }
  }
  const provider = sql`json_extract(r.model, '$.providerID')`
  const model = sql`json_extract(r.model, '$.id')`
  const profile = sql`json_extract(r.model, '$.profile')`
  if (group === "provider") return { raw: sql`json_array('provider', ${provider})`, key: sql`raw` }
  if (group === "provider-profile-model")
    return { raw: sql`json_array('provider-profile-model', ${provider}, ${profile}, ${model})`, key: sql`raw` }
  if (group === "provider-model")
    return { raw: sql`json_array('provider-model', ${provider}, ${model})`, key: sql`raw` }
  if (group === "model-id") return { raw: sql`json_array('model-id', ${model})`, key: sql`raw` }
  if (group === "profile") return { raw: sql`json_array('profile', ${provider}, ${profile})`, key: sql`raw` }
  if (group === "prompt") {
    const anchor = sessions ? sql`coalesce(r.usage_anchor, h.anchor)` : sql`r.usage_anchor`
    return {
      raw: sql`json_array('prompt', json_extract(${anchor}, '$.sessionID'), json_extract(${anchor}, '$.inputID'))`,
      key: sql`raw`,
    }
  }
  if (group === "task")
    return { raw: source(sessions !== undefined).taskPath, key: sql`json_array('task', task.value)` }
  if (group === "session") return { raw: source(sessions !== undefined).sessionID, key: sql`raw` }
  if (group === "project") return { raw: source(sessions !== undefined).projectID, key: sql`raw` }
  if (group === "agent") return { raw: sql`r.agent`, key: sql`raw` }
  const format = group === "hour" ? "%Y-%m-%dT%H:00:00" : group === "day" ? "%Y-%m-%d" : "%Y-%m"
  if (!timeZone)
    return {
      raw: sql`strftime(${format + (group === "hour" ? ".000Z" : "")}, r.time_created / 1000.0, 'unixepoch')`,
      key: sql`raw`,
    }
  const endpoint = (order: SQL) =>
    db
      .get<{ time: number }>(
        sql`
    SELECT r.time_created AS time FROM ${source(sessions !== undefined).name} AS r
    WHERE 1 ${range.from === undefined ? sql`` : sql`AND r.time_created >= ${range.from}`}
      ${range.to === undefined ? sql`` : sql`AND r.time_created < ${range.to}`}
    ORDER BY r.time_created ${order} LIMIT 1`,
      )
      .pipe(Effect.orDie)
  const first = yield* endpoint(sql`ASC`)
  const last = yield* endpoint(sql`DESC`)
  const offsets = !first || !last ? [] : timeZoneOffsets(timeZone, first.time, last.time)
  const seconds =
    offsets.length === 0
      ? sql`0`
      : sql`CASE ${sql.join(
          offsets.toReversed().map((offset) => sql`WHEN r.time_created >= ${offset.start} THEN ${offset.seconds}`),
          sql` `,
        )} ELSE 0 END`
  const label =
    offsets.length === 0
      ? sql`'+00:00'`
      : sql`CASE ${sql.join(
          offsets.toReversed().map((offset) => sql`WHEN r.time_created >= ${offset.start} THEN ${offset.label}`),
          sql` `,
        )} ELSE '+00:00' END`
  return {
    raw: sql`strftime(${format}, r.time_created / 1000.0 + (${seconds}), 'unixepoch') ${group === "hour" ? sql`|| (${label})` : sql``}`,
    key: sql`raw`,
  }
})

type ReportSqlRow = Aggregate & { kind: number; raws: string | null; rowCount: number | null }

export const report = Effect.fn("SessionUsageRead.report")(
  function* (db: Db, input: ReportInput) {
    const key = yield* groupKey(db, input.group, input, input.timeZone, input.sessions)
    const ranges = yield* stage(db, input.where, key.raw, input.sessions, input.group, {
      from: input.from,
      to: input.to,
    })
    const result = yield* db
      .all<ReportSqlRow>(
        sql`
  WITH keyed AS MATERIALIZED (
    SELECT CAST(${key.key} AS TEXT) AS key, sessionID, title, projectID, ${input.group === "model" ? sql`raw` : sql`model`} AS model, agent, time,
      ${rollup}, json_group_array(DISTINCT raw) AS raws
    FROM temp.usage_partial ${input.group === "task" ? sql`LEFT JOIN json_each(raw) AS task` : sql``} GROUP BY 1
  )
  SELECT 0 AS kind, page.* FROM (
    SELECT k.key, k.sessionID, k.title, k.projectID, k.model, k.agent, k.time,
      k.logical, k.physical, k.helpers, k.continued, k.fallback, k.input, k.output, k.reasoning, k.cacheRead, k.cacheWrite,
      k.cost + coalesce(json_extract(c.correction, '$.cost'), 0) AS cost, k.priced + coalesce(json_extract(c.correction, '$.requests'), 0) AS priced, k.cacheReadReported,
      (c.correction IS NOT NULL) AS currentCatalog, k.raws, NULL AS rowCount
    FROM keyed AS k
    LEFT JOIN (SELECT key AS correctionKey, value AS correction FROM json_each(${JSON.stringify(input.corrections)})) AS c
      ON c.correctionKey = k.key
    ORDER BY ${input.order} LIMIT ${input.limit} OFFSET ${input.offset}
  ) AS page
  UNION ALL
  SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    coalesce(sum(logical), 0), coalesce(sum(physical), 0), coalesce(sum(helpers), 0), coalesce(sum(continued), 0),
    coalesce(sum(fallback), 0), coalesce(sum(input), 0), coalesce(sum(output), 0), coalesce(sum(reasoning), 0),
    coalesce(sum(cacheRead), 0), coalesce(sum(cacheWrite), 0), coalesce(sum(cost), 0), coalesce(sum(priced), 0),
    min(cacheReadReported), 0, NULL, (SELECT count(*) FROM keyed)
  FROM temp.usage_partial
`,
      )
      .pipe(Effect.orDie)
    yield* release(db, "usage_partial")
    const total = result.find((row) => row.kind === 1)!
    const page = result.filter((row) => row.kind === 0)
    const observations = yield* speed(db, input.where, input.group, key, page, ranges, input.sessions)
    const models =
      input.group === "model"
        ? yield* ambiguousModels(db, input.where, page, ranges, input.sessions)
        : new Map<string, string>()
    return {
      rows: page.map((row): ReportRow => ({
        ...row,
        ...(models.has(row.key) ? { model: models.get(row.key)! } : {}),
        ...observations.get(row.key),
      })),
      total,
      rowCount: total.rowCount!,
    }
  },
  (effect, db) =>
    Effect.ensuring(
      effect,
      Effect.all([
        release(db, "usage_partial"),
        release(db, "usage_slot"),
        release(db, "usage_sample"),
        release(db, "usage_metric"),
        release(db, "usage_anchor_hint"),
      ]),
    ),
)

const decodeRaws = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const speed = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  group: ReportGroup,
  key: { readonly raw: SQL },
  page: ReadonlyArray<ReportSqlRow>,
  ranges: ReadonlyArray<Slice>,
  sessions?: ReadonlyArray<SessionSchema.ID>,
) {
  const observations = new Map<string, { speed: ProviderRequest.Speed }>()
  if (page.length === 0) return observations
  const pairs = JSON.stringify(
    page.flatMap((item, slot) =>
      group === "model" || group === "task" ? decodeRaws(item.raws!).map((raw) => [raw, slot]) : [[item.key, slot]],
    ),
  )
  yield* db
    .run(sql`CREATE TEMP TABLE usage_slot (raw TEXT, slot INTEGER, PRIMARY KEY(raw, slot)) WITHOUT ROWID`)
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`INSERT INTO temp.usage_slot SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${pairs})`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(sql`CREATE TEMP TABLE usage_sample (slot INTEGER, first, total, tokens, duration, providerTimed INTEGER,
      valid INTEGER GENERATED ALWAYS AS (duration > 0 AND duration <= 9007199254740991 AND CAST(duration AS INTEGER) = duration
        AND tokens > 0 AND tokens <= 9007199254740991 AND CAST(tokens AS INTEGER) = tokens) STORED)`)
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_metric (slot INTEGER, metric INTEGER, value, count INTEGER NOT NULL, PRIMARY KEY(slot, metric, value)) WITHOUT ROWID`,
    )
    .pipe(Effect.orDie)
  type Stats = {
    slot: number
    first: number
    total: number
    tokens: number
    duration: number
    generationSamples: number
    providerTimedSamples: number
    observedSamples: number
  }
  const sampled = new Map<number, Stats>()
  for (const slice of ranges) {
    const selected = source(slice.sessionID !== undefined)
    yield* db.run(sql`DELETE FROM temp.usage_sample`).pipe(Effect.orDie)
    yield* db
      .run(
        sql`
      INSERT INTO temp.usage_sample (slot, first, total, tokens, duration, providerTimed)
      SELECT usage_slot.slot,
        json_extract(r.timing, '$.firstOutputMs'), json_extract(r.timing, '$.totalMs'), json_extract(r.timing, '$.generatedTokens'),
        CASE WHEN json_type(r.timing, '$.generationDurationNs') IS NOT NULL THEN json_extract(r.timing, '$.generationDurationNs')
          WHEN json_extract(r.timing, '$.observedGenerationDurationNs') >= 1000000000 THEN json_extract(r.timing, '$.observedGenerationDurationNs') END,
        json_type(r.timing, '$.generationDurationNs') IS NOT NULL
      FROM ${selected.name} AS r INDEXED BY ${sliceScanIndex(slice)} ${selected.join}
      ${group === "prompt" && sessions ? sql`LEFT JOIN temp.usage_anchor_hint AS h ON h.id = r.id` : sql``}
      JOIN temp.usage_slot ON usage_slot.raw = ${group === "model" ? sql`r.model` : key.raw}
      WHERE ${where} ${sliceWhere(slice)}
    `,
      )
      .pipe(Effect.orDie)
    yield* Effect.yieldNow
    const rows = yield* db
      .all<Stats>(
        sql`
      SELECT slot, count(first) AS first, count(total) AS total, count(CASE WHEN valid THEN 1 END) AS generationSamples,
        count(CASE WHEN valid AND providerTimed THEN 1 END) AS providerTimedSamples,
        count(CASE WHEN valid AND NOT providerTimed THEN 1 END) AS observedSamples,
        total(CASE WHEN valid THEN tokens END) AS tokens,
        total(CASE WHEN valid THEN duration END) AS duration
      FROM temp.usage_sample GROUP BY slot
    `,
      )
      .pipe(Effect.orDie)
    yield* Effect.yieldNow
    for (const [metric, value, present] of [
      [0, sql`first`, sql`first IS NOT NULL`],
      [1, sql`total`, sql`total IS NOT NULL`],
      [2, sql`tokens * 1000000000.0 / duration`, sql`valid`],
    ] as const) {
      yield* db
        .run(
          sql`
      INSERT INTO temp.usage_metric SELECT slot, ${metric}, ${value} AS value, count(*)
      FROM temp.usage_sample WHERE ${present} GROUP BY slot, value
      ON CONFLICT (slot, metric, value) DO UPDATE SET count = count + excluded.count
    `,
        )
        .pipe(Effect.orDie)
      yield* Effect.yieldNow
    }
    for (const row of rows) {
      const current = sampled.get(row.slot)
      sampled.set(row.slot, {
        slot: row.slot,
        first: (current?.first ?? 0) + row.first,
        total: (current?.total ?? 0) + row.total,
        tokens: (current?.tokens ?? 0) + row.tokens,
        duration: (current?.duration ?? 0) + row.duration,
        generationSamples: (current?.generationSamples ?? 0) + row.generationSamples,
        providerTimedSamples: (current?.providerTimedSamples ?? 0) + row.providerTimedSamples,
        observedSamples: (current?.observedSamples ?? 0) + row.observedSamples,
      })
    }
  }
  for (const row of sampled.values()) {
    if (row.first === 0 && row.total === 0 && row.duration === 0) continue
    const first = yield* percentiles(db, row.slot, 0, row.first)
    const total = yield* percentiles(db, row.slot, 1, row.total)
    const generation = yield* percentiles(db, row.slot, 2, row.generationSamples)
    observations.set(page[row.slot].key, {
      speed: {
        samples: row.first,
        generationSamples: row.generationSamples,
        providerTimedSamples: row.providerTimedSamples,
        observedSamples: row.observedSamples,
        ...(generation ? { generationP50TokensPerSecond: generation[0], generationP90TokensPerSecond: generation[1] } : {}),
        ...(first ? { firstOutputP50Ms: first[0], firstOutputP95Ms: first[1] } : {}),
        ...(total ? { totalP50Ms: total[0], totalP95Ms: total[1] } : {}),
        ...(row.duration === 0 ? {} : { outputTokensPerSecond: row.tokens / (row.duration / 1_000_000_000) }),
      },
    })
  }
  return observations
})

const ambiguousModels = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  page: ReadonlyArray<ReportSqlRow>,
  ranges: ReadonlyArray<Slice>,
  sessions?: ReadonlyArray<SessionSchema.ID>,
) {
  type Candidate = { model: string; updated: number; sessionID: string; request: number; family: number }
  const models = new Map<string, string>()
  for (const item of page) {
    if (decodeRaws(item.raws!).length < 2) continue
    let earliest: Candidate | undefined
    for (const slice of ranges) {
      const selected = source(slice.sessionID !== undefined)
      const candidate = yield* db
        .get<Candidate>(
          sql`
        SELECT r.model AS model, ${selected.updated} AS updated, ${selected.sessionID} AS sessionID, r.request AS request,
          ${sessions ? sql`CAST(family.key AS INTEGER)` : sql`0`} AS family
        FROM ${selected.name} AS r INDEXED BY ${sliceScanIndex(slice)} ${selected.join}
        ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
        WHERE ${where} ${sliceWhere(slice)} AND r.model IN (SELECT value FROM json_each(${item.raws}))
        ORDER BY ${sessions ? sql`family, r.request` : sql`${selected.updated}, ${selected.sessionID}, r.request`} LIMIT 1
      `,
        )
        .pipe(Effect.orDie)
      yield* Effect.yieldNow
      if (!candidate) continue
      const order = !earliest
        ? -1
        : sessions
          ? candidate.family - earliest.family || candidate.request - earliest.request
          : candidate.updated - earliest.updated ||
            (candidate.sessionID < earliest.sessionID ? -1 : candidate.sessionID > earliest.sessionID ? 1 : 0) ||
            candidate.request - earliest.request
      if (order < 0) earliest = candidate
    }
    if (earliest) models.set(item.key, earliest.model)
  }
  return models
})

const percentiles = Effect.fnUntraced(function* (db: Db, slot: number, metric: 0 | 1 | 2, size: number) {
  if (size === 0) return undefined
  const targets = [Math.ceil(size / 2), Math.ceil((size * (metric === 2 ? 90 : 95)) / 100)]
  const values: number[] = []
  let cursor: number | undefined
  let seen = 0
  while (values.length < targets.length) {
    const rows = yield* db
      .all<{ value: number; count: number }>(
        sql`
      SELECT value, count FROM temp.usage_metric WHERE slot = ${slot} AND metric = ${metric}
        ${cursor === undefined ? sql`` : sql`AND value > ${cursor}`}
      ORDER BY value LIMIT ${metricRows}
    `,
      )
      .pipe(Effect.orDie)
    for (const row of rows) {
      seen += row.count
      cursor = row.value
      while (values.length < targets.length && seen >= targets[values.length]) values.push(row.value)
    }
    yield* Effect.yieldNow
    if (rows.length < metricRows) break
  }
  return values
})

const pricingBoundary = Effect.fnUntraced(function* (
  db: Db,
  after: string | undefined,
  rows: number,
  sessionID?: SessionSchema.ID,
  range: Range = {},
) {
  if (sessionID !== undefined) {
    const cursor = after === undefined ? undefined : Number(after)
    const next = yield* db
      .get<{ request: number }>(
        sql`
      SELECT r.request FROM ${source(true).name} AS r INDEXED BY ${source(true).index}
      WHERE r.session_id = ${sessionID} ${cursor === undefined ? sql`` : sql`AND r.request > ${cursor}`}
      ORDER BY r.request LIMIT 1 OFFSET ${rows - 1}
    `,
      )
      .pipe(Effect.orDie)
    yield* Effect.yieldNow
    return {
      slice: { sessionID, after: cursor, before: next?.request } as Slice,
      after: next ? String(next.request) : undefined,
    }
  }
  const cursor: Cursor | undefined = after === undefined ? undefined : JSON.parse(after)
  const next = yield* db
    .get<Cursor>(
      sql`
    SELECT r.time_created AS time, r.id FROM ${source(false).name} AS r INDEXED BY ${source(false).unpricedIndex}
    WHERE r.cost IS NULL AND r.source <> 'decision' ${sliceWhere({ after: cursor, ...range })}
    ORDER BY r.time_created, r.id LIMIT 1 OFFSET ${rows - 1}
  `,
    )
    .pipe(Effect.orDie)
  yield* Effect.yieldNow
  return { slice: { after: cursor, before: next, ...range } as Slice, after: next ? JSON.stringify(next) : undefined }
})

export const unpriced = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  after?: string,
  sessionID?: SessionSchema.ID,
  range?: Range,
) {
  const selected = source(sessionID !== undefined)
  const page = yield* pricingBoundary(db, after, 200, sessionID, range)
  const ids = yield* db
    .all<{ id: ProviderRequest.ID }>(
      sql`
    SELECT r.id FROM ${selected.name} AS r INDEXED BY ${selected.unpricedIndex} ${selected.join}
    WHERE ${where} AND r.cost IS NULL AND r.source <> 'decision'
      ${sliceWhere(page.slice)}
  `,
    )
    .pipe(Effect.orDie)
  yield* Effect.yieldNow
  if (ids.length === 0) return { rows: [], after: page.after }
  const request = alias(selected.table, "r")
  const session = alias(SessionTable, "s")
  const rows = yield* db
    .select({
      record: {
        model: request.model,
        tokens: request.tokens,
        agent: request.agent,
        time_created: request.time_created,
        usage_anchor: request.usage_anchor,
      },
      inputID:
        sessionID === undefined
          ? sql<null>`NULL`
          : sql<NonNullable<ProviderRequest.Record["inputID"]> | null>`r.input_id`,
      taskPath: selected.taskPath,
      sessionID: selected.sessionID,
      title: selected.title,
      projectID: selected.projectID,
      directory: selected.directory,
      workspaceID: selected.workspaceID,
    })
    .from(request)
    .leftJoin(session, eq(session.id, request.session_id))
    .where(
      sql`${request.cost} IS NULL AND ${request.source} <> 'decision' AND ${inArray(
        request.id,
        ids.map((row) => row.id),
      )}`,
    )
    .orderBy(asc(request.id))
    .limit(200)
    .all()
    .pipe(Effect.orDie)
  return { rows, after: page.after }
})

export const latest = Effect.fn("SessionUsageRead.latest")(function* (
  db: Db,
  where: SQL,
  sessions?: ReadonlyArray<SessionSchema.ID>,
) {
  type Latest = {
    invalidation: ProviderRequest.Invalidation
    namespace: string
    timing: string | null
    time: number
    family: number
    updated: number
    sessionID: string
    request: number
  }
  let latest: Latest | undefined
  for (const slice of yield* slices(db, sessions)) {
    const selected = source(slice.sessionID !== undefined)
    const candidate = yield* db
      .get<Latest>(
        sql`
  SELECT r.invalidation, substr(r.prompt_cache_key, 1, 8) AS namespace, r.timing, r.time_created AS time,
    ${sessions ? sql`CAST(family.key AS INTEGER)` : sql`0`} AS family,
    ${selected.updated} AS updated, ${selected.sessionID} AS sessionID, r.request
  FROM ${selected.name} AS r INDEXED BY ${sliceIndex(slice)} ${selected.join}
  ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
  WHERE ${where} ${sliceWhere(slice)}
  ORDER BY r.time_created DESC, ${sessions ? sql`CAST(family.key AS INTEGER) DESC` : sql`${selected.updated} DESC, r.session_id DESC`}, r.request DESC LIMIT 1
`,
      )
      .pipe(Effect.orDie)
    if (candidate) {
      const order = !latest
        ? 1
        : candidate.time - latest.time ||
          (sessions
            ? candidate.family - latest.family
            : candidate.updated - latest.updated ||
              (candidate.sessionID > latest.sessionID ? 1 : candidate.sessionID < latest.sessionID ? -1 : 0)) ||
          candidate.request - latest.request
      if (order > 0) latest = candidate
    }
    yield* Effect.yieldNow
  }
  if (!latest) return undefined
  return { invalidation: latest.invalidation, namespace: latest.namespace, timing: latest.timing }
})

export function usageWhere(input: Partial<ProviderRequest.ReportInput>, sessions?: ReadonlyArray<SessionSchema.ID>) {
  return sql`${sessions ? sql`r.session_id IN (SELECT value FROM json_each(${JSON.stringify(sessions)}))` : sql`1`}
    ${input.from === undefined ? sql`` : sql`AND +r.time_created >= ${input.from}`}
    ${input.to === undefined ? sql`` : sql`AND +r.time_created < ${input.to}`}
    ${input.providerID === undefined ? sql`` : sql`AND json_extract(r.model, '$.providerID') = ${input.providerID}`}
    ${input.profile === undefined ? sql`` : sql`AND json_extract(r.model, '$.profile') = ${input.profile}`}
    ${input.modelID === undefined ? sql`` : sql`AND json_extract(r.model, '$.id') = ${input.modelID}`}
    ${input.selectedEffort === undefined ? sql`` : sql`AND json_extract(r.model, '$.variant') = ${input.selectedEffort}`}`
}

export const SessionUsageRead = {
  models,
  unpriced,
  latest,
  report,
  pricingRefs,
  localUsage,
  localSpend,
  each,
  usageWhere,
}
