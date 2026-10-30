import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import type { ServerWebSocket } from "bun"
import { Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { Scope } from "effect"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCoordination } from "@ycoding-ai/core/config/coordination"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { NativeDecisions } from "@ycoding-ai/core/dots/native-decisions"
import { NativeDots } from "@ycoding-ai/core/dots/native"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Form } from "@ycoding-ai/core/form"
import { Integration } from "@ycoding-ai/core/integration"
import { KV } from "@ycoding-ai/core/kv"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionGoalDecisions } from "@ycoding-ai/core/session/goal-decisions"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { NodeFileSystem } from "@effect/platform-node"
import { Layer } from "effect"
import { reviewLayer, reviewLocation } from "../../core/test/fixture/review"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { remoteControlTransport } from "../src/remote-control/bootstrap"
import { createRemoteControlHost } from "../src/remote-control/host"
import { connectRemoteControlSocket } from "../src/remote-control/socket"
import { createRemoteControlStateStore } from "../src/remote-control/state"

type Question = { id: string; header: string; options?: { label: string }[] }
type Message = {
  id?: string | number
  method?: string
  params?: { threadId?: string; itemId?: string; requestId?: string; questions?: Question[] }
  result?: unknown
  error?: { code: number; message: string }
}
type Frame = { type: string; client_id: string; stream_id: string; env_id: string; seq_id: number; message: Message; conn: number }

const environmentID = "synthetic-environment"
const clientID = "acceptance-client"

const nativeID = (frame: Frame) => {
  const id = frame.message.id
  if (typeof id !== "string") throw new Error("Expected a string native request id")
  return id
}

async function bounded<A>(promise: Promise<A>, label: string, ms = 5_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

const it = testEffect(reviewLayer())

type SettleGate = { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
type Control = {
  nativeGate: SettleGate | undefined
  nativeSettles: number
  beforeReconsider: Effect.Effect<void>
  reconsiders: string[]
  reconsiderResults: { readonly outcome: string; readonly settled: boolean }[]
}

const harness = (options: { readonly customRule?: boolean; readonly goalLoop?: boolean } = {}) => Effect.gen(function* () {
  const location = yield* reviewLocation
  if (options.customRule) {
    yield* Effect.promise(() => fs.mkdir(`${location.directory}/.ycoding/guardrails`, { recursive: true }))
    yield* Effect.promise(() => Bun.write(`${location.directory}/.ycoding/guardrails/native.md`, "---\nid: native-choice\ndecision: ask\nactions: [shell]\nresources: [native-synthetic-command]\nreason: Explicit native choice\n---\n"))
  }
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
  const located = locations.get(root.location, [LocationServiceMap.full])
  const forms = yield* Form.Service.pipe(Effect.provide(located))
  const questions = yield* Question.Service.pipe(Effect.provide(located))
  const permissions = yield* Permission.Service.pipe(Effect.provide(located))
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  const agent = Agent.ID.make("native-acceptance")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  yield* sessions.autonomy.set({ sessionID: root.id, permissions: "auto", ...(options.goalLoop ? {} : { guardrails: "auto" }) })
  const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(located))

  const access = DotsAccess.make({ db, kv, configuration: () => Effect.succeed({ ready: true, profile: "synthetic-native-acceptance" }) })
  const enable = Effect.gen(function* () { yield* access.set({ enabled: true, expectedRevision: (yield* access.get()).revision }) })
  const disable = Effect.gen(function* () { yield* access.set({ enabled: false, expectedRevision: (yield* access.get()).revision }) })
  yield* enable
  const credential = new Credential.Info({
    id: Credential.ID.make("cred_native_acceptance"), integrationID: Integration.ID.make("openai"), label: "synthetic-native-acceptance",
    value: { type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "synthetic-access", refresh: "synthetic-refresh", expires: 0, metadata: { accountID: "synthetic-account" } },
  })
  const temporary = (prefix: string) => Effect.acquireRelease(
    Effect.promise(() => tmpdir(prefix)),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  )
  const home = yield* temporary("ycoding-native-acceptance-home-")
  const data = yield* temporary("ycoding-native-acceptance-data-")
  const fsutil = yield* FSUtil.Service.pipe(Effect.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
  const control: Control = { nativeGate: undefined, nativeSettles: 0, beforeReconsider: Effect.void, reconsiders: [], reconsiderResults: [] }
  const seen: { readonly type: string; readonly data: Record<string, unknown> }[] = []
  const stopSeen = yield* events.listen((event) => Effect.sync(() => {
    seen.push({ type: event.type, data: typeof event.data === "object" && event.data !== null ? Object.fromEntries(Object.entries(event.data)) : {} })
  }))
  yield* Effect.addFinalizer(() => stopSeen)
  const native = yield* NativeDots.make({
    db, store, sessions, execution, projects, access, kv, reviews,
    home: home.path, data: data.path, projectRoot: (directory) => Project.root(fsutil, directory),
    events,
    config: {
      snapshot: () => Effect.succeed({ entries: [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: credential.label } }) })], diagnostics: [] }),
      subscribe: () => () => {},
    },
    credentials: { list: () => Effect.succeed([credential]) },
    credential: () => Effect.succeed({ access: "synthetic-access", accountID: "synthetic-account", key: "synthetic-key", profile: credential.label, credentialID: credential.id, accountGeneration: credential.accountGeneration }),
    models: () => Effect.succeed([]), skills: () => Effect.succeed([]), selectedModel: (session) => Effect.succeed(session.model),
    authorization: (session) => Effect.gen(function* () {
      return { permission: yield* Permission.Service, guardrail: yield* SessionGuardrail.Service }
    }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
    decisions: (session) => Effect.gen(function* () {
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const forms = yield* Form.Service
      const questions = yield* Question.Service
      const decisions = NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
      return {
        ...decisions,
        settle: (...input: Parameters<typeof decisions.settle>) => {
          control.nativeSettles++
          const gate = control.nativeGate
          return gate === undefined ? decisions.settle(...input) : Deferred.succeed(gate.entered, undefined).pipe(Effect.andThen(Deferred.await(gate.release)), Effect.andThen(decisions.settle(...input)))
        },
      }
    }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
  })

  const frames: Frame[] = []
  const others: { conn: number; type: string; seq_id?: number }[] = []
  const connections: ServerWebSocket<undefined>[] = []
  const listeners = new Set<() => void>()
  const poke = () => { for (const listener of listeners) listener() }
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch: (request, server) => server.upgrade(request) ? undefined : new Response(null, { status: 404 }),
    websocket: {
      open: (socket) => { connections.push(socket); poke() },
      message: (socket, text) => {
        const frame = JSON.parse(String(text)) as Frame
        const conn = connections.indexOf(socket)
        if (frame.type === "server_message") frames.push({ ...frame, conn })
        else others.push({ conn, type: frame.type, seq_id: frame.seq_id })
        poke()
      },
      close: () => poke(),
    },
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  const host = createRemoteControlHost({
    native, store: createRemoteControlStateStore(`${location.directory}/native-acceptance-control.json`), codexHome: location.directory,
    hostname: () => "synthetic-native-acceptance",
    fetchFn: async () => Response.json({ server_id: "synthetic-server", environment_id: environmentID, remote_control_token: "synthetic-token" }),
    connect: (_url, headers) => connectRemoteControlSocket(`ws://127.0.0.1:${server.port}`, headers),
  })
  const unregister = native.attachTransport(remoteControlTransport(host.status, { computer: async () => ({ state: "unavailable", problem: "configuration" }), attach: async () => ({ state: "unavailable", problem: "configuration" }) }))
  yield* Effect.addFinalizer(() => Effect.promise(async () => { unregister(); await host.shutdown() }))

  const until = <A>(read: () => A | undefined, label: string, ms = 5_000) => {
    const found = read()
    if (found !== undefined) return Promise.resolve(found)
    const pending = Promise.withResolvers<A>()
    const check = () => { const value = read(); if (value !== undefined) pending.resolve(value) }
    listeners.add(check)
    return bounded(pending.promise, label, ms).finally(() => listeners.delete(check))
  }
  const connection = (index: number) => until(() => connections[index], `WebSocket connection ${index}`)
  const sequences = new Map<string, number>()
  let requestCounter = 0
  const send = (conn: number, streamID: string, message: unknown) => {
    const key = `${conn}:${streamID}`
    const seq = sequences.get(key) ?? 0
    sequences.set(key, seq + 1)
    connections[conn]!.send(JSON.stringify({ type: "client_message", client_id: clientID, stream_id: streamID, env_id: environmentID, seq_id: seq, message }))
  }
  const rpc = async (conn: number, streamID: string, method: string, params: Record<string, unknown> = {}) => {
    const id = ++requestCounter
    send(conn, streamID, { id, method, params })
    return (await until(() => frames.find((frame) => frame.conn === conn && frame.stream_id === streamID && frame.message.id === id), method)).message
  }
  const open = async (conn: number, streamID: string) => {
    const initialized = await rpc(conn, streamID, "initialize", { clientInfo: { name: "synthetic-acceptance" } })
    expect(initialized.error).toBeUndefined()
    send(conn, streamID, { method: "initialized" })
  }
  const inputs = (conn: number, streamID: string, itemID: string) => frames.filter((frame) => frame.conn === conn && frame.stream_id === streamID && frame.message.method === "item/tool/requestUserInput" && frame.message.params?.itemId === itemID)
  const requestInput = (conn: number, streamID: string, itemID: string) => until(() => inputs(conn, streamID, itemID)[0], `requestUserInput ${itemID} on ${conn}/${streamID}`)
  const resolvedFor = (frame: Frame) => frames.filter((other) => other.conn === frame.conn && other.stream_id === frame.stream_id && other.message.method === "serverRequest/resolved" && other.message.params?.requestId === frame.message.id)
  const resolved = (frame: Frame) => until(() => resolvedFor(frame)[0], `serverRequest/resolved ${String(frame.message.id)}`)
  const answerFor = (frame: Frame) => Object.fromEntries((frame.message.params?.questions ?? []).map((question) => [question.id, { answers: [question.options?.[0]?.label ?? "synthetic"] }]))
  const respond = (frame: Frame, answers: Record<string, unknown> = answerFor(frame), conn = frame.conn, streamID = frame.stream_id, id: unknown = frame.message.id) => {
    const from = frames.length
    send(conn, streamID, { id, result: { answers } })
    return until(() => frames.slice(from).find((other) => other.conn === conn && other.stream_id === streamID && other.message.id === id && other.message.error !== undefined), "response rejection")
  }
  const quiet = async (conn: number, streamID: string) => { expect((await rpc(conn, streamID, "thread/list")).error).toBeUndefined() }

  const receipts = Effect.gen(function* () {
    const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
    return Array.from(log).filter((event): event is EventRuntime.Payload => !EventRuntime.isSynced(event) && event.type === SessionEvent.DotsDecisionSettled.type)
  })
  const sessionEvents = Effect.gen(function* () {
    const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
    return Array.from(log).filter((event): event is EventRuntime.Payload => !EventRuntime.isSynced(event)).map((event) => event.type)
  })

  const durableEvents = (type: string) => Effect.gen(function* () {
    const log = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
    return Array.from(log).filter((event): event is EventRuntime.Payload => !EventRuntime.isSynced(event) && event.type === type).map((event) => ({ type: event.type, data: typeof event.data === "object" && event.data !== null ? Object.fromEntries(Object.entries(event.data)) : {} }))
  })
  const askPermission = (name: string) => permissions.ask({
    sessionID: root.id, agent, action: "edit", resources: [`src/${name}.ts`], requireExplicitDecision: true,
    source: { type: "tool", messageID: `msg_${name}`, callID: `call_${name}` },
  })
  const askQuestion = (header: string) => Effect.gen(function* () {
    const asked = yield* Deferred.make<Question.Request>()
    const stop = yield* events.listen((event) => event.type === Question.Event.Asked.type
      ? Deferred.succeed(asked, event.data as unknown as Question.Request).pipe(Effect.asVoid) : Effect.void)
    const waiting = yield* questions.ask({ sessionID: root.id, questions: [{ header, question: `${header}?`, options: [{ label: "One", description: "First" }], custom: false }] }).pipe(Effect.exit, Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    yield* stop
    return { id: request.id, waiting }
  })
  const askGuardrail = (resource: string, action = "shell") => Effect.gen(function* () {
    const input = { sessionID: root.id, action, resources: [resource] }
    const evaluation = yield* guardrails.evaluate(input)
    const asked = yield* Deferred.make<Guardrail.Request>()
    const stop = yield* events.listen((event) => event.type === Guardrail.Event.Asked.type
      ? Deferred.succeed(asked, event.data as unknown as Guardrail.Request).pipe(Effect.asVoid) : Effect.void)
    yield* Effect.addFinalizer(() => stop)
    const waiting = yield* guardrails.assert(input).pipe(Effect.forkScoped)
    const request = yield* Effect.raceFirst(Deferred.await(asked), Fiber.await(waiting).pipe(Effect.flatMap(() => Effect.die("Guardrail settled before the required explicit choice"))))
    return { id: request.id, hardReview: evaluation.hardReview, waiting }
  })
  const askForm = (title: string) => forms.create({ sessionID: root.id, title, fields: [{ type: "string", key: "answer", required: true }] })

  const loop = Effect.gen(function* () {
    if (!options.goalLoop) return undefined
    const autonomy = yield* SessionAutonomy.Service
    const gate = yield* Deferred.make<void>()
    const instrument = (located: SessionGoalDecisions.Located | undefined): SessionGoalDecisions.Located | undefined => {
      if (located === undefined) return undefined
      const around = <R extends { readonly outcome: string; readonly settled: boolean }, E>(name: string, real: Effect.Effect<R, E>) =>
        Effect.sync(() => void control.reconsiders.push(name)).pipe(
          Effect.andThen(control.beforeReconsider),
          Effect.andThen(real),
          Effect.tap((result) => Effect.sync(() => void control.reconsiderResults.push({ outcome: result.outcome, settled: result.settled }))),
        )
      const guardrail = located.guardrail
      const form = located.form
      return {
        ...located,
        ...(guardrail === undefined ? {} : { guardrail: { ...guardrail, reconsider: (input: Parameters<typeof guardrail.reconsider>[0]) => around(`guardrail:${input.requestID}`, guardrail.reconsider(input)) } }),
        ...(form === undefined ? {} : { form: { ...form, reconsider: (input: Parameters<typeof form.reconsider>[0]) => around(`form:${input.id}`, form.reconsider(input)) } }),
      }
    }
    const locate = SessionGoalDecisions.locate(store, locations)
    const made = SessionGoalDecisions.make({
      db: db.db,
      events,
      autonomy: { ...autonomy, snapshot: (...input: Parameters<typeof autonomy.snapshot>) => Deferred.await(gate).pipe(Effect.andThen(autonomy.snapshot(...input))) },
      execution: { active: Effect.succeed(new Set()), wake: () => Effect.void },
      orchestration,
      policy: () => Effect.sync(() => ConfigCoordination.resolve()),
      locate: (sessionID) => locate(sessionID).pipe(Effect.map(instrument)),
    })
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    yield* SessionGoalDecisions.start({ events, autonomy, loop: made }).pipe(Effect.provideService(Scope.Scope, scope))
    yield* autonomy.setGoal({ sessionID: root.id, text: "Ship the synthetic feature" })
    return {
      inspect: made.inspect,
      release: Deferred.succeed(gate, undefined),
      auto: autonomy.set({ sessionID: root.id, answers: "auto", guardrails: "auto" }),
    }
  })
  const goalLoop = yield* loop

  yield* Effect.promise(() => host.start())
  yield* Effect.promise(() => connection(0))
  return {
    root, access, enable, disable, host, forms, questions, permissions, frames, others, connections, server,
    until, connection, send, rpc, open, inputs, requestInput, resolved, resolvedFor, answerFor, respond, quiet,
    receipts, sessionEvents, askPermission, askQuestion, askForm, askGuardrail, guardrails, poke, control, seen, goalLoop, db, durableEvents,
  }
})

it.live("correlates a real permission, Question and Form to one requestUserInput each and settles exactly the answered request", () => Effect.gen(function* () {
  const h = yield* harness()
  yield* Effect.promise(() => h.open(0, "alpha"))
  const permission = yield* h.askPermission("correlate")
  const question = yield* h.askQuestion("Correlate")
  const form = yield* h.askForm("Correlate form")
  expect(permission.effect).toBe("ask")
  const frames = yield* Effect.promise(() => Promise.all([h.requestInput(0, "alpha", permission.id), h.requestInput(0, "alpha", question.id), h.requestInput(0, "alpha", form.id)]))
  yield* Effect.promise(() => h.quiet(0, "alpha"))
  for (const [frame, itemID] of [[frames[0]!, permission.id], [frames[1]!, question.id], [frames[2]!, form.id]] as const) {
    expect(h.inputs(0, "alpha", itemID)).toHaveLength(1)
    expect(typeof frame.message.id).toBe("string")
    expect(frame.message.params?.threadId).toBe(h.root.id)
  }
  expect(new Set(frames.map((frame) => frame.message.id)).size).toBe(3)

  expect(yield* h.receipts).toHaveLength(0)
  yield* Effect.promise(async () => {
    h.send(0, "alpha", { id: frames[2]!.message.id, result: { answers: h.answerFor(frames[2]!) } })
    expect((await h.resolved(frames[2]!)).message.params).toEqual({ threadId: h.root.id, requestId: nativeID(frames[2]!) })
  })
  expect((yield* h.forms.state(form.id)).status).toBe("answered")
  expect(yield* h.permissions.snapshot(permission.id)).toBeDefined()
  expect((yield* h.receipts).map((event) => (event.data as { source: { requestID: string } }).source.requestID)).toEqual([frames[2]!.message.id as string])
  expect(h.resolvedFor(frames[0]!)).toHaveLength(0)
  expect(h.resolvedFor(frames[1]!)).toHaveLength(0)

  yield* Effect.promise(async () => {
    h.send(0, "alpha", { id: frames[1]!.message.id, result: { answers: h.answerFor(frames[1]!) } })
    await h.resolved(frames[1]!)
  })
  const settledQuestion = yield* Fiber.join(question.waiting)
  expect(settledQuestion._tag).toBe("Success")
  yield* Effect.promise(async () => {
    h.send(0, "alpha", { id: frames[0]!.message.id, result: { answers: h.answerFor(frames[0]!) } })
    await h.resolved(frames[0]!)
  })
  expect(yield* h.permissions.snapshot(permission.id)).toBeUndefined()
  const settled = yield* h.receipts
  expect(settled.map((event) => (event.data as { source: { requestID: string } }).source.requestID).toSorted()).toEqual(frames.map((frame) => frame.message.id as string).toSorted())
  for (const frame of frames) expect(h.resolvedFor(frame)).toHaveLength(1)
  expect(yield* h.sessionEvents).not.toContain(SessionEvent.Execution.Started.type)
}), 30_000)

it.live("rejects stale, mismatched and post-revocation answers without a Core settlement", () => Effect.gen(function* () {
  const h = yield* harness()
  yield* Effect.promise(() => h.open(0, "alpha"))
  const settledForm = yield* h.askForm("Stale")
  const settledFrame = yield* Effect.promise(() => h.requestInput(0, "alpha", settledForm.id))
  yield* Effect.promise(async () => {
    h.send(0, "alpha", { id: settledFrame.message.id, result: { answers: h.answerFor(settledFrame) } })
    await h.resolved(settledFrame)
  })
  const receiptsAfterSettlement = yield* h.receipts
  expect(receiptsAfterSettlement).toHaveLength(1)

  const live = yield* h.askForm("Live")
  const liveFrame = yield* Effect.promise(() => h.requestInput(0, "alpha", live.id))
  const stale = yield* Effect.promise(() => h.respond(settledFrame))
  expect(stale.message.error).toMatchObject({ code: -32600, message: "Unknown or completed native request" })
  const mismatched = yield* Effect.promise(() => h.respond(liveFrame, h.answerFor(liveFrame), 0, "alpha", "native_unknown"))
  expect(mismatched.message.error).toMatchObject({ code: -32600, message: "Unknown or completed native request" })
  const wrongQuestion = yield* Effect.promise(() => h.respond(liveFrame, { unknown: { answers: ["x"] } }))
  expect(wrongQuestion.message.error).toMatchObject({ code: -32602, message: "Answer does not match a native question" })
  expect((yield* h.forms.state(live.id)).status).toBe("pending")
  expect(yield* h.receipts).toEqual(receiptsAfterSettlement)

  yield* h.disable
  yield* Effect.promise(() => h.until(() => h.connections[0]!.readyState === 3 ? true : undefined, "socket closure on Dots Off"))
  expect((yield* h.forms.state(live.id)).status).toBe("pending")
  yield* h.enable
  yield* Effect.promise(async () => {
    await h.connection(1)
    await h.open(1, "alpha")
    const late = await h.respond(liveFrame, h.answerFor(liveFrame), 1, "alpha")
    expect(late.message.error).toMatchObject({ code: -32600, message: "Unknown or completed native request" })
    const fresh = await h.requestInput(1, "alpha", live.id)
    expect(fresh.message.id).not.toBe(liveFrame.message.id)
  })
  expect((yield* h.forms.state(live.id)).status).toBe("pending")
  expect(yield* h.receipts).toEqual(receiptsAfterSettlement)
}), 30_000)

it.live("surfaces only still-pending requests under new native ids after a reconnect and replays or answers nothing", () => Effect.gen(function* () {
  const h = yield* harness()
  yield* Effect.promise(() => h.open(0, "alpha"))
  const kept = yield* h.askPermission("reconnect")
  const dropped = yield* h.askForm("Settled while disconnected")
  const [keptFirst, droppedFirst] = yield* Effect.promise(() => Promise.all([h.requestInput(0, "alpha", kept.id), h.requestInput(0, "alpha", dropped.id)]))
  const eventsBefore = yield* h.sessionEvents

  h.connections[0]!.close()
  yield* Effect.promise(() => h.connection(1))
  yield* h.forms.cancel(dropped.id)
  yield* Effect.promise(() => h.open(1, "beta"))
  const kept1 = yield* Effect.promise(() => h.requestInput(1, "beta", kept.id))
  yield* Effect.promise(() => h.quiet(1, "beta"))
  expect(kept1.message.id).not.toBe(keptFirst.message.id)
  expect(h.inputs(1, "beta", kept.id)).toHaveLength(1)
  expect(h.inputs(1, "beta", dropped.id)).toHaveLength(0)
  expect(h.inputs(0, "alpha", dropped.id)).toHaveLength(1)
  expect(droppedFirst.message.id).toBeDefined()
  expect(h.frames.filter((frame) => frame.conn === 1 && frame.message.method === "item/tool/requestUserInput")).toHaveLength(1)

  const oldAnswer = yield* Effect.promise(() => h.respond(keptFirst, h.answerFor(keptFirst), 1, "beta"))
  expect(oldAnswer.message.error).toMatchObject({ code: -32600 })
  expect(yield* h.permissions.snapshot(kept.id)).toBeDefined()
  expect((yield* h.forms.state(dropped.id)).status).toBe("cancelled")
  expect(yield* h.receipts).toHaveLength(0)
  const newEvents = (yield* h.sessionEvents).slice(eventsBefore.length)
  for (const forbidden of [SessionEvent.Execution.Started.type, SessionEvent.InputAdmitted.type, SessionEvent.DotsDecisionSettled.type]) expect(newEvents).not.toContain(forbidden)
  const sessionMethods = new Set(h.frames.filter((frame) => frame.conn === 1).map((frame) => frame.message.method).filter((method) => method !== undefined))
  expect([...sessionMethods].toSorted()).toEqual(["item/tool/requestUserInput"])
}), 30_000)

it.live("multiplexes two streams on one socket and resolves a shared request on the other stream without a duplicate settlement", () => Effect.gen(function* () {
  const h = yield* harness()
  yield* Effect.promise(async () => { await h.open(0, "alpha"); await h.open(0, "beta") })
  const form = yield* h.askForm("Shared")
  const [alpha, beta] = yield* Effect.promise(() => Promise.all([h.requestInput(0, "alpha", form.id), h.requestInput(0, "beta", form.id)]))
  expect(alpha.message.id).not.toBe(beta.message.id)
  expect(alpha.stream_id).toBe("alpha")
  expect(beta.stream_id).toBe("beta")
  expect(h.inputs(0, "alpha", form.id)).toHaveLength(1)
  expect(h.inputs(0, "beta", form.id)).toHaveLength(1)

  yield* Effect.promise(async () => {
    h.send(0, "alpha", { id: alpha.message.id, result: { answers: h.answerFor(alpha) } })
    await h.resolved(alpha)
    await h.resolved(beta)
  })
  expect(h.resolvedFor(alpha)).toHaveLength(1)
  expect(h.resolvedFor(beta)).toHaveLength(1)
  expect((yield* h.forms.state(form.id)).status).toBe("answered")
  expect(yield* h.receipts).toHaveLength(1)
  const second = yield* Effect.promise(() => h.respond(beta))
  expect(second.message.error).toMatchObject({ code: -32600, message: "Unknown or completed native request" })
  expect(yield* h.receipts).toHaveLength(1)
}), 30_000)

it.live("accepts and ignores client acks and restarts server sequence numbers per stream after a reconnect", () => Effect.gen(function* () {
  const h = yield* harness()
  yield* Effect.promise(() => h.open(0, "alpha"))
  const form = yield* h.askForm("Ack")
  const first = yield* Effect.promise(() => h.requestInput(0, "alpha", form.id))
  const before = h.frames.filter((frame) => frame.conn === 0 && frame.stream_id === "alpha").map((frame) => frame.seq_id)
  expect(before[0]).toBe(0)
  expect(before).toEqual(before.map((_, index) => index))

  const count = h.frames.length
  for (const seq_id of [0, 1, 99]) h.connections[0]!.send(JSON.stringify({ type: "ack", client_id: clientID, stream_id: "alpha", env_id: environmentID, seq_id }))
  yield* Effect.promise(() => h.quiet(0, "alpha"))
  const afterAck = h.frames.slice(count).filter((frame) => frame.message.method !== undefined || frame.message.error !== undefined)
  expect(afterAck.every((frame) => frame.message.error === undefined)).toBe(true)
  expect(h.inputs(0, "alpha", form.id)).toHaveLength(1)
  expect((yield* h.forms.state(form.id)).status).toBe("pending")

  h.connections[0]!.close()
  yield* Effect.promise(() => h.connection(1))
  yield* Effect.promise(() => h.open(1, "alpha"))
  const second = yield* Effect.promise(() => h.requestInput(1, "alpha", form.id))
  expect(second.message.id).not.toBe(first.message.id)
  const after = h.frames.filter((frame) => frame.conn === 1 && frame.stream_id === "alpha").map((frame) => frame.seq_id)
  expect(after[0]).toBe(0)
  expect(after).toEqual(after.map((_, index) => index))
  expect(h.inputs(1, "alpha", form.id)).toHaveLength(1)
  expect((yield* h.forms.state(form.id)).status).toBe("pending")
  expect(yield* h.receipts).toHaveLength(0)
}), 30_000)

for (const kind of ["custom", "hard"] as const) it.live(`settles a real ${kind} guardrail review once and refuses an answer the native contract does not offer`, () => Effect.gen(function* () {
  const h = yield* harness({ customRule: kind === "custom" })
  yield* Effect.promise(() => h.open(0, "alpha"))
  const asked = yield* h.askGuardrail(kind === "hard" ? "git reset --hard" : "native-synthetic-command")
  expect(asked.hardReview).toBe(kind === "hard")
  const frame = yield* Effect.promise(() => h.requestInput(0, "alpha", asked.id))
  yield* Effect.promise(() => h.quiet(0, "alpha"))
  expect(h.inputs(0, "alpha", asked.id)).toHaveLength(1)
  expect(frame.message.params?.threadId).toBe(h.root.id)
  const options = frame.message.params?.questions?.[0]?.options?.map((option) => option.label) ?? []
  expect(options).toContain("Allow once")
  expect(options).not.toContain("Always allow")
  expect(options.map((label) => label.toLowerCase()).some((label) => label.includes("always"))).toBe(false)
  const key = frame.message.params!.questions![0]!.id

  const refused = yield* Effect.promise(() => h.respond(frame, { [key]: { answers: ["always"] } }))
  expect(refused.message.error).toMatchObject({ code: -32602, message: "Answer is not an available option" })
  expect(yield* h.guardrails.requestSnapshot(h.root.id, asked.id)).toBeDefined()
  expect(yield* h.receipts).toHaveLength(0)
  expect(h.resolvedFor(frame)).toHaveLength(0)

  yield* Effect.promise(async () => {
    h.send(0, "alpha", { id: frame.message.id, result: { answers: { [key]: { answers: ["Allow once"] } } } })
    expect((await h.resolved(frame)).message.params).toEqual({ threadId: h.root.id, requestId: nativeID(frame) })
  })
  yield* (yield* Fiber.join(asked.waiting)).release
  expect(yield* h.guardrails.requestSnapshot(h.root.id, asked.id)).toBeUndefined()
  const settled = yield* h.receipts
  expect(settled).toHaveLength(1)
  expect(settled[0]?.data).toMatchObject({ source: { kind: "dots-native", requestID: frame.message.id }, target: { kind: "guardrail", requestID: asked.id }, reply: "once" })

  const second = yield* Effect.promise(() => h.respond(frame, { [key]: { answers: ["Allow once"] } }))
  expect(second.message.error).toMatchObject({ code: -32600, message: "Unknown or completed native request" })
  expect(yield* h.receipts).toHaveLength(1)
  expect(h.resolvedFor(frame)).toHaveLength(1)
}), 30_000)

it.live("resolves a Question answered externally through Core on the stream without any further event, read or poll", () => Effect.gen(function* () {
  const h = yield* harness()
  yield* Effect.promise(() => h.open(0, "alpha"))
  const question = yield* h.askQuestion("External")
  const frame = yield* Effect.promise(() => h.requestInput(0, "alpha", question.id))
  yield* Effect.promise(() => h.quiet(0, "alpha"))
  expect(h.inputs(0, "alpha", question.id)).toHaveLength(1)
  const mark = h.frames.length

  yield* h.questions.reply({ requestID: question.id as never, answers: [["One"]] })
  expect((yield* Fiber.join(question.waiting))._tag).toBe("Success")

  const observed = () => h.frames.slice(mark).filter((other) => other.conn === 0 && other.stream_id === "alpha").map((other) => `${other.message.method ?? "response"}${other.message.params?.requestId ? `:${other.message.params.requestId}` : ""}`)
  const cleared = (other: (typeof h.frames)[number]) => other.stream_id === "alpha" && other.message.method === "thread/status/changed"
    && !JSON.stringify((other.message.params as { status?: unknown } | undefined)?.status).includes("waitingOnUserInput")
  const outcome = yield* Effect.promise(async () => {
    try {
      const resolved = await h.resolved(frame)
      const status = await h.until(() => h.frames.slice(mark).find(cleared), "thread/status/changed without waitingOnUserInput", 3_000).catch(() => undefined)
      return { resolved, status, error: undefined }
    } catch (error) { return { resolved: undefined, status: undefined, error: String(error) } }
  })
  if (outcome.resolved === undefined || outcome.status === undefined) throw new Error(`Native carrier did not follow an external Question reply on its own. Frames after the reply: ${JSON.stringify(observed())}; ${outcome.error ?? "resolved arrived, waiting status never cleared"}`)
  expect(outcome.resolved.message.params).toEqual({ threadId: h.root.id, requestId: nativeID(frame) })
  yield* Effect.promise(() => h.quiet(0, "alpha"))
  expect(h.resolvedFor(frame)).toHaveLength(1)
  expect(h.inputs(0, "alpha", question.id)).toHaveLength(1)
  expect(yield* h.receipts).toHaveLength(0)
  expect(h.frames.slice(mark).filter((other) => other.message.method === "item/tool/requestUserInput")).toHaveLength(0)
}), 30_000)

const goalReceipts = (db: Database.Interface["db"], root: Session.Info["id"]) =>
  SessionPending.list(db, root).pipe(
    Effect.map((items) => items.flatMap((item) => {
      if (item.type !== "synthetic" || !item.id.startsWith("msg_goaldec_")) return []
      const decoded = Schema.decodeUnknownOption(SessionGoalDecisions.Receipt)(item.data.metadata?.goalDecision)
      return decoded._tag === "Some" ? [decoded.value] : []
    })),
  )

const recommendedForm = (sessionID: Session.Info["id"]): Form.CreateInput => ({
  sessionID,
  title: "Choose the synthetic branch",
  fields: [{ key: "branch", type: "string", required: true, options: [{ value: "safe", label: "Safe (Recommended)" }] }],
})

for (const kind of ["guardrail", "form"] as const) for (const order of ["native first", "goal loop first"] as const)
  it.live(`a pending ${kind} that the native client and the goal loop both settle is settled once (${order})`, () => Effect.gen(function* () {
    const h = yield* harness({ goalLoop: true })
    const loop = h.goalLoop!
    yield* Effect.promise(() => h.open(0, "alpha"))
    const candidate = kind === "guardrail"
      ? yield* h.askGuardrail(`${os.homedir()}/ycoding-goal-race-${crypto.randomUUID()}/notes.txt`, "file_mutation")
      : yield* h.forms.create(recommendedForm(h.root.id))
    const frame = yield* Effect.promise(() => h.requestInput(0, "alpha", candidate.id))
    const requestID = nativeID(frame)
    expect(h.inputs(0, "alpha", candidate.id)).toHaveLength(1)
    expect(h.control.reconsiders).toEqual([])
    expect(yield* goalReceipts(h.db.db, h.root.id)).toEqual([])
    yield* loop.auto

    let nativeFailure: Frame | undefined
    if (order === "native first") {
      h.control.beforeReconsider = Effect.promise(async () => {
        h.send(0, "alpha", { id: frame.message.id, result: { answers: h.answerFor(frame) } })
        await h.resolved(frame)
      })
      yield* loop.release
      yield* loop.inspect(h.root.id)
    } else {
      const gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      h.control.nativeGate = gate
      const from = h.frames.length
      h.send(0, "alpha", { id: frame.message.id, result: { answers: h.answerFor(frame) } })
      yield* Deferred.await(gate.entered).pipe(Effect.timeout("5 seconds"))
      yield* loop.release
      yield* loop.inspect(h.root.id)
      yield* Deferred.succeed(gate.release, undefined)
      nativeFailure = yield* Effect.promise(() => h.until(() => h.frames.slice(from).find((other) => other.stream_id === "alpha" && other.message.id === frame.message.id && other.message.error !== undefined), "native response rejection"))
      yield* Effect.promise(() => h.resolved(frame))
    }
    yield* loop.inspect(h.root.id)
    yield* loop.inspect(h.root.id)
    yield* Effect.promise(() => h.quiet(0, "alpha"))

    const replied = h.seen.filter((event) =>
      (event.type === Guardrail.Event.Replied.type && event.data.requestID === candidate.id) ||
      (event.type === Form.Event.Replied.type && event.data.id === candidate.id))
    const dots = (yield* h.receipts).filter((event) => {
      const target = Schema.decodeUnknownSync(SessionEvent.DotsDecisionSettled.data)(event.data).target
      return (target.kind === "form" ? target.formID : target.kind === "guardrail" ? target.requestID : undefined) === candidate.id
    })
    const decided = (yield* h.durableEvents(SessionEvent.GuardrailDecided.type)).filter((event) => event.data.requestID === candidate.id)
    const goal = (yield* goalReceipts(h.db.db, h.root.id)).filter((receipt) => receipt.outcome === "settled" && receipt.candidate.requestID === candidate.id)

    expect(replied.length + (kind === "guardrail" ? decided.length : 0)).toBe(1)
    expect(dots.length + decided.length + (kind === "form" ? goal.length : 0)).toBe(1)
    expect(h.resolvedFor(frame).map((other) => other.message.params)).toEqual([{ threadId: h.root.id, requestId: requestID }])
    expect(h.inputs(0, "alpha", candidate.id)).toHaveLength(1)
    expect(h.control.reconsiders).toEqual([`${kind}:${candidate.id}`])
    expect(h.control.nativeSettles).toBe(1)

    if (order === "native first") {
      expect(dots).toHaveLength(1)
      expect(dots[0]?.data).toMatchObject({ source: { kind: "dots-native", requestID }, target: kind === "guardrail" ? { kind: "guardrail", requestID: candidate.id } : { kind: "form", formID: candidate.id } })
      expect(decided).toEqual([])
      expect(goal).toEqual([])
      expect(h.control.reconsiderResults).toEqual([{ outcome: "stale", settled: false }])
    } else {
      expect(dots).toEqual([])
      expect(nativeFailure?.message.error).toMatchObject({ code: -32603, message: "Native decision could not be confirmed" })
      expect(goal).toHaveLength(1)
      expect(goal[0]).toMatchObject({ outcome: "settled", via: kind === "guardrail" ? "auto-guardrail" : "auto-answer", candidate: { kind, requestID: candidate.id } })
      expect(h.control.reconsiderResults).toEqual([{ outcome: "allowed", settled: true }])
      if (kind === "guardrail") expect(decided[0]?.data).toMatchObject({ actor: "coordinator", coordinatorSessionID: h.root.id, reply: "once" })
      else expect(replied[0]?.data).toMatchObject({ source: { kind: "coordinator", coordinatorSessionID: h.root.id } })
    }
  }), 30_000)
