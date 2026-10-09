import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { Config } from "@ycoding-ai/schema/config"
import { ConfigGroup } from "../src/groups/config.js"

test("config diagnostics is a Location-scoped response with Config.Diagnostic entries", () => {
  const operation = ConfigGroup.endpoints["config.diagnostics"]
  expect(operation).toBeDefined()
  expect(operation.query).toBeDefined()
  const success = [...operation.success][0]
  if (!success) throw new Error("config.diagnostics has no success schema")
  expect(Schema.is(Config.Diagnostic)({
    path: "/tmp/ycoding.jsonc",
    reason: "invalid-values",
    message: "Rejected configuration value",
  })).toBe(true)
  expect(Schema.is(Config.Diagnostic)({
    path: "/tmp/ycoding.jsonc",
    reason: "unknown",
    message: "Rejected configuration value",
  })).toBe(false)
  expect(success.ast).toBeDefined()

  expect(OpenApi.fromApi(HttpApi.make("server").add(ConfigGroup)).paths["/api/config/diagnostics"]?.get?.operationId).toBe(
    "config.diagnostics",
  )
})
