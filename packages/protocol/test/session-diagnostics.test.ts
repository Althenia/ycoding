import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { makeSessionGroup } from "../src/groups/session.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionDiagnosticsLocationMiddleware",
) {}

test("session diagnostics endpoint accepts optional prepared-request breakdown", () => {
  const endpoint = makeSessionGroup(SessionLocationMiddleware).endpoints["session.diagnostics"]
  const success = [...endpoint.success][0]
  if (!success) throw new Error("session.diagnostics has no success schema")
  const diagnostics = {
    model: { providerID: "openai", id: "gpt" },
    context: { total: 12 },
    tokens: { uncachedInput: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cache: { eligible: 10, mechanism: "none", readReported: false, writeReported: false },
  }
  const contextBreakdown = { system: 1, tools: 0, user: 2, assistant: 3, reasoning: 0, toolCalls: 4, other: 0 }
  expect(Schema.is(success)({ data: diagnostics })).toBe(true)
  expect(Schema.is(success)({ data: { ...diagnostics, contextBreakdown } })).toBe(true)
  expect(Schema.is(success)({ data: { ...diagnostics, contextBreakdown: { ...contextBreakdown, other: -1 } } })).toBe(false)
})
