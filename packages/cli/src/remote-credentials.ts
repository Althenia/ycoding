export * as RemoteCredentials from "./remote-credentials"

import { Global } from "@ycoding-ai/core/global"
import { deviceSignaturePayload, enrollmentCodePattern } from "@ycoding-ai/remote"
import { Effect, FileSystem, Option, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"

// Local device enrollment for the remote relay. The P-256 private key never
// leaves this machine and lives outside the repository under the global state
// directory with 0600 permissions; tokens are rotated by the relay and stored
// here, but never in a URL or an environment variable.

export const PublicKey = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
})
export type PublicKey = typeof PublicKey.Type

export const PrivateKey = Schema.Struct({
  ...PublicKey.fields,
  d: Schema.String,
})
export type PrivateKey = typeof PrivateKey.Type

export const Identity = Schema.Struct({
  deviceID: Schema.String,
  name: Schema.String,
  relayURL: Schema.String,
  publicKey: PublicKey,
  privateKey: PrivateKey,
  refreshToken: Schema.optional(Schema.String),
  refreshExpiresAt: Schema.optional(Schema.Number),
  enrolledAt: Schema.Number,
})
export type Identity = typeof Identity.Type

export const filename = "remote-device.json"

const decodeIdentity = Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))
const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Identity))

/** The credentials outlive any repository checkout; they are never project-local. */
export const file = Effect.gen(function* () {
  const global = yield* Global.Service
  return path.join(global.state, filename)
})

export const read = Effect.fn("cli.remote-credentials.read")(function* () {
  const fs = yield* FileSystem.FileSystem
  const target = yield* file
  const info = yield* lstat(target)
  if (Option.isNone(info)) return undefined
  if (info.value.isSymbolicLink()) return yield* Effect.fail(new Error(symlinkError(target)))
  const text = yield* fs.readFileString(target)
  return yield* decodeIdentity(text).pipe(
    Effect.mapError(() => new Error(`Malformed remote device credentials at ${target}; re-enroll this device`)),
  )
})

/** First enrollment: refuse to silently replace an existing device identity. */
export const create = Effect.fn("cli.remote-credentials.create")(function* (identity: Identity) {
  const target = yield* file
  const existing = yield* lstat(target)
  if (Option.isSome(existing))
    return yield* Effect.fail(
      new Error(
        `This machine is already enrolled at ${target}; revoke the old device first or re-run with --replace`,
      ),
    )
  return yield* write(identity, target)
})

/** Rotating an existing device identity: refresh credentials, name, or relay URL. */
export const update = Effect.fn("cli.remote-credentials.update")(function* (identity: Identity) {
  return yield* write(identity, yield* file)
})

const write = Effect.fnUntraced(function* (identity: Identity, target: string) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* lstat(target)
  if (Option.isSome(info) && info.value.isSymbolicLink()) return yield* Effect.fail(new Error(symlinkError(target)))
  const encoded = yield* encodeIdentity(identity)
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  const temp = `${target}.${crypto.randomUUID()}.tmp`
  yield* fs.writeFileString(temp, encoded, { mode: 0o600 })
  // Rename replaces the destination entry itself, so a link planted at the
  // destination cannot redirect the write to another file.
  yield* fs.rename(temp, target)
})

/** Read-only symlink probe: `FileSystem.stat` follows links, which is unsafe here. */
const lstat = (target: string) =>
  Effect.tryPromise({
    try: async () => {
      const info = await fs.lstat(target)
      return {
        isSymbolicLink: () => info.isSymbolicLink(),
      }
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined), Effect.map(Option.fromNullishOr))

function symlinkError(target: string) {
  return `Refusing to use ${target} because it is a symbolic link; remove it and enroll this device again`
}

export async function generateDeviceKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.privateKey),
    crypto.subtle.exportKey("jwk", pair.publicKey),
  ])
  if (!publicKey.x || !publicKey.y || !privateKey.d) throw new Error("Failed to generate a P-256 device key")
  return {
    privateKey: PrivateKey.make({ kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y, d: privateKey.d }),
    publicKey: PublicKey.make({ kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y }),
  }
}

/** Raw 64-byte `r || s` ECDSA value in unpadded base64url, as the relay expects. */
export async function signChallenge(privateKey: PrivateKey, challengeID: string, nonce: string) {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(deviceSignaturePayload(challengeID, nonce)),
  )
  return Buffer.from(new Uint8Array(signature)).toString("base64url")
}

export type FetchLike = typeof globalThis.fetch

/**
 * The relay authoritatively rejected this device (revoked, expired, or unknown).
 * A caller must treat this as terminal: reconnecting or retrying credential
 * exchange cannot recover it, only a new enrollment can.
 */
export class DeviceAuthorizationError extends Error {
  override readonly name = "DeviceAuthorizationError"

  constructor(readonly status: number) {
    super("The relay no longer authorizes this device; enroll it again with `ycoding remote enroll`")
  }
}

export async function enroll(input: {
  readonly relayURL: string
  readonly enrollmentID: string
  readonly code: string
  readonly name: string
  readonly privateKey: PrivateKey
  readonly publicKey: PublicKey
  readonly fetcher?: FetchLike
}) {
  if (!enrollmentCodePattern.test(input.code)) throw new Error("That enrollment code is not in the expected format")
  const name = input.name.trim()
  if (name.length === 0) throw new Error("A device name is required")
  const response = await post(input.relayURL, "/api/devices/enroll", input.fetcher, {
    enrollmentID: input.enrollmentID,
    code: input.code,
    name,
    publicKey: input.publicKey,
  })
  const deviceID = requireStringField(response, "deviceID")
  return { deviceID }
}

export const credentials = Effect.fn("cli.remote-credentials.credentials")(function* (
  identity: Identity,
  options: { readonly fetcher?: FetchLike; readonly now?: () => number } = {},
) {
  const now = options.now ?? Date.now
  const current = now()
  const rotated =
    identity.refreshToken !== undefined && identity.refreshExpiresAt !== undefined && identity.refreshExpiresAt > current
      ? yield* refresh(identity, options.fetcher)
      : yield* challenge(identity, options.fetcher)
  yield* update({ ...identity, refreshToken: rotated.refreshToken, refreshExpiresAt: rotated.refreshExpiresAt })
  return { accessToken: rotated.accessToken, accessExpiresAt: rotated.accessExpiresAt }
})

const challenge = Effect.fnUntraced(function* (identity: Identity, fetcher?: FetchLike) {
  const minted = yield* Effect.tryPromise({
    try: () =>
      post(identity.relayURL, "/api/devices/challenge", fetcher, { deviceID: identity.deviceID }),
    catch: (cause) => authenticationError(cause, "Could not start device authentication with the relay"),
  })
  const challengeID = requireStringField(minted, "challengeID")
  const nonce = requireStringField(minted, "nonce")
  const signature = yield* Effect.tryPromise({
    try: () => signChallenge(identity.privateKey, challengeID, nonce),
    catch: (cause) => new Error("Could not sign the device challenge", { cause }),
  })
  const tokens = yield* Effect.tryPromise({
    try: () =>
      post(identity.relayURL, "/api/devices/token", fetcher, { deviceID: identity.deviceID, challengeID, signature }),
    catch: (cause) => authenticationError(cause, "The relay rejected this device"),
  })
  return requireTokens(tokens)
})

const refresh = Effect.fnUntraced(function* (identity: Identity, fetcher?: FetchLike) {
  const tokens = yield* Effect.tryPromise({
    try: () =>
      post(identity.relayURL, "/api/devices/refresh", fetcher, {
        deviceID: identity.deviceID,
        refreshToken: identity.refreshToken,
      }),
    catch: (cause) => authenticationError(cause, "The relay rejected this device credential"),
  })
  return requireTokens(tokens)
})

function authenticationError(cause: unknown, message: string) {
  if (cause instanceof DeviceAuthorizationError) return cause
  return new Error(message, { cause })
}

async function post(relayURL: string, route: string, fetcher: FetchLike | undefined, body: unknown) {
  const url = new URL(route, withTrailingSlash(relayURL))
  if (url.search !== "") throw new Error("Device credentials are never sent as URL parameters")
  const response = await (fetcher ?? globalThis.fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // A redirect could carry the credential body to another origin.
    redirect: "error",
    body: JSON.stringify(body),
  })
  if (response.status === 401 || response.status === 403 || response.status === 410)
    throw new DeviceAuthorizationError(response.status)
  // Never read or log the response body: it may contain credentials.
  if (!response.ok) throw new Error(`Relay rejected the request with status ${response.status}`)
  return (await response.json()) as unknown
}

function withTrailingSlash(value: string) {
  return value.endsWith("/") ? value : value + "/"
}

function requireTokens(value: unknown): { accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number } {
  if (typeof value !== "object" || value === null) throw new Error("Malformed device credential response")
  const record = value as Record<string, unknown>
  const accessToken = record.accessToken
  const refreshToken = record.refreshToken
  const accessExpiresAt = record.accessExpiresAt
  const refreshExpiresAt = record.refreshExpiresAt
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    typeof accessExpiresAt !== "number" ||
    typeof refreshExpiresAt !== "number"
  )
    throw new Error("Malformed device credential response")
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
}

function requireStringField(value: unknown, field: string) {
  if (typeof value !== "object" || value === null) throw new Error("Malformed relay response")
  const found = (value as Record<string, unknown>)[field]
  if (typeof found !== "string" || found.length === 0) throw new Error(`Malformed relay response: missing ${field}`)
  return found
}
