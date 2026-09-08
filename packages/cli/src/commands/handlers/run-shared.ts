import { Effect } from "effect"
import { ServerConnection } from "../../services/server-connection"

export type RunInput = {
  readonly server?: string
  readonly standalone: boolean
  readonly message: string[]
  readonly continue?: boolean
  readonly session?: string
  readonly fork?: boolean
  readonly model?: string
  readonly agent?: string
  readonly format: "default" | "json"
  readonly file: string[]
  readonly title?: string
  readonly thinking?: boolean
  readonly auto?: boolean
}

export function runCommand(input: RunInput) {
  return Effect.gen(function* () {
    const { runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    const server = yield* ServerConnection.resolve({ server: input.server, standalone: input.standalone })
    yield* Effect.promise(() => runNonInteractive({ ...input, server }))
  })
}

export function runRoot(input: {
  readonly server?: string
  readonly standalone: boolean
  readonly prompt?: string
  readonly model: string
  readonly continue: boolean
  readonly session?: string
}) {
  if (!input.prompt)
    return Effect.sync(() => {
      process.exitCode = 1
      process.stderr.write("ycoding: --model requires a positional prompt\n")
    })
  return runCommand({
    server: input.server,
    standalone: input.standalone,
    message: [input.prompt],
    model: input.model,
    continue: input.continue,
    session: input.session,
    format: "default",
    file: [],
  })
}
