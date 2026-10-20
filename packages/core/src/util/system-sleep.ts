export * as SystemSleep from "./system-sleep"

import { Context, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeGlobalNode } from "../effect/app-node"
import { AppProcess } from "../process"

export type SystemState = "on" | "off" | "error"

export interface Interface {
  readonly permitted: Effect.Effect<boolean>
  readonly set: (disabled: boolean) => Effect.Effect<SystemState>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SystemSleep") {}

const sudo = "/usr/bin/sudo"
const pmset = "/usr/bin/pmset"
const timeout = "10 seconds"

export const make = (platform: NodeJS.Platform, spawner: AppProcess.Interface): Interface => {
  const exitCode = (args: string[]) =>
    spawner
      .run(ChildProcess.make(sudo, args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }), { timeout })
      .pipe(
        Effect.map((result) => result.exitCode),
        Effect.catch(() => Effect.succeed(undefined)),
      )
  return {
    permitted:
      platform === "darwin"
        ? exitCode(["-n", "-l", pmset, "-a", "disablesleep", "1"]).pipe(Effect.map((code) => code === 0))
        : Effect.succeed(false),
    set: (disabled) =>
      platform === "darwin"
        ? exitCode(["-n", pmset, "-a", "disablesleep", disabled ? "1" : "0"]).pipe(
            Effect.map((code) => (code !== 0 ? "error" : disabled ? "on" : "off")),
          )
        : Effect.succeed("error"),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* AppProcess.Service
    return Service.of(make(process.platform, spawner))
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AppProcess.node] })
