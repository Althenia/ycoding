import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  session_prompt_Request_payloadSchema,
  SessionPending_UserSchema,
  SessionAutonomySetValue1_goalSchema,
  session_daybreak_set_Request_payloadSchema,
  InstructionEntryValueTooLargeErrorSchema,
  Form_FieldsSchema,
  FileDiff_InfoSchema,
} from "@ycoding-ai/protocol/v5"

test("Rust/TS prompt presence preserves false, empty collections and lone UTF16 metadata keys", () => {
  const bytes = new Uint8Array(Buffer.from("12020a001a0022002a0c0a0a0a04120200d8120210003800", "hex"))
  const value = create(session_prompt_Request_payloadSchema, {
    text: encodeLossless(""),
    files: { items: [] },
    agents: { items: [] },
    resume: false,
    metadata: { entries: [{ key: encodeLossless("\ud800"), value: { kind: { case: "boolean", value: false } } }] },
  })
  expect(encodeStrict(session_prompt_Request_payloadSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(session_prompt_Request_payloadSchema, bytes)
  expect(decoded.id).toBeUndefined()
  expect(decoded.resume).toBe(false)
  expect(decoded.files?.items).toEqual([])
  expect(decoded.agents?.items).toEqual([])
  expect(decodeLossless(decoded.metadata!.entries[0]!.key!)).toBe("\ud800")
  expect(encodeStrict(session_prompt_Request_payloadSchema, decoded)).toEqual(bytes)
  expect(() => decodeStrict(session_prompt_Request_payloadSchema, bytes.subarray(4))).toThrow("required presence")
})

test("Rust/TS admission records preserve safe sequences and finite millisecond timestamps", () => {
  const bytes = new Uint8Array(
    Buffer.from("08ffffffffffffff0f12020a001a020a0021000000000000e0bf280132040a020a003801", "hex"),
  )
  const value = create(SessionPending_UserSchema, {
    admittedSeq: 9007199254740991n,
    id: encodeLossless(""),
    sessionID: encodeLossless(""),
    timeCreated: -0.5,
    type: 1,
    data: { text: encodeLossless("") },
    delivery: 1,
  })
  expect(encodeStrict(SessionPending_UserSchema, value)).toEqual(bytes)
  const decoded = decodeStrict(SessionPending_UserSchema, bytes)
  expect(decoded.admittedSeq).toBe(9007199254740991n)
  expect(decoded.timeCreated).toBe(-0.5)
  expect(encodeStrict(SessionPending_UserSchema, decoded)).toEqual(bytes)
  expect(() =>
    encodeStrict(
      SessionPending_UserSchema,
      create(SessionPending_UserSchema, { ...value, admittedSeq: 9007199254740992n }),
    ),
  ).toThrow("integer constraint")
})

test("Rust/TS goal resume, text and clear branches are distinct and daybreak clearing is required", () => {
  for (const [hex, kind] of [
    ["0a04120200d8", { case: "value1", value: encodeLossless("\ud800") }],
    ["1001", { case: "value2", value: true }],
    ["1a00", { case: "clear", value: {} }],
  ] as const) {
    const bytes = new Uint8Array(Buffer.from(hex, "hex"))
    expect(
      encodeStrict(SessionAutonomySetValue1_goalSchema, create(SessionAutonomySetValue1_goalSchema, { kind })),
    ).toEqual(bytes)
    expect(
      encodeStrict(SessionAutonomySetValue1_goalSchema, decodeStrict(SessionAutonomySetValue1_goalSchema, bytes)),
    ).toEqual(bytes)
  }
  const clear = new Uint8Array([10, 2, 18, 0])
  expect(
    encodeStrict(
      session_daybreak_set_Request_payloadSchema,
      create(session_daybreak_set_Request_payloadSchema, { daybreak: { kind: { case: "clear", value: {} } } }),
    ),
  ).toEqual(clear)
  expect(() => decodeStrict(session_daybreak_set_Request_payloadSchema, new Uint8Array())).toThrow("required presence")
  expect(() => decodeStrict(SessionAutonomySetValue1_goalSchema, new Uint8Array([16, 1, 26, 0]))).toThrow(
    "duplicate oneof",
  )
})

test("Rust/TS typed instruction errors preserve signed int64 fields and empty message presence", () => {
  const bytes = new Uint8Array(Buffer.from("080110ffffffffffffffffff0118804022020a00", "hex"))
  const value = create(InstructionEntryValueTooLargeErrorSchema, {
    Tag: 1,
    actualBytes: -1n,
    maxBytes: 8192n,
    message: encodeLossless(""),
  })
  expect(encodeStrict(InstructionEntryValueTooLargeErrorSchema, value)).toEqual(bytes)
  expect(decodeStrict(InstructionEntryValueTooLargeErrorSchema, bytes).actualBytes).toBe(-1n)
  expect(
    encodeStrict(
      InstructionEntryValueTooLargeErrorSchema,
      decodeStrict(InstructionEntryValueTooLargeErrorSchema, bytes),
    ),
  ).toEqual(bytes)
  expect(() =>
    encodeStrict(
      InstructionEntryValueTooLargeErrorSchema,
      create(InstructionEntryValueTooLargeErrorSchema, { ...value, actualBytes: -9007199254740992n }),
    ),
  ).toThrow("integer constraint")
})

test("Rust/TS nonempty Forms and relocated file diffs preserve structural bounds and bytes", () => {
  const field = new Uint8Array(Buffer.from("0a0922070a030a016b3001", "hex"))
  expect(
    encodeStrict(
      Form_FieldsSchema,
      create(Form_FieldsSchema, {
        items: [{ kind: { case: "value4", value: { key: encodeLossless("k"), type: 1 } } }],
      }),
    ),
  ).toEqual(field)
  expect(encodeStrict(Form_FieldsSchema, decodeStrict(Form_FieldsSchema, field))).toEqual(field)
  expect(() => decodeStrict(Form_FieldsSchema, new Uint8Array())).toThrow("count constraint")
  const bytes = new Uint8Array(Buffer.from("0a04120200d812020a00180020012801", "hex"))
  const value = create(FileDiff_InfoSchema, {
    file: encodeLossless("\ud800"),
    patch: encodeLossless(""),
    additions: 0n,
    deletions: 1n,
    status: 1,
  })
  expect(encodeStrict(FileDiff_InfoSchema, value)).toEqual(bytes)
  expect(encodeStrict(FileDiff_InfoSchema, decodeStrict(FileDiff_InfoSchema, bytes))).toEqual(bytes)
})
