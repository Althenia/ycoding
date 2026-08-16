import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent, Model, Provider, SessionOrchestration } from "../src/index.js"
import { SessionID } from "../src/session-id.js"

const parentID = SessionID.make("ses_parent")
const sessionID = SessionID.make("ses_child")
const model = Model.Ref.make({
  providerID: Provider.ID.make("openai"),
  id: Model.ID.make("gpt-5.6"),
  variant: Model.VariantID.make("high"),
})

describe("SessionOrchestration", () => {
  test("defines the complete task lifecycle", () => {
    const decode = Schema.decodeUnknownSync(SessionOrchestration.State)
    for (const state of [
      "starting",
      "running",
      "waiting",
      "cancelling",
      "cancelled",
      "completed",
      "failed",
      "lost",
    ] as const) {
      expect(decode(state)).toBe(state)
    }
    expect(() => decode("queued")).toThrow()
  })

  test("bounds progress, questions, and terminal excerpts", () => {
    expect(Schema.is(SessionOrchestration.Progress)({ text: "p".repeat(4096), time: 1 })).toBe(true)
    expect(Schema.is(SessionOrchestration.Progress)({ text: "p".repeat(4097), time: 1 })).toBe(false)
    expect(Schema.is(SessionOrchestration.Progress)({ text: "€".repeat(1365), time: 1 })).toBe(true)
    expect(Schema.is(SessionOrchestration.Progress)({ text: "€".repeat(1366), time: 1 })).toBe(false)
    expect(Schema.is(SessionOrchestration.Question)({ id: "qst_1", text: "q".repeat(8192), time: 1 })).toBe(true)
    expect(Schema.is(SessionOrchestration.Question)({ id: "qst_1", text: "q".repeat(8193), time: 1 })).toBe(false)
    expect(
      Schema.is(SessionOrchestration.Question)({
        id: "qst_1",
        text: "Proceed?",
        data: { value: "x".repeat(8192) },
        time: 1,
      }),
    ).toBe(false)
    expect(Schema.is(SessionOrchestration.TerminalExcerpt)("x".repeat(16 * 1024))).toBe(true)
    expect(Schema.is(SessionOrchestration.TerminalExcerpt)("x".repeat(16 * 1024 + 1))).toBe(false)
  })

  test("bounds every durable orchestration payload by UTF-8 bytes", () => {
    expect(Schema.is(SessionOrchestration.DescriptionText)("d".repeat(4 * 1024))).toBe(true)
    expect(Schema.is(SessionOrchestration.DescriptionText)("d".repeat(4 * 1024 + 1))).toBe(false)
    expect(Schema.is(SessionOrchestration.DescriptionText)("€".repeat(1365))).toBe(true)
    expect(Schema.is(SessionOrchestration.DescriptionText)("€".repeat(1366))).toBe(false)
    expect(Schema.is(SessionOrchestration.ToolCallID)("c".repeat(512))).toBe(true)
    expect(Schema.is(SessionOrchestration.ToolCallID)("c".repeat(513))).toBe(false)
    expect(Schema.is(SessionOrchestration.PromptText)("p".repeat(64 * 1024))).toBe(true)
    expect(Schema.is(SessionOrchestration.PromptText)("p".repeat(64 * 1024 + 1))).toBe(false)
    expect(Schema.is(SessionOrchestration.ControlText)("m".repeat(64 * 1024))).toBe(true)
    expect(Schema.is(SessionOrchestration.ControlText)("m".repeat(64 * 1024 + 1))).toBe(false)
    expect(Schema.is(SessionOrchestration.FailureText)("e".repeat(16 * 1024))).toBe(true)
    expect(Schema.is(SessionOrchestration.FailureText)("e".repeat(16 * 1024 + 1))).toBe(false)
    expect(Schema.is(SessionOrchestration.AnswerData)({ value: "x".repeat(8 * 1024 - 12) })).toBe(true)
    expect(Schema.is(SessionOrchestration.AnswerData)({ value: "x".repeat(8 * 1024) })).toBe(false)

    expect(
      Schema.is(SessionOrchestration.Change)({
        type: "launched",
        parentID,
        parentAssistantMessageID: "msg_parent",
        toolCallID: "c".repeat(513),
        inputID: "msg_input",
        description: "Review",
        agent: "build",
        model,
        promptDigest: "digest",
        background: true,
        delivery: "steer",
      }),
    ).toBe(false)
    expect(
      Schema.is(SessionOrchestration.Change)({ type: "failed", error: "e".repeat(16 * 1024 + 1) }),
    ).toBe(false)
  })

  test("models parent controls and child reports as discriminated unions", () => {
    const control = Schema.decodeUnknownSync(SessionOrchestration.Control)
    expect(control({ action: "list" })).toEqual({ action: "list" })
    expect(control({ action: "send", sessionID, text: "context", delivery: "queue" })).toEqual({
      action: "send",
      sessionID,
      text: "context",
      delivery: "queue",
    })
    expect(
      control({ action: "answer", sessionID, questionID: "qst_1", text: "yes", data: { approved: true } }),
    ).toMatchObject({ action: "answer", questionID: "qst_1" })
    expect(control({ action: "cancel", sessionID })).toMatchObject({ action: "cancel" })
    expect(control({ action: "resume", sessionID })).toMatchObject({ action: "resume" })
    expect(() => control({ action: "send", sessionID, text: "context", delivery: "later" })).toThrow()

    const report = Schema.decodeUnknownSync(SessionOrchestration.Report)
    expect(report({ action: "progress", text: "halfway" })).toEqual({ action: "progress", text: "halfway" })
    expect(report({ action: "question", text: "Proceed?", data: { risk: "low" } })).toMatchObject({
      action: "question",
    })
  })

  test("records foreground detachment as a durable task change", () => {
    expect(Schema.decodeUnknownSync(SessionOrchestration.Change)({ type: "backgrounded" })).toEqual({
      type: "backgrounded",
    })
  })

  test("describes the bounded direct-child TeamView", () => {
    const task = SessionOrchestration.Task.make({
      sessionID,
      parentID,
      description: "Implement projection",
      agent: Agent.ID.make("build"),
      model,
      background: true,
      state: "running",
      revision: 3,
      time: { created: 1, updated: 2 },
    })
    expect(Schema.is(SessionOrchestration.TeamView)({ children: [task], omitted: 0 })).toBe(true)
  })
})
