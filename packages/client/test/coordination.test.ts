import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Agent } from "@ycoding-ai/schema/agent"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Session } from "@ycoding-ai/schema/session"
import { YCoding } from "../src/promise/index"

const selection = Coordination.DispatchSelection.make({
  agent: Agent.ID.make("occam"),
  model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture-model"), profile: "Work", variant: "medium" }),
  reason: "A bounded parser edit with settled behavior",
})
const input = {
  groupID: Coordination.GroupID.make("cgrp_client"),
  dispatchID: Coordination.DispatchID.make("cdsp_client"),
  holderSessionID: Session.ID.make("ses_owner"),
  targetSessionID: Session.ID.make("ses_worker"),
  revision: Coordination.Revision.make(1), generation: 1,
  text: "Check the parser", selection,
}
const dispatch = {
  id: input.dispatchID, groupID: input.groupID, targetSessionID: input.targetSessionID,
  coordinatorSessionID: input.holderSessionID, generation: 1, status: "queued", reason: "capacity",
  text: input.text, selection, time: { created: 1, updated: 1 },
}
const receipt = {
  id: "crcpt_client", groupID: input.groupID, dispatchID: input.dispatchID, kind: "dispatched",
  sessionID: input.targetSessionID, generation: 1, selection, time: 1,
}
const body = {
  dispatchID: input.dispatchID, holderSessionID: input.holderSessionID, targetSessionID: input.targetSessionID,
  revision: 1, generation: 1, text: input.text, selection,
}

test("Promise client serializes dispatch selection and preserves it on receipts", async () => {
  const requests: Request[] = []
  const client = YCoding.make({ baseUrl: "http://localhost:3000", fetch: async (request, init) => {
    const value = request instanceof Request ? request : new Request(request, init)
    requests.push(value)
    return Response.json({ data: value.method === "POST" ? dispatch : [receipt] })
  } })
  expect((await client.coordination.dispatch(input)).selection).toEqual(selection)
  expect((await client.coordination.receipts({ groupID: input.groupID }))[0]?.selection).toEqual(selection)
  expect(await requests[0]!.json()).toEqual(body)
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["POST", "/api/coordination/cgrp_client/dispatch"], ["GET", "/api/coordination/cgrp_client/receipts"],
  ])
})

test("Effect client serializes dispatch selection and preserves it on receipts", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: { method: string; url: string; body: unknown }[] = []
  const http = HttpClient.make((request) => {
    requests.push({ method: request.method, url: request.url,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined })
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data: request.method === "POST" ? dispatch : [receipt] })))
  })
  const result = await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    const dispatched = yield* client.coordination.dispatch(input)
    const receipts = yield* client.coordination.receipts({ groupID: input.groupID })
    return { dispatched, receipts }
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)
  expect(result.dispatched.selection).toEqual(selection)
  expect(result.receipts[0]?.selection).toEqual(selection)
  expect(requests).toEqual([
    { method: "POST", url: "http://localhost:3000/api/coordination/cgrp_client/dispatch", body },
    { method: "GET", url: "http://localhost:3000/api/coordination/cgrp_client/receipts", body: undefined },
  ])
})
