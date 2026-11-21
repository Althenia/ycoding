import { expect, test } from "bun:test"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Clock, Effect, Fiber, FileSystem, Option, PlatformError, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { join } from "node:path"
import type { EnsureOptions, Endpoint } from "../src/service.js"
import { pollDelay, startupTimeout } from "../src/service-poll.js"

type Kind = "promise" | "effect"
const kinds: Kind[] = ["promise", "effect"]
const info = {
  id: "synthetic-owner",
  pid: 41001,
  version: "test",
  url: "http://synthetic.invalid",
  password: "synthetic",
}
const ready = { healthy: true, pid: info.pid, version: info.version, sourceEpoch: info.id }
const missing = () => Object.assign(new Error("Synthetic missing registration"), { code: "ENOENT" })

async function fixture(kind: Kind) {
  let now = 1_000_000
  let registration: unknown = info
  let health: unknown = ready
  let status = 200
  let reads = 0
  let probes = 0
  let spawning = 0
  const stops: unknown[] = []
  const signals: unknown[] = []
  const removed: string[] = []
  const children: { exitCode: number | null; signalCode: string | null }[] = []
  let readHook: (() => unknown) | undefined
  let probeHook: (() => void) | undefined
  let spawnHook: (() => void) | undefined
  let signalHook: ((signal: string | number) => void) | undefined
  const read = async () => {
    reads++
    const value = readHook ? await readHook() : registration
    if (value instanceof Error) throw value
    return typeof value === "string" ? value : JSON.stringify(value)
  }
  const fs = FileSystem.layerNoop({
    readFileString: () =>
      Clock.currentTimeMillis.pipe(
        Effect.tap((time) =>
          Effect.sync(() => {
            now = 1_000_000 + time
          }),
        ),
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: read,
            catch: (cause) =>
              PlatformError.systemError({
                _tag:
                  cause instanceof Error && "code" in cause && cause.code === "ENOENT"
                    ? "NotFound"
                    : "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
                cause,
              }),
          }),
        ),
      ),
  })
  const dependencies = {
    ServiceStatus,
    Clock,
    Effect,
    FileSystem,
    Option,
    Schedule,
    Schema,
    pollDelay,
    startupTimeout,
    join,
    readFile: read,
    readFileSync: () => "",
    rmSync: (path: string) => {
      removed.push(path)
    },
    randomUUID: () => `candidate-${children.length}`,
    homedir: () => "/synthetic",
    Date: { now: () => now },
    setTimeout: (callback: () => void, delay: number) => {
      now += delay
      queueMicrotask(callback)
      return 0
    },
    process: {
      env: {},
      kill: (pid: number, signal: string | number) => {
        signals.push([pid, signal])
        signalHook?.(signal)
        if (signal === 0) throw missing()
      },
    },
    spawn: () => {
      spawning++
      const child = {
        exitCode: null,
        signalCode: null,
        once() {
          return this
        },
        unref() {},
      }
      children.push(child)
      spawnHook?.()
      return child
    },
    fetch: async (input: URL, init?: RequestInit) => {
      if (input.pathname === "/api/service/stop") {
        if (typeof init?.body !== "string") throw new Error("Expected serialized stop request")
        stops.push(JSON.parse(init.body))
        registration = missing()
        return Response.json({ accepted: true })
      }
      probes++
      expect(input.toString()).toBe("http://synthetic.invalid/api/health")
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic " + btoa("ycoding:synthetic"))
      probeHook?.()
      if (health instanceof Error) throw health
      return Response.json(health, { status })
    },
  }
  const source = await Bun.file(new URL(`../src/${kind}/service.ts`, import.meta.url)).text()
  const stripped = source
    .replace(/^import .*\n/gm, "")
    .replace(/^export \* from .*\n/gm, "")
    .replace(/\bexport /g, "")
  const code = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(stripped)
  const module = new Function(...Object.keys(dependencies), `${code}\nreturn { ensure, discover }`)(
    ...Object.values(dependencies),
  ) as {
    ensure: (options: EnsureOptions) => Promise<Endpoint> | Effect.Effect<Endpoint, Error, FileSystem.FileSystem>
    discover: (
      options: EnsureOptions,
    ) => Promise<Endpoint | undefined> | Effect.Effect<Endpoint | undefined, Error, FileSystem.FileSystem>
  }
  const options: EnsureOptions = { file: "/synthetic/registration.json", version: "test", existing: "preserve" }
  const effect = (value: Effect.Effect<Endpoint, Error, FileSystem.FileSystem>) => value.pipe(Effect.provide(fs))
  return {
    options,
    stops,
    signals,
    removed,
    children,
    get reads() {
      return reads
    },
    get probes() {
      return probes
    },
    get spawns() {
      return spawning
    },
    set registration(value: unknown) {
      registration = value
    },
    set health(value: unknown) {
      health = value
    },
    set status(value: number) {
      status = value
    },
    set onRead(value: () => unknown) {
      readHook = value
    },
    set onProbe(value: () => void) {
      probeHook = value
    },
    set onSpawn(value: () => void) {
      spawnHook = value
    },
    set onSignal(value: (signal: string | number) => void) {
      signalHook = value
    },
    async discover(overrides: Partial<EnsureOptions> = {}) {
      const result = module.discover({ ...options, ...overrides })
      if (result instanceof Promise) return result
      return Effect.runPromise(result.pipe(Effect.provide(fs)))
    },
    run(overrides: Partial<EnsureOptions> = {}): Promise<Endpoint> {
      const result = module.ensure({ ...options, ...overrides })
      if (result instanceof Promise) return result
      return Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* effect(result).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust("2 minutes")
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(TestClock.layer())),
      )
    },
    async interrupt(overrides: Partial<EnsureOptions> = {}) {
      const result = module.ensure({ ...options, ...overrides })
      if (result instanceof Promise) throw new Error("Expected interruptible Effect service")
      return Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* effect(result).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestClock.adjust("100 millis")
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(TestClock.layer())),
      )
    },
  }
}

function untouched(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.stops).toEqual([])
  expect(f.signals).toEqual([])
  expect(f.spawns).toBe(0)
}

for (const kind of kinds) {
  test(`${kind} preserve reuses a ready exact-version incumbent`, async () => {
    const f = await fixture(kind)
    expect(await f.run()).toEqual({
      url: info.url,
      auth: { type: "basic", username: "ycoding", password: "synthetic" },
    })
    untouched(f)
    expect(f.probes).toBe(1)
  })

  test(`${kind} preserve waits only for a compatible starting incumbent`, async () => {
    const f = await fixture(kind)
    f.status = 503
    f.onProbe = () => {
      if (f.probes === 2) f.status = 200
    }
    expect((await f.run()).url).toBe(info.url)
    untouched(f)
    expect(f.probes).toBe(2)
  })

  test(`${kind} preserve bounds a compatible starting incumbent`, async () => {
    const f = await fixture(kind)
    f.status = 503
    await expect(f.run()).rejects.toThrow("Timed out waiting for the background service to start")
    untouched(f)
  })

  for (const condition of [
    "failed",
    "incompatible",
    "corrupt",
    "unreadable",
    "invalid-info",
    "missing-id",
    "missing-version",
    "wrong-pid",
    "wrong-version",
    "wrong-epoch",
    "missing-epoch",
    "legacy",
    "unhealthy",
    "unauthorized",
    "unknown-status",
    "unreachable",
  ] as const) {
    test(`${kind} preserve rejects ${condition} without stopping or spawning`, async () => {
      const f = await fixture(kind)
      if (condition === "failed") f.status = 500
      if (condition === "incompatible") {
        f.registration = { ...info, version: "old" }
        f.health = { ...ready, version: "old" }
      }
      if (condition === "corrupt") f.registration = "{"
      if (condition === "unreadable")
        f.registration = Object.assign(new Error("Synthetic permission failure"), { code: "EACCES" })
      if (condition === "invalid-info") f.registration = { ...info, pid: -1 }
      if (condition === "missing-id") f.registration = { ...info, id: undefined }
      if (condition === "missing-version") f.registration = { ...info, version: undefined }
      if (condition === "wrong-pid") f.health = { ...ready, pid: 41002 }
      if (condition === "wrong-version") f.health = { ...ready, version: "other" }
      if (condition === "wrong-epoch") f.health = { ...ready, sourceEpoch: "other-owner" }
      if (condition === "missing-epoch") f.health = { ...ready, sourceEpoch: undefined }
      if (condition === "legacy") f.health = { healthy: true }
      if (condition === "unhealthy") f.health = { ...ready, healthy: false }
      if (condition === "unauthorized") f.status = 401
      if (condition === "unknown-status") f.status = 404
      if (condition === "unreachable") f.health = new Error("Synthetic health unavailable")
      f.onSpawn = () => {
        f.registration = info
        f.health = ready
        f.status = 200
      }
      await expect(f.run()).rejects.toThrow()
      untouched(f)
      expect(f.probes).toBeLessThanOrEqual(1)
    })
  }

  test(`${kind} preserve spawns only after confirmed absence`, async () => {
    const f = await fixture(kind)
    f.registration = missing()
    f.onSpawn = () => {
      f.registration = info
    }
    expect((await f.run()).url).toBe(info.url)
    expect(f.spawns).toBe(1)
    expect(f.stops).toEqual([])
    expect(f.signals).toEqual([])
  })

  test(`${kind} preserve observes an incompatible incumbent appearing inside the loop`, async () => {
    const f = await fixture(kind)
    f.status = 503
    f.onProbe = () => {
      if (f.probes === 2) {
        f.registration = { ...info, version: "old" }
        f.health = { ...ready, version: "old" }
      }
    }
    await expect(f.run()).rejects.toThrow()
    untouched(f)
  })

  test(`${kind} preserve rechecks registration after the startup callback`, async () => {
    const f = await fixture(kind)
    f.registration = missing()
    await expect(
      f.run({
        onStart: () => {
          f.registration = { ...info, version: "old" }
          f.health = { ...ready, version: "old" }
        },
      }),
    ).rejects.toThrow()
    untouched(f)
  })

  test(`${kind} preserve rejects registration replacement during health verification`, async () => {
    const f = await fixture(kind)
    f.onProbe = () => {
      f.registration = { ...info, id: "changed-owner" }
    }
    await expect(f.run()).rejects.toThrow()
    untouched(f)
  })

  test(`${kind} preserve contender loses to an incompatible incumbent without replacement`, async () => {
    const f = await fixture(kind)
    f.registration = missing()
    f.onSpawn = () => {
      f.children[0].exitCode = 0
      f.registration = { ...info, version: "old" }
      f.health = { ...ready, version: "old" }
    }
    await expect(f.run({ startupErrorFile: "/synthetic/candidate-error" })).rejects.toThrow()
    expect(f.spawns).toBe(1)
    expect(f.stops).toEqual([])
    expect(f.signals).toEqual([])
    expect(f.removed).toEqual(["/synthetic/candidate-error.candidate-0"])
  })

  test(`${kind} preserve simultaneous callers reuse a lock winner`, async () => {
    const f = await fixture(kind)
    f.registration = missing()
    f.onSpawn = () => {
      f.registration = info
    }
    const result = await Promise.all([f.run(), f.run()])
    expect(result.map((endpoint) => endpoint.url)).toEqual([info.url, info.url])
    expect(f.spawns).toBeLessThanOrEqual(2)
    expect(f.stops).toEqual([])
    expect(f.signals).toEqual([])
  })

  for (const policy of [undefined, "replace"] as const) {
    for (const condition of ["failed", "incompatible"] as const) {
      test(`${kind} ${policy ?? "default"} retains ${condition} replacement`, async () => {
        const f = await fixture(kind)
        if (condition === "failed") f.status = 500
        else {
          f.registration = { ...info, version: "old" }
          f.health = { ...ready, version: "old" }
        }
        f.onSpawn = () => {
          f.registration = info
          f.health = ready
          f.status = 200
        }
        expect((await f.run({ existing: policy })).url).toBe(info.url)
        expect(f.stops).toEqual([{ instanceID: info.id }])
        expect(f.signals.every((entry) => Array.isArray(entry) && entry[1] === 0)).toBe(true)
        expect(f.spawns).toBe(1)
      })
    }
  }
}

test("effect preserve interruption leaves incumbent and pending registration untouched", async () => {
  const f = await fixture("effect")
  f.status = 503
  await f.interrupt()
  untouched(f)
  expect(f.removed).toEqual([])
})

test("effect preserve interruption cancels a pending registration read", async () => {
  const f = await fixture("effect")
  f.onRead = () => new Promise<never>(() => {})
  await f.interrupt()
  untouched(f)
  expect(f.reads).toBe(1)
})

test("effect preserve interruption after spawn releases only its diagnostic handle", async () => {
  const f = await fixture("effect")
  f.registration = missing()
  f.onSpawn = () => {
    f.registration = info
    f.status = 503
  }
  await f.interrupt({ startupErrorFile: "/synthetic/candidate-error" })
  expect(f.spawns).toBe(1)
  expect(f.stops).toEqual([])
  expect(f.signals).toEqual([])
  expect(f.removed).toEqual(["/synthetic/candidate-error.candidate-0"])
})

test("promise discovery and default ensure accept valid registration with omitted identity fields", async () => {
  const f = await fixture("promise")
  f.registration = { url: info.url, pid: info.pid, password: "synthetic" }
  expect((await f.discover())?.url).toBe(info.url)
  expect((await f.run({ existing: undefined })).url).toBe(info.url)
  untouched(f)
})

for (const registration of [
  null,
  [],
  1,
  { ...info, url: 1 },
  { ...info, pid: "41001" },
  { ...info, pid: 0 },
  { ...info, pid: 1.5 },
  { ...info, id: 1 },
  { ...info, version: 1 },
  { ...info, password: {} },
]) {
  test(`promise discovery rejects malformed registration ${JSON.stringify(registration)} before health`, async () => {
    const f = await fixture("promise")
    f.registration = registration
    expect(await f.discover()).toBeUndefined()
    expect(f.probes).toBe(0)
    untouched(f)
  })
}

test("promise default ensure treats invalid registration as missing without a stop signal", async () => {
  const f = await fixture("promise")
  f.registration = { ...info, id: 1 }
  f.onSpawn = () => {
    f.registration = info
  }
  expect((await f.run({ existing: undefined })).url).toBe(info.url)
  expect(f.spawns).toBe(1)
  expect(f.stops).toEqual([])
  expect(f.signals).toEqual([])
})

test("promise discovery refuses legacy health without attempting replacement", async () => {
  const f = await fixture("promise")
  f.health = { healthy: true }
  expect(await f.discover()).toBeUndefined()
  untouched(f)
})

for (const policy of [undefined, "replace"] as const) {
  test(`promise ${policy ?? "default"} preserves legacy replacement and identity-guarded signals`, async () => {
    const f = await fixture("promise")
    f.health = { healthy: true }
    f.onSignal = (signal) => {
      if (signal === "SIGTERM") f.registration = missing()
    }
    f.onSpawn = () => {
      f.registration = info
      f.health = ready
    }
    expect((await f.run({ existing: policy })).url).toBe(info.url)
    expect(f.stops).toEqual([])
    expect(f.signals).toEqual([
      [info.pid, "SIGTERM"],
      [info.pid, 0],
    ])
    expect(f.spawns).toBe(1)
  })
}
