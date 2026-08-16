import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionMessage } from "@ycoding-ai/schema/session-message"
import { Session } from "@ycoding-ai/schema/session"
import {
  SessionSubagentAnswer,
  SessionSubagentLaunch,
  SessionSubagentListQuery,
  SessionSubagentMessage,
  SubagentCursor,
} from "../src/groups/session.js"

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

test("validates bounded subagent page queries and opaque parent-scoped cursors", async () => {
  const input = {
    parentID: Session.ID.make("ses_parent"),
    anchor: { rank: 0 as const, updated: 2, sessionID: Session.ID.make("ses_child"), direction: "next" as const },
  }
  const cursor = SubagentCursor.make(input)

  expect(await Effect.runPromise(SubagentCursor.parse(cursor))).toEqual(input)
  expect(Schema.decodeUnknownSync(SessionSubagentListQuery)({ limit: "10", cursor })).toEqual({ limit: 10, cursor })
  expect(() => Schema.decodeUnknownSync(SessionSubagentListQuery)({ limit: "0" })).toThrow()
  expect(() => Schema.decodeUnknownSync(SessionSubagentListQuery)({ limit: "11" })).toThrow()
  expect(await Effect.runPromise(Effect.exit(SubagentCursor.parse("not-a-cursor")))).toMatchObject({ _tag: "Failure" })
})
