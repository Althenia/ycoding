import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionMessageTable, SessionPendingTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    recordOpened: () => Effect.void,
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      LocationServiceMap.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const aggregateTypes = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => row.type)
  })

describe("SessionV2.daybreak.set", () => {
  it.effect("persists a Daybreak selection through its durable event and column", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      const info = yield* session.daybreak.set({ sessionID: created.id, daybreak: "daybreak_blue" })

      expect(info.daybreak).toBe("daybreak_blue")
      expect((yield* session.get(created.id)).daybreak).toBe("daybreak_blue")
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.daybreak).toBe("daybreak_blue")
      expect(yield* aggregateTypes(created.id)).toEqual([
        EventV2.versionedType(SessionEvent.Created.type, SessionEvent.Created.durable.version),
        EventV2.versionedType(SessionEvent.DaybreakSet.type, SessionEvent.DaybreakSet.durable.version),
      ])
    }),
  )

  it.effect("clears the Daybreak selection when null is set", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.daybreak.set({ sessionID: created.id, daybreak: "daybreak_blue" })

      const info = yield* session.daybreak.set({ sessionID: created.id, daybreak: null })

      expect(info.daybreak).toBeUndefined()
      expect((yield* session.get(created.id)).daybreak).toBeUndefined()
      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.daybreak).toBeNull()
    }),
  )

  it.effect("rejects a Daybreak change for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_daybreak")

      expect(
        yield* session.daybreak.set({ sessionID: missing, daybreak: "daybreak_red" }).pipe(Effect.flip),
      ).toEqual(new SessionV2.NotFoundError({ sessionID: missing }))
    }),
  )

  it.effect("publishes only the Daybreak event without transcript or pending rows", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      yield* session.daybreak.set({ sessionID: created.id, daybreak: "daybreak_red" })

      expect(yield* aggregateTypes(created.id)).toEqual([
        EventV2.versionedType(SessionEvent.Created.type, SessionEvent.Created.durable.version),
        EventV2.versionedType(SessionEvent.DaybreakSet.type, SessionEvent.DaybreakSet.durable.version),
      ])
      const messages = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, created.id))
        .all()
        .pipe(Effect.orDie)
      expect(messages).toHaveLength(0)
      const pending = yield* db
        .select()
        .from(SessionPendingTable)
        .where(eq(SessionPendingTable.session_id, created.id))
        .all()
        .pipe(Effect.orDie)
      expect(pending).toHaveLength(0)
    }),
  )
})
