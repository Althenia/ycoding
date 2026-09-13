import { IsolatedBrowser } from "@ycoding-ai/core/isolated-browser"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
} from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

function mapSessionNotFound(error: { readonly sessionID: string }) {
  return new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` })
}

function mapOperation(
  error:
    | IsolatedBrowser.UnavailableError
    | IsolatedBrowser.OwnershipError
    | IsolatedBrowser.FenceError
    | IsolatedBrowser.BusyError
    | { readonly _tag: "Session.NotFoundError"; readonly sessionID: string },
) {
  if (error._tag === "Session.NotFoundError") return mapSessionNotFound(error)
  if (error._tag === "IsolatedBrowser.OwnershipError") return new ForbiddenError({ message: error.message })
  if (error._tag === "IsolatedBrowser.FenceError" || error._tag === "IsolatedBrowser.BusyError")
    return new ConflictError({ message: error.message })
  if (error._tag === "IsolatedBrowser.UnavailableError")
    return new ServiceUnavailableError({ message: error.message, service: "isolated-browser" })
  return new InvalidRequestError({ message: "Isolated browser operation failed" })
}

export const IsolatedBrowserHandler = HttpApiBuilder.group(Api, "server.isolatedBrowser", (handlers) =>
  Effect.succeed(
    handlers
      .handle(
        "isolatedBrowser.status",
        Effect.fn(function* (ctx) {
          const browser = yield* IsolatedBrowser.Service
          return { data: yield* browser.status(ctx.params.sessionID).pipe(Effect.mapError(mapSessionNotFound)) }
        }),
      )
      .handle(
        "isolatedBrowser.start",
        Effect.fn(function* (ctx) {
          const browser = yield* IsolatedBrowser.Service
          return {
            data: yield* browser.start(ctx.params.sessionID, ctx.payload).pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "isolatedBrowser.tabs",
        Effect.fn(function* (ctx) {
          const browser = yield* IsolatedBrowser.Service
          return { data: yield* browser.list(ctx.params.sessionID).pipe(Effect.mapError(mapSessionNotFound)) }
        }),
      )
      .handle(
        "isolatedBrowser.observe",
        Effect.fn(function* (ctx) {
          const browser = yield* IsolatedBrowser.Service
          return {
            data: yield* browser
              .observe({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "isolatedBrowser.action",
        Effect.fn(function* (ctx) {
          const browser = yield* IsolatedBrowser.Service
          return {
            data: yield* browser
              .action({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "isolatedBrowser.control",
        Effect.fn(function* (ctx) {
          const browser = yield* IsolatedBrowser.Service
          return {
            data: yield* browser.control(ctx.params.sessionID, ctx.payload).pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "isolatedBrowser.stop",
        Effect.fn(function* (ctx) {
          const browser = yield* IsolatedBrowser.Service
          yield* browser.stop(ctx.params.sessionID).pipe(Effect.mapError(mapOperation))
          return HttpApiSchema.NoContent.make()
        }),
      ),
  ),
)
