import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup } from "../src/groups/session.js"
import { SessionNotFoundError } from "../src/errors.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionLocationMiddleware",
) {}

test("pin endpoints use the session-scoped V2 contract", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const pin = group.endpoints["session.pin"]
  const unpin = group.endpoints["session.unpin"]

  expect(pin.method).toBe("POST")
  expect(pin.path).toBe("/api/session/:sessionID/pin")
  expect(unpin.method).toBe("DELETE")
  expect(unpin.path).toBe("/api/session/:sessionID/pin")
  const document = OpenApi.fromApi(HttpApi.make("test").add(group))
  for (const method of ["post", "delete"] as const) {
    const responses = document.paths["/api/session/{sessionID}/pin"]?.[method]?.responses
    expect(responses?.["204"]).toBeDefined()
    expect(responses?.["204"]?.content).toBeUndefined()
    expect(responses?.["404"]).toBeDefined()
  }
  for (const endpoint of [pin, unpin]) {
    expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
    expect([...endpoint.success].every((schema) => HttpApiSchema.isNoContent(schema.ast))).toBe(true)
    expect(
      [...endpoint.error].some((schema) =>
        Schema.is(schema)(new SessionNotFoundError({ sessionID: "ses_missing", message: "Session not found" })),
      ),
    ).toBe(true)
  }
})
