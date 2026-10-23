import { expect, test } from "bun:test"
import { Schema } from "effect"
import { MembersInput } from "../src/groups/coordination.js"
import { ClientApi } from "../src/client.js"
import { Authorization } from "../src/middleware/authorization.js"

test("coordination settings has an authenticated read-only global endpoint", () => {
  const endpoint = ClientApi.groups["server.coordination"].endpoints["coordination.settings"]
  expect(endpoint).toBeDefined()
  expect(endpoint.method).toBe("GET")
  expect(endpoint.path).toBe("/api/coordination/settings")
  expect(endpoint.middlewares.has(Authorization)).toBe(true)
})

test("project edits accept a bounded name without discarding roster or decision narrowing", () => {
  const decode = Schema.decodeUnknownSync(MembersInput, { onExcessProperty: "error" })
  const input = { revision: 1, name: "Documentation", members: [{ sessionID: "ses_coordinator", role: "coordinator" }], policy: { concurrency: 1, queueCapacity: 10, delegatedDecisions: { categories: [] } } } as const
  expect(Schema.encodeSync(MembersInput)(decode(input))).toEqual(input)
  for (const name of ["", "x".repeat(121)]) expect(() => decode({ ...input, name })).toThrow()
})
