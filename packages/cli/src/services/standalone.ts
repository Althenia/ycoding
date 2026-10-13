import type { Endpoint } from "@ycoding-ai/client/effect/service"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { randomBytes } from "node:crypto"
import { runtimeExecutable, runtimeEnvironment } from "../runtime-executable"

const Ready = Schema.Struct({ url: Schema.String })
const decodeReady = Schema.decodeUnknownPromise(Schema.fromJsonString(Ready))

type Options = {
  readonly command?: ReadonlyArray<string>
}

function command(password: string, options: Options) {
  const [executable, ...args] = options.command ?? []
  if (!executable) throw new Error("Failed to resolve standalone server command")
  return ChildProcess.make(executable, [...args, "--stdio", "--port", "0"], {
    cwd: process.cwd(),
    // Explicit entry wins over anything inherited, so a user-exported
    // YCODING_PASSWORD cannot shadow the child's lease credential.
    env: { ...runtimeEnvironment(), YCODING_PASSWORD: password },
    extendEnv: true,
    // The server treats EOF on this pipe as the end of its ownership lease.
    // The OS closes it even when the TUI is killed before Effect finalizers run.
    stdin: "pipe",
    stderr: "inherit",
    killSignal: "SIGTERM",
    forceKillAfter: "3 seconds",
  })
}

const makeEndpoint = Effect.fn("cli.standalone.endpoint")(function* (options: Options) {
  const password = randomBytes(32).toString("base64url")
  const executable = options.command ?? [yield* Effect.tryPromise(runtimeExecutable)]
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const proc = yield* spawner.spawn(command(password, { command: executable }))
  const readyLine = yield* Deferred.make<string, Error>()
  // Keep draining stdout after readiness so later server writes cannot hit EPIPE.
  yield* proc.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Deferred.succeed(readyLine, line)),
    Effect.ensuring(Deferred.fail(readyLine, new Error("Standalone server exited before reporting readiness"))),
    Effect.forkScoped,
  )
  const output = yield* Deferred.await(readyLine)
  const ready = yield* Effect.tryPromise(() => decodeReady(output))
  return {
    url: ready.url,
    auth: { type: "basic" as const, username: "ycoding", password },
    pid: proc.pid,
  } satisfies Endpoint & { readonly pid: number }
}, Effect.provide(NodeServices.layer))

export function start(options: Options = {}) {
  return makeEndpoint(options)
}

export * as Standalone from "./standalone"
