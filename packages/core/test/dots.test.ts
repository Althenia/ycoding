import { describe, expect, test } from "bun:test"
import { DotsRoom } from "@ycoding-ai/core/dots/room"
import type { DotsPubSub } from "@ycoding-ai/core/dots/pubsub"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Integration } from "@ycoding-ai/core/integration"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { DotsRuntime } from "@ycoding-ai/core/dots"
import { DotsAttachments } from "@ycoding-ai/core/dots/attachments"
import { DotsHttp } from "@ycoding-ai/core/dots/http"
import { DotsTransport } from "@ycoding-ai/core/dots/transport"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import type { Dots } from "@ycoding-ai/schema/dots"
import { Cause, Deferred, Effect, Exit, Fiber, Queue, Schedule, Scope, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { TestClock } from "effect/testing"

describe("Dots room transport", () => {
  const credentials = { access: "synthetic-room-token", accountID: "synthetic-room-account" }
  const assistant = (text: string, id = "reply") => ({
    id,
    raw_messages: [{ author: { role: "assistant" }, content: { content_type: "text", parts: [text] } }],
  })
  const posted = (id: string, accountUserID = "dot-member", text = "Committed peer text") => ({
    id,
    role: "user",
    account_user_id: accountUserID,
    content: { text, attachments: [] },
    request_id: null,
    reply_to: null,
    message_metadata: { turn_trigger: "message" },
  })
  const fixture = Effect.gen(function* () {
    const notices = yield* Queue.unbounded<DotsPubSub.Notice, DotsTransport.Error | Cause.Done>()
    const calls: Array<DotsHttp.Request> = []
    const topics: string[] = []
    const state = {
      selection: {
        selection: {
          thread_id: "thread/1",
          generation: "generation-1",
          available: true,
          aeon_id: "dot-1",
          messaging_room_id: "room/1",
        },
      } as unknown,
      room: {
        id: "room/1",
        members: [
          { account_user_id: "human-member" },
          { account_user_id: "dot-member", aeon_id: "dot-1" },
          { account_user_id: "other-dot-member", aeon_id: "dot-2" },
        ],
      } as unknown,
      history: [{ items: [] as unknown[], prev_cursor: null, next_cursor: null }] as unknown[],
      failUpload: false,
      ambiguous: false,
    }
    let uploaded = 0
    const http: DotsHttp.Interface = {
      json: (_credentials, input) =>
        Effect.suspend(() => {
          calls.push(input)
          if (input.path === "/tbo/primary") return Effect.succeed(state.selection)
          if (input.path === "/tbo/by-thread/thread%2F1")
            return Effect.succeed({
              id: "dot-1",
              messaging_room_id: "room/1",
              status: "active",
              active_root_thread_id: "thread/1",
            })
          if (input.method === "GET" && input.path === "/messaging/rooms/room%2F1")
            return Effect.succeed(state.room)
          if (input.method === "GET" && input.path.startsWith("/messaging/rooms/room%2F1/messages")) {
            if (Number(new URL(input.path, "https://example.invalid").searchParams.get("limit")) > 32)
              return Effect.fail(new DotsTransport.Error({ reason: "rejected", message: "History page limit exceeded" }))
            return Effect.succeed(state.history.shift() ?? { items: [], prev_cursor: null, next_cursor: null })
          }
          if (input.path === "/messaging/rooms/room%2F1/files")
            return state.failUpload
              ? Effect.fail(new DotsTransport.Error({ reason: "rejected", message: "Fixture upload rejection" }))
              : Effect.succeed({ id: `file-${++uploaded}`, status: "ready" })
          if (input.method === "POST" && input.path === "/messaging/rooms/room%2F1/messages")
            return state.ambiguous
              ? Effect.fail(new DotsTransport.Error({ reason: "disconnected", message: "Fixture ambiguous write" }))
              : Effect.succeed({ id: "own-server-message" })
          return Effect.die(new Error(`Unexpected synthetic route: ${input.method} ${input.path}`))
        }),
    }
    const transport = DotsRoom.make({
      http,
      pubsub: {
        connect: () =>
          Effect.succeed({
            subscribe: (topic) =>
              Effect.sync(() => {
                topics.push(topic)
              }),
            events: Stream.fromQueue(notices),
          }),
      },
    })
    return { transport, calls, state, topics, notices }
  })
  const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

  test("discovers only the available explicit primary target without creating a room", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        expect(yield* view.transport.destinations(credentials)).toEqual([
          { dotID: "dot-1", threadID: "thread/1", generation: "generation-1", label: "Primary Dot conversation" },
        ])
        view.state.selection = { selection: null }
        expect(yield* view.transport.destinations(credentials)).toEqual([])
        view.state.selection = { selection: { available: true, thread_id: "thread/1" } }
        expect(Exit.isFailure(yield* Effect.exit(view.transport.destinations(credentials)))).toBe(true)
        expect(view.calls.every((call) => call.method === "GET")).toBe(true)
      }),
    ))

  test("uploads selected files, images and pasted text as multipart bytes before sending their IDs", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        const connection = yield* view.transport.connect(credentials)
        yield* connection.subscribe("thread/1")
        const files = [
          { name: "chosen.txt", mime: "text/plain", bytes: new TextEncoder().encode("selected") },
          { name: "paste.txt", mime: "text/plain", bytes: new TextEncoder().encode("pasted text") },
          { name: "image.png", mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) },
        ]
        expect(
          yield* connection.send({
            threadID: "thread/1",
            messageID: "request-1",
            groupID: "group",
            text: "Only selected content",
            files,
          }),
        ).toEqual({ status: "accepted" })
        const uploads = view.calls.filter((call) => call.path.endsWith("/files"))
        expect(uploads).toHaveLength(3)
        for (const [index, request] of uploads.entries()) {
          expect(request.body).toBeInstanceOf(FormData)
          const file = (request.body as FormData).get("file")
          if (!(file instanceof File)) throw new Error("Missing multipart file")
          expect(file.name).toBe(files[index]?.name)
          expect(file.type.split(";")[0]).toBe(files[index]?.mime)
          expect(new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))).toEqual(files[index]?.bytes)
        }
        const sent = view.calls.find((call) => call.method === "POST" && call.path.endsWith("/messages"))
        expect(sent?.body).toEqual({
          content: {
            text: "Only selected content",
            attachments: [
              { type: "file", file_id: "file-1" },
              { type: "file", file_id: "file-2" },
              { type: "file", file_id: "file-3" },
            ],
          },
          request_id: "request-1",
          idempotency_token: "request-1",
        })
        expect(view.topics).toEqual(["calpico-chatgpt-messaging"])
      }),
    ))

  test("never replaces a rejected upload with a text-only send or retries an ambiguous message", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        const connection = yield* view.transport.connect(credentials)
        yield* connection.subscribe("thread/1")
        const input = {
          threadID: "thread/1",
          messageID: "request-1",
          groupID: "group",
          text: "text",
          files: [{ name: "file.txt", mime: "text/plain", bytes: new Uint8Array([1]) }],
        }
        view.state.failUpload = true
        expect(Exit.isFailure(yield* Effect.exit(connection.send(input)))).toBe(true)
        expect(view.calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"))).toHaveLength(0)
        view.state.ambiguous = true
        const exit = yield* Effect.exit(connection.send({ ...input, files: [] }))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ reason: "disconnected" })
        expect(view.calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"))).toHaveLength(1)
        expect(connection).not.toHaveProperty("interrupt")
      }),
    ))

  test("pages complete history and projects visible assistant snapshots without turns", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        const hidden = {
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["hidden"] },
          metadata: { hidden: true },
        }
        const analysis = { ...hidden, metadata: {}, channel: "analysis" }
        view.state.history = [
          {
            items: [
              {
                ...assistant("Visible"),
                raw_messages: [
                  ...assistant("Visible").raw_messages,
                  hidden,
                  analysis,
                  ...assistant("Second paragraph").raw_messages,
                ],
              },
            ],
            prev_cursor: "older",
            next_cursor: null,
          },
          { items: [assistant("Older", "older")], prev_cursor: null, next_cursor: null },
        ]
        const connection = yield* view.transport.connect(credentials)
        const snapshots = yield* connection.subscribe("thread/1")
        expect(snapshots).toHaveLength(2)
        expect(snapshots).toContainEqual({
          type: "message.revision",
          threadID: "thread/1",
          itemID: "reply",
          text: "Visible\n\nSecond paragraph",
          revision: expect.any(String),
        })
        expect(snapshots.every((item) => !("turnID" in item))).toBe(true)
        expect(view.calls.filter((call) => call.path.includes("before=older"))).toHaveLength(1)
      }),
    ))

  test("notification updates refetch snapshots and correlate only known server message IDs", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        const connection = yield* view.transport.connect(credentials)
        yield* connection.subscribe("thread/1")
        yield* connection.send({
          threadID: "thread/1",
          messageID: "local-request",
          causalMessageID: "msg_tool_cause",
          groupID: "group",
          text: "hello",
          files: [],
        })
        view.state.history = [
          {
            items: [{ ...assistant("Revised"), reply_to: { message_id: "own-server-message" } }],
            prev_cursor: null,
            next_cursor: null,
          },
        ]
        const received = yield* Stream.runCollect(connection.inbound.pipe(Stream.take(1))).pipe(Effect.forkScoped)
        yield* Queue.offer(view.notices, {
          type: "message",
          topicID: "calpico-chatgpt-messaging",
          payload: { type: "calpico-message-update", payload: { room_id: "other-room", message_id: "reply" } },
        })
        yield* Queue.offer(view.notices, {
          type: "message",
          topicID: "calpico-chatgpt-messaging",
          payload: { type: "calpico-message-update", payload: { room_id: "room/1", message_id: "reply" } },
        })
        const items = yield* Fiber.join(received).pipe(Effect.timeout("2 seconds"))
        expect(items).toEqual([
          {
            type: "message.revision",
            threadID: "thread/1",
            itemID: "reply",
            text: "Revised",
            revision: expect.any(String),
            causalMessageID: "msg_tool_cause",
          },
        ])
      }),
    ))

  test("rejects repeated history cursors rather than silently truncating a snapshot", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        view.state.history = [
          { items: [], prev_cursor: "loop" },
          { items: [], prev_cursor: "loop" },
        ]
        const connection = yield* view.transport.connect(credentials)
        const exit = yield* Effect.exit(connection.subscribe("thread/1"))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ reason: "invalid-response" })
      }),
    ))

  test("uses service-supported history page sizes", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        const connection = yield* view.transport.connect(credentials)
        expect(yield* connection.subscribe("thread/1")).toEqual([])
      }),
    ))

  test("reads committed messages only from the selected Dot's room membership without inventing a turn", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        view.state.history = [{ items: [
          posted("peer"),
          posted("human", "human-member"),
          posted("other-dot", "other-dot-member"),
          posted("unmatched", "unknown-member"),
          { ...posted("claimed-dot", "unknown-member"), aeon_id: "dot-1" },
          { ...posted("wrong-role"), role: "system" },
          posted("empty", "dot-member", " "),
          { ...posted("deleted"), deleted_at: "2026-01-01T00:00:00Z" },
          { ...posted("nonfinal"), raw_messages: assistant("Visible revision").raw_messages },
        ], prev_cursor: null }]
        const connection = yield* view.transport.connect(credentials)
        expect(yield* connection.subscribe("thread/1")).toEqual([
          { type: "message", threadID: "thread/1", itemID: "peer", text: "Committed peer text" },
          { type: "message.revision", threadID: "thread/1", itemID: "nonfinal", text: "Visible revision", revision: expect.any(String) },
        ])
      }),
    ))

  test("refreshes selected-Dot membership before admitting message and room updates", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        const connection = yield* view.transport.connect(credentials)
        yield* connection.subscribe("thread/1")
        view.state.room = { id: "room/1", members: [{ account_user_id: "replacement-member", aeon_id: "dot-1" }] }
        view.state.history = [{ items: [posted("stale-member"), posted("new-member", "replacement-member")], prev_cursor: null }]
        const received = yield* Stream.runCollect(connection.inbound.pipe(Stream.take(1))).pipe(Effect.forkScoped)
        yield* Queue.offer(view.notices, {
          type: "message", topicID: "calpico-chatgpt-messaging",
          payload: { type: "calpico-room-update", payload: { room: { id: "room/1", aeon_id: "dot-1" } } },
        })
        expect(yield* Fiber.join(received).pipe(Effect.timeout("2 seconds"))).toEqual([
          { type: "message", threadID: "thread/1", itemID: "new-member", text: "Committed peer text" },
        ])
      }),
    ))

  test("rejects mismatched or malformed room membership before projecting peer messages", () =>
    run(
      Effect.gen(function* () {
        const view = yield* fixture
        const connection = yield* view.transport.connect(credentials)
        for (const room of [
          { id: "other-room", members: [{ account_user_id: "dot-member", aeon_id: "dot-1" }] },
          { id: "room/1", members: null },
        ]) {
          view.state.room = room
          expect(Exit.isFailure(yield* Effect.exit(connection.subscribe("thread/1")))).toBe(true)
        }
      }),
    ))

  test("seeds committed room history and parses live Dot posts without admitting any through the runtime", () =>
    run(
      Effect.gen(function* () {
        const profile = yield* profiles()
        const view = yield* fixture
        view.state.history = [{ items: [posted("historical")], prev_cursor: null }]
        const admissions: DotsRuntime.PeerAdmission[] = []
        const pulled = yield* Queue.unbounded<DotsTransport.Inbound>()
        const transport: DotsTransport.Interface = {
          ...view.transport,
          connect: (credentials) =>
            view.transport.connect(credentials).pipe(
              Effect.map((connection) => ({
                ...connection,
                inbound: connection.inbound.pipe(Stream.rechunk(1), Stream.tap((event) => Queue.offer(pulled, event))),
              })),
            ),
        }
        const service = yield* DotsRuntime.make({
          enabled: () => Effect.succeed(true),
          integration: profile.integrations,
          transport,
          attachments: () => Effect.die("No attachment reads are expected"),
          sessions: {
            exists: (id) => Effect.succeed(id === s1),
            admit: (input) => Effect.sync(() => { admissions.push(input) }),
          },
        })
        yield* service.bind({ sessionID: s1, target: { profile: "fixture-a", dotID: "dot-1", threadID: "thread/1", generation: "generation-1", label: "dot-1" } })
        expect(admissions).toEqual([])
        const notify = (type: string, payload: unknown) =>
          Queue.offer(view.notices, { type: "message", topicID: "calpico-chatgpt-messaging", payload: { type, payload } })
        const pull = Queue.take(pulled).pipe(Effect.timeout("2 seconds"))
        view.state.history = [{ items: [posted("historical"), posted("live")], prev_cursor: null }]
        yield* notify("calpico-message-add", { room_id: "room/1" })
        expect(yield* pull).toMatchObject({ type: "message", itemID: "historical" })
        expect(yield* pull).toMatchObject({ type: "message", itemID: "live" })
        view.state.history = [{ items: [posted("historical"), posted("live", "dot-member", "Edited"), posted("next")], prev_cursor: null }]
        yield* notify("calpico-message-update", { room_id: "room/1", message_id: "live" })
        const batch = [yield* pull, yield* pull, yield* pull]
        expect(batch.map((event) => (event.type === "message" ? event.itemID : undefined))).toEqual(["historical", "live", "next"])
        expect(batch[1]).toMatchObject({ text: "Edited" })
        view.state.history = [{ items: [posted("historical")], prev_cursor: null }]
        yield* notify("calpico-room-update", { room_id: "room/1" })
        expect(yield* pull).toMatchObject({ type: "message", itemID: "historical" })
        expect(admissions).toEqual([])
      }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))),
    ))
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))
const integrationID = Integration.ID.make("openai")
const methodID = Integration.MethodID.make("chatgpt-browser")
const s1 = SessionSchema.ID.make("ses_dots_one")
const s2 = SessionSchema.ID.make("ses_dots_two")

const destinationsByAccount: Record<string, DotsTransport.Destination[]> = {
  "fixture-account-a": [
    { dotID: "dot_a", threadID: "thread_a1", generation: "1", label: "Dot A" },
    { dotID: "dot_a", threadID: "thread_a2", generation: "1", label: "Dot A second" },
  ],
  "fixture-account-b": [{ dotID: "dot_b", threadID: "thread_b1", generation: "7", label: "Dot B" }],
}

const target = (profile: string, destination: DotsTransport.Destination): Dots.Target => ({ profile, ...destination })
const a1 = target("fixture-a", destinationsByAccount["fixture-account-a"]![0]!)
const a2 = target("fixture-a", destinationsByAccount["fixture-account-a"]![1]!)
const b1 = target("fixture-b", destinationsByAccount["fixture-account-b"]![0]!)

function fakeTransport() {
  const log = {
    destinations: [] as DotsTransport.Credentials[],
    connects: [] as DotsTransport.Credentials[],
    subscribes: [] as string[],
    sends: [] as DotsTransport.Outgoing[],
    controls: [] as Array<{ credentials: DotsTransport.Credentials; dotID: string; threadID: string; action: "pause" | "resume" }>,
    runtimeReads: [] as DotsTransport.Credentials[],
    closed: 0,
  }
  const control = {
    offered: undefined as DotsTransport.Destination[] | undefined,
    destinationFailures: [] as DotsTransport.Error[],
    connectFailures: [] as DotsTransport.Error[],
    send: (input: DotsTransport.Outgoing): Effect.Effect<DotsTransport.Receipt, DotsTransport.Error> =>
      Effect.succeed({ status: "accepted", turnID: `turn_${input.messageID}` }),
    runtimeState: (_credentials: DotsTransport.Credentials): Effect.Effect<"paused" | "unpaused" | "unknown", DotsTransport.Error> => Effect.succeed("unpaused"),
    control: (action: "pause" | "resume", _isCurrent: () => boolean): Effect.Effect<"paused" | "unpaused" | "unknown", DotsTransport.Error> => Effect.succeed(action === "pause" ? "paused" : "unpaused"),
    connections: [] as Array<Queue.Queue<DotsTransport.Inbound, DotsTransport.Error | Cause.Done>>,
    snapshot: (_threadID: string): ReadonlyArray<DotsTransport.Inbound> => [],
    subscribe: (threadID: string): Effect.Effect<ReadonlyArray<DotsTransport.Inbound>, DotsTransport.Error> =>
      Effect.sync(() => control.snapshot(threadID)),
  }
  return Effect.gen(function* () {
    const connected = yield* Queue.unbounded<number>()
    const pulled = yield* Queue.unbounded<DotsTransport.Inbound>()
    const transport: DotsTransport.Interface = {
      runtimeState: (credentials) => Effect.suspend(() => {
        log.runtimeReads.push(credentials)
        return control.runtimeState(credentials)
      }),
      control: (credentials, input, isCurrent, onDispatch) => Effect.suspend(() => {
        if (!isCurrent()) return Effect.fail(new DotsTransport.Error({ reason: "target-changed", message: "Target changed" }))
        onDispatch?.()
        log.controls.push({ credentials, ...input })
        return control.control(input.action, isCurrent)
      }),
      destinations: (credentials) =>
        Effect.suspend(() => {
          log.destinations.push(credentials)
          const failure = control.destinationFailures.shift()
          if (failure) return Effect.fail(failure)
          return Effect.succeed(control.offered ?? destinationsByAccount[credentials.accountID] ?? [])
        }),
      connect: (credentials) =>
        Effect.gen(function* () {
          log.connects.push(credentials)
          const failure = control.connectFailures.shift()
          if (failure) return yield* Effect.fail(failure)
          const inbound = yield* Queue.unbounded<DotsTransport.Inbound, DotsTransport.Error | Cause.Done>()
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              log.closed++
            }),
          )
          control.connections.push(inbound)
          const index = control.connections.length
          return {
            subscribe: (threadID) =>
              Effect.suspend(() => {
                log.subscribes.push(threadID)
                return control.subscribe(threadID)
              }).pipe(Effect.tap(() => Queue.offer(connected, index))),
            send: (input) =>
              Effect.suspend(() => {
                log.sends.push(input)
                return control.send(input)
              }),
            inbound: Stream.fromQueue(inbound).pipe(
              Stream.rechunk(1),
              Stream.tap((event) => Queue.offer(pulled, event)),
            ),
          }
        }),
    }
    return { transport, log, control, connected, pulled }
  })
}

const profiles = Effect.fn(function* () {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const refreshed: string[] = []
  yield* integrations.transform((draft) =>
    draft.method.update({
      integrationID,
      method: { id: methodID, type: "oauth", label: "Synthetic ChatGPT" },
      authorize: () => Effect.die("Authentication must not be started"),
      refresh: (value) =>
        Effect.sync(() => {
          refreshed.push(value.access)
          return Credential.OAuth.make({ ...value, access: "fixture-refreshed", expires: Date.now() + 3_600_000 })
        }),
    }),
  )
  const oauth = (name: string) =>
    Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: `fixture-access-${name}`,
      refresh: `fixture-refresh-${name}`,
      expires: Date.now() + 3_600_000,
      metadata: { accountID: `fixture-account-${name}` },
    })
  const first = yield* credentials.create({ integrationID, label: "fixture-a", value: oauth("a") })
  const second = yield* credentials.create({ integrationID, label: "fixture-b", value: oauth("b") })
  yield* credentials.create({
    integrationID,
    label: "fixture-key",
    value: Credential.Key.make({ type: "key", key: "fixture-api-key" }),
  })
  yield* credentials.activate(first.id)
  return { integrations, credentials, first, second, refreshed }
})

const runtime = Effect.fn(function* (
  options: {
    readonly sessions?: ReadonlySet<SessionSchema.ID>
    readonly attachments?: DotsAttachments.Read
    readonly retryDelay?: (attempt: number) => number
    readonly enabled?: boolean | "omitted" | "defect" | "throws" | "succeed"
  } = {},
) {
  const profile = yield* profiles()
  const fake = yield* fakeTransport()
  const gate = { on: options.enabled !== false, checks: 0 }
  const integrationReads = { count: 0 }
  const changes = yield* Queue.unbounded<void>()
  const setEnabled = (on: boolean) => Effect.sync(() => { gate.on = on }).pipe(Effect.andThen(Queue.offer(changes, undefined)))
  const admitted = yield* Queue.unbounded<DotsRuntime.PeerAdmission>()
  const admissions: DotsRuntime.PeerAdmission[] = []
  const known = options.sessions ?? new Set([s1, s2])
  const attachments =
    options.attachments ??
    DotsAttachments.make({
      store: { resolveURI: () => Effect.die("unused"), read: () => Effect.die("unused") },
    })
  const service = yield* DotsRuntime.make({
    ...(options.enabled === "omitted"
      ? {}
      : {
          enabled:
            options.enabled === "defect"
              ? () => Effect.die("synthetic gate read failure")
              : options.enabled === "throws"
                ? () => { throw new Error("synthetic gate callback failure") }
                : options.enabled === "succeed"
                  ? () => Effect.succeed(gate.on)
                  : () => Effect.sync(() => { gate.checks++; return gate.on }),
        }),
    changes: Stream.fromQueue(changes),
    integration: {
      connection: profile.integrations.connection,
      get: (id) => Effect.sync(() => { integrationReads.count++ }).pipe(Effect.andThen(profile.integrations.get(id))),
    },
    transport: fake.transport,
    attachments,
    retryDelay: options.retryDelay ?? (() => 0),
    sessions: {
      exists: (sessionID) => Effect.succeed(known.has(sessionID)),
      admit: (input) =>
        Effect.gen(function* () {
          admissions.push(input)
          yield* Queue.offer(admitted, input)
        }),
    },
  })
  return { ...profile, ...fake, service, admitted, admissions, gate, setEnabled, integrationReads }
})

const connectedStatus = (service: DotsRuntime.Interface, sessionID: SessionSchema.ID) =>
  service
    .status(sessionID)
    .pipe(
      Effect.repeat({ until: (item) => item.state === "connected", schedule: Schedule.spaced("1 millis") }),
      Effect.timeout("2 seconds"),
    )

const code = <A>(effect: Effect.Effect<A, DotsRuntime.Error>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  )

let drains = 0
const drained = (value: { readonly control: { readonly connections: Array<Queue.Queue<DotsTransport.Inbound, DotsTransport.Error | Cause.Done>> }; readonly pulled: Queue.Queue<DotsTransport.Inbound> }, connection = 0) =>
  Effect.gen(function* () {
    const marker = `drain-${++drains}`
    yield* Queue.offer(value.control.connections[connection]!, { type: "turn.completed", threadID: marker, turnID: marker })
    while ((yield* Queue.take(value.pulled).pipe(Effect.timeout("2 seconds"))).threadID !== marker) continue
  })

describe("Dots runtime", () => {
  it.live("L10 names only the explicitly confirmed binding and renames without redirecting", () => Effect.gen(function* () {
    const value = yield* runtime()
    const named = yield* value.service.bind({ sessionID: s1, target: { ...a1, label: "  V  " } })
    expect(named.target).toEqual({ ...a1, label: "V" })
    expect((yield* value.service.bind({ sessionID: s2, target: b1 })).target).toEqual(b1)
    const connections = value.log.connects.length
    expect((yield* value.service.bind({ sessionID: s1, target: { ...a1, label: "  Vega  " } })).target).toEqual({ ...a1, label: "Vega" })
    expect((yield* value.service.status(s2)).target).toEqual(b1)
    expect(value.log.connects).toHaveLength(connections)
    expect(value.log.sends).toEqual([])
    expect(value.admissions).toEqual([])
    expect((yield* value.service.bind({ sessionID: s1, target: { ...a1, label: "   " } })).target).toEqual(a1)
  }))

  it.live("L10 generation and account replacement require confirmation and never inherit a prior name", () => Effect.gen(function* () {
    const value = yield* runtime()
    yield* value.service.bind({ sessionID: s1, target: { ...a1, label: "V" } })
    const replacement = { ...a1, generation: "new-generation", label: "Primary Dot conversation" }
    value.control.offered = [replacement]
    expect(yield* code(value.service.attachment(s1))).toBe("target_changed")
    expect(yield* code(value.service.bind({ sessionID: s1, target: a1 }))).toBe("target_unavailable")
    expect((yield* value.service.bind({ sessionID: s1, target: replacement })).target).toEqual(replacement)
    yield* value.service.bind({ sessionID: s1, target: { ...replacement, label: "V" } })
    yield* value.credentials.update(value.first.id, { value: Credential.OAuth.make({
      type: "oauth", methodID, access: "fixture-replacement", refresh: "fixture-replacement-refresh",
      expires: Date.now() + 3_600_000, metadata: { accountID: "fixture-replacement-account" },
    }) })
    expect(yield* code(value.service.attachment(s1))).toBe("profile_changed")
    expect((yield* value.service.bind({ sessionID: s1, target: replacement })).target).toEqual(replacement)
    expect(value.log.sends).toEqual([])
    expect(value.admissions).toEqual([])
  }))

  it.effect("bounds runtime status reads and degrades a hung read to unknown", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const started = yield* Deferred.make<void>()
      let interrupted = 0
      value.control.runtimeState = () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Effect.sync(() => { interrupted++ })))
      const read = yield* value.service.status(s1).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust("15 seconds")
      expect((yield* Fiber.join(read)).runtimeState).toBe("unknown")
      expect(interrupted).toBe(1)
      expect(value.log.controls).toEqual([])
    }),
  )

  it.effect("bounds dispatched runtime controls and preserves their unknown lock after timeout", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const started = yield* Deferred.make<void>()
      value.control.control = () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      const call = yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 })).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(call)).toBe("control_failed")
      expect((yield* value.service.status(s1)).runtimeState).toBe("unknown")
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
      expect(value.log.controls).toHaveLength(1)
    }),
  )

  it.live("refuses runtime controls before snapshots settle and after disconnect including during preflight", () =>
    Effect.gen(function* () {
      const value = yield* runtime({ retryDelay: () => 1000 })
      const subscribing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      value.control.subscribe = () => Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as([]))
      const binding = yield* value.service.bind({ sessionID: s1, target: a1 }).pipe(Effect.forkChild)
      yield* Deferred.await(subscribing)
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("connection_unavailable")
      expect((yield* value.service.status(s1)).runtimeState).toBe("unknown")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(binding)
      value.control.runtimeState = () => Effect.gen(function* () {
        value.control.runtimeState = () => Effect.succeed("unpaused")
        yield* Queue.end(value.control.connections[0]!)
        yield* value.service.status(s1).pipe(Effect.repeat({ until: status => status.state !== "connected" }), Effect.timeout("2 seconds"))
        return "unpaused" as const
      }).pipe(Effect.orDie)
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("connection_unavailable")
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("connection_unavailable")
      expect(value.log.controls).toEqual([])
    }),
  )

  it.live("uses credentials refreshed after preflight and never retries an unauthorized control", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.runtimeState = () => Effect.gen(function* () {
        yield* value.credentials.refresh(value.first, Effect.succeed(Credential.OAuth.make({
          type: "oauth", methodID, access: "fixture-fresh-control", refresh: "fixture-refresh-a",
          expires: Date.now() + 3_600_000, metadata: { accountID: "fixture-account-a" },
        }))).pipe(Effect.orDie)
        return "unpaused" as const
      })
      value.control.control = () => Effect.fail(new DotsTransport.Error({ reason: "unauthorized", message: "Rejected control" }))
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("authentication_failed")
      expect(value.log.controls).toHaveLength(1)
      expect(value.log.controls[0]?.credentials.access).toBe("fixture-fresh-control")
      expect(value.refreshed).toEqual([])
      expect((yield* value.service.status(s1)).runtimeState).toBe("unknown")
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
    }),
  )

  it.live("rechecks binding and account identity after runtime preflight", () =>
    Effect.gen(function* () {
      for (const change of ["target", "account"] as const) {
        const value = yield* runtime()
        yield* value.service.bind({ sessionID: s1, target: a1 })
        value.control.runtimeState = () => Effect.gen(function* () {
          value.control.runtimeState = () => Effect.succeed("unpaused")
          if (change === "target") yield* value.service.bind({ sessionID: s1, target: a2 })
          if (change === "account") yield* value.credentials.update(value.first.id, { value: Credential.OAuth.make({
            type: "oauth", methodID, access: "fixture-other", refresh: "fixture-other-refresh",
            expires: Date.now() + 3_600_000, metadata: { accountID: "fixture-other-account" },
          }) })
          return "unpaused" as const
        }).pipe(Effect.orDie)
        expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe(change === "target" ? "target_changed" : "profile_changed")
        expect(value.log.controls).toEqual([])
      }
    }),
  )

  it.live("keeps interrupted and root-replaced dispatched controls uncertain until reconfirmed", () =>
    Effect.gen(function* () {
      for (const kind of ["interrupted", "replaced"] as const) {
        const value = yield* runtime()
        yield* value.service.bind({ sessionID: s1, target: a1 })
        const started = yield* Deferred.make<void>()
        value.control.control = () => Deferred.succeed(started, undefined).pipe(Effect.andThen(kind === "interrupted"
          ? Effect.never
          : Effect.fail(new DotsTransport.Error({ reason: "target-changed", message: "Root changed" }))))
        const call = yield* value.service.pause({ sessionID: s1, expectedTarget: a1 }).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        if (kind === "interrupted") yield* Fiber.interrupt(call)
        if (kind === "replaced") {
          const exit = yield* Fiber.join(call)
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ code: "target_changed" })
        }
        expect((yield* value.service.status(s1)).runtimeState).toBe("unknown")
        expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
        expect(value.log.controls).toHaveLength(1)
      }
    }),
  )

  it.live("serializes runtime controls and returns verified pause and resume states", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const attached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      value.control.control = (action, isCurrent) => Effect.gen(function* () {
        expect(isCurrent()).toBe(true)
        yield* Deferred.succeed(attached, undefined)
        yield* Deferred.await(release)
        expect(isCurrent()).toBe(true)
        return action === "pause" ? "paused" as const : "unpaused" as const
      })
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const first = yield* value.service.pause({ sessionID: s1, expectedTarget: a1 }).pipe(Effect.forkChild)
      yield* Deferred.await(attached)
      expect(value.admissions).toEqual([])
      expect(value.log.sends).toEqual([])
      yield* Queue.offer(value.control.connections[0]!, { type: "message", threadID: a1.threadID, itemID: "during-control", text: "Inbound while control waits" })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      expect(value.log.sends).toEqual([])
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(first)).runtimeState).toBe("paused")
      value.control.runtimeState = () => Effect.succeed("paused")
      expect((yield* value.service.resume({ sessionID: s1, expectedTarget: a1 })).runtimeState).toBe("unpaused")
      expect(value.log.controls.map(item => item.action)).toEqual(["pause", "resume"])
      expect(value.admissions).toEqual([])
    }),
  )

  it.live("reads current runtime state before POST without rediscovering destinations", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const reads = value.log.destinations.length
      const runtimeReads = value.log.runtimeReads.length
      value.control.destinationFailures.push(new DotsTransport.Error({ reason: "unavailable", message: "No rediscovery is allowed" }))
      yield* value.service.pause({ sessionID: s1, expectedTarget: a1 })
      expect(value.log.destinations).toHaveLength(reads)
      expect(value.log.runtimeReads).toHaveLength(runtimeReads + 1)
      expect(value.log.controls[0]?.action).toBe("pause")
    }),
  )

  it.live("locks uncertain controls across status reads and reconnect until explicit reconfirmation", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.control = () => Effect.fail(new DotsTransport.Error({ reason: "disconnected", message: "Control outcome is unknown" }))
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("control_failed")
      yield* Queue.end(value.control.connections[0]!)
      yield* Queue.take(value.connected)
      yield* Queue.take(value.connected)
      yield* connectedStatus(value.service, s1)
      expect((yield* value.service.status(s1)).runtimeState).toBe("unknown")
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
      expect(value.log.controls).toHaveLength(1)
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.control = () => Effect.succeed("paused")
      expect((yield* value.service.pause({ sessionID: s1, expectedTarget: a1 })).runtimeState).toBe("paused")
      expect(value.log.controls).toHaveLength(2)
    }),
  )

  it.live("reads runtime status without mutations and reports read failure as unknown", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect((yield* value.service.status(s1)).runtimeState).toBe("unpaused")
      value.control.runtimeState = () => Effect.succeed("paused")
      expect((yield* value.service.status(s1)).runtimeState).toBe("paused")
      value.control.runtimeState = () => Effect.fail(new DotsTransport.Error({ reason: "unavailable", message: "Read unavailable" }))
      expect((yield* value.service.status(s1)).runtimeState).toBe("unknown")
      expect(value.log.controls).toEqual([])
    }),
  )

  it.live("rejects wrong starting states and stale targets before POST", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(yield* code(value.service.resume({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
      value.control.runtimeState = () => Effect.succeed("paused")
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
      value.control.runtimeState = () => Effect.succeed("unknown")
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("runtime_unknown")
      for (const expectedTarget of [a2, { ...a1, profile: "other" }, { ...a1, generation: "2" }])
        expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget }))).toBe("target_changed")
      expect(value.log.controls).toEqual([])
    }),
  )

  it.live("never admits room revisions or completed messages from snapshots, reconnects or live updates", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const revision = (hash: string, text: string): DotsTransport.Inbound => ({
        type: "message.revision",
        threadID: a1.threadID,
        itemID: "versioned-room-item",
        revision: hash,
        text,
      })
      value.control.snapshot = () => [revision("initial", "Initial visible text")]
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.snapshot = () => [
        revision("initial", "Initial visible text"),
        revision("updated", "Updated visible text"),
        { type: "message", threadID: a1.threadID, itemID: "snapshot-room-item", text: "Snapshot reply" },
      ]
      const first = value.control.connections[0]
      if (!first) throw new Error("The first connection is missing")
      expect(yield* Queue.take(value.connected)).toBe(1)
      yield* Queue.end(first)
      expect(yield* Queue.take(value.connected)).toBe(2)
      yield* connectedStatus(value.service, s1)
      expect(value.admissions).toEqual([])
      const second = value.control.connections[1]
      if (!second) throw new Error("The replacement connection is missing")
      yield* Queue.offer(second, revision("updated", "Updated visible text"))
      yield* Queue.offer(second, revision("newest", "Newest visible text"))
      yield* Queue.offer(second, revision("newest", "Newest visible text"))
      yield* Queue.offer(second, { type: "turn.completed", threadID: a1.threadID, turnID: "unrelated-room-turn" })
      yield* Queue.offer(second, {
        type: "message",
        threadID: a1.threadID,
        itemID: "completed-room-item",
        text: "Completed reply",
      })
      yield* drained(value, 1)
      expect(value.admissions).toEqual([])
      expect(value.log.sends).toEqual([])
      expect(value.log.controls).toEqual([])
    }),
  )
  it.live("refuses dispatch when the service no longer offers the confirmed generation", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.offered = [{ ...a1, generation: "replacement-generation" }]
      expect(
        yield* code(
          value.service.send({ sessionID: s1, expectedTarget: a1, id: "stale-generation", text: "Do not transmit" }),
        ),
      ).toBe("target_changed")
      expect(value.log.sends).toEqual([])
    }),
  )
  it.live("reads destinations with the explicitly named profile instead of the active profile", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      expect(yield* value.service.targets("fixture-b")).toEqual([b1])
      expect(value.log.destinations).toEqual([{ access: "fixture-access-b", accountID: "fixture-account-b" }])
      expect(value.log.connects).toEqual([])
    }),
  )

  it.live("rejects missing and non-ChatGPT profiles without contacting the service", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      expect(yield* code(value.service.targets("missing"))).toBe("profile_unavailable")
      expect(yield* code(value.service.targets("fixture-key"))).toBe("profile_unavailable")
      expect(value.log.destinations).toEqual([])
    }),
  )

  it.live("uses named Core OAuth for an authenticated request without exposing credentials", () =>
    Effect.gen(function* () {
      const profile = yield* profiles()
      const fake = yield* fakeTransport()
      const calls: Array<{ url: string; headers: Headers }> = []
      const http = DotsHttp.make({
        fetch: async (url, init) => {
          calls.push({ url, headers: new Headers(init.headers) })
          return Response.json({ selection: null })
        },
      })
      const service = yield* DotsRuntime.make({
        enabled: () => Effect.succeed(true),
        integration: profile.integrations,
        transport: {
          ...fake.transport,
          destinations: (credentials) =>
            http
              .json(credentials, { method: "GET", path: "/tbo/primary" })
              .pipe(Effect.as(destinationsByAccount[credentials.accountID] ?? [])),
        },
        attachments: () => Effect.die("Discovery must not read attachments"),
        sessions: { exists: () => Effect.succeed(true), admit: () => Effect.void },
      })
      const targets = yield* service.targets("fixture-b")
      expect(targets).toEqual([b1])
      expect(calls).toHaveLength(1)
      const [request] = calls
      if (!request) throw new Error("The authenticated request was not captured")
      expect(request.url).toBe("https://chatgpt.com/backend-api/tbo/primary")
      expect(request.headers.get("authorization")).toBe("Bearer fixture-access-b")
      expect(request.headers.get("x-openai-expected-account-id")).toBe("fixture-account-b")
      expect(request.headers.get("originator")).toBe("Codex Desktop")
      expect(request.headers.get("user-agent")?.startsWith("Codex Desktop/")).toBe(true)
      expect(JSON.stringify(targets)).not.toContain("fixture-access-b")
      expect(JSON.stringify(targets)).not.toContain("fixture-account-b")
      expect(yield* code(service.targets("fixture-key"))).toBe("profile_unavailable")
      expect(calls).toHaveLength(1)
      expect(fake.log.connects).toEqual([])
    }),
  )

  it.live("refreshes the named profile once after an unauthorized destination read", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      value.control.destinationFailures.push(new DotsTransport.Error({ reason: "unauthorized", message: "expired" }))
      expect(yield* value.service.targets("fixture-b")).toEqual([b1])
      expect(value.refreshed).toEqual(["fixture-access-b"])
      expect(value.log.destinations.map((item) => item.access)).toEqual(["fixture-access-b", "fixture-refreshed"])
    }),
  )

  it.live("confirms a destination without sending and reports it connected", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      expect(yield* value.service.status(s1)).toEqual({ enabled: true, state: "disconnected" })
      expect(yield* value.service.bind({ sessionID: s1, target: a1 })).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
      expect(yield* value.service.status(s1)).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
      expect(value.log.subscribes).toEqual(["thread_a1"])
      expect(value.log.sends).toEqual([])
      expect(value.log.connects).toEqual([{ access: "fixture-access-a", accountID: "fixture-account-a" }])
    }),
  )

  it.live("rejects stale or unknown destinations and unknown Sessions before connecting", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      expect(yield* code(value.service.bind({ sessionID: s1, target: { ...a1, generation: "0" } }))).toBe(
        "target_unavailable",
      )
      expect(yield* code(value.service.bind({ sessionID: s1, target: { ...a1, profile: "fixture-b" } }))).toBe(
        "target_unavailable",
      )
      expect(
        yield* code(value.service.bind({ sessionID: SessionSchema.ID.make("ses_dots_missing"), target: a1 })),
      ).toBe("session_not_found")
      expect(value.log.connects).toEqual([])
    }),
  )

  it.live("lets one Session own a destination at a time", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(yield* code(value.service.bind({ sessionID: s2, target: a1 }))).toBe("target_in_use")
      expect(yield* value.service.status(s2)).toEqual({ enabled: true, state: "disconnected" })
    }),
  )

  it.live("shares one connection per exact account and closes it with its last binding", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* value.service.bind({ sessionID: s2, target: a2 })
      expect(value.log.connects).toHaveLength(1)
      yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "manual" })
      yield* value.service.send({
        sessionID: s2,
        expectedTarget: a2,
        id: "m2",
        text: "agent",
        causalMessageID: "msg_assistant",
      })
      expect(value.log.sends.map((item) => item.threadID)).toEqual(["thread_a1", "thread_a2"])
      expect(value.log.connects).toHaveLength(1)

      yield* value.service.bind({ sessionID: s1, target: b1 })
      expect(value.log.connects.map((item) => item.accountID)).toEqual(["fixture-account-a", "fixture-account-b"])
      expect(value.log.closed).toBe(0)
      yield* value.service.bind({ sessionID: s2, target: { ...a2 } })
      expect(value.log.connects).toHaveLength(2)
      yield* code(value.service.bind({ sessionID: s2, target: b1 }))
      expect(value.log.closed).toBe(0)
    }),
  )

  it.live("closes an account connection when its last Session binds elsewhere", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* value.service.bind({ sessionID: s1, target: b1 })
      expect(value.log.closed).toBe(1)
      expect(yield* value.service.status(s1)).toEqual({ enabled: true, target: b1, state: "connected", runtimeState: "unpaused" })
    }),
  )

  it.live("sends only the current text and explicitly chosen files", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const directory = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "dots-send-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
      const file = path.join(directory, "notes.txt")
      yield* Effect.promise(() => writeFile(file, "synthetic notes"))
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const delivery = yield* value.service.send({
        sessionID: s1,
        expectedTarget: a1,
        id: "m1",
        text: "Review these",
        files: [
          { uri: pathToFileURL(file).href, name: "notes.txt" },
          { uri: "data:image/png;base64,iVBORw0KGgo=", name: "pasted.png" },
        ],
      })
      expect(delivery).toEqual({ messageID: "m1", status: "accepted", turnID: "turn_m1" })
      expect(value.log.sends).toHaveLength(1)
      const sent = value.log.sends[0]!
      expect(sent.threadID).toBe("thread_a1")
      expect(sent.messageID).toBe("m1")
      expect(sent.text).toBe("Review these")
      expect(
        sent.files.map((item) => ({
          name: item.name,
          mime: item.mime,
          text: Buffer.from(item.bytes).toString("base64"),
        })),
      ).toEqual([
        { name: "notes.txt", mime: "text/plain", text: Buffer.from("synthetic notes").toString("base64") },
        { name: "pasted.png", mime: "image/png", text: "iVBORw0KGgo=" },
      ])
    }),
  )

  it.live("rejects empty, oversized, directory, and unsupported attachments before transmitting", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const directory = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "dots-limit-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
      const large = path.join(directory, "large.bin")
      yield* Effect.promise(() => writeFile(large, ""))
      yield* Effect.promise(() => truncate(large, AttachmentStore.MAX_BYTES + 1))
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "m0", text: "   " }))).toBe(
        "invalid_input",
      )
      for (const uri of [pathToFileURL(large).href, pathToFileURL(directory).href, "https://example.invalid/file.txt"])
        expect(
          yield* code(
            value.service.send({
              sessionID: s1,
              expectedTarget: a1,
              id: `m-${uri.length}`,
              text: "x",
              files: [{ uri }],
            }),
          ),
        ).toBe("attachment_invalid")
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("requires a confirmed destination before sending", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" }))).toBe(
        "not_bound",
      )
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("not_bound")
      expect(value.log.connects).toEqual([])
    }),
  )

  it.live("applies the empty-file rule to managed attachments before transmission", () =>
    Effect.gen(function* () {
      const value = yield* runtime({
        attachments: DotsAttachments.make({
          store: {
            resolveURI: () =>
              Effect.succeed({ type: "managed" as const, digest: "0".repeat(64), path: "attachments/empty", bytes: 0 }),
            read: () => Effect.succeed(new Uint8Array()),
          },
        }),
      })
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(
        yield* code(
          value.service.send({
            sessionID: s1,
            expectedTarget: a1,
            id: "empty_managed",
            text: "hello",
            files: [{ uri: `ycoding-attachment://sha256/${"0".repeat(64)}`, name: "empty.txt" }],
          }),
        ),
      ).toBe("attachment_invalid")
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("refuses to send when the confirmed destination differs from the one the sender saw", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a2, id: "m1", text: "hello" }))).toBe(
        "target_changed",
      )
      expect(
        yield* code(
          value.service.send({ sessionID: s1, expectedTarget: { ...a1, generation: "2" }, id: "m2", text: "hello" }),
        ),
      ).toBe("target_changed")
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("refuses a send whose destination is rebound while its attachments are read", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const reading = yield* Deferred.make<void>()
      const value = yield* runtime({
        attachments: () =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ name: "notes.txt", mime: "text/plain", bytes: new TextEncoder().encode("notes") }),
          ),
      })
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const sending = yield* value.service
        .send({
          sessionID: s1,
          expectedTarget: a1,
          id: "m1",
          text: "hello",
          files: [{ uri: "file:///synthetic/notes.txt" }],
        })
        .pipe(Effect.flip, Effect.forkChild)
      yield* Deferred.await(reading)
      yield* value.service.bind({ sessionID: s1, target: a2 })
      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.join(sending)).code).toBe("target_changed")
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("returns the first delivery for a reused message ID without transmitting again", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const first = yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })
      const second = yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello again" })
      expect(second).toEqual(first)
      expect(value.log.sends).toHaveLength(1)
    }),
  )

  it.live("retains an interrupted dispatched send as unknown instead of replaying it", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const dispatched = yield* Deferred.make<void>()
      value.control.send = () => Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Effect.never))
      const input = { sessionID: s1, expectedTarget: a1, id: "interrupted", text: "current text" }
      const sending = yield* value.service.send(input).pipe(Effect.forkChild)
      yield* Deferred.await(dispatched)
      yield* Fiber.interrupt(sending)
      value.control.send = () => Effect.succeed({ status: "accepted" })
      expect((yield* value.service.send(input).pipe(Effect.timeout("1 second"))).status).toBe("unknown")
      expect(value.log.sends).toHaveLength(1)
    }),
  )

  it.live("permits retry after cancellation before any dispatch", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>()
      let blocked = true
      const value = yield* runtime({
        attachments: () =>
          blocked
            ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({ name: "chosen.txt", mime: "text/plain", bytes: new TextEncoder().encode("chosen") }),
      })
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const input = {
        sessionID: s1,
        expectedTarget: a1,
        id: "before_dispatch",
        text: "current text",
        files: [{ uri: "data:text/plain;base64,eA==" }],
      }
      const sending = yield* value.service.send(input).pipe(Effect.forkChild)
      yield* Deferred.await(reading)
      yield* Fiber.interrupt(sending)
      expect(value.log.sends).toEqual([])
      blocked = false
      expect((yield* value.service.send(input).pipe(Effect.timeout("1 second"))).status).toBe("accepted")
      expect(value.log.sends).toHaveLength(1)
    }),
  )

  it.live("retains an uncertain message identity after sustained later traffic", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.send = () => Effect.succeed({ status: "unknown" })
      yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "uncertain", text: "first" })
      value.control.send = () => Effect.succeed({ status: "accepted" })
      for (let i = 0; i < 1025; i++)
        yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: `later_${i}`, text: "later" })
      const prior = value.log.sends.length
      expect(
        (yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "uncertain", text: "first" })).status,
      ).toBe("unknown")
      expect(value.log.sends).toHaveLength(prior)
    }),
  )

  it.live("reports an interrupted transmission as unknown and never replays it after reconnecting", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* Queue.take(value.connected)
      value.control.send = () =>
        Effect.fail(new DotsTransport.Error({ reason: "disconnected", message: "socket closed" }))
      expect(yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).toEqual({
        messageID: "m1",
        status: "unknown",
      })
      yield* Queue.end(value.control.connections[0]!)
      expect(yield* Queue.take(value.connected)).toBe(2)
      expect(value.log.subscribes).toEqual(["thread_a1", "thread_a1"])
      expect(yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).toEqual({
        messageID: "m1",
        status: "unknown",
      })
      expect(value.log.sends).toHaveLength(1)
      expect(yield* connectedStatus(value.service, s1)).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
    }),
  )

  it.live("admits no correlated peer reply and still correlates the sent turn on its echo", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.send = () => Effect.fail(new DotsTransport.Error({ reason: "disconnected", message: "response lost" }))
      expect(yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).toEqual({
        messageID: "m1",
        status: "unknown",
      })
      const inbound = value.control.connections[0]!
      yield* Queue.offer(inbound, { type: "turn.started", threadID: "thread_a1", turnID: "turn_m1" })
      yield* Queue.offer(inbound, {
        type: "message",
        threadID: "thread_other",
        turnID: "t9",
        itemID: "i9",
        text: "stray",
      })
      yield* Queue.offer(inbound, {
        type: "message",
        threadID: "thread_a1",
        turnID: "turn_m1",
        itemID: "item_1",
        text: "Hi there",
      })
      yield* Queue.offer(inbound, { type: "user.message", threadID: "thread_a1", turnID: "turn_m1", clientMessageID: "m1" })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      expect(yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).toEqual({
        messageID: "m1",
        status: "accepted",
        turnID: "turn_m1",
      })
      expect(value.log.sends).toHaveLength(1)
    }),
  )

  it.live("carries a fresh message group and the causal message on each outgoing transmission", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* value.service.send({
        sessionID: s1,
        expectedTarget: a1,
        id: "m1",
        text: "one",
        causalMessageID: "msg_assistant",
      })
      yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m2", text: "two" })
      const [first, second] = value.log.sends
      expect(first).toMatchObject({ messageID: "m1", causalMessageID: "msg_assistant" })
      expect(second?.messageID).toBe("m2")
      expect(second).not.toHaveProperty("causalMessageID")
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      expect(first?.groupID).toMatch(uuid)
      expect(second?.groupID).toMatch(uuid)
      expect(second?.groupID).not.toBe(first?.groupID)
    }),
  )

  it.live("admits no streamed reply assembled from deltas when its turn completes", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })
      const inbound = value.control.connections[0]!
      yield* Queue.offer(inbound, {
        type: "message.delta",
        threadID: "thread_a1",
        turnID: "turn_m1",
        itemID: "item_1",
        delta: "Hel",
      })
      yield* Queue.offer(inbound, {
        type: "message.delta",
        threadID: "thread_a1",
        turnID: "turn_m1",
        itemID: "item_1",
        delta: "lo",
      })
      yield* Queue.offer(inbound, { type: "turn.completed", threadID: "thread_a1", turnID: "turn_m1" })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      expect(value.log.sends).toHaveLength(1)
    }),
  )

  it.live("admits neither streamed deltas nor their completed item", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const inbound = value.control.connections[0]!
      yield* Queue.offer(inbound, {
        type: "message.delta",
        threadID: "thread_a1",
        turnID: "t1",
        itemID: "item_1",
        delta: "Draft",
      })
      yield* Queue.offer(inbound, {
        type: "message",
        threadID: "thread_a1",
        turnID: "t1",
        itemID: "item_1",
        text: "Final",
      })
      yield* Queue.offer(inbound, { type: "turn.completed", threadID: "thread_a1", turnID: "t1" })
      yield* Queue.offer(inbound, {
        type: "message",
        threadID: "thread_a1",
        turnID: "t2",
        itemID: "item_2",
        text: "Next",
      })
      yield* drained(value)
      expect(value.admissions).toEqual([])
    }),
  )

  it.live("seeds the first thread snapshot and admits neither earlier nor later replies", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      value.control.snapshot = () => [
        { type: "user.message", threadID: "thread_a1", turnID: "t0", clientMessageID: "earlier" },
        { type: "message", threadID: "thread_a1", turnID: "t0", itemID: "item_old", text: "Earlier reply" },
        { type: "turn.completed", threadID: "thread_a1", turnID: "t0" },
      ]
      expect(yield* value.service.bind({ sessionID: s1, target: a1 })).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
      expect(value.admissions).toEqual([])
      const inbound = value.control.connections[0]!
      yield* Queue.offer(inbound, {
        type: "message",
        threadID: "thread_a1",
        turnID: "t0",
        itemID: "item_old",
        text: "Earlier reply",
      })
      yield* Queue.offer(inbound, {
        type: "message",
        threadID: "thread_a1",
        turnID: "t1",
        itemID: "item_new",
        text: "New",
      })
      yield* drained(value)
      expect(value.admissions).toEqual([])
    }),
  )

  it.live("admits no unfinished first-snapshot reply at its live completion", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      value.control.snapshot = () => [
        { type: "message.snapshot", threadID: "thread_a1", turnID: "t1", itemID: "i1", text: "Opening " },
      ]
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(value.admissions).toEqual([])
      yield* Queue.offer(value.control.connections[0]!, {
        type: "message.delta",
        threadID: "thread_a1",
        turnID: "t1",
        itemID: "i1",
        delta: "reply",
      })
      yield* Queue.offer(value.control.connections[0]!, { type: "turn.completed", threadID: "thread_a1", turnID: "t1" })
      yield* drained(value)
      expect(value.admissions).toEqual([])
    }),
  )

  it.live("admits nothing from an interrupted partial reply or its authoritative reconnect snapshot", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* Queue.offer(value.control.connections[0]!, {
        type: "message.delta",
        threadID: "thread_a1",
        turnID: "t1",
        itemID: "i1",
        delta: "Old ",
      })
      yield* drained(value)
      value.control.snapshot = () => [
        { type: "message.snapshot", threadID: "thread_a1", turnID: "t1", itemID: "i1", text: "Old recovered " },
      ]
      yield* Queue.end(value.control.connections[0]!)
      yield* Queue.take(value.connected)
      yield* Queue.take(value.connected)
      yield* connectedStatus(value.service, s1)
      yield* Queue.offer(value.control.connections[1]!, {
        type: "message.delta",
        threadID: "thread_a1",
        turnID: "t1",
        itemID: "i1",
        delta: "tail",
      })
      yield* Queue.offer(value.control.connections[1]!, { type: "turn.completed", threadID: "thread_a1", turnID: "t1" })
      yield* drained(value, 1)
      expect(value.admissions).toEqual([])
      expect(value.log.subscribes).toEqual(["thread_a1", "thread_a1"])
    }),
  )

  it.live("keeps a new thread unready on an already connected account", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const subscribing = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      value.control.subscribe = () =>
        Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as([]))
      const binding = yield* value.service.bind({ sessionID: s2, target: a2 }).pipe(Effect.forkChild)
      yield* Deferred.await(subscribing)
      expect((yield* value.service.status(s2)).state).toBe("connecting")
      expect(
        yield* code(value.service.send({ sessionID: s2, expectedTarget: a2, id: "before_snapshot", text: "hello" })),
      ).toBe("connection_unavailable")
      expect(value.log.sends).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.join(binding)).state).toBe("connected")
    }),
  )

  it.live("flushes a live reply received while a new thread snapshot is pending without admitting it", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const subscribing = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      value.control.subscribe = () =>
        Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as([]))
      const binding = yield* value.service.bind({ sessionID: s2, target: a2 }).pipe(Effect.forkChild)
      yield* Deferred.await(subscribing)
      yield* Queue.offer(value.control.connections[0]!, {
        type: "message",
        threadID: "thread_a2",
        turnID: "new_turn",
        itemID: "new_item",
        text: "Arrived during subscription",
      })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      expect((yield* value.service.status(s2)).state).toBe("connecting")
      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.join(binding)).state).toBe("connected")
      expect(value.admissions).toEqual([])
      expect((yield* value.service.send({ sessionID: s2, expectedTarget: a2, id: "after_buffer", text: "hello" })).status).toBe("accepted")
      expect(value.log.sends).toHaveLength(1)
    }),
  )

  it.live("admits no completed reply from live events or reconnect snapshots", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const message = (itemID: string): DotsTransport.Inbound => ({
        type: "message",
        threadID: "thread_a1",
        turnID: `turn_${itemID}`,
        itemID,
        text: itemID,
      })
      value.control.snapshot = () => [message("item_1")]
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* Queue.offer(value.control.connections[0]!, message("item_2"))
      yield* drained(value)
      value.control.snapshot = () => [message("item_1"), message("item_2"), message("item_3")]
      yield* Queue.end(value.control.connections[0]!)
      expect(yield* Queue.take(value.connected)).toBe(1)
      expect(yield* Queue.take(value.connected)).toBe(2)
      yield* connectedStatus(value.service, s1)
      yield* Queue.end(value.control.connections[1]!)
      expect(yield* Queue.take(value.connected)).toBe(3)
      yield* connectedStatus(value.service, s1)
      yield* Queue.offer(value.control.connections[2]!, message("item_4"))
      yield* drained(value, 2)
      expect(value.admissions).toEqual([])
      expect(value.log.subscribes).toEqual(["thread_a1", "thread_a1", "thread_a1"])
    }),
  )

  it.live("keeps another thread's records out of first and reconnect snapshots and admits no own-thread reply", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const foreign = (suffix: string): ReadonlyArray<DotsTransport.Inbound> => [
        {
          type: "turn.started",
          threadID: "thread_other",
          turnID: `foreign_turn_${suffix}`,
          clientMessageID: `foreign_${suffix}`,
        },
        {
          type: "user.message",
          threadID: "thread_other",
          turnID: `foreign_turn_${suffix}`,
          clientMessageID: `foreign_${suffix}`,
        },
        {
          type: "message.snapshot",
          threadID: "thread_other",
          turnID: `foreign_turn_${suffix}`,
          itemID: `foreign_item_${suffix}`,
          text: "foreign partial",
        },
        {
          type: "message",
          threadID: "thread_other",
          turnID: `foreign_turn_${suffix}`,
          itemID: `foreign_done_${suffix}`,
          text: "foreign done",
        },
      ]
      const own = (itemID: string): DotsTransport.Inbound => ({
        type: "message",
        threadID: "thread_a1",
        turnID: `turn_${itemID}`,
        itemID,
        text: itemID,
      })
      value.control.snapshot = () => [...foreign("first"), own("own_1")]
      yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(value.admissions).toEqual([])
      const first = value.control.connections[0]!
      yield* Queue.offer(first, own("own_1"))
      yield* Queue.offer(first, { type: "turn.completed", threadID: "thread_a1", turnID: "foreign_turn_first" })
      yield* Queue.offer(first, {
        type: "message",
        threadID: "thread_a1",
        turnID: "foreign_turn_first",
        itemID: "live_1",
        text: "live_1",
      })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      expect(value.log.controls).toEqual([])

      value.control.snapshot = () => [...foreign("second"), own("own_1"), own("own_2")]
      yield* Queue.end(first)
      expect(yield* Queue.take(value.connected)).toBe(1)
      expect(yield* Queue.take(value.connected)).toBe(2)
      yield* connectedStatus(value.service, s1)
      yield* Queue.offer(value.control.connections[1]!, {
        type: "turn.completed",
        threadID: "thread_a1",
        turnID: "foreign_turn_second",
      })
      yield* drained(value, 1)
      expect(value.log.controls).toEqual([])
      expect(value.admissions).toEqual([])
    }),
  )

  it.live("buffers historical and new items during a pending snapshot and admits neither", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const subscribing = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const message = (itemID: string): DotsTransport.Inbound => ({
        type: "message",
        threadID: "thread_a2",
        turnID: `turn_${itemID}`,
        itemID,
        text: itemID,
      })
      value.control.subscribe = () =>
        Deferred.succeed(subscribing, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as([message("old_item")]),
        )
      const binding = yield* value.service.bind({ sessionID: s2, target: a2 }).pipe(Effect.forkChild)
      yield* Deferred.await(subscribing)
      const inbound = value.control.connections[0]!
      yield* Queue.offer(inbound, message("old_item"))
      yield* Queue.offer(inbound, message("new_item"))
      yield* drained(value)
      expect(value.admissions).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.join(binding)).state).toBe("connected")
      expect(value.admissions).toEqual([])
      yield* Queue.offer(inbound, { type: "turn.completed", threadID: "thread_a2", turnID: "turn_new_item" })
      yield* Queue.offer(inbound, message("new_item"))
      yield* Queue.offer(inbound, message("barrier"))
      yield* drained(value)
      expect(value.admissions).toEqual([])
    }),
  )
  it.live("admits no final text after a snapshot partial", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      value.control.snapshot = () => [
        { type: "message.snapshot", threadID: "thread_a1", turnID: "t1", itemID: "i1", text: "Partial " },
      ]
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const inbound = value.control.connections[0]!
      yield* Queue.offer(inbound, { type: "message", threadID: "thread_a1", turnID: "t1", itemID: "i1", text: "Final" })
      yield* Queue.offer(inbound, { type: "turn.completed", threadID: "thread_a1", turnID: "t1" })
      yield* Queue.offer(inbound, { type: "message", threadID: "thread_a1", turnID: "t2", itemID: "i2", text: "Next" })
      yield* drained(value)
      expect(value.admissions).toEqual([])
    }),
  )
  it.live("settles an unknown delivery from a reconnect snapshot without resending", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.send = () =>
        Effect.fail(new DotsTransport.Error({ reason: "disconnected", message: "socket closed" }))
      expect(yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).toEqual({
        messageID: "m1",
        status: "unknown",
      })
      value.control.snapshot = () => [
        { type: "user.message", threadID: "thread_a1", turnID: "turn_x", clientMessageID: "m1" },
        { type: "message", threadID: "thread_a1", turnID: "turn_x", itemID: "item_1", text: "Got it" },
      ]
      yield* Queue.end(value.control.connections[0]!)
      expect(yield* Queue.take(value.connected)).toBe(1)
      expect(yield* Queue.take(value.connected)).toBe(2)
      yield* connectedStatus(value.service, s1)
      expect(value.admissions).toEqual([])
      expect(yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).toEqual({
        messageID: "m1",
        status: "accepted",
        turnID: "turn_x",
      })
      yield* Queue.end(value.control.connections[1]!)
      expect(yield* Queue.take(value.connected)).toBe(3)
      yield* connectedStatus(value.service, s1)
      expect(value.admissions).toEqual([])
      expect(yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).toEqual({
        messageID: "m1",
        status: "accepted",
        turnID: "turn_x",
      })
      expect(value.log.sends).toHaveLength(1)
    }),
  )
  it.live("admits no correlated room reply and keeps the room without a remote turn", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      value.control.snapshot = () => [
        { type: "message.snapshot", threadID: "thread_a1", itemID: "room_1", text: "Partial", causalMessageID: "m1" },
      ]
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const reply: DotsTransport.Inbound = {
        type: "message",
        threadID: "thread_a1",
        itemID: "room_1",
        text: "Final",
        causalMessageID: "m1",
      }
      yield* Queue.offer(value.control.connections[0]!, reply)
      yield* Queue.offer(value.control.connections[0]!, reply)
      yield* Queue.offer(value.control.connections[0]!, {
        type: "message",
        threadID: "thread_a1",
        itemID: "room_2",
        text: "Next",
      })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      expect(value.log.sends).toEqual([])
    }),
  )
  it.live("settles an echoed room request without inferring runtime pause state", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.send = () =>
        Effect.fail(new DotsTransport.Error({ reason: "disconnected", message: "response lost" }))
      expect((yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).status).toBe(
        "unknown",
      )
      value.control.snapshot = () => [{ type: "user.message", threadID: "thread_a1", clientMessageID: "m1" }]
      yield* Queue.end(value.control.connections[0]!)
      yield* Queue.take(value.connected)
      yield* Queue.take(value.connected)
      yield* connectedStatus(value.service, s1)
      const result = yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })
      expect(result.status).toBe("accepted")
      expect(result).not.toHaveProperty("turnID")
      expect(value.log.sends).toHaveLength(1)
      value.control.runtimeState = () => Effect.succeed("unknown")
      expect((yield* value.service.status(s1)).runtimeState).toBe("unknown")
      expect(value.log.controls).toEqual([])
    }),
  )

  it.live("refuses sends until the initial thread snapshot settles", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const subscribing = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      value.control.subscribe = () =>
        Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as([]))
      const binding = yield* value.service.bind({ sessionID: s1, target: a1 }).pipe(Effect.forkChild)
      yield* Deferred.await(subscribing)
      expect((yield* value.service.status(s1)).state).toBe("connecting")
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "early", text: "hello" }))).toBe(
        "connection_unavailable",
      )
      expect(value.log.sends).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(binding)).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
      expect(
        (yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "early", text: "hello" })).status,
      ).toBe("accepted")
      expect(value.log.sends).toHaveLength(1)
    }),
  )

  it.live("stays unconnected while thread snapshot subscription fails", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      let failing = true
      value.control.subscribe = (threadID) =>
        failing
          ? Effect.fail(new DotsTransport.Error({ reason: "unavailable", message: "snapshot down" }))
          : Effect.sync(() => value.control.snapshot(threadID))
      const status = yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(status.state).not.toBe("connected")
      expect((yield* value.service.status(s1)).state).not.toBe("connected")
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" }))).toBe(
        "connection_unavailable",
      )
      expect(value.log.sends).toEqual([])
      failing = false
      expect(yield* connectedStatus(value.service, s1)).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
      expect((yield* value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" })).status).toBe(
        "accepted",
      )
    }),
  )

  it.live("rolls back a binding whose snapshot fails on an already connected account", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.subscribe = () =>
        Effect.fail(new DotsTransport.Error({ reason: "unavailable", message: "snapshot down" }))
      expect(yield* code(value.service.bind({ sessionID: s2, target: a2 }))).toBe("connection_unavailable")
      expect(yield* value.service.status(s2)).toEqual({ enabled: true, state: "disconnected" })
      expect(yield* value.service.status(s1)).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
      expect(value.log.connects).toHaveLength(1)
    }),
  )

  it.live("backs off between consecutive connection failures and resets after connecting", () =>
    Effect.gen(function* () {
      const attempts: number[] = []
      const value = yield* runtime({
        retryDelay: (attempt) => {
          attempts.push(attempt)
          return 0
        },
      })
      value.control.connectFailures.push(
        new DotsTransport.Error({ reason: "unavailable", message: "down" }),
        new DotsTransport.Error({ reason: "unavailable", message: "down" }),
      )
      expect((yield* value.service.bind({ sessionID: s1, target: a1 })).state).not.toBe("failed")
      yield* Queue.take(value.connected)
      expect(yield* connectedStatus(value.service, s1)).toEqual({ enabled: true, target: a1, state: "connected", runtimeState: "unpaused" })
      yield* Queue.end(value.control.connections[0]!)
      yield* Queue.take(value.connected)
      yield* connectedStatus(value.service, s1)
      expect(attempts).toEqual([1, 2, 0])
      expect(value.log.connects).toHaveLength(4)
    }),
  )

  it.live("admits no completed, redelivered or streamed peer item", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const inbound = value.control.connections[0]!
      const message = {
        type: "message" as const,
        threadID: "thread_a1",
        turnID: "turn_peer",
        itemID: "item_1",
        text: "Unprompted",
      }
      yield* Queue.offer(inbound, message)
      yield* Queue.offer(inbound, {
        type: "message.delta",
        threadID: "thread_a1",
        turnID: "turn_peer",
        itemID: "item_1",
        delta: "Un",
      })
      yield* Queue.offer(inbound, message)
      yield* Queue.offer(inbound, { type: "turn.completed", threadID: "thread_a1", turnID: "turn_peer" })
      yield* Queue.offer(inbound, { ...message, turnID: "turn_next", itemID: "item_2", text: "Second" })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      expect(value.log.sends).toEqual([])
    }),
  )
  it.live("controls only the Session's confirmed destination", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* value.service.bind({ sessionID: s2, target: a2 })
      yield* value.service.pause({ sessionID: s1, expectedTarget: a1 })
      expect(value.log.controls[0]).toMatchObject({ dotID: a1.dotID, threadID: a1.threadID, action: "pause" })
      expect(yield* code(value.service.pause({ sessionID: s2, expectedTarget: a1 }))).toBe("target_changed")
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a2 }))).toBe("target_changed")
      expect(value.log.controls).toHaveLength(1)
    }),
  )

  it.live("fails closed when the bound profile switches accounts", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: b1 })
      yield* Queue.take(value.connected)
      yield* value.credentials.update(value.second.id, {
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "fixture-access-c",
          refresh: "fixture-refresh-c",
          expires: Date.now() + 3_600_000,
          metadata: { accountID: "fixture-account-c" },
        }),
      })
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: b1, id: "m1", text: "hello" }))).toBe(
        "profile_changed",
      )
      yield* Queue.end(value.control.connections[0]!)
      const status = yield* value.service
        .status(s1)
        .pipe(
          Effect.repeat({ until: (item) => item.state === "failed", schedule: Schedule.spaced("1 millis") }),
          Effect.timeout("2 seconds"),
        )
      expect(status).toMatchObject({ target: b1, state: "failed" })
      expect(value.log.connects.map((item) => item.accountID)).toEqual(["fixture-account-b"])
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("refuses runtime control after the bound profile changes accounts", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: b1 })
      yield* value.credentials.update(value.second.id, {
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "fixture-access-c",
          refresh: "fixture-refresh-c",
          expires: Date.now() + 3_600_000,
          metadata: { accountID: "fixture-account-c" },
        }),
      })
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: b1 }))).toBe("profile_changed")
      expect(value.log.controls).toEqual([])
    }),
  )

  it.live("checks account identity after reading attachments and before dispatch", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const reading = yield* Deferred.make<void>()
      const value = yield* runtime({
        attachments: () =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ name: "notes.txt", mime: "text/plain", bytes: new TextEncoder().encode("notes") }),
          ),
      })
      yield* value.service.bind({ sessionID: s1, target: b1 })
      const sending = yield* value.service
        .send({
          sessionID: s1,
          expectedTarget: b1,
          id: "m1",
          text: "hello",
          files: [{ uri: "file:///synthetic/notes.txt" }],
        })
        .pipe(Effect.flip, Effect.forkChild)
      yield* Deferred.await(reading)
      yield* value.credentials.update(value.second.id, {
        value: Credential.OAuth.make({
          type: "oauth",
          methodID,
          access: "fixture-access-c",
          refresh: "fixture-refresh-c",
          expires: Date.now() + 3_600_000,
          metadata: { accountID: "fixture-account-c" },
        }),
      })
      yield* Deferred.succeed(gate, undefined)
      expect((yield* Fiber.join(sending)).code).toBe("profile_changed")
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("reports a sanitized failure when connecting is unauthorized and holds no connection", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      value.control.connectFailures.push(
        new DotsTransport.Error({ reason: "unauthorized", message: "Bearer fixture-access-a rejected" }),
        new DotsTransport.Error({ reason: "unauthorized", message: "Bearer fixture-refreshed rejected" }),
      )
      const status = yield* value.service.bind({ sessionID: s1, target: a1 })
      expect(status).toMatchObject({ target: a1, state: "failed" })
      expect(status.error).not.toContain("fixture-access")
      expect(status.error).not.toContain("fixture-refreshed")
      expect(value.refreshed).toEqual(["fixture-access-a"])
      expect(value.log.connects.map((item) => item.access)).toEqual(["fixture-access-a", "fixture-refreshed"])
      expect(value.log.closed).toBe(0)
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "hello" }))).toBe(
        "connection_unavailable",
      )
    }),
  )

  it.live("restarts a failed connection after the destination is explicitly confirmed again", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      value.control.connectFailures.push(
        new DotsTransport.Error({ reason: "unauthorized", message: "Synthetic rejection" }),
        new DotsTransport.Error({ reason: "unauthorized", message: "Synthetic rejection" }),
      )
      expect((yield* value.service.bind({ sessionID: s1, target: a1 })).state).toBe("failed")
      expect((yield* value.service.bind({ sessionID: s1, target: a1 })).state).toBe("connected")
      expect(value.log.connects).toHaveLength(3)
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("closes every connection when the runtime scope ends", () =>
    Effect.gen(function* () {
      const profile = yield* profiles()
      const fake = yield* fakeTransport()
      const scope = yield* Scope.make()
      const service = yield* DotsRuntime.make({
        enabled: () => Effect.succeed(true),
        integration: profile.integrations,
        transport: fake.transport,
        attachments: DotsAttachments.make({
          store: { resolveURI: () => Effect.die("unused"), read: () => Effect.die("unused") },
        }),
        retryDelay: () => 0,
        sessions: { exists: () => Effect.succeed(true), admit: () => Effect.void },
      }).pipe(Scope.provide(scope))
      yield* service.bind({ sessionID: s1, target: a1 })
      yield* service.bind({ sessionID: s2, target: b1 })
      expect(fake.log.connects).toHaveLength(2)
      yield* Scope.close(scope, Exit.void)
      expect(fake.log.closed).toBe(2)
    }),
  )
})

describe("Dots capability gate", () => {
  for (const enabled of ["omitted", false, "defect", "throws"] as const)
    it.live(`blocks every operation before any credential, network, attachment or admission effect when ${enabled === false ? "disabled" : enabled}`, () =>
      Effect.gen(function* () {
        let attachmentReads = 0
        const value = yield* runtime({
          enabled,
          attachments: () => {
            attachmentReads++
            return Effect.die("No attachment reads are expected")
          },
        })
        const send = (input: { id: string; text: string; files?: Dots.Send["files"] }) =>
          value.service.send({ sessionID: s1, expectedTarget: a1, ...input })
        expect(yield* code(value.service.targets("fixture-a"))).toBe("feature_disabled")
        expect(yield* code(value.service.bind({ sessionID: s1, target: a1 }))).toBe("feature_disabled")
        expect(yield* code(send({ id: "m1", text: "Do not send", files: [{ uri: "data:text/plain;base64,AA==", name: "a.txt" }] }))).toBe("feature_disabled")
        expect(yield* code(send({ id: "m2", text: "  " }))).toBe("feature_disabled")
        expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("feature_disabled")
        expect(yield* code(value.service.resume({ sessionID: s1, expectedTarget: a1 }))).toBe("feature_disabled")
        expect(yield* value.service.status(s1)).toEqual({ enabled: false, state: "disconnected" })
        expect(value.integrationReads.count).toBe(0)
        expect(attachmentReads).toBe(0)
        expect(value.refreshed).toEqual([])
        expect(value.log.destinations).toEqual([])
        expect(value.log.connects).toEqual([])
        expect(value.log.subscribes).toEqual([])
        expect(value.log.sends).toEqual([])
        expect(value.log.controls).toEqual([])
        expect(value.log.runtimeReads).toEqual([])
        expect(value.admissions).toEqual([])
      }),
    )

  it.live("closes the connection, ignores later peers and never replays a binding when turned off then on", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      yield* value.setEnabled(false)
      yield* Effect.sync(() => value.log.closed).pipe(
        Effect.repeat({ until: (closed) => closed === 1, schedule: Schedule.spaced("1 millis") }),
        Effect.timeout("2 seconds"),
      )
      yield* Queue.offer(value.control.connections[0]!, { type: "message", threadID: a1.threadID, itemID: "after-disable", text: "Ignored" })
      expect(yield* value.service.status(s1)).toEqual({ enabled: false, state: "disconnected" })
      yield* value.setEnabled(true)
      expect(yield* value.service.status(s1)).toEqual({ enabled: true, state: "disconnected" })
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "after", text: "No binding" }))).toBe("not_bound")
      expect(value.log.connects).toHaveLength(1)
      expect(value.log.sends).toEqual([])
      expect(value.admissions).toEqual([])
    }),
  )

  it.live("reads the gate callback on every operation rather than once at construction", () =>
    Effect.gen(function* () {
      const value = yield* runtime({ enabled: "succeed" })
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.gate.on = false
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "Hold" }))).toBe("feature_disabled")
      expect(value.log.sends).toEqual([])
      expect(yield* value.service.status(s1)).toEqual({ enabled: false, state: "disconnected" })
      expect(value.log.closed).toBe(1)
    }),
  )

  it.live("reports disabled and releases the binding when the capability turns off during a status read", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      value.control.runtimeState = () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("unpaused" as const))
      const read = yield* value.service.status(s1).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      value.gate.on = false
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(read)).toEqual({ enabled: false, state: "disconnected" })
      expect(value.log.closed).toBe(1)
    }),
  )

  it.live("releases the binding when a status read observes the capability off before any change notice", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.gate.on = false
      expect(yield* value.service.status(s1)).toEqual({ enabled: false, state: "disconnected" })
      expect(value.log.closed).toBe(1)
      value.gate.on = true
      expect(yield* value.service.status(s1)).toEqual({ enabled: true, state: "disconnected" })
    }),
  )

  it.live("admits no peer message once the capability is off, and the change notice closes the connection", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.gate.on = false
      yield* Queue.offer(value.control.connections[0]!, { type: "message", threadID: a1.threadID, itemID: "late", text: "Late reply" })
      yield* drained(value)
      expect(value.admissions).toEqual([])
      yield* value.setEnabled(false)
      yield* Effect.sync(() => value.log.closed).pipe(
        Effect.repeat({ until: (closed) => closed === 1, schedule: Schedule.spaced("1 millis") }),
        Effect.timeout("2 seconds"),
      )
      expect(value.admissions).toEqual([])
      expect(value.log.connects).toHaveLength(1)
    }),
  )
  it.live("does not reconnect a dropped connection while the capability is off", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const before = value.gate.checks
      value.gate.on = false
      yield* Queue.end(value.control.connections[0]!)
      yield* Effect.sync(() => value.gate.checks).pipe(
        Effect.repeat({ until: (checks) => checks > before, schedule: Schedule.spaced("1 millis") }),
        Effect.timeout("2 seconds"),
      )
      expect(value.log.connects).toHaveLength(1)
      expect(yield* value.service.status(s1)).toEqual({ enabled: false, state: "disconnected" })
      expect(value.log.connects).toHaveLength(1)
    }),
  )

  it.live("sends nothing when the capability turns off while attachments are read", () =>
    Effect.gen(function* () {
      const flip: { run: () => void } = { run: () => {} }
      const value = yield* runtime({
        attachments: () => Effect.sync(() => flip.run()).pipe(Effect.as({ name: "a.txt", mime: "text/plain", bytes: new Uint8Array([1]) })),
      })
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const destinations = value.log.destinations.length
      flip.run = () => { value.gate.on = false }
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "Hold", files: [{ uri: "data:text/plain;base64,AA==", name: "a.txt" }] }))).toBe("feature_disabled")
      expect(value.log.destinations).toHaveLength(destinations)
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("sends nothing when the capability turns off during destination preflight", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      const original = value.transport.destinations
      Object.assign(value.transport, {
        destinations: (credentials: DotsTransport.Credentials) =>
          Effect.sync(() => { value.gate.on = false }).pipe(Effect.andThen(original(credentials))),
      })
      expect(yield* code(value.service.send({ sessionID: s1, expectedTarget: a1, id: "m1", text: "Hold" }))).toBe("feature_disabled")
      expect(value.log.sends).toEqual([])
      expect(yield* value.service.status(s1)).toEqual({ enabled: false, state: "disconnected" })
    }),
  )

  it.live("connects nothing when the capability turns off during binding destination lookup", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const original = value.transport.destinations
      Object.assign(value.transport, {
        destinations: (credentials: DotsTransport.Credentials) =>
          Effect.sync(() => { value.gate.on = false }).pipe(Effect.andThen(original(credentials))),
      })
      expect(yield* code(value.service.bind({ sessionID: s1, target: a1 }))).toBe("feature_disabled")
      expect(value.log.connects).toEqual([])
      expect(value.log.subscribes).toEqual([])
    }),
  )

  it.live("settles a binding that is waiting for its first snapshot when the capability turns off", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      const subscribing = yield* Deferred.make<void>()
      value.control.subscribe = () => Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Effect.never))
      const binding = yield* code(value.service.bind({ sessionID: s1, target: a1 })).pipe(Effect.forkChild)
      yield* Deferred.await(subscribing)
      yield* value.setEnabled(false)
      expect(yield* Fiber.join(binding).pipe(Effect.timeout("2 seconds"))).toBe("feature_disabled")
      expect(value.log.closed).toBe(1)
      expect(value.log.sends).toEqual([])
    }),
  )

  it.live("issues no runtime control when the capability turns off during the runtime state read", () =>
    Effect.gen(function* () {
      const value = yield* runtime()
      yield* value.service.bind({ sessionID: s1, target: a1 })
      value.control.runtimeState = () => Effect.sync(() => { value.gate.on = false }).pipe(Effect.as("unpaused" as const))
      expect(yield* code(value.service.pause({ sessionID: s1, expectedTarget: a1 }))).toBe("feature_disabled")
      expect(value.log.controls).toEqual([])
    }),
  )
})
