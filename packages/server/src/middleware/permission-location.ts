import { StandaloneConfig } from "@ycoding-ai/core/config/standalone"
import { Database } from "@ycoding-ai/core/database/database"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import { Permission } from "@ycoding-ai/core/permission"
import { StandalonePermissionService } from "@ycoding-ai/core/permission/standalone"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Workspace } from "@ycoding-ai/core/workspace"
import { InvalidRequestError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export class SessionPermission extends Context.Service<SessionPermission, Permission.Interface<StandaloneConfig.InvalidError>>()("@ycoding/HttpApiSessionPermission") {}

export class PermissionLocationMiddleware extends HttpApiMiddleware.Service<PermissionLocationMiddleware, { provides: SessionPermission }>()(
  "@ycoding/HttpApiPermissionLocation", { error: [InvalidRequestError, SessionNotFoundError] },
) {}

export const permissionLocationLayer = Layer.effect(PermissionLocationMiddleware, Effect.gen(function* () {
  const { db } = yield* Database.Service
  const locations = yield* LocationServiceMap.Service
  return PermissionLocationMiddleware.of((effect) => Effect.gen(function* () {
    const route = yield* HttpRouter.RouteContext
    const sessionID = yield* Schema.decodeUnknownEffect(Session.ID)(route.params.sessionID).pipe(
      Effect.mapError(() => new InvalidRequestError({ message: "Invalid session ID", field: "sessionID" })),
    )
    const row = yield* db.select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id, scope: SessionTable.scope })
      .from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!row) return yield* new SessionNotFoundError({ sessionID, message: `Session not found: ${sessionID}` })
    const request = yield* HttpServerRequest.HttpServerRequest
    const query = new URL(request.url, "http://localhost").searchParams
    const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
    const directories = [...query.getAll("location[directory]"), request.headers["x-ycoding-directory"] === undefined ? null : decode(request.headers["x-ycoding-directory"])]
    const workspaces = [...query.getAll("location[workspace]"), request.headers["x-ycoding-workspace"] ?? null]
    if (directories.some((value) => value !== null && value !== row.directory) || workspaces.some((value) => value !== null && value !== row.workspaceID))
      return yield* new InvalidRequestError({ message: "Session location does not match the recorded placement" })
    const ref = Location.Ref.make({ directory: AbsolutePath.make(row.directory), workspaceID: row.workspaceID ? Workspace.ID.make(row.workspaceID) : undefined })
    if (row.scope === "standalone") {
      return yield* Effect.gen(function* () {
        const permission = yield* StandalonePermissionService.Service
        return yield* effect.pipe(Effect.provideService(SessionPermission, permission))
      }).pipe(
        Effect.provide(locations.get(ref, [StandalonePermissionService.node], "standalone")),
        Effect.catchTag("Session.ScopeUnavailableError", () => Effect.fail(new InvalidRequestError({ message: "Standalone Session operation is unavailable" }))),
      )
    }
    return yield* Effect.gen(function* () {
      const permission = yield* Permission.Service
      return yield* effect.pipe(Effect.provideService(SessionPermission, permission))
    }).pipe(Effect.provide(locations.get(ref, [LocationServiceMap.full])))
  }).pipe(Effect.catchTag("StandaloneConfig.InvalidError", () => Effect.fail(new InvalidRequestError({ message: "Standalone configuration is unavailable" })))))
}))
