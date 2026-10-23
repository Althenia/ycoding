import { expect, test } from "bun:test"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { CoordinationSettings } from "@ycoding-ai/core/coordination-settings"
import { CoordinationRuntime } from "@ycoding-ai/core/session/coordination-runtime"
import { Coordination } from "../../schema/src/coordination"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { CoordinationHandler } from "../src/handlers/coordination"

const participant = (sessionID: string) => ({ sessionID, title: sessionID, location: { directory: "/project" }, state: "idle", lastActivity: 1, pending: [] })
const info = Schema.decodeUnknownSync(Coordination.Info)({
  id: "cgrp_http", name: "Boundary", revision: 2, active: false,
  master: participant("ses_master"), members: [participant("ses_member")],
  settings: { concurrency: 2, delegatedDecisions: { categories: ["question"] } },
  time: { created: 1, updated: 1 },
})
const group = {
  id: info.id, name: info.name, revision: info.revision, masterSessionID: info.master.sessionID,
  memberSessionIDs: [info.members[0]!.sessionID], settings: info.settings, active: false, time: info.time,
}

function fixture(service: Partial<CoordinationService.Interface>, runtime: Partial<CoordinationRuntime.Interface> = {}) {
  let authorized = 0
  const services = Layer.mergeAll(
    Layer.mock(CoordinationService.Service, service),
    Layer.mock(CoordinationRuntime.Service, { get: () => Effect.succeed(info), ...runtime }),
    Layer.succeed(CoordinationSettings.Service, { read: () => Effect.succeed({ enabled: false, categories: ["question", "permission", "review"] }) }),
    Layer.succeed(Authorization, (effect) => Effect.sync(() => { authorized += 1 }).pipe(Effect.andThen(effect))),
    Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
  )
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.coordination"])).pipe(
    Layer.provide(CoordinationHandler.pipe(Layer.provide(services))),
    Layer.provide(HttpServer.layerServices),
  ))
  return {
    json: (path: string, method: string, body?: unknown) => handler.handler(new Request(`http://localhost/api/coordination${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })),
    authorized: () => authorized,
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("create, get, update, and delete bind to the Project service without Location input", async () => {
  const received: unknown[] = []
  await using http = fixture({
    create: (input) => Effect.sync(() => { received.push(["create", input]); return group }),
    update: (groupID, input) => Effect.sync(() => { received.push(["update", groupID, input]); return group }),
    delete: (groupID) => Effect.sync(() => { received.push(["delete", groupID]) }),
  })
  const created = await http.json("", "POST", { name: "Boundary", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] })
  expect(created.status).toBe(200)
  expect(await created.json()).toMatchObject({ data: { id: "cgrp_http", master: { sessionID: "ses_master" }, active: false } })
  expect((await http.json("/cgrp_http", "GET")).status).toBe(200)
  const patch = { revision: 2, name: "Renamed", settings: { concurrency: null } }
  expect((await http.json("/cgrp_http", "PATCH", patch)).status).toBe(200)
  expect((await http.json("/cgrp_http", "DELETE")).status).toBe(204)
  expect(received).toEqual([
    ["create", { name: "Boundary", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] }],
    ["update", "cgrp_http", patch],
    ["delete", "cgrp_http"],
  ])
  expect(http.authorized()).toBe(4)
})

test("list returns summaries from the runtime", async () => {
  const summary = { id: info.id, name: info.name, revision: info.revision, active: false, masterSessionID: info.master.sessionID, memberCount: 1, settings: info.settings, time: info.time }
  await using http = fixture({}, { summaries: () => Effect.succeed([summary]) })
  const result = await http.json("", "GET")
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ data: [JSON.parse(JSON.stringify(summary))] })
})

test("settings exposes central revocation through the authenticated read route", async () => {
  await using http = fixture({})
  const result = await http.json("/settings", "GET")
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ data: { enabled: false, categories: ["question", "permission", "review"] } })
  expect(http.authorized()).toBe(1)
})

test("a stale revision and an ineligible Session return typed conflicts", async () => {
  await using http = fixture({
    update: () => Effect.fail(new CoordinationService.ConflictError({ message: "The revision changed" })),
    create: () => Effect.fail(new CoordinationService.IneligibleSessionError({ message: "Session ses_member already belongs to Project cgrp_other" })),
    delete: () => Effect.fail(new CoordinationService.NotFoundError({ message: "Project cgrp_http does not exist" })),
  })
  const stale = await http.json("/cgrp_http", "PATCH", { revision: 1 })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toEqual({ _tag: "CoordinationError", reason: "Coordination.ConflictError", message: "The revision changed" })
  const taken = await http.json("", "POST", { name: "Boundary", masterSessionID: "ses_master", memberSessionIDs: ["ses_member"] })
  expect(taken.status).toBe(409)
  expect(await taken.json()).toMatchObject({ reason: "Coordination.IneligibleSessionError" })
  const missing = await http.json("/cgrp_http", "DELETE")
  expect(missing.status).toBe(409)
  expect(await missing.json()).toMatchObject({ reason: "Coordination.NotFoundError" })
})

test("removed lifecycle, claim, dispatch, and wait routes are not served", async () => {
  await using http = fixture({})
  for (const [path, method] of [["/cgrp_http/arm", "POST"], ["/cgrp_http/dispatch", "POST"], ["/cgrp_http/claim", "POST"], ["/cgrp_http/wait", "POST"], ["/cgrp_http/members", "PUT"], ["/cgrp_http/capacity", "GET"]] as const)
    expect((await http.json(path, method, method === "GET" ? undefined : {})).status).toBe(404)
})
