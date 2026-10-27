import { expect, test } from "bun:test"
import { Api } from "../src/api"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"

test("remote status and switch are local authenticated server operations", () => {
  const group = Api.groups["server.remote"]
  expect(Object.keys(group.endpoints).sort()).toEqual(["remote.get", "remote.set"])
  for (const endpoint of Object.values(group.endpoints)) expect(endpoint.middlewares.has(Authorization)).toBe(true)
})
