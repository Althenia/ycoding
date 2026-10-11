import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
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
      SessionExecution.node,
    ]),
    [
      [Project.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make(import.meta.dir) })

describe("Session pin", () => {
  it.effect("rejects unknown sessions for both pin operations", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const id = Session.ID.make("ses_pin_missing")
      expect(yield* session.pin(id).pipe(Effect.flip)).toBeInstanceOf(Session.NotFoundError)
      expect(yield* session.unpin(id).pipe(Effect.flip)).toBeInstanceOf(Session.NotFoundError)
    }),
  )

  it.effect("projects idempotent durable pin and unpin events without changing update time", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
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
        .filter((event): event is SessionEvent.PublicDurableEvent => !EventRuntime.isSynced(event))
        .map((event) => Schema.encodeSync(SessionEvent.Durable)(event).type)
      expect(log.filter((type) => type === SessionEvent.Pinned.type)).toHaveLength(1)
      expect(log.filter((type) => type === SessionEvent.Unpinned.type)).toHaveLength(1)
    }),
  )

  it.effect("pins and unpins an owned child Session durably", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ parentID: parent.id })

      yield* session.pin(child.id)
      expect((yield* session.get(child.id)).time.pinned).toBeDefined()
      yield* session.unpin(child.id)
      expect((yield* session.get(child.id)).time.pinned).toBeUndefined()
    }),
  )
})
