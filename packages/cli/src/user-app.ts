import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Service, type Endpoint, type Info } from "@ycoding-ai/client/effect/service"
import { make, V5ClientError, type V5Client, type V5Options } from "@ycoding-ai/client/v5"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Effect, Exit, Redacted, Schema, Scope } from "effect"
import { Env } from "./env"
import { frontendAssetArguments } from "./frontend-launch"
import { FrontendPaths } from "./paths"
import { extractRuntime } from "./runtime-executable"
import { filename } from "./services/service-config"
import { Standalone } from "./services/standalone"
import { loadUserAppPacket, UserAppError } from "./user-app-packet"
import { userAppSocket } from "./user-app-socket"

export type UserAppSelection = { mode: "managed" } | { mode: "external"; url: string } | { mode: "private" }
export type UserAppOptions = { location: NonNullable<V5Options["location"]>; signal?: AbortSignal }
export type UserApp = { readonly api: Omit<V5Client, "transport">; close(): Promise<void> }

const decodeRegistration = Schema.decodeUnknownSync(Schema.fromJsonString(Service.Info))
const decodeHealth = Schema.decodeUnknownSync(ServiceStatus.Health)

function endpointURL(url: string) {
  try {
    const value = new URL(url)
    if (!["http:", "https:"].includes(value.protocol) || value.username || value.password)
      throw new UserAppError("configuration")
    return value
  } catch {
    throw new UserAppError("configuration")
  }
}

async function registration(file: string): Promise<Info | undefined> {
  try {
    return decodeRegistration(await readFile(file, "utf8"))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw new UserAppError("configuration")
  }
}

function sameRegistration(left: Info, right: Info) {
  return (
    left.id === right.id &&
    left.pid === right.pid &&
    left.version === right.version &&
    left.url === right.url &&
    left.password === right.password
  )
}

export async function openUserApp(selection: UserAppSelection, options: UserAppOptions): Promise<UserApp> {
  let signal: AbortSignal | undefined
  const scope = await Effect.runPromise(Scope.make())
  const opening = new AbortController()
  const sockets: ReturnType<typeof userAppSocket>[] = []
  let client: V5Client | undefined
  let privateServer:
    | {
        readonly pid: number
        readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>
      }
    | undefined
  let closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    const receipt = Promise.withResolvers<void>()
    closing = receipt.promise
    let failed = false
    try {
      client?.transport.close()
    } catch {
      failed = true
    }
    sockets.forEach((owned) => {
      try {
        owned.socket.close()
      } catch {
        failed = true
      }
    })
    const closingScope = Effect.runPromise(Scope.close(scope, Exit.void))
    const closingProcess =
      privateServer?.closed.then((result) => {
        if (result.error || result.code !== 0) throw new UserAppError("shutdown")
      }) ?? Promise.resolve()
    const settle = async () => {
      const results = await Promise.allSettled([closingScope, closingProcess, ...sockets.map((owned) => owned.closed)])
      if (failed || results.some((result) => result.status === "rejected")) throw new UserAppError("shutdown")
    }
    void settle().then(receipt.resolve, () => receipt.reject(new UserAppError("shutdown")))
    return closing
  }
  const abort = () => opening.abort()
  const cancelled = () => {
    if (opening.signal.aborted) throw new UserAppError("cancelled")
  }
  try {
    signal = options?.signal
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    ) {
      signal = undefined
      throw new UserAppError("configuration")
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    const mode = selection?.mode
    const selectedURL = mode === "external" ? selection.url : undefined
    const configuredLocation = options?.location
    const location = configuredLocation && {
      directory: configuredLocation.directory,
      workspaceID: configuredLocation.workspaceID,
    }
    cancelled()
    if (
      !selection ||
      !["managed", "external", "private"].includes(mode) ||
      !location ||
      typeof location.directory !== "string" ||
      !path.isAbsolute(location.directory)
    )
      throw new UserAppError("configuration")
    try {
      if (!(await stat(location.directory)).isDirectory()) throw new UserAppError("configuration")
    } catch {
      throw new UserAppError("configuration")
    }
    const packet = await loadUserAppPacket()
    cancelled()
    let endpoint: Endpoint
    let selected: Info | undefined
    let file: string | undefined
    if (mode === "managed") {
      file = path.join(FrontendPaths.resolvePaths(process.env, packet.channel).state, filename(packet.channel))
      const before = await registration(file)
      if (before && before.version !== packet.version) throw new UserAppError("version")
      if (before && !before.id) throw new UserAppError("identity")
      cancelled()
      endpoint = await Effect.runPromise(
        Service.ensure({
          file,
          version: packet.version,
          existing: "preserve",
          command: [packet.frontend, "serve", "--service"],
          startupErrorFile: file + ".startup-error",
        }).pipe(Effect.provide(NodeFileSystem.layer)),
        { signal: opening.signal },
      )
      selected = await registration(file)
      if (
        !selected?.id ||
        selected.version !== packet.version ||
        selected.url !== endpoint.url ||
        selected.password !== endpoint.auth?.password ||
        (before && !sameRegistration(before, selected))
      )
        throw new UserAppError("identity")
    } else if (mode === "private") {
      const executable = await extractRuntime(
        packet.runtime.payload,
        packet.runtime.sha256,
        FrontendPaths.Path.bin,
        packet.version,
      ).catch(() => {
        throw new UserAppError("artifact")
      })
      cancelled()
      const owned = await Effect.runPromise(
        Standalone.start({
          command: [executable, "serve", ...frontendAssetArguments(packet.frontend)],
          cwd: location.directory,
        }).pipe(Effect.provideService(Scope.Scope, scope)),
        { signal: opening.signal },
      )
      privateServer = owned
      endpoint = owned
    } else {
      if (typeof selectedURL !== "string") throw new UserAppError("configuration")
      endpointURL(selectedURL)
      const password = await Effect.runPromise(Env.password)
      endpoint = {
        url: selectedURL,
        auth: password ? { type: "basic", username: "ycoding", password: Redacted.value(password) } : undefined,
      }
    }
    cancelled()
    const url = endpointURL(endpoint.url)
    const response = await fetch(new URL("/api/health", url), {
      headers: Service.headers(endpoint),
      signal: opening.signal,
      redirect: "error",
    })
    if (response.status === 401 || response.status === 403) throw new UserAppError("authentication")
    if (!response.ok) throw new UserAppError("unavailable")
    const health = await response.json().then(
      (body: unknown) => {
        try {
          return decodeHealth(body)
        } catch {
          throw new UserAppError("contract")
        }
      },
      () => {
        throw new UserAppError("contract")
      },
    )
    if (health.version !== packet.version) throw new UserAppError("version")
    if (
      (privateServer && health.pid !== privateServer.pid) ||
      (selected && (health.pid !== selected.pid || health.sourceEpoch !== selected.id))
    )
      throw new UserAppError("identity")
    cancelled()
    client = make({
      endpoint,
      location,
      socket: (url, headers) => {
        const owned = userAppSocket(url, headers)
        sockets.push(owned)
        return owned.socket
      },
    })
    const interrupted = Promise.withResolvers<never>()
    const interrupt = () => interrupted.reject(new UserAppError("cancelled"))
    opening.signal.addEventListener("abort", interrupt, { once: true })
    try {
      await Promise.race([client.transport.ready(), interrupted.promise])
    } finally {
      opening.signal.removeEventListener("abort", interrupt)
    }
    cancelled()
    if (client.transport.sourceEpoch !== health.sourceEpoch) throw new UserAppError("identity")
    if (file && selected) {
      const current = await registration(file)
      if (!current || !sameRegistration(selected, current)) throw new UserAppError("identity")
    }
    cancelled()
    const { transport: _transport, ...api } = client
    return { api, close }
  } catch (error) {
    await close()
    if (opening.signal.aborted) throw new UserAppError("cancelled")
    if (error instanceof UserAppError) throw error
    const socketFailure = sockets.map((owned) => owned.failure()).find((failure) => failure !== undefined)
    if (socketFailure) throw new UserAppError(socketFailure)
    if (error instanceof V5ClientError && error.status === "protocol") throw new UserAppError("contract")
    throw new UserAppError("unavailable")
  } finally {
    try {
      signal?.removeEventListener("abort", abort)
    } catch {
      await close()
      throw new UserAppError("shutdown")
    }
  }
}
