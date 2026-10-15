export * as SessionHistoryBackup from "./history-backup"

import { rename, rm, statfs } from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { eq, sql } from "drizzle-orm"
import { Clock, Duration, Effect, Semaphore } from "effect"
import { DataMigrationTable } from "../data-migration.sql"
import type { Database } from "../database/database"

export const MARKER = "session-history-prune-backup-v1"
export const SUFFIX = ".pre-prune-backup"
export const HEADROOM_BYTES = 1024 ** 3
const notifyInterval = Duration.hours(1)

export interface Unavailable {
  readonly path: string
  readonly required: number
  readonly available: number
}

export interface Options {
  readonly db: Database.Interface["db"]
  readonly notify: (input: Unavailable) => Effect.Effect<void>
  readonly freeBytes?: (directory: string) => Effect.Effect<number>
}

export function make(options: Options) {
  const lock = Semaphore.makeUnsafe(1)
  const freeBytes =
    options.freeBytes ??
    ((directory: string) =>
      Effect.promise(() => statfs(directory)).pipe(Effect.map((stats) => stats.bavail * stats.bsize)))
  let logged = false
  let notified: number | undefined

  const refuse = Effect.fnUntraced(function* (input: Unavailable) {
    if (!logged)
      yield* Effect.logWarning("session history pruning skipped: not enough free disk space for its one-time backup", {
        ...input,
      })
    logged = true
    const now = yield* Clock.currentTimeMillis
    if (notified !== undefined && now - notified < Duration.toMillis(notifyInterval)) return false
    notified = now
    yield* options.notify(input)
    return false
  })

  return lock.withPermit(
    Effect.gen(function* () {
      const recorded = yield* options.db
        .select({ name: DataMigrationTable.name })
        .from(DataMigrationTable)
        .where(eq(DataMigrationTable.name, MARKER))
        .get()
        .pipe(Effect.orDie)
      if (recorded) return true
      const main = (yield* options.db.all<{ name: string; file: string }>(sql`PRAGMA database_list`).pipe(Effect.orDie))
        .find((row) => row.name === "main")
      if (!main?.file) return true
      const target = `${main.file}${SUFFIX}`
      const size = yield* options.db
        .get<{ bytes: number }>(sql`SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()`)
        .pipe(Effect.orDie)
      const required = (size?.bytes ?? 0) + HEADROOM_BYTES
      const available = yield* freeBytes(path.dirname(main.file))
      if (available < required) return yield* refuse({ path: target, required, available })
      const copied = yield* copy(main.file, target).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logError("session history pruning skipped: its one-time backup failed", { path: target, cause }).pipe(
            Effect.as(false),
          ),
        ),
      )
      if (!copied) return false
      yield* options.db
        .insert(DataMigrationTable)
        .values({ name: MARKER, time_completed: yield* Clock.currentTimeMillis })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* Effect.logInfo("session history pruning backed up the database before its first pruning pass", {
        path: target,
      })
      return true
    }),
  )
}

// The copy runs on a worker thread with its own read-only connection so a multi-minute
// VACUUM INTO never blocks the server's event loop.
const worker = `
const { parentPort, workerData } = require("node:worker_threads")
const { DatabaseSync } = require("node:sqlite")
try {
  const source = new DatabaseSync(workerData.source, { readOnly: true })
  try {
    source.prepare("VACUUM INTO ?").run(workerData.target)
  } finally {
    source.close()
  }
  const copy = new DatabaseSync(workerData.target, { readOnly: true })
  try {
    parentPort.postMessage({ check: copy.prepare("PRAGMA quick_check").all().map((row) => row.quick_check) })
  } finally {
    copy.close()
  }
} catch (error) {
  parentPort.postMessage({ error: String(error) })
}
`

const copy = (source: string, target: string) => {
  const temporary = `${target}.tmp`
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() => rm(temporary, { force: true }))
    const result = yield* Effect.callback<{ readonly check?: ReadonlyArray<string>; readonly error?: string }, Error>(
      (resume) => {
        const thread = new Worker(worker, { eval: true, workerData: { source, target: temporary } })
        thread.once("message", (message) => resume(Effect.succeed(message)))
        thread.once("error", (error) => resume(Effect.fail(error)))
        thread.once("exit", (code) => resume(Effect.fail(new Error(`Backup worker exited with code ${code}`))))
        return Effect.promise(() => thread.terminate())
      },
    )
    if (result.error !== undefined) return yield* Effect.fail(new Error(result.error))
    if (result.check?.length !== 1 || result.check[0] !== "ok")
      return yield* Effect.fail(new Error(`Backup integrity check failed: ${JSON.stringify(result.check)}`))
    return yield* Effect.tryPromise(() => rename(temporary, target))
  }).pipe(Effect.onError(() => Effect.promise(() => rm(temporary, { force: true }))))
}
