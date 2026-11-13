import { expect, test } from "bun:test"
import { HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeApi } from "../src/api.js"

class Location extends HttpApiMiddleware.Service<Location>()("native-only-location") {}
const api = makeApi({ definitions: [], locationMiddleware: Location, catalogLocationMiddleware: Location, formLocationMiddleware: Location, sessionLocationMiddleware: Location })

test("native Dots exposes global access, computer administration and the Dot conversation over HTTP", () => {
  expect(Object.keys(api.groups["server.dots"].endpoints).sort()).toEqual([
    "dots.attach", "dots.detach", "dots.get", "dots.remove", "dots.resume", "dots.set", "dots.task.updates", "dots.thread.interrupt",
    "dots.thread.read", "dots.thread.requests", "dots.thread.respond", "dots.thread.send", "dots.threads",
  ])
  const document = OpenApi.fromApi(api)
  for (const path of ["/api/dots/computer", "/api/dots/computer/detach", "/api/dots/computer/remove", "/api/dots/resume",
    "/api/dots/thread/{threadID}/message", "/api/dots/thread/{threadID}/interrupt", "/api/dots/thread/{threadID}/requests/{requestID}"])
    expect(Object.keys(document.paths[path] ?? {})).toEqual(["post"])
  for (const path of ["/api/dots/threads", "/api/dots/tasks/{taskID}/updates", "/api/dots/thread/{threadID}", "/api/dots/thread/{threadID}/requests"])
    expect(Object.keys(document.paths[path] ?? {})).toEqual(["get"])
  expect(JSON.stringify(document.paths["/api/dots/thread/{threadID}/requests/{requestID}"])).toContain("409")
})

test("the HTTP contract retires incoming MCP control while retaining ordinary MCP providers", () => {
  const document = OpenApi.fromApi(api)
  expect(Object.keys(api.groups)).not.toContain("server.mcpEvents")
  expect(Object.keys(api.groups)).toContain("server.mcp")
  expect(document.paths["/api/remote/mcp"]).toBeUndefined()
  const prompt = document.paths["/api/session/{sessionID}/prompt"]
  expect(JSON.stringify(prompt)).not.toContain("remoteSource")
})
