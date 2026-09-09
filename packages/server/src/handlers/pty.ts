import { Pty } from "@ycoding-ai/core/pty"
import { PtyProtocol } from "@ycoding-ai/core/pty/protocol"
import { PtyTicket } from "@ycoding-ai/core/pty/ticket"
import { Location } from "@ycoding-ai/core/location"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Effect, Queue } from "effect"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Socket } from "effect/unstable/socket"
import { Api } from "../api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import {
  ForbiddenError,
  PtyConflictError,
  PtyNotFoundError,
  PtyResourceLimitError,
  SessionNotFoundError,
} from "@ycoding-ai/protocol/errors"
import { PTY_CONNECT_TOKEN_HEADER, PTY_CONNECT_TOKEN_HEADER_VALUE } from "@ycoding-ai/protocol/groups/pty"
import { response } from "../location"
import { PtyEnvironment } from "../pty-environment"
import { PtyConnect } from "../pty-connect"

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory as string, workspaceID: location.workspaceID }
})

const mapNotFound = (ptyID: Pty.Info["id"]) =>
  new PtyNotFoundError({ ptyID, message: `PTY session not found: ${ptyID}` })
const mapForbidden = () => new ForbiddenError({ message: "PTY does not belong to this Session" })
const mapConflict = (ptyID: Pty.Info["id"]) =>
  new PtyConflictError({ ptyID, message: "PTY control generation or writer fence is stale" })

function mapOwned<A, R>(effect: Effect.Effect<A, Pty.NotFoundError | Pty.OwnershipError, R>) {
  return Effect.mapError(effect, (error) =>
    error._tag === "Pty.NotFoundError" ? mapNotFound(error.ptyID) : mapForbidden(),
  )
}

function mapMutation<A, R>(effect: Effect.Effect<A, Pty.NotFoundError | Pty.OwnershipError | Pty.FenceError, R>) {
  return Effect.mapError(effect, (error) =>
    error._tag === "Pty.NotFoundError"
      ? mapNotFound(error.ptyID)
      : error._tag === "Pty.OwnershipError"
        ? mapForbidden()
        : mapConflict(error.ptyID),
  )
}

function mapCreate<A, R>(effect: Effect.Effect<A, Pty.ResourceLimitError, R>) {
  return Effect.mapError(
    effect,
    (error) => new PtyResourceLimitError({ resource: error.resource, message: `PTY ${error.resource} limit reached` }),
  )
}

export const PtyHandler = HttpApiBuilder.group(Api, "server.pty", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* PtyTicket.Service
    const cors = yield* CorsConfig
    const environment = yield* PtyEnvironment.Service

    return handlers
      .handle(
        "pty.list",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(pty.list(ctx.query.sessionID))
        }),
      )
      .handle(
        "pty.create",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          const location = yield* Location.Service
          const sessions = yield* SessionV2.Service
          const owner = yield* sessions.get(ctx.payload.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              () =>
                new SessionNotFoundError({
                  sessionID: ctx.payload.sessionID,
                  message: `Session not found: ${ctx.payload.sessionID}`,
                }),
            ),
          )
          if (owner.location.directory !== location.directory || owner.location.workspaceID !== location.workspaceID)
            return yield* new SessionNotFoundError({
              sessionID: ctx.payload.sessionID,
              message: `Session not found at this location: ${ctx.payload.sessionID}`,
            })
          const cwd = ctx.payload.cwd || location.directory
          return yield* response(
            pty
              .create({
                ...ctx.payload,
                args: ctx.payload.args ? [...ctx.payload.args] : undefined,
                cwd,
                env: {
                  ...ctx.payload.env,
                  ...(yield* environment.get({ directory: location.directory, cwd })),
                },
              })
              .pipe(mapCreate),
          )
        }),
      )
      .handle(
        "pty.get",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(pty.get(ctx.params.ptyID, ctx.query.sessionID).pipe(mapOwned))
        }),
      )
      .handle(
        "pty.update",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(
            pty
              .update(ctx.params.ptyID, {
                ...ctx.payload,
                size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
              })
              .pipe(mapMutation),
          )
        }),
      )
      .handle(
        "pty.remove",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          yield* pty.remove(ctx.params.ptyID, ctx.query.sessionID).pipe(mapOwned)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "pty.control",
        Effect.fn(function* (ctx) {
          const pty = yield* Pty.Service
          return yield* response(pty.control(ctx.params.ptyID, ctx.payload).pipe(mapMutation))
        }),
      )
      .handle(
        "pty.connectToken",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // The custom header forces a CORS preflight, so cross-origin browser pages cannot
          // mint tickets without passing the server's origin policy.
          if (
            request.headers[PTY_CONNECT_TOKEN_HEADER] !== PTY_CONNECT_TOKEN_HEADER_VALUE ||
            !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
          )
            return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
          const pty = yield* Pty.Service
          const info = yield* pty.get(ctx.params.ptyID, ctx.payload.sessionID).pipe(mapOwned)
          if (info.generation !== ctx.payload.generation) return yield* mapConflict(ctx.params.ptyID)
          const fence = ctx.payload.access === "control" ? ctx.payload.expectedFence : undefined
          if (ctx.payload.access === "control" && (info.control.owner !== "user" || fence !== info.control.fence))
            return yield* mapConflict(ctx.params.ptyID)
          return yield* response(
            tickets.issue({
              ptyID: ctx.params.ptyID,
              sessionID: ctx.payload.sessionID,
              access: ctx.payload.access,
              generation: ctx.payload.generation,
              fence,
              ...(yield* ticketScope),
            }),
          )
        }),
      )
      .handleRaw(
        "pty.connect",
        Effect.fn("PtyHandler.connect")(function* (ctx) {
          const pty = yield* Pty.Service
          const query = PtyConnect.parse(ctx.request.url)
          if (!query) return HttpServerResponse.empty({ status: 403 })
          const exists = yield* pty.get(ctx.params.ptyID, query.sessionID).pipe(
            Effect.as(true),
            Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
            Effect.catchTag("Pty.OwnershipError", () => Effect.succeed(false)),
          )
          if (!exists) return HttpServerResponse.empty({ status: 404 })
          const valid = isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
            ? yield* tickets.consume({
                ticket: query.ticket,
                ptyID: ctx.params.ptyID,
                sessionID: query.sessionID,
                access: query.access,
                generation: query.generation,
                fence: query.fence,
                ...(yield* ticketScope),
              })
            : false
          if (!valid) return HttpServerResponse.empty({ status: 403 })

          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer
          const closeAccepted = (event: Socket.CloseEvent) =>
            socket
              .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
              .pipe(
                Effect.timeout("1 second"),
                Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
                Effect.catch(() => Effect.void),
              )

          // Outbound frames flow through one queue drained by a single writer so replay, live
          // output, and the close frame keep their order.
          type Outbound =
            | { readonly type: "replay"; readonly replay: Pty.Attachment["replay"] }
            | { readonly type: "data"; readonly chunk: Pty.OutputChunk }
            | { readonly type: "end"; readonly event: Pty.EndEvent }
            | Socket.CloseEvent
          const outbox = yield* Queue.bounded<Outbound>(256)
          let overflowed = false
          const closeOnShutdown = () => {
            Effect.runSyncExit(
              write(
                PtyProtocol.controlFrame({
                  type: "end",
                  generation: query.generation,
                  reason: "service_shutdown",
                }),
              ).pipe(Effect.andThen(write(new Socket.CloseEvent(1012, "service shutdown")))),
            )
          }
          const untrack = PtyConnect.track(NodeHttpServerRequest.toIncomingMessage(ctx.request).socket, closeOnShutdown)
          const attachment = yield* pty
            .attach(ctx.params.ptyID, {
              sessionID: query.sessionID,
              access: query.access,
              generation: query.generation,
              fence: query.fence,
              offset: query.offset,
              onData: (chunk) => {
                if (!Queue.offerUnsafe(outbox, { type: "data", chunk })) overflowed = true
              },
              onEnd: (event) => {
                if (!Queue.offerUnsafe(outbox, { type: "end", event })) overflowed = true
              },
            })
            .pipe(
              Effect.catchTags({
                "Pty.NotFoundError": () =>
                  closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
                "Pty.ExitedError": () =>
                  closeAccepted(new Socket.CloseEvent(4404, "session exited")).pipe(Effect.as(undefined)),
                "Pty.OwnershipError": () =>
                  closeAccepted(new Socket.CloseEvent(4403, "forbidden")).pipe(Effect.as(undefined)),
                "Pty.FenceError": () =>
                  closeAccepted(new Socket.CloseEvent(4409, "stale writer fence")).pipe(Effect.as(undefined)),
                "Pty.ResourceLimitError": () =>
                  closeAccepted(new Socket.CloseEvent(4408, "attachment limit")).pipe(Effect.as(undefined)),
              }),
            )
          if (!attachment) {
            untrack()
            return HttpServerResponse.empty()
          }

          Queue.offerUnsafe(outbox, { type: "replay", replay: attachment.replay })
          attachment.activate()

          const drain = Effect.gen(function* () {
            while (true) {
              const item = yield* Queue.take(outbox)
              if (overflowed) {
                yield* write(
                  PtyProtocol.controlFrame({ type: "end", generation: query.generation, reason: "overflow" }),
                )
                yield* write(new Socket.CloseEvent(4408, "output overflow"))
                return
              }
              if (item instanceof Socket.CloseEvent) {
                yield* write(item)
                return
              }
              if (item.type === "replay") {
                yield* write(
                  PtyProtocol.controlFrame({
                    type: "replay",
                    generation: item.replay.generation,
                    startOffset: item.replay.startOffset,
                    endOffset: item.replay.endOffset,
                    gap: item.replay.gap,
                  }),
                )
                for (const chunk of PtyProtocol.chunks(item.replay.data, item.replay.startOffset)) {
                  yield* write(
                    PtyProtocol.controlFrame({
                      type: "chunk",
                      generation: item.replay.generation,
                      startOffset: chunk.startOffset,
                      endOffset: chunk.endOffset,
                    }),
                  )
                  yield* write(PtyProtocol.dataFrame(chunk.data))
                }
                continue
              }
              if (item.type === "data") {
                yield* write(
                  PtyProtocol.controlFrame({
                    type: "chunk",
                    generation: item.chunk.generation,
                    startOffset: item.chunk.startOffset,
                    endOffset: item.chunk.endOffset,
                  }),
                )
                yield* write(PtyProtocol.dataFrame(item.chunk.data))
                continue
              }
              yield* write(PtyProtocol.controlFrame({ type: "end", ...item.event }))
              yield* write(new Socket.CloseEvent(item.event.reason === "service_shutdown" ? 1012 : 1000))
              return
            }
          })

          yield* Effect.race(
            drain,
            socket.runRaw((message) => {
              const decoded = PtyProtocol.decodeInput(message)
              if (decoded !== undefined && !attachment.write(decoded))
                Queue.offerUnsafe(outbox, new Socket.CloseEvent(4409, "stale writer fence"))
            }),
          ).pipe(
            Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
            Effect.ensuring(
              Effect.sync(() => {
                untrack()
                attachment.detach()
              }),
            ),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
)
