import { Browser } from "@ycoding-ai/core/browser"
import { BrowserProtocol } from "@ycoding-ai/core/browser/protocol"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
} from "@ycoding-ai/protocol/errors"
import { Effect, Fiber, Queue } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Socket } from "effect/unstable/socket"
import { Api } from "../api"

function mapSessionNotFound(error: { readonly sessionID: string }) {
  return new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` })
}

function mapOperation(
  error:
    | Browser.UnavailableError
    | Browser.OwnershipError
    | Browser.FenceError
    | Browser.BusyError
    | Browser.BridgeError
    | { readonly _tag: "Session.NotFoundError"; readonly sessionID: string },
) {
  if (error._tag === "Session.NotFoundError") return mapSessionNotFound(error)
  if (error._tag === "Browser.OwnershipError") return new ForbiddenError({ message: error.message })
  if (error._tag === "Browser.FenceError" || error._tag === "Browser.BusyError")
    return new ConflictError({ message: error.message })
  if (error._tag === "Browser.UnavailableError")
    return new ServiceUnavailableError({ message: error.message, service: "browser-extension" })
  return new InvalidRequestError({ message: error.message })
}

export const BrowserHandler = HttpApiBuilder.group(Api, "server.browser", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "browser.status",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return { data: yield* browser.status(ctx.params.sessionID).pipe(Effect.mapError(mapSessionNotFound)) }
        }),
      )
      .handle(
        "browser.tabs",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return { data: yield* browser.list(ctx.params.sessionID).pipe(Effect.mapError(mapSessionNotFound)) }
        }),
      )
      .handle(
        "browser.start",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return {
            data: yield* browser.start(ctx.params.sessionID).pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "browser.observe",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return {
            data: yield* browser
              .observe({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "browser.action",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return {
            data: yield* browser
              .action({ sessionID: ctx.params.sessionID, ...ctx.payload })
              .pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "browser.control",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          return {
            data: yield* browser.control(ctx.params.sessionID, ctx.payload).pipe(Effect.mapError(mapOperation)),
          }
        }),
      )
      .handle(
        "browser.stop",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          yield* browser.stop(ctx.params.sessionID).pipe(Effect.mapError(mapOperation))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "browser.forget",
        Effect.fn(function* (ctx) {
          const browser = yield* Browser.Service
          yield* browser.forget(ctx.params.sessionID).pipe(Effect.mapError(mapOperation))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handleRaw(
        "browser.connect",
        Effect.fn("BrowserHandler.connect")(function* (ctx) {
          const extensionID = BrowserProtocol.extensionIDFromOrigin(ctx.request.headers.origin)
          if (!extensionID) return HttpServerResponse.empty({ status: 403 })
          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer
          type Outbound = string | Socket.CloseEvent
          const inbox = yield* Queue.bounded<string | Uint8Array | ArrayBuffer>(128)
          const outbox = yield* Queue.bounded<Outbound>(128)
          const send = (message: BrowserProtocol.ServerMessage) =>
            Queue.offerUnsafe(outbox, BrowserProtocol.encodeServer(message))
          const close = (code: number, reason: string) => {
            Queue.offerUnsafe(outbox, new Socket.CloseEvent(code, reason))
          }
          const reader = yield* socket
            .runRaw((message) => {
              if (!Queue.offerUnsafe(inbox, message)) close(4408, "input overflow")
            })
            .pipe(
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.forkScoped,
            )
          const first = yield* Queue.take(inbox).pipe(
            Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(undefined) }),
          )
          const handshake = first === undefined ? undefined : BrowserProtocol.decodeClient(first)
          if (
            !handshake ||
            (handshake.type !== "pair" && handshake.type !== "authenticate") ||
            handshake.extensionID !== extensionID
          ) {
            close(4403, "authentication required")
            yield* drain(outbox, write)
            return HttpServerResponse.empty()
          }
          const browser = yield* Browser.Service
          const attached = yield* browser
            .attach({
              sessionID: ctx.params.sessionID,
              origin: ctx.request.headers.origin,
              handshake,
              transport: { send, close },
            })
            .pipe(
              Effect.map((attachment) => ({ type: "attached" as const, attachment })),
              Effect.catchTags({
                "Session.NotFoundError": () => Effect.succeed({ type: "rejected" as const }),
                "Browser.AuthenticationError": () => Effect.succeed({ type: "rejected" as const }),
                "Browser.BusyError": () => Effect.succeed({ type: "busy" as const }),
              }),
            )
          if (attached.type === "busy") {
            close(4409, "bridge busy")
            yield* drain(outbox, write)
            return HttpServerResponse.empty()
          }
          if (attached.type === "rejected") {
            close(4403, "authentication rejected")
            yield* drain(outbox, write)
            return HttpServerResponse.empty()
          }
          const attachment = attached.attachment
          const incoming = Effect.gen(function* () {
            while (true) {
              const frame = yield* Queue.take(inbox)
              const message = BrowserProtocol.decodeClient(frame)
              if (!message || message.type === "pair" || message.type === "authenticate") {
                close(4400, "invalid frame")
                return
              }
              yield* attachment.receive(message)
            }
          })
          yield* Effect.race(drain(outbox, write), incoming).pipe(
            Effect.ensuring(attachment.detach),
            Effect.ensuring(Fiber.interrupt(reader)),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
)

function drain(
  outbox: Queue.Queue<string | Socket.CloseEvent>,
  write: (message: string | Socket.CloseEvent) => Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    while (true) {
      const message = yield* Queue.take(outbox)
      yield* write(message)
      if (message instanceof Socket.CloseEvent) return
    }
  }).pipe(Effect.catch(() => Effect.void))
}
