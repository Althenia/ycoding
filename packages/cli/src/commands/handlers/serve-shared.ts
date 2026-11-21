import { Effect, Option } from "effect"
import { writeFile } from "node:fs/promises"
import { NativeProcess } from "../../native-process"
import { readFile } from "node:fs/promises"

export interface Input {
  readonly service: boolean
  readonly stdio: boolean
  readonly hostname: Option.Option<string>
  readonly port: Option.Option<number>
  readonly meeting?: boolean
}

export const runServe = Effect.fnUntraced(function* (input: Input) {
  if (input.service && input.stdio) return yield* Effect.fail(new Error("--service and --stdio cannot be combined"))
  return yield* NativeProcess.run({
    mode: input.service ? "service" : input.stdio ? "stdio" : "default",
    hostname: Option.getOrUndefined(input.hostname),
    port: Option.getOrUndefined(input.port),
    meeting: input.meeting,
  }).pipe(Effect.tapError((error) => (input.service ? recordStartupError(error) : Effect.void)))
})

export const recordStartupError = Effect.fnUntraced(function* (error: unknown) {
  const file = process.env.YCODING_SERVICE_STARTUP_ERROR_FILE
  if (!file) return
  const message = error instanceof Error ? error.message : String(error)
  yield* Effect.tryPromise(async () => {
    const existing = await readFile(file, "utf8").catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return ""
      throw cause
    })
    if (!existing) await writeFile(file, message, { mode: 0o600 })
  }).pipe(Effect.ignore)
})
