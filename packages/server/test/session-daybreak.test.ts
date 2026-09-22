import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Api } from "../src/api"
import { SessionHandler } from "../src/handlers/session"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { processIdentityLayer } from "../src/process-identity"

const sessionID = SessionV2.ID.make("ses_daybreak_http")

function info(daybreak: SessionV2.Info["daybreak"]) {
  return SessionV2.Info.make({
    id: sessionID,
    projectID: ProjectV2.ID.global,
    title: "test",
    daybreak,
    cost: Schema.decodeUnknownSync(SessionV2.Info.fields.cost)(0),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  })
}

function fixture(set: SessionV2.Interface["daybreak"]["set"]) {
  // Core outcomes are controlled; this boundary verifies decoding, forwarding, and HTTP settlement.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const location = Context.empty() as Context.Context<LocationServices>
  const services = Layer.mergeAll(
    Layer.mock(SessionV2.Service, {
      daybreak: { set },
      autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused") },
      revert: { stage: () => Effect.die("unused"), clear: () => Effect.die("unused"), commit: () => Effect.die("unused") },
    }),
    Layer.mock(SessionOrchestration.Service, {}),
    processIdentityLayer(ServiceStatus.Epoch.make("epoch_daybreak_test")),
    Layer.succeed(SessionLocationMiddleware, effect => Effect.provide(effect, location)),
    Layer.succeed(LocationMiddleware, effect => Effect.provide(effect, location)),
    Layer.succeed(Authorization, effect => effect),
    Layer.succeed(SchemaErrorMiddleware, effect => effect),
  )
  const handler = HttpRouter.toWebHandler(HttpApiBuilder.layer(HttpApi.make("server").add(Api.groups["server.session"])).pipe(
    Layer.provide(SessionHandler.pipe(Layer.provide(services))),
    Layer.provide(HttpServer.layerServices),
  ))
  return {
    request: (payload: Record<string, unknown>) => handler.handler(new Request(`http://localhost/api/session/${sessionID}/daybreak`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    })),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("session.daybreak.set forwards set and clear payloads with the updated Session info", async () => {
  const received: unknown[] = []
  await using f = fixture(input => Effect.sync(() => {
    received.push(input)
    return info(input.daybreak ?? undefined)
  }))
  for (const daybreak of ["daybreak_blue", "daybreak_red", null] as const) {
    const response = await f.request({ daybreak })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toMatchObject({ id: sessionID, title: "test" })
    expect(body.data.daybreak).toBe(daybreak ?? undefined)
    expect(received.at(-1)).toEqual({ sessionID, daybreak })
  }
})

test("session.daybreak.set maps the missing-Session failure", async () => {
  await using f = fixture(() => Effect.fail(new SessionV2.NotFoundError({ sessionID })))
  const response = await f.request({ daybreak: "daybreak_blue" })
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
})
