import { Database } from "@ycoding-ai/core/database/database"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Workspace } from "@ycoding-ai/core/workspace"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import { isBrowserConnectURL } from "@ycoding-ai/protocol/groups/browser"
import type { LocationServices } from "../location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@ycoding/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

export const sessionLocationID = (params: Readonly<Record<string, string | undefined>>) =>
  params.sessionID ?? params.parentID

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const locations = yield* LocationServiceMap.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const request = yield* HttpServerRequest.HttpServerRequest
        if (isBrowserConnectURL(new URL(request.url, "http://localhost")))
          return yield* effect.pipe(
            Effect.provide(
              locations.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }), [LocationServiceMap.full]),
            ),
          )
        const sessionID = yield* decodeSessionID(sessionLocationID(route.params)).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const row = yield* db
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id, scope: SessionTable.scope, projectID: SessionTable.project_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row)
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })

        const url = new URL(request.url, "http://localhost")
        const query = url.searchParams
        const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
        const directories = [...query.getAll("location[directory]"), request.headers["x-ycoding-directory"] === undefined ? null : decode(request.headers["x-ycoding-directory"])]
        const workspaces = [...query.getAll("location[workspace]"), request.headers["x-ycoding-workspace"] ?? null]
        if (directories.some((value) => value !== null && value !== row.directory) || workspaces.some((value) => value !== null && value !== row.workspaceID))
          return yield* new InvalidRequestError({ message: "Session location does not match the recorded placement" })
        const ref = Location.Ref.make({ directory: AbsolutePath.make(row.directory), workspaceID: row.workspaceID ? Workspace.ID.make(row.workspaceID) : undefined })
        if (row.scope === "standalone") {
          if (request.method !== "GET" || url.pathname !== `/api/session/${sessionID}`)
            return yield* new InvalidRequestError({ message: "Standalone Session operation is unavailable" })
          const context = Context.make(Location.Service, Location.Service.of({ ...ref, project: { id: row.projectID, directory: ref.directory } }))
          return yield* Effect.provide(effect, Context.makeUnsafe<LocationServices>(context.mapUnsafe))
        }

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(row.directory),
                workspaceID: row.workspaceID ? Workspace.ID.make(row.workspaceID) : undefined,
              }),
              [LocationServiceMap.full],
            ),
          ),
        )
      }),
    )
  }),
)
