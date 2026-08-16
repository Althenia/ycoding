import { expect, test } from "bun:test"
import { Schema } from "effect"
import { isYCodingEvent, YCodingEvent } from "../src/groups/event.js"

test("classifies public events by type", () => {
  expect(isYCodingEvent({ type: "server.connected" })).toBe(true)
  expect(isYCodingEvent({ type: "mcp.status.changed" })).toBe(true)
  expect(isYCodingEvent({ type: "mcp.resources.changed" })).toBe(true)
  expect(isYCodingEvent({ type: "mcp.tools.changed" })).toBe(false)
})

test("decodes the current durable session creation event", () => {
  const event = Schema.decodeUnknownSync(YCodingEvent)({
    id: "evt_created",
    created: 1,
    type: "session.created",
    durable: { aggregateID: "ses_current", seq: 0, version: 2 },
    data: {
      sessionID: "ses_current",
      projectID: "project",
      location: { directory: "/project" },
      title: "Current session",
      created: 1,
    },
  })

  expect(event.type).toBe("session.created")
  if (event.type !== "session.created") throw new Error("Expected session.created")
  expect(Number(event.durable.version)).toBe(2)
  expect(event.data).not.toHaveProperty("slug")
})

test("public step events preserve provider cache telemetry and omit the legacy cache mechanism", () => {
  const event = Schema.decodeUnknownSync(YCodingEvent)({
    id: "evt_test",
    created: 0,
    type: "session.step.ended",
    durable: { aggregateID: "ses_test", seq: 1, version: 1 },
    data: {
      sessionID: "ses_test",
      assistantMessageID: "msg_test",
      finish: "stop",
      cost: 0,
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 0 } },
      cacheMechanism: "openai-prompt-cache",
      providerCache: {
        mechanism: "openai-prefix-cache",
        readReported: true,
        writeReported: false,
      },
    },
  })

  expect(event.data).not.toHaveProperty("cacheMechanism")
  expect(event.data).toMatchObject({
    providerCache: {
      mechanism: "openai-prefix-cache",
      readReported: true,
      writeReported: false,
    },
  })
})
