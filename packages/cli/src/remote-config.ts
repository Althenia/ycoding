export * as RemoteConfig from "./remote-config"

import { Global } from "@ycoding-ai/core/global"
import { RemoteWebSocketPath, isPreviewOrigin, maxPreviewOrigins } from "@ycoding-ai/remote"
import { Effect, FileSystem, Schema } from "effect"
import path from "node:path"

// Existing remote.json files may contain Session entries. They are decoded so
// operator data is left intact, but remote authorization and Location resolution
// never read them.

export const AllowlistSession = Schema.Struct({
  sessionID: Schema.String,
  directory: Schema.String,
  workspaceID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
})
export type AllowlistSession = typeof AllowlistSession.Type

export const AppPreview = Schema.Struct({
  origins: Schema.optional(Schema.Array(Schema.String)),
  ports: Schema.optional(Schema.Array(Schema.Number)),
  frameAncestors: Schema.optional(Schema.Array(Schema.String)),
})
export type AppPreview = typeof AppPreview.Type

export const Config = Schema.Struct({
  relayURL: Schema.optional(Schema.String),
  sessions: Schema.Array(AllowlistSession),
  appPreview: Schema.optional(AppPreview),
})
export type Config = typeof Config.Type

const filename = "remote.json"
export const envVar = "YCODING_REMOTE_URL"

const empty = (): Config => ({ sessions: [] })

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config))
const file = Effect.gen(function* () {
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

export function appPreview(config: Config) {
  const preview = config.appPreview
  if (preview === undefined) return undefined
  const origins = preview.origins ?? []
  if (origins.length > maxPreviewOrigins || !origins.every(isPreviewOrigin) || new Set(origins).size !== origins.length)
    throw new Error(`appPreview.origins must list at most ${maxPreviewOrigins} distinct exact HTTPS origins`)
  const ports = preview.ports ?? []
  if (ports.length > 64 || !ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535))
    throw new Error("appPreview.ports must list at most 64 loopback ports from 1 through 65535")
  const frameAncestors = preview.frameAncestors ?? []
  if (frameAncestors.length > 16 || !frameAncestors.every(isPreviewOrigin)) throw new Error("appPreview.frameAncestors must list at most 16 exact HTTPS origins")
  if (origins.length === 0 || ports.length === 0) return undefined
  return { origins: [...origins], ports: [...new Set(ports)], frameAncestors: [...new Set(frameAncestors)] }
}

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
  return new URL(RemoteWebSocketPath.agent, base).toString()
}
