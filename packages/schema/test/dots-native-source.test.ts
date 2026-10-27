import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Form } from "../src/form.js"
import { SessionEvent } from "../src/session-event.js"

test("native source records exact authority without an MCP principal or credential secret", () => {
  const source = { kind: "dots-native" as const, profile: "synthetic", credentialID: "credential", accountID: "account", accountGeneration: 2, environmentID: "environment", connectionID: "connection", clientID: "client", streamID: "stream", rootSessionID: "ses_root", accessRevision: 3, requestID: "request" }
  const value = Schema.decodeUnknownSync(Form.NativeReplySource)(source)
  expect(Schema.encodeSync(Form.NativeReplySource)(value)).toEqual(source)
  expect(Schema.decodeUnknownSync(Form.ClientReplySource)(source)).toEqual(value)
  expect(Schema.decodeUnknownSync(SessionEvent.DotsDecisionSettled.data)({ sessionID: "ses_root", source, target: { kind: "form", formID: "frm_native", fingerprint: "f".repeat(64) } }).source).toEqual(value)
  for (const key of Object.keys(source)) {
    const missing = { ...source }
    delete missing[key as keyof typeof source]
    expect(() => Schema.decodeUnknownSync(Form.NativeReplySource)(missing)).toThrow()
  }
})
