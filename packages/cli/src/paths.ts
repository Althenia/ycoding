export * as FrontendPaths from "./paths"

import os from "node:os"
import path from "node:path"
import { Context, Layer } from "effect"
import { InstallationChannel } from "./version"

export function resolvePaths(environment: NodeJS.ProcessEnv = process.env, channel = InstallationChannel) {
  const namespace = channel === "beta" ? "ycoding-beta" : "ycoding"
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir()
  const data = path.join(environment.XDG_DATA_HOME || path.join(home, ".local/share"), namespace)
  const cache = path.join(environment.XDG_CACHE_HOME || path.join(home, ".cache"), namespace)
  return {
    home: environment.YCODING_TEST_HOME ?? home,
    data,
    cache,
    config:
      environment.YCODING_CONFIG_DIR || path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), namespace),
    state: path.join(environment.XDG_STATE_HOME || path.join(home, ".local/state"), namespace),
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
    tmp: path.join(environment.TMPDIR ?? environment.TEMP ?? os.tmpdir(), namespace),
  }
}

export const Path = resolvePaths()
export class Service extends Context.Service<Service, ReturnType<typeof resolvePaths>>()("@ycoding/cli/Paths") {}
export const layerWith = (input: Partial<ReturnType<typeof resolvePaths>> = {}) =>
  Layer.succeed(Service, { ...Path, ...input })
export const layer = layerWith()
