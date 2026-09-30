import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { AppProcess } from "@ycoding-ai/core/process"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))

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
  it.live("builds the macOS inhibitor that releases itself when the backend pid exits", () =>
    Effect.sync(() => {
      expect(KeepAwake.macOSInhibitor(4242)).toMatchObject({
        command: "/usr/bin/caffeinate",
        args: ["-i", "-w", "4242"],
      })
    }),
  )

  it.live("reports unsupported and never spawns on platforms without a verified inhibitor", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* KeepAwake.make({
        spawner: yield* AppProcess.Service,
        platform: "linux",
        pid: process.pid,
        command: child.command,
      })
      const unsupported = { state: "unsupported", message: "Keep machine awake is available on macOS only." } as const
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
      const awake = yield* KeepAwake.make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        command: child.command,
      })
      expect(yield* awake.get).toEqual({ state: "off" })
      expect(yield* awake.set(true)).toEqual({ state: "on" })
      const pid = yield* child.pid(0)
      expect(alive(pid)).toBe(true)
      expect(yield* awake.set(true)).toEqual({ state: "on" })
      expect(child.spawned).toHaveLength(1)
      expect(yield* awake.get).toEqual({ state: "on" })

      expect(yield* awake.set(false)).toEqual({ state: "off" })
      expect(
        yield* eventually(
          () => alive(pid),
          (running) => !running,
        ),
      ).toBe(false)
      expect(yield* awake.set(false)).toEqual({ state: "off" })
      expect(child.spawned).toHaveLength(1)
    }),
  )

  it.live("serializes concurrent switches into one inhibitor", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* KeepAwake.make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        command: child.command,
      })
      const results = yield* Effect.all([awake.set(true), awake.set(true), awake.set(true)], {
        concurrency: "unbounded",
      })
      expect(results).toEqual([{ state: "on" }, { state: "on" }, { state: "on" }])
      expect(child.spawned).toHaveLength(1)
      const pid = yield* child.pid(0)
      const [off, on] = yield* Effect.all([awake.set(false), awake.set(true)], { concurrency: "unbounded" })
      expect(off).toEqual({ state: "off" })
      expect(on).toEqual({ state: "on" })
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
      const awake = yield* KeepAwake.make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        command: () =>
          broken ? ChildProcess.make(path.join(directory, "missing-inhibitor"), ["secret-argument"]) : child.command(),
      })
      const failed = yield* awake.set(true)
      expect(failed).toEqual({ state: "error", message: "The sleep inhibitor could not be started." })
      expect(yield* awake.get).toEqual(failed)
      expect(JSON.stringify(failed)).not.toContain("secret-argument")
      expect(JSON.stringify(failed)).not.toContain(directory)

      broken = false
      expect(yield* awake.set(true)).toEqual({ state: "on" })
      expect(yield* awake.set(false)).toEqual({ state: "off" })
    }),
  )

  it.live("reports an error when the inhibitor exits immediately after starting", () =>
    Effect.gen(function* () {
      const awake = yield* KeepAwake.make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        command: () => ChildProcess.make(process.execPath, ["-e", "process.exit(3)"]),
      })
      expect(yield* awake.set(true)).toEqual({
        state: "error",
        message: "The sleep inhibitor stopped unexpectedly (exit code 3).",
      })
      expect(yield* awake.get).toEqual({
        state: "error",
        message: "The sleep inhibitor stopped unexpectedly (exit code 3).",
      })
      expect(yield* awake.set(false)).toEqual({ state: "off" })
    }),
  )

  it.live("turns an unexpected inhibitor exit into an error without rearming it", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const awake = yield* KeepAwake.make({
        spawner: yield* AppProcess.Service,
        platform: "darwin",
        pid: process.pid,
        command: child.command,
      })
      expect(yield* awake.set(true)).toEqual({ state: "on" })
      const pid = yield* child.pid(0)
      process.kill(pid, "SIGKILL")
      const status = yield* eventually(
        () => Effect.runPromise(awake.get),
        (value) => value.state !== "on",
      )
      expect(status.state).toBe("error")
      expect(status.message).toContain("The sleep inhibitor stopped unexpectedly")
      expect(child.spawned).toHaveLength(1)
      expect(yield* awake.set(true)).toEqual({ state: "on" })
      expect(child.spawned).toHaveLength(2)
    }),
  )

  it.live("releases the inhibitor when the owning scope closes", () =>
    Effect.gen(function* () {
      const directory = yield* fixture
      const child = recordedChild(directory)
      const spawner = yield* AppProcess.Service
      const scope = yield* Scope.make()
      const awake = yield* KeepAwake.make({
        spawner,
        platform: "darwin",
        pid: process.pid,
        command: child.command,
      }).pipe(Effect.provideService(Scope.Scope, scope))
      expect(yield* awake.set(true)).toEqual({ state: "on" })
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
        const awake = yield* KeepAwake.make({
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
          command: child.command,
        })
        const starting = yield* awake.set(true).pipe(Effect.forkScoped)
        yield* Deferred.await(spawned)
        const pid = yield* child.pid(0)
        expect(pid).toBeGreaterThan(0)
        expect(alive(pid)).toBe(true)
        expect(yield* awake.get).toEqual({ state: "off" })
        yield* Fiber.interrupt(starting)
        expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true)
        expect(
          yield* eventually(
            () => alive(pid),
            (running) => !running,
          ),
        ).toBe(false)
        expect(yield* awake.get).toEqual({ state: "off" })
        expect(yield* awake.set(false)).toEqual({ state: "off" })
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
        const awake = yield* KeepAwake.make({
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
          command: child.command,
        }).pipe(Effect.provideService(Scope.Scope, scope))
        expect(yield* awake.set(true)).toEqual({ state: "on" })
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
        expect(yield* awake.get).toEqual({ state: "off" })
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
      const awake = yield* KeepAwake.make({
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
      expect(yield* awake.get).toEqual({ state: "off" })
      expect(child.spawned).toHaveLength(1)
    }),
  )
})
