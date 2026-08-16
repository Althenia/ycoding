import { Database } from "@ycoding-ai/core/database/database"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { Location } from "@ycoding-ai/core/location"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { WorkspaceV2 } from "@ycoding-ai/core/workspace"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import type { LocationServices } from "../location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@ycoding/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)

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
          .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row)
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(row.directory),
                workspaceID: row.workspaceID ? WorkspaceV2.ID.make(row.workspaceID) : undefined,
              }),
            ),
          ),
        )
      }),
    )
  }),
)
