import { expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeIncidentGroup } from "../src/groups/incident.js"

class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware>()("test/LocationMiddleware") {}

const IncidentGroup = makeIncidentGroup(LocationMiddleware)
const document = OpenApi.fromApi(HttpApi.make("incident-test").add(IncidentGroup))
const names = (path: string, method: "get" | "delete") =>
  document.paths[path]?.[method]?.parameters?.map((parameter) => ("$ref" in parameter ? parameter.$ref : parameter.name))
const decode = (endpoint: keyof typeof IncidentGroup.endpoints, input: unknown) =>
  Schema.decodeUnknownSync(IncidentGroup.endpoints[endpoint].query as never)(input) as Record<string, unknown>

test("declares server-scoped incident operations", () => {
  const endpoints = IncidentGroup.endpoints
  expect([endpoints["incident.report"].method, endpoints["incident.report"].path]).toEqual(["GET", "/api/incident/report"])
  expect([endpoints["incident.recent"].method, endpoints["incident.recent"].path]).toEqual(["GET", "/api/incident/recent"])
  expect([endpoints["incident.guidance.get"].method, endpoints["incident.guidance.get"].path]).toEqual(["GET", "/api/incident/guidance"])
  expect([endpoints["incident.guidance.clear"].method, endpoints["incident.guidance.clear"].path]).toEqual(["DELETE", "/api/incident/guidance"])
  for (const name of ["incident.report", "incident.recent"] as const) expect(endpoints[name].middlewares.size).toBe(0)
  for (const name of ["incident.guidance.get", "incident.guidance.clear"] as const) {
    expect(endpoints[name].middlewares.size).toBe(1)
    expect(endpoints[name].middlewares.has(LocationMiddleware)).toBe(true)
  }
  expect(document.paths["/api/incident/report"]?.get?.operationId).toBe("incident.report")
  expect(document.paths["/api/incident/recent"]?.get?.operationId).toBe("incident.recent")
  expect(document.paths["/api/incident/guidance"]?.get?.operationId).toBe("incident.guidance.get")
  expect(document.paths["/api/incident/guidance"]?.delete?.operationId).toBe("incident.guidance.clear")
})

test("declares query parameters", () => {
  expect(names("/api/incident/report", "get")).toEqual(["group", "from", "to", "offset", "limit"])
  expect(names("/api/incident/recent", "get")).toEqual(["provider", "model", "agent", "limit"])
  expect(names("/api/incident/guidance", "get")).toEqual(["provider", "model", "location"])
  expect(names("/api/incident/guidance", "delete")).toEqual(["provider", "model", "location"])
})

test("decodes and bounds report queries", () => {
  expect(decode("incident.report", { group: "model", from: "1", to: "9", offset: "0", limit: "200" })).toEqual({ group: "model", from: 1, to: 9, offset: 0, limit: 200 })
  expect(decode("incident.report", { group: "agent" })).toEqual({ group: "agent" })
  for (const bad of [{ group: "x" }, { group: "model", offset: "-1" }, { group: "model", limit: "201" }, { group: "model", limit: "0" }, { group: "model", from: "-1" }, {}])
    expect(() => decode("incident.report", bad)).toThrow()
})

test("decodes and bounds recent and guidance queries", () => {
  expect(decode("incident.recent", { provider: "p", model: "m", agent: "build", limit: "50" })).toEqual({ provider: "p", model: "m", agent: "build", limit: 50 })
  expect(decode("incident.recent", { provider: "p", model: "m" })).toEqual({ provider: "p", model: "m" })
  for (const bad of [{ provider: "p", model: "m", limit: "51" }, { provider: "p", model: "m", limit: "0" }, { provider: "p" }])
    expect(() => decode("incident.recent", bad)).toThrow()
  for (const endpoint of ["incident.guidance.get", "incident.guidance.clear"] as const) {
    expect(decode(endpoint, { provider: "p", model: "m" })).toEqual({ provider: "p", model: "m" })
    expect(decode(endpoint, { provider: "p", model: "m", location: { directory: "/d" } })).toEqual({
      provider: "p",
      model: "m",
      location: { directory: "/d" },
    })
    expect(() => decode(endpoint, { provider: "p" })).toThrow()
  }
})

test("report and recent queries carry no location", () => {
  expect(names("/api/incident/report", "get")).not.toContain("location")
  expect(names("/api/incident/recent", "get")).not.toContain("location")
  const deepObject = (method: "get" | "delete") =>
    document.paths["/api/incident/guidance"]?.[method]?.parameters?.find(
      (parameter) => !("$ref" in parameter) && parameter.name === "location",
    )
  expect(deepObject("get")).toMatchObject({ style: "deepObject", explode: true })
  expect(deepObject("delete")).toMatchObject({ style: "deepObject", explode: true })
})

test("local operation IDs are exact and none is a dotted prefix of another", () => {
  const ids = Object.keys(IncidentGroup.endpoints)
  expect(ids).toEqual(["incident.report", "incident.recent", "incident.guidance.get", "incident.guidance.clear"])
  for (const id of ids) expect(ids.some((other) => other.startsWith(id + "."))).toBe(false)
})
