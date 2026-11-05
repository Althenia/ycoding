import { Database } from "@ycoding-ai/core/database/database"
import { StandaloneConfig } from "@ycoding-ai/core/config/standalone"
import { Form } from "@ycoding-ai/core/form"
import { StandaloneForm } from "@ycoding-ai/core/form/standalone"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Workspace } from "@ycoding-ai/core/workspace"
import { InvalidRequestError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { requestRef } from "../location"

export class SessionForm extends Context.Service<SessionForm, Form.Interface<StandaloneConfig.InvalidError>>()("@ycoding/HttpApiSessionForm") {}

export class FormLocationMiddleware extends HttpApiMiddleware.Service<
  FormLocationMiddleware,
  { provides: SessionForm }
>()("@ycoding/HttpApiFormLocation", {
  error: [InvalidRequestError, SessionNotFoundError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

export const formLocationLayer = Layer.effect(
  FormLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap.Service

    return FormLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        if (route.params.sessionID === "global") {
          // Temporary MCP elicitation escape hatch. This is still Location-scoped; it only bypasses
          // the session row lookup because some MCP elicitations cannot currently be attributed to
          // a real session. Keep this undocumented and remove once elicitations carry session ownership.
          const request = yield* HttpServerRequest.HttpServerRequest
          return yield* Effect.gen(function* () {
            const form = yield* Form.Service
            return yield* effect.pipe(Effect.provideService(SessionForm, form))
          }).pipe(Effect.provide(locations.get(requestRef(request), [LocationServiceMap.full])))
        }

        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const row = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id, scope: SessionTable.scope })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) {
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })
        }

        const request = yield* HttpServerRequest.HttpServerRequest
        const query = new URL(request.url, "http://localhost").searchParams
        const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
        const directories = [...query.getAll("location[directory]"), request.headers["x-ycoding-directory"] === undefined ? null : decode(request.headers["x-ycoding-directory"])]
        const workspaces = [...query.getAll("location[workspace]"), request.headers["x-ycoding-workspace"] ?? null]
        if (row.scope === "standalone" && (directories.some((value) => value !== null && value !== row.directory) || workspaces.some((value) => value !== null && value !== row.workspaceID)))
          return yield* new InvalidRequestError({ message: "Session location does not match the recorded placement" })
        const ref = Location.Ref.make({ directory: AbsolutePath.make(row.directory), workspaceID: row.workspaceID ? Workspace.ID.make(row.workspaceID) : undefined })
        if (row.scope === "standalone") {
          return yield* Effect.gen(function* () {
            const form = yield* StandaloneForm.Service
            return yield* effect.pipe(Effect.provideService(SessionForm, form))
          }).pipe(
            Effect.provide(locations.get(ref, [StandaloneForm.node], "standalone")),
            Effect.catchTag("Session.ScopeUnavailableError", () => Effect.fail(new InvalidRequestError({ message: "Standalone Session operation is unavailable" }))),
          )
        }
        return yield* Effect.gen(function* () {
          const form = yield* Form.Service
          return yield* effect.pipe(Effect.provideService(SessionForm, form))
        }).pipe(Effect.provide(locations.get(ref, [LocationServiceMap.full])))
      }).pipe(Effect.catchTag("StandaloneConfig.InvalidError", () => Effect.fail(new InvalidRequestError({ message: "Standalone configuration is unavailable" })))),
    )
  }),
)
