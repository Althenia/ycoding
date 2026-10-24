import { expect, test } from "bun:test"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { Session } from "@ycoding-ai/core/session"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { PermissionHandler } from "../src/handlers/permission"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { SessionLocationMiddleware } from "../src/middleware/session-location"

test("request-only permission rejection preserves ownership, feedback, and missing-request failures", async () => {
  const request: Permission.Request = {
    id: Permission.ID.create("per_owned"),
    sessionID: Session.ID.make("ses_owner"),
    action: "bash",
    resources: ["git status"],
    escalation: { reason: "unsupported-output" },
  }
  const calls: Permission.ReplyInput[] = []
  const service = Permission.Service.of({
    evaluateEffective: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    assert: () => Effect.die("unused"),
    deferPending: () => Effect.die("unused"),
    snapshot: () => Effect.die("unused"),
    snapshots: () => Effect.die("unused"),
    reconsider: () => Effect.die("unused"),
    escalate: () => Effect.die("unused"),
    get: (id) => Effect.succeed(id === request.id ? request : undefined),
    list: () => Effect.succeed([request]),
    forSession: (id) => Effect.succeed(id === request.sessionID ? [request] : []),
    reply: (input) =>
      input.message === "settled"
        ? Effect.fail(new Permission.NotFoundError({ requestID: input.requestID }))
        : Effect.sync(() => {
            calls.push(input)
          }),
  })
  const location = Context.makeUnsafe<LocationServices>(Context.make(Permission.Service, service).mapUnsafe)
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.permission"])).pipe(
      Layer.provide(PermissionHandler),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SessionLocationMiddleware, (effect) => Effect.provide(effect, location)),
          Layer.succeed(LocationMiddleware, (effect) => Effect.provide(effect, location)),
          Layer.succeed(Authorization, (effect) => effect),
          Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  const post = (sessionID: string, requestID: string, action: string, payload: unknown) =>
    handler.handler(
      new Request(`http://localhost/api/session/${sessionID}/permission/${requestID}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      Context.make(PermissionSaved.Service, {
        list: () => Effect.die("unused"),
        add: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      }),
    )
  try {
    const listed = await handler.handler(
      new Request(`http://localhost/api/session/${request.sessionID}/permission`),
      Context.make(PermissionSaved.Service, {
        list: () => Effect.die("unused"),
        add: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      }),
    )
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ data: [request] })
    expect((await post(request.sessionID, request.id, "reject", {})).status).toBe(204)
    expect(
      (await post(request.sessionID, request.id, "reject", { message: "Use a read-only alternative" })).status,
    ).toBe(204)
    expect((await post(request.sessionID, request.id, "reply", { reply: "reject" })).status).toBe(204)
    const wrongSession = await post("ses_unrelated", request.id, "reject", {})
    expect(wrongSession.status).toBe(404)
    expect(await wrongSession.json()).toMatchObject({ _tag: "PermissionNotFoundError", requestID: request.id })
    expect((await post(request.sessionID, "per_missing", "reject", {})).status).toBe(404)
    expect((await post(request.sessionID, request.id, "reject", { message: 42 })).status).toBe(400)
    const settled = await post(request.sessionID, request.id, "reject", { message: "settled" })
    expect(settled.status).toBe(404)
    expect(await settled.json()).toMatchObject({ _tag: "PermissionNotFoundError", requestID: request.id })
    expect(calls).toEqual([
      { requestID: request.id, reply: "reject", rejectScope: "request", message: undefined },
      { requestID: request.id, reply: "reject", rejectScope: "request", message: "Use a read-only alternative" },
      { requestID: request.id, reply: "reject", message: undefined },
    ])
  } finally {
    await handler.dispose()
  }
})
