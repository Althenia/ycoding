import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { YCoding } from "../src/promise/index"

const groupID = Coordination.GroupID.make("cgrp_client")
const participant = (sessionID: string) => ({
  sessionID, title: sessionID, location: { directory: "/work" }, state: "idle", lastActivity: 1, pending: [],
})
const info = {
  id: groupID, name: "Docs", revision: 1, active: false, master: participant("ses_master"),
  members: [participant("ses_member")], settings: { concurrency: null }, time: { created: 1, updated: 1 },
}
const create = { name: "Docs", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] } as never
const update = { groupID, revision: 1, name: "Renamed", memberSessionIDs: [], settings: { concurrency: 2 } } as never
const updateBody = { revision: 1, name: "Renamed", memberSessionIDs: [], settings: { concurrency: 2 } }

test("Promise client sends Project create, update, and delete", async () => {
  const requests: Request[] = []
  const client = YCoding.make({ baseUrl: "http://localhost:3000", fetch: async (request, init) => {
    const value = request instanceof Request ? request : new Request(request, init)
    requests.push(value)
    return value.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ data: info })
  } })
  expect((await client.coordination.create(create)).master.sessionID).toBe("ses_master")
  expect((await client.coordination.update(update)).id).toBe(groupID)
  await client.coordination.delete({ groupID })
  expect(await requests[0]!.json()).toEqual(create as never)
  expect(await requests[1]!.json()).toEqual(updateBody)
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["POST", "/api/coordination"], ["PATCH", "/api/coordination/cgrp_client"], ["DELETE", "/api/coordination/cgrp_client"],
  ])
})

test("Effect client sends Project create, update, and delete", async () => {
  const { YCoding } = await import("../src/effect/index")
  const requests: { method: string; url: string; body: unknown }[] = []
  const http = HttpClient.make((request) => {
    requests.push({ method: request.method, url: request.url,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined })
    return Effect.succeed(HttpClientResponse.fromWeb(request,
      request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ data: info })))
  })
  await Effect.gen(function* () {
    const client = yield* YCoding.make({ baseUrl: "http://localhost:3000" })
    yield* client.coordination.create(create)
    yield* client.coordination.update(update)
    yield* client.coordination.delete({ groupID })
  }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.runPromise)
  expect(requests).toEqual([
    { method: "POST", url: "http://localhost:3000/api/coordination", body: create },
    { method: "PATCH", url: "http://localhost:3000/api/coordination/cgrp_client", body: updateBody },
    { method: "DELETE", url: "http://localhost:3000/api/coordination/cgrp_client", body: undefined },
  ])
})
