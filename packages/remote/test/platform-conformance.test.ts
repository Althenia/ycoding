import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  browser_open_Request_payloadSchema,
  pty_create_Request_payloadSchema,
  Shell_Info_metadataSchema,
  ForbiddenErrorSchema,
  Platform_AssetMetadataSchema,
  Pty_SizeSchema,
} from "@ycoding-ai/protocol/v5"

test("Rust/TS browser fences retain safe uint64 values and lone UTF16 text", () => {
  const bytes = new Uint8Array(Buffer.from("08ffffffffffffff0f1204120200d81a030a0163", "hex"))
  const value = create(browser_open_Request_payloadSchema, {
    generation: 9007199254740991n,
    url: encodeLossless("\ud800"),
    callID: encodeLossless("c"),
  })
  expect(encodeStrict(browser_open_Request_payloadSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(browser_open_Request_payloadSchema, bytes)
  expect(decoded.generation).toBe(9007199254740991n)
  expect(decodeLossless(decoded.url!)).toBe("\ud800")
  expect(encodeStrict(browser_open_Request_payloadSchema, decoded)).toEqual(bytes)
  expect(() =>
    encodeStrict(
      browser_open_Request_payloadSchema,
      create(browser_open_Request_payloadSchema, { ...value, generation: 9007199254740992n }),
    ),
  ).toThrow("integer constraint")
})

test("Rust/TS PTY input retains optional empty collections rather than absent fields", () => {
  const bytes = new Uint8Array(Buffer.from("0a070a057365735f781a003200", "hex"))
  const value = create(pty_create_Request_payloadSchema, {
    sessionID: encodeLossless("ses_x"),
    args: { items: [] },
    env: { entries: [] },
  })
  expect(encodeStrict(pty_create_Request_payloadSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(pty_create_Request_payloadSchema, bytes)
  expect(decoded.args?.items).toEqual([])
  expect(decoded.env?.entries).toEqual([])
  expect(decoded.command).toBeUndefined()
  expect(encodeStrict(pty_create_Request_payloadSchema, decoded)).toEqual(bytes)
  expect(() => decodeStrict(pty_create_Request_payloadSchema, new Uint8Array())).toThrow("required presence")
})

test("Rust/TS open shell metadata preserves lone UTF16 keys and fractional values", () => {
  const bytes = new Uint8Array(Buffer.from("0a110a04120200d8120919000000000000e0bf", "hex"))
  const value = create(Shell_Info_metadataSchema, {
    entries: [{ key: encodeLossless("\ud800"), value: { kind: { case: "number", value: -0.5 } } }],
  })
  expect(encodeStrict(Shell_Info_metadataSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(Shell_Info_metadataSchema, bytes)
  expect(decodeLossless(decoded.entries[0]!.key!)).toBe("\ud800")
  expect(decoded.entries[0]!.value?.kind).toEqual({ case: "number", value: -0.5 })
  expect(encodeStrict(Shell_Info_metadataSchema, decoded)).toEqual(bytes)
})

test("Rust/TS typed errors preserve closed tags and empty message presence", () => {
  const bytes = new Uint8Array(Buffer.from("080112020a00", "hex"))
  const value = create(ForbiddenErrorSchema, { Tag: 1, message: encodeLossless("") })
  expect(encodeStrict(ForbiddenErrorSchema, value)).toEqual(bytes)
  expect(encodeStrict(ForbiddenErrorSchema, decodeStrict(ForbiddenErrorSchema, bytes))).toEqual(bytes)
  expect(() => decodeStrict(ForbiddenErrorSchema, new Uint8Array([8, 99, 18, 2, 10, 0]))).toThrow("enum")
})

test("Rust/TS asset metadata and PTY size bounds preserve exact byte counts", () => {
  const bytes = new Uint8Array(Buffer.from("0a020a001000", "hex"))
  const value = create(Platform_AssetMetadataSchema, { mime: encodeLossless(""), byteCount: 0n })
  expect(encodeStrict(Platform_AssetMetadataSchema, value)).toEqual(bytes)
  expect(encodeStrict(Platform_AssetMetadataSchema, decodeStrict(Platform_AssetMetadataSchema, bytes))).toEqual(bytes)
  const size = new Uint8Array(Buffer.from("08c80110f403", "hex"))
  expect(encodeStrict(Pty_SizeSchema, create(Pty_SizeSchema, { rows: 200n, cols: 500n }))).toEqual(size)
  expect(encodeStrict(Pty_SizeSchema, decodeStrict(Pty_SizeSchema, size))).toEqual(size)
  expect(() => encodeStrict(Pty_SizeSchema, create(Pty_SizeSchema, { rows: 201n, cols: 500n }))).toThrow(
    "integer constraint",
  )
})
