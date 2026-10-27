import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const access = { sessionID: "ses_root", rootSessionID: "ses_root", enabled: true, revision: 1, inherited: false, configured: true }

test("generated Promise access methods serialize only the revision-fenced payload and unwrap access", async () => {
  const { YCoding } = await import("../src/promise/index")
  const requests: Request[] = []
  const client = YCoding.make({ baseUrl: "http://localhost", fetch: async (input, init) => {
    requests.push(input instanceof Request ? input : new Request(input, init))
    return Response.json({ data: access })
  } })
  expect(await client.dots.access.get({ sessionID: "ses_root" })).toEqual(access)
  expect(await client.dots.access.set({ sessionID: "ses_root", enabled: true, expectedRevision: 0 })).toEqual(access)
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/api/session/ses_root/dots/access"], ["POST", "/api/session/ses_root/dots/access"],
  ])
  expect(await requests[1]!.json()).toEqual({ enabled: true, expectedRevision: 0 })
})

test("generated Effect access methods retain the canonical operation shape", async () => {
  const { YCoding } = await import("../src/effect/index")
  const methods: string[] = []
  const http = HttpClient.make((request) => {
    methods.push(request.method)
    expect(new URL(request.url).pathname).toBe("/api/session/ses_root/dots/access")
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: access })))
  })
  await Effect.runPromise(Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost" })
    expect(yield* client.dots.access.get({ sessionID: "ses_root" })).toEqual(access)
    expect(yield* client.dots.access.set({ sessionID: "ses_root", enabled: true, expectedRevision: 0 })).toEqual(access)
  }).pipe(Effect.provideService(HttpClient.HttpClient, http)))
  expect(methods).toEqual(["GET", "POST"])
})
