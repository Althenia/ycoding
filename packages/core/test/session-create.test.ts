import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Money } from "@ycoding-ai/schema/money"
import { Agent } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { asc, eq } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Workspace } from "@ycoding-ai/core/workspace"
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
const it = testEffect(
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
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const id = Session.ID.create()

/** Public session events from a `log` read, without synced markers. */
const logEvents = (session: Session.Interface, sessionID: Session.ID, follow?: boolean) =>
  session
    .log({ sessionID, follow })
    .pipe(Stream.filter((item): item is SessionEvent.PublicDurableEvent => !EventRuntime.isSynced(item)))

const assertCreateInputTypes = (session: Session.Interface) => {
  // @ts-expect-error location or parentID is required.
  session.create({})
  // @ts-expect-error child sessions inherit their parent's location.
  session.create({ parentID: Session.ID.create(), location })
}
void assertCreateInputTypes

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

describe("Session.create", () => {
  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect((yield* session.list()).data).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect((yield* session.list()).data).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const workspaceID = Workspace.ID.make("wrk_test")
      const model = CatalogModel.Ref.make({
        id: CatalogModel.ID.make("sonnet"),
        providerID: Provider.ID.anthropic,
        variant: CatalogModel.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: Agent.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("rejects creation with the internal decision helper before projecting a Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const store = yield* SessionStore.Service
      const database = yield* Database.Service
      const sessionID = Session.ID.create()

      expect(yield* session.create({ id: sessionID, location, agent: Agent.ID.make("decision") }).pipe(Effect.flip))
        .toMatchObject({ _tag: "Session.AgentNotSelectableError", agent: "decision" })
      expect(yield* store.get(sessionID)).toBeUndefined()
      expect((yield* session.list()).data).toEqual([])
      expect(yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
        .pipe(Effect.orDie)).toEqual([])
    }),
  )

  it.effect("adopts an existing Session before validating a retried decision-helper selection", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location, agent: Agent.ID.make("custom-reviewer") })

      expect(yield* session.create({ id: created.id, location, agent: Agent.ID.make("decision") })).toEqual(created)
      expect(Array.from(yield* Stream.runCollect(logEvents(session, created.id)))).toHaveLength(1)
    }),
  )

  it.effect("preserves creation with historical hidden helpers and custom agents", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service

      for (const id of ["title", "custom-reviewer"]) {
        const created = yield* session.create({ location, agent: Agent.ID.make(id) })
        expect(created.agent).toBe(Agent.ID.make(id))
        expect((yield* session.get(created.id)).agent).toBe(Agent.ID.make(id))
      }
    }),
  )

  it.effect("persists only deny rules in the session permission ceiling", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const deny = { action: "shell", resource: "*", effect: "deny" as const }

      const created = yield* session.create({
        location,
        permissionCeiling: [
          { action: "read", resource: "*", effect: "allow" },
          deny,
          deny,
        ],
      })

      expect(created.permissionCeiling).toEqual([deny])
      expect((yield* session.get(created.id)).permissionCeiling).toEqual([deny])
    }),
  )

  it.effect("inherits location from an existing parent when omitted", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ parentID: parent.id, title: "child" })

      expect(child).toMatchObject({ parentID: parent.id, location })
    }),
  )

  for (const scenario of [
    { name: "a child inherits the parent Daybreak selection", derive: "child", parentDaybreak: true, expected: "daybreak_blue" },
    { name: "a child stays without Daybreak when the parent has none", derive: "child", parentDaybreak: false, expected: undefined },
    { name: "a fork drops the parent Daybreak selection", derive: "fork", parentDaybreak: true, expected: undefined },
  ] as const)
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const parent = yield* session.create({ location, title: "parent" })
        if (scenario.parentDaybreak) yield* session.daybreak.set({ sessionID: parent.id, daybreak: "daybreak_blue" })

        const derived =
          scenario.derive === "child"
            ? yield* session.create({ parentID: parent.id, title: "child" })
            : yield* session.fork({ sessionID: parent.id })

        expect(derived.daybreak).toBe(scenario.expected)
        expect((yield* session.get(derived.id)).daybreak).toBe(scenario.expected)
      }),
    )

  it.effect("does not let child creation drop the parent permission ceiling", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const inherited = { action: "shell", resource: "*", effect: "deny" as const }
      const added = { action: "read", resource: "/secret/*", effect: "deny" as const }
      const parent = yield* session.create({ location, permissionCeiling: [inherited] })

      const child = yield* session.create({
        parentID: parent.id,
        title: "child",
        permissionCeiling: [
          { action: "shell", resource: "*", effect: "allow" },
          added,
        ],
      })

      expect(child.permissionCeiling).toEqual([inherited, added])
    }),
  )

  it.effect("rejects child creation when the parent does not exist", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const missing = Session.ID.create()

      expect(yield* Effect.flip(session.create({ parentID: missing, title: "child" }))).toEqual(
        new Session.NotFoundError({ sessionID: missing }),
      )
    }),
  )

  it.effect("filters root sessions before applying the page limit", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const staleRoot = yield* session.create({ location, title: "stale root" })
      const root = yield* session.create({ location, title: "root" })
      const children = yield* Effect.forEach(Array.from({ length: 60 }), (_, index) =>
        session.create({ parentID: root.id, title: `child ${index}` }),
      )

      yield* Effect.forEach(children, (item, index) =>
        db
          .update(SessionTable)
          .set({ time_created: index + 100, time_updated: index + 20_000 })
          .where(eq(SessionTable.id, item.id))
          .run(),
      )
      yield* db
        .update(SessionTable)
        .set({ time_created: 2, time_updated: 5_000 })
        .where(eq(SessionTable.id, staleRoot.id))
        .run()
      yield* db
        .update(SessionTable)
        .set({ time_created: 1, time_updated: 10_000 })
        .where(eq(SessionTable.id, root.id))
        .run()

      const page = yield* session.list({ directory: location.directory, parentID: null, limit: 1, order: "desc" })

      expect(page.data.map((item) => item.id)).toEqual([root.id])
    }),
  )

  it.effect("filters direct child sessions by parent ID", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ location, title: "parent" })
      const child = yield* session.create({ parentID: parent.id, title: "child" })
      yield* session.create({ location, title: "other root" })

      const page = yield* session.list({ parentID: parent.id })

      expect(page.data.map((item) => item.id)).toEqual([child.id])
    }),
  )

  it.effect("preserves the permission ceiling when forking", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const deny = { action: "shell", resource: "*", effect: "deny" as const }
      const parent = yield* session.create({ location, permissionCeiling: [deny] })

      const fork = yield* session.fork({ sessionID: parent.id })

      expect(fork.permissionCeiling).toEqual([deny])
    }),
  )

  it.effect("forks a session by replaying a durable fork event into copied projected rows", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location, title: "Parent" })
      const admitted = yield* session.prompt({
        sessionID: parent.id,
        text: "First",
        resume: false,
      })
      yield* SessionPending.promoteSteers(db, events, parent.id)
      yield* session.synthetic({ sessionID: parent.id, text: "parent note", resume: false })
      yield* SessionPending.promoteSteers(db, events, parent.id)

      const forked = yield* session.fork({ sessionID: parent.id })
      const parentContext = yield* session.context(parent.id)
      const forkContext = yield* session.context(forked.id)
      const history = Array.from(yield* Stream.runCollect(logEvents(session, forked.id)))

      expect(forked).toMatchObject({ title: "Parent (fork #1)", fork: { sessionID: parent.id } })
      expect(forked.parentID).toBeUndefined()
      expect(forkContext).toMatchObject([
        { type: "user", text: "First" },
        { type: "synthetic", text: "parent note" },
      ])
      expect(forkContext.map((message) => message.id)).not.toEqual(parentContext.map((message) => message.id))
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        type: "session.forked",
        durable: { seq: 0 },
        data: { sessionID: forked.id, parentID: parent.id },
      })
      expect(yield* SessionPending.find(db, forkContext[0].id)).toBeUndefined()
      expect(yield* SessionPending.find(db, forkContext[1].id)).toBeUndefined()
      // Fork-copied messages have no admitted event in the fork aggregate, so
      // reusing their IDs as prompt IDs is conflicting reuse, not a retry.
      expect(
        yield* session
          .prompt({ id: forkContext[0].id, sessionID: forked.id, text: "First", resume: false })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "Session.PromptConflictError", messageID: forkContext[0].id })

      yield* session.prompt({
        sessionID: parent.id,
        text: "Parent changed",
        resume: false,
      })
      yield* SessionPending.promoteSteers(db, events, parent.id)
      yield* session.prompt({
        sessionID: forked.id,
        text: "Child continues",
        resume: false,
      })
      yield* SessionPending.promoteSteers(db, events, forked.id)

      expect((yield* session.context(parent.id)).map((message) => message.type)).toEqual(["user", "synthetic", "user"])
      expect((yield* session.context(forked.id)).map((message) => message.type)).toEqual(["user", "synthetic", "user"])
      expect((yield* session.context(forked.id)).at(-1)).toMatchObject({ text: "Child continues" })
      expect(
        Array.from(yield* Stream.runCollect(logEvents(session, forked.id))).map(
          (event): number | undefined => event.durable?.seq,
        ),
      ).toEqual([0, 5, 6])
      expect(yield* SessionPending.find(db, admitted.id)).toBeUndefined()
    }),
  )

  it.effect("forks before the selected boundary message", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      const first = yield* session.prompt({
        sessionID: parent.id,
        text: "First",
        resume: false,
      })
      yield* SessionPending.promoteSteers(db, events, parent.id)
      const second = yield* session.prompt({
        sessionID: parent.id,
        text: "Second",
        resume: false,
      })
      yield* SessionPending.promoteSteers(db, events, parent.id)
      const assistantMessageID = SessionMessage.ID.create()
      const model = CatalogModel.Ref.make({ id: CatalogModel.ID.make("model"), providerID: Provider.ID.make("provider") })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: parent.id,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: parent.id,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.make(0.75),
        tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
      })

      const forked = yield* session.fork({ sessionID: parent.id, messageID: second.id })
      const beforeFirst = yield* session.fork({ sessionID: parent.id, messageID: first.id })
      const complete = yield* session.fork({ sessionID: parent.id })

      const context = yield* session.context(forked.id)
      const history = Array.from(yield* Stream.runCollect(logEvents(session, forked.id)))
      expect(forked.fork).toEqual({ sessionID: parent.id, messageID: second.id })
      expect(context).toMatchObject([{ text: "First" }])
      expect(context[0]?.id).not.toBe(first.id)
      expect(history[0]).toMatchObject({ data: { from: second.id } })
      expect(forked).toMatchObject({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0 } })
      expect(yield* session.context(beforeFirst.id)).toEqual([])
      expect(beforeFirst).toMatchObject({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0 } })
      expect(complete).toMatchObject({
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: Agent.ID.make("build") },
        {
          id,
          location,
          model: CatalogModel.Ref.make({ id: CatalogModel.ID.make("sonnet"), providerID: Provider.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect((yield* session.list()).data).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect((yield* session.list()).data).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID: id,
        agent: Agent.ID.make("build"),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build" })
    }),
  )

  for (const scenario of [{ name: "generated ID", input: { location } }, { name: "caller ID", input: { id, location } }])
    it.effect(`persists ${scenario.name} creation through the current created event`, () =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const { db } = yield* Database.Service
        const created = yield* session.create(scenario.input)

        expect(
          yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
        ).toMatchObject([{ type: EventRuntime.versionedType(SessionEvent.Created.type, 2), data: { sessionID: created.id } }])
      }),
    )

  it.effect("includes current creation rows in the Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({
        sessionID: created.id,
        text: "Hello",
        resume: false,
      })
      yield* SessionPending.promoteSteers(db, events, created.id)

      expect(
        Array.from(yield* logEvents(session, created.id, true).pipe(Stream.take(3), Stream.runCollect)),
      ).toMatchObject([
        {
          durable: { seq: 0, version: 2 },
          type: "session.created",
          data: { projectID: Project.ID.global, location, title: expect.any(String) },
        },
        {
          durable: { seq: 1 },
          type: "session.input.admitted",
          data: { input: { type: "user", data: { text: "Hello" }, delivery: "steer" } },
        },
        { durable: { seq: 2 }, type: "session.input.promoted" },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sourceEvents = yield* EventRuntime.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: Session.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        text: "Replay lifecycle",
        resume: false,
      })
      yield* SessionPending.promoteSteers(sourceDb, sourceEvents, created.id)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        created: DateTime.makeUnsafe(event.created),
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layer({ path: path.join(tmp.path, "target.sqlite") })
      const targetLayer = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node]),
        [[Database.node, targetDatabase]],
      )

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventRuntime.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionPending.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          type: "user",
          data: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionPending.find(db, admitted.id)).toBeUndefined()
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventRuntime.versionedType(SessionEvent.Created.type, 2)],
          [1, EventRuntime.versionedType(SessionEvent.InputAdmitted.type, 1)],
          [2, EventRuntime.versionedType(SessionEvent.InputPromoted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(targetLayer)))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const event = yield* EventRuntime.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionEvent.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.live("runs a shell command and projects the started/ended shell message", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })

        yield* session.shell({ sessionID: created.id, command: "echo hello" })

        const messages = yield* session.messages({ sessionID: created.id, order: "asc" })
        const shell = messages.find((message): message is SessionMessage.Shell => message.type === "shell")
        expect(shell).toMatchObject({ type: "shell", command: "echo hello", status: "exited", exit: 0 })
        expect(shell?.output?.output).toContain("hello")
        expect(shell?.output?.truncated).toBe(false)
        expect(shell?.time.completed).toBeDefined()
      }),
    ),
  )

  it.live("records the owning Session on the started shell info", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })

        yield* session.shell({ sessionID: created.id, command: "echo owned" })

        const started = Array.from(yield* Stream.runCollect(logEvents(session, created.id))).filter(
          (event) => event.type === "session.shell.started",
        )
        expect(started).toHaveLength(1)
        expect(started).toMatchObject([
          {
            type: "session.shell.started",
            data: { sessionID: created.id, shell: { metadata: { sessionID: created.id } } },
          },
        ])
      }),
    ),
  )

  it.live("rejects catastrophic direct shell commands before process creation", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })

        expect(
          yield* session.shell({ sessionID: created.id, command: "rm -rf /" }).pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
        ).toBe("Guardrail.BlockedError")
        expect(yield* session.messages({ sessionID: created.id, order: "asc" })).toEqual([])
      }),
    ),
  )

  it.live("fails direct shell execution when sandboxing is required but unavailable", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(path.join(directory, "ycoding.json"), JSON.stringify({ shell_sandbox: "required" })),
        )
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })

        expect(
          yield* session.shell({ sessionID: created.id, command: "echo hello" }).pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
        ).toBe("ShellSandbox.Unavailable")
        expect(yield* session.messages({ sessionID: created.id, order: "asc" })).toEqual([])
      }),
    ),
  )

  it.live("projects optional sandbox fallback warnings for the TUI", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(path.join(directory, "ycoding.json"), JSON.stringify({ shell: "/bin/sh", shell_sandbox: "optional" })),
        )
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })

        yield* session.shell({ sessionID: created.id, command: "echo hello" })

        const messages = yield* session.messages({ sessionID: created.id, order: "asc" })
        const shell = messages.find((message): message is SessionMessage.Shell => message.type === "shell")
        expect(shell?.metadata?.sandboxWarnings).toEqual([
          "No enforceable shell sandbox backend was available; command ran with host-user filesystem, process, and network authority.",
        ])
      }),
    ),
  )

  it.live("still emits shell ended for a failing command", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })

        yield* session.shell({ sessionID: created.id, command: "false" })

        const messages = yield* session.messages({ sessionID: created.id, order: "asc" })
        const shell = messages.find((message): message is SessionMessage.Shell => message.type === "shell")
        expect(shell).toMatchObject({ type: "shell", command: "false", status: "exited" })
        expect(shell?.exit).not.toBe(0)
        expect(shell?.time.completed).toBeDefined()
      }),
    ),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("plan") })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(
        Array.from(
          yield* logEvents(session, created.id, true).pipe(Stream.drop(1), Stream.take(1), Stream.runCollect),
        ),
      ).toMatchObject([{ type: "session.agent.selected", data: { agent: "plan" } }])
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const missing = Session.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: Agent.ID.make("plan") }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("rejects switching to the internal decision helper without a selection event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location, agent: Agent.ID.make("custom-reviewer") })

      expect(yield* session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("decision") }).pipe(Effect.flip))
        .toMatchObject({ _tag: "Session.AgentNotSelectableError", agent: "decision" })
      expect(yield* session.get(created.id)).toEqual(created)
      expect(Array.from(yield* Stream.runCollect(logEvents(session, created.id)))).toHaveLength(1)
      expect(yield* session.pending(created.id)).toEqual([])
    }),
  )

  it.effect("preserves switching to historical hidden helpers", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: Agent.ID.make("title") })
      expect((yield* session.get(created.id)).agent).toBe(Agent.ID.make("title"))
      expect(Array.from(yield* Stream.runCollect(logEvents(session, created.id)))).toMatchObject([
        { type: "session.created" },
        { type: "session.agent.selected", data: { agent: "title" } },
      ])
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
        const model = CatalogModel.Ref.make({
          id: CatalogModel.ID.make("sonnet"),
          providerID: Provider.ID.anthropic,
          variant: CatalogModel.VariantID.make("high"),
        })
        yield* Catalog.Service.use((catalog) =>
          catalog.transform((editor) => {
            editor.provider.update(model.providerID, (provider) => {
              provider.package = Provider.aisdk("@ai-sdk/anthropic")
            })
            editor.model.update(model.providerID, model.id, (entry) => {
              entry.limit = { context: 128_000, output: 16_384 }
              entry.variants = [{ id: CatalogModel.VariantID.make("high") }]
            })
          }),
        ).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))

        expect(yield* session.switchModel({ sessionID: created.id, model })).toEqual({ status: "switched" })

        expect(yield* session.get(created.id)).toMatchObject({ model })
        const events = Array.from(
          yield* logEvents(session, created.id, true).pipe(Stream.drop(1), Stream.take(1), Stream.runCollect),
        )
        expect(events).toMatchObject([{ type: "session.model.selected" }])
        expect(events[0]?.data).toEqual({ sessionID: created.id, model })
      }),
    ),
  )

  it.effect("ignores a model switch when the selected model is unchanged", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const model = CatalogModel.Ref.make({ id: CatalogModel.ID.make("sonnet"), providerID: Provider.ID.anthropic })
      const created = yield* session.create({ location, model })

      expect(yield* session.switchModel({ sessionID: created.id, model })).toEqual({ status: "switched" })
      expect(yield* session.switchModel({ sessionID: created.id, model })).toEqual({ status: "switched" })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("treats a variant named default as an ordinary variant", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const base = CatalogModel.Ref.make({ id: CatalogModel.ID.make("sonnet"), providerID: Provider.ID.anthropic })
        const created = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
          model: base,
        })
        yield* Catalog.Service.use((catalog) =>
          catalog.transform((editor) => {
            editor.provider.update(base.providerID, (provider) => {
              provider.package = Provider.aisdk("@ai-sdk/anthropic")
            })
            editor.model.update(base.providerID, base.id, (entry) => {
              entry.limit = { context: 128_000, output: 16_384 }
              entry.variants = [{ id: CatalogModel.VariantID.make("default") }]
            })
          }),
        ).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))

        const selected = CatalogModel.Ref.make({ ...base, variant: CatalogModel.VariantID.make("default") })
        expect(yield* session.switchModel({ sessionID: created.id, model: selected })).toEqual({ status: "switched" })

        expect((yield* session.get(created.id)).model).toEqual(selected)
      }),
    ),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const missing = Session.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: CatalogModel.Ref.make({ id: CatalogModel.ID.make("sonnet"), providerID: Provider.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})
