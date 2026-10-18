export * as ProviderUsageCache from "./cache"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Effect } from "effect"

export interface GetInput {
  readonly key: string
  readonly ttlMs: number
  readonly refresh?: boolean
  readonly generation?: number
  readonly load: Effect.Effect<ProviderUsage.Snapshot, Error>
}

export interface Interface {
  readonly get: (input: GetInput) => Effect.Effect<ProviderUsage.Snapshot, Error>
  readonly peek: (input: { readonly key: string; readonly generation?: number }) => Effect.Effect<ProviderUsage.Snapshot | undefined>
  readonly put: (key: string, value: ProviderUsage.Snapshot, ttlMs: number) => Effect.Effect<void>
  readonly clear: (key?: string) => Effect.Effect<void>
}

interface Entry {
  readonly generation: number
  readonly value?: ProviderUsage.Snapshot
  readonly expiresAt: number
  readonly pending?: Promise<ProviderUsage.Snapshot>
}

export function make(input: { readonly now?: () => number } = {}): Interface {
  const now = input.now ?? Date.now
  const entries = new Map<string, Entry>()
  const store = (key: string, entry: Entry) => {
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > 256) entries.delete(entries.keys().next().value!)
  }

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
          const generation = request.generation ?? 0
          if (current && current.generation >= generation) {
            store(request.key, current)
            if (current.pending) return current.pending
            if (current.value && (current.generation > generation || (!request.refresh && current.expiresAt > now())))
              return current.value
          }

          let pending: Promise<ProviderUsage.Snapshot>
          pending = Effect.runPromise(request.load)
            .then((value) => {
              if (entries.get(request.key)?.pending === pending)
                store(request.key, { generation, value, expiresAt: now() + request.ttlMs })
              return value
            })
            .catch((cause) => {
              const previous = current?.value
              if (previous) {
                const value = stale(previous)
                if (entries.get(request.key)?.pending === pending)
                  store(request.key, { generation, value, expiresAt: now() + Math.min(request.ttlMs, 30_000) })
                return value
              }
              throw cause
            })
            .finally(() => {
              const latest = entries.get(request.key)
              if (latest?.pending === pending)
                store(request.key, { generation: latest.generation, value: latest.value, expiresAt: latest.expiresAt })
            })
          store(request.key, {
            generation,
            value: current?.value,
            expiresAt: current?.expiresAt ?? 0,
            pending,
          })
          return pending
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error("Provider usage refresh failed")),
      }),
    peek: (request) =>
      Effect.sync(() => {
        const current = entries.get(request.key)
        return current && current.generation >= (request.generation ?? 0) ? current.value : undefined
      }),
    put: (key, value, ttlMs) =>
      Effect.sync(() => {
        store(key, { generation: 0, value, expiresAt: now() + ttlMs })
      }),
    clear: (key) =>
      Effect.sync(() => {
        if (key === undefined) entries.clear()
        else entries.delete(key)
      }),
  }
}
