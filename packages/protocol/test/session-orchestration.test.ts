import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { SessionSubagentAnswer, SessionSubagentLaunch, SessionSubagentMessage } from "../src/groups/session.js"

test("validates Session subagent launch and control payloads", () => {
  const messageID = SessionMessage.ID.make("msg_control")
  expect(
    Schema.decodeUnknownSync(SessionSubagentLaunch)({
      parentAssistantMessageID: "msg_parent",
      toolCallID: "call_1",
      agent: "reviewer",
      description: "Review implementation",
      prompt: "Review the changed files",
      background: true,
      model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
    }),
  ).toMatchObject({ agent: "reviewer", model: { variant: "high" } })
  expect(
    Schema.decodeUnknownSync(SessionSubagentMessage)({
      messageID,
      text: "Use this context",
      delivery: "queue",
    }),
  ).toEqual({ messageID, text: "Use this context", delivery: "queue" })
  expect(Schema.decodeUnknownSync(SessionSubagentAnswer)({ text: "Proceed", data: { approved: true } })).toEqual({
    text: "Proceed",
    data: { approved: true },
  })
  expect(() =>
    Schema.decodeUnknownSync(SessionSubagentMessage)({ messageID, text: "later", delivery: "later" }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SessionSubagentLaunch)({
      parentAssistantMessageID: "msg_parent",
      toolCallID: "c".repeat(513),
      agent: "reviewer",
      description: "Review implementation",
      prompt: "Review the changed files",
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SessionSubagentLaunch)({
      parentAssistantMessageID: "msg_parent",
      toolCallID: "call_1",
      agent: "reviewer",
      description: "d".repeat(4 * 1024 + 1),
      prompt: "Review the changed files",
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SessionSubagentMessage)({
      messageID,
      text: "m".repeat(64 * 1024 + 1),
      delivery: "steer",
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SessionSubagentAnswer)({ data: { value: "x".repeat(8 * 1024) } }),
  ).toThrow()
})
