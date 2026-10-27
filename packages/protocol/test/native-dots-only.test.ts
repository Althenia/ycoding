import { expect, test } from "bun:test"
import { HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeApi } from "../src/api.js"

class Location extends HttpApiMiddleware.Service<Location>()("native-only-location") {}
const api = makeApi({ definitions: [], locationMiddleware: Location, formLocationMiddleware: Location, sessionLocationMiddleware: Location })

test("native Dots exposes only root access administration over HTTP", () => {
  expect(Object.keys(api.groups["server.dots"].endpoints).sort()).toEqual(["session.dots.access.get", "session.dots.access.set"])
})

test("the HTTP contract retires incoming MCP control while retaining ordinary MCP providers", () => {
  const document = OpenApi.fromApi(api)
  expect(Object.keys(api.groups)).not.toContain("server.mcpEvents")
  expect(Object.keys(api.groups)).toContain("server.mcp")
  expect(document.paths["/api/remote/mcp"]).toBeUndefined()
  const prompt = document.paths["/api/session/{sessionID}/prompt"]
  expect(JSON.stringify(prompt)).not.toContain("remoteSource")
})
