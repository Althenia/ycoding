import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionErrors } from "@ycoding-ai/core/session/error"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { InstructionStateTable, SessionPendingTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_live_state")
const guardrailDigest = "a".repeat(64)
const guardrails = Layer.succeed(
  SessionGuardrail.Service,
  SessionGuardrail.Service.of({
    evaluate: () => Effect.die("unused"),
    assert: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    status: () => Effect.die("unused"),
    snapshot: () => Effect.succeed({ sequence: 4, digest: guardrailDigest }),
    withSnapshot: (_sessionID, use) => use({ sequence: 4, digest: guardrailDigest }),
  }),
)
const it = testEffect(
  SessionLiveState.layer.pipe(Layer.provideMerge(Layer.merge(Database.layer({ path: ":memory:" }), guardrails))),
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
      id: EventV2.ID.make("evt_created"),
      aggregate_id: sessionID,
      seq: 20,
      created: 1,
      type: EventV2.versionedType(SessionEvent.Created.type, SessionEvent.Created.durable.version),
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
          text: 'Authoritative current Session state (JSON):\n{"autonomy":{"mode":"normal"},"permissionCeiling":[],"todos":[]}',
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
            id: EventV2.ID.make("evt_transaction_admitted"),
            aggregate_id: sessionID,
            seq: 21,
            created: 21,
            type: EventV2.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version),
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
        id: EventV2.ID.make("evt_irrelevant"),
        aggregate_id: sessionID,
        seq: 1,
        created: 1,
        type: EventV2.versionedType(SessionEvent.Renamed.type, SessionEvent.Renamed.durable.version),
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
        id: EventV2.ID.make("evt_instruction"),
        aggregate_id: sessionID,
        seq: 2,
        created: 2,
        type: EventV2.versionedType(
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
        id: EventV2.ID.make("evt_moved"),
        aggregate_id: sessionID,
        seq: 3,
        created: 3,
        type: EventV2.versionedType(SessionEvent.Moved.type, SessionEvent.Moved.durable.version),
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
        id: EventV2.ID.make("evt_admitted"),
        aggregate_id: sessionID,
        seq: 4,
        created: 4,
        type: EventV2.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version),
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
        id: EventV2.ID.make("evt_promoted"),
        aggregate_id: sessionID,
        seq: 5,
        created: 5,
        type: EventV2.versionedType(SessionEvent.InputPromoted.type, SessionEvent.InputPromoted.durable.version),
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

it.effect("returns the tagged missing-session error", () =>
  Effect.gen(function* () {
    const service = yield* SessionLiveState.Service
    expect(yield* service.load(SessionV2.ID.make("ses_missing_live_state")).pipe(Effect.flip)).toBeInstanceOf(
      SessionErrors.NotFoundError,
    )
  }),
)
