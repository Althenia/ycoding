export * as UserActivity from "./user-activity"

import { openUserActivity } from "#user-activity-ffi"
import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export type State = "off" | "on" | "unsupported" | "error"

export interface Native {
  readonly declare: (id: number) => { readonly code: number; readonly id: number }
  readonly release: (id: number) => number
  readonly close: () => void
}

export interface Interface {
  readonly set: (active: boolean) => State
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/UserActivity") {}

export function make(platform: NodeJS.Platform, open: () => Native | undefined = openUserActivity): Interface {
  let native: Native | undefined
  let id = 0
  return {
    set: (active) => {
      if (platform !== "darwin") return "unsupported"
      try {
        if (active) {
          native ??= open()
          if (!native) return "unsupported"
          const result = native.declare(id)
          if (result.code !== 0 || result.id === 0) return "error"
          id = result.id
          return "on"
        }
        if (!native) return "off"
        if (id !== 0 && native.release(id) !== 0) return "error"
        id = 0
        native.close()
        native = undefined
        return "off"
      } catch {
        return "error"
      }
    },
  }
}

export const layer = Layer.sync(Service, () => make(process.platform))
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
