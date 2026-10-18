import { expect, test } from "bun:test"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionUsageReportQuery } from "../src/groups/session.js"
import { ProviderUsageGroup } from "../src/groups/provider-usage.js"
import { Schema } from "effect"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()("test/UsageAccountingLocation") {}

test("prompt and recursive task costs are bounded Session-owned GET reads", () => {
  const group = makeSessionGroup(LocationMiddleware)
  const document = OpenApi.fromApi(HttpApi.make("accounting").add(group))
  for (const [name, path] of [["session.promptCosts", "prompts"], ["session.taskCosts", "tasks"]] as const) {
    expect(group.endpoints[name].method).toBe("GET")
    expect(group.endpoints[name].middlewares.has(LocationMiddleware)).toBe(true)
    const operation = document.paths[`/api/session/{sessionID}/usage/${path}`]?.get
    expect(operation?.operationId).toBe(name)
    for (const status of [200, 400, 404, 503]) expect(operation?.responses?.[status]).toBeDefined()
  }
})

test("forecast is a read-only provider-usage endpoint with explicit local token scope", () => {
  const document = OpenApi.fromApi(HttpApi.make("forecast").add(ProviderUsageGroup))
  const operation = document.paths["/api/provider/usage/forecast"]?.get
  expect(operation?.operationId).toBe("providerUsage.forecast")
  expect(operation?.parameters?.map((parameter) => "$ref" in parameter ? parameter.$ref : parameter.name))
    .toEqual(["location", "localScope"])
  expect(operation?.responses?.[503]).toBeDefined()
  expect(document.components?.schemas?.["UsageForecast.Pace"]).toMatchObject({
    type: "object",
    properties: { verdict: { enum: ["ahead", "cutting-it-close", "will-run-out"] }, projectedUsedAtReset: { type: "number" } },
    required: ["verdict", "projectedUsedAtReset"],
  })
  expect(document.components?.schemas?.["UsageForecast.Quota"]).toMatchObject({
    properties: { pace: { $ref: "#/components/schemas/UsageForecast.Pace" } },
  })
})

test("report query preserves selected effort and provider-qualified profile filters", () => {
  expect<unknown>(Schema.decodeUnknownSync(SessionUsageReportQuery)({ group: "profile", providerID: "openai", profile: "work", selectedEffort: "high", from: "0", to: "100" }))
    .toEqual({ group: "profile", providerID: "openai", profile: "work", selectedEffort: "high", from: 0, to: 100 })
})
