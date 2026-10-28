export * as UsageDashboardRead from "./usage-dashboard-read"

import { Cause, Context, Effect, Exit, Layer, Schedule, Scope } from "effect"
import type { UsageDashboard } from "@ycoding-ai/schema/usage-dashboard"
import { makeGlobalNode } from "./effect/app-node"
import { GenerationActivity } from "./generation-activity"
import type { Location } from "./location"
import { LocationServiceMap } from "./location-service-map"
import { UsageDashboardRuntime } from "./usage-dashboard"
import { UsageViews } from "./usage-view"
import { UsageViewRecipe } from "./usage-view-recipe"

export interface Interface {
  readonly read: (location: Location.Ref, input: UsageDashboard.Input) => Effect.Effect<UsageDashboard.Info>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/UsageDashboardRead") {}

const slots = ["daily", "monthly", "breakdown"] as const

const failureName = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.name : "defect"
}

type Held = { readonly quota: UsageDashboardRuntime.Interface["quota"]; readonly scope: Scope.Closeable; used: number }

export const layer: Layer.Layer<
  Service,
  never,
  UsageViews.Service | LocationServiceMap.Service | GenerationActivity.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const views = yield* UsageViews.Service
    const activity = yield* GenerationActivity.Service
    const locations = yield* LocationServiceMap.Service
    const scope = yield* Scope.Scope
    const held = new Map<string, Held>()
    const starting = new Set<string>()
    const failed = new Map<string, number>()

    yield* Effect.gen(function* () {
      const now = Date.now()
      for (const [key, entry] of held) {
        if (now - entry.used <= UsageDashboardRuntime.timing.idleMs) continue
        held.delete(key)
        yield* Scope.close(entry.scope, Exit.void)
      }
    }).pipe(Effect.repeat(Schedule.spaced(UsageDashboardRuntime.timing.idleMs)), Effect.forkIn(scope))

    const acquire = (key: string, location: Location.Ref, refresh: boolean) =>
      Effect.gen(function* () {
        const child = yield* Scope.fork(scope)
        const acquired = yield* locations.contextEffect(location, [UsageDashboardRuntime.node]).pipe(
          Effect.map((context) => Context.get(context, UsageDashboardRuntime.Service)),
          Effect.provideService(Scope.Scope, child),
          Effect.exit,
        )
        if (acquired._tag === "Failure") {
          yield* Scope.close(child, Exit.void)
          if (Cause.hasInterruptsOnly(acquired.cause)) return
          yield* Effect.logError("Usage dashboard quota Location is unavailable", { failure: failureName(acquired.cause) })
          failed.set(key, Date.now() + UsageDashboardRuntime.timing.retryMs)
          return
        }
        failed.delete(key)
        held.set(key, { quota: acquired.value.quota, scope: child, used: Date.now() })
        yield* acquired.value.quota(refresh)
      }).pipe(
        Effect.ensuring(Effect.sync(() => void starting.delete(key))),
        Effect.forkIn(scope),
      )

    const quota = Effect.fnUntraced(function* (location: Location.Ref, refresh: boolean) {
      const key = UsageViewRecipe.locationKey({ directory: location.directory, workspaceID: location.workspaceID ?? null })
      const entry = held.get(key)
      if (entry) {
        entry.used = Date.now()
        return yield* entry.quota(refresh)
      }
      const retryAt = failed.get(key)
      if (!starting.has(key) && (retryAt === undefined || Date.now() >= retryAt)) {
        starting.add(key)
        yield* acquire(key, location, refresh)
      }
      if (retryAt !== undefined) return { status: "error" as const, message: UsageDashboardRuntime.quotaFailure }
      return { status: "preparing" as const }
    })

    return Service.of({
      read: Effect.fn("UsageDashboard.read")(function* (location, input) {
        const present = slots.filter((slot) => input[slot] !== undefined)
        const accounting = yield* views.read(present.map((slot) => input[slot]!), input.refresh ? { refresh: true } : undefined)
        const overlay = yield* quota(location, input.refresh === true)
        if (accounting.status !== "ready") return accounting
        if (accounting.reports.length !== present.length)
          return { status: "error" as const, message: "Usage dashboard report is missing" }
        return {
          status: "ready" as const,
          asOf: accounting.publishedAt,
          revision: accounting.revision,
          summary: accounting.summary,
          quota: overlay,
          live: yield* activity.snapshot(),
          ...Object.fromEntries(present.map((slot, index) => [slot, accounting.reports[index]])),
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [UsageViews.node, LocationServiceMap.node, GenerationActivity.node],
})
