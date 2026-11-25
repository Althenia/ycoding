import { AccountConnectors } from "@ycoding-ai/core/account-connectors"
import { Integration } from "@ycoding-ai/core/integration"
import { Provider } from "@ycoding-ai/core/provider"
import { AccountSkillsRead } from "@ycoding-ai/core/account-connectors/skills-read"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Session } from "@ycoding-ai/core/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { response } from "../location"
import { WellKnown } from "@ycoding-ai/core/wellknown"

const authorize = <A, R>(effect: Effect.Effect<A, Integration.AuthorizationError, R>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new InvalidRequestError({
          message: error.cause instanceof Provider.RetiredError ? error.cause.message : "Authentication failed",
          kind: "integration_authorization",
        }),
    ),
  )

export const IntegrationHandler = HttpApiBuilder.group(Api, "server.integration", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const locations = yield* LocationServiceMap.Service
    return handlers
      .handle(
        "integration.accountSkills.read",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          return yield* response(
            AccountSkillsRead.read({ integrationID: ctx.params.integrationID, ...ctx.query }).pipe(
              Effect.provideService(Session.Service, sessions),
              Effect.provide(
                locations.get(Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }), [
                  AccountConnectors.node,
                ]),
              ),
              Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: error.kind })),
            ),
          )
        }),
      )
      .handle(
        "integration.list",
        Effect.fn(function* () {
          const service = yield* Integration.Service
          return yield* response(service.list())
        }),
      )
      .handle(
        "integration.get",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          return yield* response(service.get(ctx.params.integrationID))
        }),
      )
      .handle(
        "integration.wellknown.add",
        Effect.fn(function* (ctx) {
          const wellknown = yield* WellKnown.Service
          const integration = yield* Integration.Service
          yield* wellknown
            .add(ctx.payload.url)
            .pipe(
              Effect.mapError(
                (error) => new InvalidRequestError({ message: error.message, kind: "well_known_discovery" }),
              ),
            )
          yield* integration.reload()
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "integration.connect.key",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          yield* authorize(
            service.connection.key({
              integrationID: ctx.params.integrationID,
              key: ctx.payload.key,
              label: ctx.payload.label,
              credentialID: ctx.payload.credentialID,
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "integration.oauth.connect",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          return yield* response(
            authorize(
              service.oauth.connect({
                integrationID: ctx.params.integrationID,
                methodID: ctx.payload.methodID,
                inputs: ctx.payload.inputs,
                label: ctx.payload.label,
                credentialID: ctx.payload.credentialID,
              }),
            ),
          )
        }),
      )
      .handle(
        "integration.oauth.status",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          return yield* response(
            service.oauth.status({
              integrationID: ctx.params.integrationID,
              attemptID: ctx.params.attemptID,
            }),
          )
        }),
      )
      .handle(
        "integration.oauth.complete",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          yield* service.oauth
            .complete({
              integrationID: ctx.params.integrationID,
              attemptID: ctx.params.attemptID,
              code: ctx.payload.code,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new InvalidRequestError({
                    message:
                      error._tag === "Integration.CodeRequired"
                        ? "Authorization code is required"
                        : "Authentication failed",
                    kind:
                      error._tag === "Integration.CodeRequired"
                        ? "integration_code_required"
                        : "integration_authorization",
                  }),
              ),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "integration.oauth.cancel",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          yield* service.oauth.cancel({
            integrationID: ctx.params.integrationID,
            attemptID: ctx.params.attemptID,
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "integration.command.connect",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          return yield* response(
            authorize(
              service.command.connect({
                integrationID: ctx.params.integrationID,
                methodID: ctx.payload.methodID,
                label: ctx.payload.label,
              }),
            ),
          )
        }),
      )
      .handle(
        "integration.command.status",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          return yield* response(
            service.command.status({
              integrationID: ctx.params.integrationID,
              attemptID: ctx.params.attemptID,
            }),
          )
        }),
      )
      .handle(
        "integration.command.cancel",
        Effect.fn(function* (ctx) {
          const service = yield* Integration.Service
          yield* service.command.cancel({
            integrationID: ctx.params.integrationID,
            attemptID: ctx.params.attemptID,
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
