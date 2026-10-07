import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup } from "../src/groups/session.js"
import { InvalidRequestError, SessionNotFoundError } from "../src/errors.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionAgentSelectionLocationMiddleware",
) {}

const group = makeSessionGroup(SessionLocationMiddleware)

test("Session creation and agent switching admit typed invalid-agent and missing-Session errors", () => {
  for (const name of ["session.create", "session.switchAgent"] as const) {
    const endpoint = group.endpoints[name]
    const valid = [...endpoint.error].map((schema) => Schema.is(schema))
    expect(valid.some((is) => is(new InvalidRequestError({ field: "agent", message: "Internal helper" })))).toBe(true)
    expect(valid.some((is) => is(new SessionNotFoundError({ sessionID: "ses_missing", message: "Missing Session" })))).toBe(true)
  }
})

test("OpenAPI documents HTTP 400 rejection without changing Session payloads or successes", () => {
  const document = OpenApi.fromApi(HttpApi.make("agent-selection-test").add(group))
  for (const path of ["/api/session", "/api/session/{sessionID}/agent"]) {
    expect(document.paths[path]?.post?.responses?.[400]).toBeDefined()
    expect(document.paths[path]?.post?.responses?.[404]).toBeDefined()
  }
  expect(document.paths["/api/session"]?.post?.responses?.[200]).toBeDefined()
  expect(document.paths["/api/session/{sessionID}/agent"]?.post?.responses?.[204]).toBeDefined()
})
