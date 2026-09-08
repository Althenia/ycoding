import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Database } from "@ycoding-ai/core/database/database"
import { EventV2 } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
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
      SessionExecution.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("SessionV2 archive", () => {
  it.effect("rejects unknown sessions for both archive operations", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const id = SessionV2.ID.make("ses_archive_missing")
      expect(yield* session.archive(id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
      expect(yield* session.unarchive(id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
    }),
  )

  it.effect("projects idempotent durable archive and unarchive events", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      const updated = DateTime.toEpochMillis(created.time.updated)

      expect(created.time.archived).toBeUndefined()
      yield* Effect.all([session.archive(created.id), session.archive(created.id)], {
        concurrency: "unbounded",
        discard: true,
      })
      const archived = yield* session.get(created.id)
      expect(archived.time.archived).toBeDefined()
      expect(DateTime.toEpochMillis(archived.time.updated)).toBe(updated)
      expect((yield* session.list()).data.some((item) => item.id === created.id)).toBe(true)

      yield* session.archive(created.id)
      expect(DateTime.toEpochMillis((yield* session.get(created.id)).time.archived!)).toBe(
        DateTime.toEpochMillis(archived.time.archived!),
      )

      yield* Effect.all([session.unarchive(created.id), session.unarchive(created.id)], {
        concurrency: "unbounded",
        discard: true,
      })
      expect((yield* session.get(created.id)).time.archived).toBeUndefined()

      const log = Array.from(yield* Stream.runCollect(events.log({ aggregateID: created.id })))
        .filter((event): event is SessionEvent.PublicDurableEvent => !EventV2.isSynced(event))
        .map((event) => Schema.encodeSync(SessionEvent.Durable)(event).type)
      expect(log.filter((type) => type === SessionEvent.Archived.type)).toHaveLength(1)
      expect(log.filter((type) => type === SessionEvent.Unarchived.type)).toHaveLength(1)
    }),
  )
})
