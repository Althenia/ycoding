export * as ServerProcess from "./server-process"

import { spawn } from "node:child_process"
import { Effect } from "effect"
import { runtimeEnvironment, runtimeExecutable } from "./runtime-executable"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly meeting?: boolean
}

export const run = Effect.fnUntraced(function* (options: Options) {
  const executable = yield* Effect.tryPromise(runtimeExecutable)
  const args = [
    ...(options.mode === "default" ? [] : [options.mode === "service" ? "--service" : "--stdio"]),
    ...(options.hostname === undefined ? [] : ["--hostname", options.hostname]),
    ...(options.port === undefined ? [] : ["--port", String(options.port)]),
    ...(options.meeting ? ["--meeting"] : []),
  ]
  return yield* Effect.callback<void, Error>((resume) => {
    const child = spawn(executable, args, { stdio: "inherit", env: runtimeEnvironment() })
    const interrupt = () => child.kill("SIGINT")
    const terminate = () => child.kill("SIGTERM")
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    child.once("error", (error) => resume(Effect.fail(error)))
    child.once("exit", (code, signal) => {
      if (code === 0) return resume(Effect.void)
      process.exitCode = code ?? 1
      resume(Effect.fail(new Error(`Rust runtime exited ${signal ? `on ${signal}` : `with code ${code}`}`)))
    })
    return Effect.promise(async () => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000)
        child.once("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
        child.kill("SIGTERM")
      })
    })
  })
})
