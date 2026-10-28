export * as GenerationActivity from "./generation-activity"

import type { Model } from "@ycoding-ai/schema/model"
import type { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import type { UsageDashboard } from "@ycoding-ai/schema/usage-dashboard"
import { Cause, Clock, Context, Effect, Layer, type Scope } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { GenerationMeter } from "./session/generation-meter"

const WINDOW_NS = 5_000_000_000n
const SLOT_NS = 250_000_000n
const BUCKET_MS = 5_000
const WINDOW_SECONDS = 5
const HISTORY = 120
const MODELS = 50

type Entry = { readonly key: string; readonly model: Model.Ref; tokens: number; lastOutput?: bigint }
type Slot = { readonly slot: bigint; readonly key: string; readonly model: Model.Ref; at: bigint; tokens: number }

export function registry(anchor: { readonly wallMs: number; readonly ns: bigint }) {
  const entries = new Map<GenerationMeter.Meter, Entry>()
  const slots: Slot[] = []
  const history: UsageDashboard.LivePoint[] = []
  let now = anchor.ns
  let bucket = Math.floor(anchor.wallMs / BUCKET_MS)
  let bucketTokens = 0
  let bucketPeak = 0

  const wall = (ns: bigint) => anchor.wallMs + Number((ns - anchor.ns) / 1_000_000n)
  const close = (index: number, tokens: number, peak: number) => {
    history.push({
      at: (index + 1) * BUCKET_MS,
      active: peak,
      ...(peak > 0 || tokens > 0 ? { outputTokensPerSecond: tokens / WINDOW_SECONDS } : {}),
    })
    if (history.length > HISTORY) history.shift()
  }
  const advance = (time: bigint) => {
    if (time > now) now = time
    const target = Math.floor(wall(now) / BUCKET_MS)
    if (target > bucket) {
      close(bucket, bucketTokens, bucketPeak)
      for (let index = Math.max(bucket + 1, target - HISTORY); index < target; index++) close(index, 0, entries.size)
      bucket = target
      bucketTokens = 0
      bucketPeak = entries.size
    }
    while (slots.length > 0 && slots[0]!.at <= now - WINDOW_NS) slots.shift()
    return now
  }
  const record = (entry: Entry, at: bigint, tokens: number) => {
    const slot = at / SLOT_NS
    const existing = slots.findLast((value) => value.slot === slot && value.key === entry.key)
    if (existing) {
      existing.at = at
      existing.tokens += tokens
    }
    if (!existing) slots.push({ slot, key: entry.key, model: entry.model, at, tokens })
    bucketTokens += tokens
  }

  return {
    update(meter: GenerationMeter.Meter, time: bigint) {
      const at = advance(time)
      const known = entries.get(meter)
      const finished = GenerationMeter.terminal(meter.phase())
      if (!known && finished) return
      const entry = known ?? { key: key(meter.model), model: meter.model, tokens: 0 }
      const tokens = meter.outputTokens()
      if (tokens > entry.tokens) {
        record(entry, at, tokens - entry.tokens)
        entry.tokens = tokens
        entry.lastOutput = at
      }
      if (finished) entries.delete(meter)
      if (!finished) entries.set(meter, entry)
      bucketPeak = Math.max(bucketPeak, entries.size)
    },
    remove(meter: GenerationMeter.Meter, time: bigint) {
      advance(time)
      entries.delete(meter)
    },
    snapshot(time: bigint): UsageDashboard.Live {
      const at = advance(time)
      const since = at - WINDOW_NS
      const models = new Map<string, { model: Model.Ref; active: number; streaming: number; tokens: number }>()
      const model = (key: string, ref: Model.Ref) => {
        const existing = models.get(key)
        if (existing) return existing
        const created = { model: ref, active: 0, streaming: 0, tokens: 0 }
        models.set(key, created)
        return created
      }
      for (const entry of entries.values()) {
        const value = model(entry.key, entry.model)
        value.active += 1
        if (entry.lastOutput !== undefined && entry.lastOutput > since) value.streaming += 1
      }
      for (const slot of slots) model(slot.key, slot.model).tokens += slot.tokens
      const all = [...models.entries()]
      const tokens = all.reduce((sum, [, value]) => sum + value.tokens, 0)
      return {
        asOf: wall(at),
        active: entries.size,
        streaming: all.reduce((sum, [, value]) => sum + value.streaming, 0),
        ...(entries.size > 0 || tokens > 0 ? { outputTokensPerSecond: tokens / WINDOW_SECONDS } : {}),
        models: all
          .toSorted(([leftKey, left], [rightKey, right]) =>
            right.active - left.active || right.tokens - left.tokens || leftKey.localeCompare(rightKey))
          .slice(0, MODELS)
          .map(([, value]) => ({
            model: value.model,
            active: value.active,
            streaming: value.streaming,
            outputTokensPerSecond: value.tokens / WINDOW_SECONDS,
          })),
        history: [...history],
      }
    },
  }
}

const key = (model: Model.Ref) => JSON.stringify([model.providerID, model.id, model.variant ?? null, model.profile ?? null])

export interface StartInput {
  readonly requestID: ProviderRequest.ID
  readonly attempt: number
  readonly model: Model.Ref
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<GenerationMeter.Meter, never, Scope.Scope>
  readonly snapshot: () => Effect.Effect<UsageDashboard.Live>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/GenerationActivity") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = registry({ wallMs: yield* Clock.currentTimeMillis, ns: yield* Clock.currentTimeNanos })
    return Service.of({
      start: (input) =>
        Effect.acquireRelease(
          Effect.map(Clock.currentTimeNanos, (startedNs) => {
            const meter = GenerationMeter.make({ ...input, startedNs, onChange: state.update })
            state.update(meter, startedNs)
            return meter
          }),
          (meter, exit) =>
            Effect.map(Clock.currentTimeNanos, (time) => {
              meter.settle(exit._tag === "Failure" && Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed", time)
              state.remove(meter, time)
            }),
        ),
      snapshot: () => Effect.map(Clock.currentTimeNanos, state.snapshot),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
