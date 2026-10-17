import { expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makePermissionGroup } from "../src/groups/permission.js"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()("test/PermissionLocation") {}
class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/PermissionSessionLocation",
) {}

test("request-only permission rejection has a distinct Session-owned endpoint", () => {
  const group = makePermissionGroup(LocationMiddleware, SessionLocationMiddleware)
  const endpoint = group.endpoints["session.permission.reject"]
  expect(endpoint).toBeDefined()
  expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
  expect([...endpoint.middlewares]).not.toContain(LocationMiddleware)
  const document = OpenApi.fromApi(HttpApi.make("permission-test").add(group))
  const operation = document.paths["/api/session/{sessionID}/permission/{requestID}/reject"]?.post
  expect(operation?.operationId).toBe("session.permission.reject")
  expect(operation?.responses?.[204]).toBeDefined()
  expect(operation?.responses?.[404]).toBeDefined()
  expect(document.paths["/api/session/{sessionID}/permission/{requestID}/reply"]?.post?.operationId).toBe(
    "session.permission.reply",
  )
})
