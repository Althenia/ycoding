import { expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "../src/database/database"
import { EventRuntime } from "../src/event"
import { EventTable } from "../src/event/sql"
import { ContextManifest } from "../src/session/context-manifest"
import { SessionEvent } from "../src/session/event"
import { SessionHistory } from "../src/session/history"
import {
  CompactionManifestBlobTable,
  SessionContextExclusionTable,
  SessionContextStateTable,
  SessionMessageTable,
} from "../src/session/sql"
import { historyDatabase, historyFixture } from "./fixture/session-history-pruning"
import { observationMessageData } from "./fixture/session-observations"
import { testEffect } from "./lib/effect"

const it = testEffect(historyDatabase)

it.effect("does not decode unrelated large or corrupt payloads while model history still validates them", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db, { count: 1000, bytes: 8192 })
    yield* db
      .update(SessionMessageTable)
      .set({
        type: "system",
        data: observationMessageData({
          id: fixture.tail[1],
          type: "system",
          text: "Current state",
          metadata: { contextSource: "session-state" },
          time: { created: 1 },
        }),
      })
      .where(eq(SessionMessageTable.id, fixture.tail[1]))
      .run()
    yield* db.run(
      sql`UPDATE session_message SET type = 'assistant', data = 'invalid assistant JSON' WHERE id = ${fixture.tail[0]}`,
    )
    const observed = yield* SessionHistory.observationState(db, fixture.sessionID)
    expect([...observed.present]).toEqual(["session-state"])
    expect(observed.latest.size).toBe(0)
    expect(Exit.isFailure(yield* SessionHistory.entriesForRunner(db, fixture.sessionID, []).pipe(Effect.exit))).toBe(
      true,
    )
    expect(yield* db.get<{ count: number }>("SELECT COUNT(*) AS count FROM session_message")).toEqual({
      count: fixture.count,
    })
  }),
)

for (const status of ["active", "quarantined"] as const) {
  it.effect(`selects chronological observations from the ${status} context`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const fixture = yield* historyFixture(db)
      const ids = [fixture.ids[0], fixture.tail[0], fixture.tail[1]]
      for (const [index, id] of ids.entries()) {
        yield* db
          .update(SessionMessageTable)
          .set({
            type: index === 2 ? "synthetic" : "system",
            data: observationMessageData({
              id,
              type: index === 2 ? "synthetic" : "system",
              text: `Observation ${index}`,
              ...(index === 2 ? { description: "TeamView update" } : {}),
              metadata: { contextSource: index === 2 ? "team-view" : index === 0 ? "step-limit" : "session-state" },
              time: { created: index },
            }),
          })
          .where(eq(SessionMessageTable.id, id))
          .run()
      }
      yield* EventRuntime.reserveSequence(db, fixture.sessionID, fixture.count)
      yield* db
        .insert(EventTable)
        .values(
          ids.map((id, index) => ({
            id: EventRuntime.ID.make(String(id).replace(/^msg_/, "evt_")),
            aggregate_id: fixture.sessionID,
            seq: index,
            created: index,
            type: EventRuntime.versionedType(
              SessionEvent.ContextObserved.type,
              SessionEvent.ContextObserved.durable.version,
            ),
            data: {
              source: index === 2 ? "team-view" : index === 0 ? "step-limit" : "session-state",
              text: `Observation ${index}`,
            },
          })),
        )
        .run()
      yield* db
        .update(SessionContextStateTable)
        .set({ status })
        .where(eq(SessionContextStateTable.session_id, fixture.sessionID))
        .run()
      const observed = yield* SessionHistory.observationState(db, fixture.sessionID)
      const expected: Array<[SessionHistory.ObservationSource, string]> = [
        ["team-view", "Observation 2"],
        ["session-state", "Observation 1"],
      ]
      if (status === "quarantined") expected.push(["step-limit", "Observation 0"])
      expect([...observed.latest]).toEqual(expected)
      expect([...observed.present]).toEqual([...observed.latest.keys()])
      const complete = yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])
      expect(
        complete.entries
          .filter((entry) => entry.message.metadata?.contextSource !== undefined)
          .map((entry) => entry.message.id),
      ).toEqual(status === "active" ? ids.slice(1) : ids)
    }),
  )
}

it.effect("rejects corruption in selected observations and omits project-artifact boundary notices", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db)
    yield* db.run(
      sql`UPDATE session_message SET type = 'system', data = ${JSON.stringify({ text: 1, metadata: { contextSource: "session-state" }, time: { created: 1 } })} WHERE id = ${fixture.tail[0]}`,
    )
    expect(Exit.isFailure(yield* SessionHistory.observationState(db, fixture.sessionID).pipe(Effect.exit))).toBe(true)
    yield* db
      .update(SessionMessageTable)
      .set({
        type: "synthetic",
        data: observationMessageData({
          id: fixture.tail[0],
          type: "synthetic",
          text: "Project boundary",
          description: "TeamView update",
          metadata: { contextSource: "team-view", projectArtifactsEnded: {} },
          time: { created: 1 },
        }),
      })
      .where(eq(SessionMessageTable.id, fixture.tail[0]))
      .run()
    yield* db
      .insert(EventTable)
      .values({
        id: EventRuntime.ID.make("evt_observation_project_boundary"),
        aggregate_id: fixture.sessionID,
        seq: fixture.summary.coveredThrough.seq + 1,
        created: 1,
        type: EventRuntime.versionedType(SessionEvent.ProjectArtifactsEnded.type, 1),
        data: {},
      })
      .run()
    expect([...(yield* SessionHistory.observationState(db, fixture.sessionID)).present]).toEqual([])
    expect(
      (yield* SessionHistory.entriesForRunner(db, fixture.sessionID, [])).entries
        .slice(1)
        .map((entry) => entry.message.id),
    ).toEqual(fixture.tail.slice(1))
  }),
)

it.effect("preserves digest-validated observation exclusions and legacy compaction boundaries", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db)
    const data = observationMessageData({
      id: fixture.ids[0],
      type: "system",
      text: "Covered state",
      metadata: { contextSource: "session-state" },
      time: { created: 0 },
    })
    yield* db
      .update(SessionMessageTable)
      .set({ type: "system", data })
      .where(eq(SessionMessageTable.id, fixture.ids[0]))
      .run()
    yield* db
      .update(CompactionManifestBlobTable)
      .set({ content: {} })
      .where(eq(CompactionManifestBlobTable.digest, fixture.manifestDigest))
      .run()
    const target = { kind: "message" as const, messageID: fixture.ids[0], digest: ContextManifest.payloadDigest(data) }
    yield* db
      .insert(SessionContextExclusionTable)
      .values({
        session_id: fixture.sessionID,
        context_revision: 1,
        target_key: ContextManifest.targetKey(target),
        target_kind: "message",
        target_selector: target,
        reason: "superseded_authority",
        manifest_digest: fixture.manifestDigest,
      })
      .run()
    expect([...(yield* SessionHistory.observationState(db, fixture.sessionID)).present]).toEqual([])
    yield* db
      .update(SessionContextExclusionTable)
      .set({ target_selector: { ...target, digest: "a".repeat(64) } })
      .run()
    expect([...(yield* SessionHistory.observationState(db, fixture.sessionID)).present]).toEqual(["session-state"])
    yield* db
      .update(SessionMessageTable)
      .set({
        type: "compaction",
        data: observationMessageData({
          id: fixture.ids[1],
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "Legacy checkpoint",
          recent: "",
          time: { created: 1 },
        }),
      })
      .where(eq(SessionMessageTable.id, fixture.ids[1]))
      .run()
    expect([...(yield* SessionHistory.observationState(db, fixture.sessionID)).present]).toEqual([])
  }),
)

it.effect("advances past a fully excluded page without inheriting its presence flags", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const fixture = yield* historyFixture(db, { count: 303 })
    yield* db
      .update(CompactionManifestBlobTable)
      .set({ content: {} })
      .where(eq(CompactionManifestBlobTable.digest, fixture.manifestDigest))
      .run()
    yield* db
      .update(SessionMessageTable)
      .set({
        type: "system",
        data: observationMessageData({
          id: fixture.ids[0],
          type: "system",
          text: "Retained state",
          metadata: { contextSource: "session-state" },
          time: { created: 0 },
        }),
      })
      .where(eq(SessionMessageTable.id, fixture.ids[0]))
      .run()
    for (const [index, id] of fixture.ids.slice(100, 200).entries()) {
      const data = observationMessageData({
        id,
        type: "synthetic",
        text: `Excluded TeamView ${index}`,
        description: "TeamView update",
        metadata: { contextSource: "team-view" },
        time: { created: index },
      })
      yield* db.update(SessionMessageTable).set({ type: "synthetic", data }).where(eq(SessionMessageTable.id, id)).run()
      const target = { kind: "message" as const, messageID: id, digest: ContextManifest.payloadDigest(data) }
      yield* db
        .insert(SessionContextExclusionTable)
        .values({
          session_id: fixture.sessionID,
          context_revision: 1,
          target_key: ContextManifest.targetKey(target),
          target_kind: "message",
          target_selector: target,
          reason: "superseded_authority",
          manifest_digest: fixture.manifestDigest,
        })
        .run()
    }
    const state = yield* SessionHistory.observationState(db, fixture.sessionID)
    expect([...state.present]).toEqual(["session-state"])
    expect(state.latest.size).toBe(0)
  }),
)
