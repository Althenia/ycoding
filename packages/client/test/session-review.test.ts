import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Session } from "@ycoding-ai/schema/session"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { YCoding } from "../src/promise/index"
import { make } from "../src/effect/generated/client"

const decision = { kind: "permission", reply: "once" } as const
const item = {
  itemID: "rvw_first",
  sessionID: "ses_child",
  rootSessionID: "ses_root",
  sessionTitle: "Child",
  created: 1,
  kind: "permission",
  reason: "sleep_entry",
  origin: { requestID: "per_first" },
  payload: {
    type: "permission",
    action: "shell",
    resources: ["echo value"],
    fingerprint: "a".repeat(64),
    requestID: "per_first",
  },
} as const

test("promise review methods serialize the family path and kind-tagged decision", async () => {
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return request.method === "GET" ? Response.json({ data: [item, { ...item, reason: "disabled" }] }) : new Response(null, { status: 204 })
    },
  })
  expect(await client.review.list({ sessionID: "ses_root" })).toEqual([item, { ...item, reason: "disabled" }])
  await client.review.decide({ sessionID: "ses_root", itemID: "rvw_first", decision })
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/api/session/ses_root/review"],
    ["POST", "/api/session/ses_root/review/rvw_first/decide"],
  ])
  expect(await requests[1]!.json()).toEqual({ decision })
})

test("Effect review methods decode item contracts and serialize the same decision body", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const httpClient = HttpClient.make((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.method === "GET" ? Response.json({ data: [item, { ...item, reason: "disabled" }] }) : new Response(null, { status: 204 }),
      ),
    )
  })
  const items = await Effect.gen(function* () {
    const client = yield* make({ baseUrl: "http://localhost:3000" })
    const listed = yield* client.review.list({ sessionID: Session.ID.make("ses_root") })
    yield* client.review.decide({
      sessionID: Session.ID.make("ses_root"),
      itemID: SessionReview.ID.make("rvw_first"),
      decision,
    })
    return listed
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)
  expect(items).toEqual([item, { ...item, reason: "disabled" }])
  expect(requests).toEqual([
    { method: "GET", url: "http://localhost:3000/api/session/ses_root/review", body: undefined },
    { method: "POST", url: "http://localhost:3000/api/session/ses_root/review/rvw_first/decide", body: { decision } },
  ])
})
