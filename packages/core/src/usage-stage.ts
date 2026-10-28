export * as UsageStage from "./usage-stage"

import { Effect } from "effect"
import { sql, type SQL } from "drizzle-orm"
import type { Database } from "./database/database"

type Db = Pick<Database.Interface["db"], "get" | "all" | "run">

export type Family = "backend" | "session"

export const spans = [1, 60_000, 900_000] as const

const chunkRows = 10_000

const families = {
  backend: {
    cell: "usage_analytics_cell",
    sample: "usage_analytics_cell_sample",
    unpriced: "usage_analytics_cell_unpriced",
    leaf: "usage_analytics_cell_leaf",
    source: "usage_analytics_request",
    dims: ["session_id", "project_id", "directory", "workspace_id", "agent", "model", "usage_anchor", "task_path"],
    select:
      "r.session_id AS session_id, r.project_id AS project_id, r.directory AS directory, r.workspace_id AS workspace_id, r.agent AS agent, r.model AS model, r.usage_anchor AS usage_anchor, r.task_path AS task_path",
    key: "json_array(r.session_id, r.project_id, r.directory, r.workspace_id, r.agent, r.model, r.usage_anchor, r.task_path)",
    updated: "r.session_updated",
    scope: [] as string[],
  },
  session: {
    cell: "session_usage_cell",
    sample: "session_usage_cell_sample",
    unpriced: "session_usage_cell_unpriced",
    leaf: "session_usage_cell_leaf",
    source: "session_provider_request",
    dims: ["session_id", "agent", "source", "model", "usage_anchor", "input_id"],
    select:
      "r.session_id AS session_id, r.agent AS agent, r.source AS source, r.model AS model, r.usage_anchor AS usage_anchor, CASE WHEN r.usage_anchor IS NULL THEN r.input_id END AS input_id",
    key: "json_array(r.agent, r.source, r.model, r.usage_anchor, CASE WHEN r.usage_anchor IS NULL THEN r.input_id END)",
    updated: "0",
    scope: ["session_id"],
  },
} as const

const sums = [
  ["logical", "count(*)"],
  ["physical", "sum(attempts)"],
  ["helpers", "sum(kind <> 'step')"],
  ["continued", "sum(continuation = 'continued')"],
  ["fallback", "sum(continuation = 'fallback')"],
  ["input", "sum(input)"],
  ["output", "sum(output)"],
  ["reasoning", "sum(reasoning)"],
  ["cache_read", "sum(cache_read)"],
  ["cache_write", "sum(cache_write)"],
  ["cache_read_reported", "sum(reported)"],
  ["cost", "total(cost)"],
  ["priced", "count(cost)"],
  ["spend", "total(CASE WHEN cost >= 0 AND cost <= 1.7976931348623157e308 THEN cost END)"],
  ["spend_priced", "count(CASE WHEN cost >= 0 AND cost <= 1.7976931348623157e308 THEN 1 END)"],
  ["unpriced", "sum(cost IS NULL AND kind <> 'decision')"],
  ["first_output", "count(first_ms)"],
  ["total_output", "count(total_ms)"],
  ["generation_samples", "count(CASE WHEN valid THEN 1 END)"],
  ["provider_timed", "count(CASE WHEN valid AND provider_timed THEN 1 END)"],
  ["observed", "count(CASE WHEN valid AND NOT provider_timed THEN 1 END)"],
  ["generation_tokens", "total(CASE WHEN valid THEN gen_tokens END)"],
  ["generation_duration", "total(CASE WHEN valid THEN gen_duration END)"],
  ["generation_rate", "total(CASE WHEN valid THEN gen_tokens * 1000000000.0 / gen_duration END)"],
  ["busy_ms", "sum(total_ms)"],
  ["failed", "sum(outcome = 'failed')"],
  ["cancelled", "sum(outcome = 'cancelled')"],
  ["outcomes", "count(outcome)"],
] as const

const representative = [
  ["first_updated", "max(CASE WHEN fr = 1 THEN updated END)"],
  ["first_request", "max(CASE WHEN fr = 1 THEN request END)"],
  ["last_updated", "CASE WHEN span = 1 THEN max(CASE WHEN lr = 1 THEN updated END) END"],
  ["last_request", "CASE WHEN span = 1 THEN max(CASE WHEN lr = 1 THEN request END) END"],
  ["last_invalidation", "CASE WHEN span = 1 THEN max(CASE WHEN lr = 1 THEN invalidation END) END"],
  ["last_namespace", "CASE WHEN span = 1 THEN max(CASE WHEN lr = 1 THEN namespace END) END"],
  ["last_timing", "CASE WHEN span = 1 THEN max(CASE WHEN lr = 1 THEN timing END) END"],
] as const

const grains = (family: Family, predicate: SQL) => {
  const config = families[family]
  const partition = ["span", "bucket", "key", ...config.scope].join(", ")
  return sql`WITH src AS MATERIALIZED (
    SELECT ${sql.raw(config.select)}, ${sql.raw(config.key)} AS key, r.time_created AS time, ${sql.raw(config.updated)} AS updated,
      r.id AS source_id, r.request AS request, r.attempts AS attempts, r.source AS kind, r.continuation AS continuation, r.cost AS cost,
      coalesce(r.cache_read_reported, 0) AS reported, r.invalidation AS invalidation,
      substr(r.prompt_cache_key, 1, 8) AS namespace, r.timing AS timing, r.outcome AS outcome,
      json_extract(r.tokens, '$.input') AS input, json_extract(r.tokens, '$.output') AS output,
      json_extract(r.tokens, '$.reasoning') AS reasoning, json_extract(r.tokens, '$.cache.read') AS cache_read,
      json_extract(r.tokens, '$.cache.write') AS cache_write,
      json_extract(r.timing, '$.firstOutputMs') AS first_ms, json_extract(r.timing, '$.totalMs') AS total_ms,
      json_extract(r.timing, '$.generatedTokens') AS gen_tokens,
      CASE WHEN json_type(r.timing, '$.generationDurationNs') IS NOT NULL THEN json_extract(r.timing, '$.generationDurationNs')
        WHEN json_extract(r.timing, '$.observedGenerationDurationNs') >= 1000000000 THEN json_extract(r.timing, '$.observedGenerationDurationNs') END AS gen_duration,
      json_type(r.timing, '$.generationDurationNs') IS NOT NULL AS provider_timed
    FROM ${sql.raw(config.source)} AS r WHERE ${predicate}
  ),
  grain AS MATERIALIZED (
    SELECT src.*, gen_duration > 0 AND gen_duration <= 9007199254740991 AND CAST(gen_duration AS INTEGER) = gen_duration
        AND gen_tokens > 0 AND gen_tokens <= 9007199254740991 AND CAST(gen_tokens AS INTEGER) = gen_tokens AS valid,
      span.value AS span, time - ((time % span.value) + span.value) % span.value AS bucket
    FROM src, json_each(${sql.raw(`'${JSON.stringify(spans)}'`)}) AS span
  ),
  ranked AS (
    SELECT grain.*,
      row_number() OVER (PARTITION BY ${sql.raw(partition)} ORDER BY updated, request) AS fr,
      row_number() OVER (PARTITION BY ${sql.raw(partition)} ORDER BY time DESC, updated DESC, request DESC) AS lr
    FROM grain
  ) `
}

const matches = (family: Family, cell: string, grain: string) =>
  sql.raw(
    ["span", "bucket", "key", ...families[family].scope].map((column) => `${cell}.${column} = ${grain}.${column}`).join(" AND "),
  )

const touchedIDs = (family: Family) =>
  sql`SELECT c.id FROM (SELECT DISTINCT ${sql.raw(["span", "bucket", "key", ...families[family].scope].join(", "))} FROM grain) AS g
    CROSS JOIN ${sql.raw(families[family].cell)} AS c WHERE ${matches(family, "c", "g")}`

const apply = Effect.fnUntraced(function* (db: Db, family: Family, predicate: SQL, sign: 1 | -1) {
  const config = families[family]
  const columns = [...config.dims, "span", "bucket", "key", ...sums.map(([name]) => name), ...representative.map(([name]) => name)]
  const conflict = [...config.scope, "span", "bucket", "key"].join(", ")
  const factor = sql.raw(String(sign))
  const first = "(excluded.first_updated, excluded.first_request) < (first_updated, first_request)"
  const last = "span = 1 AND (excluded.last_updated, excluded.last_request) > (last_updated, last_request)"
  const updates = [
    ...sums.map(([name]) => `${name} = ${name} + excluded.${name}`),
    ...(sign === 1
      ? [
          ...["first_updated", "first_request"].map(
            (name) => `${name} = CASE WHEN ${first} THEN excluded.${name} ELSE ${name} END`,
          ),
          ...["last_updated", "last_request", "last_invalidation", "last_namespace", "last_timing"].map(
            (name) => `${name} = CASE WHEN ${last} THEN excluded.${name} ELSE ${name} END`,
          ),
        ]
      : []),
  ]
  yield* db
    .run(
      sql`${grains(family, predicate)}
    INSERT INTO ${sql.raw(config.cell)} (${sql.raw(columns.join(", "))})
    SELECT ${sql.raw(config.dims.join(", "))}, span, bucket, key,
      ${sql.join(
        sums.map(([, value]) => sql`${factor} * coalesce(${sql.raw(value)}, 0)`),
        sql`, `,
      )},
      ${sql.raw(representative.map(([, value]) => value).join(", "))}
    FROM ranked GROUP BY ${sql.raw(conflict)}
    ON CONFLICT (${sql.raw(conflict)}) DO UPDATE SET ${sql.raw(updates.join(", "))}`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`${grains(family, predicate)}
    INSERT INTO ${sql.raw(config.sample)} (cell, metric, value, count)
    SELECT c.id, m.metric, m.value, ${factor} * count(*) FROM (
      SELECT ${sql.raw([...config.scope, "span", "bucket", "key"].join(", "))}, 0 AS metric, first_ms AS value FROM grain WHERE first_ms IS NOT NULL
      UNION ALL SELECT ${sql.raw([...config.scope, "span", "bucket", "key"].join(", "))}, 1, total_ms FROM grain WHERE total_ms IS NOT NULL
      UNION ALL SELECT ${sql.raw([...config.scope, "span", "bucket", "key"].join(", "))}, 2, gen_tokens * 1000000000.0 / gen_duration FROM grain WHERE valid
    ) AS m CROSS JOIN ${sql.raw(config.cell)} AS c WHERE ${matches(family, "c", "m")}
    GROUP BY c.id, m.metric, m.value
    ON CONFLICT (cell, metric, value) DO UPDATE SET count = count + excluded.count`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`${grains(family, predicate)}
    INSERT INTO ${sql.raw(config.unpriced)} (cell, context, requests, input, output, reasoning, cache_read, cache_write)
    SELECT c.id, g.input + g.cache_read + g.cache_write, ${factor} * count(*), ${factor} * sum(g.input), ${factor} * sum(g.output),
      ${factor} * sum(g.reasoning), ${factor} * sum(g.cache_read), ${factor} * sum(g.cache_write)
    FROM grain AS g CROSS JOIN ${sql.raw(config.cell)} AS c
    WHERE ${matches(family, "c", "g")} AND g.cost IS NULL AND g.kind <> 'decision'
    GROUP BY 1, 2
    ON CONFLICT (cell, context) DO UPDATE SET requests = requests + excluded.requests, input = input + excluded.input,
      output = output + excluded.output, reasoning = reasoning + excluded.reasoning,
      cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`,
    )
    .pipe(Effect.orDie)
  const leaves = sql`SELECT c.id, g.updated, g.request, g.source_id FROM grain AS g CROSS JOIN ${sql.raw(config.cell)} AS c
    WHERE ${matches(family, "c", "g")}`
  yield* db
    .run(
      sign === 1
        ? sql`${grains(family, predicate)} INSERT INTO ${sql.raw(config.leaf)} (cell, updated, request, source) ${leaves}`
        : sql`${grains(family, predicate)} DELETE FROM ${sql.raw(config.leaf)} WHERE (cell, updated, request, source) IN (${leaves})`,
    )
    .pipe(Effect.orDie)
})

export const append = (db: Db, family: Family, id: string) => apply(db, family, sql`r.id = ${id}`, 1)

export const remove = Effect.fnUntraced(function* (db: Db, family: Family, predicate: SQL) {
  const config = families[family]
  const cell = config.cell
  yield* apply(db, family, predicate, -1)
  yield* db
    .run(
      sql`${grains(family, predicate)}
    UPDATE ${sql.raw(cell)} SET (first_updated, first_request) = (
      SELECT l.updated, l.request FROM ${sql.raw(config.leaf)} AS l WHERE l.cell = ${sql.raw(cell)}.id
      ORDER BY l.updated, l.request LIMIT 1
    )
    WHERE id IN (${touchedIDs(family)})`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`${grains(family, predicate)}
    UPDATE ${sql.raw(cell)} SET (last_updated, last_request, last_invalidation, last_namespace, last_timing) = (
      SELECT l.updated, l.request, r.invalidation, substr(r.prompt_cache_key, 1, 8), r.timing
      FROM ${sql.raw(config.leaf)} AS l CROSS JOIN ${sql.raw(config.source)} AS r
      WHERE l.cell = ${sql.raw(cell)}.id AND r.id = l.source
      ORDER BY l.updated DESC, l.request DESC LIMIT 1
    )
    WHERE span = 1 AND id IN (${touchedIDs(family)})`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`${grains(family, predicate)} DELETE FROM ${sql.raw(config.sample)} WHERE count <= 0 AND cell IN (${touchedIDs(family)})`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`${grains(family, predicate)} DELETE FROM ${sql.raw(config.unpriced)} WHERE requests <= 0 AND cell IN (${touchedIDs(family)})`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(sql`${grains(family, predicate)} DELETE FROM ${sql.raw(cell)} WHERE logical <= 0 AND id IN (${touchedIDs(family)})`)
    .pipe(Effect.orDie)
})

export const backfill = Effect.fn("UsageStage.backfill")(function* (db: Db) {
  for (const family of ["backend", "session"] as const) {
    const config = families[family]
    for (const table of [config.leaf, config.sample, config.unpriced, config.cell])
      while (true) {
        yield* db
          .run(sql.raw(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ${chunkRows})`))
          .pipe(Effect.orDie)
        const removed = yield* db.get<{ count: number }>(sql`SELECT changes() AS count`).pipe(Effect.orDie)
        yield* Effect.yieldNow
        if ((removed?.count ?? 0) < chunkRows) break
      }
    const order = family === "backend" ? "time_created, id" : "session_id, request"
    const index =
      family === "backend" ? "usage_analytics_request_time_created_id_idx" : "session_provider_request_session_request_idx"
    const cursor = sql.raw(`(r.${order.split(", ").join(", r.")})`)
    let after: { first: string | number; second: string | number } | undefined
    while (true) {
      const boundary = yield* db
        .get<{ first: string | number; second: string | number }>(
          sql`SELECT ${sql.raw(order.split(", ").map((column, index) => `r.${column} AS ${index === 0 ? "first" : "second"}`).join(", "))}
          FROM ${sql.raw(config.source)} AS r INDEXED BY ${sql.raw(index)}
          WHERE ${after === undefined ? sql`1` : sql`${cursor} > (${after.first}, ${after.second})`}
          ORDER BY ${sql.raw(`r.${order.split(", ").join(", r.")}`)} LIMIT 1 OFFSET ${chunkRows - 1}`,
        )
        .pipe(Effect.orDie)
      yield* apply(
        db,
        family,
        sql`${after === undefined ? sql`1` : sql`${cursor} > (${after.first}, ${after.second})`}
          ${boundary === undefined ? sql`` : sql`AND ${cursor} <= (${boundary.first}, ${boundary.second})`}`,
        1,
      )
      yield* Effect.yieldNow
      if (!boundary) break
      after = boundary
    }
  }
})
