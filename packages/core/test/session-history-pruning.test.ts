import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { ContextManifest } from "../src/session/context-manifest"
import { eq, sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { Instructions } from "../src/instructions/index"
import { SessionEvent } from "../src/session/event"
import { SessionSchema } from "../src/session/schema"
import { SessionHistory } from "../src/session/history"
import { SessionMessage } from "../src/session/message"
import { SessionRunCoordinator } from "../src/session/run-coordinator"
import {
  CompactionManifestBlobTable,
  InstructionBlobTable,
  InstructionStateTable,
  SessionContextStateTable,
  SessionProviderRequestTable,
} from "../src/session/sql"
import { historyDatabase, historyFixture } from "./fixture/session-history-pruning"
import { testEffect } from "./lib/effect"

const it = testEffect(EventRuntime.layer.pipe(Layer.provideMerge(historyDatabase)))

it.effect("loads only the checkpoint and later payloads while preserving canonical rows", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db)
    yield* db.run(sql`UPDATE session_message SET data = 'covered invalid JSON' WHERE id = ${fixture.ids[0]}`)
    const history = yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])
    expect(history.entries.map((entry) => entry.message.id)).toEqual([
      SessionMessage.ID.make(`msg_compaction_${fixture.manifestDigest}`),
      ...fixture.tail,
    ])
    expect(history.entries[0].message.type === "synthetic" && history.entries[0].message.text).toContain(
      fixture.summary.text,
    )
    expect(yield* db.get<{ count: number }>("SELECT COUNT(*) AS count FROM session_message")).toEqual({
      count: fixture.count,
    })
    expect(Exit.isFailure(yield* SessionHistory.load(db, fixture.sessionID).pipe(Effect.exit))).toBe(true)
  }),
)

it.effect("does not hide corruption in the selected tail", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db)
    yield* db.run(sql`UPDATE session_message SET data = 'selected invalid JSON' WHERE id = ${fixture.tail[0]}`)
    expect(Exit.isFailure(yield* SessionHistory.entriesForRunner(db, fixture.sessionID, []).pipe(Effect.exit))).toBe(
      true,
    )
  }),
)

for (const invalid of [
  "quarantined",
  "absent",
  "malformed",
  "past-context",
  "missing-anchor",
  "anchor-sequence",
  "anchor-digest",
] as const) {
  it.effect(`retains canonical history for a ${invalid} checkpoint`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const fixture = yield* historyFixture(db)
      if (invalid === "quarantined")
        yield* db
          .update(SessionContextStateTable)
          .set({ status: "quarantined", error_code: "invalid_manifest" })
          .where(eq(SessionContextStateTable.session_id, fixture.sessionID))
          .run()
      if (invalid === "absent")
        yield* db
          .delete(SessionContextStateTable)
          .where(eq(SessionContextStateTable.session_id, fixture.sessionID))
          .run()
      if (invalid !== "quarantined" && invalid !== "absent")
        yield* db
          .update(CompactionManifestBlobTable)
          .set({
            content: {
              summary:
                invalid === "malformed"
                  ? {}
                  : {
                      ...fixture.summary,
                      coveredThrough: {
                        messageID:
                          invalid === "missing-anchor"
                            ? "msg_missing_anchor"
                            : fixture.summary.coveredThrough.messageID,
                        seq:
                          fixture.summary.coveredThrough.seq +
                          (invalid === "past-context" ? 100 : invalid === "anchor-sequence" ? -1 : 0),
                      },
                      digest: invalid === "anchor-digest" ? "a".repeat(64) : fixture.summary.digest,
                    },
            },
          })
          .where(eq(CompactionManifestBlobTable.digest, fixture.manifestDigest))
          .run()
      expect((yield* SessionHistory.forModel(db, fixture.sessionID)).map((message) => message.id)).toEqual(fixture.ids)
      yield* db.run(sql`UPDATE session_message SET data = 'uncovered invalid JSON' WHERE id = ${fixture.ids[0]}`)
      expect(Exit.isFailure(yield* SessionHistory.entriesForRunner(db, fixture.sessionID, []).pipe(Effect.exit))).toBe(
        true,
      )
    }),
  )
}

it.effect("retains chronological instruction updates across the checkpoint epoch", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db)
    const key = Instructions.Key.make("test/history")
    const first = Instructions.hash("first")
    const second = Instructions.hash("second")
    const source = Instructions.make({
      key,
      codec: Schema.String,
      read: Effect.succeed("second"),
      render: { initial: (value) => `Initial ${value}`, changed: (_before, value) => `Update ${value}` },
    })
    yield* db
      .insert(InstructionBlobTable)
      .values([
        { hash: first, value: "first" },
        { hash: second, value: "second" },
      ])
      .run()
    yield* db
      .update(InstructionStateTable)
      .set({
        epoch_start: fixture.summary.coveredThrough.seq,
        through_seq: fixture.count + 1,
        initial_values: { [key]: first },
        current_values: { [key]: second },
      })
      .where(eq(InstructionStateTable.session_id, fixture.sessionID))
      .run()
    yield* db
      .insert(EventSequenceTable)
      .values({ aggregate_id: fixture.sessionID, seq: fixture.count + 1 })
      .run()
    yield* db
      .insert(EventTable)
      .values({
        id: EventRuntime.ID.make("evt_history_instruction"),
        aggregate_id: fixture.sessionID,
        seq: fixture.count + 1,
        created: fixture.count + 1,
        type: EventRuntime.versionedType(
          SessionEvent.InstructionsUpdated.type,
          SessionEvent.InstructionsUpdated.durable.version,
        ),
        data: { sessionID: fixture.sessionID, delta: { [key]: second } },
      })
      .run()
    const history = yield* SessionHistory.entriesForRunner(db, fixture.sessionID, source)
    expect(history.initial).toBe("Initial first")
    expect(history.entries.slice(1, -1).map((entry) => entry.message.id)).toEqual(fixture.tail)
    expect(history.entries.at(-1)?.message).toMatchObject({ type: "system", text: "Update second" })
  }),
)

it.effect("leaves canonical transcript and snapshot payloads unchanged", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db)
    const before = yield* SessionHistory.load(db, fixture.sessionID)
    expect(before.map((message) => message.id)).toEqual(fixture.ids)
    yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])
    expect(yield* SessionHistory.load(db, fixture.sessionID)).toEqual(before)
    expect((yield* SessionHistory.snapshotWindow(db, fixture.sessionID, 100)).messages).toEqual(before)
  }),
)

it.effect("keeps remote retained messages and account/model provenance selection", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db)
    const model = Model.Ref.make({
      providerID: Provider.ID.make("test"),
      id: Model.ID.make("owner"),
      variant: Model.VariantID.make("high"),
    })
    const account = "b".repeat(64)
    yield* db
      .update(CompactionManifestBlobTable)
      .set({
        content: {
          remote: {
            provider: "test",
            modelID: "owner",
            variant: "high",
            digest: ContextManifest.payloadDigest({ private: "state" }),
            itemID: "cmp_private",
            retained: [
              {
                messageID: fixture.ids[0],
                seq: 0,
                digest: ContextManifest.payloadDigest({ text: "0:" + "x".repeat(32), time: { created: 0 } }),
              },
            ],
          },
        },
      })
      .where(eq(CompactionManifestBlobTable.digest, fixture.manifestDigest))
      .run()
    yield* db
      .insert(SessionProviderRequestTable)
      .values({
        id: ProviderRequest.ID.make("prq_history_remote"),
        session_id: fixture.sessionID,
        assistant_message_id: SessionMessage.ID.make(`msg_compaction_${fixture.manifestDigest}`),
        connection_identity_digest: account,
        source: "compaction",
        agent: Agent.ID.make("compaction"),
        model,
        route_id: "test",
        prompt_cache_key: "history",
        system_digest: "s",
        tool_digest: "t",
        request: 1,
        attempts: 1,
        invalidation: "first-request",
        continuation: "full",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time_created: 0,
      })
      .run()
    expect(
      (yield* SessionHistory.forModel(db, fixture.sessionID, model, account)).map((message) => message.id),
    ).toEqual([fixture.ids[0], SessionMessage.ID.make(`msg_compaction_${fixture.manifestDigest}`), ...fixture.tail])
    for (const [selected, identity] of [
      [model, undefined],
      [model, "c".repeat(64)],
      [{ ...model, id: Model.ID.make("other") }, account],
      [{ ...model, variant: Model.VariantID.make("low") }, account],
    ] as const) {
      expect(
        (yield* SessionHistory.forModel(db, fixture.sessionID, selected, identity)).map((message) => message.id),
      ).toEqual(fixture.ids)
    }
  }),
)

it.effect("reads only retained and later payloads under a matching remote manifest", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db, { count: 40 })
    const covered = fixture.count - 11
    const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("owner") })
    const account = "b".repeat(64)
    yield* db
      .update(CompactionManifestBlobTable)
      .set({
        content: {
          remote: {
            provider: "test",
            modelID: "owner",
            digest: ContextManifest.payloadDigest({ private: "state" }),
            itemID: "cmp_private",
            retained: [3, 17].map((index) => ({
              messageID: fixture.ids[index],
              seq: index,
              digest: ContextManifest.payloadDigest({ text: `${index}:` + "x".repeat(32), time: { created: index } }),
            })),
          },
        },
      })
      .where(eq(CompactionManifestBlobTable.digest, fixture.manifestDigest))
      .run()
    yield* db
      .insert(SessionProviderRequestTable)
      .values({
        id: ProviderRequest.ID.make("prq_history_remote_bounded"),
        session_id: fixture.sessionID,
        assistant_message_id: SessionMessage.ID.make(`msg_compaction_${fixture.manifestDigest}`),
        connection_identity_digest: account,
        source: "compaction",
        agent: Agent.ID.make("compaction"),
        model,
        route_id: "test",
        prompt_cache_key: "history",
        system_digest: "s",
        tool_digest: "t",
        request: 1,
        attempts: 1,
        invalidation: "first-request",
        continuation: "full",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time_created: 0,
      })
      .run()
    const expected = [
      fixture.ids[3],
      fixture.ids[17],
      SessionMessage.ID.make(`msg_compaction_${fixture.manifestDigest}`),
      ...fixture.ids.slice(covered + 1),
    ]
    expect((yield* SessionHistory.forModel(db, fixture.sessionID, model, account)).map((message) => message.id)).toEqual(
      expected,
    )
    yield* db.run(
      sql`UPDATE session_message SET data = 'covered invalid JSON'
        WHERE session_id = ${fixture.sessionID} AND seq <= ${covered} AND seq NOT IN (3, 17)`,
    )
    expect((yield* SessionHistory.forModel(db, fixture.sessionID, model, account)).map((message) => message.id)).toEqual(
      expected,
    )
    expect(Exit.isFailure(yield* SessionHistory.forModel(db, fixture.sessionID).pipe(Effect.exit))).toBe(true)
  }),
)

it.effect("reads latest, recent, and unsettled tool messages from bounded rows after the completed V1 floor", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db, { count: 40 })
    const model = { providerID: "test", id: "model" }
    const tool = (id: string, status: "streaming" | "running" | "completed") => ({
      type: "tool",
      id,
      name: "echo",
      state:
        status === "streaming"
          ? { status, input: "{" }
          : { status, input: {}, structured: {}, content: [] },
      time: { created: 1 },
    })
    const assistant = (content: ReadonlyArray<unknown>) => ({ agent: "build", model, content, time: { created: 1 } })
    const rows = [
      { type: "assistant", data: assistant([tool("call_before_floor", "running")]) },
      { type: "skill", data: { skill: "review", name: "Review", text: "before floor", time: { created: 1 } } },
      { type: "user", data: { text: "before floor", time: { created: 1 } } },
      {
        type: "compaction",
        data: { reason: "auto", status: "completed", summary: "V1 summary", recent: "", time: { created: 1 } },
      },
      { type: "user", data: { text: "after floor", time: { created: 1 } } },
      { type: "assistant", data: { bogus: true } },
      { type: "assistant", data: assistant([{ type: "text", text: "Done" }, tool("call_streaming", "streaming")]) },
      { type: "synthetic", data: { bogus: true } },
      { type: "assistant", data: assistant([tool("call_completed", "completed")]) },
      { type: "assistant", data: assistant([tool("call_running", "running")]) },
      {
        type: "compaction",
        data: {
          jobID: "cmp_current",
          trigger: "manual",
          status: "completed",
          revision: 1,
          boundary: { messageID: fixture.ids[29], seq: 29 },
          metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 10, retainedTokens: 5 },
          time: { created: 1 },
        },
      },
      { type: "synthetic", data: { text: "newest", time: { created: 1 } } },
    ] as const
    const ids = rows.map((_, index) => SessionMessage.ID.make(`msg_history_bounded_${index}`))
    yield* Effect.forEach(
      rows,
      (row, index) =>
        db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
            VALUES (${ids[index]}, ${fixture.sessionID}, ${row.type}, ${fixture.count + index},
              ${fixture.count + index}, ${fixture.count + index}, ${JSON.stringify(row.data)})`,
        ),
      { discard: true },
    )

    expect((yield* SessionHistory.latest(db, fixture.sessionID, "assistant"))?.id).toBe(ids[9])
    expect((yield* SessionHistory.latest(db, fixture.sessionID, "user"))?.id).toBe(ids[4])
    expect(yield* SessionHistory.latest(db, fixture.sessionID, "skill")).toBeUndefined()
    expect((yield* SessionHistory.recent(db, fixture.sessionID, 4)).map((message) => message.id)).toEqual(ids.slice(8))
    expect((yield* SessionHistory.unsettledToolMessages(db, fixture.sessionID)).map((message) => message.id)).toEqual([
      ids[6],
      ids[9],
    ])
    expect(Exit.isFailure(yield* SessionHistory.load(db, fixture.sessionID).pipe(Effect.exit))).toBe(true)
    yield* db.run(sql`DELETE FROM session_message WHERE id IN (${ids[5]}, ${ids[7]})`)
    expect((yield* SessionHistory.recent(db, fixture.sessionID, 100)).map((message) => message.id)).toEqual(
      (yield* SessionHistory.load(db, fixture.sessionID)).map((message) => message.id),
    )
    expect((yield* SessionHistory.recent(db, fixture.sessionID, 100)).map((message) => message.id)).toEqual([
      ids[3],
      ids[4],
      ids[6],
      ...ids.slice(8),
    ])
  }),
)

it.effect("releases an interrupted history snapshot before another aggregate commits", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const fixture = yield* historyFixture(db)
    const entered = yield* Deferred.make<void>()
    const queued = yield* Deferred.make<void>()
    const snapshot = yield* db
      .transaction(() =>
        SessionHistory.entriesForRunner(db, fixture.sessionID, []).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never),
        ),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(entered)
    const other = yield* Deferred.succeed(queued, undefined).pipe(
      Effect.andThen(
        events.publish(SessionEvent.Renamed, { sessionID: SessionSchema.ID.make("ses_history_other"), title: "Other" }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Deferred.await(queued)
    expect(other.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(snapshot)
    expect((yield* Fiber.join(other)).durable?.seq).toBe(EventRuntime.Seq.make(0))
    expect((yield* SessionHistory.load(db, fixture.sessionID)).map((message) => message.id)).toEqual(fixture.ids)
  }),
)

it.effect("drains separate Session bursts while a peer waits and releases coordinator ownership", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const fixture = yield* historyFixture(db)
    const entered = yield* Deferred.make<void>()
    const peers = Array.from({ length: 4 }, (_, index) => SessionSchema.ID.make(`ses_history_burst_${index}`))
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, never>({
      drain: (key) =>
        Effect.gen(function* () {
          if (key === fixture.sessionID) {
            yield* SessionHistory.entriesForRunner(db, key, [])
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.never
            return
          }
          for (let index = 0; index < 8; index++) {
            const history = yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])
            expect(history.entries.slice(1).map((entry) => entry.message.id)).toEqual(fixture.tail)
            yield* events.publish(SessionEvent.Renamed, { sessionID: key, title: `${index}` })
          }
        }).pipe(Effect.orDie),
    })
    yield* coordinator.wake(fixture.sessionID)
    yield* Deferred.await(entered)
    yield* Effect.all(
      peers.map((key) => coordinator.run(key)),
      { concurrency: "unbounded" },
    )
    expect(Array.from(yield* coordinator.active)).toEqual([fixture.sessionID])
    for (const peer of peers) {
      const log = yield* events.log({ aggregateID: peer }).pipe(Stream.runCollect)
      expect(log.flatMap((event) => EventRuntime.isSynced(event) ? [] : [event.durable?.seq])).toEqual(
        [0, 1, 2, 3, 4, 5, 6, 7].map((sequence) => EventRuntime.Seq.make(sequence)),
      )
    }
    yield* coordinator.interrupt(fixture.sessionID)
    yield* coordinator.awaitIdle(fixture.sessionID)
    expect((yield* coordinator.active).size).toBe(0)
  }),
)
