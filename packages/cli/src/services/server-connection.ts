import { Service, type Endpoint, type EnsureOptions } from "@ycoding-ai/client/effect/service"
import { V5ClientError } from "@ycoding-ai/client/v5"
import { createClient } from "./client"
import { InstallationVersion } from "../version"
import { Effect, Redacted } from "effect"
import { Env } from "../env"
import { ServiceConfig } from "./service-config"
import { Standalone } from "./standalone"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error"
  readonly onStart?: EnsureOptions["onStart"]
}

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args) {
  if (args.server !== undefined && args.standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (args.server !== undefined) {
    const password = yield* Env.password
    const endpoint = {
      url: args.server,
      auth: password ? { type: "basic" as const, username: "ycoding", password: Redacted.value(password) } : undefined,
    } satisfies Endpoint
    const client = createClient(endpoint)
    yield* Effect.addFinalizer(() => Effect.sync(() => client.transport.close()))
    const health = yield* Effect.tryPromise({
      try: () => client.health.get({ signal: AbortSignal.timeout(5_000) }),
      catch: (cause) => connectError(endpoint, cause),
    })
    if (health.version !== InstallationVersion)
      process.stderr.write(
        `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${InstallationVersion}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (args.standalone) {
    return { endpoint: yield* Standalone.start() } satisfies Resolved
  }

  const options = yield* ServiceConfig.options()
  return {
    endpoint: yield* resolveManaged({ ...options, onStart: args.onStart }, args.mismatch ?? "replace"),
    service: managedService(options),
  } satisfies Resolved
})

export function managedService(options: EnsureOptions) {
  const reconnectOptions = { ...options, version: undefined }
  return {
    reconnect: () => Service.ensure(reconnectOptions),
    restart: () =>
      Effect.gen(function* () {
        yield* Service.stop(options)
        yield* Service.ensure(reconnectOptions)
      }),
  }
}

const resolveManaged = Effect.fnUntraced(function* (options: EnsureOptions, mismatch: NonNullable<Args["mismatch"]>) {
  if (mismatch === "replace") return yield* Service.ensure(options)
  if (mismatch === "ignore") return yield* Service.ensure({ ...options, version: undefined })

  const compatible = yield* Service.discover(options)
  if (compatible !== undefined) return compatible
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing !== undefined)
    return yield* Effect.fail(new Error("Background server version does not match this client"))
  return yield* Service.ensure(options)
})

function connectError(endpoint: Endpoint, cause: unknown) {
  if (cause instanceof V5ClientError && ["unavailable", "unsent"].includes(cause.status))
    return new Error(
      `Could not reach or authenticate with server at ${endpoint.url}; check the address and YCODING_PASSWORD`,
      { cause },
    )
  return new Error(`Server at ${endpoint.url} did not provide a compatible health response`, { cause })
}

export * as ServerConnection from "./server-connection"
