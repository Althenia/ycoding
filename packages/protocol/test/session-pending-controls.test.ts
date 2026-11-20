import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup } from "../src/groups/session.js"
import { InvalidRequestError, PendingInputNotFoundError, SessionNotFoundError } from "../src/errors.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionLocationMiddleware",
) {}

test("pending input endpoints are session-scoped, bodiless and typed", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const remove = group.endpoints["session.pending.remove"]
  const steer = group.endpoints["session.pending.steer"]

  expect([remove.method, remove.path]).toEqual(["DELETE", "/api/session/:sessionID/pending/:messageID"])
  expect([steer.method, steer.path]).toEqual(["POST", "/api/session/:sessionID/pending/:messageID/steer"])
  const document = OpenApi.fromApi(HttpApi.make("test").add(group))
  const removeResponses = document.paths["/api/session/{sessionID}/pending/{messageID}"]?.delete?.responses
  const steerResponses = document.paths["/api/session/{sessionID}/pending/{messageID}/steer"]?.post?.responses
  for (const responses of [removeResponses, steerResponses]) {
    expect(responses?.["204"]).toBeDefined()
    expect(responses?.["204"]?.content).toBeUndefined()
    expect(responses?.["404"]).toBeDefined()
    expect(responses?.["400"]).toBeDefined()
  }
  const errors = [
    new SessionNotFoundError({ sessionID: "ses_missing", message: "Session not found" }),
    new PendingInputNotFoundError({ sessionID: "ses_a", messageID: "msg_a", message: "Pending input not found" }),
    new InvalidRequestError({ message: "invalid" }),
  ]
  for (const endpoint of [remove, steer]) {
    expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
    expect([...endpoint.success].every((schema) => HttpApiSchema.isNoContent(schema.ast))).toBe(true)
    for (const error of errors) expect([...endpoint.error].some((schema) => Schema.is(schema)(error))).toBe(true)
  }
  expect(PendingInputNotFoundError.make({ sessionID: "ses_a", messageID: "msg_a", message: "x" })._tag).toBe("PendingInputNotFoundError")
})
