export * as LocationMutationPath from "./location-mutation-path"

import { realpath } from "node:fs"
import { Context, Effect, Layer, PlatformError } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"

/** Strict canonical paths for Git checkout trust comparisons, not general filesystem resolution. */
export class Service extends Context.Service<Service, {
  readonly realPath: (path: string) => Effect.Effect<string, FSUtil.Error>
}>()("@ycoding/LocationMutationPath") {}

const nativeRealPath = (path: string) => Effect.callback<string, PlatformError.PlatformError>((resume) => {
  realpath.native(path, (error, canonical) => {
    if (!error) return resume(Effect.succeed(canonical))
    resume(Effect.fail(PlatformError.systemError({
      _tag: error.code === "ENOENT" ? "NotFound"
        : error.code === "EACCES" || error.code === "EPERM" ? "PermissionDenied"
        : error.code === "ENOTDIR" || error.code === "ELOOP" ? "BadResource" : "Unknown",
      module: "FileSystem",
      method: "realPath",
      pathOrDescriptor: path,
      syscall: error.syscall,
      cause: error,
    })))
  })
})

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return Service.of({ realPath: process.platform === "win32" ? nativeRealPath : fs.realPath })
  })),
  deps: [FSUtil.node],
})
