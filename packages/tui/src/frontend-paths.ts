export * as FrontendPaths from "./frontend-paths"

import path from "node:path"
import os from "node:os"
import { Context, Layer } from "effect"

export function resolve(input: { home: string; env: NodeJS.ProcessEnv }) {
  return {
    home: input.home,
    config: path.join(input.env.XDG_CONFIG_HOME || path.join(input.home, ".config"), "ycoding"),
    state: path.join(input.env.XDG_STATE_HOME || path.join(input.home, ".local", "state"), "ycoding"),
    cache: path.join(input.env.XDG_CACHE_HOME || path.join(input.home, ".cache"), "ycoding"),
  }
}

export const Path = resolve({ home: process.env.YCODING_TEST_HOME ?? os.homedir(), env: process.env })
export type Interface = ReturnType<typeof resolve>
export class Service extends Context.Service<Service, Interface>()("@ycoding/TuiFrontendPaths") {}
export function make(input: Partial<Interface> = {}) {
  return { ...Path, ...input }
}
export const layer = Layer.succeed(Service, make())
export const layerWith = (input: Partial<Interface>) => Layer.succeed(Service, make(input))
