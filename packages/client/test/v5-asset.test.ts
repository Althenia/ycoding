import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  encodeLossless,
  session_attachment_read_ResultSchema,
  fs_read_ResultSchema,
  TypedPayloadSchema,
} from "@ycoding-ai/protocol/v5"
import { assetResult } from "../src/v5/asset.js"

test.each([new Uint8Array(), new Uint8Array([0, 255, 128, 1])])(
  "REQ-WIRE-012 adapts terminal raw attachment bytes without a wire base64 tunnel",
  (data) => {
    const result = create(TypedPayloadSchema, {
      typeName: session_attachment_read_ResultSchema.typeName,
      payload: encodeStrict(
        session_attachment_read_ResultSchema,
        create(session_attachment_read_ResultSchema, {
          data: { mime: encodeLossless("application/octet-stream"), bytes: BigInt(data.length) },
        }),
      ),
    })
    expect(assetResult({ data, result }, "session.attachment.read")).toEqual({
      mime: "application/octet-stream",
      bytes: data.length,
      data: data.length ? "AP+AAQ==" : "",
    })
  },
)

test("REQ-WIRE-012 file asset consumption returns the exact bytes", () => {
  const data = new Uint8Array([0, 255])
  const result = create(TypedPayloadSchema, {
    typeName: fs_read_ResultSchema.typeName,
    payload: encodeStrict(
      fs_read_ResultSchema,
      create(fs_read_ResultSchema, { data: { mime: encodeLossless("application/octet-stream"), byteCount: 2n } }),
    ),
  })
  expect(assetResult({ data, result }, "fs.read")).toBe(data)
})

test("REQ-WIRE-012 no terminal asset metadata means unsupported, not fabricated success", () => {
  expect(() => assetResult({ data: new Uint8Array([1]) }, "session.attachment.read")).toThrow(
    "Asset metadata is unsupported until contract",
  )
})

test("REQ-WIRE-012 terminal metadata and raw-byte length must agree", () => {
  const result = create(TypedPayloadSchema, {
    typeName: session_attachment_read_ResultSchema.typeName,
    payload: encodeStrict(
      session_attachment_read_ResultSchema,
      create(session_attachment_read_ResultSchema, {
        data: { mime: encodeLossless("application/octet-stream"), bytes: 2n },
      }),
    ),
  })
  expect(() => assetResult({ data: new Uint8Array([1]), result }, "session.attachment.read")).toThrow(
    "Asset metadata does not match content",
  )
})
