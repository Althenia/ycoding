import { expect } from "bun:test"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Form } from "@ycoding-ai/core/form"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { location } from "../../core/test/fixture/location"
import { testEffect } from "../../core/test/lib/effect"
import { Api } from "../src/api"
import { FormHandler } from "../src/handlers/form"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { FormLocationMiddleware } from "../src/middleware/form-location"

const it = testEffect(AppNodeBuilder.build(Form.node, [
  [Database.node, Database.configured({ path: ":memory:" })],
  [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([
    new Config.Document({ type: "document", info: new Config.Info({}) }),
  ]) })],
  [SessionAutonomy.node, Layer.mock(SessionAutonomy.Service, {
    isAsleep: () => Effect.succeed(false), decisionMode: () => Effect.succeed("manual"),
  })],
  [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.die("Human forms do not use decisions") })],
]))

it.effect("session.form.create stays pending after a day and accepts a late validated reply", () => Effect.gen(function* () {
  const form = yield* Form.Service
  const provided = Context.make(Form.Service, form).pipe(Context.add(Location.Service,
    location({ directory: AbsolutePath.make("/tmp/ycoding-form-http") })))
  const services = Context.makeUnsafe<LocationServices>(provided.mapUnsafe)
  const application = yield* Layer.build(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.form"])).pipe(
    Layer.provide(FormHandler),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(FormLocationMiddleware, (effect) => Effect.provide(effect, services)),
      Layer.succeed(LocationMiddleware, (effect) => Effect.provide(effect, services)),
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
  const base = "/api/session/ses_form_timeout/form"
  const created = yield* request(base, "POST", {
    id: "frm_http_timeout", title: "Public form", fields: [{ key: "name", type: "string", required: true }],
  })
  expect(created.status).toBe(200)
  yield* TestClock.adjust("24 hours")
  const state = yield* request(`${base}/frm_http_timeout/state`)
  expect(state.status).toBe(200)
  expect(state.body).toMatchObject({ _tag: "Uint8Array" })
  if (state.body._tag !== "Uint8Array") return yield* Effect.die("Expected a JSON state response")
  expect(JSON.parse(new TextDecoder().decode(state.body.body))).toEqual({ data: { status: "pending" } })
  const listed = yield* request(base)
  if (listed.body._tag !== "Uint8Array") return yield* Effect.die("Expected a JSON list response")
  expect(JSON.parse(new TextDecoder().decode(listed.body.body))).toMatchObject({ data: [{ id: "frm_http_timeout" }] })
  expect((yield* request(`${base}/frm_http_timeout/reply`, "POST", { answer: {} })).status).toBe(400)
  expect((yield* request(`${base}/frm_http_timeout/reply`, "POST", { answer: { name: "Late" } })).status).toBe(204)
  expect((yield* request(`${base}/frm_http_timeout/reply`, "POST", { answer: { name: "Again" } })).status).toBe(409)
}))
