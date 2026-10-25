import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Model } from "@ycoding-ai/schema/model"
import { Session } from "@ycoding-ai/schema/session"
import { Provider } from "@ycoding-ai/schema/provider"

const model = Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-6.1-sol-ultrafast"), variant: Model.VariantID.make("high"), profile: "Work" })
const task = { sessionID: "ses_child", parentID: "ses_parent", description: "Task", agent: "omoikane", model, background: true, state: "running", revision: 2, time: { created: 1, updated: 2 } }
const input = { parentID: Session.ID.make("ses_parent"), childID: Session.ID.make("ses_child"), expectedModel: model, model }

test("generated Promise child model method serializes only the canonical payload", async () => {
  const { YCoding } = await import("../src/promise/index")
  const requests: Request[] = []
  const client = YCoding.make({ baseUrl: "http://localhost", fetch: async (url, init) => {
    requests.push(url instanceof Request ? url : new Request(url, init))
    return Response.json({ data: task })
  } })
  expect(await client.session.subagent.switchModel(input)).toEqual(task)
  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe("POST")
  expect(new URL(requests[0].url).pathname).toBe("/api/session/ses_parent/subagent/ses_child/model")
  expect(await requests[0].json()).toEqual({ expectedModel: model, model })
})

test("generated Effect child model method uses the same serialized boundary", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: { method: string; url: string; body: unknown }[] = []
  const http = HttpClient.make(request => {
    requests.push({ method: request.method, url: request.url, body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined })
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: task })))
  })
  const result = await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost" })
    return yield* client.session.subagent.switchModel(input)
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)
  expect(result).toEqual(task)
  expect(requests).toEqual([{ method: "POST", url: "http://localhost/api/session/ses_parent/subagent/ses_child/model", body: { expectedModel: model, model } }])
})
