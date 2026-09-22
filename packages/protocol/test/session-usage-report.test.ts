import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeSessionGroup, SessionUsageReportQuery } from "../src/groups/session.js"

class SessionLocationMiddleware extends HttpApiMiddleware.Service<SessionLocationMiddleware>()(
  "test/SessionUsageReportLocationMiddleware",
) {}

test("decodes and validates usage report query bounds", () => {
  const decode = Schema.decodeUnknownSync(SessionUsageReportQuery)
  expect(
    decode({
      group: "hour",
      from: "0",
      to: "2",
      offset: "0",
      limit: "200",
      sort: "cost",
      order: "desc",
    }),
  ).toEqual({
    group: "hour",
    from: 0,
    to: 2,
    offset: 0,
    limit: 200,
    sort: "cost",
    order: "desc",
  })
  for (const query of [
    { group: "hour", from: "2", to: "2" },
    { group: "hour", from: "3", to: "2" },
    { group: "hour", offset: "-1" },
    { group: "hour", limit: "0" },
    { group: "hour", limit: "201" },
    { group: "hour", sort: "requests" },
    { group: "hour", order: "newest" },
  ])
    expect(() => decode(query)).toThrow()
})

test("publishes the additive location-owned usage report OpenAPI operation", () => {
  const group = makeSessionGroup(SessionLocationMiddleware)
  const endpoint = group.endpoints["session.usageReport"]
  const document = OpenApi.fromApi(HttpApi.make("usage-report-test").add(group))
  const operation = document.paths["/api/session/{sessionID}/usage/report"]?.get

  expect(endpoint.middlewares.has(SessionLocationMiddleware)).toBe(true)
  expect(operation?.operationId).toBe("v2.session.usageReport")
  expect(operation?.parameters?.map((parameter) => "$ref" in parameter ? parameter.$ref : parameter.name)).toEqual([
    "sessionID",
    "group",
    "from",
    "to",
    "offset",
    "limit",
    "sort",
    "order",
  ])
  for (const status of [200, 400, 404]) expect(operation?.responses?.[status]).toBeDefined()
})
