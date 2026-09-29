import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionOutstandingQuery } from "../src/groups/session.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionOutstandingLocationMiddleware",
) {}

test("publishes a process-global outstanding read with bounded Session IDs and optional failed-state reconciliation", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const endpoint = group.endpoints["session.outstanding"]
  const operation = OpenApi.fromApi(HttpApi.make("session-outstanding-test").add(group)).paths["/api/session/outstanding"]?.get
  expect(endpoint).toBeDefined()
  expect([...endpoint.middlewares]).toHaveLength(0)
  expect(operation?.operationId).toBe("v2.session.outstanding")
  expect(operation?.parameters?.map((item) => "$ref" in item ? item.$ref : item.name)).toEqual(["failures"])
  expect(Schema.decodeUnknownSync(SessionOutstandingQuery)({ failures: "true" })).toEqual({ failures: true })
  expect(() => Schema.decodeUnknownSync(SessionOutstandingQuery)({ failures: "yes" })).toThrow()
  const success = [...endpoint.success][0]
  expect(Schema.is(success)({ data: ["ses_parent"], failed: ["ses_parent"] })).toBe(true)
  expect(Schema.is(success)({ data: ["wrong"], failed: [] })).toBe(false)
})
