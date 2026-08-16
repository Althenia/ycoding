import { Effect, Option } from "effect"
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
  })
})
