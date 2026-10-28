export * as UsageDashboardRuntime from "./usage-dashboard"

import { Cause, Clock, Context, Deferred, Effect, Layer, Scope } from "effect"
import type { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import type { UsageDashboard } from "@ycoding-ai/schema/usage-dashboard"
import type { UsageForecast } from "@ycoding-ai/schema/usage-forecast"
import { Credential } from "./credential"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { EventRuntime } from "./event"
import { ProviderUsageRuntime } from "./provider-usage"

export interface Interface {
  readonly quota: (refresh: boolean) => Effect.Effect<UsageDashboard.Quota>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/UsageDashboard") {}

export const quotaFailure = "Provider quotas are unavailable"

export const timing = { refreshMs: 30_000, forecastMs: 60_000, retryMs: 30_000, idleMs: 300_000 } as const

type Overlay =
  | {
      readonly kind: "ready"
      readonly fence: string
      readonly providers: ReadonlyArray<ProviderUsage.Snapshot>
      readonly forecast: UsageForecast.Info
      readonly expiresAt: number
    }
  | { readonly kind: "failed"; readonly fence: string; readonly retryAt: number }

const failureName = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.name : "defect"
}

export const layer: Layer.Layer<
  Service,
  never,
  | ProviderUsageRuntime.Service
  | Database.Service
  | EventRuntime.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const usage = yield* ProviderUsageRuntime.Service
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
    const scope = yield* Scope.Scope
    const clock = yield* Clock.Clock
    let configEpoch = 0
    let overlay: Overlay | undefined
    let running = false
    let force = false
    let used = 0
    let wake = Deferred.makeUnsafe<void>()
    const signal = () => void Deferred.doneUnsafe(wake, Effect.void)

    const fence = Effect.map(Credential.identities(db), (rows) => JSON.stringify([configEpoch, rows]))

    yield* Effect.acquireRelease(
      events.listen((event) =>
        Effect.sync(() => {
          if (event.type !== "config.updated" && event.type !== "integration.connection.updated") return
          configEpoch += 1
          overlay = undefined
          signal()
        }),
      ),
      (unsubscribe) => unsubscribe,
    )

    const prepare = Effect.gen(function* () {
      const refresh = force
      force = false
      const before = yield* fence
      const settle = <A>(phase: string, effect: Effect.Effect<A>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("Usage dashboard account overlay failed", { phase, failure: failureName(cause) }).pipe(
                  Effect.as(undefined),
                ),
          ),
        )
      const [providers, forecasted] = yield* Effect.all(
        [
          settle("providers", usage.list(refresh ? { refresh: true } : undefined)),
          settle("forecast", usage.forecast({ localScope: "backend" })),
        ],
        { concurrency: 2 },
      )
      const now = yield* clock.currentTimeMillis
      if ((yield* fence) !== before) {
        overlay = undefined
        return
      }
      const forecast = forecasted ?? { asOf: now, localScope: "backend" as const }
      overlay = providers
        ? { kind: "ready", fence: before, providers, forecast, expiresAt: forecast.asOf + timing.forecastMs }
        : { kind: "failed", fence: before, retryAt: now + timing.retryMs }
    })

    const start = Effect.suspend(() => {
      if (running) return Effect.void
      running = true
      return Effect.gen(function* () {
        while ((yield* clock.currentTimeMillis) - used < timing.idleMs) {
          wake = Deferred.makeUnsafe<void>()
          if (overlay?.kind !== "failed" || (yield* clock.currentTimeMillis) >= overlay.retryAt) yield* prepare
          yield* Deferred.await(wake).pipe(
            Effect.timeout(overlay?.kind === "failed" ? timing.retryMs : timing.refreshMs),
            Effect.ignore,
          )
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running = false
            overlay = undefined
          }),
        ),
        Effect.provideService(Clock.Clock, clock),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })

    return Service.of({
      quota: Effect.fn("UsageDashboard.quota")(function* (refresh) {
        const now = yield* clock.currentTimeMillis
        used = now
        const current = yield* fence
        if (overlay && overlay.fence !== current) overlay = undefined
        if (refresh) {
          force = true
          overlay = undefined
        }
        yield* start
        const prepared = overlay?.kind === "ready" && overlay.expiresAt > now ? overlay : undefined
        const failed = overlay?.kind === "failed" ? overlay : undefined
        if (!prepared && (!failed || now >= failed.retryAt)) signal()
        if (prepared) return { status: "ready" as const, providers: prepared.providers, forecast: prepared.forecast }
        if (failed) return { status: "error" as const, message: quotaFailure }
        return { status: "preparing" as const }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ProviderUsageRuntime.node, Database.node, EventRuntime.node],
})
