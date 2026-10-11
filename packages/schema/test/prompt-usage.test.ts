import { expect, test } from "bun:test"
import { ProviderRequest } from "../src/provider-request.js"
import { SessionEvent } from "../src/session-event.js"
import { Telemetry } from "../src/telemetry.js"
import { Schema } from "effect"

test("prompt generation has its own provider-request, usage, and telemetry source", () => {
  expect(Schema.decodeUnknownSync(ProviderRequest.Source)("prompt")).toBe("prompt")
  expect(Schema.decodeUnknownSync(SessionEvent.UsageRecorded.data.fields.source)("prompt")).toBe("prompt")
  expect(Schema.decodeUnknownSync(Telemetry.Operation)("session.promptGenerate")).toBe("session.promptGenerate")
})
