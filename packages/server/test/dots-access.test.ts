import { expect, test } from "bun:test"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { UnauthorizedError } from "@ycoding-ai/protocol/errors"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { DotsHandler } from "../src/handlers/dots"

test("global Dots HTTP requires authentication without Session middleware and enforces exact CAS payloads", async () => {
  let state = { enabled: false, revision: 0 }
  const calls: unknown[] = []
  const service = DotsAccess.Service.of({
    get: () => Effect.succeed(state),
    status: () => Effect.succeed({ access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "off" } }),
    set: (input) => Effect.gen(function* () {
      calls.push(input)
      if (input.expectedRevision !== state.revision) return yield* new DotsAccess.Error({ code: "conflict", message: "Stale revision" })
      if (state.enabled !== input.enabled) state = { enabled: input.enabled, revision: state.revision + 1 }
      return state
    }),
    attachComputer: () => Effect.sync(() => {
      calls.push("attach")
      return { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "connected" }, computer: { state: "attached" } }
    }),
    subscribe: () => () => {},
    attachTransport: () => () => {},
  })
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.dots"]).middleware(Authorization).middleware(SchemaErrorMiddleware)).pipe(
    Layer.provide(DotsHandler),
    Layer.provide(Layer.mergeAll(
      Layer.succeed(Authorization, (effect) => Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers.authorization !== "Bearer synthetic") return yield* new UnauthorizedError({ message: "Authentication required" })
        return yield* effect
      })),
      Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
    )),
    Layer.provide(HttpServer.layerServices),
  ))
  const request = (method: string, body?: unknown, pathname = "/api/dots", authenticated = true) => handler.handler(new Request(`http://localhost${pathname}`, {
    method, headers: { ...(authenticated ? { authorization: "Bearer synthetic" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), Context.make(DotsAccess.Service, service))
  try {
    expect((await request("GET", undefined, "/api/dots", false)).status).toBe(401)
    expect((await request("PUT", { enabled: true, expectedRevision: 0 }, "/api/dots", false)).status).toBe(401)
    expect(calls).toEqual([])
    expect(await (await request("GET")).json()).toEqual({ data: { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "off" } } })
    for (const body of [{ enabled: true }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 0, sessionID: "ses_root" }, { enabled: true, expectedRevision: 0, source: {} }, { enabled: true, expectedRevision: 0, explicitDecision: true }, { enabled: true, expectedRevision: 0, validate: true }])
      expect((await request("PUT", body)).status).toBe(400)
    expect(calls).toHaveLength(0)
    const accepted = await request("PUT", { enabled: true, expectedRevision: 0 })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ data: { access: { enabled: true, revision: 1 }, configuration: { ready: true, profile: "trusted" }, connection: { state: "off" } } })
    expect((await request("PUT", { enabled: false, expectedRevision: 0 })).status).toBe(409)
    expect((await request("POST", { enabled: false, expectedRevision: 1 })).status).toBe(404)
    expect((await request("GET", undefined, "/api/session/ses_root/dots/access")).status).toBe(404)
    calls.length = 0
    expect((await request("POST", { replaceOthers: true }, "/api/dots/computer", false)).status).toBe(401)
    for (const body of [{}, { replaceOthers: false }, { replaceOthers: "true" }, { replaceOthers: true, environmentID: "env_other" }])
      expect((await request("POST", body, "/api/dots/computer")).status).toBe(400)
    expect(calls).toEqual([])
    const attached = await request("POST", { replaceOthers: true }, "/api/dots/computer")
    expect(attached.status).toBe(200)
    expect(await attached.json()).toEqual({ data: { access: state, configuration: { ready: true, profile: "trusted" }, connection: { state: "connected" }, computer: { state: "attached" } } })
    expect(calls).toEqual(["attach"])
  } finally {
    await handler.dispose()
  }
})
