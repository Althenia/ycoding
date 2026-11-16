import { Clock, Effect } from "effect"

export type Sources = {
  readonly runtime: "bun" | "node" | "unknown"
  readonly version: string
  readonly footprint?: () => unknown
  readonly rss?: () => unknown
  readonly peak?: () => unknown
  readonly heap?: () => unknown
  readonly moduleUnavailable?: boolean
}

type Runtime = {
  readonly versions: { readonly bun?: string; readonly node?: string }
  readonly memoryUsage?: (() => unknown) & { readonly rss?: () => unknown }
  readonly resourceUsage?: () => unknown
}

type Reading =
  | { readonly status: "available"; readonly value: unknown }
  | { readonly status: "unsupported" | "unavailable" | "error"; readonly reason: string }

export async function sources(
  runtime: Runtime = process,
  load: (specifier: string) => Promise<Record<string, unknown>> = (specifier) => import(specifier),
): Promise<Sources> {
  if (runtime.versions.bun) {
    const base = {
      runtime: "bun" as const,
      version: runtime.versions.bun,
      peak: runtime.resourceUsage?.bind(runtime),
    }
    try {
      const jsc = await load("bun:jsc")
      const footprint = jsc.memoryUsage
      return {
        ...base,
        footprint: typeof footprint === "function" ? () => footprint() : undefined,
      }
    } catch {
      return { ...base, moduleUnavailable: true }
    }
  }
  if (runtime.versions.node) return {
    runtime: "node",
    version: runtime.versions.node,
    rss: runtime.memoryUsage?.rss ? () => runtime.memoryUsage!.rss!() : undefined,
    peak: runtime.resourceUsage ? () => runtime.resourceUsage!() : undefined,
    heap: runtime.memoryUsage ? () => runtime.memoryUsage!() : undefined,
  }
  return { runtime: "unknown", version: "unknown" }
}

function read(get?: () => unknown, unavailable = false): Reading {
  if (!get) return unavailable
    ? { status: "unavailable", reason: "module-unavailable" }
    : { status: "unsupported", reason: "api-unavailable" }
  try {
    const value = get()
    return value === undefined || value === null
      ? { status: "unavailable", reason: "no-reading" }
      : { status: "available", value }
  } catch {
    return { status: "error", reason: "read-failed" }
  }
}

function metric(
  reading: Reading,
  source: string,
  basis: "current" | "process-lifetime-peak" | "process-lifetime-counter" | "unverified",
  field?: string,
  scale = 1,
  zeroUnavailable = false,
  unit: "bytes" | "count" = "bytes",
) {
  const metadata = { source, basis, unit }
  if (reading.status !== "available") return { ...metadata, ...reading }
  const selected = field === undefined ? reading : read(() => {
    if (typeof reading.value !== "object" || reading.value === null) return undefined
    return Reflect.get(reading.value, field)
  })
  if (selected.status !== "available") return { ...metadata, ...selected }
  const value = selected.value
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value * scale))
    return { ...metadata, status: "error" as const, reason: "invalid-reading" }
  if (zeroUnavailable && value === 0) return { ...metadata, status: "unavailable" as const, reason: "not-reported" }
  return { ...metadata, status: "available" as const, value: value * scale }
}

export function collect(input: Sources, timestampMs: number) {
  const footprint = read(input.footprint, input.moduleUnavailable)
  const heap = input.runtime === "node" ? read(input.heap, input.moduleUnavailable) : read()
  const resources = read(input.peak)
  const unsupported = read()
  const bun = input.runtime === "bun"
  const node = input.runtime === "node"
  return {
    timestampMs,
    runtime: {
      name: input.runtime,
      version: /^[a-zA-Z0-9.+-]{1,64}$/.test(input.version) ? input.version : "unknown",
    },
    rss: bun
      ? metric(footprint, "bun:jsc.memoryUsage.current", "current", "current", 1, true)
      : metric(read(input.rss, input.moduleUnavailable), "process.memoryUsage.rss", "current", undefined, 1, true),
    peakRss: bun
      ? metric(footprint, "bun:jsc.memoryUsage.peak", "process-lifetime-peak", "peak", 1, true)
      : metric(resources, "process.resourceUsage.maxRSS", "process-lifetime-peak", "maxRSS", 1024, true),
    commit: {
      current: metric(bun ? footprint : unsupported, "bun:jsc.memoryUsage.currentCommit", "current", "currentCommit"),
      peak: metric(bun ? footprint : unsupported, "bun:jsc.memoryUsage.peakCommit", "process-lifetime-peak", "peakCommit"),
    },
    pageFaults: {
      minor: metric(resources, "process.resourceUsage.minorPageFault", "process-lifetime-counter", "minorPageFault", 1, false, "count"),
      major: metric(resources, "process.resourceUsage.majorPageFault", "process-lifetime-counter", "majorPageFault", 1, false, "count"),
    },
    heap: {
      size: bun
        ? metric({ status: "unavailable", reason: "sampling-cost-unverified" }, "bun:jsc.heapSize", "unverified")
        : metric(heap, "process.memoryUsage.heapUsed", "current", "heapUsed"),
      capacity: metric(node ? heap : unsupported, node ? "process.memoryUsage.heapTotal" : "none", "current", "heapTotal"),
      external: metric(node ? heap : unsupported, node ? "process.memoryUsage.external" : "none", "current", "external"),
    },
    nativeAllocations: { status: "unavailable", reason: "not-measured" },
    allocatorRetained: { status: "unavailable", reason: "not-measured" },
  }
}

export function loadSources(load: () => Promise<Sources> = sources) {
  return Effect.promise(async () => {
    try {
      return await load()
    } catch {
      return { runtime: "unknown" as const, version: "unknown", moduleUnavailable: true }
    }
  })
}

export function start(enabled: boolean, load: () => Promise<Sources> = sources) {
  if (!enabled) return Effect.void
  return Effect.gen(function* () {
    const input = yield* loadSources(load)
    for (let index = 0; index < 120; index++) {
      const timestamp = yield* Clock.currentTimeMillis
      yield* Effect.logDebug("memory sample", { component: "memory", sequence: index + 1, ...collect(input, timestamp) })
        .pipe(Effect.annotateLogs({ role: "server" }))
      if (index < 119) yield* Effect.sleep("30 seconds")
    }
  }).pipe(Effect.forkScoped({ startImmediately: true }), Effect.asVoid)
}

export * as MemoryDiagnostics from "./memory"
