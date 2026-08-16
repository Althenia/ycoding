import { expect } from "bun:test"
import { Effect } from "effect"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { it } from "./lib/effect"

const runtime = SessionCacheRuntime.layer({ capacity: 2 })

it.effect("adaptive TTL promotes only after two eligible observations in five minutes", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    expect(
      yield* service.policy({ namespace: "stable", modelID: "claude-sonnet-4-5", configured: "adaptive", now: 0 }),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
    yield* service.observe({ namespace: "stable", cacheRead: 0, cacheWrite: 1200, eligible: 1200, now: 1_000 })
    expect(
      yield* service.policy({ namespace: "stable", modelID: "claude-sonnet-4-5", configured: "adaptive", now: 2_000 }),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
    yield* service.observe({ namespace: "stable", cacheRead: 900, cacheWrite: 0, eligible: 1200, now: 3_000 })
    expect(
      yield* service.policy({ namespace: "stable", modelID: "claude-sonnet-4-5", configured: "adaptive", now: 4_000 }),
    ).toEqual({
      ttlSeconds: 3600,
      promoted: true,
    })
  }).pipe(Effect.provide(runtime)),
)

it.effect("adaptive TTL does not promote from missing or stale reusable reports", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* service.observe({ namespace: "missing", cacheRead: 0, cacheWrite: 0, eligible: 1200, now: 0 })
    yield* service.observe({ namespace: "missing", cacheRead: 0, cacheWrite: 0, eligible: 1200, now: 1_000 })
    expect(
      yield* service.policy({ namespace: "missing", modelID: "claude-sonnet-4-5", configured: "adaptive", now: 2_000 }),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })

    yield* service.observe({ namespace: "stale", cacheRead: 100, cacheWrite: 0, eligible: 1200, now: 0 })
    yield* service.observe({ namespace: "stale", cacheRead: 100, cacheWrite: 0, eligible: 1200, now: 301_000 })
    expect(
      yield* service.policy({ namespace: "stale", modelID: "claude-sonnet-4-5", configured: "adaptive", now: 302_000 }),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
  }).pipe(Effect.provide(runtime)),
)

it.effect("explicit TTL overrides bypass adaptive state and bounded eviction resets old namespaces", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    expect(
      yield* service.policy({ namespace: "explicit", modelID: "claude-sonnet-4-5", configured: "1h", now: 0 }),
    ).toEqual({ ttlSeconds: 3600, promoted: true })
    expect(
      yield* service.policy({ namespace: "explicit", modelID: "claude-sonnet-4-5", configured: "5m", now: 0 }),
    ).toEqual({ ttlSeconds: 300, promoted: false })
    expect(
      yield* service.policy({ namespace: "unsupported", modelID: "custom-model", configured: "1h", now: 0 }),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })

    for (const namespace of ["one", "two", "three"]) {
      yield* service.observe({ namespace, cacheRead: 100, cacheWrite: 0, eligible: 100, now: namespace.length })
      yield* service.observe({ namespace, cacheRead: 100, cacheWrite: 0, eligible: 100, now: namespace.length + 1 })
    }
    expect(yield* service.policy({ namespace: "one", modelID: "claude", configured: "adaptive", now: 10 })).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
  }).pipe(Effect.provide(runtime)),
)
