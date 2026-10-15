import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { eq } from "drizzle-orm"
import path from "path"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Project } from "@ycoding-ai/core/project"
import { AppProcess } from "@ycoding-ai/core/process"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionPendingTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  }),
)

const held: string[] = []
const released: string[] = []
let decisionConfidence = 0.9
const keepAwake = Layer.effect(
  KeepAwake.Service,
  Effect.gen(function* () {
    const awake = yield* KeepAwake.make({ spawner: yield* AppProcess.Service, platform: "linux", pid: process.pid, clamshell: { set: () => "unsupported" } })
    return KeepAwake.Service.of({
      ...awake,
      hold: (id) =>
        awake.hold(id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              held.push(id)
            }),
          ),
        ),
      release: (id) =>
        awake.release(id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              released.push(id)
            }),
          ),
        ),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))

const build = (database?: Layer.Layer<never>, projectLayer = projects) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventRuntime.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionOrchestration.node,
      LocationServiceMap.node,
    ]),
    [
      [Project.node, projectLayer],
      [SessionExecution.node, SessionExecution.noopLayer],
      [KeepAwake.node, keepAwake],
      [
        Decision.node,
        Layer.succeed(
          Decision.Service,
          Decision.Service.of({
            evaluate: (input) =>
              Effect.succeed(
                Schema.decodeUnknownSync(Decision.Output)({
                  provider: "agent",
                  response: {
                    model: { providerID: "test", id: "decision-model" },
                    semantics: "model-estimate",
                    version: 1,
                    answers: [
                      {
                        name: input.request.questions[0]!.name,
                        type: input.request.questions[0]!.type,
                        answer: input.request.questions[0]!.type === "predicate" ? true : null,
                        choice: input.request.questions[0]!.type === "predicate" ? null : input.request.questions[0]!.name === "guardrail" ? "escalate" : "Careful",
                        score: null,
                        confidence: decisionConfidence,
                      },
                    ],
                  },
                }),
              ),
          }),
        ),
      ],
      ...(database ? [[Database.node, database] as const] : []),
    ],
  )

const it = testEffect(build())
const unavailableLocation = testEffect(build(undefined, Layer.effect(Project.Service, Effect.gen(function* () {
  const service = yield* Project.Service
  return Project.Service.of({ ...service, resolve: (directory) => directory.endsWith("/unavailable")
    ? Effect.die(new Error("Fixture Location unavailable")) : service.resolve(directory) })
})).pipe(Layer.provide(projects))))
const locationFor = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })
const tmpLocation = Effect.gen(function* () {
  const directory = yield* Effect.promise(() => tmpdir("ycoding-sleep-"))
  yield* Effect.addFinalizer(() => Effect.promise(() => directory[Symbol.asyncDispose]()))
  return locationFor(directory.path)
})

const pendingTexts = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(SessionPendingTable)
      .where(eq(SessionPendingTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => JSON.stringify(row))
  })

const requestReview = Effect.fnUntraced(function* (guardrail: SessionGuardrail.Interface, sessionID: Session.ID) {
  const events = yield* EventRuntime.Service
  const asked = yield* Deferred.make<Guardrail.Request>()
  const stop = yield* events.listen((event) => {
    if (event.type !== Guardrail.Event.Asked.type) return Effect.void
    const request = Schema.decodeUnknownSync(Guardrail.Request)(event.data)
    return request.sessionID === sessionID ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
  })
  const fiber = yield* guardrail.assert({ sessionID, action: "shell", resources: ["git reset --hard"] }).pipe(Effect.forkScoped)
  const request = yield* Deferred.await(asked).pipe(Effect.ensuring(stop))
  return { fiber, request }
})

describe("Session sleep", () => {
  it.effect("sleep rejects escalated reviews across family Locations and preserves plain human reviews", () => Effect.gen(function* () {
    const session = yield* Session.Service
    const root = yield* session.create({ location: yield* tmpLocation })
    const child = yield* session.create({ parentID: root.id })
    const other = yield* session.create({ location: root.location })
    const events = yield* EventRuntime.Service
    const childLocation = yield* tmpLocation
    yield* events.publish(SessionEvent.Moved, { sessionID: child.id, location: childLocation })
    const locations = yield* LocationServiceMap.Service
    const rootGuardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(root.location)))
    const childGuardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(childLocation)))
    const plain = yield* requestReview(rootGuardrail, root.id)
    const unrelated = yield* requestReview(rootGuardrail, other.id)
    yield* session.autonomy.set({ sessionID: root.id, guardrailDecision: true })
    const escalatedRoot = yield* requestReview(rootGuardrail, root.id)
    const escalatedChild = yield* requestReview(childGuardrail, child.id)
    expect(escalatedRoot.request.escalation).toBeDefined()
    expect(escalatedChild.request.escalation).toBeDefined()
    yield* session.autonomy.set({ sessionID: child.id, sleep: true })
    expect((yield* rootGuardrail.forSession(root.id)).map((request) => request.id)).toEqual([plain.request.id])
    expect(yield* childGuardrail.forSession(child.id)).toEqual([])
    expect(Exit.isFailure(yield* Fiber.await(escalatedRoot.fiber))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.await(escalatedChild.fiber))).toBe(true)
    expect((yield* rootGuardrail.forSession(other.id)).map((request) => request.id)).toEqual([unrelated.request.id])
    expect(plain.fiber.pollUnsafe()).toBeUndefined()
    expect(unrelated.fiber.pollUnsafe()).toBeUndefined()
    const decisions = (yield* rootGuardrail.status(root.id)).decisions ?? []
    expect(decisions.map((item) => ({ sessionID: item.sessionID, requestID: item.requestID, reply: item.reply, choice: item.choice, confidence: item.confidence }))).toEqual([
      { sessionID: root.id, requestID: escalatedRoot.request.id, reply: "reject", choice: escalatedRoot.request.escalation?.choice, confidence: escalatedRoot.request.escalation?.confidence },
      { sessionID: child.id, requestID: escalatedChild.request.id, reply: "reject", choice: escalatedChild.request.escalation?.choice, confidence: escalatedChild.request.escalation?.confidence },
    ])
  }))
  unavailableLocation.effect("a failed family Location does not skip later rejections or sleep notices", () => Effect.gen(function* () {
    const session = yield* Session.Service
    const root = yield* session.create({ location: yield* tmpLocation })
    const unavailable = yield* session.create({ parentID: root.id })
    const child = yield* session.create({ parentID: unavailable.id })
    const childLocation = yield* tmpLocation
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Moved, { sessionID: unavailable.id, location: locationFor(path.join(root.location.directory, "unavailable")) })
    yield* events.publish(SessionEvent.Moved, { sessionID: child.id, location: childLocation })
    const locations = yield* LocationServiceMap.Service
    const rootGuardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(root.location)))
    const childGuardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(childLocation)))
    yield* session.autonomy.set({ sessionID: root.id, guardrailDecision: true })
    const waitingRoot = yield* requestReview(rootGuardrail, root.id)
    const waitingChild = yield* requestReview(childGuardrail, child.id)
    expect((yield* session.autonomy.set({ sessionID: root.id, sleep: true })).sleep).toBeDefined()
    expect(Exit.isFailure(yield* Fiber.await(waitingRoot.fiber))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.await(waitingChild.fiber))).toBe(true)
    expect(yield* rootGuardrail.forSession(root.id)).toEqual([])
    expect(yield* childGuardrail.forSession(child.id)).toEqual([])
    const store = yield* SessionStore.Service
    for (const member of [root, unavailable, child]) {
      const notice = (yield* store.context(member.id)).at(-1)
      expect(notice?.type === "system" && notice.text).toContain("user is asleep")
    }
    expect((yield* rootGuardrail.status(root.id)).decisions).toHaveLength(2)
  }))
  it.live("archiving a sleeping root wakes it and releases its hold without rearming on unarchive", () => Effect.gen(function* () {
    const session = yield* Session.Service
    const root = yield* session.create({ location: yield* tmpLocation })
    const before = released.length
    yield* session.autonomy.set({ sessionID: root.id, sleep: true })
    yield* session.archive(root.id)
    expect((yield* session.autonomy.get(root.id)).sleep).toBeUndefined()
    expect((yield* session.autonomy.get(root.id)).guardrailDecision).toBe(false)
    expect(released.slice(before)).toEqual([root.id])
    yield* session.unarchive(root.id)
    expect((yield* session.autonomy.get(root.id)).sleep).toBeUndefined()
    expect(released.slice(before)).toEqual([root.id])
  }))
  it.effect("sleep answers orchestration options and falls back on low confidence", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ location: yield* tmpLocation })
      const child = yield* sessions.create({ parentID: root.id })
      const events = yield* EventRuntime.Service
      yield* events.publish(
        SessionEvent.Task.Updated,
        Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({
          sessionID: child.id,
          change: {
            type: "launched",
            parentID: root.id,
            parentAssistantMessageID: "msg_sleep_parent",
            toolCallID: "call_sleep_child",
            inputID: "msg_sleep_input",
            description: "Sleep child",
            agent: "build",
            model: { providerID: "test", id: "decision-model" },
            promptDigest: "digest",
            background: true,
            delivery: "steer",
          },
        }),
      )
      yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
      yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
      const orchestration = yield* SessionOrchestration.Service
      decisionConfidence = 0.9
      expect(
        (yield* orchestration.question(child.id, "Choose a plan", { options: ["Fast", "Careful"] })).autoAnswered,
      ).toBe(true)
      expect((yield* pendingTexts(child.id)).join("\n")).toContain("Careful")
      decisionConfidence = 0.79
      expect(
        (yield* orchestration.question(child.id, "Choose another plan", { options: ["Fast", "Careful"] })).autoAnswered,
      ).toBe(true)
      expect((yield* pendingTexts(child.id)).join("\n")).toContain("Continue with the safest reasonable default")
    }),
  )
  it.effect(
    "sleep holds keep-awake, admits a sleep notice, and wake restores the prior guardrail-decision toggle",
    () =>
      Effect.gen(function* () {
        held.length = 0
        released.length = 0
        const session = yield* Session.Service
        const created = yield* session.create({ location: yield* tmpLocation })
        yield* session.autonomy.set({ sessionID: created.id, guardrailDecision: true })

        const asleep = yield* session.autonomy.set({ sessionID: created.id, sleep: true })
        expect(asleep.sleep).toEqual({ priorGuardrailDecision: true })
        expect(held).toEqual([created.id])
        const store = yield* SessionStore.Service
        const notice = (yield* store.context(created.id)).find((message) => message.type === "system")
        expect(notice).toMatchObject({ type: "system", metadata: { contextSource: "session-state" } })
        expect(notice?.type === "system" && notice.text).toContain("user is asleep")
        expect(notice?.type === "system" && notice.text).toContain("battery")

        const woken = yield* session.autonomy.set({ sessionID: created.id, sleep: false })
        expect(woken.sleep).toBeUndefined()
        expect(woken.guardrailDecision).toBe(true)
        expect(released).toEqual([created.id])
        expect((yield* store.context(created.id)).at(-1)).toMatchObject({
          type: "system",
          text: expect.stringContaining("user is back"),
        })
      }),
  )

  it.effect("a user prompt wakes the family and releases the keep-awake hold", () =>
    Effect.gen(function* () {
      held.length = 0
      released.length = 0
      const session = yield* Session.Service
      const created = yield* session.create({ location: yield* tmpLocation })
      yield* session.autonomy.set({ sessionID: created.id, sleep: true })
      expect(held).toEqual([created.id])

      yield* session.prompt({ sessionID: created.id, text: "Back now", resume: false })

      const state = yield* session.autonomy.get(created.id)
      expect(state.sleep).toBeUndefined()
      expect(state.guardrailDecision).toBe(false)
      expect(released).toEqual([created.id])
      const texts = (yield* pendingTexts(created.id)).join("\n")
      const store = yield* SessionStore.Service
      expect((yield* store.context(created.id)).at(-1)).toMatchObject({
        type: "system",
        text: expect.stringContaining("user is back"),
      })
      expect(texts).toContain("Back now")
    }),
  )

  it.effect("child switches control the root family and a child prompt wakes every member", () =>
    Effect.gen(function* () {
      held.length = 0
      released.length = 0
      const session = yield* Session.Service
      const root = yield* session.create({ location: yield* tmpLocation })
      const child = yield* session.create({ parentID: root.id })
      yield* session.autonomy.set({ sessionID: child.id, yolo: 2 })
      expect((yield* session.autonomy.set({ sessionID: child.id, guardrailDecision: true })).yolo).toBe(2)
      expect((yield* session.autonomy.get(root.id)).guardrailDecision).toBe(true)
      yield* session.autonomy.set({ sessionID: child.id, sleep: true })
      expect(held).toEqual([root.id])
      expect((yield* session.autonomy.get(child.id)).sleep).toEqual({ priorGuardrailDecision: true })
      const store = yield* SessionStore.Service
      expect((yield* store.context(child.id)).at(-1)).toMatchObject({
        type: "system",
        text: expect.stringContaining("user is asleep"),
      })
      yield* session.prompt({ sessionID: child.id, text: "Delegated input", origin: "subagent", resume: false })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeDefined()
      yield* session.prompt({ sessionID: child.id, text: "Plugin input", origin: "plugin", resume: false })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeDefined()
      yield* session.prompt({ sessionID: child.id, text: "Back", metadata: { origin: "subagent" }, resume: false })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeUndefined()
      expect((yield* session.autonomy.get(child.id)).guardrailDecision).toBe(true)
      expect(released).toEqual([root.id])
    }),
  )

  it.effect("a plugin command leaves a sleeping family asleep while a user command wakes it", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => tmpdir("ycoding-sleep-command-"))
      yield* Effect.addFinalizer(() => Effect.promise(() => directory[Symbol.asyncDispose]()))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory.path, "ycoding.json"),
          JSON.stringify({ commands: { note: { template: "Take a note" } } }),
        ),
      )
      const session = yield* Session.Service
      const root = yield* session.create({ location: locationFor(directory.path) })
      const locations = yield* LocationServiceMap.Service
      yield* PluginSupervisor.Service.use((supervisor) => supervisor.flush).pipe(
        Effect.provide(locations.get(root.location)),
      )
      yield* session.autonomy.set({ sessionID: root.id, sleep: true })
      yield* session.command({ sessionID: root.id, command: "note", origin: "plugin", resume: false })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeDefined()
      yield* session.command({ sessionID: root.id, command: "note", resume: false })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeUndefined()
    }),
  )

  it.effect("a retried prompt that reuses its message ID does not wake a family put to sleep afterwards", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const root = yield* session.create({ location: yield* tmpLocation })
      const id = SessionMessage.ID.make("msg_sleep_retry")
      yield* session.prompt({ id, sessionID: root.id, text: "Original", resume: false })
      yield* session.autonomy.set({ sessionID: root.id, sleep: true })
      yield* session.prompt({ id, sessionID: root.id, text: "Original", resume: false })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeDefined()
      yield* session.prompt({ sessionID: root.id, text: "Fresh", resume: false })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeUndefined()
    }),
  )

  it.effect("a user prompt wakes the family before the runner can promote its input", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const root = yield* session.create({ location: yield* tmpLocation })
      yield* session.autonomy.set({ sessionID: root.id, sleep: true })
      const { db } = yield* Database.Service
      const events = yield* EventRuntime.Service
      const asleepAtPromotion = yield* Deferred.make<boolean>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === SessionEvent.InputAdmitted.type
          ? SessionPending.promoteSteers(db, events, root.id, () =>
              session.autonomy
                .get(root.id)
                .pipe(Effect.flatMap((state) => Deferred.succeed(asleepAtPromotion, state.sleep !== undefined))),
            ).pipe(Effect.forkDetach, Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* session.prompt({ sessionID: root.id, text: "Back", resume: false })
      expect(yield* Deferred.await(asleepAtPromotion)).toBe(false)
    }),
  )

  testEffect(Layer.empty).live(
    "restart rehydrates sleep keep-awake holds from durable autonomy",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => tmpdir("ycoding-sleep-rehydrate-"))
        yield* Effect.addFinalizer(() => Effect.promise(() => directory[Symbol.asyncDispose]()))
        const databasePath = path.join(directory.path, "sleep.db")
        const firstHeld = yield* Deferred.make<string>()
        const recording = (signal: typeof firstHeld) =>
          Layer.effect(
            KeepAwake.Service,
            Effect.gen(function* () {
              const awake = yield* KeepAwake.make({
                spawner: yield* AppProcess.Service,
                platform: "linux",
                pid: process.pid,
                clamshell: { set: () => "unsupported" },
              })
              return KeepAwake.Service.of({
                ...awake,
                hold: (id) => awake.hold(id).pipe(Effect.tap(() => Deferred.succeed(signal, id))),
              })
            }),
          ).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
        const layerFor = (signal: typeof firstHeld) =>
          AppNodeBuilder.build(
            LayerNode.group([
              Database.node,
              EventRuntime.node,
              SessionProjector.node,
              SessionStore.node,
              Session.node,
              LocationServiceMap.node,
            ]),
            [
              [Project.node, projects],
              [SessionExecution.node, SessionExecution.noopLayer],
              [KeepAwake.node, recording(signal)],
              [Database.node, Database.layer({ path: databasePath })],
            ],
          )
        const firstScope = yield* Scope.make()
        const first = Context.get(
          yield* Layer.buildWithScope(Layer.fresh(layerFor(firstHeld)), firstScope),
          Session.Service,
        )
        const created = yield* first.create({ location: locationFor(directory.path) })
        yield* first.autonomy.set({ sessionID: created.id, sleep: true })
        expect(yield* Deferred.await(firstHeld)).toBe(created.id)
        yield* Scope.close(firstScope, Exit.void)
        const secondHeld = yield* Deferred.make<string>()
        const secondScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
        const second = Context.get(
          yield* Layer.buildWithScope(Layer.fresh(layerFor(secondHeld)), secondScope),
          Session.Service,
        )
        expect(yield* Deferred.await(secondHeld)).toBe(created.id)
        expect((yield* second.autonomy.get(created.id)).sleep).toEqual({ priorGuardrailDecision: false })
      }),
    60_000,
  )
})
