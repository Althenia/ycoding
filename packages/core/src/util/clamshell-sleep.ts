export * as ClamshellSleep from "./clamshell-sleep"

import { setClamshellSleepDisabled } from "#clamshell-sleep-ffi"
import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export type LidState = "on" | "off" | "unsupported" | "error"

export interface Interface {
  readonly set: (lidAwake: boolean) => LidState
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/ClamshellSleep") {}

export const make = (platform: NodeJS.Platform): Interface => ({
  set: (lidAwake) => {
    if (platform !== "darwin") return "unsupported"
    try {
      const result = setClamshellSleepDisabled(lidAwake)
      if ("unsupported" in result) return "unsupported"
      if (!result.ok) return "error"
      return lidAwake ? "on" : "off"
    } catch {
      return "error"
    }
  },
})

export const layer = Layer.succeed(Service, make(process.platform))
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
