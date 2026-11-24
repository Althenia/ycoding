export * as NativeProcess from "./native-process"

import { Effect, Fiber, Stream } from "effect"
import { spawn } from "node:child_process"
import { frontendAssetArguments } from "./frontend-launch"
import { runtimeEnvironment, runtimeExecutable } from "./runtime-executable"
import { InstallationChannel, InstallationVersion } from "./version"

export type Options = {
  readonly mode: "default" | "service" | "stdio"
  readonly hostname?: string
  readonly port?: number
  readonly meeting?: boolean
  readonly command?: ReadonlyArray<string>
  readonly cwd?: string
  readonly detached?: boolean
  readonly env?: Readonly<Record<string, string>>
}

export const start = Effect.fnUntraced(function* (options: Options) {
  const command = options.command ?? [
    yield* Effect.tryPromise(runtimeExecutable),
    "serve",
    ...frontendAssetArguments(),
  ]
  const [executable, ...prefix] = command
  if (!executable) return yield* Effect.fail(new Error("Failed to resolve the native runtime command"))
  const owned = yield* Effect.acquireRelease(
    Effect.try(() => {
      const child = spawn(
        executable,
        [
          ...prefix,
          ...(options.mode === "default" ? [] : [options.mode === "stdio" ? "--stdio" : "--service"]),
          ...(options.hostname === undefined ? [] : ["--hostname", options.hostname]),
          ...(options.port === undefined ? [] : ["--port", String(options.port)]),
          ...(options.meeting ? ["--meeting"] : []),
        ],
        {
          cwd: options.cwd ?? process.cwd(),
          detached: options.detached,
          env: {
            ...runtimeEnvironment(),
            ...options.env,
            YCODING_VERSION: InstallationVersion,
            YCODING_CHANNEL: InstallationChannel,
          },
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        },
      )
      let error: Error | undefined
      child.on("error", (cause) => {
        error = cause
      })
      child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") error ??= cause
      })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal, error })),
      )
      let closing: Promise<{ ok: true } | { ok: false; cause: unknown }> | undefined
      const close = () =>
        (closing ??= cleanup().then(
          () => ({ ok: true as const }),
          (cause: unknown) => ({ ok: false as const, cause }),
        ))
      async function cleanup() {
        const failures: unknown[] = []
        const attempt = async (run: () => unknown) => {
          try {
            await run()
          } catch (cause) {
            failures.push(cause)
          }
        }
        await attempt(() => {
          child.stdin.end()
          if (options.mode !== "stdio" && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
        })
        await attempt(async () => {
          const timer = setTimeout(() => {
            failures.push(new Error("Native runtime cleanup required forced termination"))
            child.kill("SIGKILL")
          }, 3_000)
          try {
            await closed
          } finally {
            clearTimeout(timer)
          }
        })
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, "Native runtime cleanup failed")
      }
      return { child, closed, close }
    }),
    (owned) =>
      Effect.promise(async () => {
        const result = await owned.close()
        if (!result.ok) throw result.cause
      }),
  )
  return {
    child: owned.child,
    pid: owned.child.pid!,
    stdout: owned.child.stdout,
    stderr: owned.child.stderr,
    closed: owned.closed,
    retire: () => {
      void owned.close()
    },
  }
})

export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* start(options)
      const output = yield* Stream.fromAsyncIterable(child.stdout, (cause) => cause).pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => {
            process.stdout.write(bytes)
          }),
        ),
        Effect.forkScoped,
      )
      const errors = yield* Stream.fromAsyncIterable(child.stderr, (cause) => cause).pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => {
            process.stderr.write(bytes)
          }),
        ),
        Effect.forkScoped,
      )
      if (options.mode === "stdio")
        yield* Effect.acquireRelease(
          Effect.sync(() => process.stdin.pipe(child.child.stdin)),
          () =>
            Effect.sync(() => {
              process.stdin.unpipe(child.child.stdin)
            }),
        )
      yield* Effect.addFinalizer(() => Effect.sync(child.retire))
      const result = yield* Effect.promise(() => child.closed)
      yield* Fiber.join(output)
      yield* Fiber.join(errors)
      if (result.error) yield* Effect.fail(result.error)
      if (result.code !== 0) yield* Effect.fail(new Error(`Native runtime exited (${result.code ?? result.signal})`))
    }),
  )
})
