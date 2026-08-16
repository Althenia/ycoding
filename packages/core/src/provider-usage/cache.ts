export * as ProviderUsageCache from "./cache"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Effect } from "effect"

export interface GetInput {
  readonly key: string
  readonly ttlMs: number
  readonly refresh?: boolean
  readonly load: Effect.Effect<ProviderUsage.Snapshot, Error>
}

export interface Interface {
  readonly get: (input: GetInput) => Effect.Effect<ProviderUsage.Snapshot, Error>
  readonly put: (key: string, value: ProviderUsage.Snapshot, ttlMs: number) => Effect.Effect<void>
  readonly clear: (key?: string) => Effect.Effect<void>
}

interface Entry {
  readonly value?: ProviderUsage.Snapshot
  readonly expiresAt: number
  readonly pending?: Promise<ProviderUsage.Snapshot>
}

export function make(input: { readonly now?: () => number } = {}): Interface {
  const now = input.now ?? Date.now
  const entries = new Map<string, Entry>()

  const stale = (value: ProviderUsage.Snapshot) =>
    new ProviderUsage.Snapshot({
      providerID: value.providerID,
      label: value.label,
      status: "stale",
      source: value.source,
      stability: value.stability,
      updatedAt: value.updatedAt,
      windows: value.windows,
      message: "Provider usage refresh failed",
    })

  return {
    get: (request) =>
      Effect.tryPromise({
        try: async () => {
          const current = entries.get(request.key)
          if (!request.refresh && current?.value && current.expiresAt > now()) return current.value
          if (current?.pending) return current.pending

          let pending: Promise<ProviderUsage.Snapshot>
          pending = Effect.runPromise(request.load)
            .then((value) => {
              entries.set(request.key, { value, expiresAt: now() + request.ttlMs })
              return value
            })
            .catch((cause) => {
              const previous = entries.get(request.key)?.value ?? current?.value
              if (previous) {
                const value = stale(previous)
                entries.set(request.key, { value: previous, expiresAt: now() + Math.min(request.ttlMs, 30_000) })
                return value
              }
              throw cause
            })
            .finally(() => {
              const latest = entries.get(request.key)
              if (latest?.pending === pending)
                entries.set(request.key, { value: latest.value, expiresAt: latest.expiresAt })
            })
          entries.set(request.key, {
            value: current?.value,
            expiresAt: current?.expiresAt ?? 0,
            pending,
          })
          return pending
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error("Provider usage refresh failed")),
      }),
    put: (key, value, ttlMs) =>
      Effect.sync(() => {
        entries.set(key, { value, expiresAt: now() + ttlMs })
      }),
    clear: (key) =>
      Effect.sync(() => {
        if (key === undefined) entries.clear()
        else entries.delete(key)
      }),
  }
}
