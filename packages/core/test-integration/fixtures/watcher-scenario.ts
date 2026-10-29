import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Logger, Option, Queue, Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Watcher } from "@ycoding-ai/core/filesystem/watcher"

type Subscribe = {
  readonly dir: string
  readonly fn: unknown
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}
type Unsubscribe = { readonly dir: string; readonly fn: unknown }
type Control = {
  readonly subscribes: Subscribe[]
  readonly unsubscribes: Unsubscribe[]
  readonly waitFor: (kind: "subscribes" | "unsubscribes", count: number, ms: number) => Promise<boolean>
}

const messages: unknown[] = []
const logger = Logger.layer([
  Logger.make((options) => {
    messages.push(Array.isArray(options.message) ? options.message[0] : options.message)
  }),
])
const count = (message: string) => messages.filter((item) => item === message).length

const controlled: { readonly control: Control } = createRequire(import.meta.url)("./watcher-controlled-binding.cjs")
const control = () => controlled.control
const waitFor = (kind: "subscribes" | "unsubscribes", total: number, ms: number) =>
  Effect.promise(() => control().waitFor(kind, total, ms))

const summary = () => {
  const binding = control()
  return {
    subscribes: binding.subscribes.length,
    unsubscribes: binding.unsubscribes.length,
    unsubscribedSubscribedCallback: binding.unsubscribes.every((call) =>
      binding.subscribes.some((item) => item.dir === call.dir && item.fn === call.fn),
    ),
    started: count("watcher started"),
    stopped: count("watcher stopped"),
    fallback: count("native watcher failed; using recursive fallback"),
  }
}

const open = (input: Watcher.WatchInput, clock?: Clock.Clock) =>
  Effect.gen(function* () {
    const watcher = yield* Watcher.Service
    const scope = yield* Scope.make()
    const ready = yield* Deferred.make<void>()
    const updates = yield* Queue.unbounded<Watcher.Update>()
    const run = watcher
      .subscribe(input, Deferred.succeed(ready, undefined).pipe(Effect.asVoid))
      .pipe(Stream.runForEach((update) => Queue.offer(updates, update)))
    yield* (clock ? run.pipe(Effect.provideService(Clock.Clock, clock)) : run).pipe(
      Effect.forkIn(scope, { startImmediately: true }),
    )
    return { scope, ready, updates }
  })

const tracedClock = Effect.gen(function* () {
  const clock = yield* TestClock.make()
  const sleeps: number[] = []
  const requested = yield* Deferred.make<void>()
  const traced: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Effect.sync(() => sleeps.push(Duration.toMillis(duration))).pipe(
        Effect.andThen(Deferred.succeed(requested, undefined)),
        Effect.andThen(clock.sleep(duration)),
      ),
  }
  return { clock, traced, sleeps, requested }
})

const delivered = (directory: string, updates: Queue.Queue<Watcher.Update>) =>
  Effect.gen(function* () {
    const probe = path.join(directory, "probe.txt")
    const take: Effect.Effect<Watcher.Update> = Queue.take(updates).pipe(
      Effect.flatMap((update) => (update.path === probe ? Effect.succeed(update) : take)),
    )
    for (let attempt = 0; attempt < 20; attempt++) {
      yield* Effect.promise(() => writeFile(probe, `probe-${attempt}`))
      if (Option.isSome(yield* take.pipe(Effect.timeoutOption("250 millis")))) return true
    }
    return false
  })

const scenarios: Record<string, (directory: string) => Effect.Effect<unknown, unknown, Watcher.Service | Scope.Scope>> = {
  "close-during-pending": (directory) =>
    Effect.gen(function* () {
      const watch = yield* open({ path: directory, type: "directory" })
      yield* waitFor("subscribes", 1, 5_000)
      const closing = yield* Scope.close(watch.scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      control().subscribes[0]?.resolve()
      yield* Fiber.join(closing)
      yield* waitFor("unsubscribes", 1, 2_000)
      return summary()
    }),
  "shared-key": (directory) =>
    Effect.gen(function* () {
      const first = yield* open({ path: directory, type: "directory", ignore: ["b", "a", "a"] })
      yield* waitFor("subscribes", 1, 5_000)
      control().subscribes[0]?.resolve()
      yield* Deferred.await(first.ready)
      const second = yield* open({ path: path.join(directory, "nested", ".."), type: "directory", ignore: ["a", "b"] })
      yield* Deferred.await(second.ready)
      const subscribesWhileShared = control().subscribes.length
      yield* Scope.close(first.scope, Exit.void)
      const unsubscribesAfterFirstClose = control().unsubscribes.length
      yield* Scope.close(second.scope, Exit.void)
      return { ...summary(), subscribesWhileShared, unsubscribesAfterFirstClose }
    }),
  "native-rejection": (directory) =>
    Effect.gen(function* () {
      const watch = yield* open({ path: directory, type: "directory" })
      yield* waitFor("subscribes", 1, 5_000)
      control().subscribes[0]?.reject(new Error("synthetic native failure"))
      yield* Deferred.await(watch.ready)
      const fallbackDelivered = yield* delivered(directory, watch.updates)
      yield* Scope.close(watch.scope, Exit.void)
      return { ...summary(), fallbackDelivered }
    }),
  "native-timeout": (directory) =>
    Effect.gen(function* () {
      const time = yield* tracedClock
      const watch = yield* open({ path: directory, type: "directory" }, time.traced)
      yield* waitFor("subscribes", 1, 5_000)
      yield* Deferred.await(time.requested)
      yield* time.clock.adjust(9_999)
      const readyBeforeDeadline = yield* Deferred.isDone(watch.ready)
      yield* time.clock.adjust(1)
      yield* Deferred.await(watch.ready)
      const fallbackDelivered = yield* delivered(directory, watch.updates)
      control().subscribes[0]?.resolve()
      yield* waitFor("unsubscribes", 1, 2_000)
      yield* Scope.close(watch.scope, Exit.void)
      return { ...summary(), sleeps: time.sleeps, readyBeforeDeadline, fallbackDelivered }
    }),
  "cancel-then-timeout": (directory) =>
    Effect.gen(function* () {
      const time = yield* tracedClock
      const watch = yield* open({ path: directory, type: "directory" }, time.traced)
      yield* waitFor("subscribes", 1, 5_000)
      yield* Deferred.await(time.requested)
      const closing = yield* Scope.close(watch.scope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* time.clock.adjust(10_000)
      yield* Fiber.join(closing)
      control().subscribes[0]?.resolve()
      yield* waitFor("unsubscribes", 1, 2_000)
      return { ...summary(), sleeps: time.sleeps }
    }),
}

const scenario = scenarios[process.argv[2] ?? ""]
if (!scenario) throw new Error(`unknown watcher scenario: ${process.argv[2]}`)
const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-watcher-scenario-"))
try {
  const result = await Effect.runPromise(
    scenario(directory).pipe(Effect.scoped, Effect.provide(Watcher.layer()), Effect.provide(logger)),
  )
  console.log(JSON.stringify(result))
} finally {
  await rm(directory, { recursive: true, force: true })
}
