export * as RemoteConfig from "./remote-config"

import { Global } from "@ycoding-ai/core/global"
import { RemoteLimits } from "@ycoding-ai/remote"
import { Effect, FileSystem, Schema } from "effect"
import path from "node:path"

// The explicit local allowlist for remote access. A session is reachable from
// the relay only after the local user opted it in here, and the entry binds the
// session to the Location it was verified at, so a remote client can never
// choose or influence which folder YCoding serves.

export const AllowlistSession = Schema.Struct({
  sessionID: Schema.String,
  directory: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
})
export type AllowlistSession = typeof AllowlistSession.Type

export const Config = Schema.Struct({
  relayURL: Schema.optional(Schema.String),
  sessions: Schema.Array(AllowlistSession),
})
export type Config = typeof Config.Type

export const filename = "remote.json"
export const envVar = "YCODING_REMOTE_URL"

const empty = (): Config => ({ sessions: [] })

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config))
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Config))

export const file = Effect.gen(function* () {
  const global = yield* Global.Service
  return path.join(global.config, filename)
})

export const read = Effect.fn("cli.remote-config.read")(function* () {
  const fs = yield* FileSystem.FileSystem
  const target = yield* file
  if (!(yield* fs.exists(target))) return empty()
  const text = yield* fs.readFileString(target)
  return yield* decodeConfig(text).pipe(
    Effect.mapError(() => new Error(`Malformed remote configuration at ${target}; fix or remove it`)),
  )
})

const write = Effect.fnUntraced(function* (config: Config) {
  const fs = yield* FileSystem.FileSystem
  const target = yield* file
  const encoded = yield* encodeConfig(config)
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  const temp = `${target}.${crypto.randomUUID()}.tmp`
  yield* fs.writeFileString(temp, encoded, { mode: 0o600 })
  yield* fs.rename(temp, target)
})

export const sessions = Effect.fn("cli.remote-config.sessions")(function* () {
  return (yield* read()).sessions
})

/** Upsert one opted-in session. The session identity is the allowlist key. */
export const allow = Effect.fn("cli.remote-config.allow")(function* (session: AllowlistSession) {
  const config = yield* read()
  const existing = config.sessions.findIndex((entry) => entry.sessionID === session.sessionID)
  if (existing === -1 && config.sessions.length >= RemoteLimits.maxAdvertisedSessions)
    return yield* Effect.fail(
      new Error(`At most ${RemoteLimits.maxAdvertisedSessions} sessions can be exposed to the relay`),
    )
  const next = existing === -1 ? [...config.sessions, session] : config.sessions.with(existing, session)
  yield* write({ ...config, sessions: next })
  return session
})

export const deny = Effect.fn("cli.remote-config.deny")(function* (sessionID: string) {
  const config = yield* read()
  const next = config.sessions.filter((entry) => entry.sessionID !== sessionID)
  if (next.length === config.sessions.length) return false
  yield* write({ ...config, sessions: next })
  return true
})

/**
 * Resolution order: explicit flag, environment, then stored configuration.
 * The relay base is an HTTPS origin; the agent socket is derived from it.
 */
export const relayURL = Effect.fn("cli.remote-config.relayURL")(function* (
  input: { readonly flag?: string; readonly env?: string } = {},
) {
  const stored = input.flag ?? input.env ?? (yield* read()).relayURL
  if (stored === undefined || stored.trim().length === 0)
    return yield* Effect.fail(
      new Error(
        `No relay URL configured; pass --relay, set ${envVar}, or store one with \`ycoding remote enroll --relay <url>\``,
      ),
    )
  return normalizeRelayURL(stored.trim())
})

export function normalizeRelayURL(value: string) {
  const url = parseURL(value)
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("The relay URL must be HTTPS; only a loopback relay may use HTTP")
  if (url.username !== "" || url.password !== "") throw new Error("The relay URL must not carry credentials")
  if (url.search !== "" || url.hash !== "") throw new Error("The relay URL must not carry a query or fragment")
  if (url.pathname !== "/" && url.pathname !== "")
    throw new Error("The relay URL must be an origin without a path")
  return url.origin
}

/**
 * Device credentials are bound to the origin the device enrolled with. An
 * environment or flag override may not retarget them, so the caller checks the
 * requested origin before minting or refreshing any credential.
 */
export function assertEnrolledRelay(input: { readonly requested: string; readonly enrolled: string }) {
  const requested = parseURL(input.requested).origin
  const enrolled = parseURL(input.enrolled).origin
  if (requested !== enrolled)
    throw new Error(
      `Refusing to send device credentials to ${requested}: this device is enrolled at ${enrolled}. ` +
        "Enroll a device for the other relay instead.",
    )
  return enrolled
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

function parseURL(value: string) {
  try {
    return new URL(value)
  } catch {
    throw new Error("The relay URL must be an absolute HTTPS URL")
  }
}

/** Agent relay socket for a relay base. The device credential travels in the upgrade header only. */
export function agentURL(relayURL: string) {
  const base = new URL(relayURL)
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:"
  return new URL("/ws/agent", base).toString()
}
