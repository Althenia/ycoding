import { Effect } from "effect"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServerConnection } from "../../services/server-connection"
import { Standalone } from "../../services/standalone"

export type RunInput = {
  readonly server?: string
  readonly standalone: boolean
  readonly config?: string
  readonly isolated?: boolean
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
  readonly permissions?: "manual" | "yolo" | "auto"
  readonly guardrails?: "manual" | "yolo" | "auto"
  readonly answers?: "manual" | "yolo" | "auto"
}

export function runCommand(input: RunInput) {
  return Effect.gen(function* () {
    const { runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    const env = yield* privateServerEnvironment(input)
    const server = env
      ? { endpoint: yield* Standalone.start({ env }) }
      : yield* ServerConnection.resolve({ server: input.server, standalone: input.standalone })
    yield* Effect.promise(() => runNonInteractive({ ...input, server }))
  })
}

/**
 * `--config` and `--isolated` configure the server process itself, so they always start a private
 * server. The config document travels as YCODING_CONFIG_CONTENT, the highest-priority config layer.
 */
const privateServerEnvironment = Effect.fnUntraced(function* (input: RunInput) {
  if (input.config === undefined && !input.isolated) return undefined
  if (input.server !== undefined)
    return yield* Effect.fail(new Error("--config and --isolated start a private server and cannot be combined with --server"))
  const content = input.config === undefined ? undefined : yield* readConfigDocument(input.config)
  const data = input.isolated ? yield* isolatedDataDirectory() : undefined
  return {
    ...(content === undefined ? {} : { YCODING_CONFIG_CONTENT: content }),
    ...(data === undefined
      ? {}
      : { XDG_DATA_HOME: data, YCODING_DB: path.join(data, "ycoding", "ycoding.db") }),
  }
})

const readConfigDocument = Effect.fnUntraced(function* (file: string) {
  if (process.env.YCODING_CONFIG_CONTENT !== undefined)
    return yield* Effect.fail(new Error("--config cannot be combined with YCODING_CONFIG_CONTENT"))
  const target = path.resolve(process.env.PWD ?? process.cwd(), file)
  const text = yield* Effect.tryPromise({
    try: () => fs.readFile(target, "utf8"),
    catch: (cause) => new Error(`Cannot read --config file ${target}`, { cause }),
  })
  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0)
    return yield* Effect.fail(
      new Error(
        `--config file ${target} is not valid JSON/JSONC: ${errors
          .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
          .join("; ")}`,
      ),
    )
  return text
})

/** A fresh data directory owned by this run; it is removed after the private server stops. */
const isolatedDataDirectory = () =>
  Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "ycoding-isolated-"))),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  )

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
