export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service, type DiscoverOptions, type Info } from "@ycoding-ai/client/effect/service"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Global } from "@ycoding-ai/core/global"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { AppProcess } from "@ycoding-ai/core/process"
import { randomBytes, randomUUID } from "node:crypto"
import path from "node:path"
import { Effect, FileSystem, Option, Redacted, Schedule, Schema } from "effect"
import { HttpServer } from "effect/unstable/http"
import { Env } from "./env"
import { DatabaseRecovery } from "./services/database-recovery"
import { ServiceConfig } from "./services/service-config"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  const providedRaw = processEffect(options).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), [
        [
          Global.node,
          Global.layerWith(process.env.YCODING_CONFIG_DIR ? { config: process.env.YCODING_CONFIG_DIR } : {}),
        ],
      ]),
    ),
    Effect.provide(NodeServices.layer),
  )
  // `start()` still carries per-request `Request<"Requires", ...>` markers from its internal
  // HttpRouter layer composition (see @ycoding-ai/server/process, createRoutes). They are resolved
  // once the router dispatches a real HTTP request, not by this generator's static requirements
  // channel, so narrow them away here the same way the SDK's embedded runtime construction does.
  const provided = providedRaw as Effect.Effect<Effect.Success<typeof providedRaw>, Effect.Error<typeof providedRaw>>
  return yield* provided
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(Global.Path.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      if (
        serviceOptions !== undefined &&
        port !== undefined &&
        (yield* Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })) !== undefined
      )
        return
      if (options.mode === "service" && !process.env.YCODING_DB) {
        const backup = yield* Effect.tryPromise(() => DatabaseRecovery.backupUnsupported())
        if (backup)
          yield* Effect.logWarning("backed up unsupported pre-current database", {
            backup,
          })
      }
      const { start } = yield* Effect.promise(() => import("@ycoding-ai/server/process"))
      const environmentPassword = yield* Env.password
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        delete process.env.YCODING_PASSWORD
        delete process.env.YCODING_SERVER_PASSWORD
      }
      const password =
        options.mode === "service"
          ? config.password || randomBytes(32).toString("base64url")
          : environmentPassword
            ? Redacted.value(environmentPassword)
            : randomBytes(32).toString("base64url")
      if (!password) return yield* Effect.fail(new Error("Missing server password"))
      const instanceID = randomUUID()
      const server = yield* start(
        {
          client: process.env.YCODING_CLIENT ?? "cli",
          hostname,
          port,
          password,
          simulation: truthy(process.env.YCODING_SIMULATE),
          database: {
            path: process.env.YCODING_DB,
          },
          models: {
            url: process.env.YCODING_MODELS_URL,
            file: process.env.YCODING_MODELS_PATH,
            fetch: !truthy(process.env.YCODING_DISABLE_MODELS_FETCH),
          },
          observability: {
            endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
            headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
          },
          config: {
            directory: process.env.YCODING_CONFIG_DIR,
            project: !truthy(process.env.YCODING_CONFIG_PROJECT_DISABLE ?? process.env.YCODING_DISABLE_PROJECT_CONFIG),
            file: process.env.YCODING_CONFIG,
            content: process.env.YCODING_CONFIG_CONTENT,
          },
          windows: {
            gitbash: process.env.YCODING_GIT_BASH_PATH,
          },
          fs: {
            filewatcher: !truthy(process.env.YCODING_FILEWATCHER_DISABLE ?? process.env.YCODING_DISABLE_FILEWATCHER),
            fff:
              process.env.YCODING_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.YCODING_DISABLE_FFF),
          },
        },
        serviceOptions === undefined
          ? undefined
          : {
              instanceID,
              onListen: (address, shutdown) =>
                Effect.gen(function* () {
                  if (!config.password) yield* ServiceConfig.password(password)
                  return yield* register(address, password, instanceID, serviceOptions.file, shutdown)
                }),
            },
      ).pipe(
        Effect.catch((error) => {
          if (serviceOptions === undefined || port === undefined || !addressInUse(error)) return Effect.fail(error)
          return recognizeIncumbent(serviceOptions, hostname, port).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.void
                : Effect.fail(
                    new Error(
                      `Managed service port ${port} on ${hostname} is already in use by another process. ` +
                        `Set \`port\` in ${ServiceConfig.filename()} under the YCoding config directory, ` +
                        "or start with `ycoding --standalone`.",
                      { cause: error },
                    ),
                  ),
            ),
          )
        }),
      )
      if (server === undefined) return
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      if (options.mode === "default" && !environmentPassword) console.log(`server password ${password}`)
      return yield* options.mode === "service"
        ? server.shutdown
        : options.mode === "stdio"
          ? waitForStdinClose()
          : Effect.never
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

const infoJson = Schema.fromJsonString(Service.Info)
const encodeInfo = Schema.encodeEffect(infoJson)
const decodeInfo = Schema.decodeUnknownEffect(infoJson)

const register = Effect.fnUntraced(function* (
  address: HttpServer.Address,
  password: string,
  id: string,
  file: string,
  shutdown: Effect.Effect<void>,
) {
  const fs = yield* FileSystem.FileSystem
  const temp = file + "." + id + ".tmp"
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const info = {
    id,
    version: InstallationVersion,
    url: HttpServer.formatAddress(address),
    pid: process.pid,
    password,
  }
  const encoded = yield* encodeInfo(info)
  const current = fs.readFileString(file).pipe(
    Effect.flatMap(decodeInfo),
    Effect.orElseSucceed(() => undefined),
  )
  const owns = (found: Info | undefined) =>
    found?.id === info.id &&
    found.version === info.version &&
    found.url === info.url &&
    found.pid === info.pid &&
    found.password === info.password
  yield* fs.writeFileString(temp, encoded, { mode: 0o600 }).pipe(Effect.andThen(fs.rename(temp, file)))
  yield* current.pipe(
    Effect.filterOrFail(owns),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.ignore,
    Effect.andThen(shutdown),
    Effect.forkScoped,
  )
  return current.pipe(
    Effect.flatMap((found) => (owns(found) ? fs.remove(file) : Effect.void)),
    Effect.ignore,
  )
})

const recognizeIncumbent = Effect.fnUntraced(function* (options: DiscoverOptions, hostname: string, port: number) {
  const found = yield* Service.incumbent({ ...options, url: serviceURL(hostname, port) }).pipe(
    Effect.filterOrFail((value) => value !== undefined),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeoutOption("15 seconds"),
  )
  return Option.isSome(found)
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}
