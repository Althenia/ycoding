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
      SessionExecution.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

describe("SessionV2 pin", () => {
  it.effect("rejects unknown sessions for both pin operations", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const id = SessionV2.ID.make("ses_pin_missing")
      expect(yield* session.pin(id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
      expect(yield* session.unpin(id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.NotFoundError)
    }),
  )

  it.effect("projects idempotent durable pin and unpin events without changing update time", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      const updated = DateTime.toEpochMillis(created.time.updated)

      expect(created.time.pinned).toBeUndefined()
      yield* Effect.all([session.pin(created.id), session.pin(created.id)], {
        concurrency: "unbounded",
        discard: true,
      })
      const pinned = yield* session.get(created.id)
      expect(pinned.time.pinned).toBeDefined()
      expect(DateTime.toEpochMillis(pinned.time.updated)).toBe(updated)
      expect((yield* session.list()).data.find((item) => item.id === created.id)?.time.pinned).toBeDefined()

      yield* session.pin(created.id)
      expect(DateTime.toEpochMillis((yield* session.get(created.id)).time.pinned!)).toBe(
        DateTime.toEpochMillis(pinned.time.pinned!),
      )

      yield* Effect.all([session.unpin(created.id), session.unpin(created.id)], {
        concurrency: "unbounded",
        discard: true,
      })
      expect((yield* session.get(created.id)).time.pinned).toBeUndefined()

      const log = Array.from(yield* Stream.runCollect(events.log({ aggregateID: created.id })))
        .filter((event): event is SessionEvent.PublicDurableEvent => !EventV2.isSynced(event))
        .map((event) => Schema.encodeSync(SessionEvent.Durable)(event).type)
      expect(log.filter((type) => type === SessionEvent.Pinned.type)).toHaveLength(1)
      expect(log.filter((type) => type === SessionEvent.Unpinned.type)).toHaveLength(1)
    }),
  )
})
