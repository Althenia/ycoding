import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger, References } from "effect"
import { TestClock } from "effect/testing"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryDiagnostics } from "../src/observability/memory"
import { Logging } from "../src/observability/logging"
import { it } from "./lib/effect"

test("Bun reports RSS without calling unverified heap, census or snapshot APIs", async () => {
  let footprints = 0
  let heaps = 0
  const input = await MemoryDiagnostics.sources({ versions: { bun: "1.4.4", node: "24.3.0" } }, async (specifier) => {
    expect(specifier).toBe("bun:jsc")
    return {
      memoryUsage: () => { footprints++; return { current: 500, peak: 900, currentCommit: 700 } },
      heapSize: () => { heaps++; throw new Error("Unverified heap sampling must not run") },
      heapStats: () => { throw new Error("Heap census must not run") },
      getHeapStatistics: () => { throw new Error("Heap statistics must not run") },
      getHeapSnapshot: () => { throw new Error("Snapshot must not run") },
      fullGC: () => { throw new Error("GC must not run") },
    }
  })
  const sample = MemoryDiagnostics.collect(input, 1234)
  expect(sample.timestampMs).toBe(1234)
  expect(sample.runtime).toEqual({ name: "bun", version: "1.4.4" })
  expect(sample.rss).toMatchObject({ status: "available", value: 500, unit: "bytes", basis: "current" })
  expect(sample.peakRss).toMatchObject({ status: "available", value: 900, unit: "bytes", basis: "process-lifetime-peak" })
  expect(sample.heap.size).toMatchObject({ status: "unavailable", reason: "sampling-cost-unverified", source: "bun:jsc.heapSize", basis: "unverified" })
  expect(sample.heap.size).not.toHaveProperty("value")
  expect(sample.heap.capacity.status).toBe("unsupported")
  expect(sample.heap.external.status).toBe("unsupported")
  expect(sample.nativeAllocations.status).toBe("unavailable")
  expect(sample.allocatorRetained.status).toBe("unavailable")
  expect([footprints, heaps]).toEqual([1, 0])
  expect(JSON.stringify(sample)).not.toContain("currentCommit")
})

test("Node reports bytes separately and converts only the process-lifetime RSS peak from KiB", async () => {
  let heapReads = 0
  const memoryUsage = Object.assign(() => {
    heapReads++
    return { heapUsed: 200, heapTotal: 400, external: 75, rss: 500, arrayBuffers: 50, prompt: "secret-payload" }
  }, { rss: () => 500 })
  const input = await MemoryDiagnostics.sources({
    versions: { node: "26.4.0" },
    memoryUsage,
    resourceUsage: () => ({ maxRSS: 2 }),
  }, async () => { throw new Error("Node must not import Bun") })
  const sample = MemoryDiagnostics.collect(input, 5000)
  expect(sample.runtime).toEqual({ name: "node", version: "26.4.0" })
  expect(sample.rss).toMatchObject({ status: "available", value: 500, unit: "bytes" })
  expect(sample.peakRss).toMatchObject({ status: "available", value: 2048, source: "process.resourceUsage.maxRSS" })
  expect(sample.heap.size).toMatchObject({ status: "available", value: 200, basis: "current" })
  expect(sample.heap.capacity).toMatchObject({ status: "available", value: 400 })
  expect(sample.heap.external).toMatchObject({ status: "available", value: 75 })
  expect(heapReads).toBe(1)
  expect(JSON.stringify(sample)).not.toContain("secret-payload")
  expect(JSON.stringify(sample)).not.toContain("arrayBuffers")
})

test("unavailable modules, unsupported APIs, read errors and missing fields never become zero measurements", async () => {
  const missing = await MemoryDiagnostics.sources({ versions: { bun: "1.4.4" } }, async () => { throw new Error("secret failure") })
  expect(MemoryDiagnostics.collect(missing, 0).rss).toMatchObject({ status: "unavailable", reason: "module-unavailable" })
  const sample = MemoryDiagnostics.collect({
    runtime: "node",
    version: "secret payload\n",
    rss: () => { throw new Error("secret failure") },
    peak: () => ({}),
    heap: () => ({ heapUsed: 0, heapTotal: Number.NaN }),
  }, 0)
  expect(sample.rss).toMatchObject({ status: "error", reason: "read-failed" })
  expect(sample.peakRss).toMatchObject({ status: "unavailable", reason: "no-reading" })
  expect(sample.heap.size).toMatchObject({ status: "available", value: 0 })
  expect(sample.heap.capacity).toMatchObject({ status: "error", reason: "invalid-reading" })
  expect(sample.heap.external).toMatchObject({ status: "unavailable", reason: "no-reading" })
  expect(sample.runtime.version).toBe("unknown")
  expect(JSON.stringify(sample)).not.toContain("secret")
  const unsupported = MemoryDiagnostics.collect({ runtime: "unknown", version: "unknown" }, 0)
  expect(unsupported.rss.status).toBe("unsupported")
  expect(unsupported.heap.size.status).toBe("unsupported")
})

test("invalid, overflowing and unreported counters are explicit while a real zero heap is valid", () => {
  for (const value of [-1, Infinity, NaN, "100", 0.5]) {
    const sample = MemoryDiagnostics.collect({ runtime: "node", version: "26.4.0", heap: () => ({ heapUsed: value }) }, 0)
    expect(sample.heap.size).toMatchObject({ status: "error", reason: "invalid-reading" })
    expect(sample.heap.size).not.toHaveProperty("value")
  }
  const sample = MemoryDiagnostics.collect({
    runtime: "node", version: "26.4.0", rss: () => 0,
    peak: () => ({ maxRSS: Number.MAX_SAFE_INTEGER }), heap: () => ({ heapUsed: 0 }),
  }, 0)
  expect(sample.rss).toMatchObject({ status: "unavailable", reason: "not-reported" })
  expect(sample.peakRss).toMatchObject({ status: "error", reason: "invalid-reading" })
  expect(sample.heap.size).toMatchObject({ status: "available", value: 0 })
})

it.effect("disabled sampling performs no imports, reads or scheduled work", () => Effect.gen(function* () {
  let loads = 0
  yield* MemoryDiagnostics.start(false, async () => {
    loads++
    throw new Error("Disabled sampler must not load")
  })
  yield* TestClock.adjust("2 hours")
  expect(loads).toBe(0)
}))

it.effect("sampling emits 120 timestamped aggregates at 30-second intervals and then stops", () => Effect.gen(function* () {
  const messages: unknown[] = []
  let reads = 0
  const logger = Logger.make((entry) => { messages.push(entry.message) })
  yield* Effect.gen(function* () {
    yield* MemoryDiagnostics.start(true, async () => ({
      runtime: "bun", version: "1.4.4",
      footprint: () => { reads++; return { current: reads * 10, peak: 2000 } },
      heap: () => { throw new Error("Unverified heap sampling must not run") },
    }))
    yield* TestClock.adjust(0)
    expect(messages).toHaveLength(1)
    yield* TestClock.adjust("29999 millis")
    expect(messages).toHaveLength(1)
    yield* TestClock.adjust("1 millis")
    expect(messages).toHaveLength(2)
    yield* TestClock.adjust("2 hours")
    expect(messages).toHaveLength(120)
    expect(reads).toBe(120)
    expect(messages[0]).toMatchObject(["memory sample", { sequence: 1, timestampMs: 0, rss: { value: 10 } }])
    expect(messages[119]).toMatchObject(["memory sample", { sequence: 120, timestampMs: 3_570_000, rss: { value: 1200 } }])
  }).pipe(Effect.provide(Logger.layer([logger])), Effect.provideService(References.MinimumLogLevel, "Debug"))
}))

it.effect("closing the owning scope cancels sampling and ignores late module completion", () => Effect.gen(function* () {
  let reads = 0
  yield* Effect.scoped(Effect.gen(function* () {
    yield* MemoryDiagnostics.start(true, async () => ({ runtime: "bun", version: "1.4.4", footprint: () => ({ current: ++reads }) }))
    yield* TestClock.adjust(0)
    expect(reads).toBe(1)
  }))
  yield* TestClock.adjust("1 hour")
  expect(reads).toBe(1)
  const pending = Promise.withResolvers<MemoryDiagnostics.Sources>()
  yield* Effect.scoped(MemoryDiagnostics.start(true, () => pending.promise))
  pending.resolve({ runtime: "bun", version: "1.4.4", footprint: () => ({ current: ++reads }) })
  yield* TestClock.adjust("1 hour")
  expect(reads).toBe(1)
}))

test("aggregate capture retains the private file logger, run ID and payload-free record shape", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-memory-log-"))
  const file = path.join(directory, "ycoding.log")
  try {
    await Effect.gen(function* () {
      yield* MemoryDiagnostics.start(true, async () => ({
        runtime: "node", version: "26.4.0", rss: () => 1024,
        heap: () => ({ heapUsed: 256, heapTotal: 512, external: 64, message: "private-payload" }),
      }))
      yield* TestClock.adjust(0)
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([Logging.fileLogger(file, "memory-test")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
      Effect.runPromise,
    )
    const line = (await fs.readFile(file, "utf8")).trim()
    expect(line.split("\n")).toHaveLength(1)
    expect(line).toContain("timestamp=")
    expect(line).toContain(" run=memory-test ")
    expect(line).toContain(" component=memory ")
    expect(line).toContain("rss.value=1024")
    expect(line).toContain("rss.unit=bytes")
    expect(line).toContain("role=server")
    expect(line).not.toContain("private-payload")
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
