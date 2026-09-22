import { expect, test } from "bun:test"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { UsageGroup } from "../src/groups/usage.js"

test("declares local-runtime global usage summary and report operations", () => {
  const summary = UsageGroup.endpoints["usage.get"]
  const report = UsageGroup.endpoints["usage.report"]
  const document = OpenApi.fromApi(HttpApi.make("usage-test").add(UsageGroup))

  expect(summary.path).toBe("/api/usage")
  expect(summary.method).toBe("GET")
  expect(summary.middlewares.size).toBe(0)
  expect(report.path).toBe("/api/usage/report")
  expect(report.method).toBe("GET")
  expect(report.middlewares.size).toBe(0)
  expect(document.paths["/api/usage"]?.get?.operationId).toBe("v2.usage.get")
  expect(document.paths["/api/usage/report"]?.get?.operationId).toBe("v2.usage.report")
  expect(
    document.paths["/api/usage/report"]?.get?.parameters?.map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    ),
  ).toEqual(["group", "from", "to", "offset", "limit", "sort", "order"])
})
