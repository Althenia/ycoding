import type { Endpoint } from "@ycoding-ai/client/effect/service"
import { Deferred, Effect, Schema, Stream } from "effect"
import { randomBytes } from "node:crypto"
import { NativeProcess } from "../native-process"

const Ready = Schema.Struct({ url: Schema.String })
const decodeReady = Schema.decodeUnknownPromise(Schema.fromJsonString(Ready))

type Options = {
  readonly command?: ReadonlyArray<string>
  readonly cwd?: string
  readonly detached?: boolean
  /** Environment overrides for the private server, applied over the inherited environment. */
  readonly env?: Readonly<Record<string, string>>
  readonly meeting?: boolean
}

const makeEndpoint = Effect.fn("cli.standalone.endpoint")(function* (options: Options) {
  const password = randomBytes(32).toString("base64url")
  const proc = yield* NativeProcess.start({
    mode: "stdio",
    port: 0,
    command: options.command,
    cwd: options.cwd,
    detached: options.detached,
    meeting: options.meeting,
    env: { ...options.env, YCODING_PASSWORD: password, YCODING_SERVER_PASSWORD: "" },
  })
  const readyLine = yield* Deferred.make<string, Error>()
  yield* Stream.fromAsyncIterable(proc.stderr, (cause) => cause).pipe(Stream.runDrain, Effect.forkScoped)
  yield* Stream.fromAsyncIterable(proc.stdout, (cause) => cause).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Deferred.succeed(readyLine, line)),
    Effect.ensuring(Deferred.fail(readyLine, new Error("Standalone server exited before reporting readiness"))),
    Effect.forkScoped,
  )
  yield* Effect.addFinalizer(() => Effect.sync(proc.retire))
  const output = yield* Deferred.await(readyLine)
  const ready = yield* Effect.tryPromise(() => decodeReady(output))
  return {
    endpoint: {
      url: ready.url,
      auth: { type: "basic" as const, username: "ycoding", password },
      pid: proc.pid,
    } satisfies Endpoint & { readonly pid: number },
    closed: proc.closed,
    exited: Effect.promise(() => proc.closed).pipe(Effect.asVoid),
  }
})

export function owned(options: Options = {}) {
  return makeEndpoint(options).pipe(Effect.map(({ endpoint, exited }) => ({ endpoint, exited })))
}

export function start(options: Options = {}) {
  return makeEndpoint(options).pipe(Effect.map((server) => ({ ...server.endpoint, closed: server.closed })))
}

export * as Standalone from "./standalone"
