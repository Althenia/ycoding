import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { YCoding } from "../src/promise/index"

const items = [{ kind: "question", sessionID: "ses_client", sessionTitle: "Synthetic", directory: "/work", id: "que_client", summary: "Enter a value",
  decide: [{ label: "Reply (replace answer values)", template: true, argv: ["ycoding", "api", "session.question.reply", "--param", "sessionID=ses_client", "--param", "requestID=que_client", "--data", '{"answers":[["<answer:0>"]]}'] }],
}]

test("Promise decision.list preserves exact argv without requiring a Location", async () => {
  const requests: Request[] = []
  const client = YCoding.make({ baseUrl: "http://localhost:3000", fetch: async (request, init) => {
    const value = request instanceof Request ? request : new Request(request, init)
    requests.push(value)
    return Response.json({ data: items })
  } })
  expect(await client.decision.list()).toEqual(items)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.method).toBe("GET")
  expect(requests[0]!.url).toBe("http://localhost:3000/api/decision")
  expect(requests[0]!.headers.has("x-ycoding-directory")).toBe(false)
})

test("Effect decision.list preserves exact argv without requiring a Location", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: string[] = []
  const http = HttpClient.make((request) => {
    requests.push(request.url)
    expect(request.method).toBe("GET")
    expect(request.headers["x-ycoding-directory"]).toBeUndefined()
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: items })))
  })
  const result = await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    return yield* client.decision.list()
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)
  expect(result).toEqual(items)
  expect(requests).toEqual(["http://localhost:3000/api/decision"])
})
