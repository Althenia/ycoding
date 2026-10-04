import { Session } from "@ycoding-ai/core/session"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { Authorization } from "@ycoding-ai/protocol/middleware/authorization"
import { SchemaErrorMiddleware } from "@ycoding-ai/protocol/middleware/schema-error"
import { ServiceStatus } from "@ycoding-ai/protocol/groups/health"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { SessionHandler } from "../src/handlers/session"
import { GuardrailHandler } from "../src/handlers/guardrail"
import { LocationMiddleware, type LocationServices } from "../src/location"
import { SessionLocationMiddleware } from "../src/middleware/session-location"
import { processIdentityLayer } from "../src/process-identity"

export const sessionHttpEpoch = ServiceStatus.Epoch.make("epoch_session_http")

export function sessionHttp(
  session: Partial<Session.Interface>,
  options: {
    orchestration?: Partial<SessionOrchestration.Interface>
    guardrail?: Partial<SessionGuardrail.Interface>
    onLocation?: () => void
  } = {},
) {
  const location = Context.makeUnsafe<LocationServices>(new Map())
  const services = Layer.mergeAll(
    Layer.mock(Session.Service, {
      autonomy: { get: () => Effect.die("unused"), set: () => Effect.die("unused") },
      daybreak: { set: () => Effect.die("unused") },
      revert: {
        stage: () => Effect.die("unused"),
        clear: () => Effect.die("unused"),
        commit: () => Effect.die("unused"),
      },
      ...session,
    }),
    Layer.mock(SessionOrchestration.Service, options.orchestration ?? {}),
    Layer.mock(SessionGuardrail.Service, options.guardrail ?? {}),
    processIdentityLayer(sessionHttpEpoch),
    Layer.succeed(
      SessionLocationMiddleware,
      SessionLocationMiddleware.of((effect) =>
        Effect.sync(() => options.onLocation?.()).pipe(Effect.andThen(Effect.provide(effect, location))),
      ),
    ),
    Layer.succeed(LocationMiddleware, (effect) => Effect.provide(effect, location)),
    Layer.succeed(Authorization, (effect) => effect),
    Layer.succeed(SchemaErrorMiddleware, (effect) => effect),
  )
  const handler = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(
      HttpApi.make("server").add(Api.groups["server.session"]).add(Api.groups["server.guardrail"]),
    ).pipe(
      Layer.provide(Layer.merge(SessionHandler, GuardrailHandler).pipe(Layer.provide(services))),
      Layer.provide(HttpServer.layerServices),
    ),
  )
  return {
    request: (path: string, init?: RequestInit) => handler.handler(new Request(`http://localhost${path}`, init)),
    json: (path: string, method: string, body: unknown) =>
      handler.handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    [Symbol.asyncDispose]: () => handler.dispose(),
  }
}
