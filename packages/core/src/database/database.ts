export * as Database from "./database"

import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { sqliteLayer } from "#sqlite"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "../global"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
  /** Read-only connection for long reads; absent for in-memory databases, which cannot be opened twice. */
  reader?: DatabaseShape
}

export const Options = Schema.Struct({
  path: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/storage/Database") {}

const makeService = (file: string) =>
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)
    const autoVacuum = yield* db.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")
    if (autoVacuum?.auto_vacuum === 0) {
      yield* db.run("PRAGMA auto_vacuum = INCREMENTAL")
      yield* db.run("VACUUM")
    }
    if (autoVacuum?.auto_vacuum === 2) yield* db.run("PRAGMA incremental_vacuum(256)")
    yield* db.run("PRAGMA optimize=0x10002")

    if (file === ":memory:") return { db }
    const reader = yield* Layer.build(
      sqliteLayer({ filename: file, readonly: true, readwrite: false, create: false, disableWAL: true }),
    ).pipe(
      Effect.flatMap((context) => makeDatabase.pipe(Effect.provide(context))),
      Effect.tap((reader) =>
        Effect.all([
          reader.run("PRAGMA busy_timeout = 5000"),
          reader.run("PRAGMA cache_size = -64000"),
          reader.run("PRAGMA temp_store = MEMORY"),
        ]),
      ),
    )
    return { db, reader }
  }).pipe(Effect.orDie)

export const reclaim = Effect.fn("Database.reclaim")(function* (db: DatabaseShape) {
  let free = yield* freelist(db)
  while (free > 0) {
    yield* db.run("PRAGMA incremental_vacuum(32)")
    yield* Effect.yieldNow
    const remaining = yield* freelist(db)
    if (remaining >= free) return
    free = remaining
  }
})

const freelist = (db: DatabaseShape) =>
  db.get<{ freelist_count: number }>("PRAGMA freelist_count").pipe(Effect.map((row) => row?.freelist_count ?? 0))

export function filename(options?: Options) {
  if (options?.path === ":memory:" || (options?.path && isAbsolute(options.path))) return options.path
  if (options?.path) return join(Global.Path.data, options.path)
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.YCODING_DISABLE_CHANNEL_DB === "1" ||
    process.env.YCODING_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "ycoding.db")
  return join(Global.Path.data, `ycoding-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export function layer(options?: Options) {
  return Layer.suspend(() => {
    const file = filename(options)
    return Layer.effect(Service, makeService(file)).pipe(Layer.provide(sqliteLayer({ filename: file })))
  })
}

export const layerFromPath = (path: string) => layer({ path })

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [] })
}

export const node = configured({ path: ":memory:" })
