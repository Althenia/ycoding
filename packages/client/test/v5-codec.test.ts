import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import {
  create,
  encodeStrict,
  decodeStrict,
  Model_RefSchema,
  SessionAutonomySetSchema,
  SessionsQuerySchema,
  PublicEventSchema,
  PublicEvent_catalog_updatedSchema,
  PublicEvent_catalog_updated_metadataEntrySchema,
  ServiceHealthSchema,
  LosslessStringSchema,
  SessionReview_OriginSchema,
  SessionReview_OriginValue3Schema,
} from "@ycoding-ai/protocol/v5"
import { encodeDomain, decodeDomain } from "../src/v5/codec.js"

test("REQ-WIRE-004 preserves lone UTF-16 units, empty strings and explicit profile values", () => {
  const model = { id: "a\ud800b😀", providerID: "", variant: "", profile: "owner\udfff" }
  const encoded = encodeDomain(Model_RefSchema.typeName, model)
  const wire = decodeStrict(Model_RefSchema, encoded)
  expect(wire.id?.encoding.case).toBe("utf16LeUnits")
  expect(wire.providerID?.encoding).toEqual({ case: "utf8", value: "" })
  expect(decodeDomain(Model_RefSchema.typeName, encoded)).toEqual(model)
})

test("REQ-WIRE-004 distinguishes absent, empty, false, zero and explicit clearing", () => {
  for (const value of [
    { goal: null },
    { goal: true },
    { permissions: "manual" },
    { guardrails: "yolo", answers: "auto" },
  ])
    expect(
      decodeDomain(SessionAutonomySetSchema.typeName, encodeDomain(SessionAutonomySetSchema.typeName, value)),
    ).toEqual(value)
  for (const value of [{}, { parentID: null }, { parentID: "" }, { limit: 1, search: "" }])
    expect(decodeDomain(SessionsQuerySchema.typeName, encodeDomain(SessionsQuerySchema.typeName, value))).toEqual(value)
})

test("REQ-WIRE-004 converts typed public events into the existing domain shape", () => {
  const bytes = encodeStrict(
    PublicEventSchema,
    create(PublicEventSchema, {
      kind: {
        case: "catalogUpdated",
        value: create(PublicEvent_catalog_updatedSchema, {
          id: { encoding: { case: "utf8", value: "evt_catalog" } },
          created: 0,
          type: 1,
          metadata: {
            entries: [
              {
                key: { encoding: { case: "utf16LeUnits", value: new Uint8Array([0, 216]) } },
                value: { kind: { case: "number", value: 0.125 } },
              },
            ],
          },
          data: {},
        }),
      },
    }),
  )
  expect(decodeDomain(PublicEventSchema.typeName, bytes)).toEqual({
    id: "evt_catalog",
    created: 0,
    type: "catalog.updated",
    metadata: { "\ud800": 0.125 },
    data: {},
  })
})

test("REQ-WIRE-004 rejects unsafe integer conversion rather than rounding", () => {
  expect(() =>
    encodeDomain(ServiceHealthSchema.typeName, {
      healthy: true,
      version: "v",
      sourceEpoch: "source",
      pid: Number.MAX_SAFE_INTEGER + 1,
    }),
  ).toThrow()
})

test("REQ-WIRE-004/007 string admission uses canonical UTF-16 bytes, not replacement-character UTF-8", () => {
  const value = "\ud800".repeat(30000)
  const bytes = encodeDomain(LosslessStringSchema.typeName, value, 65536)
  expect(bytes.length).toBeLessThan(65536)
  expect(decodeDomain(LosslessStringSchema.typeName, bytes)).toBe(value)
  expect(() => encodeDomain(LosslessStringSchema.typeName, "x".repeat(65536), 65536)).toThrow(
    "Encoded domain byte limit",
  )
})

test("REQ-WIRE-004 duplicate dynamic keys are rejected rather than collapsed", () => {
  const bytes = encodeStrict(
    PublicEventSchema,
    create(PublicEventSchema, {
      kind: {
        case: "catalogUpdated",
        value: create(PublicEvent_catalog_updatedSchema, {
          id: { encoding: { case: "utf8", value: "evt_catalog" } },
          created: 0,
          type: 1,
          metadata: {
            entries: [1, 2].map((value) =>
              create(PublicEvent_catalog_updated_metadataEntrySchema, {
                key: { encoding: { case: "utf8", value: "duplicate" } },
                value: { kind: { case: "number", value } },
              }),
            ),
          },
          data: {},
        }),
      },
    }),
  )
  expect(() => decodeDomain(PublicEventSchema.typeName, bytes)).toThrow("Duplicate domain object key")
})

test("REQ-WIRE-004 review request origins carry the executor marker at tag 2 and never normalize false", () => {
  const name = SessionReview_OriginSchema.typeName
  expect(SessionReview_OriginSchema.fields.map((field) => [field.name, field.number])).toEqual([
    ["value_1", 1],
    ["value_2", 2],
    ["value_3", 3],
  ])
  expect(SessionReview_OriginValue3Schema.fields.map((field) => [field.name, field.number])).toEqual([
    ["requestID", 1],
    ["executor", 2],
  ])
  const wire = (domain: object) => {
    const bytes = encodeDomain(name, domain)
    const raw = decodeStrict(SessionReview_OriginSchema, bytes)
    expect(raw.kind.case).toBe("value3")
    return {
      bytes,
      executor: raw.kind.case === "value3" ? raw.kind.value.executor : "other",
      decoded: decodeDomain(name, bytes),
    }
  }
  const absent = wire({ requestID: "per_review" })
  expect(absent.executor).toBe(false)
  expect(absent.bytes.includes(0x10)).toBe(false)
  expect(absent.decoded).toEqual({ requestID: "per_review" })
  expect(absent.decoded).not.toHaveProperty("executor")
  const marked = wire({ requestID: "per_review", executor: true })
  expect(marked.executor).toBe(true)
  expect(marked.decoded).toEqual({ requestID: "per_review", executor: true })
  expect(Array.from(marked.bytes.subarray(-2))).toEqual([0x10, 0x01])
  expect(marked.bytes.length).toBe(absent.bytes.length + 2)
  const falsy = wire({ requestID: "per_review", executor: false })
  expect(falsy.executor).toBe(false)
  expect(Array.from(falsy.bytes.subarray(-2))).toEqual([0x10, 0x00])
  expect(falsy.decoded).toEqual({ requestID: "per_review", executor: false })
  const canonical: ReadonlyArray<readonly [unknown, SessionReview.Origin]> = [
    [absent.decoded, { requestID: "per_review" }],
    [marked.decoded, { requestID: "per_review", executor: true }],
  ]
  for (const [decoded, expected] of canonical)
    expect(Schema.decodeUnknownSync(SessionReview.Origin)(decoded)).toEqual(expected)
  expect(() => Schema.decodeUnknownSync(SessionReview.Origin)(falsy.decoded)).toThrow()
  expect(() => encodeDomain(name, { requestID: "per_review", executor: "true" })).toThrow()
  expect(() => encodeDomain(name, { requestID: "per_review", extra: true })).toThrow()
  for (const tool of [{ messageID: "msg_a", callID: "call_a" }, { questionID: "qst_a" }])
    expect(decodeDomain(name, encodeDomain(name, tool))).toEqual(tool)
  expect(() => encodeDomain(name, { messageID: "msg_a", callID: "call_a", executor: true })).toThrow()
})
