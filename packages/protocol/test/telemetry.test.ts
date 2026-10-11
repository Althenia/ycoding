import { expect, test } from "bun:test"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { ServerGroup } from "../src/groups/server.js"
import { ClientApi } from "../src/client.js"
import { Authorization } from "../src/middleware/authorization.js"

test("declares machine-global bounded telemetry ingest and read routes", () => {
  const append = ServerGroup.endpoints["telemetry.append"]
  const list = ServerGroup.endpoints["telemetry.list"]
  const document = OpenApi.fromApi(HttpApi.make("telemetry-test").add(ServerGroup))
  expect(append?.path).toBe("/api/server/web-latency")
  expect(append?.method).toBe("POST")
  expect(list?.path).toBe("/api/server/web-latency")
  expect(list?.method).toBe("GET")
  expect(append?.middlewares.size).toBe(0)
  expect(list?.middlewares.size).toBe(0)
  expect(document.paths["/api/server/web-latency"]?.post?.operationId).toBe("telemetry.append")
  expect(document.paths["/api/server/web-latency"]?.get?.operationId).toBe("telemetry.list")
  expect(document.paths["/api/server/telemetry/consent"]?.get?.operationId).toBe("telemetry.consent.get")
  expect(document.paths["/api/server/telemetry/consent"]?.put?.operationId).toBe("telemetry.consent.set")
  expect(document.paths["/api/server/web-latency"]?.post?.responses).toHaveProperty("403")
  for (const name of ["telemetry.append", "telemetry.consent.get", "telemetry.consent.set"] as const)
    expect(ClientApi.groups["server.server"].endpoints[name].middlewares.has(Authorization)).toBe(true)
})
