import { Service, type Endpoint, type EnsureOptions } from "@ycoding-ai/client/effect/service"
import { ClientError, isUnauthorizedError, YCoding } from "@ycoding-ai/client/promise"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { Effect, Redacted } from "effect"
import { Env } from "../env"
import { ServiceConfig } from "./service-config"
import { Standalone } from "./standalone"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error"
  readonly diagnostics?: "sanitized"
  readonly onStart?: EnsureOptions["onStart"]
  readonly privateServer?: Parameters<typeof Standalone.start>[0]
  readonly managed?: "discover"
  readonly managedCommand?: EnsureOptions["command"]
}

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
  readonly exited?: Effect.Effect<void>
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args) {
  if (args.server !== undefined && args.standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (args.server !== undefined) {
    const password = yield* Env.password
    let auth: Endpoint["auth"] = password
      ? { type: "basic" as const, username: "ycoding", password: Redacted.value(password) }
      : undefined
    const target = URL.canParse(args.server) ? new URL(args.server).href : undefined
    if (auth === undefined && target !== undefined) {
      for (const file of yield* ServiceConfig.registrationFiles()) {
        const registered = yield* Service.registration({ file })
        if (registered !== undefined && URL.canParse(registered.url) && new URL(registered.url).href === target) {
          auth = registered.auth
          break
        }
      }
    }
    const endpoint = { url: args.server, auth } satisfies Endpoint
    const client = YCoding.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const health = yield* Effect.tryPromise({
      try: () => client.health.get({ signal: AbortSignal.timeout(5_000) }),
      catch: (cause) => connectError(endpoint, cause),
    })
    if (health.version !== InstallationVersion)
      process.stderr.write(
        args.diagnostics === "sanitized"
          ? "Warning: [server-version-mismatch] Native server version differs from this client; continuing without replacement.\n"
          : `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${InstallationVersion}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (args.standalone) {
    const server = yield* Standalone.owned(args.privateServer)
    return { endpoint: server.endpoint, exited: server.exited } satisfies Resolved
  }
  if (args.managed === "discover") {
    const options = yield* ServiceConfig.discoveryOptions()
    const endpoint = yield* Service.discover(options)
    if (endpoint !== undefined) return { endpoint } satisfies Resolved
    const existing = yield* Service.discover({ ...options, version: undefined })
    return yield* Effect.fail(new Error(existing === undefined
      ? "No compatible managed server is running"
      : "Managed server version does not match the bundled desktop client"))
  }

  const configured = yield* ServiceConfig.options()
  const options = { ...configured, ...(args.managedCommand ? { command: args.managedCommand } : {}) }
  if (args.managedCommand) {
    const endpoint = yield* Service.discover(options)
    if (endpoint !== undefined) return { endpoint } satisfies Resolved
  }
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

const resolveManaged = Effect.fnUntraced(function* (
  options: EnsureOptions,
  mismatch: NonNullable<Args["mismatch"]>,
) {
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
  if (isUnauthorizedError(cause)) {
    return new Error(
      endpoint.auth === undefined
        ? `Server at ${endpoint.url} requires a password; set YCODING_PASSWORD`
        : `Server at ${endpoint.url} rejected the password`,
      { cause },
    )
  }
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${endpoint.url}`, { cause })
  return new Error(`Server at ${endpoint.url} did not provide a compatible health response`, { cause })
}

export * as ServerConnection from "./server-connection"
