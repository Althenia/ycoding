import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Deferred, Effect, Option } from "effect"
import path from "node:path"
import { DesktopHostCommand } from "../desktop-host"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(DesktopHostCommand, (input) => Effect.scoped(Effect.gen(function* () {
  if (!path.isAbsolute(input.backend)) return yield* Effect.fail(new Error("Desktop backend must be a bundled absolute executable"))
  const server = Option.getOrUndefined(input.server)
  if (server !== undefined) {
    const url = yield* Effect.try(() => new URL(server))
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      return yield* Effect.fail(new Error("Desktop shared endpoint must be a credential-free HTTP(S) origin"))
  }
  const eof = yield* Deferred.make<void>()
  const ended = () => Deferred.doneUnsafe(eof, Effect.void)
  yield* Effect.acquireRelease(Effect.sync(() => {
    process.stdin.once("end", ended)
    process.stdin.once("error", ended)
    process.stdin.resume()
    if (process.stdin.readableEnded) ended()
  }), () => Effect.sync(() => {
    process.stdin.off("end", ended)
    process.stdin.off("error", ended)
  }))
  yield* Effect.raceFirst(Deferred.await(eof), Effect.gen(function* () {
    const connection = yield* ServerConnection.resolve({
      server,
      standalone: input.mode === "own",
      privateServer: { command: [input.backend, "serve"] },
      managed: "discover",
      diagnostics: "sanitized",
    })
    yield* Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify({ type: "desktop.endpoint", version: InstallationVersion, endpoint: connection.endpoint }) + "\n",
        (error) => error ? reject(error) : resolve())
    }))
    const exited = "exited" in connection ? connection.exited : undefined
    if (!exited) return yield* Effect.never
    yield* exited
    return yield* Effect.fail(new Error("Desktop private backend exited"))
  }))
})))
