import { expect, test } from "bun:test"
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
  for (const value of [{ goal: null, yolo: 0 }, { goal: true, yolo: 2 }, { yolo: 1 }])
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
