import { afterEach, expect, spyOn } from "bun:test"
import { Effect, Layer, Logger, References, Scope } from "effect"
import { TestClock } from "effect/testing"
import { MemoryTelemetry } from "../src/observability/memory-telemetry"
import { MemoryDiagnostics } from "../src/observability/memory"
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
    let loads = 0
    let footprintReads = 0
    let resourceReads = 0
    let active = 2
    let failed = false
    const load = async (): Promise<MemoryDiagnostics.Sources> => {
      loads++
      return {
        runtime: "bun", version: "1.4.4",
        footprint: () => {
          footprintReads++
          if (failed) throw new Error("private-read-error")
          return { current: 256 * mib, peak: 300 * mib, currentCommit: 500 * mib, peakCommit: 600 * mib }
        },
        peak: () => { resourceReads++; return { minorPageFault: 19, majorPageFault: 0 } },
      }
    }
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
      yield* MemoryTelemetry.start({ loaded: () => Effect.succeed(loaded) }, ["a", "b"], { active: () => Effect.sync(() => active) }, load).pipe(
        Effect.provideService(Scope.Scope, scope),
      )
      yield* TestClock.adjust(0)
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
            activeGenerations: 2,
            runtimeMemory: expect.objectContaining({
              rss: expect.objectContaining({ status: "available", value: 256 * mib }),
              peakRss: expect.objectContaining({ status: "available", value: 300 * mib }),
              commit: expect.objectContaining({ current: expect.objectContaining({ value: 500 * mib }) }),
              pageFaults: expect.objectContaining({ minor: expect.objectContaining({ value: 19, unit: "count" }) }),
            }),
          }),
        ],
      })
      reading.rss = 255 * mib
      failed = true
      yield* TestClock.adjust("59 seconds")
      expect(records).toHaveLength(1)
      yield* TestClock.adjust("1 second")
      expect(records.at(-1)?.message).toMatchObject(["runtime memory telemetry", {
        runtimeMemory: { rss: { status: "error", reason: "read-failed" }, pageFaults: { minor: { status: "available" } } },
      }])
      failed = false
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
      active = 0
      yield* TestClock.adjust("60 seconds")
      expect(records.at(-1)?.message).toEqual([
        "runtime memory telemetry",
        expect.objectContaining({
          loadedLocations: 0,
          boundLocations: 0,
          standaloneLocations: 0,
          fullLocations: 0,
          builtServicesTotal: 0,
          activeGenerations: 0,
        }),
      ])
      yield* Scope.close(scope, yield* Effect.exit(Effect.void))
      const count = records.length
      const reads = memory.mock.calls.length
      reading.rss = 600 * mib
      yield* TestClock.adjust("120 seconds")
      expect(records).toHaveLength(count)
      expect(memory.mock.calls).toHaveLength(reads)
      expect(loads).toBe(1)
      expect(footprintReads).toBe(reads)
      expect(resourceReads).toBe(reads)
      expect(records.at(-1)?.message).toMatchObject(["runtime memory telemetry", {
        runtimeMemory: { rss: { status: "available" } },
      }])
      expect(JSON.stringify(records)).not.toContain("private")
    }).pipe(Effect.provide(logger))
  }),
)

it.effect("runtime summary load failures remain explicit and late loads cannot sample after scope closure", () =>
  Effect.gen(function* () {
    const memory = spyOn(process, "memoryUsage").mockReturnValue({ rss: 100, heapTotal: 20, heapUsed: 10, external: 5, arrayBuffers: 0 })
    restored.push(() => memory.mockRestore())
    const messages: unknown[] = []
    const logger = Logger.layer([Logger.make(({ message }) => messages.push(message))])
    let loads = 0
    let reads = 0
    let activityReads = 0
    const locations = { loaded: () => Effect.succeed([]) }
    const activity = { active: () => Effect.sync(() => { activityReads++; return 0 }) }
    yield* Effect.gen(function* () {
      yield* Effect.scoped(Effect.gen(function* () {
        yield* MemoryTelemetry.start(locations, [], activity, async () => {
          loads++
          throw new Error("private-module-error")
        })
        yield* TestClock.adjust(0)
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject(["runtime memory telemetry", {
          runtimeMemory: { rss: { status: "unavailable", reason: "module-unavailable" } },
        }])
        yield* TestClock.adjust("60 seconds")
        expect(messages).toHaveLength(2)
      }))
      expect(loads).toBe(1)
      const pending = Promise.withResolvers<MemoryDiagnostics.Sources>()
      yield* Effect.scoped(MemoryTelemetry.start(locations, [], activity, () => pending.promise))
      pending.resolve({ runtime: "bun", version: "1.4.4", footprint: () => ({ current: ++reads }) })
      yield* TestClock.adjust("120 seconds")
      expect(messages).toHaveLength(2)
      expect(reads).toBe(0)
      expect(activityReads).toBe(2)
      expect(memory.mock.calls).toHaveLength(2)
      expect(JSON.stringify(messages)).not.toContain("private")
    }).pipe(Effect.provide(logger), Effect.provideService(References.MinimumLogLevel, "Debug"))
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
