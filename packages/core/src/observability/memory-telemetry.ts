import { Clock, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import { GenerationActivity } from "../generation-activity"
import { MemoryDiagnostics } from "./memory"

export function sample() {
  const value = process.memoryUsage()
  return {
    rssBytes: value.rss,
    heapTotalBytes: value.heapTotal,
    heapUsedBytes: value.heapUsed,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
    nativeGapBytes: Math.max(0, value.rss - value.heapTotal - value.external),
  }
}

export function delta(before: ReturnType<typeof sample>, after = sample()) {
  return {
    ...after,
    rssDeltaBytes: after.rssBytes - before.rssBytes,
    heapUsedDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
    before,
    after,
  }
}

export function start(
  locations: Pick<LocationServiceMap.Interface, "loaded">,
  fullServices: readonly string[],
  activity: Pick<GenerationActivity.Interface, "active">,
  load: () => Promise<MemoryDiagnostics.Sources> = MemoryDiagnostics.sources,
) {
  return Effect.gen(function* () {
    const sources = yield* MemoryDiagnostics.loadSources(load)
    let highWaterRss: number | undefined
    let lastLoggedInfoRss = 0
    yield* Effect.gen(function* () {
      const memory = sample()
      const loaded = yield* locations.loaded()
      const timestampMs = yield* Clock.currentTimeMillis
      const metadata = {
        component: "memory",
        ...memory,
        timestampMs,
        runtimeMemory: MemoryDiagnostics.collect(sources, timestampMs),
        activeGenerations: yield* activity.active(),
        loadedLocations: loaded.length,
        boundLocations: loaded.filter((entry) => entry.scope !== "standalone").length,
        standaloneLocations: loaded.filter((entry) => entry.scope === "standalone").length,
        fullLocations: loaded.filter(
          (entry) =>
            entry.scope !== "standalone" &&
            fullServices.length > 0 &&
            fullServices.every((name) => entry.built.includes(name)),
        ).length,
        builtServicesTotal: loaded.reduce((total, entry) => total + entry.built.length, 0),
      }
      const info =
        highWaterRss === undefined ||
        memory.rssBytes > highWaterRss ||
        Math.abs(memory.rssBytes - lastLoggedInfoRss) >= 64 * 1024 * 1024
      highWaterRss = Math.max(highWaterRss ?? 0, memory.rssBytes)
      if (info) lastLoggedInfoRss = memory.rssBytes
      yield* (info ? Effect.logInfo : Effect.logDebug)("runtime memory telemetry", {
        ...metadata,
        highWaterRssBytes: highWaterRss,
      })
    }).pipe(Effect.repeat(Schedule.spaced("60 seconds")))
  }).pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid)
}

export const node = (fullServices: readonly string[]) =>
  makeGlobalNode({
    name: "memory-telemetry",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const activity = yield* GenerationActivity.Service
        yield* start(locations, fullServices, activity)
      }),
    ),
    deps: [LocationServiceMap.node, GenerationActivity.node],
  })

export * as MemoryTelemetry from "./memory-telemetry"
