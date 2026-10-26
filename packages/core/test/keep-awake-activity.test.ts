import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess } from "effect/unstable/process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { LayerNode } from "../src/effect/layer-node"
import { KeepAwake } from "../src/keep-awake"
import { AppProcess } from "../src/process"
import { ProcessLock } from "../src/util/process-lock"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(AppProcess.node))
const fixture = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "ycoding-activity-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)

it.live("the macOS inhibitor holds display and idle sleep for the backend lifetime", () => Effect.sync(() => {
  expect(KeepAwake.macOSInhibitor(4242)).toMatchObject({ command: "/usr/bin/caffeinate", args: ["-d", "-i", "-w", "4242"] })
}))

it.effect("a non-lid-owner renews activity while sleep-held and stops at the final release", () => Effect.gen(function* () {
  const directory = yield* fixture
  const lidFile = path.join(directory, "lid.json")
  const owner = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
  yield* ProcessLock.acquire(lidFile).pipe(Effect.provideService(Scope.Scope, owner))
  const calls: boolean[] = []
  const spawned = yield* Deferred.make<void>()
  const spawner = yield* AppProcess.Service
  const awake = yield* KeepAwake.make({
    spawner: { ...spawner, spawn: (command) => spawner.spawn(command).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))) },
    platform: "darwin", pid: process.pid, lidFile,
    command: () => ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
    clamshell: { set: () => { throw new Error("Not the lid owner") } },
    systemSleep: { permitted: Effect.die("Not the system owner"), set: () => Effect.die("Not the system owner") },
    userActivity: { set: (on) => { calls.push(on); return on ? "on" : "off" } },
  })
  const starting = yield* awake.hold("family").pipe(Effect.forkScoped)
  yield* Deferred.await(spawned)
  yield* TestClock.adjust("300 millis")
  expect(yield* Fiber.join(starting)).toMatchObject({ state: "on", display: "on", activity: "on", lid: "held" })
  expect(calls).toEqual([true])
  yield* TestClock.adjust("1 second")
  expect(calls).toEqual([true, true])
  expect(yield* awake.set(false)).toMatchObject({ state: "on", display: "on", activity: "on", manual: false, sleepHold: true })
  expect(yield* awake.release("family")).toMatchObject({ state: "off", display: "off", activity: "off" })
  expect(calls).toEqual([true, true, false])
  yield* TestClock.adjust("2 seconds")
  expect(calls).toEqual([true, true, false])
}))

it.effect("activity renewal failure remains visible while the display inhibitor stays on", () => Effect.gen(function* () {
  const directory = yield* fixture
  const spawned = yield* Deferred.make<void>()
  const spawner = yield* AppProcess.Service
  let fail = false
  const awake = yield* KeepAwake.make({
    spawner: { ...spawner, spawn: (command) => spawner.spawn(command).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))) },
    platform: "darwin", pid: process.pid, lidFile: path.join(directory, "lid.json"),
    command: () => ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
    clamshell: { set: (on) => on ? "on" : "off" },
    systemSleep: { permitted: Effect.succeed(false), set: () => Effect.succeed("off") },
    userActivity: { set: (on) => !on ? "off" : fail ? "error" : "on" },
  })
  const starting = yield* awake.set(true).pipe(Effect.forkScoped)
  yield* Deferred.await(spawned)
  yield* TestClock.adjust("300 millis")
  yield* Fiber.join(starting)
  fail = true
  yield* TestClock.adjust("1 second")
  expect(yield* awake.get).toMatchObject({ state: "on", display: "on", activity: "error" })
  expect((yield* awake.get).message).toMatch(/activity.*failed/i)
  yield* awake.set(false)
}))

for (const result of ["error", "unsupported"] as const) it.live(`initial activity ${result} is explicit and scoped cleanup still runs`, () => Effect.gen(function* () {
  const directory = yield* fixture
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const calls: boolean[] = []
  const awake = yield* KeepAwake.make({
    spawner: yield* AppProcess.Service, platform: "darwin", pid: process.pid, lidFile: path.join(directory, "lid.json"),
    command: () => ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
    clamshell: { set: (on) => on ? "on" : "off" },
    systemSleep: { permitted: Effect.succeed(false), set: () => Effect.succeed("off") },
    userActivity: { set: (on) => { calls.push(on); return on ? result : "off" } },
  }).pipe(Effect.provideService(Scope.Scope, scope))
  expect(yield* awake.set(true)).toMatchObject({ state: "on", display: "on", activity: result })
  yield* Scope.close(scope, Exit.void)
  expect(calls.at(-1)).toBe(false)
  expect(yield* awake.get).toMatchObject({ display: "off", activity: "off" })
}))

it.effect("cancelled inhibitor startup cannot acquire activity after cancellation", () => Effect.gen(function* () {
  const directory = yield* fixture
  const spawned = yield* Deferred.make<void>()
  const calls: boolean[] = []
  const spawner = yield* AppProcess.Service
  const awake = yield* KeepAwake.make({
    spawner: { ...spawner, spawn: (command) => spawner.spawn(command).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))) },
    platform: "darwin", pid: process.pid, lidFile: path.join(directory, "lid.json"),
    command: () => ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
    clamshell: { set: (on) => on ? "on" : "off" },
    systemSleep: { permitted: Effect.succeed(false), set: () => Effect.succeed("off") },
    userActivity: { set: (on) => { calls.push(on); return on ? "on" : "off" } },
  })
  const starting = yield* awake.set(true).pipe(Effect.forkScoped)
  yield* Deferred.await(spawned)
  yield* Fiber.interrupt(starting)
  yield* TestClock.adjust("2 seconds")
  expect(calls).not.toContain(true)
  expect(yield* awake.get).toMatchObject({ state: "off", display: "off", activity: "off" })
}))

it.live("inhibitor death releases the owned activity assertion without rearming", () => Effect.gen(function* () {
  const directory = yield* fixture
  const terminate = yield* Deferred.make<() => Effect.Effect<void, unknown>>()
  const spawner = yield* AppProcess.Service
  const calls: boolean[] = []
  const awake = yield* KeepAwake.make({
    spawner: { ...spawner, spawn: (command) => spawner.spawn(command).pipe(Effect.tap((handle) => Deferred.succeed(terminate, () => handle.kill()))) },
    platform: "darwin", pid: process.pid, lidFile: path.join(directory, "lid.json"),
    command: () => ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
    clamshell: { set: (on) => on ? "on" : "off" },
    systemSleep: { permitted: Effect.succeed(false), set: () => Effect.succeed("off") },
    userActivity: { set: (on) => { calls.push(on); return on ? "on" : "off" } },
  })
  yield* awake.set(true)
  yield* (yield* Deferred.await(terminate))()
  const settled = yield* awake.get.pipe(
    Effect.flatMap((status) => status.state === "error" ? Effect.succeed(status) : Effect.yieldNow.pipe(Effect.andThen(awake.get))),
    Effect.repeat({ until: (status) => status.state === "error" }),
    Effect.timeout("5 seconds"),
  )
  expect(settled).toMatchObject({ state: "error", display: "error", activity: "off" })
  expect(calls.at(-1)).toBe(false)
}))
