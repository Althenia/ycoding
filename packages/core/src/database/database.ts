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
}

export const Options = Schema.Struct({
  path: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/storage/Database") {}

const databaseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

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
  return Layer.suspend(() => databaseLayer.pipe(Layer.provide(sqliteLayer({ filename: filename(options) }))))
}

export const layerFromPath = (path: string) => layer({ path })

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [] })
}

export const node = configured({ path: ":memory:" })
