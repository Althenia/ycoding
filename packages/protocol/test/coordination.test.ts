import { expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { ClientApi, groupNames } from "../src/client.js"
import { Authorization } from "../src/middleware/authorization.js"
import { SchemaErrorMiddleware } from "../src/middleware/schema-error.js"

test("local coordination operations are authenticated and globally placed", () => {
  const group = ClientApi.groups["server.coordination"]
  expect(group).toBeDefined()
  expect(groupNames["server.coordination"]).toBe("coordination")
  const document = OpenApi.fromApi(ClientApi)
  for (const [name, method, path] of [
    ["list", "get", "/api/coordination"],
    ["create", "post", "/api/coordination"],
    ["get", "get", "/api/coordination/{groupID}"],
    ["members", "put", "/api/coordination/{groupID}/members"],
    ["arm", "post", "/api/coordination/{groupID}/arm"],
    ["stop", "post", "/api/coordination/{groupID}/stop"],
    ["complete", "post", "/api/coordination/{groupID}/complete"],
    ["claim", "post", "/api/coordination/{groupID}/claim"],
    ["release", "post", "/api/coordination/{groupID}/release"],
    ["dispatch", "post", "/api/coordination/{groupID}/dispatch"],
    ["receipts", "get", "/api/coordination/{groupID}/receipts"],
    ["wait", "post", "/api/coordination/{groupID}/wait"],
    ["cancelWait", "post", "/api/coordination/{groupID}/wait/cancel"],
    ["capacity", "get", "/api/coordination/{groupID}/capacity"],
  ] as const) {
    const endpoint = group.endpoints[`coordination.${name}`]
    expect(endpoint.middlewares.has(Authorization)).toBe(true)
    expect(endpoint.middlewares.has(SchemaErrorMiddleware)).toBe(true)
    const operation = document.paths[path]?.[method]
    expect(operation?.operationId).toBe(`coordination.${name}`)
    expect(operation?.responses["401"]).toBeDefined()
    expect(operation?.parameters?.some((parameter) => !("$ref" in parameter) && ["location", "directory", "workspace"].includes(parameter.name)) ?? false).toBe(false)
  }
})
