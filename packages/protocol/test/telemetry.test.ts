import { expect, test } from "bun:test"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { ServerGroup } from "../src/groups/server.js"

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
})
