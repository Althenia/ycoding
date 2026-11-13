import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { Api } from "../api"

const conversationError = (error: DotsAccess.Error) => error.code === "conflict"
  ? new ConflictError({ message: error.message, resource: "dots" }) : new InvalidRequestError({ message: error.message })
const page = (query: { readonly cursor?: string; readonly limit?: number }) => ({
  ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  ...(query.limit === undefined ? {} : { limit: query.limit }),
})

export const DotsHandler = HttpApiBuilder.group(Api, "server.dots", (handlers) =>
  handlers
    .handle("dots.get", Effect.fn(function* () {
      const access = yield* DotsAccess.Service
      return { data: yield* access.status().pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    }))
    .handle("dots.set", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      yield* access.set(ctx.payload).pipe(Effect.mapError((error) => error.code === "conflict"
        ? new ConflictError({ message: error.message, resource: "dots" }) : new InvalidRequestError({ message: error.message })))
      return { data: yield* access.status().pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    }))
    .handle("dots.attach", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.attachComputer(ctx.payload).pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    }))
    .handle("dots.detach", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.detachComputer(ctx.payload).pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    }))
    .handle("dots.remove", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.removeComputer(ctx.payload).pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))) }
    }))
    .handle("dots.threads", Effect.fn(function* () {
      const access = yield* DotsAccess.Service
      return { data: yield* access.threads().pipe(Effect.mapError(conversationError)) }
    }))
    .handle("dots.task.updates", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.taskUpdates(ctx.params.taskID, page(ctx.query)).pipe(Effect.mapError(conversationError)) }
    }))
    .handle("dots.thread.read", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.readThread(ctx.params.threadID, page(ctx.query)).pipe(Effect.mapError(conversationError)) }
    }))
    .handle("dots.thread.send", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.sendMessage(ctx.params.threadID, ctx.payload).pipe(Effect.mapError(conversationError)) }
    }))
    .handle("dots.thread.interrupt", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.interruptTurn(ctx.params.threadID, ctx.payload).pipe(Effect.mapError(conversationError)) }
    }))
    .handle("dots.resume", Effect.fn(function* () {
      const access = yield* DotsAccess.Service
      return { data: yield* access.resume().pipe(Effect.mapError(conversationError)) }
    }))
    .handle("dots.thread.requests", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.requests(ctx.params.threadID).pipe(Effect.mapError(conversationError)) }
    }))
    .handle("dots.thread.respond", Effect.fn(function* (ctx) {
      const access = yield* DotsAccess.Service
      return { data: yield* access.respond(ctx.params.threadID, ctx.params.requestID, ctx.payload).pipe(Effect.mapError(conversationError)) }
    })),
)
