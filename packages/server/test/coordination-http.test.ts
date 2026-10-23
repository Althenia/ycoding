import { expect, test } from "bun:test"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { CoordinationSettings } from "@ycoding-ai/core/coordination-settings"
import { Detail, DispatchInput } from "@ycoding-ai/protocol/groups/coordination"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { CoordinationHandler } from "../src/handlers/coordination"

const group = Schema.decodeUnknownSync(Detail)({
  id: "cgrp_http", name: "Boundary", status: "disarmed",
  revision: 2, fencingGeneration: 1,
  members: [{ sessionID: "ses_coordinator", role: "coordinator", location: { directory: "/project" } }],
  policy: { concurrency: 2, queueCapacity: 10, delegatedDecisions: { categories: ["question"] } },
  time: { created: 1, updated: 1 },
  claims: [], dispatches: [],
})

function fixture(service: Partial<CoordinationService.Interface>) {
  let authorized = 0
  const services = Layer.mergeAll(
    Layer.mock(CoordinationService.Service, service),
    Layer.succeed(CoordinationSettings.Service, { read: () => Effect.succeed({ enabled: false, categories: ["question", "permission", "review"] }) }),
    Layer.succeed(Authorization, (effect) => Effect.sync(() => { authorized += 1 }).pipe(Effect.andThen(effect))),
    Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
  )
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.coordination"])).pipe(
    Layer.provide(CoordinationHandler.pipe(Layer.provide(services))),
    Layer.provide(HttpServer.layerServices),
  ))
  return {
    json: (path: string, method: string, body: unknown) => handler.handler(new Request(`http://localhost/api/coordination${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })),
    get: (path: string) => handler.handler(new Request(`http://localhost/api/coordination${path}`)),
    authorized: () => authorized,
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("local coordination binds human lifecycle authority and maps revision and narrowing without Location input", async () => {
  const received: unknown[] = []
  await using http = fixture({
    create: (actor, input) => Effect.sync(() => { received.push({ actor, input }); return group }),
    arm: (actor, input) => Effect.sync(() => { received.push({ actor, input }); return group }),
    updateRoster: (actor, input) => Effect.sync(() => { received.push({ actor, input }); return group }),
  })
  const members = [{ sessionID: "ses_coordinator", role: "coordinator" }]
  const created = await http.json("", "POST", { name: "Boundary", policy: group.policy, members })
  expect(created.status).toBe(200)
  expect(await created.json()).toMatchObject({ data: { id: group.id } })
  expect(received[0]).toMatchObject({ actor: { kind: "human" }, input: { name: "Boundary", policy: group.policy, members } })
  expect((await http.json(`/${group.id}/arm`, "POST", { revision: 2 })).status).toBe(200)
  expect(received[1]).toEqual({ actor: { kind: "human" }, input: { groupID: group.id, expectedRevision: 2 } })
  expect((await http.json(`/${group.id}/members`, "PUT", { revision: 2, members, policy: group.policy })).status).toBe(200)
  expect(received[2]).toEqual({ actor: { kind: "human" }, input: { groupID: group.id, expectedRevision: 2, name: undefined, members, policy: group.policy } })
  expect(http.authorized()).toBe(3)
})

test("settings exposes central revocation through the authenticated read route", async () => {
  await using http = fixture({})
  const result = await http.get("/settings")
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ data: { enabled: false, categories: ["question", "permission", "review"] } })
  expect(http.authorized()).toBe(1)
})

test("local coordination returns a typed conflict instead of successful lifecycle settlement", async () => {
  await using http = fixture({ arm: () => Effect.fail(new CoordinationService.ConflictError({ message: "The revision changed" })) })
  const result = await http.json(`/${group.id}/arm`, "POST", { revision: 1 })
  expect(result.status).toBe(409)
  expect(await result.json()).toEqual({ _tag: "CoordinationError", reason: "Coordination.ConflictError", message: "The revision changed" })
  expect(http.authorized()).toBe(1)
})

test("dispatch HTTP requires selection and preserves its exact model and reason in the receipt", async () => {
  const received: unknown[] = []
  const selection = { agent: "occam", model: { providerID: "fixture", id: "fixture-model", variant: "medium" }, reason: "Small, low-risk change with settled behavior" }
  const request = Schema.decodeUnknownSync(DispatchInput)({ dispatchID: "cdsp_http", revision: 2, holderSessionID: "ses_coordinator", generation: 1, targetSessionID: "ses_target", text: "Inspect the parser", selection })
  const dispatch = { id: request.dispatchID!, groupID: group.id, targetSessionID: request.targetSessionID, coordinatorSessionID: group.members[0]!.sessionID, generation: 1, status: "pending" as const, text: request.text, selection: request.selection, time: { created: 1, updated: 1 } }
  await using http = fixture({ dispatch: (_actor, input) => Effect.sync(() => { received.push(input); return dispatch }) })
  const input = { revision: 2, holderSessionID: group.members[0]!.sessionID, generation: 1, targetSessionID: dispatch.targetSessionID, text: dispatch.text }
  expect((await http.json(`/${group.id}/dispatch`, "POST", input)).status).toBe(400)
  expect(received).toHaveLength(0)
  const result = await http.json(`/${group.id}/dispatch`, "POST", { ...input, selection })
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ data: { selection } })
  expect(received).toEqual([expect.objectContaining({ selection })])
})
