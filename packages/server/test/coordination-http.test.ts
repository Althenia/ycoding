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

test("board is an authenticated Project read with a data envelope", async () => {
  const board = {
    groupID: info.id,
    nodes: [{ sessionID: info.master.sessionID, title: "Root chat", role: "master" as const, state: "idle" as const }],
    tasks: [], handoffs: [], reviews: [],
  }
  const groups: string[] = []
  const runtime = { board: (groupID: Coordination.GroupID) => Effect.sync(() => { groups.push(groupID); return board }) }
  await using http = fixture({}, runtime as Partial<CoordinationRuntime.Interface>)
  const result = await http.json("/cgrp_http/board", "GET")
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ data: board })
  expect(groups).toEqual(["cgrp_http"])
  expect(http.authorized()).toBe(1)
})

test("the authenticated Project response retains recorded ownership and omits absent ownership", async () => {
  const owner = { sessionID: "ses_supervisor", title: "Supervisor" }
  const owned = Schema.decodeUnknownSync(Coordination.Info)({
    ...info,
    members: [{ ...info.members[0], owner }, participant("ses_unowned")],
  })
  await using http = fixture({}, { get: () => Effect.succeed(owned) })
  const response = await http.json("/cgrp_http", "GET")
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.data.members[0].owner).toEqual(owner)
  expect(body.data.members[1]).not.toHaveProperty("owner")
  expect(http.authorized()).toBe(1)
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

const attachedResult = () => Schema.decodeUnknownSync(Coordination.AttachResult)({
  groupID: "cgrp_http", sessionID: "ses_new", location: { directory: "/elsewhere" }, ownerSessionID: "ses_owner", reconciled: false,
})

test("attach and detach bind the group's Master and URL group through the runtime without Location input", async () => {
  const received: unknown[] = []
  await using http = fixture({
    delete: () => Effect.sync(() => { received.push(["delete"]) }),
  }, {
    attach: (caller, input, options) => Effect.sync(() => { received.push(["attach", caller, input, options]); return attachedResult() }),
    remove: (caller, input, options) => Effect.sync(() => { received.push(["remove", caller, input, options]); return { sessionID: input.sessionID, removed: true as const } }),
  })
  const attach = await http.json("/cgrp_http/members", "POST", { sessionID: "ses_new", ownerSessionID: "ses_owner" })
  expect(attach.status).toBe(200)
  expect(await attach.json()).toEqual({ data: JSON.parse(JSON.stringify(attachedResult())) })
  expect((await http.json("/cgrp_http/members", "POST", { sessionID: "ses_new" })).status).toBe(200)
  const detach = await http.json("/cgrp_http/members/ses_member", "DELETE")
  expect(detach.status).toBe(200)
  expect(await detach.json()).toEqual({ data: { sessionID: "ses_member", removed: true } })
  expect(received).toEqual([
    ["attach", "ses_master", { sessionID: "ses_new", ownerSessionID: "ses_owner" }, { groupID: "cgrp_http" }],
    ["attach", "ses_master", { sessionID: "ses_new" }, { groupID: "cgrp_http" }],
    ["remove", "ses_master", { sessionID: "ses_member" }, { groupID: "cgrp_http" }],
  ])
  expect(http.authorized()).toBe(3)
})

test("attach and detach reject malformed identities before reaching the runtime", async () => {
  let reached = 0
  await using http = fixture({}, {
    attach: () => Effect.sync(() => { reached += 1; return attachedResult() }),
    remove: () => Effect.sync(() => { reached += 1; return { sessionID: info.members[0]!.sessionID, removed: true as const } }),
  })
  for (const body of [{}, { sessionID: "bad" }, { sessionID: "ses_new", ownerSessionID: "bad" }])
    expect((await http.json("/cgrp_http/members", "POST", body)).status).toBe(400)
  expect((await http.json("/cgrp_http/members/bad", "DELETE")).status).toBe(400)
  expect((await http.json("/bad/members/ses_member", "DELETE")).status).toBe(400)
  expect(reached).toBe(0)
})

test("attach and detach refusals and unknown Projects return typed conflicts", async () => {
  const refused = new CoordinationRuntime.RefusedError({ message: "Session ses_member has active work or pending requests" })
  await using http = fixture({}, {
    attach: () => Effect.fail(refused),
    remove: () => Effect.fail(refused),
    get: (groupID) => groupID === info.id ? Effect.succeed(info) : Effect.fail(new CoordinationService.NotFoundError({ message: `Project ${groupID} does not exist` })),
  })
  for (const [path, method, body] of [["/cgrp_http/members", "POST", { sessionID: "ses_new" }], ["/cgrp_http/members/ses_member", "DELETE", undefined]] as const) {
    const response = await http.json(path, method, body)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ _tag: "CoordinationError", reason: "Coordination.RefusedError", message: refused.message })
  }
  const missing = await http.json("/cgrp_missing/members/ses_member", "DELETE")
  expect(missing.status).toBe(409)
  expect(await missing.json()).toMatchObject({ reason: "Coordination.NotFoundError" })
})

test("removed lifecycle, claim, dispatch, and wait routes are not served", async () => {
  await using http = fixture({})
  for (const [path, method] of [["/cgrp_http/arm", "POST"], ["/cgrp_http/dispatch", "POST"], ["/cgrp_http/claim", "POST"], ["/cgrp_http/wait", "POST"], ["/cgrp_http/members", "PUT"], ["/cgrp_http/capacity", "GET"]] as const)
    expect((await http.json(path, method, method === "GET" ? undefined : {})).status).toBe(404)
})
