import { Effect, Option } from "effect"
import { writeFile } from "node:fs/promises"
import { ServerProcess } from "../../server-process"

export interface Input {
  readonly service: boolean
  readonly stdio: boolean
  readonly hostname: Option.Option<string>
  readonly port: Option.Option<number>
}

export const runServe = Effect.fnUntraced(function* (input: Input) {
  if (input.service && input.stdio) return yield* Effect.fail(new Error("--service and --stdio cannot be combined"))
  return yield* ServerProcess.run({
    mode: input.service ? "service" : input.stdio ? "stdio" : "default",
    hostname: Option.getOrUndefined(input.hostname),
    port: Option.getOrUndefined(input.port),
  }).pipe(Effect.tapError((error) => (input.service ? recordStartupError(error) : Effect.void)))
})

export const recordStartupError = Effect.fnUntraced(function* (error: unknown) {
  const file = process.env.YCODING_SERVICE_STARTUP_ERROR_FILE
  if (!file) return
  const message = error instanceof Error ? error.message : String(error)
  yield* Effect.tryPromise(() => writeFile(file, message, { mode: 0o600 })).pipe(Effect.ignore)
})
