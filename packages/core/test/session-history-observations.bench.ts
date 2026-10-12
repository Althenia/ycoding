import "./preload"
import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Statement } from "effect/unstable/sql"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { SessionEvent } from "../src/session/event"
import { SessionHistory } from "../src/session/history"
import { SessionContextStateTable, SessionMessageTable } from "../src/session/sql"
import { historyDatabase, historyFixture } from "./fixture/session-history-pruning"
import { observationMessageData } from "./fixture/session-observations"

const mode = process.argv[2]
assert(mode === "baseline" || mode === "observations")
const count = Number(process.argv[3] ?? 2048)
const bytes = Number(process.argv[4] ?? 8192)
assert(Number.isSafeInteger(count) && count >= 303 && count <= 10000)
assert(Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= 16384)
assert(count * bytes <= 64 * 1024 * 1024)

const memory = () => {
  const usage = process.memoryUsage()
  return { rssMiB: usage.rss / 1048576, heapMiB: usage.heapUsed / 1048576 }
}
const stats = (values: number[]) => {
  const ordered = values.toSorted((a, b) => a - b)
  return { median: ordered[Math.floor(values.length / 2)], max: ordered.at(-1) }
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db, { count, bytes })
    yield* db.update(SessionContextStateTable).set({ status: "quarantined" }).run()
    const sources = ["session-state", "team-view", "step-limit"] as const
    const trustedThrough = count - 251
    yield* EventRuntime.reserveSequence(db, fixture.sessionID, count)
    for (let offset = 0; offset < count; offset += 50) {
      for (let index = offset; index < Math.min(count, offset + 50); index++) {
        const source = index <= trustedThrough ? sources[index % 3] : "team-view"
        yield* db
          .update(SessionMessageTable)
          .set({
            type: source === "team-view" ? "synthetic" : "system",
            data: observationMessageData({
              id: fixture.ids[index],
              type: source === "team-view" ? "synthetic" : "system",
              text: `${index}:` + "x".repeat(bytes),
              metadata: { contextSource: source },
              ...(source === "team-view" ? { description: "TeamView update" } : {}),
              time: { created: index },
            }),
          })
          .where(eq(SessionMessageTable.id, fixture.ids[index]))
          .run()
      }
      if (offset <= trustedThrough)
        yield* db
          .insert(EventTable)
          .values(
            fixture.ids.slice(offset, Math.min(trustedThrough + 1, offset + 50)).map((id, local) => ({
              id: EventRuntime.ID.make(String(id).replace(/^msg_/, "evt_")),
              aggregate_id: fixture.sessionID,
              seq: offset + local,
              created: offset + local,
              type: EventRuntime.versionedType(
                SessionEvent.ContextObserved.type,
                SessionEvent.ContextObserved.durable.version,
              ),
              data: { source: sources[(offset + local) % 3], text: `${offset + local}:` + "x".repeat(bytes) },
            })),
          )
          .run()
    }
    const expectedIDs = new Set(fixture.ids.slice(trustedThrough - 2, trustedThrough + 1))
    const expected = Array.from({ length: 3 }, (_, index): [SessionHistory.ObservationSource, string] => [
      sources[(trustedThrough - 2 + index) % 3],
      `${trustedThrough - 2 + index}:` + "x".repeat(bytes),
    ]).toSorted((left, right) => left[0].localeCompare(right[0]))
    Bun.gc(true)
    const afterFixture = memory()
    const read = Effect.gen(function* () {
      if (mode === "baseline") {
        const history = yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])
        return {
          entries: history.entries,
          latest: history.entries
            .filter((entry) => expectedIDs.has(entry.message.id))
            .map((entry): [SessionHistory.ObservationSource, string] => {
              const source = entry.message.metadata?.contextSource
              assert(source === "session-state" || source === "team-view" || source === "step-limit")
              assert(entry.message.type === "system" || entry.message.type === "synthetic")
              return [source, entry.message.text]
            }),
          returnedEntries: history.entries.length,
        }
      }
      const state = yield* SessionHistory.observationState(db, fixture.sessionID)
      return { entries: undefined, latest: [...state.latest], returnedEntries: state.latest.size }
    })
    const duration: number[] = []
    const transientHeap: number[] = []
    const transientRss: number[] = []
    const payloadPages: number[] = []
    for (let sample = 0; sample < 8; sample++) {
      Bun.gc(true)
      const before = memory()
      const start = performance.now()
      let pages = 0
      const loaded = yield* read.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            const [sql, params] = statement.compile()
            if (
              sql.includes('from "session_message"') &&
              sql.includes('"type" in') &&
              sql.slice(0, sql.indexOf(" from ")).includes('"data"')
            ) {
              assert(sql.includes('order by "session_message"."seq" desc limit ?'))
              assert.equal(params.at(-1), 100)
              pages++
            }
            return statement
          }),
        ),
      )
      duration.push(performance.now() - start)
      const after = memory()
      transientHeap.push(after.heapMiB - before.heapMiB)
      transientRss.push(after.rssMiB - before.rssMiB)
      assert.equal(loaded.returnedEntries, mode === "baseline" ? count : 3)
      assert.deepEqual(
        loaded.latest.toSorted((left, right) => left[0].localeCompare(right[0])),
        expected,
      )
      if (loaded.entries !== undefined) assert.equal(loaded.entries.length, count)
      assert.equal(pages, mode === "baseline" ? 0 : 3)
      payloadPages.push(pages)
    }
    assert.deepEqual(yield* db.get<{ count: number }>("SELECT COUNT(*) AS count FROM session_message"), { count })
    Bun.gc(true)
    return {
      mode,
      count,
      bytes,
      samples: 8,
      returnedEntries: mode === "baseline" ? count : 3,
      untrustedNewest: 250,
      payloadPages: stats(payloadPages),
      pageRowLimit: 100,
      afterFixture,
      afterSamples: memory(),
      assemblyMs: stats(duration),
      sampledTransientHeapMiB: stats(transientHeap),
      sampledTransientRssMiB: stats(transientRss),
    }
  }).pipe(Effect.scoped, Effect.provide(historyDatabase), Effect.timeout("90 seconds")),
)
Bun.gc(true)
console.log(
  JSON.stringify({
    environment: { bun: Bun.version, platform: process.platform, arch: process.arch },
    ...result,
    afterScope: memory(),
  }),
)
