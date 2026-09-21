import type { RemotePublicKey } from "../../../../packages/remote/src/index"

/** Unpadded base64url, matching the wire contract in `packages/remote`. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function base64UrlDecode(value: string): Uint8Array | undefined {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return undefined
  }
}

/** Opaque credential material. Stored as a hash, never in plaintext. */
export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)))
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
}

/** Length-independent comparison for state, nonce, and code values. */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  const masked = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  let difference = 0
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return masked === 0 && difference === 0
}

/** Verifies a raw 64-byte `r || s` ECDSA P-256 / SHA-256 device signature. */
export async function verifyP256Signature(
  publicKey: RemotePublicKey,
  payload: string,
  signature: string,
): Promise<boolean> {
  const bytes = base64UrlDecode(signature)
  if (bytes?.byteLength !== 64) return false
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, new TextEncoder().encode(payload))
  } catch {
    return false
  }
}

/** Verifies RS256 with an RSA JWK from a JWKS document. */
export async function verifyRs256(
  publicKeyJwk: JsonWebKey,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKeyJwk.kty !== "RSA" || typeof publicKeyJwk.n !== "string" || typeof publicKeyJwk.e !== "string") return false
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: publicKeyJwk.n, e: publicKeyJwk.e, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(signingInput))
  } catch {
    return false
  }
}

export type DecodedJwt = {
  readonly header: Record<string, unknown>
  readonly payload: Record<string, unknown>
  readonly signingInput: string
  readonly signature: Uint8Array
}

/** Splits a compact JWS. Validation is the caller's responsibility. */
export function decodeJwt(token: string): DecodedJwt | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const [header, payload, signature] = parts
  if (header === undefined || payload === undefined || signature === undefined) return undefined
  const headerBytes = base64UrlDecode(header)
  const payloadBytes = base64UrlDecode(payload)
  const signatureBytes = base64UrlDecode(signature)
  if (!headerBytes || !payloadBytes || !signatureBytes) return undefined
  const parsedHeader = parseJsonObject(headerBytes)
  const parsedPayload = parseJsonObject(payloadBytes)
  if (!parsedHeader || !parsedPayload) return undefined
  return { header: parsedHeader, payload: parsedPayload, signingInput: `${header}.${payload}`, signature: signatureBytes }
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
