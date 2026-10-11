import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest.js"
import { SessionEvent } from "../src/session-event.js"

test("prediction is a minimal ephemeral public event, absent from durable history", () => {
  const definition = EventManifest.Server.get("session.prediction.updated")
  expect(definition).toBeDefined()
  expect(definition).toBe(SessionEvent.PredictionUpdated)
  expect(definition?.durability).toBe("ephemeral")
  expect(EventManifest.Durable.has("session.prediction.updated.1")).toBe(false)
  const event = Schema.decodeUnknownSync(SessionEvent.PredictionUpdated)({
    id: "evt_prediction", created: 1, type: "session.prediction.updated",
    data: { sessionID: "ses_prediction", sourceMessageID: "msg_reply", text: "Run the focused tests", unused: "not public" },
  })
  const encoded = Schema.encodeSync(SessionEvent.PredictionUpdated)({ ...event, location: undefined, metadata: undefined })
  expect(encoded.data).toEqual({ sessionID: "ses_prediction", sourceMessageID: "msg_reply", text: "Run the focused tests" })
  expect(Object.keys(encoded)).not.toContain("location")
  expect(Object.keys(encoded)).not.toContain("metadata")
})
