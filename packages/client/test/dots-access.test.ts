import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const status = { access: { enabled: true, revision: 1 }, configuration: { ready: true, profile: "Synthetic" }, connection: { state: "connected", hostname: "synthetic-host" } }

test("generated Promise global Dots methods serialize only the revision-fenced payload and unwrap status", async () => {
  const { YCoding } = await import("../src/promise/index")
  const requests: Request[] = []
  const controller = new AbortController()
  const client = YCoding.make({ baseUrl: "http://localhost", fetch: async (input, init) => {
    requests.push(input instanceof Request ? input : new Request(input, init))
    return Response.json({ data: status })
  } })
  expect(await client.dots.get({ signal: controller.signal })).toEqual(status)
  expect(await client.dots.set({ enabled: true, expectedRevision: 0 }, { signal: controller.signal })).toEqual(status)
  expect(Object.keys(client.dots)).toEqual(["get", "set"])
  expect(requests.map((request) => [request.method, new URL(request.url).pathname, new URL(request.url).search, request.headers.get("x-ycoding-directory"), request.headers.get("x-ycoding-workspace")])).toEqual([
    ["GET", "/api/dots", "", null, null], ["PUT", "/api/dots", "", null, null],
  ])
  expect(await requests[1]!.json()).toEqual({ enabled: true, expectedRevision: 0 })
  controller.abort()
  expect(requests.map((request) => request.signal.aborted)).toEqual([true, true])
})

test("generated Effect global Dots methods retain the canonical serialized request and status", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: unknown[] = []
  const http = HttpClient.make((request) => {
    requests.push({ method: request.method, path: new URL(request.url).pathname, query: new URL(request.url).search,
      directory: request.headers["x-ycoding-directory"], workspace: request.headers["x-ycoding-workspace"],
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined })
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: status })))
  })
  await Effect.runPromise(Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost" })
    expect(yield* client.dots.get()).toEqual(status)
    expect(yield* client.dots.set({ enabled: true, expectedRevision: 0 })).toEqual(status)
    expect(Object.keys(client.dots)).toEqual(["get", "set"])
  }).pipe(Effect.provideService(HttpClient.HttpClient, http)))
  expect(requests).toEqual([
    { method: "GET", path: "/api/dots", query: "", directory: undefined, workspace: undefined, body: undefined },
    { method: "PUT", path: "/api/dots", query: "", directory: undefined, workspace: undefined, body: { enabled: true, expectedRevision: 0 } },
  ])
})
