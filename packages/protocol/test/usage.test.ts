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
  expect(document.paths["/api/usage"]?.get?.operationId).toBe("usage.get")
  expect(document.paths["/api/usage/report"]?.get?.operationId).toBe("usage.report")
  expect(
    document.paths["/api/usage/report"]?.get?.parameters?.map((parameter) =>
      "$ref" in parameter ? parameter.$ref : parameter.name,
    ),
  ).toEqual(["group", "providerID", "profile", "modelID", "selectedEffort", "timeZone", "from", "to", "offset", "limit", "sort", "order"])
})

test("declares one composed dashboard operation", () => {
  const dashboard = UsageGroup.endpoints["usage.dashboard"]
  const document = OpenApi.fromApi(HttpApi.make("usage-test").add(UsageGroup))

  expect(dashboard.path).toBe("/api/usage/dashboard")
  expect(dashboard.method).toBe("POST")
  expect(dashboard.middlewares.size).toBe(0)
  expect(document.paths["/api/usage/dashboard"]?.post?.operationId).toBe("usage.dashboard")
  expect(Object.keys(UsageGroup.endpoints)).toEqual(["usage.get", "usage.report", "usage.dashboard"])
})
