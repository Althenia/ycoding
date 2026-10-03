import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Base64 } from "../src/prompt.js"

describe("Prompt.Base64", () => {
  test.each(["", "AA==", "AAA=", "AAAA", "////", "++//", "AAAAAA==", "AAAAAAA="])(
    "accepts valid Base64 structure %s",
    (value) => expect(Schema.is(Base64)(value)).toBe(true),
  )

  test.each(["A", "AA", "AAA", "AAAAA", "=", "==", "====", "AA=", "A===", "AA==AAAA", "AAA===", "AA$=", "AAA\nA"])(
    "rejects invalid Base64 structure %s",
    (value) => expect(Schema.is(Base64)(value)).toBe(false),
  )

  test.each([8 * 1024 * 1024, 8 * 1024 * 1024 + 1, 20 * 1024 * 1024])(
    "accepts a valid %i-byte payload before image resizing",
    (bytes) => {
      const encoded = Buffer.alloc(bytes, 255).toString("base64")
      expect(Schema.is(Base64)(encoded)).toBe(true)
      expect(Schema.decodeUnknownSync(Base64)(encoded)).toBe(encoded)
      expect(Schema.encodeSync(Base64)(encoded)).toBe(encoded)
    },
  )

  test("rejects a malformed suffix on a large payload", () => {
    const encoded = Buffer.alloc(8 * 1024 * 1024, 255).toString("base64")
    expect(Schema.is(Base64)(encoded.slice(0, -1) + "$")).toBe(false)
  })
})
