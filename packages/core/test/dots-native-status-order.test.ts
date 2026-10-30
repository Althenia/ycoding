import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { NativeDots } from "@ycoding-ai/core/dots/native"
import { NativeDecisions } from "@ycoding-ai/core/dots/native-decisions"
import { DotsAccess } from "@ycoding-ai/core/dots/access"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { Project } from "@ycoding-ai/core/project"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { Database } from "@ycoding-ai/core/database/database"
import { KV } from "@ycoding-ai/core/kv"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { Decision } from "@ycoding-ai/core/decision"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Job } from "@ycoding-ai/core/job"
import { AppProcess } from "@ycoding-ai/core/process"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { SessionGoal } from "@ycoding-ai/core/session/goal"
import { Shell } from "@ycoding-ai/core/shell"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { fixedLocations } from "./fixture/location-map"
import { reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"

const realExecutionLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node, KV.node, EventRuntime.node, Session.node, SessionStore.node, SessionExecution.node, Project.node,
    SessionAutonomy.node, SessionOrchestration.node, SessionReview.node, LocationServiceMap.node, Job.node,
  ]),
  [
    [SessionExecution.node, SessionExecution.noopLayer],
    [Project.node, Layer.mock(Project.Service, {
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      recordOpened: () => Effect.void,
    })],
    [KeepAwake.node, Layer.mock(KeepAwake.Service, {
      hold: () => Effect.succeed({ state: "off" as const }), release: () => Effect.succeed({ state: "off" as const }),
      get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
    })],
    [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.die("Status ordering never requests a judgment") })],
  ],
)
const it = testEffect(realExecutionLayer)

const realCoordinator = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const store = yield* SessionStore.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  const runStarted = yield* Deferred.make<void>()
  const runFinish = yield* Deferred.make<void>()
  const drains = { count: 0 }
  const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({
    drain: () => Effect.sync(() => { drains.count++ }).pipe(
      Effect.andThen(Deferred.succeed(runStarted, undefined)),
      Effect.andThen(Deferred.await(runFinish)),
    ),
  }))
  const shell = Layer.mock(Shell.Service, { list: () => Effect.succeed([]) })
  const goals = Layer.succeed(SessionGoal.Service, SessionGoal.Service.of({
    synthesize: () => Effect.die("unused"), steer: () => Effect.die("unused"), continuation: () => Effect.die("unused"),
  }))
  const locations = Layer.effect(
    LocationServiceMap.Service,
    fixedLocations(() => Layer.mergeAll(runner, shell, goals) as unknown as Layer.Layer<LocationServices>),
  )
  const compaction = SessionCompactionExecution.Service.of({ start: () => Effect.die("unused"), run: () => Effect.die("unused") })
  const context = yield* Layer.buildWithScope(
    SessionRestart.layer.pipe(
      Layer.provideMerge(SessionExecution.layer),
      Layer.provide(Layer.succeed(Database.Service, database)),
      Layer.provide(Layer.succeed(EventRuntime.Service, events)),
      Layer.provide(AppNodeBuilder.build(LayerNode.group([AppProcess.node]))),
      Layer.provide(Layer.succeed(SessionStore.Service, store)),
      Layer.provide(Layer.succeed(SessionAutonomy.Service, SessionAutonomy.make({ db: database.db }))),
      Layer.provide(Layer.succeed(Job.Service, jobs)),
      Layer.provide(Layer.succeed(SessionCompactionExecution.Service, compaction)),
      Layer.provide(locations),
    ),
    scope,
  )
  return { execution: Context.get(context, SessionExecution.Service), runStarted, runFinish, drains }
})

const nativeSetup = Effect.gen(function* () {
  const location = yield* reviewLocation
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location })
  const db = yield* Database.Service
  const events = yield* EventRuntime.Service
  const store = yield* SessionStore.Service
  const { execution, runStarted, runFinish, drains } = yield* realCoordinator
  expect(execution).not.toBe(yield* SessionExecution.Service)
  const projects = yield* Project.Service
  const reviews = yield* SessionReview.Service
  const orchestration = yield* SessionOrchestration.Service
  const locations = yield* LocationServiceMap.Service
  const kv = yield* KV.Service
  const credential = new Credential.Info({ id: Credential.ID.make("cred_native_status"), integrationID: Integration.ID.make("openai"), label: "native-status", value: {
    type: "oauth", methodID: Integration.MethodID.make("chatgpt-browser"), access: "synthetic", refresh: "synthetic", expires: 0, metadata: { accountID: "synthetic-native-account" },
  } })
  const access = DotsAccess.make({ db, kv, configuration: () => Effect.succeed({ ready: true, profile: credential.label }) })
  yield* access.set({ enabled: true, expectedRevision: 0 })
  const host = yield* NativeDots.make({ access, db, events, store, sessions, execution, projects,
    kv, reviews, home: location.directory, data: location.directory, projectRoot: () => Effect.succeed(undefined),
    config: { snapshot: () => Effect.succeed({ entries: [new Config.Document({ type: "document", scope: "global", info: new Config.Info({ dots: { enabled: true, profile: credential.label } }) })], diagnostics: [] }), subscribe: () => () => {} },
    credentials: { list: () => Effect.succeed([credential]) }, credential: () => Effect.succeed(undefined),
    models: () => Effect.succeed([]), skills: () => Effect.succeed([]), selectedModel: (session) => Effect.succeed(session.model),
    decisions: (session) => Effect.gen(function* () {
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const forms = yield* Form.Service
      const questions = yield* Question.Service
      return NativeDecisions.make({ permission, guardrail, forms, questions, reviews, orchestration, sessions })
    }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
    authorization: (session) => Effect.gen(function* () {
      return { permission: yield* Permission.Service, guardrail: yield* SessionGuardrail.Service }
    }).pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full]))),
  })
  const pins: NativeDots.Pins = { accessRevision: 1, profile: credential.label, credentialID: credential.id, accountID: "synthetic-native-account", accountGeneration: 0,
    environmentID: "synthetic-environment", connectionID: "synthetic-connection", isCurrent: () => true }
  const connection = yield* Effect.promise(() => host.attach(pins))
  const channel = connection.channel({ clientID: "native-client", streamID: "native-stream" })
  const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
  return { root, sessions, execution, runStarted, runFinish, drains, events, channel, located: locations.get(location, [LocationServiceMap.full]), settle }
})

const terminalTypes = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
const questionInfo = { question: "Which option?", header: "Option", options: [{ label: "One", description: "First option" }] }

it.live("a started execution is visible to the native snapshot, but terminal events are delivered before the registry drops the Session", () => Effect.gen(function* () {
  const f = yield* nativeSetup
  const seen: Array<{ type: string; registry: boolean }> = []
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, (event) => {
    if (event.type !== "session.execution.started" && !terminalTypes.includes(event.type)) return
    seen.push({ type: event.type, registry: Effect.runSync(f.execution.active).has(f.root.id) })
  }))
  yield* Effect.addFinalizer(() => Effect.sync(stop))
  const running = yield* f.execution.resume(f.root.id).pipe(Effect.forkScoped)
  yield* Deferred.await(f.runStarted)
  expect(f.drains.count).toBe(1)
  expect(seen).toEqual([{ type: "session.execution.started", registry: true }])
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.active).toBe(true)
  yield* Deferred.succeed(f.runFinish, undefined)
  yield* Fiber.join(running)
  yield* f.execution.awaitIdle(f.root.id)
  expect(seen.map((item) => item.type)).toEqual(["session.execution.started", "session.execution.succeeded"])
  expect(seen[1]?.registry).toBe(true)
  expect(Effect.runSync(f.execution.active).has(f.root.id)).toBe(false)
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.active).toBe(false)
}))

const questionReads = Effect.gen(function* () {
  const f = yield* nativeSetup
  const questions = yield* Question.Service.pipe(Effect.provide(f.located))
  const reads: Array<{ type: string; waiting: Promise<readonly string[] | undefined> }> = []
  const stop = yield* Effect.promise(() => f.channel.subscribe(f.root.id, (event) => {
    if (event.type !== "question.asked" && event.type !== "question.replied") return
    reads.push({ type: event.type, waiting: f.channel.getRoot(f.root.id).then((root) => root?.waiting) })
  }))
  yield* Effect.addFinalizer(() => Effect.sync(stop))
  const asking = yield* questions.ask({ sessionID: f.root.id, questions: [questionInfo] }).pipe(Effect.forkScoped)
  yield* Effect.promise(async () => { while (reads.length === 0) await new Promise<void>((resolve) => setImmediate(resolve)) })
  const asked = yield* Effect.promise(() => reads[0]!.waiting)
  const request = (yield* questions.list())[0]!
  yield* questions.reply({ requestID: request.id, answers: [["One"]] })
  yield* Fiber.join(asking)
  yield* f.settle
  const replied = yield* Effect.promise(() => reads[1]!.waiting)
  return { f, asked, replied, questions }
})

it.live("a pending question is already waiting when its asked event reaches the native subscription", () => Effect.gen(function* () {
  const { asked } = yield* questionReads
  expect(asked).toEqual(["user-input"])
}))

it.live("window: a decision-clearing event is delivered before the decision leaves the pending set", () => Effect.gen(function* () {
  const { f, replied, questions } = yield* questionReads
  expect(replied).toEqual(["user-input"])
  expect(yield* questions.list()).toEqual([])
  expect((yield* Effect.promise(() => f.channel.getRoot(f.root.id)))?.waiting).toEqual([])
}))
