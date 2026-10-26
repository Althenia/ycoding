import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const capabilities = [
  { protocolVersion: "2026-07-28", elicitation: true, form: true, url: false, observedAt: 1_797_000_000_000 },
  { protocolVersion: "2025-11-25", elicitation: false, form: false, url: false, observedAt: 1_797_000_000_001 },
]

test("Promise Remote MCP GET and PUT preserve capability diagnostics without Location selectors", async () => {
  const { YCoding } = await import("../src/promise/index")
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json({
        data: request.method === "PUT" ? { state: "connecting", clientCapabilities: capabilities } : { state: "on", clientCapabilities: capabilities },
      })
    },
  })

  const current = await client.remote.mcp.get() satisfies { message?: string; url?: string }
  expect(current.clientCapabilities).toEqual(capabilities)
  expect(current.clientCapabilities?.[1]?.elicitation).toBe(false)

  const updated = await client.remote.mcp.set({ enabled: true }) satisfies { message?: string; url?: string }
  expect(updated.clientCapabilities).toEqual(capabilities)
  expect(updated.state).toBe("connecting")

  expect(requests.map((request) => ({
    method: request.method,
    path: new URL(request.url).pathname,
    hasDirectoryHeader: request.headers.has("x-ycoding-directory"),
    hasLocationQuery: new URL(request.url).searchParams.has("location"),
  }))).toEqual([
    { method: "GET", path: "/api/remote/mcp", hasDirectoryHeader: false, hasLocationQuery: false },
    { method: "PUT", path: "/api/remote/mcp", hasDirectoryHeader: false, hasLocationQuery: false },
  ])
  expect(await requests[1].json()).toEqual({ enabled: true })
})

test("Promise Remote MCP GET preserves an omitted capability diagnostic", async () => {
  const { YCoding } = await import("../src/promise/index")
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).pathname).toBe("/api/remote/mcp")
      return Response.json({ data: { state: "off" } })
    },
  })

  const status = await client.remote.mcp.get()
  expect(status).toEqual({ state: "off" })
  expect("clientCapabilities" in status).toBe(false)
})

test("Effect Remote MCP GET and PUT preserve capability diagnostics without Location selectors", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const http = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    return Effect.succeed(HttpClientResponse.fromWeb(
      request,
      Response.json({
        data: request.method === "PUT" ? { state: "connecting", clientCapabilities: capabilities } : { state: "on", clientCapabilities: capabilities },
      }),
    ))
  })
  const result = await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    const current = yield* client.remote.mcp.get()
    const updated = yield* client.remote.mcp.set({ enabled: true })
    return { current, updated }
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)

  expect(result.current.clientCapabilities).toEqual(capabilities)
  expect(result.current.clientCapabilities?.[1]?.elicitation).toBe(false)
  expect(result.updated.clientCapabilities).toEqual(capabilities)
  expect(result.updated.state).toBe("connecting")
  expect(requests.map((request) => ({
    method: request.method,
    path: new URL(request.url).pathname,
    hasLocationQuery: new URL(request.url).searchParams.has("location"),
    body: request.body,
  }))).toEqual([
    { method: "GET", path: "/api/remote/mcp", hasLocationQuery: false, body: undefined },
    { method: "PUT", path: "/api/remote/mcp", hasLocationQuery: false, body: { enabled: true } },
  ])
})

test("Effect Remote MCP GET preserves an omitted capability diagnostic", async () => {
  const { YCoding } = await import("../src/effect/index")
  const http = HttpClient.make((request) => Effect.succeed(
    HttpClientResponse.fromWeb(request, Response.json({ data: { state: "off" } })),
  ))
  const status = await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    return yield* client.remote.mcp.get()
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)

  expect(status).toEqual({ state: "off" })
  expect("clientCapabilities" in status).toBe(false)
})
