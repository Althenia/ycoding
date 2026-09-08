import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup } from "../src/groups/session.js"
import { SessionNotFoundError } from "../src/errors.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionLocationMiddleware",
) {}

test("archive endpoints use the session-scoped V2 contract", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const archive = group.endpoints["session.archive"]
  const unarchive = group.endpoints["session.unarchive"]

  expect(archive.method).toBe("POST")
  expect(archive.path).toBe("/api/session/:sessionID/archive")
  expect(unarchive.method).toBe("DELETE")
  expect(unarchive.path).toBe("/api/session/:sessionID/archive")
  const document = OpenApi.fromApi(HttpApi.make("test").add(group))
  for (const method of ["post", "delete"] as const) {
    const responses = document.paths["/api/session/{sessionID}/archive"]?.[method]?.responses
    expect(responses?.["204"]).toBeDefined()
    expect(responses?.["204"]?.content).toBeUndefined()
    expect(responses?.["404"]).toBeDefined()
  }
  for (const endpoint of [archive, unarchive]) {
    expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
    expect([...endpoint.success].every((schema) => HttpApiSchema.isNoContent(schema.ast))).toBe(true)
    expect(
      [...endpoint.error].some((schema) =>
        Schema.is(schema)(new SessionNotFoundError({ sessionID: "ses_missing", message: "Session not found" })),
      ),
    ).toBe(true)
  }
})
