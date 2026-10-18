export * as McpEventsSecretBox from "./secret-box"

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Context, Effect, Layer, Result } from "effect"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"

const invalidSecret = () => new McpEvents.Failure({ category: "invalid_params", reason: "invalid_secret" })
const unavailable = () => new McpEvents.Failure({ category: "unavailable", reason: "secure_storage_unavailable" })

export function decodeSecret(secret: string): Result.Result<Uint8Array, McpEvents.Failure> {
  if (!secret.startsWith("whsec_")) return Result.fail(invalidSecret())
  const encoded = secret.slice("whsec_".length)
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return Result.fail(invalidSecret())
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64") !== encoded) return Result.fail(invalidSecret())
  return Result.succeed(new Uint8Array(bytes))
}

export interface SecretBox {
  readonly encrypt: (plain: Uint8Array) => string
  readonly decrypt: (ciphertext: string) => Uint8Array | undefined
  readonly fingerprint: (secret: Uint8Array) => string
  readonly encodeCursor: (scope: string, seq: number) => string
  readonly decodeCursor: (scope: string, cursor: string) => number | undefined
}

export function makeSecretBox(key: Uint8Array): SecretBox {
  const mac = (scope: string, seq: number) => createHmac("sha256", key).update(`mcp-events-cursor:${scope}:${seq}`).digest("base64url")
  return {
    encrypt: (plain) => {
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, nonce)
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64")
    },
    decrypt: (ciphertext) => {
      const raw = Buffer.from(ciphertext, "base64")
      if (raw.length <= 28 || raw.toString("base64") !== ciphertext) return undefined
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      const result = Result.try(() => new Uint8Array(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])))
      return Result.isSuccess(result) ? result.success : undefined
    },
    fingerprint: (secret) => createHash("sha256").update(secret).digest("hex").slice(0, 32),
    encodeCursor: (scope, seq) => `cur_${Buffer.from(String(seq)).toString("base64url")}.${mac(scope, seq)}`,
    decodeCursor: (scope, cursor) => {
      if (!cursor.startsWith("cur_")) return undefined
      const parts = cursor.slice(4).split(".")
      if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return undefined
      const seq = Number(Buffer.from(parts[0], "base64url").toString("utf8"))
      if (!Number.isSafeInteger(seq) || seq < 0) return undefined
      const expected = Buffer.from(mac(scope, seq))
      const actual = Buffer.from(parts[1])
      return expected.length === actual.length && timingSafeEqual(expected, actual) ? seq : undefined
    },
  }
}

function loadOrCreateKey(path: string): Uint8Array {
  const dir = dirname(path)
  const existingDir = Result.try(() => lstatSync(dir))
  if (Result.isSuccess(existingDir)) {
    if (!existingDir.success.isDirectory() || existingDir.success.isSymbolicLink()) throw unavailable()
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const created = Result.try(() => openSync(path, "wx", 0o600))
  if (Result.isSuccess(created)) {
    const key = randomBytes(32)
    writeSync(created.success, key)
    fsyncSync(created.success)
    closeSync(created.success)
    return new Uint8Array(key)
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size !== 32) throw unavailable()
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const opened = fstatSync(fd)
  if (!opened.isFile() || opened.size !== 32) {
    closeSync(fd)
    throw unavailable()
  }
  const key = Buffer.alloc(32)
  const read = readSync(fd, key, 0, 32, 0)
  closeSync(fd)
  if (read !== 32) throw unavailable()
  return new Uint8Array(key)
}

export const keyFile = (path: string): Effect.Effect<Uint8Array, McpEvents.Failure> =>
  process.platform === "win32"
    ? Effect.fail(unavailable())
    : Effect.try({ try: () => loadOrCreateKey(path), catch: (error) => (error instanceof McpEvents.Failure ? error : unavailable()) })

export interface Interface {
  readonly get: Effect.Effect<SecretBox, McpEvents.Failure>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/McpEventsSecretBox") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const global = yield* Global.Service
  let cached: SecretBox | undefined
  const get = Effect.suspend(() =>
    cached === undefined
      ? keyFile(join(global.data, "mcp-events.key")).pipe(
          Effect.map((key) => {
            cached = makeSecretBox(key)
            return cached
          }),
        )
      : Effect.succeed(cached),
  )
  return Service.of({ get })
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

export const layerWith = (box: SecretBox) => Layer.succeed(Service, Service.of({ get: Effect.succeed(box) }))
