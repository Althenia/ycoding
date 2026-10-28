import { sql, type SQL } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { SessionSchema } from "./schema"
import type { Location } from "@ycoding-ai/schema/location"
import type { Provider } from "@ycoding-ai/schema/provider"
import type { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import { UsageAnchor } from "@ycoding-ai/schema/usage-anchor"
import type { SessionMessage } from "./message"
import { SessionUsageAttribution } from "./usage-attribution"
import { UsageStage } from "../usage-stage"

const decodeModel = Schema.decodeUnknownSync(Schema.fromJsonString(Model.Ref))
const decodeAnchor = Schema.decodeUnknownSync(Schema.fromJsonString(UsageAnchor.Ref))

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
  failed: number
  cancelled: number
  outcomes: number
}

export type PricingRef = {
  key: string
  directory: string
  workspaceID: string | null
  provider: string
  model: string
  profile: string | null
}

type Db = Database.Interface["db"]

export type Piece = { readonly span: number; readonly lo: number; readonly hi: number }
type Cursor = { readonly bucket: number; readonly key: string }
type Resume = Cursor & { readonly cell: number; readonly context: number }
type Slice = Piece & {
  readonly sessionID?: SessionSchema.ID
  readonly after?: Cursor
  readonly from?: Cursor
  readonly before?: Cursor
}
type Range = { readonly from?: number | undefined; readonly to?: number | undefined }
type Offset = ReturnType<typeof timeZoneOffsets>[number]
export type Plan = { readonly pieces: ReadonlyArray<Piece>; readonly offsets: ReadonlyArray<Offset> }

const [leaf, minute, quarter] = UsageStage.spans
const sliceRows = 10_000
const metricRows = 500
const contextRows = 500
const sampleRows = 2_000
const pageRows = 200
const lowest = -Number.MAX_SAFE_INTEGER
const binMs = 300_000
const hourMs = 3_600_000
const dayMs = 86_400_000

const floorTo = (value: number, span: number) =>
  Number.isFinite(value) ? value - (((value % span) + span) % span) : value
const ceilTo = (value: number, span: number) => {
  const floor = floorTo(value, span)
  return floor === value ? value : floor + span
}

export function pieces(range: Range, cuts: ReadonlyArray<number> = []): Piece[] {
  const from = range.from ?? -Infinity
  const to = range.to ?? Infinity
  if (!(from < to)) return []
  const points = [from, ...cuts.filter((cut) => cut > from && cut < to).toSorted((left, right) => left - right), to]
  const result: Piece[] = []
  const emit = (span: number, lo: number, hi: number) => {
    if (lo < hi) result.push({ span, lo, hi })
  }
  const fine = (lo: number, hi: number) => {
    const start = ceilTo(lo, minute)
    const end = floorTo(hi, minute)
    if (start < end) {
      emit(minute, start, end)
      emit(leaf, lo, start)
      emit(leaf, end, hi)
      return
    }
    emit(leaf, lo, hi)
  }
  for (let index = 0; index + 1 < points.length; index++) {
    const lo = points[index]!
    const hi = points[index + 1]!
    const start = ceilTo(lo, quarter)
    const end = floorTo(hi, quarter)
    if (start < end) {
      emit(quarter, start, end)
      fine(lo, start)
      fine(end, hi)
      continue
    }
    fine(lo, hi)
  }
  return result
    .toSorted((left, right) => left.span - right.span || left.lo - right.lo)
    .reduce<Piece[]>((merged, piece) => {
      const last = merged.at(-1)
      if (last && last.span === piece.span && last.hi === piece.lo) merged[merged.length - 1] = { ...last, hi: piece.hi }
      else merged.push(piece)
      return merged
    }, [])
    .map((piece) => ({
      span: piece.span,
      lo: Math.max(piece.lo, -Number.MAX_SAFE_INTEGER),
      hi: Math.min(piece.hi, Number.MAX_SAFE_INTEGER),
    }))
}

const family = (sessionScoped: boolean) => ({
  name: sql.raw(sessionScoped ? "session_usage_cell" : "usage_analytics_cell"),
  sample: sql.raw(sessionScoped ? "session_usage_cell_sample" : "usage_analytics_cell_sample"),
  unpriced: sql.raw(sessionScoped ? "session_usage_cell_unpriced" : "usage_analytics_cell_unpriced"),
  index: sql.raw(
    sessionScoped ? "session_usage_cell_session_span_bucket_key_idx" : "usage_analytics_cell_span_bucket_key_idx",
  ),
  unpricedIndex: sql.raw(sessionScoped ? "session_usage_cell_unpriced_idx" : "usage_analytics_cell_unpriced_idx"),
  join: sessionScoped ? sql`JOIN session AS s ON s.id = r.session_id` : sql``,
  cross: sessionScoped ? sql`CROSS JOIN session AS s ON s.id = r.session_id` : sql``,
  sessionID: sql<SessionSchema.ID>`r.session_id`,
  title: sessionScoped ? sql<string>`s.title` : sql<string>`r.session_id`,
  projectID: sessionScoped ? sql<string>`s.project_id` : sql<string>`r.project_id`,
  directory: sessionScoped ? sql<string>`s.directory` : sql<string>`r.directory`,
  workspaceID: sessionScoped ? sql<string | null>`s.workspace_id` : sql<string | null>`r.workspace_id`,
  inputID: sessionScoped ? sql<string | null>`r.input_id` : sql<null>`NULL`,
  taskPath: sessionScoped
    ? sql<string>`(WITH RECURSIVE path(id, parent_id, task_id) AS (
    SELECT session.id, session.parent_id, task.session_id FROM session
    LEFT JOIN session_task AS task ON task.session_id = session.id WHERE session.id = r.session_id
    UNION SELECT session.id, session.parent_id, task.session_id FROM session
    JOIN path ON session.id = path.parent_id LEFT JOIN session_task AS task ON task.session_id = session.id
  ) SELECT json_group_array(task_id) FROM path WHERE task_id IS NOT NULL)`
    : sql<string>`r.task_path`,
})

const sliceWhere = (slice: Slice) => sql`r.span = ${slice.span} AND r.bucket >= ${slice.lo} AND r.bucket < ${slice.hi}
    ${slice.sessionID === undefined ? sql`` : sql`AND r.session_id = ${slice.sessionID}`}
    ${slice.after === undefined ? sql`` : sql`AND (r.bucket, r.key) > (${slice.after.bucket}, ${slice.after.key})`}
    ${slice.from === undefined ? sql`` : sql`AND (r.bucket, r.key) >= (${slice.from.bucket}, ${slice.from.key})`}
    ${slice.before === undefined ? sql`` : sql`AND (r.bucket, r.key) <= (${slice.before.bucket}, ${slice.before.key})`}`

const boundary = (db: Db, slice: Slice, unpricedOnly: boolean) => {
  const selected = family(slice.sessionID !== undefined)
  return db
    .get<Cursor>(
      sql`
    SELECT r.bucket, r.key FROM ${selected.name} AS r INDEXED BY ${unpricedOnly ? selected.unpricedIndex : selected.index}
    WHERE ${sliceWhere(slice)} ${unpricedOnly ? sql`AND r.unpriced > 0` : sql``}
    ORDER BY r.bucket, r.key LIMIT 1 OFFSET ${sliceRows - 1}
  `,
    )
    .pipe(Effect.orDie)
}

const slices = Effect.fnUntraced(function* (
  db: Db,
  sessions: ReadonlyArray<SessionSchema.ID> | undefined,
  plan: ReadonlyArray<Piece>,
) {
  const result: Slice[] = []
  for (const sessionID of sessions ?? [undefined]) {
    for (const piece of plan) {
      let after: Cursor | undefined
      while (true) {
        const next = yield* boundary(db, { ...piece, sessionID, after }, false)
        result.push({ ...piece, sessionID, after, before: next })
        yield* Effect.yieldNow
        if (!next) break
        after = next
      }
    }
  }
  return result
})

const decodeCells = <A extends { readonly model: string; readonly usage_anchor: string | null }>(rows: ReadonlyArray<A>) =>
  rows.map((row) => ({
    ...row,
    model: decodeModel(row.model),
    usage_anchor: row.usage_anchor === null ? null : decodeAnchor(row.usage_anchor),
  }))

type Context = { readonly cell: number; readonly context: number; readonly requests: number; readonly tokens: TokenUsage.Info }

type ContextRow = {
  readonly bucket: number
  readonly key: string
  readonly cell: number
  readonly context: number
  readonly requests: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

const contextPage = <A extends ContextRow>(
  db: Db,
  sessionScoped: boolean,
  window: Slice,
  where: SQL,
  at: Resume | undefined,
  limit: number,
  fields: SQL = sql``,
) => {
  const selected = family(sessionScoped)
  return db
    .all<A>(
      sql`
    SELECT r.bucket, r.key, u.cell, u.context, u.requests, u.input, u.output, u.reasoning, u.cache_read AS cacheRead,
      u.cache_write AS cacheWrite ${fields}
    FROM ${selected.name} AS r INDEXED BY ${selected.unpricedIndex} CROSS JOIN ${selected.unpriced} AS u
    WHERE ${where} AND r.unpriced > 0 AND ${sliceWhere(at === undefined ? window : { ...window, after: undefined, from: at })}
      AND u.cell = r.id AND u.requests > 0
      ${at === undefined ? sql`` : sql`AND u.context > CASE WHEN r.id = ${at.cell} THEN ${at.context} ELSE ${lowest} END`}
    ORDER BY r.bucket, r.key, r.id, u.context LIMIT ${limit}
  `,
    )
    .pipe(Effect.orDie)
}

const toContext = (row: ContextRow): Context => ({
  cell: row.cell,
  context: row.context,
  requests: row.requests,
  tokens: {
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cache: { read: row.cacheRead, write: row.cacheWrite },
  },
})

const contextReader = (db: Db, window: Slice, positions: ReadonlyMap<number, number>) => {
  let buffer: ReadonlyArray<ContextRow> = []
  let index = 0
  let complete = false
  return (cell: { readonly id: number; readonly bucket: number; readonly key: string }) =>
    (consume: (context: Context) => void) =>
      Effect.gen(function* () {
        const target = positions.get(cell.id)!
        let at: Resume = { bucket: cell.bucket, key: cell.key, cell: cell.id, context: lowest }
        while (true) {
          while (index < buffer.length && positions.get(buffer[index]!.cell)! < target) index++
          if (index === buffer.length) {
            if (complete) return
            buffer = yield* contextPage<ContextRow>(db, true, window, sql`1`, at, contextRows)
            index = 0
            complete = buffer.length < contextRows
            yield* Effect.yieldNow
            continue
          }
          const row = buffer[index]!
          if (row.cell !== cell.id) return
          consume(toContext(row))
          at = { ...at, context: row.context }
          index++
        }
      })
}

const noContexts = () => Effect.void

type PageCursor = { readonly piece: number; readonly at?: Cursor }

const nextPage = (state: PageCursor, plan: ReadonlyArray<Piece>, at: Cursor | undefined) => {
  const next: PageCursor | undefined = at
    ? { piece: state.piece, at }
    : state.piece + 1 < plan.length
      ? { piece: state.piece + 1 }
      : undefined
  return next === undefined ? undefined : JSON.stringify(next)
}

export const pricingRefs = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  after?: string,
  sessionID?: SessionSchema.ID,
  range: Range = {},
) {
  const plan = pieces(range)
  const state: PageCursor = after === undefined ? { piece: 0 } : JSON.parse(after)
  const piece = plan[state.piece]
  if (!piece) return { refs: [], after: undefined }
  const slice = { ...piece, sessionID, after: state.at }
  const next = yield* boundary(db, slice, true)
  const selected = family(sessionID !== undefined)
  const key = sql`json_array(${selected.directory}, ${selected.workspaceID}, json_extract(r.model, '$.providerID'), json_extract(r.model, '$.id'), json_extract(r.model, '$.profile'))`
  const refs = yield* db
    .all<PricingRef>(
      sql`
    SELECT DISTINCT ${key} AS key, ${selected.directory} AS directory, ${selected.workspaceID} AS workspaceID,
      json_extract(r.model, '$.providerID') AS provider, json_extract(r.model, '$.id') AS model,
      json_extract(r.model, '$.profile') AS profile
    FROM ${selected.name} AS r INDEXED BY ${selected.unpricedIndex} ${selected.join}
    WHERE ${where} AND r.unpriced > 0 AND ${sliceWhere({ ...slice, before: next })}
  `,
    )
    .pipe(Effect.orDie)
  yield* Effect.yieldNow
  return { refs, after: nextPage(state, plan, next) }
})

const cellSums = sql`sum(r.logical) AS logical, sum(r.physical) AS physical, sum(r.helpers) AS helpers,
  sum(r.continued) AS continued, sum(r.fallback) AS fallback, sum(r.input) AS input, sum(r.output) AS output,
  sum(r.reasoning) AS reasoning, sum(r.cache_read) AS cacheRead, sum(r.cache_write) AS cacheWrite,
  min(r.cache_read_reported = r.logical) AS cacheReadReported`

const rollup = sql`sum(logical) AS logical, sum(physical) AS physical, sum(helpers) AS helpers, sum(continued) AS continued,
  sum(fallback) AS fallback, sum(input) AS input, sum(output) AS output, sum(reasoning) AS reasoning,
  sum(cacheRead) AS cacheRead, sum(cacheWrite) AS cacheWrite, sum(cost) AS cost, sum(priced) AS priced,
  min(cacheReadReported) AS cacheReadReported, sum(failed) AS failed, sum(cancelled) AS cancelled, sum(outcomes) AS outcomes`

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
      const count = Math.ceil((input.to - input.from) / binMs)
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
      yield* localCells<{
        providerID: Provider.ID
        profile: string | null
        modelID: Model.ID
        bin: number
        requests: number
        input: number
        output: number
        reasoning: number
        cacheRead: number
        cacheWrite: number
        known: number
        priced: number
      }>(
        db,
        input,
        binMs,
        sql`
      json_extract(r.model, '$.providerID') AS providerID, json_extract(r.model, '$.profile') AS profile,
      json_extract(r.model, '$.id') AS modelID, (r.bucket - ${input.from}) / ${binMs} AS bin,
      sum(r.logical) AS requests, sum(r.input) AS input, sum(r.output) AS output, sum(r.reasoning) AS reasoning,
      sum(r.cache_read) AS cacheRead, sum(r.cache_write) AS cacheWrite, total(r.spend) AS known, sum(r.spend_priced) AS priced
    `,
        sql`1, 2, 3, 4`,
        input.scope.type === "location"
          ? sql`r.directory = ${input.scope.location.directory} AND r.workspace_id IS ${input.scope.location.workspaceID ?? null}`
          : sql`1`,
        (row) => {
          const key = JSON.stringify([row.providerID, row.profile, row.modelID])
          const group = groups.get(key) ?? {
            providerID: row.providerID,
            profile: row.profile,
            modelID: row.modelID,
            bins: Array.from({ length: count }, (_, index) => ({
              start: input.from + index * binMs,
              requests: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              known: 0,
              pricedRequests: 0,
              unpricedRequests: 0,
            })),
          }
          groups.set(key, group)
          const bin = group.bins[row.bin]!
          bin.requests += row.requests
          bin.tokens.input += row.input
          bin.tokens.output += row.output
          bin.tokens.reasoning += row.reasoning
          bin.tokens.cache.read += row.cacheRead
          bin.tokens.cache.write += row.cacheWrite
          bin.known += row.known
          bin.pricedRequests += row.priced
          bin.unpricedRequests += row.requests - row.priced
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
      yield* localCells<{ providerID: Provider.ID; requests: number; known: number; priced: number }>(
        db,
        { from: input.dayStart, to: input.dayEnd },
        undefined,
        sql`json_extract(r.model, '$.providerID') AS providerID, sum(r.logical) AS requests, total(r.spend) AS known,
          sum(r.spend_priced) AS priced`,
        sql`1`,
        sql`1`,
        (row) => {
          const group = groups.get(row.providerID) ?? { known: 0, pricedRequests: 0, unpricedRequests: 0 }
          groups.set(row.providerID, group)
          group.known += row.known
          group.pricedRequests += row.priced
          group.unpricedRequests += row.requests - row.priced
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

const localCells = Effect.fnUntraced(function* <A>(
  db: Db,
  range: { readonly from: number; readonly to: number },
  interval: number | undefined,
  fields: SQL,
  group: SQL,
  filter: SQL,
  consume: (row: A) => void,
) {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from >= range.to)
    return yield* Effect.fail(new Error("Local usage requires an ordered finite millisecond range"))
  const count = interval === undefined ? 0 : Math.ceil((range.to - range.from) / interval)
  const cuts = Array.from({ length: Math.max(count - 1, 0) }, (_, index) => range.from + (index + 1) * interval!)
  for (const slice of yield* slices(db, undefined, pieces(range, cuts))) {
    const rows = yield* db
      .all<A>(
        sql`
      SELECT ${fields} FROM usage_analytics_cell AS r INDEXED BY usage_analytics_cell_span_bucket_key_idx
      WHERE ${filter} AND ${sliceWhere(slice)} GROUP BY ${group}
    `,
      )
      .pipe(Effect.orDie)
    rows.forEach(consume)
    yield* Effect.yieldNow
  }
})

export type ReportRow = Aggregate & { speed?: ProviderRequest.Speed; busy?: number }

export type Cell = {
  readonly record: {
    readonly session_id: SessionSchema.ID
    readonly input_id: SessionMessage.ID | null
    readonly usage_anchor: UsageAnchor.Ref | null
    readonly source: ProviderRequest.Source
    readonly model: Model.Ref
    readonly agent: Agent.ID
    readonly logical: number
    readonly tokens: TokenUsage.Info
    readonly cost: number
    readonly priced: number
  }
  readonly contexts: (consume: (context: Context) => void) => Effect.Effect<void>
  readonly sessionID: SessionSchema.ID
  readonly projectID: string
  readonly directory: string
  readonly workspaceID: string | null
}

export const each = Effect.fnUntraced(function* (
  db: Db,
  sessions: ReadonlyArray<SessionSchema.ID>,
  consume: (row: Cell) => Effect.Effect<void>,
) {
  for (const sessionID of sessions) {
    let after: Cursor | undefined
    while (true) {
      const rows = decodeCells(
        yield* db
          .all<{
            id: number
            bucket: number
            key: string
            session_id: SessionSchema.ID
            input_id: SessionMessage.ID | null
            usage_anchor: string | null
            source: ProviderRequest.Source
            model: string
            agent: Agent.ID
            logical: number
            input: number
            output: number
            reasoning: number
            cacheRead: number
            cacheWrite: number
            cost: number
            priced: number
            unpriced: number
            projectID: string
            directory: string
            workspaceID: string | null
          }>(
            sql`
        SELECT r.id, r.bucket, r.key, r.session_id, r.input_id, r.usage_anchor, r.source, r.model, r.agent, r.logical,
          r.input, r.output, r.reasoning, r.cache_read AS cacheRead, r.cache_write AS cacheWrite, r.cost, r.priced, r.unpriced,
          s.project_id AS projectID, s.directory, s.workspace_id AS workspaceID
        FROM session_usage_cell AS r INDEXED BY session_usage_cell_session_span_bucket_key_idx
        JOIN session AS s ON s.id = r.session_id
        WHERE ${sliceWhere({ span: quarter, lo: -Number.MAX_SAFE_INTEGER, hi: Number.MAX_SAFE_INTEGER, sessionID, after })}
        ORDER BY r.bucket, r.key LIMIT ${sliceRows}
      `,
          )
          .pipe(Effect.orDie),
      )
      const read = contextReader(
        db,
        { span: quarter, lo: -Number.MAX_SAFE_INTEGER, hi: Number.MAX_SAFE_INTEGER, sessionID, after, before: rows.at(-1) },
        new Map(rows.map((row, index) => [row.id, index])),
      )
      for (const row of rows)
        yield* consume({
          record: {
            session_id: row.session_id,
            input_id: row.input_id,
            usage_anchor: row.usage_anchor,
            source: row.source,
            model: row.model,
            agent: row.agent,
            logical: row.logical,
            tokens: {
              input: row.input,
              output: row.output,
              reasoning: row.reasoning,
              cache: { read: row.cacheRead, write: row.cacheWrite },
            },
            cost: row.cost,
            priced: row.priced,
          },
          contexts: row.unpriced > 0 ? read(row) : noContexts,
          sessionID: row.session_id,
          projectID: row.projectID,
          directory: row.directory,
          workspaceID: row.workspaceID,
        })
      yield* Effect.yieldNow
      if (rows.length < sliceRows) break
      after = rows.at(-1)!
    }
    yield* Effect.yieldNow
  }
})

const anchorHints = Effect.fnUntraced(function* (db: Db, ranges: ReadonlyArray<Slice>) {
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_anchor_hint (session_id TEXT, input_id TEXT, anchor TEXT, PRIMARY KEY(session_id, input_id)) WITHOUT ROWID`,
    )
    .pipe(Effect.orDie)
  for (const slice of ranges) {
    const sessionID = slice.sessionID!
    const inputs = yield* db
      .all<{ inputID: SessionMessage.ID }>(
        sql`
      SELECT DISTINCT r.input_id AS inputID FROM session_usage_cell AS r INDEXED BY session_usage_cell_session_span_bucket_key_idx
      WHERE ${sliceWhere(slice)} AND r.usage_anchor IS NULL AND r.input_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM temp.usage_anchor_hint AS h WHERE h.session_id = r.session_id AND h.input_id = r.input_id)
    `,
      )
      .pipe(Effect.orDie)
    for (const [index, row] of inputs.entries()) {
      const anchor = yield* SessionUsageAttribution.resolve(db, { sessionID, inputID: row.inputID })
      yield* db
        .run(
          sql`INSERT INTO temp.usage_anchor_hint VALUES (${sessionID}, ${row.inputID}, ${anchor ? JSON.stringify(anchor) : null})`,
        )
        .pipe(Effect.orDie)
      if (index % pageRows === pageRows - 1) yield* Effect.yieldNow
    }
    yield* Effect.yieldNow
  }
})

const hintJoin = sql`LEFT JOIN temp.usage_anchor_hint AS h ON h.session_id = r.session_id AND h.input_id = r.input_id`

const stage = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  raw: SQL,
  sessions: ReadonlyArray<SessionSchema.ID> | undefined,
  group: ReportGroup,
  plan: Plan,
) {
  const attribution = group === "prompt" && sessions !== undefined
  yield* db.run(sql`DROP TABLE IF EXISTS temp.usage_partial`).pipe(Effect.orDie)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_partial (raw TEXT, sessionID TEXT, title TEXT, projectID TEXT,
        model TEXT, agent TEXT, time INTEGER, logical INTEGER, physical INTEGER, helpers INTEGER, continued INTEGER,
        fallback INTEGER, input INTEGER, output INTEGER, reasoning INTEGER, cacheRead INTEGER, cacheWrite INTEGER,
        cacheReadReported INTEGER, cost REAL, priced INTEGER, failed INTEGER, cancelled INTEGER, outcomes INTEGER)`,
    )
    .pipe(Effect.orDie)
  const ranges = yield* slices(db, sessions, plan.pieces)
  if (attribution) yield* anchorHints(db, ranges)
  for (const slice of ranges) {
    const selected = family(slice.sessionID !== undefined)
    yield* db
      .run(
        sql`
      INSERT INTO temp.usage_partial
      SELECT ${raw}, ${selected.sessionID}, ${selected.title}, ${selected.projectID}, ${group === "model" ? sql`NULL` : sql`r.model`}, r.agent, r.bucket,
        ${cellSums}, total(r.cost), sum(r.priced), sum(r.failed), sum(r.cancelled), sum(r.outcomes)
      FROM ${selected.name} AS r INDEXED BY ${selected.index} ${selected.join}
      ${attribution ? hintJoin : sql``}
      WHERE ${where} AND ${sliceWhere(slice)} GROUP BY 1
    `,
      )
      .pipe(Effect.orDie)
    yield* Effect.yieldNow
  }
  return ranges
})

const release = (db: Db, table: string) => db.run(sql.raw(`DROP TABLE IF EXISTS temp.${table}`)).pipe(Effect.orDie)

const history: Plan = { pieces: pieces({}), offsets: [] }

export const models = Effect.fn("SessionUsageRead.models")(
  function* (db: Db, where: SQL, sessions?: ReadonlyArray<SessionSchema.ID>) {
    yield* stage(db, where, sql`r.model`, sessions, "model", history)
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
  plan: Plan
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

function zoneCuts(group: ReportGroup, offsets: ReadonlyArray<Offset>, last: number) {
  const cuts: number[] = []
  offsets.forEach((offset, index) => {
    const end = offsets[index + 1]?.start ?? last + 1
    if (index > 0 && floorTo(offset.start, quarter) !== offset.start) cuts.push(offset.start)
    const shift = offset.seconds * 1000
    if (floorTo(shift, quarter) === shift) return
    const step = group === "hour" ? hourMs : dayMs
    for (let time = ceilTo(offset.start + shift, step) - shift; time < end; time += step)
      if (group !== "month" || new Date(time + shift).getUTCDate() === 1) cuts.push(time)
  })
  return cuts
}

const endpoints = Effect.fnUntraced(function* (db: Db, range: Range, sessions?: ReadonlyArray<SessionSchema.ID>) {
  let first = Infinity
  let last = -Infinity
  const window = pieces(range).map((piece) => ({ ...piece, span: leaf }))
  const lo = window.length === 0 ? 0 : Math.min(...window.map((piece) => piece.lo))
  const hi = window.length === 0 ? 0 : Math.max(...window.map((piece) => piece.hi))
  for (const sessionID of sessions ?? [undefined]) {
    const selected = family(sessionID !== undefined)
    for (const order of [sql`ASC`, sql`DESC`]) {
      const row = yield* db
        .get<{ bucket: number }>(
          sql`
        SELECT r.bucket FROM ${selected.name} AS r INDEXED BY ${selected.index}
        WHERE ${sliceWhere({ span: leaf, lo, hi, sessionID })}
        ORDER BY r.bucket ${order} LIMIT 1
      `,
        )
        .pipe(Effect.orDie)
      if (row) {
        first = Math.min(first, row.bucket)
        last = Math.max(last, row.bucket)
      }
    }
    yield* Effect.yieldNow
  }
  return first <= last ? { first, last } : undefined
})

export const plan = Effect.fnUntraced(function* (
  db: Db,
  input: {
    readonly group: ReportGroup
    readonly from?: number | undefined
    readonly to?: number | undefined
    readonly timeZone?: string | undefined
    readonly sessions?: ReadonlyArray<SessionSchema.ID> | undefined
  },
) {
  const range = { from: input.from, to: input.to }
  if (!input.timeZone || !["hour", "day", "month"].includes(input.group))
    return { pieces: pieces(range), offsets: [] } satisfies Plan
  const ends = yield* endpoints(db, range, input.sessions)
  if (!ends) return { pieces: pieces(range), offsets: [] } satisfies Plan
  const offsets = timeZoneOffsets(input.timeZone, floorTo(ends.first, quarter), ends.last)
  return { pieces: pieces(range, zoneCuts(input.group, offsets, ends.last)), offsets } satisfies Plan
})

const groupKey = (group: ReportGroup, plan: Plan, sessions?: ReadonlyArray<SessionSchema.ID>) => {
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
  if (group === "task") return { raw: family(sessions !== undefined).taskPath, key: sql`json_array('task', task.value)` }
  if (group === "session") return { raw: family(sessions !== undefined).sessionID, key: sql`raw` }
  if (group === "project") return { raw: family(sessions !== undefined).projectID, key: sql`raw` }
  if (group === "agent") return { raw: sql`r.agent`, key: sql`raw` }
  const format = group === "hour" ? "%Y-%m-%dT%H:00:00" : group === "day" ? "%Y-%m-%d" : "%Y-%m"
  if (plan.offsets.length === 0)
    return {
      raw: sql`strftime(${format + (group === "hour" ? ".000Z" : "")}, r.bucket / 1000.0, 'unixepoch')`,
      key: sql`raw`,
    }
  const seconds = sql`CASE ${sql.join(
    plan.offsets.toReversed().map((offset) => sql`WHEN r.bucket >= ${offset.start} THEN ${offset.seconds}`),
    sql` `,
  )} ELSE 0 END`
  const label = sql`CASE ${sql.join(
    plan.offsets.toReversed().map((offset) => sql`WHEN r.bucket >= ${offset.start} THEN ${offset.label}`),
    sql` `,
  )} ELSE '+00:00' END`
  return {
    raw: sql`strftime(${format}, r.bucket / 1000.0 + (${seconds}), 'unixepoch') ${group === "hour" ? sql`|| (${label})` : sql``}`,
    key: sql`raw`,
  }
}

type BuildCursor = {
  readonly bucket: number
  readonly cell_key: string
  readonly cell: number
  readonly key: string
  readonly metric: number
  readonly value: number
}

const buildSamples = 10_000

export const materialize = Effect.fnUntraced(function* (
  db: Db,
  input: { readonly where: SQL; readonly group: ReportGroup; readonly plan: Plan },
) {
  const key = groupKey(input.group, input.plan)
  const raw = input.group === "model" ? sql`r.model` : key.raw
  for (const table of ["usage_build_row", "usage_build_slot", "usage_build_stat", "usage_build_sample", "usage_build_rep"])
    yield* release(db, table)
  const ranges = yield* stage(db, input.where, key.raw, undefined, input.group, input.plan)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_build_row (key TEXT PRIMARY KEY, session_id TEXT, title TEXT, project_id TEXT, model TEXT,
        agent TEXT, time INTEGER, logical INTEGER, physical INTEGER, helpers INTEGER, continued INTEGER, fallback INTEGER,
        input INTEGER, output INTEGER, reasoning INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, priced INTEGER,
        failed INTEGER, cancelled INTEGER, outcomes INTEGER)`,
    )
    .pipe(Effect.orDie)
  const partial = sql`FROM temp.usage_partial ${input.group === "task" ? sql`LEFT JOIN json_each(raw) AS task` : sql``}`
  yield* db
    .run(
      sql`INSERT INTO temp.usage_build_row
    SELECT CAST(${key.key} AS TEXT), sessionID, title, projectID, ${input.group === "model" ? sql`raw` : sql`model`}, agent, time,
      sum(logical), sum(physical), sum(helpers), sum(continued), sum(fallback), sum(input), sum(output), sum(reasoning),
      sum(cacheRead), sum(cacheWrite), sum(cost), sum(priced), sum(failed), sum(cancelled), sum(outcomes)
    ${partial} GROUP BY 1`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`INSERT INTO temp.usage_build_row
    SELECT '', '', '', '', '', '', 0, coalesce(sum(logical), 0), coalesce(sum(physical), 0), coalesce(sum(helpers), 0),
      coalesce(sum(continued), 0), coalesce(sum(fallback), 0), coalesce(sum(input), 0), coalesce(sum(output), 0),
      coalesce(sum(reasoning), 0), coalesce(sum(cacheRead), 0), coalesce(sum(cacheWrite), 0), coalesce(sum(cost), 0),
      coalesce(sum(priced), 0), coalesce(sum(failed), 0), coalesce(sum(cancelled), 0), coalesce(sum(outcomes), 0)
    FROM temp.usage_partial`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(sql`CREATE TEMP TABLE usage_build_slot (raw TEXT, key TEXT, PRIMARY KEY(raw, key)) WITHOUT ROWID`)
    .pipe(Effect.orDie)
  yield* db
    .run(sql`INSERT OR IGNORE INTO temp.usage_build_slot SELECT raw, CAST(${key.key} AS TEXT) ${partial}`)
    .pipe(Effect.orDie)
  if (input.group === "task")
    yield* db
      .run(sql`INSERT OR IGNORE INTO temp.usage_build_slot SELECT DISTINCT raw, '' FROM temp.usage_partial`)
      .pipe(Effect.orDie)
  yield* release(db, "usage_partial")
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_build_stat (key TEXT PRIMARY KEY, reported INTEGER, first_output INTEGER, total_output INTEGER,
        generation_samples INTEGER, provider_timed INTEGER, observed INTEGER, generation_tokens REAL, generation_duration REAL,
        generation_rate REAL, busy_ms INTEGER)`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_build_sample (key TEXT, metric INTEGER, value REAL, count INTEGER, PRIMARY KEY(key, metric, value)) WITHOUT ROWID`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(sql`CREATE TEMP TABLE usage_build_rep (key TEXT PRIMARY KEY, updated INTEGER, session TEXT, request INTEGER, model TEXT)`)
    .pipe(Effect.orDie)
  const heavy = Effect.fnUntraced(function* (cell: number) {
    let at: Omit<BuildCursor, "bucket" | "cell_key" | "cell"> | undefined
    while (true) {
      const cursor = at
      const page = sql`SELECT s.key AS key, m.metric AS metric, m.value AS value, m.count AS count
        FROM usage_analytics_cell AS r JOIN temp.usage_build_slot AS s ON s.raw = ${raw}
          ${cursor === undefined ? sql`` : sql`AND s.key >= ${cursor.key}`}
        CROSS JOIN usage_analytics_cell_sample AS m
        WHERE r.id = ${cell} AND m.cell = r.id
          ${
            cursor === undefined
              ? sql``
              : sql`AND (m.metric, m.value) > (CASE WHEN s.key = ${cursor.key} THEN ${cursor.metric} ELSE -1 END,
            CASE WHEN s.key = ${cursor.key} THEN ${cursor.value} ELSE -9e999 END)`
          }
        ORDER BY s.key, m.metric, m.value`
      const last = yield* db
        .get<Omit<BuildCursor, "bucket" | "cell_key" | "cell">>(sql`${page} LIMIT 1 OFFSET ${sql.raw(String(buildSamples - 1))}`)
        .pipe(Effect.orDie)
      yield* db
        .run(
          sql`INSERT INTO temp.usage_build_sample SELECT key, metric, value, sum(count)
        FROM (${page} LIMIT ${sql.raw(String(buildSamples))}) WHERE 1
        GROUP BY 1, 2, 3 ON CONFLICT (key, metric, value) DO UPDATE SET count = count + excluded.count`,
        )
        .pipe(Effect.orDie)
      yield* Effect.yieldNow
      if (!last) return
      at = last
    }
  })
  for (const slice of ranges) {
    const cells = sql`FROM usage_analytics_cell AS r INDEXED BY usage_analytics_cell_span_bucket_key_idx
      JOIN temp.usage_build_slot AS s ON s.raw = ${raw}`
    yield* db
      .run(
        sql`INSERT INTO temp.usage_build_stat
      SELECT s.key, sum(r.cache_read_reported), sum(r.first_output), sum(r.total_output), sum(r.generation_samples),
        sum(r.provider_timed), sum(r.observed), total(r.generation_tokens), total(r.generation_duration),
        total(r.generation_rate), sum(r.busy_ms)
      ${cells} WHERE ${input.where} AND ${sliceWhere(slice)} GROUP BY s.key
      ON CONFLICT (key) DO UPDATE SET reported = reported + excluded.reported, first_output = first_output + excluded.first_output,
        total_output = total_output + excluded.total_output, generation_samples = generation_samples + excluded.generation_samples,
        provider_timed = provider_timed + excluded.provider_timed, observed = observed + excluded.observed,
        generation_tokens = generation_tokens + excluded.generation_tokens,
        generation_duration = generation_duration + excluded.generation_duration,
        generation_rate = generation_rate + excluded.generation_rate, busy_ms = busy_ms + excluded.busy_ms`,
      )
      .pipe(Effect.orDie)
    const members = yield* db
      .all<{ id: number; weight: number }>(
        sql`SELECT r.id, r.first_output + r.total_output + r.generation_samples AS weight
        FROM usage_analytics_cell AS r INDEXED BY usage_analytics_cell_span_bucket_key_idx
        WHERE ${input.where} AND ${sliceWhere(slice)} ORDER BY r.bucket, r.key`,
      )
      .pipe(Effect.orDie)
    let batch: number[] = []
    let weight = 0
    const flush = Effect.suspend(() => {
      if (batch.length === 0) return Effect.void
      const ids = batch
      batch = []
      weight = 0
      return db
        .run(
          sql`INSERT INTO temp.usage_build_sample
        SELECT s.key, m.metric, m.value, sum(m.count)
        FROM usage_analytics_cell AS r JOIN temp.usage_build_slot AS s ON s.raw = ${raw}
        CROSS JOIN usage_analytics_cell_sample AS m
        WHERE r.id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND m.cell = r.id
        GROUP BY 1, 2, 3 ON CONFLICT (key, metric, value) DO UPDATE SET count = count + excluded.count`,
        )
        .pipe(Effect.orDie, Effect.andThen(Effect.yieldNow))
    })
    for (const member of members) {
      if (member.weight > buildSamples) {
        yield* flush
        yield* heavy(member.id)
        continue
      }
      if (weight + member.weight > buildSamples) yield* flush
      batch.push(member.id)
      weight += member.weight
    }
    yield* flush
    if (input.group === "model")
      yield* db
        .run(
          sql`INSERT INTO temp.usage_build_rep
        SELECT key, updated, session, request, model FROM (
          SELECT s.key AS key, r.first_updated AS updated, r.session_id AS session, r.first_request AS request, r.model AS model,
            row_number() OVER (PARTITION BY s.key ORDER BY r.first_updated, r.session_id, r.first_request) AS position
          ${cells} WHERE ${input.where} AND ${sliceWhere(slice)}
        ) WHERE position = 1
        ON CONFLICT (key) DO UPDATE SET updated = excluded.updated, session = excluded.session, request = excluded.request,
          model = excluded.model WHERE (excluded.updated, excluded.session, excluded.request) < (updated, session, request)`,
        )
        .pipe(Effect.orDie)
    yield* Effect.yieldNow
  }
  if (input.group === "task") return
  yield* db
    .run(
      sql`INSERT INTO temp.usage_build_stat
    SELECT '', coalesce(sum(reported), 0), coalesce(sum(first_output), 0), coalesce(sum(total_output), 0),
      coalesce(sum(generation_samples), 0), coalesce(sum(provider_timed), 0), coalesce(sum(observed), 0),
      total(generation_tokens), total(generation_duration), total(generation_rate), coalesce(sum(busy_ms), 0)
    FROM temp.usage_build_stat`,
    )
    .pipe(Effect.orDie)
  let after: { readonly key: string; readonly metric: number; readonly value: number } | undefined
  while (true) {
    const from = after === undefined ? sql`key > ''` : sql`(key, metric, value) > (${after.key}, ${after.metric}, ${after.value})`
    const boundary = yield* db
      .get<{ key: string; metric: number; value: number }>(
        sql`SELECT key, metric, value FROM temp.usage_build_sample WHERE ${from}
        ORDER BY key, metric, value LIMIT 1 OFFSET ${sql.raw(String(buildSamples - 1))}`,
      )
      .pipe(Effect.orDie)
    yield* db
      .run(
        sql`INSERT INTO temp.usage_build_sample SELECT '', metric, value, count FROM temp.usage_build_sample
        WHERE ${from} ${boundary === undefined ? sql`` : sql`AND (key, metric, value) <= (${boundary.key}, ${boundary.metric}, ${boundary.value})`}
        ON CONFLICT (key, metric, value) DO UPDATE SET count = count + excluded.count`,
      )
      .pipe(Effect.orDie)
    yield* Effect.yieldNow
    if (!boundary) return
    after = boundary
  }
})

type ReportSqlRow = Aggregate & { kind: number; raws: string | null; rowCount: number | null }

export const report = Effect.fn("SessionUsageRead.report")(
  function* (db: Db, input: ReportInput) {
    const key = groupKey(input.group, input.plan, input.sessions)
    const ranges = yield* stage(db, input.where, key.raw, input.sessions, input.group, input.plan)
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
      (c.correction IS NOT NULL) AS currentCatalog, k.failed, k.cancelled, k.outcomes, k.raws, NULL AS rowCount
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
    min(cacheReadReported), 0, coalesce(sum(failed), 0), coalesce(sum(cancelled), 0), coalesce(sum(outcomes), 0), NULL,
    (SELECT count(*) FROM keyed)
  FROM temp.usage_partial
`,
      )
      .pipe(Effect.orDie)
    yield* release(db, "usage_partial")
    const total = result.find((row) => row.kind === 1)!
    const page = result.filter((row) => row.kind === 0)
    const measured = yield* speed(db, input.where, input.group, key, page, ranges, input.sessions)
    const models =
      input.group === "model"
        ? yield* ambiguousModels(db, input.where, page, ranges, input.sessions)
        : new Map<string, string>()
    return {
      rows: page.map((row): ReportRow => ({
        ...row,
        ...(models.has(row.key) ? { model: models.get(row.key)! } : {}),
        ...measured.observations.get(row.key),
      })),
      total,
      rowCount: total.rowCount!,
      ...(measured.overall === undefined ? {} : { speed: measured.overall }),
    }
  },
  (effect, db) =>
    Effect.ensuring(
      effect,
      Effect.all([
        release(db, "usage_partial"),
        release(db, "usage_slot"),
        release(db, "usage_metric"),
        release(db, "usage_sample"),
        release(db, "usage_anchor_hint"),
      ]),
    ),
)

const decodeRaws = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

type SampleCursor = Cursor & {
  readonly cell: number
  readonly slot: number
  readonly metric: number
  readonly value: number
}

const overallSlot = -1

const speed = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  group: ReportGroup,
  key: { readonly raw: SQL },
  page: ReadonlyArray<ReportSqlRow>,
  ranges: ReadonlyArray<Slice>,
  sessions?: ReadonlyArray<SessionSchema.ID>,
) {
  const observations = new Map<string, { speed: ProviderRequest.Speed; busy?: number }>()
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
    .run(
      sql`CREATE TEMP TABLE usage_metric (slot INTEGER, metric INTEGER, value, count INTEGER NOT NULL, PRIMARY KEY(slot, metric, value)) WITHOUT ROWID`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`CREATE TEMP TABLE usage_sample (bucket INTEGER, key TEXT, cell INTEGER, slot INTEGER, metric INTEGER, value, count INTEGER)`,
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
    rate: number
    busy: number
  }
  const attribution = group === "prompt" && sessions !== undefined
  const sampled = new Map<number, Stats>()
  const targets = [
    ...(page.length === 0
      ? []
      : [
          {
            join: sql`JOIN temp.usage_slot ON usage_slot.raw = ${group === "model" ? sql`r.model` : key.raw}`,
            slot: sql`usage_slot.slot`,
            order: sql`, usage_slot.slot`,
            resume: (cursor: SampleCursor) =>
              sql`AND usage_slot.slot >= CASE WHEN r.id = ${cursor.cell} THEN ${cursor.slot} ELSE -1 END`,
          },
        ]),
    { join: sql``, slot: sql.raw(`${overallSlot}`), order: sql``, resume: () => sql`` },
  ]
  for (const slice of ranges)
    for (const target of targets) {
      const selected = family(slice.sessionID !== undefined)
      const cells = sql`FROM ${selected.name} AS r INDEXED BY ${selected.index} ${selected.join}
      ${attribution ? hintJoin : sql``}
      ${target.join}`
      const rows = yield* db
        .all<Stats>(
          sql`
      SELECT ${target.slot} AS slot, sum(r.first_output) AS first, sum(r.total_output) AS total,
        sum(r.generation_samples) AS generationSamples, sum(r.provider_timed) AS providerTimedSamples,
        sum(r.observed) AS observedSamples, total(r.generation_tokens) AS tokens, total(r.generation_duration) AS duration,
        total(r.generation_rate) AS rate, total(r.busy_ms) AS busy
      ${cells}
      WHERE ${where} AND ${sliceWhere(slice)} GROUP BY slot
    `,
        )
        .pipe(Effect.orDie)
      yield* Effect.yieldNow
      let at: SampleCursor | undefined
      while (true) {
        const cursor = at
        const current =
          cursor === undefined ? sql`` : sql`r.id = ${cursor.cell} AND ${target.slot} = ${cursor.slot}`
        yield* db
          .run(
            sql`
      INSERT INTO temp.usage_sample
      SELECT r.bucket, r.key, r.id, ${target.slot}, m.metric, m.value, m.count
      FROM ${selected.name} AS r INDEXED BY ${selected.index} ${selected.cross}
      ${attribution ? hintJoin : sql``}
      ${target.join}
        ${cursor === undefined ? sql`` : target.resume(cursor)}
      CROSS JOIN ${selected.sample} AS m
      WHERE ${where} AND ${sliceWhere(cursor === undefined ? slice : { ...slice, after: undefined, from: cursor })} AND m.cell = r.id
        ${
          cursor === undefined
            ? sql``
            : sql`AND (m.metric, m.value) > (CASE WHEN ${current} THEN ${cursor.metric} ELSE -1 END,
          CASE WHEN ${current} THEN ${cursor.value} ELSE -1 END)`
        }
      ORDER BY r.bucket, r.key, r.id${target.order}, m.metric, m.value LIMIT ${sql.raw(String(sampleRows))}
    `,
          )
          .pipe(Effect.orDie)
        const last = yield* db
          .get<SampleCursor & { rows: number }>(
            sql`
      SELECT (SELECT count(*) FROM temp.usage_sample) AS rows, bucket, key, cell, slot, metric, value FROM temp.usage_sample
      ORDER BY bucket DESC, key DESC, cell DESC, slot DESC, metric DESC, value DESC LIMIT 1
    `,
          )
          .pipe(Effect.orDie)
        yield* db
          .run(
            sql`
      INSERT INTO temp.usage_metric SELECT slot, metric, value, sum(count) FROM temp.usage_sample WHERE 1 GROUP BY 1, 2, 3
      ON CONFLICT (slot, metric, value) DO UPDATE SET count = count + excluded.count
    `,
          )
          .pipe(Effect.orDie)
        yield* db.run(sql`DELETE FROM temp.usage_sample`).pipe(Effect.orDie)
        yield* Effect.yieldNow
        if (!last || last.rows < sampleRows) break
        at = last
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
          rate: (current?.rate ?? 0) + row.rate,
          busy: (current?.busy ?? 0) + row.busy,
        })
      }
    }
  let overall: ProviderRequest.Speed | undefined
  for (const row of sampled.values()) {
    if (row.first === 0 && row.total === 0 && row.duration === 0) continue
    const first = yield* percentiles(db, row.slot, 0, row.first)
    const total = yield* percentiles(db, row.slot, 1, row.total)
    const generation = yield* percentiles(db, row.slot, 2, row.generationSamples)
    const measured: ProviderRequest.Speed = {
      samples: row.first,
      generationSamples: row.generationSamples,
      providerTimedSamples: row.providerTimedSamples,
      observedSamples: row.observedSamples,
      ...(generation
        ? {
            generationP50TokensPerSecond: generation[0],
            generationP90TokensPerSecond: generation[1],
            generationP95TokensPerSecond: generation[2],
            meanTokensPerSecond: row.rate / row.generationSamples,
          }
        : {}),
      ...(first ? { firstOutputP50Ms: first[0], firstOutputP95Ms: first[1], firstOutputP99Ms: first[2] } : {}),
      ...(total ? { totalP50Ms: total[0], totalP95Ms: total[1], totalP99Ms: total[2] } : {}),
      ...(row.duration === 0 ? {} : { outputTokensPerSecond: row.tokens / (row.duration / 1_000_000_000) }),
    }
    if (row.slot === overallSlot) overall = measured
    else observations.set(page[row.slot].key, { speed: measured, ...(row.total === 0 ? {} : { busy: row.busy }) })
  }
  return { observations, overall }
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
      const selected = family(slice.sessionID !== undefined)
      const candidate = yield* db
        .get<Candidate>(
          sql`
        SELECT r.model AS model, r.first_updated AS updated, ${selected.sessionID} AS sessionID, r.first_request AS request,
          ${sessions ? sql`CAST(family.key AS INTEGER)` : sql`0`} AS family
        FROM ${selected.name} AS r INDEXED BY ${selected.index} ${selected.join}
        ${sessions ? sql`JOIN json_each(${JSON.stringify(sessions)}) AS family ON family.value = s.id` : sql``}
        WHERE ${where} AND ${sliceWhere(slice)} AND r.model IN (SELECT value FROM json_each(${item.raws}))
        ORDER BY ${sessions ? sql`family, r.first_request` : sql`r.first_updated, ${selected.sessionID}, r.first_request`} LIMIT 1
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
  const targets = (metric === 2 ? [50, 90, 95] : [50, 95, 99]).map((percent) => Math.ceil((size * percent) / 100))
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

export type Unpriced = {
  readonly record: {
    readonly model: Model.Ref
    readonly tokens: TokenUsage.Info
    readonly agent: Agent.ID
    readonly time_created: number
    readonly usage_anchor: UsageAnchor.Ref | null
  }
  readonly requests: number
  readonly context: number
  readonly inputID: SessionMessage.ID | null
  readonly taskPath: string
  readonly sessionID: SessionSchema.ID
  readonly title: string
  readonly projectID: string
  readonly directory: string
  readonly workspaceID: string | null
}

type UnpricedCursor = {
  readonly piece: number
  readonly after?: Cursor
  readonly at?: Resume
  readonly before?: Cursor | null
}

type UnpricedRow = ContextRow & {
  readonly model: string
  readonly agent: Agent.ID
  readonly usage_anchor: string | null
  readonly inputID: SessionMessage.ID | null
  readonly sessionID: SessionSchema.ID
  readonly taskPath?: string
  readonly projectID?: string
  readonly directory?: string
  readonly workspaceID?: string | null
}

type Owner = {
  readonly title: string
  readonly projectID: string
  readonly directory: string
  readonly workspaceID: string | null
  readonly taskPath: string
}

export const unpriced = Effect.fnUntraced(function* (
  db: Db,
  where: SQL,
  after: string | undefined,
  sessionID: SessionSchema.ID | undefined,
  plan: ReadonlyArray<Piece>,
) {
  const sessionScoped = sessionID !== undefined
  const selected = family(sessionScoped)
  const owner =
    sessionID === undefined
      ? undefined
      : yield* db
          .get<Owner>(
            sql`
      SELECT s.title AS title, s.project_id AS projectID, s.directory AS directory, s.workspace_id AS workspaceID,
        ${selected.taskPath} AS taskPath
      FROM session AS s CROSS JOIN (SELECT ${sessionID} AS session_id) AS r WHERE s.id = r.session_id
    `,
          )
          .pipe(Effect.orDie)
  if (sessionScoped && !owner) return { rows: [] as Unpriced[], after: undefined }
  const fields = sql`, r.model AS model, r.agent AS agent, r.usage_anchor AS usage_anchor, ${selected.inputID} AS inputID,
    r.session_id AS sessionID ${
      sessionScoped
        ? sql``
        : sql`, r.task_path AS taskPath, r.project_id AS projectID, r.directory AS directory, r.workspace_id AS workspaceID`
    }`
  const decode = (row: UnpricedRow): Unpriced => ({
    record: {
      model: decodeModel(row.model),
      tokens: toContext(row).tokens,
      agent: row.agent,
      time_created: row.bucket,
      usage_anchor: row.usage_anchor === null ? null : decodeAnchor(row.usage_anchor),
    },
    requests: row.requests,
    context: row.context,
    inputID: row.inputID,
    taskPath: owner ? owner.taskPath : row.taskPath!,
    sessionID: row.sessionID,
    title: owner ? owner.title : row.sessionID,
    projectID: owner ? owner.projectID : row.projectID!,
    directory: owner ? owner.directory : row.directory!,
    workspaceID: owner ? owner.workspaceID : (row.workspaceID ?? null),
  })
  let state: UnpricedCursor = after === undefined ? { piece: 0 } : JSON.parse(after)
  const rows: Unpriced[] = []
  while (rows.length < pageRows) {
    const piece = plan[state.piece]
    if (!piece) return { rows, after: undefined }
    const window: Slice = { ...piece, sessionID, after: state.after }
    const before = state.before === undefined ? yield* boundary(db, window, true) : (state.before ?? undefined)
    const limit = pageRows - rows.length
    const page = yield* contextPage<UnpricedRow>(db, sessionScoped, { ...window, before }, where, state.at, limit, fields)
    yield* Effect.yieldNow
    for (const row of page) rows.push(decode(row))
    const last = page.at(-1)
    if (last && page.length === limit) {
      state = {
        piece: state.piece,
        after: state.after,
        at: { bucket: last.bucket, key: last.key, cell: last.cell, context: last.context },
        before: before ?? null,
      }
      break
    }
    state = before === undefined ? { piece: state.piece + 1 } : { piece: state.piece, after: before }
  }
  return { rows, after: JSON.stringify(state) }
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
  for (const [index, sessionID] of (sessions ?? [undefined]).entries()) {
    const selected = family(sessionID !== undefined)
    const scope = sql`r.span = ${leaf} ${sessionID === undefined ? sql`` : sql`AND r.session_id = ${sessionID}`}`
    let upper: Cursor | undefined
    while (true) {
      const below = upper === undefined ? sql`` : sql`AND (r.bucket, r.key) < (${upper.bucket}, ${upper.key})`
      const lower = yield* db
        .get<Cursor>(
          sql`
    SELECT r.bucket, r.key FROM ${selected.name} AS r INDEXED BY ${selected.index}
    WHERE ${scope} ${below} ORDER BY r.bucket DESC, r.key DESC LIMIT 1 OFFSET ${sliceRows - 1}
  `,
        )
        .pipe(Effect.orDie)
      const candidate = yield* db
        .get<Latest>(
          sql`
    SELECT r.last_invalidation AS invalidation, r.last_namespace AS namespace, r.last_timing AS timing, r.bucket AS time,
      ${index} AS family, coalesce(r.last_updated, 0) AS updated, r.session_id AS sessionID, r.last_request AS request
    FROM ${selected.name} AS r INDEXED BY ${selected.index}
    WHERE ${where} AND ${scope} ${below}
      ${lower === undefined ? sql`` : sql`AND (r.bucket, r.key) >= (${lower.bucket}, ${lower.key})`}
    ORDER BY r.bucket DESC, r.last_updated DESC, r.session_id DESC, r.last_request DESC LIMIT 1
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
      if (lower === undefined || (latest !== undefined && lower.bucket < latest.time)) break
      upper = lower
    }
  }
  if (!latest) return undefined
  return { invalidation: latest.invalidation, namespace: latest.namespace, timing: latest.timing }
})

export function usageWhere(input: Partial<ProviderRequest.ReportInput>, sessions?: ReadonlyArray<SessionSchema.ID>) {
  return sql`${sessions ? sql`r.session_id IN (SELECT value FROM json_each(${JSON.stringify(sessions)}))` : sql`1`}
    ${input.providerID === undefined ? sql`` : sql`AND json_extract(r.model, '$.providerID') = ${input.providerID}`}
    ${input.profile === undefined ? sql`` : sql`AND json_extract(r.model, '$.profile') = ${input.profile}`}
    ${input.modelID === undefined ? sql`` : sql`AND json_extract(r.model, '$.id') = ${input.modelID}`}
    ${input.selectedEffort === undefined ? sql`` : sql`AND json_extract(r.model, '$.variant') = ${input.selectedEffort}`}`
}

export const SessionUsageRead = {
  materialize,
  models,
  unpriced,
  latest,
  report,
  plan,
  pieces,
  pricingRefs,
  localUsage,
  localSpend,
  each,
  usageWhere,
}
