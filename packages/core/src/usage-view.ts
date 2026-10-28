export * as UsageViews from "./usage-view"

import { Cause, Context, DateTime, Deferred, Effect, Layer } from "effect"
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { Database } from "./database/database"
import { EventRuntime } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { Project } from "./project"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { Location } from "./location"
import { Agent } from "./agent"
import { SessionEvent } from "./session/event"
import { SessionProviderRequest } from "./session/provider-request"
import { SessionUsage } from "./session/usage"
import { SessionUsagePricing } from "./session/usage-pricing"
import { SessionUsageProjection } from "./session/usage-projection"
import { SessionUsageRead, type PricingRef } from "./session/usage-read"
import { UsageAnalyticsRequestTable } from "./usage-analytics.sql"
import { UsageViewChange } from "./usage-view-change"
import { UsageViewRecipe } from "./usage-view-recipe"
import { UsageViewChangeTable, UsageViewRowTable } from "./usage-view.sql"

type Db = Database.Interface["db"]
type Report = ProviderRequest.ReportInput

export type Lookup =
  | { readonly status: "preparing" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready"
      readonly revision: string
      readonly publishedAt: number
      readonly summary: ProviderRequest.Summary
      readonly reports: ReadonlyArray<ProviderRequest.Report>
    }

export interface Interface {
  readonly read: (reports: ReadonlyArray<Report>, options?: { readonly refresh?: boolean }) => Effect.Effect<Lookup>
  readonly start: (
    catalog: SessionUsagePricing.Catalogs,
    held: (location: Location.Ref) => Effect.Effect<boolean>,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/UsageViews") {}

export const limits = { states: 32, presentations: 96, batch: 200, page: 2_000, rows: 10_000, builds: 3 } as const

const failure = "Usage dashboard preparation failed"

const definition = 2

type State = {
  readonly id: string
  readonly recipe: string
  readonly generation: number
  readonly status: "pending" | "building" | "ready" | "error" | "evicted"
  readonly applied_seq: number
  readonly latest: string | null
  readonly version: number
  readonly epoch: string | null
  readonly refs: number
  readonly time_used: number
}

type Entry =
  | { readonly seq: number; readonly kind: "append"; readonly row: UsageViewRecipe.Source | undefined }
  | { readonly seq: number; readonly kind: "remove"; readonly through: number }

type BuildRow = {
  key: string
  session_id: string | null
  title: string | null
  project_id: string | null
  model: string | null
  agent: string | null
  time: number | null
  rep_updated: number | null
  rep_session: string | null
  rep_request: number | null
} & UsageViewRecipe.Measures

const rowColumns = [
  "key",
  "session_id",
  "title",
  "project_id",
  "model",
  "agent",
  "time",
  "rep_updated",
  "rep_session",
  "rep_request",
  ...UsageViewRecipe.measures,
] as const

const failureName = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.name : "defect"
}

const later = (
  left: Pick<UsageViewRecipe.Latest, "time" | "updated" | "session" | "request">,
  right: Pick<UsageViewRecipe.Latest, "time" | "updated" | "session" | "request">,
) =>
  left.time - right.time ||
  left.updated - right.updated ||
  (left.session > right.session ? 1 : left.session < right.session ? -1 : 0) ||
  left.request - right.request

const layer: Layer.Layer<Service, never, Database.Service | EventRuntime.Service | Project.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const reader = database.reader ?? db
    const builder = database.connect ? yield* database.connect : reader
    const events = yield* EventRuntime.Service
    const projects = yield* Project.Service
    const cache = SessionUsagePricing.make()
    const owner = randomUUID()
    let verified = new Map<string, ReadonlySet<string>>()
    const pricedAt = new Map<string, string>()
    const stale = new Set<string>()
    const epochs = new Map<string, number>()
    let everything = 0
    const token = (location: string) => `${everything}:${epochs.get(location) ?? 0}`
    const priced = (refs: ReadonlyArray<{ readonly ref: string; readonly price: string }>) =>
      refs.every(
        (item) => pricing.has(item.ref) && !stale.has(item.ref) && UsageViewRecipe.price(pricing.get(item.ref)) === item.price,
      )
    let pricing = new Map<string, SessionUsagePricing.Entry | undefined>()
    const unavailable = new Map<string, PricingRef>()
    let active = false
    let catalog: SessionUsagePricing.Catalogs | undefined
    let held: ((location: Location.Ref) => Effect.Effect<boolean>) | undefined
    let wake = Deferred.makeUnsafe<void>()
    const signal = () => void Deferred.doneUnsafe(wake, Effect.void)
    const retries = new Map<string, number>()
    let maintained = 0

    yield* Effect.acquireRelease(
      events.listen((event) =>
        Effect.gen(function* () {
          if (event.type === "catalog.updated") {
            if (event.location && !(held && (yield* held(event.location)))) return
            const location = event.location
              ? UsageViewRecipe.locationKey({ directory: event.location.directory, workspaceID: event.location.workspaceID ?? null })
              : undefined
            cache.invalidate(location)
            if (location === undefined) {
              everything += 1
              pricing = new Map()
              pricedAt.clear()
              stale.clear()
              unavailable.clear()
              verified = new Map()
              signal()
            }
            if (location !== undefined) {
              epochs.set(location, (epochs.get(location) ?? 0) + 1)
              let affected = false
              for (const [key, at] of pricedAt)
                if (at === location) {
                  stale.add(key)
                  affected = true
                }
              for (const [id, locations] of verified)
                if (locations.has(location)) {
                  verified.delete(id)
                  affected = true
                }
              if (affected) signal()
            }
          }
          if (event.type === SessionEvent.ProviderRequestRecorded.type) signal()
        }),
      ),
      (unsubscribe) => unsubscribe,
    )

    const labels = (connection: Db) =>
      connection
        .get<{ labels: string }>(
          sql`SELECT coalesce((SELECT json_group_array(json_array(id, name, worktree)) FROM (
            SELECT id, name, worktree FROM project ORDER BY id)), '[]') AS labels`,
        )
        .pipe(Effect.orDie, Effect.map((row) => row?.labels ?? "[]"))

    const states = (status?: State["status"]) =>
      db
        .all<State>(
          sql`SELECT id, recipe, generation, status, applied_seq, latest, version, epoch, refs, time_used FROM usage_view_state
          ${status === undefined ? sql`` : sql`WHERE status = ${status}`} ORDER BY id`,
        )
        .pipe(Effect.orDie)

    const resolve = (refs: Iterable<PricingRef>) =>
      Effect.gen(function* () {
        const missing = new Map([...refs].filter((ref) => !pricing.has(ref.key) || stale.has(ref.key)).map((ref) => [ref.key, ref]))
        if (missing.size === 0) return
        if (!catalog) return yield* Effect.die(new Error("Usage view pricing has no registered catalog capability"))
        const capability = catalog
        yield* Effect.forEach(
          Map.groupBy(missing.values(), (ref) => UsageViewRecipe.locationKey(ref)),
          ([location, refs]) =>
            Effect.gen(function* () {
              const before = token(location)
              const resolved = new Map<string, SessionUsagePricing.Entry | undefined>()
              const outcome = yield* SessionUsagePricing.resolve({ catalog: capability, cache, catalogs: new Map(), resolved, refs }).pipe(
                Effect.scoped,
                Effect.exit,
              )
              if (outcome._tag === "Failure") {
                if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.failCause(outcome.cause)
                yield* Effect.logError("Usage view pricing Location is unavailable", { failure: failureName(outcome.cause) })
              }
              const current = token(location) === before
              for (const ref of refs) {
                const entry = outcome._tag === "Success" ? resolved.get(ref.key) : undefined
                pricing.set(ref.key, entry)
                pricedAt.set(ref.key, location)
                if (current) stale.delete(ref.key)
                if (!current) stale.add(ref.key)
                if (entry === undefined) unavailable.set(ref.key, ref)
                if (entry !== undefined) unavailable.delete(ref.key)
              }
            }),
          { concurrency: 4, discard: true },
        )
      })

    const register = (wanted: ReadonlyArray<{ readonly id: string; readonly state: string; readonly recipe: string }>) =>
      db
        .transaction(() =>
          Effect.gen(function* () {
            const now = Date.now()
            for (const item of wanted) {
              const existing = yield* db
                .get<{ status: State["status"] }>(sql`SELECT status FROM usage_view_state WHERE id = ${item.state}`)
                .pipe(Effect.orDie)
              if (existing?.status === "evicted") continue
              if (!existing) {
                const count = (yield* db
                  .get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_view_state WHERE status <> 'evicted'`)
                  .pipe(Effect.orDie))?.count ?? 0
                if (count >= limits.states) {
                  yield* db
                    .run(
                      sql`UPDATE usage_view_state SET status = 'evicted' WHERE id = (
                    SELECT id FROM usage_view_state WHERE status <> 'evicted' AND id <> ${UsageViewRecipe.summaryState}
                    ORDER BY time_used LIMIT 1)`,
                    )
                    .pipe(Effect.orDie)
                  yield* db
                    .run(
                      sql`DELETE FROM usage_view_presentation WHERE state IN (SELECT id FROM usage_view_state WHERE status = 'evicted')`,
                    )
                    .pipe(Effect.orDie)
                }
                yield* db
                  .run(
                    sql`INSERT INTO usage_view_state (id, recipe, generation, status, applied_seq, rows, version, refs, time_used)
                  VALUES (${item.state}, ${item.state}, 0, 'pending', 0, 0, 0, 0, ${now})`,
                  )
                  .pipe(Effect.orDie)
              } else
                yield* db.run(sql`UPDATE usage_view_state SET time_used = ${now} WHERE id = ${item.state}`).pipe(Effect.orDie)
              const known = yield* db
                .get<{ id: string }>(sql`SELECT id FROM usage_view_presentation WHERE id = ${item.id}`)
                .pipe(Effect.orDie)
              if (!known) {
                const count = (yield* db
                  .get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_view_presentation`)
                  .pipe(Effect.orDie))?.count ?? 0
                if (count >= limits.presentations)
                  yield* db
                    .run(
                      sql`DELETE FROM usage_view_presentation WHERE id = (
                    SELECT id FROM usage_view_presentation WHERE id <> ${UsageViewRecipe.summaryPresentation} ORDER BY time_used LIMIT 1)`,
                    )
                    .pipe(Effect.orDie)
              }
              yield* db
                .run(
                  sql`INSERT INTO usage_view_presentation (id, state, recipe, time_used)
                VALUES (${item.id}, ${item.state}, ${item.recipe}, ${now})
                ON CONFLICT (id) DO UPDATE SET time_used = excluded.time_used`,
                )
                .pipe(Effect.orDie)
            }
          }),
        )
        .pipe(Effect.orDie)

    const wanted = (reports: ReadonlyArray<Report>) => [
      { id: UsageViewRecipe.summaryPresentation, state: UsageViewRecipe.summaryState, recipe: UsageViewRecipe.summaryState },
      ...reports.map((input) => ({
        id: JSON.stringify(UsageViewRecipe.presentation(input)),
        state: JSON.stringify(UsageViewRecipe.state(input)),
        recipe: JSON.stringify(UsageViewRecipe.presentation(input)),
      })),
    ]

    const start: Interface["start"] = (capability, holding) =>
      Effect.gen(function* () {
        catalog = capability
        held = holding
        if (!active) {
          active = true
          yield* db.run(sql`UPDATE usage_view_state SET status = 'pending' WHERE status = 'building'`).pipe(Effect.orDie)
        }
        maintained = 0
        signal()
      })

    const verify = Effect.fnUntraced(function* () {
      for (const state of yield* states("ready")) {
        if (state.refs === 0 || verified.has(state.id)) continue
        const rows = yield* db
          .all<{ ref: string; price: string; location: string }>(
            sql`SELECT ref, price, location FROM usage_view_ref WHERE state = ${state.id} AND generation = ${state.generation}`,
          )
          .pipe(Effect.orDie)
        const resolved = yield* resolve(rows.map((row) => UsageViewRecipe.decodeRef(row.ref))).pipe(Effect.exit)
        if (resolved._tag === "Failure") {
          if (Cause.hasInterruptsOnly(resolved.cause)) return yield* Effect.failCause(resolved.cause)
          yield* Effect.logError("Usage view price verification failed", { state: state.id, failure: failureName(resolved.cause) })
          retries.set(state.id, Date.now() + 30_000)
          yield* db
            .run(sql`UPDATE usage_view_state SET status = 'error', error = ${failure} WHERE id = ${state.id} AND status = 'ready'`)
            .pipe(Effect.orDie)
          continue
        }
        if (rows.some((row) => !pricing.has(row.ref) || stale.has(row.ref))) continue
        if (priced(rows)) {
          verified.set(state.id, new Set(rows.map((row) => row.location)))
          continue
        }
        yield* db.run(sql`UPDATE usage_view_state SET status = 'pending' WHERE id = ${state.id} AND status = 'ready'`).pipe(Effect.orDie)
      }
    })

    const retry = Effect.fnUntraced(function* (ids: ReadonlyArray<string>) {
      for (const id of ids) {
        retries.delete(id)
        yield* db.run(sql`UPDATE usage_view_state SET status = 'pending' WHERE id = ${id} AND status = 'error'`).pipe(Effect.orDie)
        const refs = yield* db
          .all<{ ref: string }>(sql`SELECT DISTINCT r.ref FROM usage_view_ref AS r JOIN usage_view_state AS s
            ON s.id = r.state AND s.generation = r.generation WHERE r.state = ${id}`)
          .pipe(Effect.orDie)
        const missing = refs.filter((row) => pricing.has(row.ref) && pricing.get(row.ref) === undefined)
        if (missing.length === 0) continue
        for (const row of missing) {
          pricing.delete(row.ref)
          pricedAt.delete(row.ref)
          stale.delete(row.ref)
          unavailable.delete(row.ref)
        }
        yield* db.run(sql`UPDATE usage_view_state SET status = 'pending' WHERE id = ${id} AND status = 'ready'`).pipe(Effect.orDie)
      }
    })

    const read: Interface["read"] = Effect.fn("UsageViews.read")(function* (reports, options) {
      const items = wanted(reports)
      if (options?.refresh) {
        yield* register(items)
        yield* retry([...new Set(items.map((item) => item.state))])
        signal()
        return { status: "preparing" as const }
      }
      const snapshot = yield* reader
        .transaction(() =>
          Effect.gen(function* () {
            const current = yield* UsageViewChange.head(reader)
            const rows = yield* reader
              .all<{
                id: string
                state: string
                payload: string | null
                version: number | null
                labels: string | null
                time_published: number | null
                time_used: number
                state_used: number
                status: State["status"]
                applied_seq: number
                state_version: number
                epoch: string | null
                refs: number
                error: string | null
              }>(
                sql`SELECT p.id, p.state, p.payload, p.version, p.labels, p.time_published, p.time_used, s.time_used AS state_used, s.status, s.applied_seq,
                  s.version AS state_version, s.epoch, s.refs, s.error
                FROM usage_view_presentation AS p JOIN usage_view_state AS s ON s.id = p.state
                WHERE p.id IN (SELECT value FROM json_each(${JSON.stringify(items.map((item) => item.id))}))`,
              )
              .pipe(Effect.orDie)
            const project = rows.some((row) => row.labels !== null) ? yield* labels(reader) : undefined
            return { current, project, rows: new Map(rows.map((row) => [row.id, row])) }
          }),
        )
        .pipe(Effect.orDie)
      const now = Date.now()
      const touch = items.filter((item) => {
        const row = snapshot.rows.get(item.id)
        return row === undefined || row.status === "evicted" || now - Math.min(row.time_used, row.state_used) > 60_000
      })
      if (touch.length > 0) yield* register(touch)
      const rows = items.map((item) => snapshot.rows.get(item.id))
      const failed = rows.find((row) => row?.status === "error")
      if (failed) return { status: "error" as const, message: failed.error ?? failure }
      const published = rows.flatMap((row) =>
        row !== undefined &&
        row.status === "ready" &&
        row.payload !== null &&
        row.applied_seq === snapshot.current &&
        row.version === row.state_version &&
        (row.refs === 0 || verified.has(row.state)) &&
        (row.labels === null || row.labels === snapshot.project)
          ? [{ ...row, payload: row.payload }]
          : [],
      )
      if (published.length !== items.length) {
        signal()
        return { status: "preparing" as const }
      }
      return {
        status: "ready" as const,
        revision: JSON.stringify([definition, snapshot.current, published[0]!.epoch]),
        publishedAt: Math.min(...published.map((row) => row.time_published ?? 0)),
        summary: UsageViewRecipe.decodeSummary(published[0]!.payload),
        reports: published.slice(1).map((row) => UsageViewRecipe.decodeReport(row.payload)),
      }
    })

    const temporary = ["usage_build_row", "usage_build_slot", "usage_build_stat", "usage_build_sample", "usage_build_rep", "usage_partial"]
    const releaseBuild = Effect.forEach(
      temporary,
      (table) => builder.run(sql.raw(`DROP TABLE IF EXISTS temp.${table}`)).pipe(Effect.orDie),
      { discard: true },
    )

    const insertRows = (state: string, generation: number, rows: ReadonlyArray<BuildRow>) =>
      db
        .run(
          sql`INSERT INTO usage_view_row (state, generation, ${sql.raw(rowColumns.join(", "))}, total_cost, total_tokens)
          SELECT ${state}, ${generation}, ${sql.raw(rowColumns.map((name) => `json_extract(value, '$.${name}')`).join(", "))},
            json_extract(value, '$.cost') + json_extract(value, '$.catalog_cost'),
            json_extract(value, '$.input') + json_extract(value, '$.output') + json_extract(value, '$.reasoning')
              + json_extract(value, '$.cache_read') + json_extract(value, '$.cache_write')
          FROM json_each(${JSON.stringify(rows)})`,
        )
        .pipe(Effect.orDie)

    const copy = Effect.fnUntraced(function* (
      state: string,
      generation: number,
      corrections: ReadonlyMap<string, { readonly cost: number; readonly requests: number }>,
    ) {
      let after: string | undefined
      while (true) {
        const rows = yield* builder
          .all<Omit<BuildRow, "catalog_cost" | "catalog_requests">>(
            sql`SELECT r.key, r.session_id, r.title, r.project_id, coalesce(p.model, r.model) AS model, r.agent, r.time,
              r.logical, r.physical, r.helpers, r.continued, r.fallback, r.input, r.output, r.reasoning, r.cache_read,
              r.cache_write, r.cost, r.priced, coalesce(t.reported, 0) AS reported, coalesce(t.first_output, 0) AS first_output,
              coalesce(t.total_output, 0) AS total_output, coalesce(t.generation_samples, 0) AS generation_samples,
              coalesce(t.provider_timed, 0) AS provider_timed, coalesce(t.observed, 0) AS observed,
              coalesce(t.generation_tokens, 0) AS generation_tokens, coalesce(t.generation_duration, 0) AS generation_duration,
              p.updated AS rep_updated, p.session AS rep_session, p.request AS rep_request
            FROM temp.usage_build_row AS r LEFT JOIN temp.usage_build_stat AS t ON t.key = r.key
            LEFT JOIN temp.usage_build_rep AS p ON p.key = r.key
            ${after === undefined ? sql`` : sql`WHERE r.key > ${after}`} ORDER BY r.key LIMIT ${limits.page}`,
          )
          .pipe(Effect.orDie)
        if (rows.length === 0) break
        yield* db
          .transaction(() =>
            insertRows(
              state,
              generation,
              rows.map((row) => ({
                ...row,
                model: row.model ?? "",
                session_id: row.session_id ?? "",
                title: row.title ?? "",
                project_id: row.project_id ?? "",
                agent: row.agent ?? "",
                time: row.time ?? 0,
                catalog_cost: corrections.get(row.key)?.cost ?? 0,
                catalog_requests: corrections.get(row.key)?.requests ?? 0,
              })),
            ),
          )
          .pipe(Effect.orDie)
        yield* Effect.yieldNow
        if (rows.length < limits.page) break
        after = rows.at(-1)!.key
      }
      type Sample = { key: string; metric: number; value: number; count: number }
      type Rank = { key: string; quantile: number; value: number; below: number }
      let cursor: Sample | undefined
      let group: { key: string; metric: number; seen: number; targets: Array<{ quantile: number; goal: number }> } | undefined
      const pending: Rank[] = []
      const flush = Effect.suspend(() => {
        if (pending.length === 0) return Effect.void
        const batch = pending.splice(0)
        return db
          .run(
            sql`INSERT INTO usage_view_rank (state, generation, key, quantile, value, below)
            SELECT ${state}, ${generation}, json_extract(value, '$.key'), json_extract(value, '$.quantile'),
              json_extract(value, '$.value'), json_extract(value, '$.below')
            FROM json_each(${JSON.stringify(batch)})`,
          )
          .pipe(Effect.orDie)
      })
      while (true) {
        const position = cursor
        const rows = yield* builder
          .all<Sample>(
            sql`SELECT key, metric, value, count FROM temp.usage_build_sample
            ${position === undefined ? sql`` : sql`WHERE (key, metric, value) > (${position.key}, ${position.metric}, ${position.value})`}
            ORDER BY key, metric, value LIMIT ${limits.rows}`,
          )
          .pipe(Effect.orDie)
        if (rows.length === 0) break
        yield* db
          .run(
            sql`INSERT INTO usage_view_sample (state, generation, key, metric, value, count)
            SELECT ${state}, ${generation}, json_extract(value, '$.key'), json_extract(value, '$.metric'),
              json_extract(value, '$.value'), json_extract(value, '$.count')
            FROM json_each(${JSON.stringify(rows)})`,
          )
          .pipe(Effect.orDie)
        for (const row of rows) {
          if (!group || group.key !== row.key || group.metric !== row.metric) {
            const size = yield* builder
              .get<{ first_output: number; total_output: number; generation_samples: number }>(
                sql`SELECT first_output, total_output, generation_samples FROM temp.usage_build_stat WHERE key = ${row.key}`,
              )
              .pipe(Effect.orDie)
            const population = size ? size[UsageViewRecipe.sizes[row.metric]!] : 0
            group = {
              key: row.key,
              metric: row.metric,
              seen: 0,
              targets: [...UsageViewRecipe.quantiles.entries()]
                .filter(([, item]) => item.metric === row.metric && population > 0)
                .map(([quantile, item]) => ({ quantile, goal: UsageViewRecipe.target(population, item.percent) })),
            }
          }
          const below = group.seen
          const seen = below + row.count
          group.seen = seen
          for (const item of group.targets.filter((item) => seen >= item.goal))
            pending.push({ key: row.key, quantile: item.quantile, value: row.value, below })
          group.targets = group.targets.filter((item) => seen < item.goal)
        }
        yield* flush
        yield* Effect.yieldNow
        if (rows.length < limits.rows) break
        cursor = rows.at(-1)
      }
      yield* flush
    })

    const build = Effect.fnUntraced(
      function* (state: State) {
        const claimed = yield* db
          .get<{ id: string }>(
            sql`UPDATE usage_view_state SET status = 'building', owner = ${owner}
            WHERE id = ${state.id} AND status = 'pending' RETURNING id`,
          )
          .pipe(Effect.orDie)
        if (!claimed) return
        const recipe = UsageViewRecipe.decodeRecipe(state.recipe)
        const where = SessionUsageRead.usageWhere(recipe)
        const range = { from: recipe.from, to: recipe.to }
        const generation = state.generation + 1
        const formatter = SessionUsageProjection.reportFormatter(recipe)
        for (let attempt = 0; attempt < limits.builds; attempt++) {
          const refs = new Map<string, PricingRef>()
          let after: string | undefined
          while (true) {
            const page: Effect.Success<ReturnType<typeof SessionUsageRead.pricingRefs>> = yield* builder
              .transaction(() => SessionUsageRead.pricingRefs(builder, where, after, undefined, range))
              .pipe(Effect.orDie)
            page.refs.forEach((ref) => refs.set(ref.key, ref))
            if (page.after === undefined) break
            after = page.after
          }
          yield* resolve(refs.values())
          const built = yield* builder
            .transaction(() =>
              Effect.gen(function* () {
                const current = yield* UsageViewChange.head(builder)
                const used = new Map<string, PricingRef>()
                let cursor: string | undefined
                while (true) {
                  const page: Effect.Success<ReturnType<typeof SessionUsageRead.pricingRefs>> =
                    yield* SessionUsageRead.pricingRefs(builder, where, cursor, undefined, range)
                  page.refs.forEach((ref) => used.set(ref.key, ref))
                  if (page.after === undefined) break
                  cursor = page.after
                }
                if ([...used.keys()].some((key) => !pricing.has(key))) return undefined
                const plan = yield* SessionUsageRead.plan(builder, { group: recipe.group, ...range, timeZone: recipe.timeZone })
                yield* SessionUsageRead.materialize(builder, { where, group: recipe.group, plan })
                const corrections = new Map<string, { cost: number; requests: number }>()
                const total = { cost: 0, requests: 0 }
                let unpricedAfter: string | undefined
                while (true) {
                  const page: Effect.Success<ReturnType<typeof SessionUsageRead.unpriced>> = yield* SessionUsageRead.unpriced(
                    builder,
                    where,
                    unpricedAfter,
                    undefined,
                    plan.pieces,
                  )
                  for (const item of page.rows) {
                    const entry = pricing.get(UsageViewRecipe.priceKey(item, item.record.model))
                    const cost = entry
                      ? SessionUsage.estimatedCatalogCost(entry.provider, entry.router, item.record.tokens, item.context)?.cost
                      : undefined
                    if (cost === undefined) continue
                    const tasks = recipe.group === "task" ? UsageViewRecipe.decodeTasks(item.taskPath) : []
                    for (const taskID of tasks.length === 0 ? [undefined] : tasks) {
                      const key = SessionUsageProjection.usageReportGroup(
                        recipe.group,
                        {
                          record: {
                            model: item.record.model,
                            agent: Agent.ID.make(item.record.agent),
                            usageAnchor: item.record.usage_anchor ?? undefined,
                            time: DateTime.makeUnsafe(item.record.time_created),
                          },
                          session: { id: item.sessionID, title: item.title, projectID: Project.ID.make(item.projectID) },
                          taskID,
                        },
                        [],
                        formatter,
                      ).key
                      const value = corrections.get(key) ?? { cost: 0, requests: 0 }
                      value.cost += cost
                      value.requests += item.requests
                      corrections.set(key, value)
                    }
                    total.cost += cost
                    total.requests += item.requests
                  }
                  if (page.after === undefined) break
                  unpricedAfter = page.after
                  yield* Effect.yieldNow
                }
                corrections.set("", total)
                const latest =
                  state.id === UsageViewRecipe.summaryState
                    ? yield* builder
                        .get<UsageViewRecipe.Latest>(
                          sql`SELECT bucket AS time, coalesce(last_updated, 0) AS updated, session_id AS session,
                            last_request AS request, last_invalidation AS invalidation, last_namespace AS namespace,
                            last_timing AS timing
                          FROM usage_analytics_cell INDEXED BY usage_analytics_cell_span_bucket_key_idx WHERE span = 1
                          ORDER BY bucket DESC, last_updated DESC, session_id DESC, last_request DESC LIMIT 1`,
                        )
                        .pipe(Effect.orDie)
                    : undefined
                const refs = [...used.values()].map((ref) => ({ ref, price: UsageViewRecipe.price(pricing.get(ref.key)) }))
                return { current, corrections, refs, latest }
              }),
            )
            .pipe(Effect.orDie)
          if (!built) continue
          yield* db
            .run(sql`UPDATE usage_view_state SET applied_seq = ${built.current} WHERE id = ${state.id} AND owner = ${owner}`)
            .pipe(Effect.orDie)
          yield* copy(state.id, generation, built.corrections)
          yield* releaseBuild
          yield* db
            .transaction(() =>
              Effect.gen(function* () {
                for (const { ref, price } of built.refs)
                  yield* db
                    .run(
                      sql`INSERT OR IGNORE INTO usage_view_ref (state, generation, location, ref, price)
                      VALUES (${state.id}, ${generation}, ${UsageViewRecipe.locationKey(ref)}, ${ref.key}, ${price})`,
                    )
                    .pipe(Effect.orDie)
                yield* db
                  .run(
                    sql`UPDATE usage_view_state SET generation = ${generation}, status = 'ready', applied_seq = ${built.current},
                      rows = (SELECT count(*) FROM usage_view_row WHERE state = ${state.id} AND generation = ${generation} AND key <> ''),
                      latest = ${built.latest ? UsageViewRecipe.encodeLatest(built.latest) : null}, error = NULL,
                      version = version + 1, epoch = ${UsageViewRecipe.digest(built.refs.map((item) => ({ ref: item.ref.key, price: item.price })))},
                      refs = ${built.refs.length}
                    WHERE id = ${state.id} AND owner = ${owner} AND status = 'building'`,
                  )
                  .pipe(Effect.orDie)
              }),
            )
            .pipe(Effect.orDie)
          retries.delete(state.id)
          if (priced(built.refs.map((item) => ({ ref: item.ref.key, price: item.price }))))
            verified.set(state.id, new Set(built.refs.map((item) => UsageViewRecipe.locationKey(item.ref))))
          return
        }
        return yield* Effect.die(new Error("Usage view pricing references kept changing during preparation"))
      },
      (effect, state) =>
        effect.pipe(
          Effect.ensuring(releaseBuild),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
              yield* Effect.logError("Usage view preparation failed", { state: state.id, failure: failureName(cause) })
              retries.set(state.id, Date.now() + 30_000)
              yield* db
                .run(sql`UPDATE usage_view_state SET status = 'error', error = ${failure} WHERE id = ${state.id}`)
                .pipe(Effect.orDie)
            }),
          ),
        ),
    )

    const where = (state: Pick<State, "id" | "generation">, key: string) =>
      sql`state = ${state.id} AND generation = ${state.generation} AND key = ${key}`

    const rank = Effect.fnUntraced(function* (
      state: Pick<State, "id" | "generation">,
      key: string,
      quantile: number,
      metric: number,
      percent: number,
      value: number,
      sign: 1 | -1,
      size: number,
    ) {
      const scope = sql`${where(state, key)} AND metric = ${metric}`
      if (size <= 0) {
        yield* db.run(sql`DELETE FROM usage_view_rank WHERE ${where(state, key)} AND quantile = ${quantile}`).pipe(Effect.orDie)
        return
      }
      const seek = (direction: "next" | "previous", from: number) =>
        db
          .get<{ value: number; count: number }>(
            sql`SELECT value, count FROM usage_view_sample WHERE ${scope}
            AND value ${sql.raw(direction === "next" ? ">" : "<")} ${from}
            ORDER BY value ${sql.raw(direction === "next" ? "ASC" : "DESC")} LIMIT 1`,
          )
          .pipe(Effect.orDie)
      const count = (at: number) =>
        db
          .get<{ count: number }>(sql`SELECT count FROM usage_view_sample WHERE ${scope} AND value = ${at}`)
          .pipe(Effect.orDie, Effect.map((row) => row?.count ?? 0))
      const current = yield* db
        .get<{ value: number; below: number }>(
          sql`SELECT value, below FROM usage_view_rank WHERE ${where(state, key)} AND quantile = ${quantile}`,
        )
        .pipe(Effect.orDie)
      let at = current?.value ?? value
      let below = current?.below ?? 0
      if (current && value < at) below += sign
      let weight = yield* count(at)
      if (weight === 0) {
        const next = yield* seek("next", at)
        const previous = next ? undefined : yield* seek("previous", at)
        const step = next ?? previous
        if (!step) return yield* Effect.die(new Error("Usage view distribution lost its population"))
        at = step.value
        weight = step.count
        if (!next) below -= weight
      }
      const goal = UsageViewRecipe.target(size, percent)
      while (goal > below + weight) {
        below += weight
        const next = yield* seek("next", at)
        if (!next) return yield* Effect.die(new Error("Usage view distribution is shorter than its population"))
        at = next.value
        weight = next.count
      }
      while (goal <= below) {
        const previous = yield* seek("previous", at)
        if (!previous) return yield* Effect.die(new Error("Usage view distribution is shorter than its rank"))
        at = previous.value
        weight = previous.count
        below -= weight
      }
      yield* db
        .run(
          sql`INSERT INTO usage_view_rank (state, generation, key, quantile, value, below)
          VALUES (${state.id}, ${state.generation}, ${key}, ${quantile}, ${at}, ${below})
          ON CONFLICT (state, generation, key, quantile) DO UPDATE SET value = excluded.value, below = excluded.below`,
        )
        .pipe(Effect.orDie)
    })

    const deltas = (value: UsageViewRecipe.Measures, sign: 1 | -1) => [
      ...UsageViewRecipe.measures.map((name) => [name, sign * value[name]] as const),
      ["total_cost", sign * (value.cost + value.catalog_cost)] as const,
      ["total_tokens", sign * (value.input + value.output + value.reasoning + value.cache_read + value.cache_write)] as const,
    ]

    const upsert = Effect.fnUntraced(function* (
      state: Pick<State, "id" | "generation">,
      key: string,
      row: UsageViewRecipe.Source,
      sign: 1 | -1,
      contribution: UsageViewRecipe.Contribution,
      representative: boolean,
    ) {
      const delta = deltas(contribution.measures, sign)
      const total = key === ""
      if (sign === 1) {
        const better = `(excluded.rep_updated, excluded.rep_session, excluded.rep_request) < (rep_updated, rep_session, rep_request)`
        yield* db
          .run(
            sql`INSERT INTO usage_view_row (state, generation, key, session_id, title, project_id, model, agent, time,
              rep_updated, rep_session, rep_request, ${sql.raw(delta.map(([name]) => name).join(", "))})
            VALUES (${state.id}, ${state.generation}, ${key}, ${total ? "" : row.session_id}, ${total ? "" : row.session_id},
              ${total ? "" : row.project_id}, ${total ? "" : JSON.stringify(row.model)}, ${total ? "" : row.agent},
              ${total ? 0 : row.time_created}, ${representative ? row.session_updated : null},
              ${representative ? row.session_id : null}, ${representative ? row.request : null},
              ${sql.join(
                delta.map(([, value]) => sql`${value}`),
                sql`, `,
              )})
            ON CONFLICT (state, generation, key) DO UPDATE SET
              ${sql.raw(delta.map(([name]) => `${name} = ${name} + excluded.${name}`).join(", "))}
              ${
                representative
                  ? sql.raw(
                      `, model = CASE WHEN ${better} THEN excluded.model ELSE model END,
                      rep_updated = CASE WHEN ${better} THEN excluded.rep_updated ELSE rep_updated END,
                      rep_session = CASE WHEN ${better} THEN excluded.rep_session ELSE rep_session END,
                      rep_request = CASE WHEN ${better} THEN excluded.rep_request ELSE rep_request END`,
                    )
                  : sql``
              }`,
          )
          .pipe(Effect.orDie)
      } else
        yield* db
          .run(
            sql`UPDATE usage_view_row SET ${sql.join(
              delta.map(([name, value]) => sql`${sql.raw(name)} = ${sql.raw(name)} + ${value}`),
              sql`, `,
            )} WHERE ${where(state, key)}`,
          )
          .pipe(Effect.orDie)
      const current = yield* db
        .select()
        .from(UsageViewRowTable)
        .where(
          and(
            eq(UsageViewRowTable.state, state.id),
            eq(UsageViewRowTable.generation, state.generation),
            eq(UsageViewRowTable.key, key),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!current || current.logical <= 0) {
        for (const table of ["usage_view_row", "usage_view_sample", "usage_view_rank"])
          yield* db.run(sql`DELETE FROM ${sql.raw(table)} WHERE ${where(state, key)}`).pipe(Effect.orDie)
        return false
      }
      if (
        sign === -1 &&
        representative &&
        current.rep_updated === row.session_updated &&
        current.rep_session === row.session_id &&
        current.rep_request === row.request
      )
        return true
      if (total) return false
      for (const [metric, value] of contribution.samples) {
        yield* db
          .run(
            sql`INSERT INTO usage_view_sample (state, generation, key, metric, value, count)
            VALUES (${state.id}, ${state.generation}, ${key}, ${metric}, ${value}, ${sign})
            ON CONFLICT (state, generation, key, metric, value) DO UPDATE SET count = count + excluded.count`,
          )
          .pipe(Effect.orDie)
        if (sign === -1)
          yield* db
            .run(sql`DELETE FROM usage_view_sample WHERE ${where(state, key)} AND metric = ${metric} AND count <= 0`)
            .pipe(Effect.orDie)
        for (const [quantile, item] of UsageViewRecipe.quantiles.entries())
          if (item.metric === metric)
            yield* rank(state, key, quantile, metric, item.percent, value, sign, current[UsageViewRecipe.sizes[metric]!])
      }
      return false
    })

    const apply = Effect.fnUntraced(function* (state: State, entries: ReadonlyArray<Entry>) {
      const recipe = UsageViewRecipe.decodeRecipe(state.recipe)
      const formatter = SessionUsageProjection.reportFormatter(recipe)
      let latest = state.latest === null ? undefined : UsageViewRecipe.decodeLatest(state.latest)
      let changed = false
      let added = false
      for (const entry of entries) {
        if (entry.seq <= state.applied_seq) continue
        if (entry.kind === "remove") {
          if (recipe.from === undefined || recipe.from <= entry.through) return { rebuild: true } as const
          continue
        }
        if (!entry.row) return { rebuild: true } as const
        const row = entry.row
        if (!UsageViewRecipe.matches(recipe, row)) continue
        changed = true
        const contribution = UsageViewRecipe.contribution(row, pricing)
        const representative = recipe.group === "model"
        for (const key of UsageViewRecipe.keys(recipe, row, formatter))
          if (yield* upsert(state, key, row, 1, contribution, representative)) return { rebuild: true } as const
        yield* upsert(state, "", row, 1, contribution, false)
        if (contribution.ref)
          added ||=
            (yield* db
              .get<{ ref: string }>(
                sql`INSERT OR IGNORE INTO usage_view_ref (state, generation, location, ref, price)
                VALUES (${state.id}, ${state.generation}, ${contribution.ref.location}, ${contribution.ref.key},
                  ${UsageViewRecipe.price(pricing.get(contribution.ref.key))}) RETURNING ref`,
              )
              .pipe(Effect.orDie)) !== undefined
        if (state.id === UsageViewRecipe.summaryState) {
          const candidate = { time: row.time_created, updated: row.session_updated, session: row.session_id, request: row.request }
          if (!latest || later(latest, candidate) < 0)
            latest = {
              ...candidate,
              invalidation: row.invalidation,
              namespace: row.prompt_cache_key.slice(0, 8),
              timing: row.timing === null ? null : JSON.stringify(row.timing),
            }
        }
      }
      return { rebuild: false, changed, added, latest } as const
    })

    const publish = Effect.fnUntraced(function* (
      state: Pick<State, "id" | "generation" | "latest" | "version">,
      presentation: { readonly id: string; readonly recipe: string },
      projectInfos: ReadonlyArray<Project.Info>,
      projectLabels: string,
    ) {
      const scope = and(eq(UsageViewRowTable.state, state.id), eq(UsageViewRowTable.generation, state.generation))
      if (presentation.id === UsageViewRecipe.summaryPresentation) {
        const groups = (yield* db
          .select()
          .from(UsageViewRowTable)
          .where(and(scope, ne(UsageViewRowTable.key, "")))
          .orderBy(asc(UsageViewRowTable.key))
          .all()
          .pipe(Effect.orDie)).map((row) => ({
          metrics: SessionUsageProjection.usageMetrics(UsageViewRecipe.aggregate(row)),
          model: UsageViewRecipe.decodeModel(row.model),
        }))
        const total = groups.reduce(
          (sum, group) => SessionUsageProjection.combineUsage(sum, group.metrics),
          SessionProviderRequest.reportMetrics([]),
        )
        const latest = state.latest === null ? undefined : UsageViewRecipe.decodeLatest(state.latest)
        return { payload: UsageViewRecipe.encodeSummary(SessionUsageProjection.usageSummary(groups, total, latest)), labels: null }
      }
      const recipe = UsageViewRecipe.decodeRecipe(presentation.recipe)
      const direction = recipe.order === "desc" ? "DESC" : "ASC"
      const order =
        recipe.sort === undefined || recipe.sort === "key"
          ? recipe.group === "hour" && recipe.timeZone
            ? `strftime('%s', key) ${direction}`
            : `key ${direction}`
          : `${UsageViewRecipe.sorts[recipe.sort]} ${direction}, key ASC`
      const page = yield* db
        .select()
        .from(UsageViewRowTable)
        .where(and(scope, ne(UsageViewRowTable.key, "")))
        .orderBy(sql.raw(order))
        .limit(recipe.limit ?? 100)
        .offset(recipe.offset ?? 0)
        .all()
        .pipe(Effect.orDie)
      const ranks = page.length === 0
        ? []
        : yield* db
            .all<{ key: string; quantile: number; value: number }>(
              sql`SELECT key, quantile, value FROM usage_view_rank WHERE state = ${state.id} AND generation = ${state.generation}
              AND key IN (SELECT value FROM json_each(${JSON.stringify(page.map((row) => row.key))}))`,
            )
            .pipe(Effect.orDie)
      const byKey = Map.groupBy(ranks, (item) => item.key)
      const totals = yield* db
        .select()
        .from(UsageViewRowTable)
        .where(and(scope, eq(UsageViewRowTable.key, "")))
        .get()
        .pipe(Effect.orDie)
      const count = (yield* db
        .get<{ count: number }>(
          sql`SELECT count(*) AS count FROM usage_view_row WHERE state = ${state.id} AND generation = ${state.generation} AND key <> ''`,
        )
        .pipe(Effect.orDie))?.count ?? 0
      const formatter = SessionUsageProjection.reportFormatter(recipe)
      const offset = recipe.offset ?? 0
      const report: ProviderRequest.Report = {
        group: recipe.group,
        rows: page.map((row) => {
          const speed = UsageViewRecipe.speed(row, new Map((byKey.get(row.key) ?? []).map((item) => [item.quantile, item.value])))
          return SessionUsageProjection.reportRow(
            recipe.group,
            { ...UsageViewRecipe.aggregate(row), ...(speed === undefined ? {} : { speed }) },
            projectInfos,
            formatter,
          )
        }),
        total: SessionUsageProjection.usageMetrics(
          UsageViewRecipe.aggregate(
            totals ?? {
              ...UsageViewRecipe.zero(),
              state: state.id,
              generation: state.generation,
              key: "",
              session_id: "",
              title: "",
              project_id: "",
              model: "",
              agent: "",
              time: 0,
              rep_updated: null,
              rep_session: null,
              rep_request: null,
              total_cost: 0,
              total_tokens: 0,
            },
          ),
        ),
        rowCount: count,
        ...(offset + page.length < count ? { nextOffset: offset + page.length } : {}),
      }
      return { payload: UsageViewRecipe.encodeReport(report), labels: recipe.group === "project" ? projectLabels : null }
    })

    const republish = Effect.fnUntraced(function* (
      state: State,
      projectInfos: ReadonlyArray<Project.Info>,
      projectLabels: string,
      all: boolean,
    ) {
      const presentations = yield* db
        .all<{ id: string; recipe: string; version: number | null; labels: string | null }>(
          sql`SELECT id, recipe, version, labels FROM usage_view_presentation WHERE state = ${state.id}`,
        )
        .pipe(Effect.orDie)
      for (const presentation of presentations) {
        if (!all && presentation.version === state.version && (presentation.labels === null || presentation.labels === projectLabels))
          continue
        const result = yield* publish(state, presentation, projectInfos, projectLabels)
        yield* db
          .run(
            sql`UPDATE usage_view_presentation SET payload = ${result.payload}, version = ${state.version},
              labels = ${result.labels}, time_published = ${Date.now()} WHERE id = ${presentation.id}`,
          )
          .pipe(Effect.orDie)
      }
    })

    const journal = Effect.fnUntraced(function* (from: number) {
      const entries = yield* db
        .select()
        .from(UsageViewChangeTable)
        .where(gt(UsageViewChangeTable.seq, from))
        .orderBy(asc(UsageViewChangeTable.seq))
        .limit(limits.batch)
        .all()
        .pipe(Effect.orDie)
      const ids = entries.flatMap((entry) => (entry.source === null ? [] : [entry.source]))
      const rows =
        ids.length === 0
          ? []
          : yield* db
              .select()
              .from(UsageAnalyticsRequestTable)
              .where(inArray(UsageAnalyticsRequestTable.id, ids))
              .all()
              .pipe(Effect.orDie)
      const byID = new Map(rows.map((row) => [row.id, row]))
      return entries.map((entry): Entry =>
        entry.kind === "remove"
          ? { seq: entry.seq, kind: "remove", through: entry.through ?? Number.MAX_SAFE_INTEGER }
          : { seq: entry.seq, kind: "append", row: entry.source === null ? undefined : byID.get(entry.source) },
      )
    })

    const catchUp = Effect.fnUntraced(function* () {
      while (true) {
        const ready = yield* states("ready")
        if (ready.length === 0) return
        const current = yield* UsageViewChange.head(db)
        const pruned = yield* UsageViewChange.pruned(db)
        for (const state of ready.filter((state) => state.applied_seq < pruned))
          yield* db.run(sql`UPDATE usage_view_state SET status = 'pending' WHERE id = ${state.id} AND status = 'ready'`).pipe(Effect.orDie)
        const consumers = ready.filter((state) => state.applied_seq >= pruned && (state.refs === 0 || verified.has(state.id)))
        if (consumers.length === 0) return
        const from = Math.min(...consumers.map((state) => state.applied_seq))
        if (from >= current) return
        const entries = yield* journal(from)
        if (entries.length === 0) return
        const needed = entries.flatMap((entry) => {
          const ref = entry.kind === "append" && entry.row ? UsageViewRecipe.contribution(entry.row, pricing).ref : undefined
          return ref
            ? [{ key: ref.key, directory: ref.directory, workspaceID: ref.workspaceID, provider: ref.provider, model: ref.model, profile: ref.profile }]
            : []
        })
        const resolution = yield* resolve(needed).pipe(Effect.exit)
        if (resolution._tag === "Success" && needed.some((ref) => !pricing.has(ref.key))) return
        if (resolution._tag === "Failure") {
          if (Cause.hasInterruptsOnly(resolution.cause)) return yield* Effect.failCause(resolution.cause)
          yield* Effect.logError("Usage view catch-up pricing failed", { failure: failureName(resolution.cause) })
          for (const state of consumers) {
            retries.set(state.id, Date.now() + 30_000)
            yield* db
              .run(sql`UPDATE usage_view_state SET status = 'error', error = ${failure} WHERE id = ${state.id} AND status = 'ready'`)
              .pipe(Effect.orDie)
          }
          return
        }
        const projectInfos = yield* projects.list()
        const projectLabels = yield* labels(db)
        const last = entries.at(-1)!.seq
        yield* db
          .transaction(() =>
            Effect.gen(function* () {
              for (const state of yield* states("ready")) {
                if (state.applied_seq >= last || state.applied_seq < pruned) continue
                if (state.refs > 0 && !verified.has(state.id)) continue
                const result = yield* apply(state, entries)
                if (result.rebuild) {
                  yield* db.run(sql`UPDATE usage_view_state SET status = 'pending' WHERE id = ${state.id}`).pipe(Effect.orDie)
                  continue
                }
                if (!result.changed) {
                  yield* db.run(sql`UPDATE usage_view_state SET applied_seq = ${last} WHERE id = ${state.id}`).pipe(Effect.orDie)
                  continue
                }
                const next = {
                  ...state,
                  applied_seq: last,
                  version: state.version + 1,
                  latest: result.latest ? UsageViewRecipe.encodeLatest(result.latest) : null,
                }
                const refs = result.added
                  ? yield* db
                      .all<{ ref: string; price: string; location: string }>(
                        sql`SELECT ref, price, location FROM usage_view_ref WHERE state = ${state.id} AND generation = ${state.generation}`,
                      )
                      .pipe(Effect.orDie)
                  : undefined
                yield* db
                  .run(
                    sql`UPDATE usage_view_state SET applied_seq = ${last}, version = ${next.version}, latest = ${next.latest}
                      ${refs ? sql`, refs = ${refs.length}, epoch = ${UsageViewRecipe.digest(refs)}` : sql``}
                    WHERE id = ${state.id}`,
                  )
                  .pipe(Effect.orDie)
                if (refs && priced(refs)) verified.set(state.id, new Set(refs.map((row) => row.location)))
                if (refs && !priced(refs)) verified.delete(state.id)
                yield* republish(next, projectInfos, projectLabels, true)
              }
            }),
          )
          .pipe(Effect.orDie)
        yield* Effect.yieldNow
      }
    })

    const purge = Effect.fnUntraced(function* () {
      for (const state of yield* states()) {
        for (const table of ["usage_view_row", "usage_view_sample", "usage_view_rank", "usage_view_ref"]) {
          while (true) {
            yield* db
              .run(
                sql`DELETE FROM ${sql.raw(table)} WHERE rowid IN (SELECT rowid FROM ${sql.raw(table)}
                WHERE state = ${state.id} AND generation ${sql.raw(state.status === "evicted" ? "<=" : "<")} ${state.generation}
                LIMIT ${limits.rows})`,
              )
              .pipe(Effect.orDie)
            const removed = yield* db.get<{ count: number }>(sql`SELECT changes() AS count`).pipe(Effect.orDie)
            yield* Effect.yieldNow
            if ((removed?.count ?? 0) < limits.rows) break
          }
        }
        if (state.status === "evicted")
          yield* db.run(sql`DELETE FROM usage_view_state WHERE id = ${state.id} AND status = 'evicted'`).pipe(Effect.orDie)
      }
      yield* UsageViewChange.collect(db, Date.now())
    })

    const maintain = Effect.fnUntraced(function* () {
      const now = Date.now()
      if (now - maintained < 60_000) return
      maintained = now
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const zones = [...new Set([undefined, zone === "UTC" ? undefined : zone])]
      yield* register(
        wanted(
          zones.flatMap((timeZone) => [
            ...UsageViewRecipe.standard(now, timeZone),
            ...UsageViewRecipe.standard(now + 3_600_000, timeZone),
          ]),
        ),
      )
      if (unavailable.size === 0) return
      const refs = [...unavailable.values()]
      for (const ref of refs) {
        pricing.delete(ref.key)
        pricedAt.delete(ref.key)
        stale.delete(ref.key)
      }
      unavailable.clear()
      yield* resolve(refs)
      for (const ref of refs.filter((ref) => pricing.get(ref.key) !== undefined))
        yield* db
          .run(
            sql`UPDATE usage_view_state SET status = 'pending' WHERE status = 'ready'
            AND id IN (SELECT state FROM usage_view_ref WHERE location = ${UsageViewRecipe.locationKey(ref)})`,
          )
          .pipe(Effect.orDie)
    })

    const isolated = <A, E>(phase: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("Usage view producer phase failed", { phase, failure: failureName(cause) }),
        ),
      )

    const step = Effect.gen(function* () {
      if (!active) {
        yield* UsageViewChange.collect(db, Date.now())
        return
      }
      yield* maintain()
      yield* verify()
      const now = Date.now()
      for (const state of yield* states("error"))
        if ((retries.get(state.id) ?? 0) <= now)
          yield* db.run(sql`UPDATE usage_view_state SET status = 'pending' WHERE id = ${state.id} AND status = 'error'`).pipe(Effect.orDie)
      for (const state of yield* states("pending"))
        if (state.time_used >= now - UsageViewChange.limits.idleMs) yield* build(state)
      yield* isolated("catch-up", catchUp())
      yield* isolated(
        "publication",
        Effect.gen(function* () {
          const projectInfos = yield* projects.list()
          const projectLabels = yield* labels(db)
          for (const state of yield* states("ready"))
            yield* db.transaction(() => republish(state, projectInfos, projectLabels, false)).pipe(
              Effect.orDie,
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.gen(function* () {
                      yield* Effect.logError("Usage view publication failed", { state: state.id, failure: failureName(cause) })
                      retries.set(state.id, Date.now() + 30_000)
                      yield* db
                        .run(sql`UPDATE usage_view_state SET status = 'error', error = ${failure} WHERE id = ${state.id}`)
                        .pipe(Effect.orDie)
                    }),
              ),
            )
        }),
      )
      yield* isolated("maintenance", purge())
    })

    yield* Effect.gen(function* () {
      while (true) {
        wake = Deferred.makeUnsafe<void>()
        yield* step.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("Usage view producer step failed", { failure: failureName(cause) }),
          ),
        )
        yield* Deferred.await(wake).pipe(Effect.timeout(active ? 1_000 : 60_000), Effect.ignore)
      }
    }).pipe(Effect.forkScoped)

    return Service.of({ read, start })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, Project.node],
})
