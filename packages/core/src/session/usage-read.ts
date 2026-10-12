import { and, asc, eq, gt, isNull, ne, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
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

export const pricingRefs = (db: Database.Interface["db"], where: SQL, after?: string) => {
  const key = sql`json_array(s.directory, s.workspace_id, json_extract(r.model, '$.providerID'), json_extract(r.model, '$.id'), json_extract(r.model, '$.profile'))`
  return db
    .all<PricingRef>(
      sql`
    SELECT DISTINCT ${key} AS key, s.directory, s.workspace_id AS workspaceID,
      json_extract(r.model, '$.providerID') AS provider, json_extract(r.model, '$.id') AS model,
      json_extract(r.model, '$.profile') AS profile
    FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
    WHERE ${where} AND r.cost IS NULL AND r.source <> 'decision'
      ${after === undefined ? sql`` : sql`AND ${key} > ${after}`}
    ORDER BY key ASC LIMIT 200
  `,
    )
    .pipe(Effect.orDie)
}

const aggregate = sql`count(*) AS logical, coalesce(sum(r.attempts), 0) AS physical, coalesce(sum(r.source <> 'step'), 0) AS helpers,
  coalesce(sum(r.continuation = 'continued'), 0) AS continued, coalesce(sum(r.continuation = 'fallback'), 0) AS fallback,
  coalesce(sum(json_extract(r.tokens, '$.input')), 0) AS input,
  coalesce(sum(json_extract(r.tokens, '$.output')), 0) AS output,
  coalesce(sum(json_extract(r.tokens, '$.reasoning')), 0) AS reasoning,
  coalesce(sum(json_extract(r.tokens, '$.cache.read')), 0) AS cacheRead,
  coalesce(sum(json_extract(r.tokens, '$.cache.write')), 0) AS cacheWrite,
  min(coalesce(r.cache_read_reported, 0)) AS cacheReadReported`

export const totals = (db: Database.Interface["db"], where: SQL) =>
  db
    .get<Aggregate>(
      sql`
  SELECT ${aggregate}, coalesce(sum(r.cost), 0) AS cost, count(r.cost) AS priced
  FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id WHERE ${where}
`,
    )
    .pipe(Effect.orDie)

export const page = (
  db: Database.Interface["db"],
  where: SQL,
  key: SQL,
  order: SQL,
  offset: number,
  limit: number,
  correction: SQL,
) =>
  db
    .all<Aggregate>(
      sql`
  SELECT CAST(${key} AS TEXT) AS key, s.id AS sessionID, s.title, s.project_id AS projectID,
    s.directory, s.workspace_id AS workspaceID, r.model, r.agent, r.time_created AS time,
    ${aggregate}, coalesce(sum(r.cost), 0) + coalesce(${correction}, 0) AS cost,
    count(r.cost) + (${correction} IS NOT NULL) AS priced, (${correction} IS NOT NULL) AS currentCatalog
  FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
  WHERE ${where} GROUP BY ${key} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}
`,
    )
    .pipe(Effect.orDie)

export const count = (db: Database.Interface["db"], where: SQL, key: SQL) =>
  db
    .get<{ count: number }>(
      sql`
  SELECT count(DISTINCT CAST(${key} AS TEXT)) AS count
  FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id WHERE ${where}
`,
    )
    .pipe(
      Effect.orDie,
      Effect.map((row) => row!.count),
    )

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

export const key = Effect.fn("SessionUsageRead.key")(function* (
  db: Database.Interface["db"],
  where: SQL,
  group: "model" | "session" | "project" | "agent" | "hour" | "day" | "month",
  timeZone?: string,
) {
  if (group === "model")
    return sql`${encode(sql`json_extract(r.model, '$.providerID')`)} || '/' || ${encode(sql`json_extract(r.model, '$.id')`)}
    || CASE WHEN json_extract(r.model, '$.variant') IS NULL THEN '' ELSE '/' || ${encode(sql`json_extract(r.model, '$.variant')`)} END
    || CASE WHEN json_extract(r.model, '$.profile') IS NULL THEN '' ELSE '/' || ${encode(sql`json_extract(r.model, '$.profile')`)} END`
  if (group === "session") return sql`s.id`
  if (group === "project") return sql`s.project_id`
  if (group === "agent") return sql`r.agent`
  const format = group === "hour" ? "%Y-%m-%dT%H:00:00" : group === "day" ? "%Y-%m-%d" : "%Y-%m"
  if (!timeZone)
    return sql`strftime(${format + (group === "hour" ? ".000Z" : "")}, r.time_created / 1000.0, 'unixepoch')`
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
  const offsets: { start: number; label: string; seconds: number }[] = []
  let after: number | undefined
  while (true) {
    const rows = yield* db
      .all<{ time: number }>(
        sql`
      SELECT DISTINCT r.time_created AS time FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
      WHERE ${where} ${after === undefined ? sql`` : sql`AND r.time_created > ${after}`} ORDER BY r.time_created ASC LIMIT 200
    `,
      )
      .pipe(Effect.orDie)
    for (const row of rows) {
      const label =
        formatter
          .formatToParts(row.time)
          .find((part) => part.type === "timeZoneName")!
          .value.replace("GMT", "") || "+00:00"
      if (offsets.at(-1)?.label === label) continue
      const parts = label.slice(1).split(":").map(Number)
      offsets.push({
        start: row.time,
        label,
        seconds: (label.startsWith("-") ? -1 : 1) * (parts[0]! * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)),
      })
    }
    if (rows.length < 200) break
    after = rows.at(-1)!.time
  }
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
  return sql`strftime(${format}, r.time_created / 1000.0 + (${seconds}), 'unixepoch') ${group === "hour" ? sql`|| (${label})` : sql``}`
})

export const grouped = (db: Database.Interface["db"], where: SQL, key: SQL, after?: string) =>
  db
    .all<Aggregate>(
      sql`
  SELECT CAST(${key} AS TEXT) AS key, s.id AS sessionID, s.title, s.project_id AS projectID,
    s.directory, s.workspace_id AS workspaceID, r.model, r.agent, r.time_created AS time,
    count(*) AS logical, coalesce(sum(r.attempts), 0) AS physical, coalesce(sum(r.source <> 'step'), 0) AS helpers,
    coalesce(sum(r.continuation = 'continued'), 0) AS continued, coalesce(sum(r.continuation = 'fallback'), 0) AS fallback,
    sum(json_extract(r.tokens, '$.input')) AS input, sum(json_extract(r.tokens, '$.output')) AS output,
    sum(json_extract(r.tokens, '$.reasoning')) AS reasoning,
    sum(json_extract(r.tokens, '$.cache.read')) AS cacheRead,
    sum(json_extract(r.tokens, '$.cache.write')) AS cacheWrite,
    coalesce(sum(r.cost), 0) AS cost, count(r.cost) AS priced,
    min(coalesce(r.cache_read_reported, 0)) AS cacheReadReported
  FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
  WHERE ${where} ${after === undefined ? sql`` : sql`AND CAST(${key} AS TEXT) > ${after}`}
  GROUP BY ${key} ORDER BY CAST(${key} AS TEXT) ASC LIMIT 200
`,
    )
    .pipe(Effect.orDie)

export const unpriced = (db: Database.Interface["db"], where: SQL, after?: ProviderRequest.ID) => {
  const request = alias(SessionProviderRequestTable, "r")
  const session = alias(SessionTable, "s")
  return db
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
      and(
        where,
        isNull(request.cost),
        ne(request.source, "decision"),
        after === undefined ? undefined : gt(request.id, after),
      ),
    )
    .orderBy(asc(request.id))
    .limit(200)
    .all()
    .pipe(Effect.orDie)
}

export const observations = Effect.fn("SessionUsageRead.observations")(function* (
  db: Database.Interface["db"],
  where: SQL,
  group: "model" | "session" | "project" | "agent" | "hour" | "day" | "month",
  key: SQL,
  page: ReadonlyArray<Aggregate>,
  sessions?: ReadonlyArray<SessionSchema.ID>,
) {
  if (page.length === 0) return new Map<string, { model: string; speed?: ProviderRequest.Speed }>()
  const selected = sql`(${sql.join(
    page.map((item) => sql`${item.key}`),
    sql`, `,
  )})`
  const models =
    group === "model"
      ? Object.fromEntries(
          page.flatMap((item) => {
            const parts = item.key.split("/").map(decodeURIComponent)
            const identities =
              parts.length === 3
                ? [
                    [parts[0], parts[1], parts[2], null],
                    [parts[0], parts[1], null, parts[2]],
                  ]
                : [[parts[0], parts[1], parts[2] ?? null, parts[3] ?? null]]
            return identities.map((identity) => [
              Buffer.from(JSON.stringify(identity)).toString("hex").toUpperCase(),
              item.key,
            ])
          }),
        )
      : {}
  const identity =
    group === "session"
      ? sql`s.id`
      : group === "project"
        ? sql`s.project_id`
        : group === "agent"
          ? sql`r.agent`
          : group === "model"
            ? sql`json_extract(${JSON.stringify(models)}, '$."' || hex(json_array(json_extract(r.model, '$.providerID'), json_extract(r.model, '$.id'), json_extract(r.model, '$.variant'), json_extract(r.model, '$.profile'))) || '"')`
            : key
  const membership = ["session", "project", "agent"].includes(group) ? sql`AND ${identity} IN ${selected}` : sql``
  const order = sessions ? sql`family_order, request_order` : sql`updated_order, session_order, request_order`
  const rows = yield* db
    .all<{
      key: string
      model: string
      first: number
      total: number
      tokens: number
      duration: number
      first50: number | null
      first95: number | null
      total50: number | null
      total95: number | null
    }>(
      sql`
    WITH candidates AS MATERIALIZED (
      SELECT ${identity} AS key, r.model, s.time_updated AS updated_order, s.id AS session_order, r.request AS request_order,
        ${sessions ? sql`CAST(family.key AS INTEGER)` : sql`0`} AS family_order,
        json_extract(r.timing, '$.firstOutputMs') AS first,
        json_extract(r.timing, '$.totalMs') AS total,
        json_extract(r.timing, '$.generatedTokens') AS tokens,
        CASE WHEN json_type(r.timing, '$.generationDurationNs') IS NOT NULL THEN json_extract(r.timing, '$.generationDurationNs')
          WHEN json_extract(r.timing, '$.observedGenerationDurationNs') >= 1000000000 THEN json_extract(r.timing, '$.observedGenerationDurationNs') END AS duration
      FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
      ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
      WHERE ${where} ${membership}
    ), samples AS MATERIALIZED (
      SELECT *, row_number() OVER (PARTITION BY key ORDER BY ${order}) AS model_rank FROM candidates WHERE key IN ${selected}
    ), first_ranked AS (
      SELECT key, first, row_number() OVER (PARTITION BY key ORDER BY first) AS rank,
        count(*) OVER (PARTITION BY key) AS size FROM samples WHERE first IS NOT NULL
    ), total_ranked AS (
      SELECT key, total, row_number() OVER (PARTITION BY key ORDER BY total) AS rank,
        count(*) OVER (PARTITION BY key) AS size FROM samples WHERE total IS NOT NULL
    ), first_stats AS (
      SELECT key, max(CASE WHEN rank = (size + 1) / 2 THEN first END) AS first50,
        max(CASE WHEN rank = (95 * size + 99) / 100 THEN first END) AS first95 FROM first_ranked GROUP BY key
    ), total_stats AS (
      SELECT key, max(CASE WHEN rank = (size + 1) / 2 THEN total END) AS total50,
        max(CASE WHEN rank = (95 * size + 99) / 100 THEN total END) AS total95 FROM total_ranked GROUP BY key
    ), generation AS (
      SELECT key, count(first) AS first, count(total) AS total,
        total(CASE WHEN duration > 0 AND duration <= 9007199254740991 AND CAST(duration AS INTEGER) = duration
          AND tokens > 0 AND tokens <= 9007199254740991 AND CAST(tokens AS INTEGER) = tokens THEN tokens END) AS tokens,
        total(CASE WHEN duration > 0 AND duration <= 9007199254740991 AND CAST(duration AS INTEGER) = duration
          AND tokens > 0 AND tokens <= 9007199254740991 AND CAST(tokens AS INTEGER) = tokens THEN duration END) AS duration
      FROM samples GROUP BY key
    ) SELECT generation.*, samples.model, first_stats.first50, first_stats.first95, total_stats.total50, total_stats.total95
      FROM generation JOIN samples ON samples.key = generation.key AND samples.model_rank = 1
      LEFT JOIN first_stats ON first_stats.key = generation.key LEFT JOIN total_stats ON total_stats.key = generation.key
  `,
    )
    .pipe(Effect.orDie)
  return new Map(
    rows.map((row): [string, { model: string; speed?: ProviderRequest.Speed }] => [
      row.key,
      {
        model: row.model,
        ...(row.first === 0 && row.total === 0 && row.duration === 0
          ? {}
          : {
              speed: {
                samples: row.first,
                ...(row.first === 0 ? {} : { firstOutputP50Ms: row.first50!, firstOutputP95Ms: row.first95! }),
                ...(row.total === 0 ? {} : { totalP50Ms: row.total50!, totalP95Ms: row.total95! }),
                ...(row.duration === 0 ? {} : { outputTokensPerSecond: row.tokens / (row.duration / 1_000_000_000) }),
              },
            }),
      },
    ]),
  )
})

export const latest = (db: Database.Interface["db"], where: SQL, sessions?: ReadonlyArray<SessionSchema.ID>) =>
  db
    .get<{ invalidation: ProviderRequest.Invalidation; namespace: string; timing: string | null }>(
      sql`
  SELECT r.invalidation, substr(r.prompt_cache_key, 1, 8) AS namespace, r.timing
  FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
  ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
  WHERE ${where} ORDER BY r.time_created DESC, ${sessions ? sql`CAST(family.key AS INTEGER) DESC` : sql`s.time_updated DESC, s.id DESC`}, r.request DESC LIMIT 1
`,
    )
    .pipe(Effect.orDie)

export const SessionUsageRead = { grouped, unpriced, observations, latest, totals, page, count, key, pricingRefs }
