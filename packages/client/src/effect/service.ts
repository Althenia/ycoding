import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Clock, Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscoverOptions, Endpoint, EnsureOptions, StopOptions } from "../service.js"
import { managedShutdownTimeout, pollDelay, startupTimeout, stopPollInterval } from "../service-poll.js"
import { assertStopTarget } from "../service-stop.js"

export * from "../service.js"
/** Contents of the local service registration file. */
export type Info = import("../service.js").Info

// Find, start, and stop the local ycoding background service.
//
// The service daemon advertises itself through a registration file in the
// user's state directory: url, pid, version, and the private password, with
// 0600 permissions. That file is the complete discovery contract — reading it
// is all a client needs to connect. The daemon's own configuration (port,
// persisted password) is CLI-owned and never read here.

type Contender = {
  readonly child: ChildProcess
  readonly error: () => Error | undefined
  readonly startupErrorFile?: string
}

// Read-only lookup: registration file plus health check and version gate.
// Never spawns; escalation to ensure() is the caller's policy.
/** Discover a healthy, compatible local service without starting one. */
export const discover = Effect.fn("service.discover")(function* (options: DiscoverOptions = {}) {
  return (yield* discoverLocal(options))?.endpoint
})

/** Recognize an authenticated compatible service, including while it starts or fails. */
export const incumbent = Effect.fn("service.incumbent")(function* (
  options: DiscoverOptions & { readonly url?: string },
) {
  const info = yield* read(options.file)
  const found = info === undefined ? undefined : yield* probe({ ...info, url: options.url ?? info.url })
  if (found === undefined || found.legacy) return undefined
  if (options.version !== undefined && found.version !== options.version) return undefined
  return { endpoint: found.endpoint, state: found.state }
})

const discoverLocal = Effect.fnUntraced(function* (options: DiscoverOptions) {
  const found = (yield* registered(options.file)).service
  if (found?.state !== "ready") return undefined
  if (options.version !== undefined && found.version !== options.version) return undefined
  return found
})

// Idempotent ensure-running: reuses a healthy compatible server, replaces a
// version-mismatched one, and otherwise spawns small contenders until a server
// becomes discoverable. A contender is never killed merely for slow startup.
/** Ensure a healthy, compatible local service is running. */
export const ensure = Effect.fn("service.ensure")(function* (options: EnsureOptions = {}) {
  const started = yield* Clock.currentTimeMillis
  const contenders = new Set<Contender>()
  let announced = false
  let lastSpawn = 0
  let spawnDelay = 5_000
  let ownerHeld = false
  let failedReplacement = false
  const announce = (reason: "missing" | "version-mismatch", previousVersion?: string) =>
    Effect.sync(() => {
      if (announced) return
      announced = true
      options.onStart?.(reason, previousVersion)
    })
  const spawnContender = Effect.gen(function* () {
    const [command, ...args] = options.command ?? ["ycoding", "serve", "--service"]
    if (command === undefined) return yield* Effect.fail(new Error("Missing service command"))
    const startupErrorFile = options.startupErrorFile ? `${options.startupErrorFile}.${randomUUID()}` : undefined
    return yield* Effect.try({
      try: () => {
        const child = spawn(command, args, {
          detached: true,
          stdio: "ignore",
          env:
            startupErrorFile === undefined
              ? process.env
              : { ...process.env, YCODING_SERVICE_STARTUP_ERROR_FILE: startupErrorFile },
        })
        let error: Error | undefined
        child.once("error", (cause) => {
          error = new Error("Failed to start server", { cause })
        })
        child.unref()
        return { child, error: () => error, startupErrorFile }
      },
      catch: (cause) => new Error("Failed to start server", { cause }),
    })
  })
  const found = yield* Effect.gen(function* () {
    const registration = yield* registered(options.file, true, options.existing === "preserve")
    const info = registration.info
    const service = registration.service
    if (service !== undefined) {
      ownerHeld = false
      spawnDelay = 5_000
      const compatible = !service.legacy && (options.version === undefined || service.version === options.version)
      if (compatible && service.state === "ready") return Option.some(service)
      if (options.existing === "preserve") {
        if (!compatible) return yield* Effect.fail(new Error("Background server version does not match this client"))
        if (service.state === "failed")
          return yield* Effect.fail(new Error("Existing background service failed to start"))
      }
      if (compatible && service.state === "failed") {
        if (failedReplacement) return yield* Effect.fail(new Error("Background service failed to start"))
        failedReplacement = true
        yield* kill(service, options).pipe(Effect.ignore)
        lastSpawn = Date.now() - spawnDelay
        return Option.none<LocalService>()
      }
      if (compatible) return Option.none<LocalService>()
      yield* announce("version-mismatch", service.version)
      yield* kill(service, options).pipe(Effect.ignore)
      lastSpawn = 0
      return Option.none<LocalService>()
    } else if (lastSpawn === 0 && info !== undefined) lastSpawn = Date.now()

    const failure = [...contenders].map(contenderFailure).find((error): error is Error => error !== undefined)
    if (failure !== undefined) return yield* Effect.fail(failure)
    const finished = [...contenders].filter(contenderFinished)
    if (finished.some((item) => item.child.exitCode === 0)) {
      ownerHeld = true
      spawnDelay = Math.min(spawnDelay * 2, 30_000)
    }
    finished.forEach((item) => {
      cleanupContender(item)
      contenders.delete(item)
    })
    // Keep one candidate plus one lock probe so a pre-lock stall cannot block recovery.
    if (contenders.size < 2 && Date.now() - lastSpawn >= spawnDelay) {
      yield* announce("missing")
      if (options.existing === "preserve" && (yield* registered(options.file, false, true)).info !== undefined)
        return Option.none<LocalService>()
      contenders.add(yield* spawnContender)
      lastSpawn = Date.now()
    }
    return Option.none<LocalService>()
  }).pipe(
    Effect.repeat({
      until: Option.isSome,
      schedule: Schedule.spaced("100 millis").pipe(
        Schedule.modifyDelay(() => Clock.currentTimeMillis.pipe(Effect.map((now) => pollDelay(now - started)))),
      ),
    }),
    Effect.timeoutOrElse({
      duration: startupTimeout,
      orElse: () => Effect.fail(new Error("Timed out waiting for the background service to start")),
    }),
    Effect.ensuring(Effect.sync(() => contenders.forEach(cleanupContender))),
  )
  if (Option.isNone(found))
    return yield* Effect.fail(new Error("Timed out waiting for the background service to start"))
  return found.value.endpoint
})

function contenderFailure(contender: Contender) {
  const error = contender.error()
  if (error !== undefined) return error
  const detail = readStartupError(contender.startupErrorFile)
  if (contender.child.exitCode !== null && contender.child.exitCode !== 0)
    return new Error(detail ?? `Server process exited with code ${contender.child.exitCode}`)
  if (contender.child.signalCode !== null)
    return new Error(detail ?? `Server process terminated by ${contender.child.signalCode}`)
  return undefined
}

function readStartupError(file?: string) {
  if (file === undefined) return undefined
  try {
    return readFileSync(file, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

function cleanupContender(contender: Contender) {
  if (contender.startupErrorFile === undefined) return
  rmSync(contender.startupErrorFile, { force: true })
}

function contenderFinished(contender: Contender) {
  return contender.error() !== undefined || contender.child.exitCode !== null || contender.child.signalCode !== null
}

/** Stop the registered local service. */
export const stop = Effect.fn("service.stop")(function* (options: StopOptions = {}) {
  const existing = yield* find(options)
  yield* Effect.try({ try: () => assertStopTarget(options.expected, existing), catch: () => new Error("The registered service changed before it could be stopped") })
  if (existing !== undefined) yield* kill(existing, options)
})

function fallback() {
  const state = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state")
  return join(state, "ycoding", "service.json")
}

/** Create HTTP authentication headers for a service endpoint. */
export function headers(endpoint: Endpoint) {
  if (endpoint.auth === undefined) return undefined
  return { authorization: "Basic " + btoa(endpoint.auth.username + ":" + endpoint.auth.password) }
}

/** Schema for the local service registration file. */
export const Info = Schema.Struct({
  id: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  url: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  password: Schema.optional(Schema.String),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Info))
const decodeHealth = Schema.decodeUnknownOption(ServiceStatus.Health)
const decodeLegacyHealth = Schema.decodeUnknownOption(Schema.Struct({ healthy: Schema.Literal(true) }))

const read = Effect.fnUntraced(function* (file?: string, preserve = false) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file ?? fallback()).pipe(
    Effect.catch((cause) => {
      if (!preserve || cause.reason._tag === "NotFound") return Effect.succeed(undefined)
      return Effect.fail(new Error("Could not read background service registration", { cause }))
    }),
  )
  if (text === undefined) return undefined
  if (!preserve) return yield* decode(text).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  const info = yield* decode(text).pipe(
    Effect.mapError((cause) => new Error("Invalid background service registration", { cause })),
  )
  if (!info.id || !info.version || !info.url)
    return yield* Effect.fail(new Error("Invalid background service registration"))
  return info
})

type LocalService = {
  readonly info: Info
  readonly endpoint: Endpoint
  readonly version?: string
  readonly state: "ready" | "waiting" | "failed"
  readonly legacy: boolean
}

function registeredEndpoint(info: Info) {
  return {
    url: info.url,
    auth:
      info.password === undefined
        ? undefined
        : { type: "basic" as const, username: "ycoding", password: info.password },
  } satisfies Endpoint
}

export const registration = Effect.fn("service.registration")(function* (options: { readonly file?: string } = {}) {
  const info = yield* read(options.file)
  return info === undefined ? undefined : registeredEndpoint(info)
})

const probe = Effect.fnUntraced(function* (info: Info, allowLegacy = false, preserve = false) {
  const endpoint = registeredEndpoint(info)
  const response = yield* Effect.tryPromise(() =>
    fetch(new URL("/api/health", info.url), {
      headers: headers(endpoint),
      signal: AbortSignal.timeout(2_000),
    }),
  ).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  if (response === undefined) return undefined
  const body = yield* Effect.tryPromise(() => response.json()).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  const health = decodeHealth(body)
  if (Option.isSome(health)) {
    if (preserve && (health.value.sourceEpoch !== info.id || ![200, 500, 503].includes(response.status)))
      return undefined
    if (health.value.pid !== info.pid) return undefined
    if (info.version !== undefined && health.value.version !== info.version) return undefined
    return {
      info,
      endpoint,
      version: health.value.version,
      state: response.ok ? "ready" : response.status === 500 ? "failed" : "waiting",
      legacy: false,
    } satisfies LocalService
  }
  if (
    !allowLegacy ||
    Option.isNone(decodeLegacyHealth(body)) ||
    (typeof body === "object" && body !== null && ("version" in body || "pid" in body))
  )
    return undefined
  return { info, endpoint, state: "ready", legacy: true } satisfies LocalService
})

const registered = Effect.fnUntraced(function* (file?: string, allowLegacy = false, preserve = false) {
  const info = yield* read(file, preserve)
  if (info === undefined) return { info: undefined, service: undefined }
  const service = yield* probe(info, allowLegacy, preserve)
  if (preserve) {
    if (service === undefined)
      return yield* Effect.fail(new Error("Existing background service could not be authenticated"))
    const current = yield* read(file, true)
    if (current === undefined || !same(info, current) || info.password !== current.password)
      return yield* Effect.fail(new Error("Background service registration changed during verification"))
  }
  return { info, service }
})

// Health-checked lookup without the version gate: lifecycle operations must be
// able to see (and replace or stop) a server from a different version.
const find = Effect.fnUntraced(function* (options: { readonly file?: string }) {
  return (yield* registered(options.file, true)).service
})

const stopPoll = Schedule.spaced(stopPollInterval)
const legacyStopPoll = Schedule.max([stopPoll, Schedule.recurs(100)])

const signal = (pid: number, name: NodeJS.Signals) =>
  Effect.try({ try: () => process.kill(pid, name), catch: (cause) => cause }).pipe(Effect.ignore)

const stopped = Effect.fnUntraced(function* (pid: number) {
  const running = yield* Effect.try({ try: () => process.kill(pid, 0), catch: () => false }).pipe(
    Effect.orElseSucceed(() => false),
  )
  if (!running) return true
  return yield* Effect.fail(new Error(`Server process ${pid} is still running`))
})

function same(left: Info, right: Info) {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid
}

const kill = Effect.fnUntraced(function* (service: LocalService, options: StopOptions) {
  const requested = yield* requestStop(service)
  if (requested === "rejected") {
    if (options.expected) return yield* Effect.fail(new Error("The selected service did not stop"))
    return
  }
  if (requested === "accepted") {
    yield* stopped(service.info.pid).pipe(
      Effect.retry(stopPoll),
      Effect.timeoutOrElse({
        duration: managedShutdownTimeout,
        orElse: () => Effect.fail(new Error(`Timed out waiting for server process ${service.info.pid} to stop`)),
      }),
    )
    return
  }
  // A stale registration may point at a reused PID. Authenticate again
  // immediately before the legacy signal fallback.
  const current = yield* find(options)
  if (current === undefined || !same(current.info, service.info)) {
    if (options.expected) return yield* Effect.fail(new Error("The registered service changed before it could be stopped"))
    return
  }
  yield* signal(service.info.pid, "SIGTERM")
  const done = yield* stopped(service.info.pid).pipe(Effect.retry(legacyStopPoll), Effect.option)
  if (Option.isSome(done)) return

  const latest = yield* find(options)
  if (latest === undefined || !same(latest.info, service.info)) {
    if (options.expected) return yield* Effect.fail(new Error("The selected service did not stop"))
    return
  }
  yield* signal(service.info.pid, "SIGKILL")
  yield* stopped(service.info.pid).pipe(Effect.retry(legacyStopPoll))
})

const decodeStopResponse = Schema.decodeUnknownOption(ServiceStatus.StopResponse)

const requestStop = Effect.fnUntraced(function* (service: LocalService) {
  if (service.info.id === undefined || service.legacy) return "unsupported" as const
  const response = yield* Effect.tryPromise(() =>
    fetch(new URL("/api/service/stop", service.info.url), {
      method: "POST",
      headers: { ...headers(service.endpoint), "content-type": "application/json" },
      body: JSON.stringify({ instanceID: service.info.id }),
      signal: AbortSignal.timeout(2_000),
    }),
  ).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  if (response === undefined || response.status === 404 || response.status === 405) return "unsupported" as const
  const body = yield* Effect.tryPromise(() => response.json()).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  const decoded = decodeStopResponse(body)
  if (!response.ok || Option.isNone(decoded) || !decoded.value.accepted) return "rejected" as const
  return "accepted" as const
})

/** Effect-based local service lifecycle operations. */
export const Service = { discover, incumbent, registration, ensure, stop, headers, Info }
