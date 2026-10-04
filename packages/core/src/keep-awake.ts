export * as KeepAwake from "./keep-awake"

import { KeepAwake } from "@ycoding-ai/schema/keep-awake"
import { Context, Duration, Effect, Exit, Layer, Option, Ref, Scope, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess } from "./process"

export const Status = KeepAwake.Status
export type Status = KeepAwake.Status

export interface Interface {
  readonly get: Effect.Effect<Status>
  readonly set: (enabled: boolean) => Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/KeepAwake") {}

export interface Options {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly platform: NodeJS.Platform
  readonly pid: number
  readonly command?: () => ChildProcess.Command
}

const startGrace = Duration.millis(300)
const unsupported: Status = { state: "unsupported", message: "Keep machine awake is available on macOS only." }

export const macOSInhibitor = (pid: number) =>
  ChildProcess.make("/usr/bin/caffeinate", ["-i", "-w", String(pid)], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })

export const make = Effect.fn("KeepAwake.make")(function* (options: Options) {
  const parent = yield* Scope.Scope
  const gate = Semaphore.makeUnsafe(1)
  const status = yield* Ref.make<Status>(options.platform === "darwin" ? { state: "off" } : unsupported)
  const active = yield* Ref.make(Option.none<Scope.Closeable>())

  const release = Ref.getAndSet(active, Option.none()).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (scope) => Scope.close(scope, Exit.void) })),
  )
  const settle = (next: Status) => Ref.set(status, next).pipe(Effect.as(next))
  const stop = release.pipe(
    Effect.andThen(settle(options.platform === "darwin" ? { state: "off" } : unsupported)),
    Effect.uninterruptible,
  )

  const start = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.gen(function* () {
        const spawned = yield* restore(
          Effect.exit(
            options.spawner
              .spawn((options.command ?? (() => macOSInhibitor(options.pid)))())
              .pipe(Effect.provideService(Scope.Scope, scope)),
          ),
        )
        if (Exit.isFailure(spawned)) {
          yield* Scope.close(scope, Exit.void)
          return yield* settle({ state: "error", message: "The sleep inhibitor could not be started." })
        }
        const handle = spawned.value
        const stopped = handle.exitCode.pipe(
          Effect.map((code) => `The sleep inhibitor stopped unexpectedly (exit code ${code}).`),
          Effect.catch(() => Effect.succeed("The sleep inhibitor stopped unexpectedly (terminated by a signal).")),
        )
        const early = yield* restore(
          Effect.raceFirst(
            stopped.pipe(Effect.map(Option.some)),
            Effect.sleep(startGrace).pipe(Effect.as(Option.none<string>())),
          ),
        )
        if (Option.isSome(early)) {
          yield* Scope.close(scope, Exit.void)
          return yield* settle({ state: "error", message: early.value })
        }
        yield* Ref.set(active, Option.some(scope))
        yield* stopped.pipe(
          Effect.flatMap((message) =>
            gate.withPermit(
              Effect.gen(function* () {
                const current = yield* Ref.get(active)
                if (Option.isNone(current) || current.value !== scope) return
                yield* Ref.set(active, Option.none())
                yield* Scope.close(scope, Exit.void)
                yield* settle({ state: "error", message })
              }).pipe(Effect.uninterruptible),
            ),
          ),
          Effect.forkIn(parent),
        )
        return yield* settle({ state: "on" })
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)))
    }),
  )

  yield* Effect.addFinalizer(() => gate.withPermit(stop).pipe(Effect.uninterruptible))

  return Service.of({
    get: Ref.get(status),
    set: (enabled) =>
      gate.withPermit(
        Effect.gen(function* () {
          if (options.platform !== "darwin") return unsupported
          if (!enabled) return yield* stop
          if (Option.isSome(yield* Ref.get(active))) return yield* Ref.get(status)
          return yield* start
        }),
      ),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* AppProcess.Service
    return yield* make({ spawner, platform: process.platform, pid: process.pid })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
