import { describe, expect, test } from "bun:test"
import { base64UrlDecode, base64UrlEncode, constantTimeEqual, decodeJwt, randomToken, sha256Hex, verifyP256Signature } from "../src/auth/crypto"

describe("base64url", () => {
  test("round-trips bytes without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = base64UrlEncode(bytes)
    expect(encoded).not.toContain("=")
    expect(encoded).not.toContain("+")
    expect(encoded).not.toContain("/")
    expect(base64UrlDecode(encoded)).toEqual(bytes)
  })

  test("rejects non-base64url input", () => {
    expect(base64UrlDecode("not+base64url")).toBeUndefined()
    expect(base64UrlDecode("has=padding")).toBeUndefined()
    expect(base64UrlDecode("")).toBeUndefined()
  })

  test("produces 32-byte P-256 coordinates", () => {
    const coordinate = base64UrlEncode(new Uint8Array(32).fill(7))
    expect(coordinate).toHaveLength(43)
  })
})

describe("random tokens and digests", () => {
  test("generates distinct 32-byte tokens", () => {
    const first = randomToken()
    const second = randomToken()
    expect(first).toHaveLength(43)
    expect(first).not.toBe(second)
    expect(base64UrlDecode(first)).toHaveLength(32)
  })

  test("hashes with SHA-256 hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("compares secrets in constant time", () => {
    expect(constantTimeEqual("same-value", "same-value")).toBe(true)
    expect(constantTimeEqual("same-value", "same-valuf")).toBe(false)
    expect(constantTimeEqual("short", "much-longer-value")).toBe(false)
    expect(constantTimeEqual("", "")).toBe(true)
  })
})

describe("device challenge signatures", () => {
  test("verifies a P-256 signature and rejects tampering", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey)
    const jwk = { kty: "EC" as const, crv: "P-256" as const, x: publicKey.x ?? "", y: publicKey.y ?? "" }
    const payload = "ycoding-device-v1\nchl_1\nnonce"
    const signature = base64UrlEncode(
      new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))),
    )

    expect(await verifyP256Signature(jwk, payload, signature)).toBe(true)
    expect(await verifyP256Signature(jwk, `${payload} `, signature)).toBe(false)

    const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
    const otherPublic = await crypto.subtle.exportKey("jwk", other.publicKey)
    expect(
      await verifyP256Signature({ kty: "EC", crv: "P-256", x: otherPublic.x ?? "", y: otherPublic.y ?? "" }, payload, signature),
    ).toBe(false)

    const shaved = base64UrlEncode(new Uint8Array(63))
    expect(await verifyP256Signature(jwk, payload, shaved)).toBe(false)
    expect(await verifyP256Signature(jwk, payload, "not base64url")).toBe(false)
  })
})

describe("jwt decoding", () => {
  test("splits a compact token without validating it", () => {
    const header = base64UrlEncode(new TextEncoder().encode('{"alg":"RS256","kid":"k1"}'))
    const payload = base64UrlEncode(new TextEncoder().encode('{"sub":"123"}'))
    const decoded = decodeJwt(`${header}.${payload}.c2ln`)
    expect(decoded?.header).toEqual({ alg: "RS256", kid: "k1" })
    expect(decoded?.payload).toEqual({ sub: "123" })
    expect(decoded?.signingInput).toBe(`${header}.${payload}`)
    expect(decoded?.signature).toEqual(new Uint8Array([0x73, 0x69, 0x67]))
  })

  test("rejects malformed tokens", () => {
    expect(decodeJwt("two.parts")).toBeUndefined()
    expect(decodeJwt("a.b.c.d")).toBeUndefined()
    expect(decodeJwt("!!!.@@@.c2ln")).toBeUndefined()
    expect(decodeJwt("a.b.c2ln")).toBeUndefined()
  })
})
