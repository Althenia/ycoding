import { expect, test } from "bun:test"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { Session } from "@ycoding-ai/core/session"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { DotsHandler } from "../src/handlers/dots"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import type { LocationServices } from "../src/location"

test("Dots access HTTP exposes exact payloads, rejects authority fields, and returns stale conflicts", async () => {
  const root = Session.ID.make("ses_root")
  let state = { sessionID: root, rootSessionID: root, enabled: false, revision: 0, inherited: false, configured: true }
  const calls: unknown[] = []
  const service = DotsAccess.Service.of({
    get: (sessionID) => sessionID === root ? Effect.succeed(state) : Effect.fail(new DotsAccess.Error({ code: "unavailable", message: "Unavailable" })),
    set: (input) => Effect.gen(function* () {
      calls.push(input)
      if (input.sessionID !== root) return yield* new DotsAccess.Error({ code: "root_required", message: "Root required" })
      if (input.expectedRevision !== state.revision) return yield* new DotsAccess.Error({ code: "conflict", message: "Stale revision" })
      if (state.enabled !== input.enabled) state = { ...state, enabled: input.enabled, revision: state.revision + 1 }
      return state
    }),
  })
  const location = Context.makeUnsafe<LocationServices>(Context.make(DotsAccess.Service, service).mapUnsafe)
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.dots"])).pipe(
    Layer.provide(DotsHandler),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(SessionLocationMiddleware, (effect) => Effect.provide(effect, location)),
      Layer.succeed(Authorization, (effect) => effect),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    Layer.provide(HttpServer.layerServices),
  ))
  const request = (method: string, body?: unknown, sessionID = root) => handler.handler(new Request(`http://localhost/api/session/${sessionID}/dots/access`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), Context.empty())
  try {
    expect(await (await request("GET")).json()).toEqual({ data: state })
    for (const body of [{ enabled: true }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 0, source: {} }, { enabled: true, expectedRevision: 0, explicitDecision: true }, { enabled: true, expectedRevision: 0, validate: true }])
      expect((await request("POST", body)).status).toBe(400)
    expect(calls).toHaveLength(0)
    const accepted = await request("POST", { enabled: true, expectedRevision: 0 })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ data: { ...state, enabled: true, revision: 1 } })
    expect((await request("POST", { enabled: false, expectedRevision: 0 })).status).toBe(409)
    expect((await request("GET", undefined, Session.ID.make("ses_missing"))).status).toBe(404)
    expect((await request("POST", { enabled: false, expectedRevision: 1 }, Session.ID.make("ses_child"))).status).toBe(400)
  } finally {
    await handler.dispose()
  }
})
