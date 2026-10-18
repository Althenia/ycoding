export * as ProviderUsagePaceAlerts from "./pace-alerts"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Context, Effect, Layer, Queue, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { ProviderUsageForecast } from "./forecast"

const resetTolerance = 1000
const maxStates = 256
const queueCapacity = 256

export interface ObserveInput {
  readonly account: string
  readonly snapshot: ProviderUsage.Snapshot
  readonly semantics: ProviderUsageForecast.Semantics
  readonly now: number
}

export interface Interface {
  readonly observe: (input: ObserveInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ProviderUsagePaceAlerts") {}

const copy = {
  "almost-out": { title: "Almost out", body: "Less than 10% of this quota remains." },
  "cutting-it-close": {
    title: "Cutting it close",
    body: "Projected quota use exceeds 90% of its limit at reset.",
  },
  "will-run-out": {
    title: "Will run out",
    body: "Quota use is at its limit or projected to exceed it before reset.",
  },
} satisfies Record<ProviderUsage.PaceMilestone, { title: string; body: string }>

const severity = { ahead: 0, "cutting-it-close": 1, "will-run-out": 2 } as const

interface State {
  updatedAt: number
  signature: string
  pending: boolean
  resetAt: number | undefined
  fired: Set<ProviderUsage.PaceMilestone>
  bucket: number
  underTen: boolean
  primed: boolean
}

export function make(input: {
  readonly deliver: (alert: ProviderUsage.QuotaPaceAlert) => Effect.Effect<boolean>
}): Interface {
  const states = new Map<string, State>()
  const lock = Semaphore.makeUnsafe(1)

  const deliver = (
    window: ProviderUsage.Window,
    resetAt: number,
    providerID: ProviderUsage.Snapshot["providerID"],
    milestone: ProviderUsage.PaceMilestone,
  ) =>
    Effect.suspend(() =>
      input.deliver(
        new ProviderUsage.QuotaPaceAlert({
          providerID,
          windowID: window.id,
          milestone,
          resetAt,
          ...copy[milestone],
        }),
      ),
    ).pipe(Effect.catchCause(() => Effect.succeed(false)))

  const evaluate = Effect.fnUntraced(function* (request: ObserveInput, window: ProviderUsage.Window) {
    const snapshot = request.snapshot
    const measure = remaining(window)
    const resetAt = window.resetAt
    if (snapshot.status !== "available" || measure === undefined || resetAt === undefined || resetAt <= request.now)
      return
    const key = JSON.stringify([request.account, snapshot.providerID, window.id])
    const known = states.get(key)
    if (known && snapshot.updatedAt < known.updatedAt) return
    const signature = JSON.stringify([
      snapshot.updatedAt,
      window.unit,
      window.used,
      window.limit,
      window.remaining,
      resetAt,
      window.periodSeconds,
    ])
    if (known && known.signature === signature && !known.pending) return
    const state: State = known ?? {
      updatedAt: snapshot.updatedAt,
      signature,
      pending: false,
      resetAt,
      fired: new Set(),
      bucket: -1,
      underTen: false,
      primed: false,
    }
    states.delete(key)
    states.set(key, state)
    while (states.size > maxStates) states.delete(states.keys().next().value!)
    state.updatedAt = snapshot.updatedAt
    state.signature = signature
    if (state.resetAt === undefined || Math.abs(resetAt - state.resetAt) > resetTolerance) {
      state.fired.clear()
      state.underTen = false
      state.bucket = -1
    }
    state.resetAt = resetAt
    const verdict = ProviderUsageForecast.pace({ window, semantics: request.semantics, now: request.now })?.verdict
    const bucket = verdict === undefined ? -1 : severity[verdict]
    const underNow = measure.remaining * 10 < measure.limit
    if (!state.primed) {
      state.primed = true
      state.pending = false
      state.bucket = bucket
      state.underTen = underNow
      state.fired.clear()
      return
    }
    const pace: ProviderUsage.PaceMilestone | undefined =
      bucket === 1 && state.bucket < 1 && !state.fired.has("cutting-it-close")
        ? "cutting-it-close"
        : bucket >= 2 && state.bucket < 2 && !state.fired.has("will-run-out")
          ? "will-run-out"
          : undefined
    if (bucket >= 0 && bucket < state.bucket) {
      if (bucket <= 0) state.fired.delete("cutting-it-close")
      if (bucket <= 1) state.fired.delete("will-run-out")
    }
    const crossed = underNow && !state.underTen
    const under = crossed && !state.fired.has("almost-out") ? ("almost-out" as const) : undefined
    if (!underNow) state.fired.delete("almost-out")
    const paceDelivered = pace === undefined ? false : yield* deliver(window, resetAt, snapshot.providerID, pace)
    const underDelivered = under === undefined ? false : yield* deliver(window, resetAt, snapshot.providerID, under)
    if (pace !== undefined && paceDelivered) state.fired.add(pace)
    if (under !== undefined && underDelivered) state.fired.add(under)
    state.pending = (pace !== undefined && !paceDelivered) || (under !== undefined && !underDelivered)
    if (bucket >= 0 && (bucket <= state.bucket || paceDelivered)) state.bucket = bucket
    if (!crossed || underDelivered) state.underTen = underNow
  })

  return {
    observe: (request) =>
      lock
        .withPermit(Effect.forEach(request.snapshot.windows, (window) => evaluate(request, window), { discard: true }))
        .pipe(Effect.catchCause(() => Effect.void)),
  }
}

function remaining(window: ProviderUsage.Window) {
  const limit = window.limit ?? (window.unit === "percent" ? 100 : undefined)
  if (window.unlimited === true || limit === undefined || !Number.isFinite(limit) || limit <= 0) return undefined
  const left = window.remaining ?? (window.used === undefined ? undefined : limit - window.used)
  if (left === undefined || !Number.isFinite(left)) return undefined
  return { remaining: Math.max(0, left), limit }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const queue = yield* Queue.dropping<ObserveInput>(queueCapacity)
    const alerts = make({
      deliver: (alert) =>
        events.publish(ProviderUsage.Event.QuotaPace, alert).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        ),
    })
    yield* Queue.take(queue).pipe(Effect.flatMap(alerts.observe), Effect.forever, Effect.forkScoped)
    return Service.of({ observe: (request) => Effect.sync(() => void Queue.offerUnsafe(queue, request)) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventRuntime.node] })
