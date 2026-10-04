import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionMessageTable, SessionPendingTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { testEffect } from "./lib/effect"

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

const aggregateTypes = (sessionID: Session.ID) =>
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

describe("Session.daybreak.set", () => {
  it.effect("persists a Daybreak selection through its durable event and column", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
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
        EventRuntime.versionedType(SessionEvent.Created.type, SessionEvent.Created.durable.version),
        EventRuntime.versionedType(SessionEvent.DaybreakSet.type, SessionEvent.DaybreakSet.durable.version),
      ])
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* db.select().from(SessionPendingTable).where(eq(SessionPendingTable.session_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(0)
    }),
  )

  it.effect("clears the Daybreak selection when null is set", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
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
      const session = yield* Session.Service
      const missing = Session.ID.make("ses_missing_daybreak")

      expect(
        yield* session.daybreak.set({ sessionID: missing, daybreak: "daybreak_red" }).pipe(Effect.flip),
      ).toEqual(new Session.NotFoundError({ sessionID: missing }))
    }),
  )
})
