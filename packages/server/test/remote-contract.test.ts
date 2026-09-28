import { expect, test } from "bun:test"
import { Api } from "../src/api"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"

test("remote status and switch are local authenticated server operations", () => {
  const group = Api.groups["server.remote"]
  expect(Object.keys(group.endpoints).sort()).toEqual(["remote.get", "remote.set"])
  expect(group.endpoints["remote.get"].middlewares.has(Authorization)).toBe(true)
  expect(group.endpoints["remote.set"].middlewares.has(Authorization)).toBe(true)
})
