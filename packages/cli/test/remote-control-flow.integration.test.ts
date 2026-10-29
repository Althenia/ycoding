import { expect } from "bun:test"
import type { ServerWebSocket } from "bun"
import { NodeFileSystem } from "@effect/platform-node"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { NativeDots } from "@ycoding-ai/core/dots/native"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { NativeDecisions } from "@ycoding-ai/core/dots/native-decisions"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Integration } from "@ycoding-ai/core/integration"
import { KV } from "@ycoding-ai/core/kv"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Money } from "@ycoding-ai/schema/money"
import { reviewLayer, reviewLocation } from "../../core/test/fixture/review"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { createRemoteControlHost } from "../src/remote-control/host"
import { remoteControlTransport } from "../src/remote-control/bootstrap"
import { connectRemoteControlSocket } from "../src/remote-control/socket"
import { createRemoteControlStateStore } from "../src/remote-control/state"

type Message = {
  id?: string | number
  method?: string
  params?: { threadId?: string; turnId?: string; itemId?: string; requestId?: string; startedAtMs?: number; completedAtMs?: number; questions?: { id: string; header: string }[] }
  result?: {
    data?: { id: string }[]
    turn?: { id: string }
    thread?: {
      id: string
      sessionId: string
      projectId: string
      historyMode: "legacy"
      model: string
      modelProvider: string
      status: { type: "idle" } | { type: "active"; activeFlags: ("waitingOnApproval" | "waitingOnUserInput")[] }
    }
  }
  error?: unknown
}
type Frame = { type: string; client_id: string; stream_id: string; env_id: string; seq_id: number; message: Message }

async function bounded<A>(promise: Promise<A>, label: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000)
    })])
  } finally { clearTimeout(timer) }
}

const it = testEffect(reviewLayer())

it.live("local native WebSocket composition admits prompts, settles real Forms and forwards injected canonical events", () => Effect.gen(function* () {
  const location = yield* reviewLocation
  const db = yield* Database.Service
  const kv = yield* KV.Service
  const events = yield* EventRuntime.Service
  const sessions = yield* Session.Service
  const store = yield* SessionStore.Service
  const execution = yield* SessionExecution.Service
  const projects = yield* Project.Service
  const reviews = yield* SessionReview.Service
  const orchestration = yield* SessionOrchestration.Service
  const locations = yield* LocationServiceMap.Service
  const root = yield* sessions.create({ location })
  const other = yield* sessions.create({ location })
  const child = yield* sessions.create({ parentID: root.id })
  const forms = yield* Form.Service.pipe(Effect.provide(locations.get(root.location, [Form.node])))
  const access = DotsAccess.make({ db, kv, configuration: () => Effect.succeed({ ready: true, profile: "synthetic-native-flow" }) })
  yield* access.set({ enabled: true, expectedRevision: 0 })
  const credential = new Credential.Info({
    id: Credential.ID.make("cred_native_flow"), integrationID: Integration.ID.make("openai"), label: "synthetic-native-flow",
    value: { type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "synthetic-access", refresh: "synthetic-refresh", expires: 0, metadata: { accountID: "synthetic-account" } },
  })
  const temporary = (prefix: string) => Effect.acquireRelease(
    Effect.promise(() => tmpdir(prefix)),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  )
  const home = yield* temporary("ycoding-native-flow-home-")
  const data = yield* temporary("ycoding-native-flow-data-")
  const fsutil = yield* FSUtil.Service.pipe(Effect.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
  let subscriptions = 0
  const native = yield* NativeDots.make({
    db, store, sessions, execution, projects, access, kv, reviews,
    home: home.path, data: data.path, projectRoot: (directory) => Project.root(fsutil, directory),
    events: { ...events, listen: (listener) => events.listen(listener).pipe(Effect.map((stop) => {
      subscriptions++
      return Effect.sync(() => { subscriptions-- }).pipe(Effect.andThen(stop))
    })) },
    config: {
      snapshot: () => Effect.succeed({ entries: [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: credential.label } }) })], diagnostics: [] }),
      subscribe: () => () => {},
    },
    credentials: { list: () => Effect.succeed([credential]) },
    credential: () => Effect.succeed({ access: "synthetic-access", accountID: "synthetic-account", key: "synthetic-key", profile: credential.label, credentialID: credential.id, accountGeneration: credential.accountGeneration }),
    models: () => Effect.succeed([]), skills: () => Effect.succeed([]), selectedModel: (session) => Effect.succeed(session.model),
    authorization: (session) => Effect.gen(function* () {
      return { permission: yield* Permission.Service, guardrail: yield* SessionGuardrail.Service }
    }).pipe(Effect.provide(locations.get(session.location, [Permission.node, SessionGuardrail.node]))),
    decisions: (session) => Effect.gen(function* () {
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const forms = yield* Form.Service
      const questions = yield* Question.Service
      return NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
    }).pipe(Effect.provide(locations.get(session.location, [Permission.node, SessionGuardrail.node, Form.node, Question.node]))),
  })
  const baselineSubscriptions = subscriptions
  const frames: Frame[] = []
  const listeners = new Set<() => void>()
  let connected = Promise.withResolvers<ServerWebSocket<undefined>>()
  let closed = Promise.withResolvers<void>()
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => server.upgrade(request) ? undefined : new Response(null, { status: 404 }),
    websocket: {
      open: (socket) => { connected.resolve(socket) },
      message: (_socket, text) => {
        const frame: Frame = JSON.parse(String(text))
        if (frame.type !== "server_message") return
        frames.push(frame)
        for (const listener of listeners) listener()
      },
      close: () => { closed.resolve() },
    },
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  const host = createRemoteControlHost({
    native, store: createRemoteControlStateStore(`${location.directory}/native-control.json`), codexHome: location.directory,
    hostname: () => "synthetic-native-flow",
    fetchFn: async () => Response.json({ server_id: "synthetic-server", environment_id: "synthetic-environment", remote_control_token: "synthetic-token" }),
    connect: (_url, headers) => connectRemoteControlSocket(`ws://127.0.0.1:${server.port}`, headers),
  })
  const unregister = native.attachTransport(remoteControlTransport(host.status, { computer: async () => ({ state: "unavailable", problem: "configuration" }), attach: async () => ({ state: "unavailable", problem: "configuration" }) }))
  yield* Effect.addFinalizer(() => Effect.promise(async () => { unregister(); await host.shutdown() }))
  yield* Effect.promise(() => host.start())
  let peer = yield* Effect.promise(() => bounded(connected.promise, "WebSocket connection"))
  let sequence = 0
  let requestID = 0
  const send = (message: unknown, streamID = "flow") => peer.send(JSON.stringify({ type: "client_message", client_id: "synthetic-client", stream_id: streamID, env_id: "synthetic-environment", seq_id: sequence++, message }))
  const wait = (matches: (frame: Frame) => boolean, label: string) => {
    const existing = frames.find(matches)
    if (existing) return Promise.resolve(existing)
    const pending = Promise.withResolvers<Frame>()
    const check = () => { const frame = frames.find(matches); if (frame) pending.resolve(frame) }
    listeners.add(check)
    return bounded(pending.promise, label).finally(() => listeners.delete(check))
  }
  const rpc = async (method: string, params: Record<string, unknown> = {}, streamID = "flow") => {
    const id = ++requestID
    send({ id, method, params }, streamID)
    return (await wait((frame) => frame.stream_id === streamID && frame.message.id === id, method)).message
  }
  const input = (formID: string, header: string, streamID = "flow") => wait((frame) => frame.stream_id === streamID && frame.message.method === "item/tool/requestUserInput" && frame.message.params?.itemId === formID && frame.message.params.questions?.[0]?.header === header, `Form ${header}`)
  const answer = async (request: Frame, value: string) => {
    send({ id: request.message.id, result: { answers: { value: { answers: [value] }, action: { answers: ["Continue"] } } } }, request.stream_id)
    await wait((frame) => frame.stream_id === request.stream_id && frame.message.method === "serverRequest/resolved" && frame.message.params?.requestId === request.message.id, "Form stage resolution")
  }
  yield* Effect.promise(async () => {
    expect((await rpc("initialize", { clientInfo: { name: "synthetic-flow" } })).error).toBeUndefined()
    send({ method: "initialized" })
    expect((await rpc("thread/list")).result?.data?.map((item) => item.id).toSorted()).toEqual([root.id, other.id].toSorted())
    expect((await rpc("thread/read", { threadId: child.id })).error).toBeDefined()
    const read = await rpc("thread/read", { threadId: root.id })
    expect(read.error).toBeUndefined()
    expect(read.result?.thread).toMatchObject({ id: root.id, sessionId: root.id, projectId: root.projectID, historyMode: "legacy", model: root.model?.id ?? "unknown", modelProvider: root.model?.providerID ?? "unknown", status: { type: "idle" } })
  })
  expect((yield* access.status()).connection).toMatchObject({ state: "connected", hostname: expect.any(String) })
  expect(subscriptions).toBe(baselineSubscriptions + 1)
  const admitted = yield* Effect.promise(() => rpc("turn/start", { threadId: root.id, input: [{ type: "text", text: "Synthetic native task" }] }))
  expect(admitted.error).toBeUndefined()
  const messageID = SessionMessage.ID.make(admitted.result!.turn!.id)
  const pending = (yield* sessions.pending(root.id)).find((item) => item.id === messageID)
  expect(pending).toMatchObject({ type: "user", data: { text: "Synthetic native task", metadata: { nativeSource: { kind: "dots-native", clientID: "synthetic-client", streamID: "flow", rootSessionID: root.id, accessRevision: 1 } } } })
  const form = yield* forms.create({ sessionID: root.id, title: "Typed native flow", fields: [
    { type: "boolean", key: "enabled", required: true },
    { type: "integer", key: "count", required: true, minimum: 2, maximum: 4, when: [{ key: "enabled", op: "eq", value: true }] },
  ] })
  const first = yield* Effect.promise(() => input(form.id, "enabled"))
  yield* Effect.promise(() => answer(first, "True"))
  const second = yield* Effect.promise(() => input(form.id, "count"))
  expect(second.message.id).not.toBe(first.message.id)
  expect((yield* forms.state(form.id)).status).toBe("pending")
  const partial = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  expect(Array.from(partial).filter((event) => event.type === SessionEvent.InputAdmitted.type)).toMatchObject([{ data: { sessionID: root.id, inputID: messageID, input: { type: "user", data: { text: "Synthetic native task" } } } }])
  expect(Array.from(partial).filter((event) => event.type === SessionEvent.DotsDecisionSettled.type)).toHaveLength(0)
  yield* Effect.promise(() => answer(second, "3"))
  expect(yield* forms.state(form.id)).toEqual({ status: "answered", answer: { enabled: true, count: 3 } })
  const settled = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  const receipts = Array.from(settled).filter((event): event is EventRuntime.Payload => !EventRuntime.isSynced(event) && event.type === SessionEvent.DotsDecisionSettled.type)
  expect(receipts).toHaveLength(1)
  expect(Schema.decodeUnknownSync(SessionEvent.DotsDecisionSettled.data)(receipts[0]?.data).source).toMatchObject({ kind: "dots-native", credentialID: credential.id, accountID: "synthetic-account", environmentID: "synthetic-environment", clientID: "synthetic-client", streamID: "flow", rootSessionID: root.id, accessRevision: 1, requestID: second.message.id })
  const assistantMessageID = SessionMessage.ID.make("msg_native_flow_output")
  yield* events.publish(SessionEvent.Execution.Started, { sessionID: root.id })
  yield* events.publish(SessionEvent.InputConsumed, { sessionID: root.id, inputIDs: [messageID] })
  yield* events.publish(SessionEvent.Step.Started, { sessionID: root.id, assistantMessageID, agent: Agent.defaultID, model: { id: CatalogModel.ID.make("synthetic-model"), providerID: Provider.ID.make("synthetic-provider") } })
  const started = yield* events.publish(SessionEvent.Text.Started, { sessionID: root.id, assistantMessageID, ordinal: 0, phase: "final_answer" })
  yield* events.publish(SessionEvent.Text.Delta, { sessionID: root.id, assistantMessageID, ordinal: 0, delta: "Synthetic output" })
  const ended = yield* events.publish(SessionEvent.Text.Ended, { sessionID: root.id, assistantMessageID, ordinal: 0, text: "Synthetic output", phase: "final_answer" })
  yield* events.publish(SessionEvent.Step.Ended, { sessionID: root.id, assistantMessageID, finish: "stop", cost: Money.USD.zero, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID: root.id })
  yield* Effect.promise(() => wait((frame) => frame.message.method === "turn/completed", "injected execution completion"))
  const output = frames.filter((frame) => ["turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed"].includes(frame.message.method ?? ""))
  expect(output.map((frame) => frame.message.method)).toEqual(["turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed"])
  expect(output.find((frame) => frame.message.method === "item/started")?.message.params?.startedAtMs).toBe(DateTime.toEpochMillis(started.created))
  expect(output.find((frame) => frame.message.method === "item/completed")?.message.params?.completedAtMs).toBe(DateTime.toEpochMillis(ended.created))
  expect(output.map((frame) => [frame.client_id, frame.stream_id, frame.env_id])).toEqual(output.map(() => ["synthetic-client", "flow", "synthetic-environment"]))
  expect(output.every((frame, index) => index === 0 || frame.seq_id > output[index - 1]!.seq_id)).toBe(true)
  expect(output.slice(1, 4).map((frame) => frame.message.params?.turnId)).toEqual([messageID, messageID, messageID])
  expect(output.at(-1)?.message).toMatchObject({ params: { threadId: root.id, turn: { id: messageID, status: "completed", items: [{ id: `${assistantMessageID}:0`, type: "agentMessage", text: "Synthetic output", phase: "final_answer" }] } } })
  const revokedForm = yield* forms.create({ sessionID: root.id, title: "Revoked native flow", fields: [{ type: "string", key: "answer", required: true }] })
  const revoked = yield* Effect.promise(() => input(revokedForm.id, "answer"))
  yield* access.set({ enabled: false, expectedRevision: 1 })
  yield* Effect.promise(() => bounded(closed.promise, "global revocation closure"))
  expect(subscriptions).toBe(baselineSubscriptions)
  const beforeLate = frames.length
  yield* events.publish(SessionEvent.Text.Delta, { sessionID: root.id, assistantMessageID, ordinal: 0, delta: "must not escape revocation" })
  expect(peer.readyState).toBe(3)
  expect((yield* Effect.promise(() => host.status())).state).toBe("off")
  expect((yield* access.status()).connection.state).toBe("off")
  expect(frames).toHaveLength(beforeLate)
  expect((yield* forms.state(revokedForm.id)).status).toBe("pending")
  const retiredPeer = peer
  connected = Promise.withResolvers<ServerWebSocket>()
  closed = Promise.withResolvers<void>()
  yield* access.set({ enabled: true, expectedRevision: 2 })
  peer = yield* Effect.promise(() => bounded(connected.promise, "new authorized WebSocket connection"))
  expect(peer).not.toBe(retiredPeer)
  expect(retiredPeer.readyState).toBe(3)
  yield* Effect.promise(async () => {
    send({ id: revoked.message.id, result: { answers: { value: { answers: ["late"] }, action: { answers: ["Continue"] } } } }, "cleanup")
    expect((await wait((frame) => frame.stream_id === "cleanup" && frame.message.id === revoked.message.id && frame.message.error !== undefined, "retired response rejection")).message.error).toBeDefined()
    await rpc("initialize", { clientInfo: { name: "synthetic-cleanup" } }, "cleanup")
    send({ method: "initialized" }, "cleanup")
    expect((await rpc("thread/read", { threadId: root.id }, "cleanup")).error).toBeUndefined()
    await input(revokedForm.id, "answer", "cleanup")
  })
  expect(subscriptions).toBe(baselineSubscriptions + 1)
  yield* Effect.promise(async () => { unregister(); await host.shutdown() })
  yield* Effect.promise(() => bounded(closed.promise, "WebSocket closure"))
  expect((yield* access.status()).connection.state).toBe("unavailable")
  expect(subscriptions).toBe(baselineSubscriptions)
  const afterClose = frames.length
  yield* events.publish(SessionEvent.Text.Delta, { sessionID: root.id, assistantMessageID, ordinal: 0, delta: "must not escape closure" })
  expect(frames).toHaveLength(afterClose)
  expect((yield* forms.state(revokedForm.id)).status).toBe("pending")
}), 30_000)
