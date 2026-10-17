import { and, asc, eq, gt, isNull, ne, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventRuntime } from "../event"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { UsageAnchor } from "@ycoding-ai/schema/usage-anchor"
import { SessionEvent } from "./event"
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
  requests: SQL = sql`NULL`,
  join: SQL = sql``,
) =>
  db
    .all<Aggregate>(
      sql`
  SELECT CAST(${key} AS TEXT) AS key, s.id AS sessionID, s.title, s.project_id AS projectID,
    s.directory, s.workspace_id AS workspaceID, r.model, r.agent, r.time_created AS time,
    ${aggregate}, coalesce(sum(r.cost), 0) + coalesce(${correction}, 0) AS cost,
    count(r.cost) + coalesce(${requests}, 0) AS priced, (${correction} IS NOT NULL) AS currentCatalog
  FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id ${join}
  WHERE ${where} GROUP BY ${key} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}
`,
    )
    .pipe(Effect.orDie)

export const count = (db: Database.Interface["db"], where: SQL, key: SQL, join: SQL = sql``) =>
  db
    .get<{ count: number }>(
      sql`
  SELECT count(DISTINCT CAST(${key} AS TEXT)) AS count
  FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id ${join} WHERE ${where}
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
  group: ProviderRequest.ReportGroup,
  timeZone?: string,
  anchors?: ReadonlyMap<string, UsageAnchor.Ref>,
) {
  if (group === "model")
    return sql`${encode(sql`json_extract(r.model, '$.providerID')`)} || '/' || ${encode(sql`json_extract(r.model, '$.id')`)}
    || CASE WHEN json_extract(r.model, '$.variant') IS NULL THEN '' ELSE '/' || ${encode(sql`json_extract(r.model, '$.variant')`)} END
    || CASE WHEN json_extract(r.model, '$.profile') IS NULL THEN '' ELSE '/' || ${encode(sql`json_extract(r.model, '$.profile')`)} END`
  const provider = sql`json_extract(r.model, '$.providerID')`
  const model = sql`json_extract(r.model, '$.id')`
  const profile = sql`json_extract(r.model, '$.profile')`
  if (group === "provider") return sql`json_array('provider', ${provider})`
  if (group === "provider-profile-model")
    return sql`json_array('provider-profile-model', ${provider}, ${profile}, ${model})`
  if (group === "provider-model") return sql`json_array('provider-model', ${provider}, ${model})`
  if (group === "model-id") return sql`json_array('model-id', ${model})`
  if (group === "profile") return sql`json_array('profile', ${provider}, ${profile})`
  if (group === "prompt") return promptKey(anchors)
  if (group === "task") return sql`json_array('task', task.value)`
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

const unattributedPrompt = JSON.stringify(["prompt", null, null])

function promptKey(anchors?: ReadonlyMap<string, UsageAnchor.Ref>) {
  if (!anchors || anchors.size === 0) return sql`${unattributedPrompt}`
  const keys = JSON.stringify(
    Object.fromEntries(
      [...anchors].map(([input, anchor]) => [Buffer.from(input).toString("hex").toUpperCase(), promptGroupKey(anchor)]),
    ),
  )
  return sql`coalesce(json_extract(${keys}, '$."' || hex(json_array(r.session_id, r.input_id)) || '"'), ${unattributedPrompt})`
}

export function promptGroupKey(anchor?: UsageAnchor.Ref) {
  return anchor ? JSON.stringify(["prompt", anchor.sessionID, anchor.inputID]) : unattributedPrompt
}

export function inputKey(sessionID: string, inputID: string) {
  return JSON.stringify([sessionID, inputID])
}

const taskPath = sql`(WITH RECURSIVE path(id, parent_id, task_id) AS (
    SELECT session.id, session.parent_id, task.session_id FROM session
    LEFT JOIN session_task AS task ON task.session_id = session.id WHERE session.id = r.session_id
    UNION SELECT session.id, session.parent_id, task.session_id FROM session
    JOIN path ON session.id = path.parent_id LEFT JOIN session_task AS task ON task.session_id = session.id
  ) SELECT json_group_array(task_id) FROM path WHERE task_id IS NOT NULL)`

export const fanout = (group: ProviderRequest.ReportGroup) =>
  group === "task" ? sql`LEFT JOIN json_each(${taskPath}) AS task` : sql``

const admittedType = EventRuntime.versionedType(
  SessionEvent.InputAdmitted.type,
  SessionEvent.InputAdmitted.durable.version,
)
const decodeAnchor = Schema.decodeUnknownOption(Schema.fromJsonString(UsageAnchor.Ref))

const admitted = (db: Database.Interface["db"], reference: UsageAnchor.Ref) =>
  db
    .get<{ causedBy: string | null; kind: string | null }>(
      sql`
    SELECT json_extract(data, '$.causedBy') AS causedBy, json_extract(data, '$.input.type') AS kind
    FROM event INDEXED BY event_aggregate_type_seq_idx
    WHERE aggregate_id = ${reference.sessionID} AND type = ${admittedType} AND json_extract(data, '$.inputID') = ${reference.inputID}
    ORDER BY seq DESC LIMIT 1
  `,
    )
    .pipe(Effect.orDie)

const resolve = Effect.fnUntraced(function* (db: Database.Interface["db"], reference: UsageAnchor.Ref) {
  const seen = new Set<string>()
  let cursor = reference
  while (true) {
    const visited = inputKey(cursor.sessionID, cursor.inputID)
    if (seen.has(visited)) return undefined
    seen.add(visited)
    const input = yield* admitted(db, cursor)
    const cause = input?.causedBy ? Option.getOrUndefined(decodeAnchor(input.causedBy)) : undefined
    if (cause) {
      cursor = cause
      continue
    }
    const session = yield* db
      .get<{ id: string }>(sql`SELECT id FROM session WHERE id = ${cursor.sessionID}`)
      .pipe(Effect.orDie)
    if (!session) return undefined
    const task = yield* db
      .get<{ parentID: UsageAnchor.Ref["sessionID"]; messageID: string; inputID: UsageAnchor.Ref["inputID"] }>(
        sql`
      SELECT parent_id AS parentID, parent_assistant_message_id AS messageID, input_id AS inputID
      FROM session_task WHERE session_id = ${cursor.sessionID}
    `,
      )
      .pipe(Effect.orDie)
    if (!task || task.inputID !== cursor.inputID) return input?.kind === "user" ? cursor : undefined
    const parent = yield* db
      .get<{ inputID: UsageAnchor.Ref["inputID"] }>(
        sql`
      SELECT id AS inputID FROM session_message
      WHERE session_id = ${task.parentID} AND type = 'user' AND seq < (
        SELECT seq FROM session_message WHERE id = ${task.messageID} AND session_id = ${task.parentID}
      ) ORDER BY seq DESC LIMIT 1
    `,
      )
      .pipe(Effect.orDie)
    if (!parent) return undefined
    cursor = { sessionID: task.parentID, inputID: parent.inputID }
  }
})

export const anchors = Effect.fn("SessionUsageRead.anchors")(function* (db: Database.Interface["db"], where: SQL) {
  const resolved = new Map<string, UsageAnchor.Ref>()
  let after: UsageAnchor.Ref | undefined
  while (true) {
    const inputs = yield* db
      .all<UsageAnchor.Ref>(
        sql`
      SELECT DISTINCT r.session_id AS sessionID, r.input_id AS inputID
      FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
      WHERE ${where} AND r.input_id IS NOT NULL
        ${after === undefined ? sql`` : sql`AND (r.session_id, r.input_id) > (${after.sessionID}, ${after.inputID})`}
      ORDER BY r.session_id, r.input_id LIMIT 200
    `,
      )
      .pipe(Effect.orDie)
    for (const input of inputs) {
      const anchor = yield* resolve(db, input)
      if (anchor) resolved.set(inputKey(input.sessionID, input.inputID), anchor)
    }
    if (inputs.length < 200) return resolved
    after = inputs.at(-1)!
  }
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
      taskPath: sql<string>`${taskPath}`,
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

const validGeneration = sql`duration > 0 AND duration <= 9007199254740991 AND CAST(duration AS INTEGER) = duration
  AND tokens > 0 AND tokens <= 9007199254740991 AND CAST(tokens AS INTEGER) = tokens`

export const observations = Effect.fn("SessionUsageRead.observations")(function* (
  db: Database.Interface["db"],
  where: SQL,
  group: ProviderRequest.ReportGroup,
  key: SQL,
  page: ReadonlyArray<Aggregate>,
  sessions?: ReadonlyArray<SessionSchema.ID>,
  join: SQL = sql``,
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
      generationSamples: number
      providerTimedSamples: number
      observedSamples: number
      generation50: number | null
      generation90: number | null
    }>(
      sql`
    WITH candidates AS MATERIALIZED (
      SELECT ${identity} AS key, r.model, s.time_updated AS updated_order, s.id AS session_order, r.request AS request_order,
        ${sessions ? sql`CAST(family.key AS INTEGER)` : sql`0`} AS family_order,
        json_extract(r.timing, '$.firstOutputMs') AS first,
        json_extract(r.timing, '$.totalMs') AS total,
        json_extract(r.timing, '$.generatedTokens') AS tokens,
        CASE WHEN json_type(r.timing, '$.generationDurationNs') IS NOT NULL THEN json_extract(r.timing, '$.generationDurationNs')
          WHEN json_extract(r.timing, '$.observedGenerationDurationNs') >= 1000000000 THEN json_extract(r.timing, '$.observedGenerationDurationNs') END AS duration,
        json_type(r.timing, '$.generationDurationNs') IS NOT NULL AS providerTimed
      FROM session_provider_request AS r JOIN session AS s ON s.id = r.session_id
      ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
      ${join}
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
    ), rate_ranked AS (
      SELECT key, tokens * 1000000000.0 / duration AS rate,
        row_number() OVER (PARTITION BY key ORDER BY tokens * 1000000000.0 / duration) AS rank,
        count(*) OVER (PARTITION BY key) AS size FROM samples WHERE ${validGeneration}
    ), rate_stats AS (
      SELECT key, max(CASE WHEN rank = (size + 1) / 2 THEN rate END) AS generation50,
        max(CASE WHEN rank = (90 * size + 99) / 100 THEN rate END) AS generation90 FROM rate_ranked GROUP BY key
    ), generation AS (
      SELECT key, count(first) AS first, count(total) AS total,
        count(CASE WHEN ${validGeneration} THEN 1 END) AS generationSamples,
        count(CASE WHEN ${validGeneration} AND providerTimed THEN 1 END) AS providerTimedSamples,
        count(CASE WHEN ${validGeneration} AND NOT providerTimed THEN 1 END) AS observedSamples,
        total(CASE WHEN ${validGeneration} THEN tokens END) AS tokens,
        total(CASE WHEN ${validGeneration} THEN duration END) AS duration
      FROM samples GROUP BY key
    ) SELECT generation.*, samples.model, first_stats.first50, first_stats.first95, total_stats.total50, total_stats.total95,
        rate_stats.generation50, rate_stats.generation90
      FROM generation JOIN samples ON samples.key = generation.key AND samples.model_rank = 1
      LEFT JOIN first_stats ON first_stats.key = generation.key LEFT JOIN total_stats ON total_stats.key = generation.key
      LEFT JOIN rate_stats ON rate_stats.key = generation.key
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
                generationSamples: row.generationSamples,
                providerTimedSamples: row.providerTimedSamples,
                observedSamples: row.observedSamples,
                ...(row.generationSamples === 0
                  ? {}
                  : {
                      generationP50TokensPerSecond: row.generation50!,
                      generationP90TokensPerSecond: row.generation90!,
                    }),
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

export const SessionUsageRead = {
  grouped,
  unpriced,
  observations,
  latest,
  totals,
  page,
  count,
  key,
  pricingRefs,
  anchors,
  fanout,
  inputKey,
  promptGroupKey,
}
