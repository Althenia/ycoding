import { expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { ClientApi, groupNames } from "../src/client.js"
import { Authorization } from "../src/middleware/authorization.js"
import { SchemaErrorMiddleware } from "../src/middleware/schema-error.js"

test("local coordination operations are the closed Project set, authenticated and globally placed", () => {
  const group = ClientApi.groups["server.coordination"]
  expect(group).toBeDefined()
  expect(groupNames["server.coordination"]).toBe("coordination")
  const document = OpenApi.fromApi(ClientApi)
  const expected = [
    ["settings", "get", "/api/coordination/settings"],
    ["list", "get", "/api/coordination"],
    ["create", "post", "/api/coordination"],
    ["get", "get", "/api/coordination/{groupID}"],
    ["update", "patch", "/api/coordination/{groupID}"],
    ["delete", "delete", "/api/coordination/{groupID}"],
  ] as const
  expect(Object.keys(group.endpoints).sort()).toEqual(expected.map(([name]) => `coordination.${name}`).sort())
  for (const [name, method, path] of expected) {
    const endpoint = group.endpoints[`coordination.${name}`]
    expect(endpoint.middlewares.has(Authorization)).toBe(true)
    expect(endpoint.middlewares.has(SchemaErrorMiddleware)).toBe(true)
    const operation = document.paths[path]?.[method]
    expect(operation?.operationId).toBe(`coordination.${name}`)
    expect(operation?.responses["401"]).toBeDefined()
    expect(operation?.parameters?.some((parameter) => !("$ref" in parameter) && ["location", "directory", "workspace"].includes(parameter.name)) ?? false).toBe(false)
  }
})

test("create and update payloads carry the Master, members, and settings without roles or policy", () => {
  const create = Schema.decodeUnknownSync(Coordination.CreateInput, { onExcessProperty: "error" })
  const input = { name: "Docs", masterSessionID: "ses_master", memberSessionIDs: ["ses_a", "ses_b"] }
  expect(create(input)).toEqual(input as never)
  expect(() => create({ ...input, members: [] })).toThrow()
  expect(() => create({ ...input, name: "" })).toThrow()
  expect(() => create({ ...input, memberSessionIDs: Array.from({ length: 65 }, (_, i) => `ses_${i}`) })).toThrow()
  const update = Schema.decodeUnknownSync(Coordination.UpdateInput, { onExcessProperty: "error" })
  const patch = { revision: 2, settings: { concurrency: 1, delegatedDecisions: { categories: [] } } }
  expect(Schema.encodeSync(Coordination.UpdateInput)(update(patch))).toEqual(patch as never)
  expect(() => update({ revision: 2, settings: { concurrency: 0 } })).toThrow()
  expect(() => update({ name: "x" })).toThrow()
  expect(() => update({ revision: 2, policy: {} })).toThrow()
})
