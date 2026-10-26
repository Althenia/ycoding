import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess } from "effect/unstable/process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { AppProcess } from "@ycoding-ai/core/process"
import { ProcessLock } from "@ycoding-ai/core/util/process-lock"
import { SystemSleep } from "@ycoding-ai/core/util/system-sleep"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

const make = (options: Omit<KeepAwake.Options, "userActivity">) => KeepAwake.make({
  ...options,
  userActivity: { set: (on) => on ? "on" : "off" },
})

const onStatus = { state: "on", display: "on", activity: "on", lid: "on", system: "on", sleepHold: false } as const
const offStatus = { state: "off", display: "off", activity: "off", lid: "off", system: "off", sleepHold: false } as const

const fakeClamshell = (fail = false) => {
  const calls: boolean[] = []
  return {
    calls,
    set: (on: boolean) => {
      calls.push(on)
      if (fail) return "error" as const
      return on ? ("on" as const) : ("off" as const)
    },
  }
}

const fakeSystem = (initial: { permitted?: boolean; failApply?: boolean; failRestore?: boolean } = {}) => {
  const behavior = { permitted: true, failApply: false, failRestore: false, ...initial }
  const calls: boolean[] = []
  const checks = { count: 0 }
  return {
    behavior,
    calls,
    checks,
    permitted: Effect.sync(() => {
      checks.count += 1
      return behavior.permitted
    }),
    set: (disabled: boolean) =>
      Effect.sync(() => {
        calls.push(disabled)
        if (disabled ? behavior.failApply : behavior.failRestore) return "error" as const
        return disabled ? ("on" as const) : ("off" as const)
      }),
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const eventually = <A>(read: () => Promise<A> | A, done: (value: A) => boolean) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 5_000
    let value = await read()
    while (!done(value) && Date.now() < deadline) {
      await Bun.sleep(20)
      value = await read()
    }
    return value
  })

const fixture = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "ycoding-keep-awake-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

const recordedChild = (directory: string, stop?: { requested: string; release: string }) => {
  const spawned: string[] = []
  const command = () => {
    const file = path.join(directory, `pid-${spawned.length}`)
    spawned.push(file)
    return ChildProcess.make(process.execPath, [
      "-e",
      `const fs = require("fs"); ${
        stop
          ? `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(stop.requested)}, "stopping"); setInterval(() => { if (fs.existsSync(${JSON.stringify(stop.release)})) process.exit(0) }, 10) });`
          : ""
      } fs.writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000)`,
    ])
  }
  const pid = (index: number) =>
    eventually(
      () => readFile(spawned[index], "utf8").catch(() => ""),
      (text) => text.length > 0,
    ).pipe(Effect.map(Number))
  return { command, spawned, pid }
}

describe("KeepAwake", () => {
  it.live("only the exclusive lid owner calls native control and non-owner shutdown preserves it", () => Effect.gen(function* () {
    const directory = yield* fixture
    const lidFile = path.join(directory, "lid.json")
    const firstNative = fakeClamshell()
    const secondNative = fakeClamshell()
    const firstScope = yield* Scope.make()
    const secondScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
    yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
    const spawner = yield* AppProcess.Service
    const first = yield* make({ spawner, platform: "darwin", pid: process.pid, systemSleep: fakeSystem(), clamshell: firstNative, lidFile, command: recordedChild(directory).command }).pipe(Effect.provideService(Scope.Scope, firstScope))
    expect(firstNative.calls).toEqual([])
    yield* first.set(true)
    expect(firstNative.calls).toEqual([true])
    const second = yield* make({ spawner, platform: "darwin", pid: process.pid, systemSleep: fakeSystem(), clamshell: secondNative, lidFile, command: recordedChild(directory).command }).pipe(Effect.provideService(Scope.Scope, secondScope))
    expect(yield* second.set(true)).toMatchObject({ state: "on", lid: "held", message: "Lid control is held by another YCoding process." })
    yield* second.set(false)
    yield* Scope.close(secondScope, Exit.void)
    expect(secondNative.calls).toEqual([])
    expect(firstNative.calls).toEqual([true])
    expect(JSON.parse(yield* Effect.promise(() => readFile(lidFile, "utf8")))).toEqual({ armed: true, system: true })
    yield* first.set(false)
    expect(firstNative.calls).toEqual([true, false])
  }))

  it.effect("a sleeping non-owner takes lid ownership at its next 1-second reapply", () => Effect.gen(function* () {
    const directory = yield* fixture
    const owner = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
    const lidFile = path.join(directory, "lid.json")
    yield* ProcessLock.acquire(lidFile).pipe(Effect.provideService(Scope.Scope, owner))
    yield* Effect.promise(() => writeFile(lidFile, JSON.stringify({ armed: true })))
    const native = fakeClamshell()
    const spawner = yield* AppProcess.Service
    const spawned = yield* Deferred.make<void>()
    const reapplied = yield* Deferred.make<void>()
    const awake = yield* make({
      spawner: { ...spawner, spawn: (command) => spawner.spawn(command).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))) },
      platform: "darwin", pid: process.pid, lidFile, command: recordedChild(directory).command,
      systemSleep: fakeSystem(), clamshell: { set: (on) => { if (on) Effect.runSync(Deferred.succeed(reapplied, undefined)); return native.set(on) } },
    })
    const holding = yield* awake.hold("sleeping").pipe(Effect.forkScoped)
    yield* Deferred.await(spawned)
    yield* TestClock.adjust("300 millis")
    yield* Fiber.join(holding)
    expect((yield* awake.get).lid).toBe("held")
    yield* Scope.close(owner, Exit.void)
    yield* TestClock.adjust("999 millis")
    expect(native.calls).toEqual([])
    yield* TestClock.adjust("1 millis")
    yield* Deferred.await(reapplied)
    expect(native.calls).toEqual([true])
    expect((yield* awake.get).lid).toBe("on")
  }))

  it.live("startup restores only an armed file whose former owner's lock is available", () => Effect.gen(function* () {
    const directory = yield* fixture
    const lidFile = path.join(directory, "lid.json")
    const native = fakeClamshell()
    const ownerScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void))
    yield* ProcessLock.acquire(lidFile).pipe(Effect.provideService(Scope.Scope, ownerScope))
    yield* Effect.promise(() => writeFile(lidFile, JSON.stringify({ armed: true })))
    const spawner = yield* AppProcess.Service
    yield* make({ spawner, platform: "darwin", pid: process.pid, systemSleep: fakeSystem(), clamshell: native, lidFile })
    expect(native.calls).toEqual([])
    yield* Scope.close(ownerScope, Exit.void)
    yield* make({ spawner, platform: "darwin", pid: process.pid, systemSleep: fakeSystem(), clamshell: native, lidFile })
    expect(native.calls).toEqual([false])
    yield* make({ spawner, platform: "darwin", pid: process.pid, systemSleep: fakeSystem(), clamshell: native, lidFile })
    expect(native.calls).toEqual([false])
  }))
  for (const reset of ["power-source change", "wake"] as const) {
    it.live(`reapplies lid control after a native reset on ${reset} and disarms on shutdown`, () =>
      Effect.gen(function* () {
        const directory = yield* fixture
        const child = recordedChild(directory)
        const reapplied = yield* Deferred.make<void>()
        let on = false
        let resetOccurred = false
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const awake = yield* make({
          spawner: yield* AppProcess.Service,
          platform: "darwin",
          pid: process.pid,
          lidFile: path.join(directory, "lid.json"),
          command: child.command,
          reapplyInterval: "10 millis",
          systemSleep: fakeSystem(), clamshell: {
            set: (value) => {
              on = value
              if (value && resetOccurred) Effect.runSync(Deferred.succeed(reapplied, undefined))
              return value ? "on" : "off"
            },
          },
        }).pipe(Effect.provideService(Scope.Scope, scope))
        yield* awake.set(true)
        expect(on).toBe(true)
        on = false
        resetOccurred = true
        yield* Deferred.await(reapplied)
        expect(on).toBe(true)
        yield* Scope.close(scope, Exit.void)
        expect(on).toBe(false)
      }),
    )
  }
  it.live("builds the macOS inhibitor that releases itself when the backend pid exits", () =>
    Effect.sync(() => {
      expect(KeepAwake.macOSInhibitor(4242)).toMatchObject({
        command: "/usr/bin/caffeinate",
        args: ["-d", "-i", "-w", "4242"],
      })
    }),
  )

  it.live("reports unsupported and never spawns on platforms without a verified inhibitor", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "linux",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: child.command,
      })
      const unsupported = {
        state: "unsupported",
        display: "unsupported",
        activity: "unsupported",
        lid: "unsupported",
        system: "unsupported",
        sleepHold: false,
        message: "Keep machine awake is available on macOS only.",
      } as const
      expect(yield* awake.get).toEqual(unsupported)
      expect(yield* awake.set(true)).toEqual(unsupported)
      expect(yield* awake.set(false)).toEqual(unsupported)
      expect(child.spawned).toEqual([])
    }),
  )

  it.live("starts one inhibitor, keeps enabling idempotent, and stops it on disable", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: child.command,
      })
      expect(yield* awake.get).toEqual(offStatus)
      expect(yield* awake.set(true)).toEqual(onStatus)
      const pid = yield* child.pid(0)
      expect(alive(pid)).toBe(true)
      expect(yield* awake.set(true)).toEqual(onStatus)
      expect(child.spawned).toHaveLength(1)
      expect(yield* awake.get).toEqual(onStatus)

      expect(yield* awake.set(false)).toEqual(offStatus)
      expect(
        yield* eventually(
          () => alive(pid),
          (running) => !running,
        ),
      ).toBe(false)
      expect(yield* awake.set(false)).toEqual(offStatus)
      expect(child.spawned).toHaveLength(1)
    }),
  )

  it.live("serializes concurrent switches into one inhibitor", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: child.command,
      })
      const results = yield* Effect.all([awake.set(true), awake.set(true), awake.set(true)], {
        concurrency: "unbounded",
      })
      expect(results).toEqual([
        onStatus,
        onStatus,
        onStatus,
      ])
      expect(child.spawned).toHaveLength(1)
      const pid = yield* child.pid(0)
      const [off, on] = yield* Effect.all([awake.set(false), awake.set(true)], { concurrency: "unbounded" })
      expect(off).toEqual(offStatus)
      expect(on).toEqual(onStatus)
      expect(child.spawned).toHaveLength(2)
      expect(
        yield* eventually(
          () => alive(pid),
          (running) => !running,
        ),
      ).toBe(false)
      expect(alive(yield* child.pid(1))).toBe(true)
    }),
  )

  it.live("reports a bounded error when the inhibitor cannot start and recovers on the next request", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      let broken = true
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: () =>
          broken ? ChildProcess.make(path.join(directory, "missing-inhibitor"), ["secret-argument"]) : child.command(),
      })
      const failed = yield* awake.set(true)
      expect(failed).toEqual({
        state: "error",
        display: "error",
        activity: "off",
        lid: "off",
        system: "off",
        sleepHold: false,
        message: "The sleep inhibitor could not be started.",
      })
      expect(yield* awake.get).toEqual(failed)
      expect(JSON.stringify(failed)).not.toContain("secret-argument")
      expect(JSON.stringify(failed)).not.toContain(directory)

      broken = false
      expect(yield* awake.set(true)).toEqual(onStatus)
      expect(yield* awake.set(false)).toEqual(offStatus)
    }),
  )

  it.live("reports an error when the inhibitor exits immediately after starting", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: () => ChildProcess.make(process.execPath, ["-e", "process.exit(3)"]),
      })
      expect(yield* awake.set(true)).toEqual({
        state: "error",
        display: "error",
        activity: "off",
        lid: "off",
        system: "off",
        sleepHold: false,
        message: "The sleep inhibitor stopped unexpectedly (exit code 3).",
      })
      expect(yield* awake.get).toEqual({
        state: "error",
        display: "error",
        activity: "off",
        lid: "off",
        system: "off",
        sleepHold: false,
        message: "The sleep inhibitor stopped unexpectedly (exit code 3).",
      })
      expect(yield* awake.set(false)).toEqual(offStatus)
    }),
  )

  it.live("turns an unexpected inhibitor exit into an error without rearming it", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: child.command,
      })
      expect(yield* awake.set(true)).toEqual(onStatus)
      const pid = yield* child.pid(0)
      process.kill(pid, "SIGKILL")
      const status = yield* eventually(
        () => Effect.runPromise(awake.get),
        (value) => value.state !== "on",
      )
      expect(status.state).toBe("error")
      expect(status.message).toContain("The sleep inhibitor stopped unexpectedly")
      expect(child.spawned).toHaveLength(1)
      expect(yield* awake.set(true)).toEqual(onStatus)
      expect(child.spawned).toHaveLength(2)
    }),
  )

  it.live("releases the inhibitor when the owning scope closes", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const spawner = yield* AppProcess.Service
      const scope = yield* Scope.make()
      const awake = yield* make({
        spawner,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: child.command,
      }).pipe(Effect.provideService(Scope.Scope, scope))
      expect(yield* awake.set(true)).toEqual(onStatus)
      const pid = yield* child.pid(0)
      expect(alive(pid)).toBe(true)
      yield* Scope.close(scope, Exit.void)
      expect(
        yield* eventually(
          () => alive(pid),
          (running) => !running,
        ),
      ).toBe(false)
    }),
  )

  for (const phase of ["spawn", "grace"] as const) {
    it.effect(`cleans up cancellation during startup ${phase} without reporting on`, () =>
      Effect.gen(function* () {
        const directory = yield* fixture
        const child = recordedChild(directory)
        const spawner = yield* AppProcess.Service
        const cleanup = yield* Scope.Scope
        const spawned = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const awake = yield* make({
          spawner: {
            ...spawner,
            spawn: (command) =>
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(command)
                yield* Scope.addFinalizer(
                  cleanup,
                  handle.isRunning.pipe(
                    Effect.flatMap((running) => (running ? handle.kill() : Effect.void)),
                    Effect.orDie,
                  ),
                )
                yield* Deferred.succeed(spawned, undefined)
                if (phase === "spawn") yield* Deferred.await(resume)
                return handle
              }),
          },
          platform: "darwin",
          pid: process.pid,
          lidFile: path.join(directory, "lid.json"),
          systemSleep: fakeSystem(), clamshell: fakeClamshell(),
          command: child.command,
        })
        const starting = yield* awake.set(true).pipe(Effect.forkScoped)
        yield* Deferred.await(spawned)
        const pid = yield* child.pid(0)
        expect(pid).toBeGreaterThan(0)
        expect(alive(pid)).toBe(true)
        expect(yield* awake.get).toEqual(offStatus)
        yield* Fiber.interrupt(starting)
        expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true)
        expect(
          yield* eventually(
            () => alive(pid),
            (running) => !running,
          ),
        ).toBe(false)
        expect(yield* awake.get).toEqual(offStatus)
        expect(yield* awake.set(false)).toEqual(offStatus)
        expect(child.spawned).toHaveLength(1)
      }),
    )
  }

  for (const action of ["disable", "owner close"] as const) {
    it.live(`finishes cleanup and reports off when ${action} is cancelled during child termination`, () =>
      Effect.gen(function* () {
        const directory = yield* fixture
        const stop = { requested: path.join(directory, "stopping"), release: path.join(directory, "release") }
        const child = recordedChild(directory, stop)
        const spawner = yield* AppProcess.Service
        const cleanup = yield* Scope.Scope
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const awake = yield* make({
          spawner: {
            ...spawner,
            spawn: (command) =>
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(command)
                yield* Scope.addFinalizer(
                  cleanup,
                  handle.isRunning.pipe(
                    Effect.flatMap((running) => (running ? handle.kill({ killSignal: "SIGKILL" }) : Effect.void)),
                    Effect.orDie,
                  ),
                )
                return handle
              }),
          },
          platform: "darwin",
          pid: process.pid,
          lidFile: path.join(directory, "lid.json"),
          systemSleep: fakeSystem(), clamshell: fakeClamshell(),
          command: child.command,
        }).pipe(Effect.provideService(Scope.Scope, scope))
        expect(yield* awake.set(true)).toEqual(onStatus)
        const pid = yield* child.pid(0)
        expect(alive(pid)).toBe(true)
        const closing = yield* (action === "disable" ? awake.set(false) : Scope.close(scope, Exit.void)).pipe(
          Effect.forkScoped,
        )
        expect(
          yield* eventually(
            () => readFile(stop.requested, "utf8").catch(() => ""),
            (text) => text === "stopping",
          ),
        ).toBe("stopping")
        const interrupted = yield* Fiber.interrupt(closing).pipe(Effect.forkScoped({ startImmediately: true }))
        const pending = closing.pollUnsafe()
        const running = alive(pid)
        yield* Effect.promise(() => writeFile(stop.release, "release"))
        yield* Fiber.join(interrupted)
        expect(pending).toBeUndefined()
        expect(running).toBe(true)
        expect(
          yield* eventually(
            () => alive(pid),
            (running) => !running,
          ),
        ).toBe(false)
        expect(yield* awake.get).toEqual(offStatus)
        expect(child.spawned).toHaveLength(1)
      }),
    )
  }

  it.effect("retains owner cleanup when scope closure is cancelled while startup holds the switch gate", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const spawner = yield* AppProcess.Service
      const cleanup = yield* Scope.Scope
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const spawned = yield* Deferred.make<void>()
      const awake = yield* make({
        spawner: {
          ...spawner,
          spawn: (command) =>
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(command)
              yield* Scope.addFinalizer(
                cleanup,
                handle.isRunning.pipe(
                  Effect.flatMap((running) => (running ? handle.kill() : Effect.void)),
                  Effect.orDie,
                ),
              )
              yield* Deferred.succeed(spawned, undefined)
              return handle
            }),
        },
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: child.command,
      }).pipe(Effect.provideService(Scope.Scope, scope))
      const starting = yield* awake.set(true).pipe(Effect.forkScoped)
      yield* Deferred.await(spawned)
      const pid = yield* child.pid(0)
      expect(pid).toBeGreaterThan(0)
      expect(alive(pid)).toBe(true)
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped({ startImmediately: true }))
      const interrupted = yield* Fiber.interrupt(closing).pipe(Effect.forkScoped({ startImmediately: true }))
      const pending = closing.pollUnsafe()
      yield* Fiber.interrupt(starting)
      yield* Fiber.join(interrupted)
      expect(pending).toBeUndefined()
      expect(
        yield* eventually(
          () => alive(pid),
          (running) => !running,
        ),
      ).toBe(false)
      expect(yield* awake.get).toEqual(offStatus)
      expect(child.spawned).toHaveLength(1)
    }),
  )

  it.live("sleep holds keep it on after manual off and restore manual-off on the last release", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const lid = fakeClamshell()
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: lid,
        command: child.command,
      })
      expect(lid.calls).toEqual([])
      expect(yield* awake.hold("ses_one")).toEqual({ ...onStatus, sleepHold: true, manual: false })
      expect(yield* awake.hold("ses_two")).toEqual({ ...onStatus, sleepHold: true, manual: false })
      expect(child.spawned).toHaveLength(1)
      expect(yield* awake.set(false)).toEqual({ ...onStatus, sleepHold: true, manual: false })
      expect(yield* awake.release("ses_one")).toEqual({ ...onStatus, sleepHold: true, manual: false })
      expect(yield* awake.release("ses_two")).toEqual(offStatus)
      expect(lid.calls).toEqual([true, false])
    }),
  )

  it.live("unsupported lid control releases its claim without leaving a crash-recovery arm record", () => Effect.gen(function* () {
    const directory = yield* fixture
    const lidFile = path.join(directory, "lid.json")
    const spawner = yield* AppProcess.Service
    const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, systemSleep: fakeSystem(), clamshell: { set: () => "unsupported" }, command: recordedChild(directory).command })
    expect(yield* awake.set(true)).toMatchObject({ state: "on", lid: "unsupported" })
    expect(JSON.parse(yield* Effect.promise(() => readFile(lidFile, "utf8")))).toEqual({ armed: false })
    const native = fakeClamshell()
    yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, systemSleep: fakeSystem(), clamshell: native })
    expect(native.calls).toEqual([])
  }))

  it.live("a failed disarm retains its arm record and an explicit retry restores normal lid sleep", () => Effect.gen(function* () {
    const directory = yield* fixture
    const lidFile = path.join(directory, "lid.json")
    let fail = true
    const calls: boolean[] = []
    const awake = yield* make({
      spawner: yield* AppProcess.Service, platform: "darwin", pid: process.pid, lidFile,
      command: recordedChild(directory).command,
      systemSleep: fakeSystem(), clamshell: { set: (on) => {
        calls.push(on)
        return !on && fail ? "error" : on ? "on" : "off"
      } },
    })
    yield* awake.set(true)
    expect(yield* awake.set(false)).toMatchObject({ state: "off", lid: "error" })
    expect(JSON.parse(yield* Effect.promise(() => readFile(lidFile, "utf8")))).toEqual({ armed: true })
    fail = false
    expect(yield* awake.set(false)).toMatchObject({ state: "off", lid: "off" })
    expect(calls).toEqual([true, false, false])
    expect(JSON.parse(yield* Effect.promise(() => readFile(lidFile, "utf8")))).toEqual({ armed: false })
  }))

  it.live("unavailable native recovery preserves a predecessor's armed record", () => Effect.gen(function* () {
    const directory = yield* fixture
    const lidFile = path.join(directory, "lid.json")
    yield* Effect.promise(() => writeFile(lidFile, JSON.stringify({ armed: true })))
    const awake = yield* make({ spawner: yield* AppProcess.Service, platform: "darwin", pid: process.pid, lidFile, systemSleep: fakeSystem(), clamshell: { set: () => "unsupported" } })
    expect(yield* awake.get).toMatchObject({ lid: "unsupported" })
    expect(JSON.parse(yield* Effect.promise(() => readFile(lidFile, "utf8")))).toEqual({ armed: true })
  }))

  it.live("releasing the last sleep hold restores a manual-on state", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const lid = fakeClamshell()
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: lid,
        command: child.command,
      })
      expect(yield* awake.set(true)).toEqual(onStatus)
      expect(yield* awake.hold("ses_one")).toEqual({ ...onStatus, sleepHold: true, manual: true })
      expect(yield* awake.release("ses_one")).toEqual(onStatus)
      expect(child.spawned).toHaveLength(1)
      expect(yield* awake.set(false)).toEqual(offStatus)
    }),
  )

  it.live("reports the lid part as error while idle keep-awake stays on", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(true),
        command: child.command,
      })
      expect(yield* awake.hold("ses_one")).toEqual({
        state: "on",
        display: "on",
        activity: "on",
        lid: "error",
        system: "on",
        sleepHold: true,
        manual: false,
        message: "Lid-closed keep-awake could not be armed; closing the lid may sleep this machine.",
      })
      expect(yield* awake.release("ses_one")).toMatchObject({ state: "off", sleepHold: false })
    }),
  )

  it.live("holds report unsupported without spawning on unsupported platforms", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* make({
        spawner: yield* AppProcess.Service,
        platform: "linux",
        pid: process.pid,
        lidFile: path.join(directory, "lid.json"),
        systemSleep: fakeSystem(), clamshell: fakeClamshell(),
        command: child.command,
      })
      expect(yield* awake.hold("ses_one")).toMatchObject({ state: "unsupported", lid: "unsupported", sleepHold: true })
      expect(yield* awake.release("ses_one")).toMatchObject({
        state: "unsupported",
        lid: "unsupported",
        system: "unsupported",
        sleepHold: false,
      })
      expect(child.spawned).toEqual([])
    }),
  )

  describe("system sleep", () => {
    const setup = Effect.gen(function* () {
      const directory = yield* fixture
      return {
        directory,
        lidFile: path.join(directory, "lid.json"),
        child: recordedChild(directory),
        spawner: yield* AppProcess.Service,
      }
    })
    const record = (lidFile: string) => Effect.promise(() => readFile(lidFile, "utf8").then((text) => JSON.parse(text)))
    const setupMessage = "System sleep hold needs one-time setup: run `ycoding keep-awake setup`."
    const applyMessage = "System sleep could not be disabled; a closed lid may still sleep during power changes."
    const restoreMessage = "System sleep could not be restored; run `sudo pmset -a disablesleep 0`."

    it.live("applies once on turn-on and not on reapply ticks, then restores on disable", () =>
      Effect.gen(function* () {
        const { lidFile, child, spawner } = yield* setup
        const lid = fakeClamshell()
        const system = fakeSystem()
        const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, command: child.command, clamshell: lid, systemSleep: system, reapplyInterval: "10 millis" })
        expect(yield* awake.hold("ses_one")).toMatchObject({ state: "on", lid: "on", system: "on", sleepHold: true })
        expect(yield* record(lidFile)).toEqual({ armed: true, system: true })
        yield* eventually(() => lid.calls.length, (count) => count >= 4)
        expect(system.calls).toEqual([true])
        expect(system.checks.count).toBe(1)
        expect(yield* awake.release("ses_one")).toEqual(offStatus)
        expect(system.calls).toEqual([true, false])
        expect(yield* record(lidFile)).toEqual({ armed: false })
      }),
    )

    it.live("restores when the owning scope closes", () =>
      Effect.gen(function* () {
        const { lidFile, child, spawner } = yield* setup
        const system = fakeSystem()
        const scope = yield* Scope.make()
        const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, command: child.command, clamshell: fakeClamshell(), systemSleep: system }).pipe(Effect.provideService(Scope.Scope, scope))
        yield* awake.set(true)
        expect(system.calls).toEqual([true])
        yield* Scope.close(scope, Exit.void)
        expect(system.calls).toEqual([true, false])
        expect(yield* record(lidFile)).toEqual({ armed: false })
      }),
    )

    it.live("reports setup without calling pmset when the sudoers rule is missing and keeps the unprivileged hold", () =>
      Effect.gen(function* () {
        const { lidFile, child, spawner } = yield* setup
        const lid = fakeClamshell()
        const system = fakeSystem({ permitted: false })
        const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, command: child.command, clamshell: lid, systemSleep: system, reapplyInterval: "10 millis" })
        expect(yield* awake.set(true)).toEqual({ ...onStatus, system: "setup", message: setupMessage })
        yield* eventually(() => lid.calls.length, (count) => count >= 4)
        expect(system.checks.count).toBe(1)
        expect(system.calls).toEqual([])
        expect(yield* record(lidFile)).toEqual({ armed: true })
        expect(yield* awake.set(false)).toEqual(offStatus)
        expect(system.calls).toEqual([])
      }),
    )

    it.live("a non-owner reports held and never checks or changes system sleep", () =>
      Effect.gen(function* () {
        const { lidFile, child, spawner } = yield* setup
        const owner = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
        yield* ProcessLock.acquire(lidFile).pipe(Effect.provideService(Scope.Scope, owner))
        yield* Effect.promise(() => writeFile(lidFile, JSON.stringify({ armed: true, system: true })))
        const system = fakeSystem()
        const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, command: child.command, clamshell: fakeClamshell(), systemSleep: system })
        expect(yield* awake.set(true)).toMatchObject({ state: "on", lid: "held", system: "held" })
        expect(yield* awake.set(false)).toMatchObject({ system: "held" })
        expect(system.calls).toEqual([])
        expect(system.checks.count).toBe(0)
        expect(yield* record(lidFile)).toEqual({ armed: true, system: true })
      }),
    )

    it.live("an apply failure reports an error while idle and lid hold stay on and is not retried", () =>
      Effect.gen(function* () {
        const { lidFile, child, spawner } = yield* setup
        const lid = fakeClamshell()
        const system = fakeSystem({ failApply: true })
        const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, command: child.command, clamshell: lid, systemSleep: system, reapplyInterval: "10 millis" })
        expect(yield* awake.set(true)).toEqual({ ...onStatus, system: "error", message: applyMessage })
        yield* eventually(() => lid.calls.length, (count) => count >= 4)
        expect(system.calls).toEqual([true])
        expect(yield* awake.get).toMatchObject({ state: "on", system: "error" })
        expect(yield* awake.set(false)).toEqual(offStatus)
        expect(system.calls).toEqual([true])
        expect(yield* record(lidFile)).toEqual({ armed: false })
      }),
    )

    it.live("a restore failure keeps the record and an explicit disable retries", () =>
      Effect.gen(function* () {
        const { lidFile, child, spawner } = yield* setup
        const system = fakeSystem({ failRestore: true })
        const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, command: child.command, clamshell: fakeClamshell(), systemSleep: system })
        yield* awake.set(true)
        expect(yield* awake.set(false)).toMatchObject({ state: "off", system: "error", message: restoreMessage })
        expect(yield* record(lidFile)).toEqual({ armed: false, system: true })
        expect(yield* awake.get).toMatchObject({ system: "error", message: restoreMessage })
        system.behavior.failRestore = false
        expect(yield* awake.set(false)).toEqual(offStatus)
        expect(system.calls).toEqual([true, false, false])
        expect(yield* record(lidFile)).toEqual({ armed: false })
      }),
    )

    it.live("startup restores only a system record whose lock is free", () =>
      Effect.gen(function* () {
        const { lidFile, spawner } = yield* setup
        const owner = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
        yield* ProcessLock.acquire(lidFile).pipe(Effect.provideService(Scope.Scope, owner))
        yield* Effect.promise(() => writeFile(lidFile, JSON.stringify({ armed: true, system: true })))
        const system = fakeSystem()
        const creating = make({ spawner, platform: "darwin", pid: process.pid, lidFile, clamshell: fakeClamshell(), systemSleep: system })
        yield* creating
        expect(system.calls).toEqual([])
        expect(yield* record(lidFile)).toEqual({ armed: true, system: true })
        yield* Scope.close(owner, Exit.void)
        yield* creating
        expect(system.calls).toEqual([false])
        expect(yield* record(lidFile)).toEqual({ armed: false })
        yield* creating
        expect(system.calls).toEqual([false])
      }),
    )

    it.live("startup restores a system record whose lid was already disarmed", () =>
      Effect.gen(function* () {
        const { lidFile, spawner } = yield* setup
        yield* Effect.promise(() => writeFile(lidFile, JSON.stringify({ armed: false, system: true })))
        const system = fakeSystem()
        yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, clamshell: fakeClamshell(), systemSleep: system })
        expect(system.calls).toEqual([false])
        expect(yield* record(lidFile)).toEqual({ armed: false })
      }),
    )

    it.live("restores system sleep when the inhibitor stops unexpectedly", () =>
      Effect.gen(function* () {
        const { lidFile, child, spawner } = yield* setup
        const system = fakeSystem()
        const awake = yield* make({ spawner, platform: "darwin", pid: process.pid, lidFile, command: child.command, clamshell: fakeClamshell(), systemSleep: system })
        yield* awake.set(true)
        process.kill(yield* child.pid(0), "SIGKILL")
        const status = yield* eventually(() => Effect.runPromise(awake.get), (value) => value.state !== "on")
        expect(status).toMatchObject({ state: "error", system: "off" })
        expect(system.calls).toEqual([true, false])
      }),
    )

    it.live("runs only the narrow non-interactive sudo pmset commands on macOS", () =>
      Effect.gen(function* () {
        const spawner = yield* AppProcess.Service
        const commands: string[][] = []
        let exitCode = 0
        const system = SystemSleep.make("darwin", {
          ...spawner,
          run: (command) =>
            Effect.sync(() => {
              if (command._tag !== "StandardCommand") throw new Error("unexpected command")
              commands.push([command.command, ...command.args])
              return { command: "", exitCode, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false }
            }),
        })
        expect(yield* system.permitted).toBe(true)
        expect(yield* system.set(true)).toBe("on")
        expect(yield* system.set(false)).toBe("off")
        expect(commands).toEqual([
          ["/usr/bin/sudo", "-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"],
          ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-a", "disablesleep", "1"],
          ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-a", "disablesleep", "0"],
        ])
        exitCode = 1
        expect(yield* system.permitted).toBe(false)
        expect(yield* system.set(true)).toBe("error")
      }),
    )

    it.live("never spawns pmset or sudo on unsupported platforms", () =>
      Effect.gen(function* () {
        const spawner = yield* AppProcess.Service
        const spawned: string[] = []
        const system = SystemSleep.make("linux", {
          ...spawner,
          run: (command) => Effect.sync(() => { spawned.push(JSON.stringify(command)); throw new Error("spawned") }),
          spawn: (command) => spawner.spawn(command).pipe(Effect.tap(() => Effect.sync(() => spawned.push("spawn")))),
        })
        expect(yield* system.permitted).toBe(false)
        expect(yield* system.set(true)).toBe("error")
        expect(spawned).toEqual([])
      }),
    )
  })
})
