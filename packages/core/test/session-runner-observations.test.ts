import { expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Statement } from "effect/unstable/sql"
import { Database } from "../src/database/database"
import { SessionHistory } from "../src/session/history"
import { historyDatabase, historyFixture } from "./fixture/session-history-pruning"
import { testEffect } from "./lib/effect"

const it = testEffect(historyDatabase)

it.effect("exhausts bounded observation and provenance pages when trusted sources are absent", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db, { count: 1003, bytes: 2048 })
    yield* db.run(sql`UPDATE session_context_state SET status = 'quarantined'`)
    yield* db.run(
      sql`UPDATE session_message SET type = 'system', data = json_set(data, '$.metadata.contextSource', 'session-state')`,
    )
    const queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []
    const state = yield* SessionHistory.observationState(db, fixture.sessionID).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          const [sql, params] = statement.compile()
          queries.push({ sql, params })
          return statement
        }),
      ),
    )
    expect(state.latest.size).toBe(0)
    expect([...state.present]).toEqual(["session-state"])
    const pages = queries.filter(
      (query) =>
        query.sql.includes('from "session_message"') &&
        query.sql.includes('"type" in') &&
        query.sql.slice(0, query.sql.indexOf(" from ")).includes('"data"'),
    )
    expect(pages).toHaveLength(11)
    expect(
      pages.every(
        (query) => query.sql.includes('order by "session_message"."seq" desc limit ?') && query.params.at(-1) === 100,
      ),
    ).toBe(true)
    const trust = queries.filter((query) => query.sql.includes('from "event"') && query.sql.includes('"event"."id" in'))
    expect(trust).toHaveLength(11)
    expect(trust.every((query) => query.params.length <= 102)).toBe(true)
  }),
)
