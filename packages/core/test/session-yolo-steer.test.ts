import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { Permission } from "@ycoding-ai/core/permission"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Project } from "@ycoding-ai/core/project"
import { Question } from "@ycoding-ai/core/question"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) =>
      directory.endsWith("/unavailable")
        ? Effect.die(new Error("Fixture Location unavailable"))
        : Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  }),
)

const wakes: Session.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
    withTransition: (_sessionID, effect) => effect,
  }),
)

let decide: () => Effect.Effect<Decision.Output, Decision.Error> = () => Effect.fail(new Decision.Error({ reason: "unavailable" }))
const decision = Layer.mock(Decision.Service, { evaluate: () => Effect.suspend(decide) })

const digestA = "a".repeat(64)
const digestB = "b".repeat(64)
const attachmentURI = (digest: string) => `ycoding-attachment://sha256/${digest}`
let resolving: (uri: string) => Effect.Effect<void> = () => Effect.void
const attachments = Layer.succeed(
  AttachmentStore.Service,
  AttachmentStore.Service.of({
    import: () => Effect.die("unused"),
    read: () => Effect.succeed(new TextEncoder().encode("note")),
    resolveURI: (uri) =>
      resolving(uri).pipe(
        Effect.map(() => {
          const digest = AttachmentStore.managedDigest(uri) ?? digestA
          return { type: "managed" as const, digest, bytes: 4, path: `attachments/sha256/${digest.slice(0, 2)}/${digest}` }
        }),
      ),
    absolutePath: () => "/unused",
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, Session.node, SessionOrchestration.node, SessionReview.node, LocationServiceMap.node]),
    [
      [Project.node, projects],
      [SessionExecution.node, execution],
      [Decision.node, decision],
      [AttachmentStore.node, attachments],
      [
        KeepAwake.node,
        Layer.mock(KeepAwake.Service, {
          hold: () => Effect.succeed({ state: "off" as const }),
          release: () => Effect.succeed({ state: "off" as const }),
          get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
        }),
      ],
    ],
  ),
)

const directive = "Local-only: cancel the transfer and continue with the local goal."

const tmpLocation = Effect.gen(function* () {
  const directory = yield* Effect.promise(() => tmpdir("ycoding-yolo-steer-"))
  yield* Effect.addFinalizer(() => Effect.promise(() => directory[Symbol.asyncDispose]()))
  return Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
})

const setup = Effect.fnUntraced(function* (options: { readonly yolo?: boolean } = {}) {
  const session = yield* Session.Service
  const root = yield* session.create({ location: yield* tmpLocation })
  if (options.yolo !== false) yield* session.autonomy.set({ sessionID: root.id, permissions: "yolo", guardrails: "yolo", answers: "yolo" })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location)
  const forms = yield* Form.Service.pipe(Effect.provide(located))
  const questions = yield* Question.Service.pipe(Effect.provide(located))
  const events = yield* EventRuntime.Service
  const seen: Array<{ readonly type: string; readonly data: unknown }> = []
  const waiters: Array<{ readonly type: string; readonly count: number; readonly done: Deferred.Deferred<void> }> = []
  const count = (type: string) => seen.filter((event) => event.type === type).length
  const stop = yield* events.listen((event) =>
    Effect.gen(function* () {
      seen.push({ type: event.type, data: event.data })
      for (const waiter of waiters.filter((item) => item.type === event.type && count(item.type) >= item.count))
        yield* Deferred.succeed(waiter.done, undefined)
    }),
  )
  yield* Effect.addFinalizer(() => stop)
  const arrived = Effect.fnUntraced(function* (type: string, occurrences = 1) {
    const done = yield* Deferred.make<void>()
    if (count(type) >= occurrences) yield* Deferred.succeed(done, undefined)
    else waiters.push({ type, count: occurrences, done })
    return Deferred.await(done)
  })
  wakes.length = 0
  decide = () => Effect.fail(new Decision.Error({ reason: "unavailable" }))
  return { session, root, forms, questions, seen, count, arrived }
})

const askForm = (forms: Form.Interface, sessionID: Session.ID, title = "Transfer reservation") =>
  forms.ask({
    sessionID,
    title,
    metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string", required: true }],
  })

const heldHelper = Effect.fnUntraced(function* () {
  const started = yield* Deferred.make<void>()
  const gate = yield* Deferred.make<void>()
  const interrupted = { count: 0 }
  decide = () =>
    Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(gate)),
      Effect.andThen(Effect.fail(new Decision.Error({ reason: "unavailable" }))),
      Effect.onInterrupt(() => Effect.sync(() => void interrupted.count++)),
    )
  return { started: Deferred.await(started), gate, interrupted }
})

describe("fresh human steer under effective YOLO", () => {
  it.live("releases a paused question wait without answering it and wakes the runner", () =>
    Effect.gen(function* () {
      const { session, root, forms, count, arrived } = yield* setup()
      const created = yield* arrived(Form.Event.Created.type)
      const waiting = yield* askForm(forms, root.id).pipe(Effect.forkScoped)
      yield* created

      const admitted = yield* session.prompt({ sessionID: root.id, text: directive })

      expect(yield* Fiber.join(waiting)).toEqual({ status: "cancelled" })
      expect(yield* forms.list({ sessionID: root.id })).toEqual([])
      expect(count(Form.Event.Cancelled.type)).toBe(1)
      expect(count(Form.Event.Replied.type)).toBe(0)
      expect(count(Form.Event.Deferred.type)).toBe(0)
      expect(wakes).toEqual([root.id])
      expect(admitted).toMatchObject({ sessionID: root.id, delivery: "steer", data: { text: directive } })
      const { db } = yield* Database.Service
      const stored = yield* SessionPending.find(db, admitted.id)
      expect(stored?.type === "user" ? stored.data.text : undefined).toBe(directive)
    }),
  )

  it.live("releases a paused question service wait with a rejection", () =>
    Effect.gen(function* () {
      const { session, root, questions, count, arrived } = yield* setup()
      const asked = yield* arrived(Question.Event.Asked.type)
      const waiting = yield* questions
        .ask({ sessionID: root.id, questions: [{ header: "Reservation", question: "Which reservation?", options: [] }] })
        .pipe(Effect.exit, Effect.forkScoped)
      yield* asked

      yield* session.prompt({ sessionID: root.id, text: directive })

      const exit = yield* Fiber.join(waiting)
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error instanceof Question.RejectedError)).toBe(true)
      expect(yield* questions.list()).toEqual([])
      expect(count(Question.Event.Rejected.type)).toBe(1)
      expect(count(Question.Event.Replied.type)).toBe(0)
    }),
  )

  it.live("releases a wait whose helper is still running and interrupts that helper", () =>
    Effect.gen(function* () {
      const { session, root, forms } = yield* setup()
      const helper = yield* heldHelper()
      const waiting = yield* askForm(forms, root.id).pipe(Effect.forkScoped)
      yield* helper.started

      yield* session.prompt({ sessionID: root.id, text: directive })

      expect(yield* Fiber.join(waiting)).toEqual({ status: "cancelled" })
      expect(helper.interrupted.count).toBe(1)
      expect(yield* forms.list({ sessionID: root.id })).toEqual([])
    }),
  )

  it.live("cancels an asleep-mode ask whose helper is held when the steer wakes the Session", () =>
    Effect.gen(function* () {
      const { session, root, forms } = yield* setup()
      yield* session.autonomy.set({ sessionID: root.id, sleep: true })
      const helper = yield* heldHelper()
      const waiting = yield* askForm(forms, root.id).pipe(Effect.forkScoped)
      yield* helper.started

      yield* session.prompt({ sessionID: root.id, text: directive })
      expect((yield* session.autonomy.get(root.id)).sleep).toBeUndefined()
      yield* Deferred.succeed(helper.gate, undefined)

      expect(yield* Fiber.join(waiting)).toEqual({ status: "cancelled" })
      expect(yield* forms.list({ sessionID: root.id })).toEqual([])
    }),
  )

  it.live("leaves a genuinely missing input pending when it is asked again after the steer", () =>
    Effect.gen(function* () {
      const { session, root, forms, count, arrived } = yield* setup()
      const firstCreated = yield* arrived(Form.Event.Created.type)
      const first = yield* askForm(forms, root.id).pipe(Effect.forkScoped)
      yield* firstCreated
      yield* session.prompt({ sessionID: root.id, text: directive })
      expect(yield* Fiber.join(first)).toEqual({ status: "cancelled" })

      const secondCreated = yield* arrived(Form.Event.Created.type, 2)
      const second = yield* askForm(forms, root.id, "Required identifier").pipe(Effect.forkScoped)
      yield* secondCreated

      expect(yield* forms.list({ sessionID: root.id })).toHaveLength(1)
      expect(count(Form.Event.Cancelled.type)).toBe(1)
      expect(count(Form.Event.Replied.type)).toBe(0)
      yield* Fiber.interrupt(second)
    }),
  )

  it.live("leaves other Sessions and child Sessions untouched", () =>
    Effect.gen(function* () {
      const { session, root, forms, count, arrived } = yield* setup()
      const sibling = yield* session.create({ location: root.location })
      const child = yield* session.create({ parentID: root.id })
      const created = yield* arrived(Form.Event.Created.type, 2)
      const waits = yield* Effect.forEach([sibling.id, child.id], (sessionID) => askForm(forms, sessionID).pipe(Effect.forkScoped))
      yield* created

      yield* session.prompt({ sessionID: root.id, text: directive })

      expect(count(Form.Event.Cancelled.type)).toBe(0)
      expect(yield* forms.list({ sessionID: sibling.id })).toHaveLength(1)
      expect(yield* forms.list({ sessionID: child.id })).toHaveLength(1)
      yield* Effect.forEach(waits, Fiber.interrupt, { discard: true })
    }),
  )

  it.live("leaves a wait pending when YOLO is off", () =>
    Effect.gen(function* () {
      const { session, root, forms, count, arrived } = yield* setup({ yolo: false })
      const created = yield* arrived(Form.Event.Created.type)
      const waiting = yield* askForm(forms, root.id).pipe(Effect.forkScoped)
      yield* created

      yield* session.prompt({ sessionID: root.id, text: directive })

      expect(count(Form.Event.Cancelled.type)).toBe(0)
      expect(yield* forms.list({ sessionID: root.id })).toHaveLength(1)
      yield* Fiber.interrupt(waiting)
    }),
  )

  it.live("surfaces a failed supersession while keeping the admission durable and the runner woken", () =>
    Effect.gen(function* () {
      const { session, root } = yield* setup()
      const events = yield* EventRuntime.Service
      const unavailable = Location.Ref.make({ directory: AbsolutePath.make(path.join(root.location.directory, "unavailable")) })
      yield* events.publish(SessionEvent.Moved, { sessionID: root.id, location: unavailable })
      const id = SessionMessage.ID.create()

      const exit = yield* session.prompt({ id, sessionID: root.id, text: directive }).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      const { db } = yield* Database.Service
      const stored = yield* SessionPending.find(db, id)
      expect(stored?.type === "user" ? stored.data.text : undefined).toBe(directive)
      expect(wakes).toEqual([root.id])

      const retried = yield* session.prompt({ id, sessionID: root.id, text: directive })
      expect(retried.id).toBe(id)
      expect(wakes).toEqual([root.id, root.id])
    }),
  )
})

describe("durable question reviews under a fresh human steer", () => {
  const formPayload = { type: "form", title: "Transfer reservation", fields: [{ key: "q0", type: "string", required: true }] } as const

  it.live("withdraws the Session's earlier question reviews and keeps every other review", () =>
    Effect.gen(function* () {
      const { session, root, forms, count } = yield* setup()
      const reviews = yield* SessionReview.Service
      const child = yield* session.create({ parentID: root.id })
      yield* session.autonomy.set({ sessionID: root.id, sleep: true })
      const deferred = yield* askForm(forms, root.id)
      if (deferred.status !== "deferred") return yield* Effect.die(new Error(`Expected a deferred form, received ${deferred.status}`))
      const open = (sessionID: Session.ID, kind: "question" | "permission" | "guardrail") =>
        reviews.open({
          sessionID,
          kind,
          reason: "disabled",
          origin: { requestID: `req_${kind}` },
          limit: 16,
          payload:
            kind === "question"
              ? formPayload
              : kind === "permission"
                ? { type: "permission", action: "shell", resources: ["touch upload.txt"], fingerprint: "a".repeat(64), requestID: Permission.ID.make("per_stale") }
                : {
                    type: "guardrail",
                    action: "shell",
                    resources: ["git push --force"],
                    ruleIDs: ["standard.review.git-force-push"],
                    reason: "Force push",
                    hardReview: true,
                    directories: [],
                    fingerprint: "b".repeat(64),
                    requestID: Guardrail.RequestID.make("grq_stale"),
                  },
        })
      const permission = yield* open(root.id, "permission")
      const guardrail = yield* open(root.id, "guardrail")
      const childQuestion = yield* open(child.id, "question")

      yield* session.prompt({ sessionID: root.id, text: directive })
      const newer = yield* open(root.id, "question")

      const remaining = (yield* reviews.list(root.id)).map((item) => item.itemID).toSorted()
      expect(remaining).toEqual([permission.itemID, guardrail.itemID, childQuestion.itemID, newer.itemID].toSorted())
      expect(count(SessionEvent.Review.Withdrawn.type)).toBe(1)
      expect(count(SessionEvent.Review.Decided.type)).toBe(0)
      expect(count(Form.Event.Replied.type)).toBe(0)
      const conflict = yield* reviews
        .decide({ sessionID: root.id, itemID: deferred.itemID, decision: { kind: "question", answers: { q0: "RES-1" } } })
        .pipe(Effect.flip)
      expect(conflict).toBeInstanceOf(SessionReview.ConflictError)
    }),
  )

  it.live("leaves earlier question reviews open when YOLO is off", () =>
    Effect.gen(function* () {
      const { session, root, count } = yield* setup({ yolo: false })
      const reviews = yield* SessionReview.Service
      const kept = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "disabled", origin: { requestID: "req_question" }, limit: 16, payload: formPayload })

      yield* session.prompt({ sessionID: root.id, text: directive })

      expect((yield* reviews.list(root.id)).map((item) => item.itemID)).toEqual([kept.itemID])
      expect(count(SessionEvent.Review.Withdrawn.type)).toBe(0)
    }),
  )
})

describe("concurrent admission of the same message ID", () => {
  const race = Effect.fnUntraced(function* () {
    const setupResult = yield* setup()
    const reached = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() }
    const release = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() }
    resolving = (uri) => {
      const key = uri === attachmentURI(digestA) ? "a" : "b"
      return Deferred.succeed(reached[key], undefined).pipe(Effect.andThen(Deferred.await(release[key])))
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => void (resolving = () => Effect.void)))
    const id = SessionMessage.ID.create()
    const prompt = (digest: string) =>
      setupResult.session.prompt({ id, sessionID: setupResult.root.id, text: directive, files: [{ uri: attachmentURI(digest) }] })
    const a = yield* prompt(digestA).pipe(Effect.forkScoped)
    const b = yield* prompt(digestB).pipe(Effect.forkScoped)
    yield* Deferred.await(reached.a)
    yield* Deferred.await(reached.b)
    return { ...setupResult, a, b, release, id }
  })

  it.live("only the winning prompt supersedes waits and a later wait survives the loser", () =>
    Effect.gen(function* () {
      const { session, root, forms, count, arrived, a, b, release } = yield* race()
      const firstCreated = yield* arrived(Form.Event.Created.type)
      const obsolete = yield* askForm(forms, root.id, "Obsolete").pipe(Effect.forkScoped)
      yield* firstCreated

      yield* Deferred.succeed(release.a, undefined)
      const winner = yield* Fiber.join(a)
      expect(yield* Fiber.join(obsolete)).toEqual({ status: "cancelled" })
      const laterCreated = yield* arrived(Form.Event.Created.type, 2)
      const later = yield* askForm(forms, root.id, "Later").pipe(Effect.forkScoped)
      yield* laterCreated

      yield* Deferred.succeed(release.b, undefined)
      const loser = yield* Fiber.join(b)

      expect(loser).toEqual(winner)
      expect(count(Form.Event.Cancelled.type)).toBe(1)
      expect(yield* forms.list({ sessionID: root.id })).toHaveLength(1)
      expect(yield* session.pending(root.id)).toHaveLength(1)
      yield* Fiber.interrupt(later)
    }),
  )

  it.live("the losing prompt does not wake a sleeping family", () =>
    Effect.gen(function* () {
      const { session, root, a, b, release } = yield* race()
      yield* Deferred.succeed(release.a, undefined)
      yield* Fiber.join(a)
      yield* session.autonomy.set({ sessionID: root.id, sleep: true })

      yield* Deferred.succeed(release.b, undefined)
      yield* Fiber.join(b)

      expect((yield* session.autonomy.get(root.id)).sleep).toBeDefined()
    }),
  )
})

describe("input that is not a fresh human steer", () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly options: { readonly delivery?: "queue"; readonly origin?: "subagent" | "plugin" | "review"; readonly resume?: false }
  }> = [
    { name: "queued delivery", options: { delivery: "queue" } },
    { name: "subagent origin", options: { origin: "subagent" } },
    { name: "plugin origin", options: { origin: "plugin" } },
    { name: "review origin", options: { origin: "review" } },
    { name: "admit-only", options: { resume: false } },
  ]
  for (const item of cases) {
    it.live(`${item.name} leaves a paused wait pending`, () =>
      Effect.gen(function* () {
        const { session, root, forms, count, arrived } = yield* setup()
        const created = yield* arrived(Form.Event.Created.type)
        const waiting = yield* askForm(forms, root.id).pipe(Effect.forkScoped)
        yield* created

        yield* session.prompt({ sessionID: root.id, text: directive, ...item.options })

        expect(count(Form.Event.Cancelled.type)).toBe(0)
        expect(yield* forms.list({ sessionID: root.id })).toHaveLength(1)
        yield* Fiber.interrupt(waiting)
      }),
    )
  }

  it.live("a reused message ID leaves a paused wait pending", () =>
    Effect.gen(function* () {
      const { session, root, forms, count, arrived } = yield* setup()
      const id = SessionMessage.ID.create()
      const first = yield* session.prompt({ id, sessionID: root.id, text: directive, resume: false })
      const created = yield* arrived(Form.Event.Created.type)
      const waiting = yield* askForm(forms, root.id).pipe(Effect.forkScoped)
      yield* created

      const reused = yield* session.prompt({ id, sessionID: root.id, text: directive })

      expect(reused).toEqual(first)
      expect(count(Form.Event.Cancelled.type)).toBe(0)
      expect(yield* forms.list({ sessionID: root.id })).toHaveLength(1)
      yield* Fiber.interrupt(waiting)
    }),
  )
})

describe("trusted input origin", () => {
  it.live("stamps new durable admissions with the runtime origin and overrides caller metadata", () =>
    Effect.gen(function* () {
      const { session, root } = yield* setup({ yolo: false })
      const forged = { inputOrigin: "plugin", source: "api" }
      const human = yield* session.prompt({ sessionID: root.id, text: "one", resume: false, metadata: forged })
      const bare = yield* session.prompt({ sessionID: root.id, text: "two", resume: false })
      const delegated = yield* session.prompt({ sessionID: root.id, text: "three", resume: false, origin: "subagent", metadata: { inputOrigin: "human" } })
      const reviewed = yield* session.prompt({ sessionID: root.id, text: "four", resume: false, origin: "review" })

      expect(human.data.metadata).toEqual({ inputOrigin: "human", source: "api" })
      expect(bare.data.metadata).toEqual({ inputOrigin: "human" })
      expect(delegated.data.metadata).toEqual({ inputOrigin: "subagent" })
      expect(reviewed.data.metadata).toEqual({ inputOrigin: "review" })
      const { db } = yield* Database.Service
      const stored = yield* SessionPending.find(db, human.id)
      expect(stored?.type === "user" ? stored.data.metadata : undefined).toEqual({ inputOrigin: "human", source: "api" })
    }),
  )
})
