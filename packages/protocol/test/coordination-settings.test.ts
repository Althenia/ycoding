import { expect, test } from "bun:test"
import { ClientApi } from "../src/client.js"
import { Authorization } from "../src/middleware/authorization.js"

test("coordination settings has an authenticated read-only global endpoint", () => {
  const endpoint = ClientApi.groups["server.coordination"].endpoints["coordination.settings"]
  expect(endpoint).toBeDefined()
  expect(endpoint.method).toBe("GET")
  expect(endpoint.path).toBe("/api/coordination/settings")
  expect(endpoint.middlewares.has(Authorization)).toBe(true)
})
