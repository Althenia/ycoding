export * as ShellLedger from "./ledger"

import { and, eq, exists, gt, isNotNull, isNull, notExists, notInArray, sql } from "drizzle-orm"
import { Clock, Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { Shell } from "@ycoding-ai/schema/shell"
import type { Database } from "../database/database"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { AppProcess } from "../process"
import { SessionEvent } from "../session/event"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { ShellTable } from "./sql"

type Db = Database.Interface["db"]
type Row = typeof ShellTable.$inferSelect
export type Process = { readonly pid: number; readonly pgid: number; readonly started: string }

const PROCESS_LIST_MAX_BYTES = 4 * 1024 * 1024
export const TERMINATE_GRACE_MS = 3_000
const TERMINATE_POLL_MS = 100
const startedType = EventRuntime.versionedType(
  SessionEvent.Execution.Started.type,
  SessionEvent.Execution.Started.durable.version,
)

export const processes = (appProcess: AppProcess.Interface, pids?: readonly number[]) =>
  appProcess
    .run(
      ChildProcess.make(
        "ps",
        pids === undefined ? ["-axo", "pid=,pgid=,lstart="] : ["-o", "pid=,pgid=,lstart=", "-p", pids.join(",")],
        { stdin: "ignore", env: { LC_ALL: "C", TZ: "UTC" }, extendEnv: true },
      ),
      { maxOutputBytes: PROCESS_LIST_MAX_BYTES, maxErrorBytes: 1024 },
    )
    .pipe(
      Effect.flatMap(AppProcess.requireSuccess),
      Effect.map((result) =>
        result.stdout
          .toString("utf8")
          .split("\n")
          .flatMap((line): Process[] => {
            const fields = line.trim().split(/\s+/)
            const pid = Number(fields[0])
            const pgid = Number(fields[1])
            if (!Number.isInteger(pid) || !Number.isInteger(pgid) || fields.length < 3) return []
            return [{ pid, pgid, started: fields.slice(2).join(" ") }]
          }),
      ),
    )

export const identify = (appProcess: AppProcess.Interface, pid: number) =>
  processes(appProcess, [pid]).pipe(
    Effect.map((found) => found.find((item) => item.pid === pid)),
    Effect.catch(() => Effect.succeed(undefined)),
  )

export const record = Effect.fn("ShellLedger.record")(function* (
  db: Db,
  input: { readonly id: Shell.ID; readonly pid: number; readonly started?: string; readonly owner: Process },
) {
  yield* db
    .insert(ShellTable)
    .values({
      id: input.id,
      pid: input.pid,
      process_started: input.started,
      owner_pid: input.owner.pid,
      owner_started: input.owner.started,
      time_created: yield* Clock.currentTimeMillis,
    })
    .run()
    .pipe(Effect.orDie)
})

export const release = (db: Db, id: Shell.ID) =>
  db
    .delete(ShellTable)
    .where(and(eq(ShellTable.id, id), eq(ShellTable.notice_pending, false)))
    .run()
    .pipe(Effect.orDie)

export const noticeOwed = (db: Db, id: Shell.ID, sessionID: SessionSchema.ID) =>
  db
    .update(ShellTable)
    .set({ session_id: sessionID, notice_pending: true })
    .where(eq(ShellTable.id, id))
    .run()
    .pipe(Effect.orDie)

export const noticeAdmitted = (db: Db, id: Shell.ID) =>
  db.delete(ShellTable).where(eq(ShellTable.id, id)).run().pipe(Effect.orDie)

const unacknowledged = (db: Db) =>
  and(
    isNotNull(ShellTable.time_lost),
    exists(db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, ShellTable.session_id))),
    notExists(
      db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, ShellTable.session_id),
            eq(EventTable.type, startedType),
            gt(EventTable.seq, ShellTable.start_seq),
          ),
        ),
    ),
  )

export const lostSessions = Effect.fn("ShellLedger.lostSessions")(function* (db: Db) {
  const rows = yield* db
    .select({ sessionID: ShellTable.session_id })
    .from(ShellTable)
    .where(unacknowledged(db))
    .all()
    .pipe(Effect.orDie)
  return [...new Set(rows.flatMap((row) => (row.sessionID === null ? [] : [row.sessionID])))]
})

export const reconcile = Effect.fn("ShellLedger.reconcile")(function* (
  db: Db,
  appProcess: AppProcess.Interface,
  graceMs = TERMINATE_GRACE_MS,
) {
  yield* db
    .delete(ShellTable)
    .where(
      and(
        isNotNull(ShellTable.time_lost),
        notInArray(ShellTable.id, db.select({ id: ShellTable.id }).from(ShellTable).where(unacknowledged(db))),
      ),
    )
    .run()
    .pipe(Effect.orDie)
  const rows = yield* db.select().from(ShellTable).where(isNull(ShellTable.time_lost)).all().pipe(Effect.orDie)
  if (rows.length === 0) return
  const snapshot = yield* processes(appProcess).pipe(Effect.option)
  if (snapshot._tag === "None") {
    yield* Effect.logWarning("could not list processes; background shell state was not reconciled")
    return
  }
  yield* Effect.forEach(
    rows.filter(
      (row) => !snapshot.value.some((item) => item.pid === row.owner_pid && item.started === row.owner_started),
    ),
    (row) =>
      Effect.gen(function* () {
        if (survivors(row, snapshot.value)) yield* terminate(row, appProcess, graceMs)
        if (!row.notice_pending || row.session_id === null) {
          yield* db.delete(ShellTable).where(eq(ShellTable.id, row.id)).run().pipe(Effect.orDie)
          return
        }
        yield* db
          .update(ShellTable)
          .set({
            time_lost: yield* Clock.currentTimeMillis,
            start_seq: sql`coalesce((select max(seq) from event where aggregate_id = ${row.session_id} and type = ${startedType}), -1)`,
          })
          .where(eq(ShellTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
      }),
    { concurrency: "unbounded", discard: true },
  )
})

function survivors(row: Row, snapshot: readonly Process[]) {
  const leader = snapshot.find((item) => item.pid === row.pid)
  if (leader) return row.process_started !== null && leader.started === row.process_started
  return snapshot.some((item) => item.pgid === row.pid)
}

const terminate = Effect.fnUntraced(function* (row: Row, appProcess: AppProcess.Interface, graceMs: number) {
  yield* signal(row, "SIGTERM")
  if (!(yield* exitedWithin(row, appProcess, graceMs))) yield* signal(row, "SIGKILL")
  yield* Effect.logWarning("terminated an orphaned background shell", { shellID: row.id, pid: row.pid })
})

const exitedWithin = Effect.fnUntraced(function* (row: Row, appProcess: AppProcess.Interface, graceMs: number) {
  const step = Math.min(TERMINATE_POLL_MS, graceMs)
  for (let waited = 0; waited < graceMs; waited += step) {
    yield* Effect.sleep(step)
    const after = yield* processes(appProcess).pipe(Effect.option)
    if (after._tag === "None" || !survivors(row, after.value)) return true
  }
  return false
})

const signal = (row: Row, name: NodeJS.Signals) =>
  Effect.try({ try: () => process.kill(-row.pid, name), catch: (error) => error }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("could not signal an orphaned background shell", { shellID: row.id, signal: name, error }),
    ),
  )
