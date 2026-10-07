import { expect, test } from "bun:test"
import { ProviderRequest } from "../src/provider-request.js"
import { SessionEvent } from "../src/session-event.js"
import { Schema } from "effect"

test("decision inference has its own provider-request and usage source", () => {
  expect(Schema.decodeUnknownSync(ProviderRequest.Source)("decision")).toBe("decision")
  expect(Schema.decodeUnknownSync(SessionEvent.UsageRecorded.data.fields.source)("decision")).toBe("decision")
})
