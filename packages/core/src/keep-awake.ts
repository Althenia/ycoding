export * as KeepAwake from "./keep-awake"

import { KeepAwake } from "@ycoding-ai/schema/keep-awake"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Scope, Semaphore } from "effect"
import fs from "node:fs"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess } from "./process"
import { Global } from "./global"
import { ClamshellSleep } from "./util/clamshell-sleep"
import { SystemSleep } from "./util/system-sleep"

export const Status = KeepAwake.Status
export type Status = KeepAwake.Status

export interface Interface {
  readonly get: Effect.Effect<Status>
  readonly set: (enabled: boolean) => Effect.Effect<Status>
  readonly hold: (id: string) => Effect.Effect<Status>
  readonly release: (id: string) => Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/KeepAwake") {}

export interface Options {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly platform: NodeJS.Platform
  readonly pid: number
  readonly command?: () => ChildProcess.Command
  readonly clamshell: ClamshellSleep.Interface
  readonly systemSleep: SystemSleep.Interface
  readonly lidFile?: string
  readonly reapplyInterval?: Duration.Input
}

const startGrace = Duration.millis(300)
const unsupported: Status = { state: "unsupported", message: "Keep machine awake is available on macOS only." }
const lidErrorMessage = "Lid-closed keep-awake could not be armed; closing the lid may sleep this machine."
const systemSetupMessage = "System sleep hold needs one-time setup: run `ycoding keep-awake setup`."
const systemApplyMessage = "System sleep could not be disabled; a closed lid may still sleep during power changes."
const systemRestoreMessage = "System sleep could not be restored; run `sudo pmset -a disablesleep 0`."

export const macOSInhibitor = (pid: number) =>
  ChildProcess.make("/usr/bin/caffeinate", ["-i", "-w", String(pid)], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })

export const make = Effect.fn("KeepAwake.make")(function* (options: Options) {
  const parent = yield* Scope.Scope
  const gate = Semaphore.makeUnsafe(1)
  const darwin = options.platform === "darwin"
  const clamshell = options.clamshell
  const lidFile = options.lidFile ?? path.join(Global.Path.state, "keep-awake-lid.json")
  const lidOwner = yield* Ref.make(Option.none<Scope.Closeable>())
  const systemSleep = options.systemSleep
  const decodeRecord = Schema.decodeUnknownOption(
    Schema.UnknownFromJsonString.pipe(
      Schema.decodeTo(Schema.Struct({ armed: Schema.Boolean, system: Schema.optionalKey(Schema.Boolean) })),
    ),
  )
  const readRecord = Effect.try(() => fs.readFileSync(lidFile, "utf8")).pipe(
    Effect.map((text) => {
      const record = Option.getOrUndefined(decodeRecord(text))
      return { armed: record?.armed === true, system: record?.system === true }
    }),
    Effect.catch(() => Effect.succeed({ armed: false, system: false })),
  )
  const readArmed = readRecord.pipe(Effect.map((record) => record.armed))
  const hasRecord = readRecord.pipe(Effect.map((record) => record.armed || record.system))
  const status = yield* Ref.make<Status>(darwin ? { state: "off" } : unsupported)
  const active = yield* Ref.make(Option.none<Scope.Closeable>())
  const manual = yield* Ref.make(false)
  const holds = yield* Ref.make<ReadonlySet<string>>(new Set())
  const lid = yield* Ref.make<ClamshellSleep.LidState | "held">(darwin ? "off" : "unsupported")
  const reapplyFiber = yield* Ref.make(Option.none<Fiber.Fiber<void>>())
  const systemHeld = yield* Ref.make(false)
  const systemFault = yield* Ref.make<"none" | "setup" | "apply" | "restore">("none")
  const writeRecord = (armed: boolean) =>
    Ref.get(systemHeld).pipe(
      Effect.flatMap((system) =>
        Effect.try(() => fs.writeFileSync(lidFile, JSON.stringify(system ? { armed, system } : { armed }))),
      ),
      Effect.exit,
    )

  const combined = Effect.gen(function* () {
    const base = yield* Ref.get(status)
    const lidState = yield* Ref.get(lid)
    const sleepHold = (yield* Ref.get(holds)).size > 0
    const fault = yield* Ref.get(systemFault)
    const system: NonNullable<Status["system"]> = !darwin
      ? "unsupported"
      : lidState === "held"
        ? "held"
        : fault === "setup"
          ? "setup"
          : fault !== "none"
            ? "error"
            : (yield* Ref.get(systemHeld))
              ? "on"
              : "off"
    const message =
      base.message ??
      (lidState === "held" ? "Lid control is held by another YCoding process." : undefined) ??
      (lidState === "error"
        ? base.state === "on"
          ? lidErrorMessage
          : "Normal lid sleep could not be restored; check this machine's power state."
        : undefined) ??
      (system === "setup" ? systemSetupMessage : undefined) ??
      (system === "error" ? (base.state === "on" ? systemApplyMessage : systemRestoreMessage) : undefined)
    return {
      ...base,
      ...(sleepHold ? { manual: yield* Ref.get(manual) } : {}),
      lid: lidState,
      system,
      sleepHold,
      ...(message === undefined ? {} : { message }),
    } satisfies Status
  })

  const desired = Effect.gen(function* () {
    return (yield* Ref.get(manual)) || (yield* Ref.get(holds)).size > 0
  })

  const releaseLidOwner = Ref.getAndSet(lidOwner, Option.none()).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (scope) => Scope.close(scope, Exit.void) })),
  )
  const restoreSystem = Effect.gen(function* () {
    const record = yield* readRecord
    if (!record.system) return
    if ((yield* systemSleep.set(false)) !== "off") {
      yield* Ref.set(systemHeld, true)
      yield* Ref.set(systemFault, "restore")
      return
    }
    yield* Ref.set(systemHeld, false)
    if (Exit.isSuccess(yield* writeRecord(record.armed))) return
    yield* Ref.set(systemHeld, true)
    yield* Ref.set(systemFault, "restore")
  })

  const applySystem = Effect.gen(function* () {
    if (yield* Ref.get(systemHeld)) {
      yield* Ref.set(systemFault, "none")
      return
    }
    if ((yield* Ref.get(systemFault)) !== "none") return
    if (!(yield* systemSleep.permitted)) {
      yield* Ref.set(systemFault, "setup")
      return
    }
    yield* Ref.set(systemHeld, true)
    const recorded = yield* writeRecord(true)
    const applied = Exit.isSuccess(recorded) && (yield* systemSleep.set(true)) === "on"
    if (applied) return
    yield* Ref.set(systemHeld, false)
    yield* Ref.set(systemFault, "apply")
    if (Exit.isSuccess(recorded)) yield* writeRecord(true)
  })

  const applyLid = (on: boolean, recover = false) => Effect.gen(function* () {
    if (!darwin) return yield* Ref.set(lid, "unsupported")
    if (Option.isNone(yield* Ref.get(lidOwner))) {
      if (!on && !recover && !(yield* hasRecord)) return yield* Ref.set(lid, "off")
      const owner = yield* Scope.make()
      const acquired = yield* Effect.tryPromise(() => import("./util/process-lock")).pipe(
        Effect.flatMap(({ ProcessLock }) => ProcessLock.acquire(lidFile).pipe(
          Effect.provideService(Scope.Scope, owner), Effect.as(true),
          Effect.catchTag("ProcessLockHeldError", () => Effect.succeed(false)),
        )),
        Effect.exit,
      )
      if (Exit.isFailure(acquired) || !acquired.value) {
        yield* Scope.close(owner, Exit.void)
        return yield* Ref.set(lid, Exit.isFailure(acquired) ? "unsupported" : "held")
      }
      yield* Ref.set(lidOwner, Option.some(owner))
      if (!on && !(yield* hasRecord)) {
        yield* releaseLidOwner
        return yield* Ref.set(lid, "off")
      }
    }
    if (!on) yield* restoreSystem
    const previouslyArmed = yield* readArmed
    const written = on && !previouslyArmed ? yield* writeRecord(true) : Exit.void
    if (Exit.isFailure(written)) {
      yield* releaseLidOwner
      return yield* Ref.set(lid, "error")
    }
    const state = yield* Effect.try(() => clamshell.set(on)).pipe(Effect.catch(() => Effect.succeed("error" as const)))
    yield* Ref.set(lid, state)
    if (on && state !== "unsupported") yield* applySystem
    if (!on || state === "unsupported") {
      if (state === "off" || (on && state === "unsupported" && !previouslyArmed)) yield* writeRecord(false).pipe(
        Effect.flatMap((exit) => (Exit.isFailure(exit) ? Ref.set(lid, "error") : Effect.void)),
      )
      if (!(yield* Ref.get(systemHeld))) yield* releaseLidOwner
    }
  }).pipe(Effect.uninterruptible)

  const stopReapply = Ref.getAndSet(reapplyFiber, Option.none()).pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.void, onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid) }),
    ),
  )

  const startReapply = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(reapplyFiber))) return
    const interval = Duration.fromInputUnsafe(options.reapplyInterval ?? Duration.seconds(1))
    const loop = Effect.sleep(interval).pipe(
      Effect.andThen(
        desired.pipe(Effect.flatMap((on) => (on ? applyLid(true).pipe(Effect.uninterruptible) : Effect.void))),
      ),
      Effect.forever,
    )
    const fiber = yield* loop.pipe(Effect.forkIn(parent))
    yield* Ref.set(reapplyFiber, Option.some(fiber))
  })

  const disarm = Ref.set(systemFault, "none").pipe(Effect.andThen(applyLid(false)))
  const release = Ref.getAndSet(active, Option.none()).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (scope) => Scope.close(scope, Exit.void) })),
  )
  const settle = (next: Status) => Ref.set(status, next).pipe(Effect.andThen(combined))
  const stop = stopReapply.pipe(
    Effect.andThen(release),
    Effect.andThen(disarm),
    Effect.andThen(settle(darwin ? { state: "off" } : unsupported)),
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
                yield* stopReapply
                yield* disarm
                yield* settle({ state: "error", message })
              }).pipe(Effect.uninterruptible),
            ),
          ),
          Effect.forkIn(parent),
        )
        yield* applyLid(true)
        yield* startReapply
        return yield* settle({ state: "on" })
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)))
    }),
  )

  const reconcile = Effect.gen(function* () {
    if (!darwin) return yield* combined
    if (!(yield* desired)) return yield* stop
    if (Option.isSome(yield* Ref.get(active))) {
      if ((yield* Ref.get(lid)) !== "on") yield* applyLid(true)
      yield* startReapply
      return yield* combined
    }
    return yield* start
  })

  if (darwin && (yield* hasRecord)) yield* applyLid(false, true)

  yield* Effect.addFinalizer(() => gate.withPermit(stop).pipe(Effect.uninterruptible))

  return Service.of({
    get: combined,
    set: (enabled) => gate.withPermit(Ref.set(manual, enabled).pipe(Effect.andThen(reconcile))),
    hold: (id) =>
      gate.withPermit(Ref.update(holds, (current) => new Set([...current, id])).pipe(Effect.andThen(reconcile))),
    release: (id) =>
      gate.withPermit(
        Ref.update(holds, (current) => new Set([...current].filter((item) => item !== id))).pipe(
          Effect.andThen(reconcile),
        ),
      ),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* AppProcess.Service
    const clamshell = yield* ClamshellSleep.Service
    const systemSleep = yield* SystemSleep.Service
    const global = yield* Global.Service
    return yield* make({ spawner, clamshell, systemSleep, lidFile: path.join(global.state, "keep-awake-lid.json"), platform: process.platform, pid: process.pid })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node, ClamshellSleep.node, SystemSleep.node, Global.node] })
