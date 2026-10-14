import { expect, test } from "bun:test"
import {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  session_family_activity_RequestSchema,
} from "../src/v5/index.js"
import { messages } from "../src/generated/v5/contract.js"

test("root-only family activity round-trips an explicitly present empty member list", () => {
  const request = create(session_family_activity_RequestSchema, { payload: { sessionIDs: { items: [] } } })
  const bytes = encodeStrict(session_family_activity_RequestSchema, request)
  expect(bytes).toEqual(new Uint8Array([10, 2, 10, 0]))
  const decoded = decodeStrict(session_family_activity_RequestSchema, bytes)
  expect(decoded.payload?.sessionIDs?.items).toEqual([])
  expect(encodeStrict(session_family_activity_RequestSchema, decoded)).toEqual(bytes)
  expect(() => decodeStrict(session_family_activity_RequestSchema, new Uint8Array([10, 0]))).toThrow(
    "required presence",
  )
})

test("family activity retains member text bounds and its structural maximum", () => {
  expect(messages["ycoding.v5.session_family_activity_Request_payload_sessionIDs"].fields[0].constraints).toEqual({
    domainObligations: ["packages/remote/src/index.ts#validOperationInput"],
    utf16Min: 1,
    utf16Max: 128,
    countMin: 0,
    countMax: 128,
  })
  const request = create(session_family_activity_RequestSchema, {
    payload: { sessionIDs: { items: Array.from({ length: 128 }, (_, index) => encodeLossless(`ses_${index}`)) } },
  })
  expect(() => encodeStrict(session_family_activity_RequestSchema, request)).not.toThrow()
  request.payload!.sessionIDs!.items.push(encodeLossless("ses_extra"))
  expect(() => encodeStrict(session_family_activity_RequestSchema, request)).toThrow("collection limit")
  for (const invalid of ["", "s".repeat(129)]) {
    request.payload!.sessionIDs!.items = [encodeLossless(invalid)]
    expect(() => encodeStrict(session_family_activity_RequestSchema, request)).toThrow("text constraint")
  }
})
