import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Dots } from "../src/dots.js"
import { SessionEvent } from "../src/session-event.js"

const envelope = {
  coordinator: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" },
  scope: { epoch: "epoch_fixture", grantID: "grant_fixture" },
  exchangeID: "exchange_fixture",
  messageID: "msg_reply_fixture",
  replyToMessageID: "msg_input_fixture",
  sourceSessionID: "ses_target_fixture",
  kind: "progress",
  origin: "agent",
}

test("Dots report state contracts retain canonical report and tool-call identity", () => {
  const value = { sessionID: "ses_target_fixture", callID: "call_fixture", deliveryID: "dots_report_fixture", messageID: "msg_reply_fixture", text: "Synthetic progress", envelope }
  const actual: unknown = Schema.decodeUnknownSync(SessionEvent.DotsReportRecorded.data)(value, { onExcessProperty: "error" })
  expect(actual).toEqual(value)
  expect(() => Schema.decodeUnknownSync(SessionEvent.DotsReportRecorded.data)({ ...value, envelope: { ...envelope, origin: "human" } })).toThrow()
})

test("Dots report state contracts distinguish enabled tool context from explicit disabled context", () => {
  const task = { coordinator: envelope.coordinator, scope: envelope.scope, exchangeID: envelope.exchangeID, messageID: envelope.replyToMessageID, targetSessionID: envelope.sourceSessionID, kind: "task", origin: "plugin" }
  const enabled = { state: "enabled", generation: 1, tool: "dots_report", envelope: task }
  const disabled = { state: "disabled", generation: 2, reason: "capability_disabled" }
  for (const dots of [enabled, disabled]) {
    const value = { sessionID: "ses_target_fixture", source: "dots", text: "Synthetic Dots state", dots }
    const actual: unknown = Schema.decodeUnknownSync(SessionEvent.ContextObserved.data)(value, { onExcessProperty: "error" })
    expect(actual).toEqual(value)
  }
  expect(() => Schema.decodeUnknownSync(Dots.CoordinationContext)({ ...enabled, tool: "invented_report" })).toThrow()
  expect(() => Schema.decodeUnknownSync(Dots.CoordinationContext)({ ...enabled, generation: -1 })).toThrow()
  expect(() => Schema.decodeUnknownSync(Dots.CoordinationContext)({ state: "enabled", generation: 1 })).toThrow()
})
