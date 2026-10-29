import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Statement } from "effect/unstable/sql"
import { Database } from "@ycoding-ai/core/database/database"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionErrors } from "@ycoding-ai/core/session/error"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { InstructionStateTable, SessionPendingTable, SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { Agent } from "@ycoding-ai/core/agent"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_live_state")

testEffect(Layer.empty).effect("goal reminders resolve routine choices without manufacturing human approval or waiting loops", () => Effect.sync(() => {
  const goal = SessionAutonomy.makeGoal({ text: "Verify the local changes" })
  for (const autoAnswer of [true, false]) {
    const text = SessionLiveState.goalReminder({ mode: "normal", permissions: "manual", guardrails: "manual", goal, answers: autoAnswer ? "auto" : "manual" })
    expect(text).toContain("Complete the active goal")
    expect(text).toContain(autoAnswer ? "This Session's effective answers mode is Auto" : "This Session's effective answers mode is Manual")
    expect(text).toContain("Each autonomy category (permissions, guardrails, answers) uses its own decision mode.")
    expect(text).toContain("The autonomy modes above are effective")
    expect(text).toContain("Do not repeat an automatic waiting answer")
    expect(text).toContain("required explicit decisions")
    expect(text).toContain("Goals do not override these gates")
  }
}))

testEffect(Layer.empty).effect("sleep state never claims lid control when only idle sleep is inhibited", () =>
  Effect.sync(() => {
    const state = { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", sleep: {} } as const
    expect(SessionLiveState.sleepReminder(state, true, false)).toContain(
      "lid-closed keep-awake is unavailable or unreported",
    )
    expect(SessionLiveState.sleepReminder(state, true, false)).not.toContain("holds idle and lid-closed sleep off")
    expect(SessionLiveState.sleepReminder(state, false, false)).toContain("battery")
    expect(SessionLiveState.sleepReminder(state, true, true)).toContain("holds idle and lid-closed sleep off")
  }),
)
const guardrailDigest = "a".repeat(64)
const guardrails = Layer.succeed(
  SessionGuardrail.Service,
  SessionGuardrail.Service.of({
    reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
    evaluate: () => Effect.die("unused"),
    assert: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    replyDelegated: () => Effect.die("unused"),
    delegatedEligible: () => Effect.die("unused"),
    requestSnapshot: () => Effect.die("unused"),
    requestSnapshots: () => Effect.die("unused"),
    reconsider: () => Effect.die("unused"),
    escalate: () => Effect.die("unused"),
    deferPending: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
    status: () => Effect.die("unused"),
    snapshot: () => Effect.succeed({ sequence: 4, digest: guardrailDigest }),
    withSnapshot: (_sessionID, use) => use({ sequence: 4, digest: guardrailDigest }),
  }),
)
const keepAwake = Layer.mock(KeepAwake.Service, {
  get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
})
const it = testEffect(
  SessionLiveState.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Database.layer({ path: ":memory:" }), guardrails, keepAwake)),
  ),
)

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Live state" })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 20 }).run().pipe(Effect.orDie)
  yield* db
    .insert(EventTable)
    .values({
      id: EventRuntime.ID.make("evt_created"),
      aggregate_id: sessionID,
      seq: 20,
      created: 1,
      type: EventRuntime.versionedType(SessionEvent.Created.type, SessionEvent.Created.durable.version),
      data: {},
    })
    .run()
    .pipe(Effect.orDie)
})

it.effect("renders canonical protected state and returns every required content-free source", () =>
  Effect.gen(function* () {
    yield* seed
    const snapshot = yield* SessionLiveState.Service.pipe(Effect.flatMap((service) => service.load(sessionID)))

    expect(snapshot.rendered).toMatchObject({
      role: "system",
      volatile: true,
      content: [
        {
          type: "text",
          text: 'Authoritative current Session state (JSON):\n{"autonomy":{"answers":"manual","guardrails":"manual","mode":"normal","permissions":"manual"},"permissionCeiling":[],"todos":[]}',
        },
      ],
    })
    expect(Object.keys(snapshot.sources).toSorted()).toEqual([
      "autonomy",
      "goal",
      "guardrails",
      "instructions",
      "orchestration",
      "pending_work",
      "permissions",
      "todos",
    ])
    expect(snapshot.sources.guardrails).toEqual({ sequence: 4, digest: guardrailDigest })
    expect(snapshot.sources.permissions.sequence).toBe(20)
    expect(JSON.stringify(snapshot.sources)).not.toContain("content")
    const protectedState = SessionLiveState.toProtectedState(snapshot.sources)
    expect(protectedState.map((entry) => entry.source)).toEqual([
      "instructions",
      "todos",
      "goal",
      "autonomy",
      "permissions",
      "guardrails",
      "pending_work",
      "orchestration",
    ])
    expect(protectedState.find((entry) => entry.source === "permissions")).toEqual({
      source: "permissions",
      revision: 20,
      digest: snapshot.sources.permissions.digest,
    })
  }),
)

it.effect("recaptures database authorities from the caller transaction", () =>
  Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const initial = yield* db.transaction((tx) => SessionLiveState.captureDatabase(tx, sessionID))
    const captured = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .update(EventSequenceTable)
          .set({ seq: 21 })
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .run()
        yield* tx
          .insert(SessionPendingTable)
          .values({
            id: SessionMessage.ID.make("msg_transaction_pending"),
            session_id: sessionID,
            type: "user",
            data: { text: "transaction-local secret" },
            delivery: "queue",
            admitted_seq: 21,
            time_created: 21,
          })
          .run()
        yield* tx
          .insert(EventTable)
          .values({
            id: EventRuntime.ID.make("evt_transaction_admitted"),
            aggregate_id: sessionID,
            seq: 21,
            created: 21,
            type: EventRuntime.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version),
            data: {},
          })
          .run()
        return yield* SessionLiveState.captureDatabase(tx, sessionID)
      }),
    )

    expect("guardrails" in captured.sources).toBe(false)
    expect(captured.sources.pending_work.sequence).toBe(21)
    expect(captured.sources.pending_work.digest).not.toBe(initial.sources.pending_work.digest)
    expect(SessionLiveState.toDatabaseProtectedState(captured.sources).map((entry) => entry.source)).toEqual([
      "instructions",
      "todos",
      "goal",
      "autonomy",
      "permissions",
      "pending_work",
      "orchestration",
    ])
    expect(JSON.stringify(captured)).not.toContain("transaction-local secret")
  }),
)

it.effect("uses source-owned sequence fences across protected-state ABA transitions", () =>
  Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const service = yield* SessionLiveState.Service
    const initial = yield* service.load(sessionID)
    yield* db
      .insert(EventTable)
      .values({
        id: EventRuntime.ID.make("evt_irrelevant"),
        aggregate_id: sessionID,
        seq: 1,
        created: 1,
        type: EventRuntime.versionedType(SessionEvent.Renamed.type, SessionEvent.Renamed.durable.version),
        data: {},
      })
      .run()
      .pipe(Effect.orDie)
    expect((yield* service.load(sessionID)).sources).toMatchObject({
      instructions: initial.sources.instructions,
      pending_work: initial.sources.pending_work,
    })

    yield* db
      .run(
        `INSERT INTO instruction_state (session_id, epoch_start, through_seq, initial_values, current_values) VALUES ('${sessionID}', 2, 2, '{"z":"${"b".repeat(64)}","a":"${"c".repeat(64)}"}', '{"z":"${"b".repeat(64)}","a":"${"c".repeat(64)}"}')`,
      )
      .pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values({
        id: EventRuntime.ID.make("evt_instruction"),
        aggregate_id: sessionID,
        seq: 2,
        created: 2,
        type: EventRuntime.versionedType(
          SessionEvent.InstructionsUpdated.type,
          SessionEvent.InstructionsUpdated.durable.version,
        ),
        data: {},
      })
      .run()
      .pipe(Effect.orDie)
    const instructed = yield* service.load(sessionID)
    expect(instructed.sources.instructions.sequence).toBe(2)
    expect(instructed.sources.instructions.digest).not.toBe(initial.sources.instructions.digest)
    yield* db.delete(InstructionStateTable).run().pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values({
        id: EventRuntime.ID.make("evt_moved"),
        aggregate_id: sessionID,
        seq: 3,
        created: 3,
        type: EventRuntime.versionedType(SessionEvent.Moved.type, SessionEvent.Moved.durable.version),
        data: {},
      })
      .run()
      .pipe(Effect.orDie)
    expect((yield* service.load(sessionID)).sources.instructions).toEqual({
      sequence: 3,
      digest: initial.sources.instructions.digest,
    })

    yield* db
      .insert(SessionPendingTable)
      .values({
        id: SessionMessage.ID.make("msg_live_state_pending"),
        session_id: sessionID,
        type: "user",
        data: { text: "must remain private" },
        delivery: "queue",
        admitted_seq: 4,
        time_created: 4,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values({
        id: EventRuntime.ID.make("evt_admitted"),
        aggregate_id: sessionID,
        seq: 4,
        created: 4,
        type: EventRuntime.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version),
        data: {},
      })
      .run()
      .pipe(Effect.orDie)
    const admitted = yield* service.load(sessionID)
    expect(admitted.sources.pending_work.sequence).toBe(4)
    expect(JSON.stringify(admitted)).not.toContain("must remain private")
    yield* db.delete(SessionPendingTable).run().pipe(Effect.orDie)
    yield* db
      .insert(EventTable)
      .values({
        id: EventRuntime.ID.make("evt_promoted"),
        aggregate_id: sessionID,
        seq: 5,
        created: 5,
        type: EventRuntime.versionedType(SessionEvent.InputPromoted.type, SessionEvent.InputPromoted.durable.version),
        data: {},
      })
      .run()
      .pipe(Effect.orDie)
    expect((yield* service.load(sessionID)).sources.pending_work).toEqual({
      sequence: 5,
      digest: initial.sources.pending_work.digest,
    })

    expect("project_artifacts" in (yield* service.load(sessionID)).sources).toBe(false)
  }),
)

it.effect("bounds latest protected-state sequence probes to one database row", () =>
  Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const types = [SessionEvent.InstructionsUpdated, SessionEvent.InputAdmitted, SessionEvent.Forked]
    yield* db
      .insert(EventTable)
      .values(
        types.flatMap((event, source) =>
          Array.from({ length: 40 }, (_, index) => ({
            id: EventRuntime.ID.make(`evt_probe_${source}_${index}`),
            aggregate_id: sessionID,
            seq: 21 + source * 40 + index,
            created: index,
            type: EventRuntime.versionedType(event.type, event.durable.version),
            data: {},
          })),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    const queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []
    const captured = yield* SessionLiveState.captureDatabase(db, sessionID).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          const [sql, params] = statement.compile()
          if (sql.includes('from "event"')) queries.push({ sql, params })
          return statement
        }),
      ),
    )
    expect(captured.sources.instructions.sequence).toBe(60)
    expect(captured.sources.pending_work.sequence).toBe(100)
    expect(captured.sources.permissions.sequence).toBe(140)
    expect(queries).toHaveLength(3)
    for (const query of queries) {
      expect(query.sql).toContain('order by "event"."seq" desc limit ?')
      expect(query.params.at(-1)).toBe(1)
    }
  }),
)

it.effect("model-facing autonomy reports inherited effective modes, not the child's local Manual", () =>
  Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const childID = Session.ID.make("ses_live_state_child")
    yield* db
      .update(SessionTable)
      .set({ autonomy: { mode: "normal", permissions: "auto", guardrails: "yolo", answers: "yolo" } })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: childID, project_id: Project.ID.global, directory: "/project", title: "Child", parent_id: sessionID })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTaskTable)
      .values({
        session_id: childID,
        parent_id: sessionID,
        parent_assistant_message_id: SessionMessage.ID.make("msg_live_state_parent"),
        tool_call_id: "call_live_state_child",
        input_id: SessionMessage.ID.make("msg_live_state_input"),
        description: "child",
        agent: Agent.ID.make("build"),
        model: CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("gpt-5.6") }),
        prompt_digest: "digest",
        background: true,
        delivery: "steer",
        state: "running",
        revision: 1,
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    const captured = yield* db.transaction((tx) => SessionLiveState.captureDatabase(tx, childID))
    expect(captured.autonomy).toMatchObject({ permissions: "auto", guardrails: "yolo", answers: "yolo" })
    const service = yield* SessionLiveState.Service
    expect((yield* service.load(childID)).text).toContain('"answers":"yolo","guardrails":"yolo","mode":"normal","permissions":"auto"')
  }),
)

it.effect("returns the tagged missing-session error", () =>
  Effect.gen(function* () {
    const service = yield* SessionLiveState.Service
    expect(yield* service.load(Session.ID.make("ses_missing_live_state")).pipe(Effect.flip)).toBeInstanceOf(
      SessionErrors.NotFoundError,
    )
  }),
)
