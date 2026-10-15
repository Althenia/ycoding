import { asc, eq, inArray, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { SessionSchema } from "./schema"
import { SessionProviderRequestTable, SessionTable } from "./sql"

export type Aggregate = {
  key: string
  sessionID: string
  title: string
  projectID: string
  directory: string
  workspaceID: string | null
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
) {
  const before = yield* unpricedBoundary(db, after, sliceRows, sessionID)
  const key = sql`json_array(s.directory, s.workspace_id, json_extract(r.model, '$.providerID'), json_extract(r.model, '$.id'), json_extract(r.model, '$.profile'))`
  const refs = yield* db
    .all<PricingRef>(
      sql`
    SELECT DISTINCT ${key} AS key, s.directory, s.workspace_id AS workspaceID,
      json_extract(r.model, '$.providerID') AS provider, json_extract(r.model, '$.id') AS model,
      json_extract(r.model, '$.profile') AS profile
    FROM session_provider_request AS r INDEXED BY ${unpricedIndex(sessionID)} JOIN session AS s ON s.id = r.session_id
    WHERE ${where} AND r.cost IS NULL AND r.source <> 'decision'
      ${sessionID === undefined ? sql`` : sql`AND r.session_id = ${sessionID}`}
      ${after === undefined ? sql`` : sql`AND r.id > ${after}`}
      ${before === undefined ? sql`` : sql`AND r.id <= ${before}`}
  `,
    )
    .pipe(Effect.orDie)
  yield* Effect.yieldNow
  return { refs, after: before }
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

export type ReportGroup = "model" | "session" | "project" | "agent" | "hour" | "day" | "month"

export type ReportRow = Aggregate & { speed?: ProviderRequest.Speed }

type Db = Database.Interface["db"]

type Cursor = { readonly time: number; readonly id: string }
type Slice =
  | { readonly sessionID?: undefined; readonly after?: Cursor; readonly before?: Cursor }
  | { readonly sessionID: SessionSchema.ID; readonly after?: number; readonly before?: number }

const sliceRows = 10_000

const sampleRows = 10_000

const sliceWhere = (slice: Slice) => {
  if (slice.sessionID !== undefined)
    return sql`AND r.session_id = ${slice.sessionID}
    ${slice.after === undefined ? sql`` : sql`AND r.request > ${slice.after}`}
    ${slice.before === undefined ? sql`` : sql`AND r.request <= ${slice.before}`}`
  return sql`${slice.after === undefined ? sql`` : sql`AND (r.time_created, r.id) > (${slice.after.time}, ${slice.after.id})`}
    ${slice.before === undefined ? sql`` : sql`AND (r.time_created, r.id) <= (${slice.before.time}, ${slice.before.id})`}`
}

const sliceIndex = (slice: Slice) =>
  sql.raw(
    slice.sessionID === undefined
      ? "session_provider_request_time_created_id_idx"
      : "session_provider_request_session_request_idx",
  )

const slices = Effect.fnUntraced(function* (db: Db, sessions?: ReadonlyArray<SessionSchema.ID>) {
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
      SELECT r.time_created AS time, r.id FROM session_provider_request AS r INDEXED BY session_provider_request_time_created_id_idx
      WHERE 1 ${sliceWhere({ after: bounds.at(-1) })}
      ORDER BY r.time_created, r.id LIMIT 1 OFFSET ${sliceRows - 1}
    `,
      )
      .pipe(Effect.orDie)
    if (!next) break
    bounds.push(next)
    yield* Effect.yieldNow
  }
  return [undefined, ...bounds].map((after, index): Slice => ({ after, before: bounds[index] }))
})

const stage = Effect.fnUntraced(function* (db: Db, where: SQL, raw: SQL, sessions?: ReadonlyArray<SessionSchema.ID>) {
  yield* db.run(sql`DROP TABLE IF EXISTS temp.usage_partial`).pipe(Effect.orDie)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_partial (raw TEXT, sessionID TEXT, title TEXT, projectID TEXT, directory TEXT, workspaceID TEXT,
        model TEXT, agent TEXT, time INTEGER, logical INTEGER, physical INTEGER, helpers INTEGER, continued INTEGER,
        fallback INTEGER, input INTEGER, output INTEGER, reasoning INTEGER, cacheRead INTEGER, cacheWrite INTEGER,
        cacheReadReported INTEGER, cost REAL, priced INTEGER)`,
    )
    .pipe(Effect.orDie)
  const ranges = yield* slices(db, sessions)
  for (const slice of ranges) {
    yield* db
      .run(
        sql`
      INSERT INTO temp.usage_partial
      SELECT ${raw}, s.id, s.title, s.project_id, s.directory, s.workspace_id, r.model, r.agent, r.time_created,
        ${aggregate}, coalesce(sum(r.cost), 0), count(r.cost)
      FROM session_provider_request AS r INDEXED BY ${sliceIndex(slice)} JOIN session AS s ON s.id = r.session_id
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
        sessionID, title, projectID, directory, workspaceID, model, agent, time, ${rollup}
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
  corrections: Readonly<Record<string, number>>
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
  if (group === "session") return { raw: sql`s.id`, key: sql`raw` }
  if (group === "project") return { raw: sql`s.project_id`, key: sql`raw` }
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
    SELECT r.time_created AS time FROM session_provider_request AS r
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
    const key = yield* groupKey(db, input.group, input, input.timeZone)
    const ranges = yield* stage(db, input.where, key.raw, input.sessions)
    const result = yield* db
      .all<ReportSqlRow>(
        sql`
  WITH keyed AS MATERIALIZED (
    SELECT CAST(${key.key} AS TEXT) AS key, sessionID, title, projectID, directory, workspaceID, model, agent, time,
      ${rollup}, json_group_array(DISTINCT raw) AS raws
    FROM temp.usage_partial GROUP BY key
  )
  SELECT 0 AS kind, page.* FROM (
    SELECT k.key, k.sessionID, k.title, k.projectID, k.directory, k.workspaceID, k.model, k.agent, k.time,
      k.logical, k.physical, k.helpers, k.continued, k.fallback, k.input, k.output, k.reasoning, k.cacheRead, k.cacheWrite,
      k.cost + coalesce(c.correction, 0) AS cost, k.priced + (c.correction IS NOT NULL) AS priced, k.cacheReadReported,
      (c.correction IS NOT NULL) AS currentCatalog, k.raws, NULL AS rowCount
    FROM keyed AS k
    LEFT JOIN (SELECT key AS correctionKey, value AS correction FROM json_each(${JSON.stringify(input.corrections)})) AS c
      ON c.correctionKey = k.key
    ORDER BY ${input.order} LIMIT ${input.limit} OFFSET ${input.offset}
  ) AS page
  UNION ALL
  SELECT 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    coalesce(sum(logical), 0), coalesce(sum(physical), 0), coalesce(sum(helpers), 0), coalesce(sum(continued), 0),
    coalesce(sum(fallback), 0), coalesce(sum(input), 0), coalesce(sum(output), 0), coalesce(sum(reasoning), 0),
    coalesce(sum(cacheRead), 0), coalesce(sum(cacheWrite), 0), coalesce(sum(cost), 0), coalesce(sum(priced), 0),
    min(cacheReadReported), 0, NULL, count(*)
  FROM keyed
`,
      )
      .pipe(Effect.orDie)
    yield* release(db, "usage_partial")
    const total = result.find((row) => row.kind === 1)!
    const page = result.filter((row) => row.kind === 0)
    const observations = yield* speed(db, input.where, input.group, key, page, ranges, input.sessions)
    return {
      rows: page.map((row): ReportRow => ({ ...row, ...observations.get(row.key) })),
      total,
      rowCount: total.rowCount!,
    }
  },
  (effect, db) =>
    Effect.ensuring(
      effect,
      Effect.all([release(db, "usage_partial"), release(db, "usage_slot"), release(db, "usage_sample")]),
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
  const observations = new Map<string, { model: string; speed?: ProviderRequest.Speed }>()
  if (page.length === 0) return observations
  const pairs = JSON.stringify(
    page.flatMap((item, slot) =>
      group === "model" ? decodeRaws(item.raws!).map((raw) => [raw, slot]) : [[item.key, slot]],
    ),
  )
  yield* db.run(sql`CREATE TEMP TABLE usage_slot (raw TEXT PRIMARY KEY, slot INTEGER) WITHOUT ROWID`).pipe(Effect.orDie)
  yield* db
    .run(
      sql`INSERT INTO temp.usage_slot SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${pairs})`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_sample (id INTEGER PRIMARY KEY, requestID TEXT NOT NULL, slot INTEGER, model TEXT,
      updated INTEGER, sessionID TEXT, request INTEGER, family INTEGER, first, total, tokens, duration)`,
    )
    .pipe(Effect.orDie)
  for (const metric of ["first", "total"])
    yield* db
      .run(
        sql.raw(
          `CREATE INDEX usage_sample_${metric} ON usage_sample (slot, ${metric}, requestID) WHERE ${metric} IS NOT NULL`,
        ),
      )
      .pipe(Effect.orDie)
  type Stats = {
    slot: number
    id: number
    model: string
    updated: number
    sessionID: string
    request: number
    family: number
    first: number
    total: number
    tokens: number
    duration: number
  }
  const sampled = new Map<number, Stats>()
  let after = 0
  for (const slice of ranges) {
    yield* db
      .run(
        sql`
      INSERT INTO temp.usage_sample (requestID, slot, model, updated, sessionID, request, family, first, total, tokens, duration)
      SELECT r.id, usage_slot.slot, r.model, s.time_updated, s.id, r.request,
        ${sessions ? sql`CAST(family.key AS INTEGER)` : sql`0`},
        json_extract(r.timing, '$.firstOutputMs'), json_extract(r.timing, '$.totalMs'), json_extract(r.timing, '$.generatedTokens'),
        CASE WHEN json_type(r.timing, '$.generationDurationNs') IS NOT NULL THEN json_extract(r.timing, '$.generationDurationNs')
          WHEN json_extract(r.timing, '$.observedGenerationDurationNs') >= 1000000000 THEN json_extract(r.timing, '$.observedGenerationDurationNs') END
      FROM session_provider_request AS r INDEXED BY ${sliceIndex(slice)} JOIN session AS s ON s.id = r.session_id
      ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
      JOIN temp.usage_slot ON usage_slot.raw = ${group === "model" ? sql`r.model` : key.raw}
      WHERE ${where} ${sliceWhere(slice)}
    `,
      )
      .pipe(Effect.orDie)
    yield* Effect.yieldNow
    const generation = yield* db
      .all<Stats>(
        sql`
      WITH chunk AS MATERIALIZED (
        SELECT *, row_number() OVER (PARTITION BY slot ORDER BY ${sessions ? sql`family, request` : sql`updated, sessionID, request`}) AS rank
        FROM temp.usage_sample WHERE id > ${after}
      )
      SELECT slot, max(id) AS id, max(CASE WHEN rank = 1 THEN model END) AS model,
        max(CASE WHEN rank = 1 THEN updated END) AS updated, max(CASE WHEN rank = 1 THEN sessionID END) AS sessionID,
        max(CASE WHEN rank = 1 THEN request END) AS request, max(CASE WHEN rank = 1 THEN family END) AS family,
        count(first) AS first, count(total) AS total,
        total(CASE WHEN duration > 0 AND duration <= 9007199254740991 AND CAST(duration AS INTEGER) = duration
          AND tokens > 0 AND tokens <= 9007199254740991 AND CAST(tokens AS INTEGER) = tokens THEN tokens END) AS tokens,
        total(CASE WHEN duration > 0 AND duration <= 9007199254740991 AND CAST(duration AS INTEGER) = duration
          AND tokens > 0 AND tokens <= 9007199254740991 AND CAST(tokens AS INTEGER) = tokens THEN duration END) AS duration
      FROM chunk GROUP BY slot
    `,
      )
      .pipe(Effect.orDie)
    for (const row of generation) {
      after = Math.max(after, row.id)
      const current = sampled.get(row.slot)
      const order = !current
        ? -1
        : sessions
          ? row.family - current.family || row.request - current.request
          : row.updated - current.updated ||
            (row.sessionID < current.sessionID ? -1 : row.sessionID > current.sessionID ? 1 : 0) ||
            row.request - current.request
      sampled.set(row.slot, {
        ...(order < 0 ? row : current!),
        first: (current?.first ?? 0) + row.first,
        total: (current?.total ?? 0) + row.total,
        tokens: (current?.tokens ?? 0) + row.tokens,
        duration: (current?.duration ?? 0) + row.duration,
      })
    }
    yield* Effect.yieldNow
  }
  for (const row of sampled.values()) {
    const first = yield* percentiles(db, row.slot, "first", row.first)
    const total = yield* percentiles(db, row.slot, "total", row.total)
    observations.set(page[row.slot].key, {
      model: row.model,
      ...(row.first === 0 && row.total === 0 && row.duration === 0
        ? {}
        : {
            speed: {
              samples: row.first,
              ...(first ? { firstOutputP50Ms: first[0], firstOutputP95Ms: first[1] } : {}),
              ...(total ? { totalP50Ms: total[0], totalP95Ms: total[1] } : {}),
              ...(row.duration === 0 ? {} : { outputTokensPerSecond: row.tokens / (row.duration / 1_000_000_000) }),
            },
          }),
    })
  }
  return observations
})

const percentiles = Effect.fnUntraced(function* (db: Db, slot: number, metric: "first" | "total", size: number) {
  if (size === 0) return undefined
  const values: number[] = []
  let cursor: { id: string; value: number } | undefined
  let rank = 0
  for (const target of [Math.ceil(size / 2), Math.ceil((size * 95) / 100)]) {
    while (rank < target) {
      const step = Math.min(sampleRows, target - rank)
      cursor = yield* db
        .get<{ id: string; value: number }>(
          sql`
        SELECT requestID AS id, ${sql.raw(metric)} AS value FROM temp.usage_sample INDEXED BY ${sql.raw(`usage_sample_${metric}`)}
        WHERE slot = ${slot} AND ${sql.raw(metric)} IS NOT NULL
          ${cursor ? sql`AND (${sql.raw(metric)}, requestID) > (${cursor.value}, ${cursor.id})` : sql``}
        ORDER BY ${sql.raw(metric)}, requestID LIMIT 1 OFFSET ${step - 1}
      `,
        )
        .pipe(Effect.orDie)
      rank += step
      yield* Effect.yieldNow
    }
    values.push(cursor!.value)
  }
  return values
})

const unpricedIndex = (sessionID?: SessionSchema.ID) =>
  sql.raw(
    sessionID === undefined ? "session_provider_request_unpriced_idx" : "session_provider_request_session_unpriced_idx",
  )

const unpricedBoundary = Effect.fnUntraced(function* (
  db: Db,
  after: string | undefined,
  rows: number,
  sessionID?: SessionSchema.ID,
) {
  const next = yield* db
    .get<{ id: string }>(
      sql`
    SELECT r.id FROM session_provider_request AS r INDEXED BY ${unpricedIndex(sessionID)}
    WHERE r.cost IS NULL AND r.source <> 'decision' ${after === undefined ? sql`` : sql`AND r.id > ${after}`}
      ${sessionID === undefined ? sql`` : sql`AND r.session_id = ${sessionID}`}
    ORDER BY r.id LIMIT 1 OFFSET ${rows - 1}
  `,
    )
    .pipe(Effect.orDie)
  yield* Effect.yieldNow
  return next?.id
})

export const unpriced = Effect.fnUntraced(function* (db: Db, where: SQL, after?: string, sessionID?: SessionSchema.ID) {
  const before = yield* unpricedBoundary(db, after, 200, sessionID)
  const ids = yield* db
    .all<{ id: ProviderRequest.ID }>(
      sql`
    SELECT r.id FROM session_provider_request AS r INDEXED BY ${unpricedIndex(sessionID)} JOIN session AS s ON s.id = r.session_id
    WHERE ${where} AND r.cost IS NULL AND r.source <> 'decision'
      ${sessionID === undefined ? sql`` : sql`AND r.session_id = ${sessionID}`}
      ${after === undefined ? sql`` : sql`AND r.id > ${after}`}
      ${before === undefined ? sql`` : sql`AND r.id <= ${before}`}
  `,
    )
    .pipe(Effect.orDie)
  yield* Effect.yieldNow
  if (ids.length === 0) return { rows: [], after: before }
  const request = alias(SessionProviderRequestTable, "r")
  const session = alias(SessionTable, "s")
  const rows = yield* db
    .select({
      record: request,
      sessionID: session.id,
      title: session.title,
      projectID: session.project_id,
      directory: session.directory,
      workspaceID: session.workspace_id,
    })
    .from(request)
    .innerJoin(session, eq(session.id, request.session_id))
    .where(
      inArray(
        request.id,
        ids.map((row) => row.id),
      ),
    )
    .orderBy(asc(request.id))
    .limit(200)
    .all()
    .pipe(Effect.orDie)
  return { rows, after: before }
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
    const candidate = yield* db
      .get<Latest>(
        sql`
  SELECT r.invalidation, substr(r.prompt_cache_key, 1, 8) AS namespace, r.timing, r.time_created AS time,
    ${sessions ? sql`CAST(family.key AS INTEGER)` : sql`0`} AS family,
    s.time_updated AS updated, s.id AS sessionID, r.request
  FROM session_provider_request AS r INDEXED BY ${sliceIndex(slice)} JOIN session AS s ON s.id = r.session_id
  ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
  WHERE ${where} ${sliceWhere(slice)}
  ORDER BY r.time_created DESC, ${sessions ? sql`CAST(family.key AS INTEGER) DESC` : sql`s.time_updated DESC, s.id DESC`}, r.request DESC LIMIT 1
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

export const SessionUsageRead = { models, unpriced, latest, report, pricingRefs }
