import { expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { StandaloneConfig } from "@ycoding-ai/core/config/standalone"
import { Database } from "@ycoding-ai/core/database/database"
import { StandaloneDecision } from "@ycoding-ai/core/decision/standalone"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { StandaloneForm } from "@ycoding-ai/core/form/standalone"
import { Form } from "@ycoding-ai/core/form"
import { Location } from "@ycoding-ai/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { StandalonePermissionService } from "@ycoding-ai/core/permission/standalone"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { testEffect } from "../../core/test/lib/effect"
import { Api } from "../src/api"
import { FormHandler } from "../src/handlers/form"
import { PermissionHandler } from "../src/handlers/permission"
import { layer as locationLayer } from "../src/location"
import { formLocationLayer } from "../src/middleware/form-location"
import { permissionLocationLayer } from "../src/middleware/permission-location"

const forbidden: string[] = []
let generation = 1
const config = StandaloneConfig.Service.of({
  snapshot: () => Effect.sync(() => ({ entries: [], generation })),
  reload: () => Effect.void,
  assert: (expected) => Effect.suspend(() => expected === generation ? Effect.void : Effect.fail(new StandaloneConfig.InvalidError({ reason: "stale" }))),
  withCurrent: (expected, use) => Effect.gen(function* () {
    const validate = Effect.suspend(() => expected === generation ? Effect.void : Effect.fail(new StandaloneConfig.InvalidError({ reason: "stale" })))
    yield* validate
    return yield* use(validate)
  }),
})
const database = Database.configured({ path: ":memory:" })
const locations = buildLocationServiceMap([
  [Database.node, database],
  [StandaloneConfig.node, Layer.succeed(StandaloneConfig.Service, config)],
  [StandaloneDecision.node, Layer.succeed(StandaloneDecision.Service, { evaluate: () => Effect.die("Unexpected decision") })],
  [Project.node, Layer.effect(Project.Service, Effect.sync(() => { forbidden.push("project"); throw new Error("Unexpected bound graph") }))],
])
const it = testEffect(AppNodeBuilder.build(LayerNode.group([LocationServiceMap.node, Database.node, EventRuntime.node]), [
  [LocationServiceMap.node, locations],
  [Database.node, database],
]))

it.effect("standalone session form controls settle the execution-owned waiter without a bound Location graph", () => Effect.gen(function* () {
  forbidden.length = 0
  generation = 1
  const db = (yield* Database.Service).db
  const id = Session.ID.make("ses_scoped_form_controls")
  const other = Session.ID.make("ses_other_form_owner")
  const ref = Location.Ref.make({ directory: AbsolutePath.make("/synthetic/form-controls") })
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({ id, project_id: Project.ID.global, directory: ref.directory, scope: "standalone", title: "Synthetic" }).run()
  yield* db.insert(SessionTable).values({ id: other, project_id: Project.ID.global, directory: ref.directory, scope: "standalone", title: "Other" }).run()
  const map = yield* LocationServiceMap.Service
  const context = yield* map.contextEffect(ref, [StandaloneForm.node], "standalone")
  const forms = Context.get(context, StandaloneForm.Service)
  const waiter = yield* forms.ask({ id: Form.ID.make("frm_scoped_controls"), sessionID: id, title: "Synthetic", fields: [{ key: "answer", type: "string", required: true }] }).pipe(Effect.forkChild({ startImmediately: true }))
  const application = yield* Layer.build(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.form"])).pipe(
    Layer.provide(FormHandler),
    Layer.provide(Layer.mergeAll(
      formLocationLayer,
      locationLayer,
      Layer.succeed(Authorization, (effect) => effect),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  ))
  const router = Context.get(application, HttpRouter.HttpRouter)
  const request = (path: string, method = "GET", body?: unknown) => router.asHttpEffect().pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }))),
  )
  const base = `/api/session/${id}/form`
  const listed = yield* request(base)
  expect(listed.status).toBe(200)
  expect((yield* request(`${base}/frm_scoped_controls/state`)).status).toBe(200)
  expect((yield* request(`${base}?location[directory]=/synthetic/other`)).status).toBe(400)
  expect((yield* request(`/api/session/${other}/form/frm_scoped_controls/state`)).status).toBe(404)
  expect((yield* request(`${base}/frm_scoped_controls/reply`, "POST", { answer: { answer: "synthetic" } })).status).toBe(204)
  expect((yield* Fiber.join(waiter)).status).toBe("answered")
  expect((yield* request(`${base}/frm_scoped_controls/reply`, "POST", { answer: { answer: "again" } })).status).toBe(409)
  const cancellation = yield* forms.ask({ id: Form.ID.make("frm_scoped_cancel"), sessionID: id, title: "Synthetic", fields: [{ key: "answer", type: "string" }] }).pipe(Effect.forkChild({ startImmediately: true }))
  expect((yield* request(`${base}/frm_scoped_cancel/cancel`, "POST")).status).toBe(204)
  expect((yield* Fiber.join(cancellation)).status).toBe("cancelled")
  yield* forms.create({ id: Form.ID.make("frm_scoped_stale"), sessionID: id, title: "Stale", fields: [{ key: "answer", type: "string" }] })
  generation++
  expect((yield* request(`${base}/frm_scoped_stale/reply`, "POST", { answer: { answer: "late" } })).status).toBe(400)
  expect((yield* request(`${base}/frm_scoped_stale/state`)).status).toBe(200)
  expect((yield* request(`${base}/frm_scoped_stale/cancel`, "POST")).status).toBe(204)
  expect(forbidden).toEqual([])
}))

it.live("standalone session permission controls settle the execution-owned waiter without a bound Location graph", () => Effect.gen(function* () {
  forbidden.length = 0
  generation = 1
  const db = (yield* Database.Service).db
  const id = Session.ID.make("ses_scoped_permission_controls")
  const other = Session.ID.make("ses_other_permission_owner")
  const ref = Location.Ref.make({ directory: AbsolutePath.make("/synthetic/permission-controls") })
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({ id, project_id: Project.ID.global, directory: ref.directory, scope: "standalone", title: "Synthetic" }).run()
  yield* db.insert(SessionTable).values({ id: other, project_id: Project.ID.global, directory: ref.directory, scope: "standalone", title: "Other" }).run()
  const map = yield* LocationServiceMap.Service
  const context = yield* map.contextEffect(ref, [StandalonePermissionService.node], "standalone")
  const permission = Context.get(context, StandalonePermissionService.Service)
  const requestID = Permission.ID.create("per_scoped_controls")
  const staleID = Permission.ID.create("per_scoped_stale")
  const firstAsked = yield* Deferred.make<void>()
  const staleAsked = yield* Deferred.make<void>()
  const raceID = Permission.ID.create("per_scoped_post_wait")
  const raceAsked = yield* Deferred.make<void>()
  const replying = yield* Deferred.make<void>()
  const releaseReply = yield* Deferred.make<void>()
  const events = yield* EventRuntime.Service
  const stop = yield* events.listen((event) => {
    if (event.type === Permission.Event.Replied.type && typeof event.data === "object" && event.data !== null && Reflect.get(event.data, "requestID") === raceID)
      return Deferred.succeed(replying, undefined).pipe(Effect.andThen(Deferred.await(releaseReply)))
    if (event.type !== Permission.Event.Asked.type || !Schema.is(Permission.Request)(event.data)) return Effect.void
    if (event.data.id === requestID) return Deferred.succeed(firstAsked, undefined).pipe(Effect.asVoid)
    if (event.data.id === staleID) return Deferred.succeed(staleAsked, undefined).pipe(Effect.asVoid)
    if (event.data.id === raceID) return Deferred.succeed(raceAsked, undefined).pipe(Effect.asVoid)
    return Effect.void
  })
  const waiter = yield* permission.assert({ id: requestID, sessionID: id, action: "synthetic", resources: ["example"], requireExplicitDecision: true }).pipe(Effect.forkChild({ startImmediately: true }))
  expect(yield* Effect.raceFirst(Deferred.await(firstAsked).pipe(Effect.as("asked")), Fiber.await(waiter))).toBe("asked")
  const application = yield* Layer.build(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.permission"])).pipe(
    Layer.provide(PermissionHandler),
    Layer.provide(Layer.mergeAll(
      permissionLocationLayer,
      locationLayer,
      Layer.succeed(Authorization, (effect) => effect),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    HttpRouter.provideRequest(Layer.mock(PermissionSaved.Service, { list: () => Effect.die("unused"), add: () => Effect.die("unused"), remove: () => Effect.die("unused") })),
    Layer.provide(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  ))
  const router = Context.get(application, HttpRouter.HttpRouter)
  const request = (path: string, method = "GET", body?: unknown) => router.asHttpEffect().pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }))),
  )
  const base = `/api/session/${id}/permission`
  expect((yield* request(base)).status).toBe(200)
  expect((yield* request(`${base}/${requestID}`)).status).toBe(200)
  expect((yield* request(`${base}?location[directory]=/synthetic/other`)).status).toBe(400)
  expect((yield* request(`/api/session/${other}/permission/${requestID}`)).status).toBe(404)
  expect((yield* request(`${base}/${requestID}/reply`, "POST", { reply: "once" })).status).toBe(204)
  yield* Fiber.join(waiter)
  expect((yield* request(`${base}/${requestID}`)).status).toBe(404)
  const stale = yield* permission.assert({ id: staleID, sessionID: id, action: "synthetic2", resources: ["example"], requireExplicitDecision: true }).pipe(Effect.forkChild({ startImmediately: true }))
  yield* Deferred.await(staleAsked)
  generation++
  expect((yield* request(`${base}/${staleID}/reply`, "POST", { reply: "once" })).status).toBe(400)
  expect((yield* request(`${base}/${staleID}`)).status).toBe(200)
  expect((yield* request(`${base}/${staleID}/reject`, "POST", {})).status).toBe(204)
  expect(Exit.isFailure(yield* Effect.exit(Fiber.join(stale)))).toBe(true)
  const raced = yield* permission.assert({ id: raceID, sessionID: id, action: "synthetic3", resources: ["example"], requireExplicitDecision: true }).pipe(Effect.forkChild({ startImmediately: true }))
  expect(yield* Effect.raceFirst(Deferred.await(raceAsked).pipe(Effect.as("asked")), Fiber.await(raced))).toBe("asked")
  const response = yield* request(`${base}/${raceID}/reply`, "POST", { reply: "once" }).pipe(Effect.forkChild({ startImmediately: true }))
  yield* Deferred.await(replying)
  generation++
  yield* Deferred.succeed(releaseReply, undefined)
  expect((yield* Fiber.join(response)).status).toBe(204)
  expect(Exit.isFailure(yield* Effect.exit(Fiber.join(raced)))).toBe(true)
  yield* stop
  expect(forbidden).toEqual([])
}))
