export * as DotsRoom from "./room"

import { Cause, Effect, Queue, Semaphore, Stream } from "effect"
import { Hash } from "../util/hash"
import type { DotsHttp } from "./http"
import type { DotsPubSub } from "./pubsub"
import { DotsTransport } from "./transport"

const topicID = "calpico-chatgpt-messaging"
const invalid = () =>
  new DotsTransport.Error({ reason: "invalid-response", message: "Dots room response was not valid" })
const rejected = () => new DotsTransport.Error({ reason: "rejected", message: "The selected Dots room is unavailable" })
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0
const parse = <A>(read: () => A) => Effect.try({ try: read, catch: () => invalid() })

function textOf(message: Record<string, unknown>) {
  if (!record(message.content)) return ""
  if (typeof message.content.text === "string") return message.content.text
  return Array.isArray(message.content.parts)
    ? message.content.parts.filter((part): part is string => typeof part === "string").join("")
    : ""
}

function visibleText(value: unknown) {
  if (!record(value) || !record(value.author) || value.author.role !== "assistant" || !record(value.content)) return ""
  const metadata = record(value.metadata) ? value.metadata : {}
  if (
    metadata.is_visually_hidden_from_conversation === true ||
    metadata.is_hidden === true ||
    metadata.hidden === true ||
    value.channel === "analysis" ||
    (value.recipient != null && value.recipient !== "all")
  )
    return ""
  if (value.content.content_type !== "text" && value.content.content_type !== "multimodal_text") return ""
  const text = textOf(value)
  return text.includes("::SKIP_COMPLETION::") ? "" : text
}

export function make(options: {
  readonly http: DotsHttp.Interface
  readonly pubsub: DotsPubSub.Interface
}): DotsTransport.Interface {
  const changed = () => new DotsTransport.Error({ reason: "target-changed", message: "The confirmed Dot or its root conversation changed; confirm the Dot again." })
  const runtimeState: DotsTransport.Interface["runtimeState"] = (credentials, target) =>
    Effect.gen(function* () {
      const value = yield* options.http.json(credentials, { method: "GET", path: `/tbo/by-thread/${encodeURIComponent(target.threadID)}` })
      if (!record(value) || !identity(value.id)) return yield* invalid()
      if (value.id !== target.dotID || value.status !== "active" || (value.active_root_thread_id != null && value.active_root_thread_id !== target.threadID))
        return yield* changed()
      return value.is_paused === true ? "paused" : value.is_paused === false ? "unpaused" : "unknown"
    })

  const control: DotsTransport.Interface["control"] = (credentials, input, isCurrent, onDispatch) =>
    Effect.gen(function* () {
      if (!isCurrent()) return yield* changed()
      onDispatch?.()
      const response = yield* options.http.json(credentials, { method: "POST", path: `/tbo/${encodeURIComponent(input.dotID)}/runtime/${input.action}` })
      if (!record(response) || !identity(response.thread_id) || typeof response.status !== "string") return yield* invalid()
      if (response.thread_id !== input.threadID || !isCurrent()) return yield* changed()
      const state = yield* runtimeState(credentials, input)
      if (!isCurrent()) return yield* changed()
      if (state !== (input.action === "pause" ? "paused" : "unpaused")) return yield* invalid()
      return state
    })

  const roomFor = (credentials: DotsTransport.Credentials, threadID: string) =>
    options.http.json(credentials, { method: "GET", path: `/tbo/by-thread/${encodeURIComponent(threadID)}` }).pipe(
      Effect.flatMap((value) => {
        if (!record(value) || !identity(value.id) || !identity(value.messaging_room_id)) return Effect.fail(invalid())
        if (
          value.status !== "active" ||
          (value.active_root_thread_id != null && value.active_root_thread_id !== threadID)
        )
          return Effect.fail(rejected())
        return Effect.succeed({ dotID: value.id, roomID: value.messaging_room_id })
      }),
    )

  const destinations: DotsTransport.Interface["destinations"] = (credentials) =>
    Effect.gen(function* () {
      const response = yield* options.http.json(credentials, { method: "GET", path: "/tbo/primary" })
      if (!record(response) || !("selection" in response)) return yield* invalid()
      const selection = response.selection
      if (selection === null) return []
      if (!record(selection) || typeof selection.available !== "boolean") return yield* invalid()
      if (!selection.available) return []
      if (!identity(selection.thread_id) || !identity(selection.generation)) return yield* invalid()
      const room = yield* roomFor(credentials, selection.thread_id)
      if (
        (selection.aeon_id != null && selection.aeon_id !== room.dotID) ||
        (selection.messaging_room_id != null && selection.messaging_room_id !== room.roomID)
      )
        return yield* rejected()
      return [{ dotID: room.dotID, threadID: selection.thread_id, generation: selection.generation, label: "Primary Dot conversation" }]
    })

  const connect: DotsTransport.Interface["connect"] = (credentials) =>
    Effect.gen(function* () {
      const notifications = yield* options.pubsub.connect(credentials)
      const queue = yield* Queue.unbounded<DotsTransport.Inbound, DotsTransport.Error | Cause.Done>()
      const rooms = new Map<string, { readonly dotID: string; readonly roomID: string }>()
      const own = new Map<string, { readonly requestID: string; readonly causalMessageID: string }>()
      const lock = Semaphore.makeUnsafe(1)
      let subscription: Effect.Effect<void, DotsTransport.Error> | undefined

      const snapshot = (threadID: string, roomID: string, dotID: string) =>
        Effect.gen(function* () {
          const room = yield* options.http.json(credentials, {
            method: "GET",
            path: `/messaging/rooms/${encodeURIComponent(roomID)}`,
          })
          if (!record(room) || room.id !== roomID || !Array.isArray(room.members)) return yield* invalid()
          const actors = new Set(
            room.members.flatMap((member) =>
              record(member) && member.aeon_id === dotID && identity(member.account_user_id)
                ? [member.account_user_id]
                : [],
            ),
          )
          const pages: unknown[][] = []
          const cursors = new Set<string>()
          let before: string | undefined
          while (true) {
            const query = new URLSearchParams({ limit: "20", ...(before === undefined ? {} : { before }) })
            const response = yield* options.http.json(credentials, {
              method: "GET",
              path: `/messaging/rooms/${encodeURIComponent(roomID)}/messages?${query.toString()}`,
            })
            if (!record(response) || !Array.isArray(response.items)) return yield* invalid()
            pages.unshift(response.items)
            const first = response.items[0]
            const cursor =
              response.prev_cursor === null
                ? undefined
                : (response.prev_cursor ?? (record(first) ? first.id : undefined))
            if (cursor == null) break
            if (!identity(cursor) || cursors.has(cursor)) return yield* invalid()
            cursors.add(cursor)
            before = cursor
          }
          return yield* parse(() =>
            pages.flat().flatMap((item): DotsTransport.Inbound[] => {
              if (!record(item)) throw invalid()
              const id = item.id ?? item.message_id
              if (!identity(id)) throw invalid()
              if (item.deleted_at != null || item.deletedAt != null) return []
              const known = own.get(`${roomID}\0${id}`)
              const parent = record(item.reply_to) ? item.reply_to.message_id : undefined
              const causalMessageID =
                typeof parent === "string" ? own.get(`${roomID}\0${parent}`)?.causalMessageID : undefined
              if (!("raw_messages" in item)) {
                if (known !== undefined) return [{ type: "user.message", threadID, clientMessageID: known.requestID }]
                if (item.role !== "user" || !identity(item.account_user_id) || !actors.has(item.account_user_id)) return []
                const text = record(item.content) && typeof item.content.text === "string" ? item.content.text : ""
                return text.trim() === "" ? [] : [
                  {
                    type: "message",
                    threadID,
                    itemID: id,
                    text,
                    ...(causalMessageID === undefined ? {} : { causalMessageID }),
                  },
                ]
              }
              if (!Array.isArray(item.raw_messages)) return []
              const text = item.raw_messages
                .map(visibleText)
                .filter((part) => part !== "")
                .join("\n\n")
              if (text === "") return []
              return [
                {
                  type: "message.revision",
                  threadID,
                  itemID: id,
                  revision: Hash.sha256(text),
                  text,
                  ...(causalMessageID === undefined ? {} : { causalMessageID }),
                },
              ]
            }),
          )
        })

      yield* Stream.runForEach(notifications.events, (notice) => {
        if (notice.topicID !== topicID) return Effect.void
        const payload = notice.type === "message" && record(notice.payload) ? notice.payload : undefined
        if (
          notice.type === "message" &&
          (!payload || ![
            "calpico-message-add",
            "calpico-message-update",
            "calpico-room-update",
            "calpico-room-metadata-update",
          ].includes(String(payload.type)))
        )
          return Effect.void
        const roomID = payload && record(payload.payload)
          ? payload.payload.room_id ?? (record(payload.payload.room) ? payload.payload.room.id : undefined)
          : undefined
        return lock.withPermit(
          Effect.forEach(
            [...rooms],
            ([threadID, room]) =>
              notice.type === "resync" || roomID === room.roomID
                ? snapshot(threadID, room.roomID, room.dotID).pipe(
                    Effect.flatMap((items) => Queue.offerAll(queue, items)),
                    Effect.asVoid,
                  )
                : Effect.void,
            { discard: true },
          ),
        )
      }).pipe(
        Effect.catch((error) => Effect.sync(() => Queue.failCauseUnsafe(queue, Cause.fail(error)))),
        Effect.forkScoped,
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => Queue.endUnsafe(queue)))

      return {
        subscribe: (threadID) =>
          Effect.gen(function* () {
            const room = yield* roomFor(credentials, threadID)
            if (subscription === undefined) subscription = yield* Effect.cached(notifications.subscribe(topicID))
            yield* subscription
            return yield* lock.withPermit(
              Effect.gen(function* () {
                rooms.set(threadID, room)
                return yield* snapshot(threadID, room.roomID, room.dotID)
              }),
            )
          }),
        inbound: Stream.fromQueue(queue),
        send: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              const bound = rooms.get(input.threadID)
              if (!bound) return yield* rejected()
              const current = yield* roomFor(credentials, input.threadID)
              if (current.dotID !== bound.dotID || current.roomID !== bound.roomID) return yield* rejected()
              const fileIDs: string[] = []
              for (const file of input.files) {
                const body = new FormData()
                body.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name)
                const uploaded = yield* options.http.json(credentials, {
                  method: "POST",
                  path: `/messaging/rooms/${encodeURIComponent(bound.roomID)}/files`,
                  body,
                })
                if (!record(uploaded) || !identity(uploaded.id) || !identity(uploaded.status)) return yield* invalid()
                fileIDs.push(uploaded.id)
              }
              const response = yield* options.http.json(credentials, {
                method: "POST",
                path: `/messaging/rooms/${encodeURIComponent(bound.roomID)}/messages`,
                body: {
                  content: { text: input.text, attachments: fileIDs.map((file_id) => ({ type: "file", file_id })) },
                  request_id: input.messageID,
                  idempotency_token: input.messageID,
                },
              })
              if (!record(response) || !identity(response.id))
                return yield* new DotsTransport.Error({
                  reason: "disconnected",
                  message: "The Dots message outcome is unknown",
                })
              own.set(`${bound.roomID}\0${response.id}`, {
                requestID: input.messageID,
                causalMessageID: input.causalMessageID ?? input.messageID,
              })
              return { status: "accepted" as const }
            }),
          ),
      } satisfies DotsTransport.Connection
    })
  return { destinations, runtimeState, control, connect }
}
