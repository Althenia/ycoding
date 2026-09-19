import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionGoal } from "@ycoding-ai/core/session/goal"
import { Context, Deferred, Effect, Layer } from "effect"
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

const sessionID = SessionV2.ID.make("ses_goal_http")

function fixture(set: SessionV2.Interface["autonomy"]["set"]) {
  // Core outcomes are controlled; this boundary verifies decoding, forwarding, and HTTP settlement.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const location = Context.empty() as Context.Context<LocationServices>
  const services = Layer.mergeAll(
    Layer.mock(SessionV2.Service, {
      autonomy: { get: () => Effect.succeed(SessionAutonomy.defaultState), set },
      revert: { stage: () => Effect.die("unused"), clear: () => Effect.die("unused"), commit: () => Effect.die("unused") },
    }),
    Layer.mock(SessionOrchestration.Service, {}),
    processIdentityLayer(ServiceStatus.Epoch.make("epoch_goal_test")),
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
    request: (payload: Record<string, unknown>) => handler.handler(new Request(`http://localhost/api/session/${sessionID}/autonomy`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    })),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("R7 goal route preserves explicit resume, replacement, and stop with YOLO", async () => {
  const received: unknown[] = []
  await using f = fixture(input => Effect.sync(() => {
    received.push(input)
    return SessionAutonomy.defaultState
  }))
  for (const goal of [true, "Ship the tested change\nPreserve existing data", null]) {
    const response = await f.request({ goal, yolo: 1 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: SessionAutonomy.defaultState })
    expect(received.at(-1)).toEqual({ sessionID, goal, yolo: 1 })
  }
})

test("R7 goal route does not acknowledge before calculation settles", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const settle = Deferred.makeUnsafe<void>()
  await using f = fixture(() => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined)
    yield* Deferred.await(settle)
    return SessionAutonomy.defaultState
  }))
  const state = { settled: false }
  const pending = f.request({ goal: "Verify the release" }).then(response => {
    state.settled = true
    return response
  })
  await Effect.runPromise(Deferred.await(entered))
  expect(state.settled).toBe(false)
  await Effect.runPromise(Deferred.succeed(settle, undefined))
  expect((await pending).status).toBe(200)
})

test("R7 goal route retains the typed missing-Session failure", async () => {
  await using f = fixture(() => Effect.fail(new SessionV2.NotFoundError({ sessionID })))
  const response = await f.request({ goal: true })
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
})

test("R7 goal route maps bounded calculation and resume failures", async () => {
  const cases = [
    { code: "goal.no_retained_goal", status: 400, tag: "InvalidRequestError" },
    { code: "goal.stale_calculation", status: 409, tag: "ConflictError" },
    { code: "goal.model_unavailable", status: 500, tag: "UnknownError" },
    { code: "goal.calculation_failed", status: 500, tag: "UnknownError" },
  ] as const
  for (const item of cases) {
    await using f = fixture(() => Effect.fail(new SessionGoal.Error({ code: item.code })))
    const response = await f.request({ goal: "Verify the release" })
    expect(response.status).toBe(item.status)
    const body = await response.json()
    expect(body).toMatchObject({ _tag: item.tag, message: expect.stringMatching(/goal/i) })
    expect(JSON.stringify(body)).not.toContain("SessionGoal.Error")
    if (item.status === 500) expect(body.ref).toMatch(/^err_[a-f0-9]{8}$/)
  }
})
