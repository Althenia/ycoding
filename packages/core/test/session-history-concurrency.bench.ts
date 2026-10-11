import "./preload"
import assert from "node:assert/strict"
import { Deferred, Effect, Fiber } from "effect"
import { Database } from "../src/database/database"
import { SessionHistory } from "../src/session/history"
import { historyDatabase, historyFixture } from "./fixture/session-history-pruning"

const count = Number(process.argv[2] ?? 10000)
const bytes = Number(process.argv[3] ?? 4096)
assert(Number.isSafeInteger(count) && count >= 12 && count <= 10000)
assert(Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= 16384)
assert(count * bytes <= 64 * 1024 * 1024)

const memory = () => {
  const usage = process.memoryUsage()
  return { rssMiB: usage.rss / 1048576, heapMiB: usage.heapUsed / 1048576 }
}
const stats = (values: number[]) => {
  const ordered = values.toSorted((a, b) => a - b)
  return {
    median: ordered[Math.floor(values.length / 2)],
    p95: ordered[Math.ceil(values.length * 0.95) - 1],
    max: ordered.at(-1),
  }
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    Bun.gc(true)
    const beforeFixture = memory()
    const fixture = yield* historyFixture(db, { count, bytes })
    Bun.gc(true)
    const afterFixture = memory()
    for (let warm = 0; warm < 3; warm++) yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])
    const duration: number[] = []
    const otherRead: number[] = []
    const transientHeap: number[] = []
    const transientRss: number[] = []
    for (let sample = 0; sample < 30; sample++) {
      Bun.gc(true)
      const before = memory()
      const entered = yield* Deferred.make<void>()
      const queued = yield* Deferred.make<void>()
      let otherStart = 0
      let otherEnd = 0
      const reader = yield* Deferred.await(entered).pipe(
        Effect.andThen(
          Effect.sync(() => {
            otherStart = performance.now()
          }),
        ),
        Effect.andThen(Deferred.succeed(queued, undefined)),
        Effect.andThen(db.get<{ value: number }>("SELECT 1 AS value")),
        Effect.tap((value) =>
          Effect.sync(() => {
            assert.equal(value?.value, 1)
            otherEnd = performance.now()
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      const start = performance.now()
      const assembled = yield* db.transaction(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(queued)),
          Effect.andThen(SessionHistory.entriesForRunner(db, fixture.sessionID, [])),
        ),
      )
      duration.push(performance.now() - start)
      const after = memory()
      transientHeap.push(after.heapMiB - before.heapMiB)
      transientRss.push(after.rssMiB - before.rssMiB)
      assert.deepEqual(
        assembled.entries.slice(1).map((entry) => entry.message.id),
        fixture.tail,
      )
      yield* Fiber.join(reader)
      otherRead.push(otherEnd - otherStart)
    }
    Bun.gc(true)
    return {
      count,
      bytes,
      warmups: 3,
      samples: 30,
      modelEntries: 11,
      beforeFixture,
      afterFixture,
      afterSamples: memory(),
      assemblyMs: stats(duration),
      otherReadMs: stats(otherRead),
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
