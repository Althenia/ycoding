export * as TelemetryConsent from "./telemetry-consent"

import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { TelemetryConsentTable } from "./telemetry-consent/sql"

export interface Interface {
  readonly get: () => Effect.Effect<Telemetry.ConsentState>
  readonly set: (input: Telemetry.ConsentInput) => Effect.Effect<Telemetry.Consent>
  readonly enabled: () => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/TelemetryConsent") {}

export const make = Effect.fn("TelemetryConsent.make")(function* (
  db: Pick<Database.Interface["db"], "select" | "insert">,
) {
  const get = Effect.fn("TelemetryConsent.get")(function* () {
    const row = yield* db.select().from(TelemetryConsentTable).get().pipe(Effect.orDie)
    return {
      noticeVersion: Telemetry.CurrentNoticeVersion,
      ...(row === undefined
        ? {}
        : {
            consent: Schema.decodeUnknownSync(Telemetry.Consent)({
              enabled: row.enabled,
              noticeVersion: row.notice_version,
              decidedAt: row.decided_at,
            }),
          }),
    } as const
  })
  return Service.of({
    get,
    enabled: () => get().pipe(Effect.map((state) => state.consent?.enabled === true)),
    set: Effect.fn("TelemetryConsent.set")(function* (input) {
      const valid = yield* Schema.decodeUnknownEffect(Telemetry.ConsentInput)(input).pipe(Effect.orDie)
      const decidedAt = yield* Clock.currentTimeMillis
      yield* db
        .insert(TelemetryConsentTable)
        .values({
          id: 1,
          enabled: valid.enabled,
          notice_version: valid.noticeVersion,
          decided_at: decidedAt,
        })
        .onConflictDoUpdate({
          target: TelemetryConsentTable.id,
          set: {
            enabled: valid.enabled,
            notice_version: valid.noticeVersion,
            decided_at: decidedAt,
          },
        })
        .run()
        .pipe(Effect.orDie)
      return { ...valid, decidedAt }
    }),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* make(database.db)
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
