export * as DotsPubSub from "./pubsub"

import { Cause, Deferred, Effect, Queue, Schema, Scope, Stream } from "effect"
import type { DotsHttp } from "./http"
import { DotsTransport } from "./transport"
import { OpenAICodex } from "../plugin/provider/openai-codex"

export type Notice =
  | { readonly type: "message"; readonly topicID: string; readonly payload: unknown }
  | { readonly type: "resync"; readonly topicID: string }

export interface Connection {
  readonly subscribe: (topicID: string) => Effect.Effect<void, DotsTransport.Error>
  readonly events: Stream.Stream<Notice, DotsTransport.Error>
}

export interface Interface {
  readonly connect: (
    credentials: DotsTransport.Credentials,
  ) => Effect.Effect<Connection, DotsTransport.Error, Scope.Scope>
}

type Listener = (event: { readonly type?: string; readonly data?: unknown }) => void

export interface Socket {
  readonly readyState: number
  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void
  removeEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void
  send(data: string): void
  close(): void
}

export interface Options {
  readonly http: Pick<DotsHttp.Interface, "json">
  readonly open: (url: string, headers: Record<string, string>) => Socket | Promise<Socket>
}

interface Command {
  readonly id: number
  readonly command: unknown
}

interface Topic {
  readonly ready: Deferred.Deferred<void, DotsTransport.Error>
  subscribed: boolean
}

const OPEN = 1
const decodeJSON = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const events = ["open", "message", "close", "error"] as const

const failure = (reason: DotsTransport.Error["reason"], message: string) => new DotsTransport.Error({ reason, message })
const invalid = () => failure("invalid-response", "Dots pubsub response was not valid")
const disconnected = () => failure("disconnected", "Dots pubsub connection closed")

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const socketURL = (response: unknown) => {
  if (!record(response) || typeof response.websocket_url !== "string") return undefined
  const url = URL.parse(response.websocket_url)
  if (!url || url.protocol !== "wss:" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined
  return response.websocket_url
}

export function make(options: Options): Interface {
  const connect: Interface["connect"] = (credentials) =>
    Effect.gen(function* () {
      const response = yield* options.http.json(credentials, { method: "GET", path: "/celsius/ws/user" })
      const url = socketURL(response)
      if (url === undefined) return yield* invalid()
      const socket = yield* Effect.acquireRelease(Effect.tryPromise({
        try: async () => options.open(url, OpenAICodex.headers()),
        catch: () => failure("unavailable", "Dots pubsub is unavailable"),
      }), (socket) => Effect.sync(() => socket.close()))
      const queue = yield* Queue.unbounded<Notice, DotsTransport.Error | Cause.Done>()
      const topics = new Map<string, Topic>()
      const byCommand = new Map<number, string>()
      const offsets = new Map<string, string>()
      const backlog: Command[] = []
      let nextID = 1
      const connectID = nextID++
      let opened = false
      let finished = false

      const finish = (error: DotsTransport.Error | undefined) => {
        if (finished) return
        finished = true
        for (const topic of topics.values()) Deferred.doneUnsafe(topic.ready, Effect.fail(error ?? disconnected()))
        if (error === undefined) Queue.endUnsafe(queue)
        else Queue.failCauseUnsafe(queue, Cause.fail(error))
      }

      const write = (commands: ReadonlyArray<Command>) => {
        try {
          socket.send(JSON.stringify(commands))
        } catch {
          finish(disconnected())
        }
      }
      const command = (body: unknown): Command => ({ id: nextID++, command: body })

      const accept = (topicID: string, payload: unknown, offset: unknown) => {
        if (typeof offset === "string") offsets.set(topicID, offset)
        Queue.offerUnsafe(queue, { type: "message", topicID, payload })
      }

      const message = (item: Record<string, unknown>) => {
        if (typeof item.topic_id !== "string") return false
        const topic = topics.get(item.topic_id)
        if (topic?.subscribed) accept(item.topic_id, item.payload, item.offset)
        return true
      }

      const reply = (id: number, value: unknown) => {
        const topicID = byCommand.get(id)
        if (topicID === undefined) return
        byCommand.delete(id)
        const topic = topics.get(topicID)
        if (!topic) return
        if (
          !record(value) ||
          value.type !== "subscribe" ||
          value.topic_id !== topicID ||
          typeof value.recovered !== "boolean" ||
          (value.catchups !== undefined && !Array.isArray(value.catchups))
        ) {
          return finish(invalid())
        }
        const catchups = value.recovered ? ((value.catchups as ReadonlyArray<unknown> | undefined) ?? []) : []
        if (catchups.some((item) => !record(item) || item.type !== "message" || item.topic_id !== topicID)) {
          return finish(invalid())
        }
        topic.subscribed = true
        Queue.offerUnsafe(queue, { type: "resync", topicID })
        for (const item of catchups as ReadonlyArray<Record<string, unknown>>)
          accept(topicID, item.payload, item.offset)
        if (typeof value.last_offset === "string") offsets.set(topicID, value.last_offset)
        Deferred.doneUnsafe(topic.ready, Effect.void)
      }

      const receive = (data: unknown) => {
        if (finished) return
        if (typeof data !== "string") return finish(invalid())
        const parsed = (() => {
          try {
            return decodeJSON(data)
          } catch {
            return undefined
          }
        })()
        if (record(parsed)) {
          if (typeof parsed.type !== "string") finish(invalid())
          return
        }
        if (!Array.isArray(parsed)) return finish(invalid())
        for (const item of parsed as ReadonlyArray<unknown>) {
          if (finished) return
          if (record(item) && item.type === "message") {
            if (!message(item)) return finish(invalid())
          } else if (record(item) && typeof item.id === "number" && "reply" in item) {
            reply(item.id, item.reply)
          } else return finish(invalid())
        }
      }

      const onOpen: Listener = () => {
        if (finished || opened) return
        opened = true
        write([
          { id: connectID, command: { type: "connect", presence: { type: "presence", state: "foreground" } } },
          ...backlog.splice(0),
        ])
      }
      const onMessage: Listener = (event) => receive(event.data)
      const onEnd: Listener = () => finish(disconnected())
      const listeners = { open: onOpen, message: onMessage, close: onEnd, error: onEnd }
      for (const type of events) socket.addEventListener(type, listeners[type])

      const dispose = Effect.sync(() => {
        if (!finished && opened && socket.readyState === OPEN && topics.size > 0) {
          write([...topics.keys()].map((topicID) => command({ type: "unsubscribe", topic_id: topicID })))
        }
        for (const type of events) socket.removeEventListener(type, listeners[type])
        finish(undefined)
      })
      yield* Scope.addFinalizer(yield* Scope.Scope, dispose)
      if (socket.readyState === OPEN) onOpen({})

      const subscribe: Connection["subscribe"] = (topicID) =>
        Effect.suspend(() => {
          if (finished) return Effect.fail(disconnected())
          const existing = topics.get(topicID)
          if (existing) return Deferred.await(existing.ready)
          const topic: Topic = { ready: Deferred.makeUnsafe<void, DotsTransport.Error>(), subscribed: false }
          topics.set(topicID, topic)
          const body = command({ type: "subscribe", topic_id: topicID })
          byCommand.set(body.id, topicID)
          if (opened) write([body])
          else backlog.push(body)
          return Deferred.await(topic.ready)
        })

      return { subscribe, events: Stream.fromQueue(queue) } satisfies Connection
    })
  return { connect }
}
