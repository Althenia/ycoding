import { afterEach, expect, spyOn } from "bun:test"
import { Effect, Layer, Logger, References, Scope } from "effect"
import { TestClock } from "effect/testing"
import { MemoryTelemetry } from "../src/observability/memory-telemetry"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { it } from "./lib/effect"

const restored: Array<() => void> = []
afterEach(() => restored.splice(0).forEach((restore) => restore()))

it.effect("runtime memory logs respect 60-second thresholds, high water, cache counts and scope cancellation", () =>
  Effect.gen(function* () {
    const mib = 1024 * 1024
    const reading = {
      rss: 256 * mib,
      heapTotal: 20 * mib,
      heapUsed: 10 * mib,
      external: 30 * mib,
      arrayBuffers: 5 * mib,
    }
    const memory = spyOn(process, "memoryUsage").mockReturnValue(reading)
    restored.push(() => memory.mockRestore())
    const ref = Location.Ref.make({ directory: AbsolutePath.make("/private-location-token") })
    let loaded = [
      { ref, scope: "bound" as const, built: ["a", "b"] },
      { ref, scope: "standalone" as const, built: ["a"] },
      { ref, scope: "bound" as const, built: ["private-service-token"] },
    ]
    const records: Array<{ level: string; message: unknown }> = []
    const logger = Logger.layer([Logger.make(({ logLevel, message }) => records.push({ level: logLevel, message }))], {
      mergeWithExisting: false,
    }).pipe(Layer.merge(Layer.succeed(References.MinimumLogLevel, "Debug")))
    yield* Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* MemoryTelemetry.start({ loaded: () => Effect.succeed(loaded) }, ["a", "b"]).pipe(
        Effect.provideService(Scope.Scope, scope),
      )
      expect(records).toHaveLength(1)
      expect(records[0]).toEqual({
        level: "Info",
        message: [
          "runtime memory telemetry",
          expect.objectContaining({
            rssBytes: 256 * mib,
            heapTotalBytes: 20 * mib,
            heapUsedBytes: 10 * mib,
            externalBytes: 30 * mib,
            arrayBuffersBytes: 5 * mib,
            nativeGapBytes: 206 * mib,
            timestampMs: 0,
            loadedLocations: 3,
            boundLocations: 2,
            standaloneLocations: 1,
            fullLocations: 1,
            builtServicesTotal: 4,
            highWaterRssBytes: 256 * mib,
          }),
        ],
      })
      reading.rss = 255 * mib
      yield* TestClock.adjust("59 seconds")
      expect(records).toHaveLength(1)
      yield* TestClock.adjust("1 second")
      for (const next of [192, 255, 256, 257, 257]) {
        reading.rss = next * mib
        yield* TestClock.adjust("60 seconds")
      }
      expect(records.map((record) => record.level)).toEqual(["Info", "Debug", "Info", "Debug", "Info", "Info", "Debug"])
      expect(records[3]?.message).toEqual([
        "runtime memory telemetry",
        expect.objectContaining({ highWaterRssBytes: 256 * mib }),
      ])
      loaded = []
      yield* TestClock.adjust("60 seconds")
      expect(records.at(-1)?.message).toEqual([
        "runtime memory telemetry",
        expect.objectContaining({
          loadedLocations: 0,
          boundLocations: 0,
          standaloneLocations: 0,
          fullLocations: 0,
          builtServicesTotal: 0,
        }),
      ])
      yield* Scope.close(scope, yield* Effect.exit(Effect.void))
      const count = records.length
      const reads = memory.mock.calls.length
      reading.rss = 600 * mib
      yield* TestClock.adjust("120 seconds")
      expect(records).toHaveLength(count)
      expect(memory.mock.calls).toHaveLength(reads)
      expect(JSON.stringify(records)).not.toContain("private")
    }).pipe(Effect.provide(logger))
  }),
)

it.effect("scalar memory accounting clamps a negative native residual to zero", () =>
  Effect.sync(() => {
    const memory = spyOn(process, "memoryUsage").mockReturnValue({
      rss: 100,
      heapTotal: 200,
      heapUsed: 50,
      external: 300,
      arrayBuffers: 10,
    })
    restored.push(() => memory.mockRestore())
    expect(MemoryTelemetry.sample()).toEqual({
      rssBytes: 100,
      heapTotalBytes: 200,
      heapUsedBytes: 50,
      externalBytes: 300,
      arrayBuffersBytes: 10,
      nativeGapBytes: 0,
    })
  }),
)
