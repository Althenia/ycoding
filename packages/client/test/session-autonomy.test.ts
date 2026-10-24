import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Session } from "@ycoding-ai/schema/session"
import { YCoding } from "../src/promise/index"
import { make } from "../src/effect/generated/client"

const views = (["manual", "yolo", "auto"] as const).map(answers => ({
  mode: "normal",
  permissions: "manual", guardrails: "manual", answers,
  effective: { permissions: "yolo", guardrails: "manual", answers, inherited: { permissions: "ses_parent" }, asleep: false, guardrailsEnabled: true },
}))

test("Promise autonomy methods preserve effective inheritance and serialize answer modes", async () => {
  const requests: Request[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return Response.json({ data: views[requests.length - 1] })
    },
  })
  const values = [await client.session.autonomy.get({ sessionID: "ses_answers" })]
  for (const answers of ["yolo", "auto"] as const)
    values.push(await client.session.autonomy.set({ sessionID: "ses_answers", payload: { answers } }))
  expect(values).toEqual(views)
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", "/api/session/ses_answers/autonomy"],
    ["PUT", "/api/session/ses_answers/autonomy"],
    ["PUT", "/api/session/ses_answers/autonomy"],
  ])
  expect(await requests[1]!.json()).toEqual({ answers: "yolo" })
  expect(await requests[2]!.json()).toEqual({ answers: "auto" })
})

test("Promise and Effect clients serialize category modes and atomic set-all without coercion", async () => {
  const payloads = (["manual", "yolo", "auto"] as const).flatMap(mode => [
    { permissions: mode }, { guardrails: mode }, { answers: mode },
    { permissions: mode, guardrails: mode, answers: mode },
  ])
  const promiseBodies: unknown[] = []
  const client = YCoding.make({
    baseUrl: "http://localhost:3000",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      promiseBodies.push(await request.json())
      return Response.json({ data: views[0] })
    },
  })
  for (const payload of payloads)
    await client.session.autonomy.set({ sessionID: "ses_switches", payload })
  expect(promiseBodies).toEqual(payloads)

  const effectBodies: unknown[] = []
  const httpClient = HttpClient.make(request => {
    effectBodies.push(request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined)
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: views[0] })))
  })
  await Effect.gen(function* () {
    const client = yield* make({ baseUrl: "http://localhost:3000" })
    for (const payload of payloads)
      yield* client.session.autonomy.set({ sessionID: Session.ID.make("ses_switches"), payload })
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)
  expect(effectBodies).toEqual(payloads)
})

test("Effect autonomy methods decode effective inheritance and serialize the same answer modes", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const httpClient = HttpClient.make(request => {
    requests.push({ method: request.method, url: request.url,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined })
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: views[requests.length - 1] })))
  })
  const values = await Effect.gen(function* () {
    const client = yield* make({ baseUrl: "http://localhost:3000" })
    const sessionID = Session.ID.make("ses_answers")
    const values = [yield* client.session.autonomy.get({ sessionID })]
    for (const answers of ["yolo", "auto"] as const)
      values.push(yield* client.session.autonomy.set({ sessionID, payload: { answers } }))
    return values
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)
  expect(values).toEqual(views)
  expect(requests).toEqual([
    { method: "GET", url: "http://localhost:3000/api/session/ses_answers/autonomy", body: undefined },
    { method: "PUT", url: "http://localhost:3000/api/session/ses_answers/autonomy", body: { answers: "yolo" } },
    { method: "PUT", url: "http://localhost:3000/api/session/ses_answers/autonomy", body: { answers: "auto" } },
  ])
})
