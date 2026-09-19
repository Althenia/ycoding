import { expect, test } from "bun:test"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Integration } from "@ycoding-ai/core/integration"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
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

const sessionID = SessionV2.ID.make("ses_switch_http")
const model = ModelV2.Ref.make({ id: ModelV2.ID.make("target"), providerID: ProviderV2.ID.make("test") })

function fixture(switchModel: SessionV2.Interface["switchModel"]) {
  // The handler captures Core services; Location/auth lookup is outside this HTTP mapping boundary.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const location = Context.empty() as Context.Context<LocationServices>
  const services = Layer.mergeAll(
    Layer.mock(SessionV2.Service, {
      switchModel,
      autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused") },
      revert: { stage: () => Effect.die("unused"), clear: () => Effect.die("unused"), commit: () => Effect.die("unused") },
    }),
    Layer.mock(SessionOrchestration.Service, {}),
    processIdentityLayer(ServiceStatus.Epoch.make("epoch_switch_test")),
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
    request: () => handler.handler(new Request(`http://localhost/api/session/${sessionID}/model`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
    })),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}

test("R1-F returns 204 only after Core switch settlement", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const settle = Deferred.makeUnsafe<void>()
  await using f = fixture(input => Effect.gen(function* () {
    expect(input).toEqual({ sessionID, model })
    yield* Deferred.succeed(entered, undefined)
    yield* Deferred.await(settle)
    return { status: "switched" as const }
  }))
  const state = { resolved: false }
  const pending = f.request().then(response => { state.resolved = true; return response })
  await Effect.runPromise(Deferred.await(entered))
  expect(state.resolved).toBe(false)
  await Effect.runPromise(Deferred.succeed(settle, undefined))
  const response = await pending
  expect(response.status).toBe(204)
  expect(await response.text()).toBe("")
})

test("R1-F maps target and authorization failures to safe actionable HTTP errors", async () => {
  const cases = [
    new SessionRunnerModel.ModelUnavailableError({ providerID: model.providerID, modelID: model.id }),
    new SessionRunnerModel.VariantUnavailableError({ providerID: model.providerID, modelID: model.id, variant: ModelV2.VariantID.make("missing") }),
    new SessionRunnerModel.ModelNotSelectedError({ sessionID }),
    new SessionRunnerModel.UnsupportedPackageError({ providerID: model.providerID, modelID: model.id, package: "sensitive-package-detail" }),
    new Integration.AuthorizationError({ cause: "sensitive-authorization-detail" }),
    new SessionV2.CompactionConflictError({ sessionID, jobID: Schema.decodeUnknownSync(SessionV2.CompactionConflictError.fields.jobID)("cmp_switch_test"), message: "sensitive-helper-detail" }),
  ]
  for (const error of cases) {
    await using f = fixture(() => Effect.fail(error))
    const response = await f.request()
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toMatchObject({ _tag: "UnknownError", ref: expect.stringMatching(/^err_[a-f0-9]{8}$/) })
    expect(body.message).toMatch(/model|provider|compaction/i)
    expect(JSON.stringify(body)).not.toContain("sensitive-")
    expect(JSON.stringify(body)).not.toContain(error._tag)
  }
})

test("R1-F retains structured budget refusal and missing-session responses", async () => {
  const blocked = {
    status: "blocked" as const, currentModel: model, targetModel: model,
    currentContextTokens: 200, targetSafeInputTokens: 100, requiredReductionTokens: 100,
    reason: "context-window-exceeded" as const,
  }
  await using refused = fixture(() => Effect.succeed(blocked))
  const response = await refused.request()
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ _tag: "ModelSwitchBlockedError", ...blocked })
  await using missing = fixture(() => Effect.fail(new SessionV2.NotFoundError({ sessionID })))
  const absent = await missing.request()
  expect(absent.status).toBe(404)
  expect(await absent.json()).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
})
