import { expect, test } from "bun:test"
import path from "node:path"
import {
  PublicEventSchema,
  SessionLogItemSchema,
  session_attachment_upload_Request_payloadSchema,
  create,
  decodeStrict,
  encodeStrict,
  encodeLossless,
  decodeLossless,
  publicEvents,
} from "@ycoding-ai/protocol/v5"

const vectors = (
  await Bun.file(path.resolve(import.meta.dir, "../../../protocol/ycoding/v5/testdata/manifest.tsv")).text()
)
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"))
function vector(name: string) {
  const hex = vectors.find((row) => row[0] === name)?.[4]
  if (hex === undefined) throw new Error(`missing vector: ${name}`)
  return new Uint8Array(Buffer.from(hex, "hex"))
}

test("REQ-WIRE-005 shared public event corpus preserves ephemeral lone UTF16 and reused durable envelopes", () => {
  const delta = decodeStrict(PublicEventSchema, vector("public-text-delta"))
  expect(delta.kind.case).toBe("sessionTextDelta")
  if (delta.kind.case !== "sessionTextDelta") throw new Error("delta branch")
  expect(decodeLossless(delta.kind.value.data!.delta!)).toBe("\ud800")
  expect(delta.kind.value).not.toHaveProperty("durable")
  const durable = decodeStrict(PublicEventSchema, vector("public-durable"))
  expect(durable.kind.case).toBe("sessionRevertCleared")
  if (durable.kind.case !== "sessionRevertCleared") throw new Error("durable branch")
  expect(durable.kind.value.durable?.seq).toBe(1n)
  const log = create(SessionLogItemSchema, { kind: { case: "value50", value: durable.kind.value } })
  expect(decodeStrict(SessionLogItemSchema, encodeStrict(SessionLogItemSchema, log)).kind.case).toBe("value50")
  for (const name of ["public-catalog", "public-text-delta", "public-durable"])
    expect(encodeStrict(PublicEventSchema, decodeStrict(PublicEventSchema, vector(name)))).toEqual(vector(name))
  expect(publicEvents).toHaveLength(115)
  expect(publicEvents.map((event) => event.name)).not.toContain("shell.updated")
  expect(PublicEventSchema.fields.some((field) => field.number === 116)).toBe(false)
  expect(PublicEventSchema.proto.reservedRange.map(({ start, end }) => ({ start, end }))).toContainEqual({
    start: 116,
    end: 117,
  })
  expect(PublicEventSchema.proto.reservedName).toContain("shell_updated")
  expect(() => decodeStrict(PublicEventSchema, vector("public-event-empty"))).toThrow("required presence")
  expect(() => decodeStrict(PublicEventSchema, vector("public-event-duplicate"))).toThrow("duplicate oneof")
})

test("REQ-WIRE-012 upload raw bytes preserve arbitrary octets, ordered offsets and byte-count bounds", () => {
  const bytes = vector("upload-raw")
  const decoded = decodeStrict(session_attachment_upload_Request_payloadSchema, bytes)
  expect(decoded.data).toEqual(new Uint8Array([0, 255]))
  expect(decoded.index).toBe(0n)
  expect(decoded.offset).toBe(0n)
  expect(decoded.last).toBe(true)
  expect(encodeStrict(session_attachment_upload_Request_payloadSchema, decoded)).toEqual(bytes)
  for (const length of [0, 1, 21000, 21001]) {
    const value = create(session_attachment_upload_Request_payloadSchema, {
      uploadID: encodeLossless("00000000-0000-4000-8000-000000000001"),
      index: 0n,
      last: true,
      data: new Uint8Array(length),
      offset: 0n,
    })
    if (length > 0 && length <= 21000)
      expect(() => encodeStrict(session_attachment_upload_Request_payloadSchema, value)).not.toThrow()
    else expect(() => encodeStrict(session_attachment_upload_Request_payloadSchema, value)).toThrow("count constraint")
  }
  expect(() => decodeStrict(session_attachment_upload_Request_payloadSchema, vector("upload-empty"))).toThrow(
    "count constraint",
  )
})
