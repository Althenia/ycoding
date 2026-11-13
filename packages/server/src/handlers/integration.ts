import { AccountConnectors } from "@ycoding-ai/core/account-connectors"
import { Integration } from "@ycoding-ai/core/integration"
import { Location } from "@ycoding-ai/core/location"
import { Session } from "@ycoding-ai/core/session"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { response } from "../location"
import { WellKnown } from "@ycoding-ai/core/wellknown"

const authorize = <A, R>(effect: Effect.Effect<A, Integration.AuthorizationError, R>) =>
  effect.pipe(
    Effect.mapError(
      () =>
        new InvalidRequestError({
          message: "Authentication failed",
          kind: "integration_authorization",
        }),
    ),
  )

export const IntegrationHandler = HttpApiBuilder.group(Api, "server.integration", (handlers) =>
  Effect.gen(function* () {
    return handlers
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
      .handle(
        "integration.accountSkills.read",
        Effect.fn(function* (ctx) {
          if (ctx.params.integrationID !== "openai") {
            return yield* new InvalidRequestError({
              message: "Account skills are only supported for the openai integration",
              kind: "unsupported_integration",
            })
          }
          if (!ctx.query.sessionID) {
            return yield* new InvalidRequestError({
              message: "Session provenance is required",
              kind: "missing_provenance",
            })
          }
          const sessionService = yield* Session.Service
          const targetSession = yield* sessionService.get(ctx.query.sessionID).pipe(
            Effect.option,
            Effect.map(Option.getOrUndefined),
          )
          if (!targetSession) {
            return yield* new InvalidRequestError({
              message: "Session not found",
              kind: "session_not_found",
            })
          }
          const location = yield* Location.Service
          if (
            targetSession.location.directory !== location.directory ||
            (targetSession.location.workspaceID ?? "") !== (location.workspaceID ?? "")
          ) {
            return yield* new InvalidRequestError({
              message: "Session does not belong to the requested location",
              kind: "cross_location_session",
            })
          }
          if (!targetSession.agent) {
            return yield* new InvalidRequestError({
              message: "Session has no configured agent",
              kind: "missing_session_agent",
            })
          }
          if (ctx.query.agent && ctx.query.agent !== targetSession.agent) {
            return yield* new InvalidRequestError({
              message: "Agent does not match session agent",
              kind: "agent_mismatch",
            })
          }
          const connectors = yield* AccountConnectors.Service
          const reader = yield* connectors
            .skillsRead({
              profile: ctx.query.profile,
              permission: {
                sessionID: targetSession.id,
                agent: targetSession.agent,
              },
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new InvalidRequestError({
                    message: error.message,
                    kind: "account_skills_configuration",
                  }),
              ),
            )
          const list = yield* reader
            .list()
            .pipe(
              Effect.mapError(
                (error) =>
                  new InvalidRequestError({
                    message: error.message,
                    kind: error.message.includes("Permission denied")
                      ? "permission_denied"
                      : "account_skills_read",
                  }),
              ),
            )
          let detail: { status: number; keys: readonly string[] } | undefined
          let detailID: string | undefined
          if (ctx.query.id !== undefined) {
            if (!list.ids.includes(ctx.query.id)) {
              return yield* new InvalidRequestError({
                message: "Requested skill ID was not returned by account skills list",
                kind: "unlisted_skill_id",
              })
            }
            detailID = ctx.query.id
          } else {
            detailID = list.ids[0]
          }
          if (detailID !== undefined) {
            const result = yield* reader
              .detail(detailID)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new InvalidRequestError({
                      message: error.message,
                      kind: "account_skills_read",
                    }),
                ),
              )
            detail = { status: result.status, keys: result.keys }
          }
          return yield* response(
            Effect.succeed({
              status: list.status,
              keys: list.keys,
              count: list.count,
              hasNext: list.hasNext,
              paginationKeys: list.paginationKeys,
              detail,
            }),
          )
        }),
      )
  }),
)
