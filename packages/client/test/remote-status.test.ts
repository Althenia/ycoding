import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const initialStatus = { state: "on", message: "Remote host connected" } as const
const updatedStatus = { state: "connecting", message: "Reconnecting to remote daemon" } as const

test("Promise Remote GET and PUT preserve status messages without Location selectors", async () => {
  const { YCoding } = await import("../src/promise/index")
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json({
        data: request.method === "PUT" ? updatedStatus : initialStatus,
      })
    },
  })

  const current = await client.remote.get()
  expect(current).toEqual(initialStatus)
  expect(current.message).toBe("Remote host connected")

  const updated = await client.remote.set({ enabled: true })
  expect(updated).toEqual(updatedStatus)
  expect(updated.state).toBe("connecting")

  expect(requests.map((request) => ({
    method: request.method,
    path: new URL(request.url).pathname,
    query: new URL(request.url).search,
    hasDirectoryHeader: request.headers.has("x-ycoding-directory"),
    hasWorkspaceHeader: request.headers.has("x-ycoding-workspace"),
  }))).toEqual([
    { method: "GET", path: "/api/remote", query: "", hasDirectoryHeader: false, hasWorkspaceHeader: false },
    { method: "PUT", path: "/api/remote", query: "", hasDirectoryHeader: false, hasWorkspaceHeader: false },
  ])
  expect(await requests[1]!.json()).toEqual({ enabled: true })
  expect(client.remote).not.toHaveProperty("mcp")
})

test("Promise Remote GET preserves an omitted status message", async () => {
  const { YCoding } = await import("../src/promise/index")
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      expect([url.pathname, url.search]).toEqual(["/api/remote", ""])
      return Response.json({ data: { state: "off" } })
    },
  })

  const status = await client.remote.get()
  expect(status).toEqual({ state: "off" })
  expect("message" in status).toBe(false)
  expect(status.message).toBeUndefined()
})

test("Effect Remote GET and PUT preserve status messages without Location selectors", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: Array<{
    method: string
    path: string
    query: string
    urlParams: Record<string, string>
    directory: string | undefined
    workspace: string | undefined
    body: unknown
  }> = []
  const http = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      query: new URL(request.url).search,
      urlParams: request.urlParams ? Object.fromEntries(request.urlParams.params) : {},
      directory: request.headers["x-ycoding-directory"],
      workspace: request.headers["x-ycoding-workspace"],
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    return Effect.succeed(HttpClientResponse.fromWeb(
      request,
      Response.json({
        data: request.method === "PUT" ? updatedStatus : initialStatus,
      }),
    ))
  })
  const result = await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    expect(client.remote).not.toHaveProperty("mcp")
    const current = yield* client.remote.get()
    const updated = yield* client.remote.set({ enabled: true })
    return { current, updated }
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)

  expect(result.current).toEqual(initialStatus)
  expect(result.current.message).toBe("Remote host connected")
  expect(result.updated).toEqual(updatedStatus)
  expect(result.updated.state).toBe("connecting")
  expect(requests).toEqual([
    { method: "GET", path: "/api/remote", query: "", urlParams: {}, directory: undefined, workspace: undefined, body: undefined },
    { method: "PUT", path: "/api/remote", query: "", urlParams: {}, directory: undefined, workspace: undefined, body: { enabled: true } },
  ])
})

test("Effect Remote GET preserves an omitted status message", async () => {
  const { YCoding } = await import("../src/effect/index")
  const http = HttpClient.make((request) => Effect.succeed(
    HttpClientResponse.fromWeb(request, Response.json({ data: { state: "off" } })),
  ))
  const status = await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    return yield* client.remote.get()
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)

  expect(status).toEqual({ state: "off" })
  expect("message" in status).toBe(false)
  expect(status.message).toBeUndefined()
})
