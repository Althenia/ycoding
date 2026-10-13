import { expect, test } from "bun:test"
import {
  create,
  decodeStrict,
  encodeStrict,
  encodeLossless,
  decodeLossless,
  Model_RefSchema,
  Provider_RequestSchema,
  Permission_RuleSchema,
  Integration_Attempt_timeSchema,
  ArtifactBadRequestSchema,
  model_default_Result_dataSchema,
  ProjectArtifact_ApiExpectationSchema,
} from "@ycoding-ai/protocol/v5"

test("Rust/TS model reference corpus preserves optional-empty and lone UTF16 identifiers", () => {
  const bytes = new Uint8Array(Buffer.from("0a020a001204120200d81a020a00", "hex"))
  const value = create(Model_RefSchema, {
    id: encodeLossless(""),
    providerID: encodeLossless("\ud800"),
    variant: encodeLossless(""),
  })
  expect(encodeStrict(Model_RefSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(Model_RefSchema, bytes)
  expect(decodeLossless(decoded.providerID!)).toBe("\ud800")
  expect(decodeLossless(decoded.variant!)).toBe("")
  expect(decoded.profile).toBeUndefined()
  expect(encodeStrict(Model_RefSchema, decoded)).toEqual(bytes)
})

test("Rust/TS provider request corpus distinguishes required empty maps from absence", () => {
  const bytes = new Uint8Array(Buffer.from("0a0012001a00", "hex"))
  const value = create(Provider_RequestSchema, {
    settings: { entries: [] },
    headers: { entries: [] },
    body: { entries: [] },
  })
  expect(encodeStrict(Provider_RequestSchema, value)).toEqual(bytes)
  expect(encodeStrict(Provider_RequestSchema, decodeStrict(Provider_RequestSchema, bytes))).toEqual(bytes)
  expect(() => decodeStrict(Provider_RequestSchema, bytes.subarray(0, 4))).toThrow("required")
})

test("Rust/TS permission and typed-error corpus uses closed enum values", () => {
  const permission = new Uint8Array(Buffer.from("0a030a012a12020a001801", "hex"))
  expect(
    encodeStrict(
      Permission_RuleSchema,
      create(Permission_RuleSchema, { action: encodeLossless("*"), resource: encodeLossless(""), effect: 1 }),
    ),
  ).toEqual(permission)
  expect(encodeStrict(Permission_RuleSchema, decodeStrict(Permission_RuleSchema, permission))).toEqual(permission)
  const error = new Uint8Array(Buffer.from("08011001", "hex"))
  expect(encodeStrict(ArtifactBadRequestSchema, decodeStrict(ArtifactBadRequestSchema, error))).toEqual(error)
  expect(() => decodeStrict(ArtifactBadRequestSchema, new Uint8Array([8, 1, 16, 99]))).toThrow("enum")
})

test("Rust/TS attempt-time corpus preserves signed fractional milliseconds", () => {
  const bytes = new Uint8Array(Buffer.from("09000000000000e0bf11000000000000e03f", "hex"))
  expect(
    encodeStrict(
      Integration_Attempt_timeSchema,
      create(Integration_Attempt_timeSchema, { created: -0.5, expires: 0.5 }),
    ),
  ).toEqual(bytes)
  const decoded = decodeStrict(Integration_Attempt_timeSchema, bytes)
  expect(decoded.created).toBe(-0.5)
  expect(decoded.expires).toBe(0.5)
  expect(encodeStrict(Integration_Attempt_timeSchema, decoded)).toEqual(bytes)
})

test("Rust/TS undefined-result corpus requires an explicit none branch", () => {
  const bytes = new Uint8Array([18, 0])
  const value = create(model_default_Result_dataSchema, { kind: { case: "none", value: {} } })
  expect(encodeStrict(model_default_Result_dataSchema, value)).toEqual(bytes)
  expect(decodeStrict(model_default_Result_dataSchema, bytes).kind.case).toBe("none")
  expect(() => decodeStrict(model_default_Result_dataSchema, new Uint8Array())).toThrow("required")
})

test("Rust/TS artifact revision corpus preserves safe uint64 integers and rejects the first unsafe value", () => {
  const bytes = new Uint8Array(Buffer.from("08ffffffffffffff0f12070a057061765f781a420a40" + "61".repeat(64), "hex"))
  const value = create(ProjectArtifact_ApiExpectationSchema, {
    expectedRevision: 9007199254740991n,
    expectedVersionID: encodeLossless("pav_x"),
    expectedDigest: encodeLossless("a".repeat(64)),
  })
  expect(encodeStrict(ProjectArtifact_ApiExpectationSchema, value)).toEqual(bytes)
  expect(decodeStrict(ProjectArtifact_ApiExpectationSchema, bytes).expectedRevision).toBe(9007199254740991n)
  expect(() =>
    encodeStrict(
      ProjectArtifact_ApiExpectationSchema,
      create(ProjectArtifact_ApiExpectationSchema, { ...value, expectedRevision: 9007199254740992n }),
    ),
  ).toThrow("integer constraint")
})
