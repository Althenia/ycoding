import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
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
      LocationServiceMap.node,
    ]),
    [
      [Project.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
const dotsTitle = "Dots · unattributed"

const createdEvent = (session: Session.Interface, sessionID: Session.ID) =>
  session.log({ sessionID }).pipe(
    Stream.filter((item): item is SessionEvent.PublicDurableEvent => !EventRuntime.isSynced(item)),
    Stream.runCollect,
    Effect.map((events) => Array.from(events).find((event) => event.type === "session.created")),
  )

describe("Session origin", () => {
  it.effect("records an executor origin on creation and on the Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const background = yield* session.create({ location, title: dotsTitle, origin: "dots-executor" })
      const ordinary = yield* session.create({ location, title: dotsTitle })

      expect(background.origin).toBe("dots-executor")
      expect((yield* session.get(background.id)).origin).toBe("dots-executor")
      expect(ordinary.origin).toBeUndefined()
      expect(JSON.stringify(ordinary)).not.toContain("origin")
      expect((yield* createdEvent(session, background.id))?.data).toMatchObject({ origin: "dots-executor" })
      expect(JSON.stringify((yield* createdEvent(session, ordinary.id))!.data)).not.toContain("origin")
    }),
  )

  it.effect("retains the full history, snapshot and messages of a hidden background Session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const background = yield* session.create({ location, title: dotsTitle, origin: "dots-executor" })
      yield* session.rename({ sessionID: background.id, title: "Renamed arbitrarily" })
      const prompt = yield* session.prompt({ sessionID: background.id, text: "Synthetic admitted input", resume: false })

      const events = Array.from(yield* Stream.runCollect(
        session.log({ sessionID: background.id }).pipe(Stream.filter((item): item is SessionEvent.PublicDurableEvent => !EventRuntime.isSynced(item))),
      ))
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["session.created", "session.renamed"]))
      const snapshot = yield* session.snapshot(background.id)
      expect(snapshot.session).toMatchObject({ id: background.id, title: "Renamed arbitrarily", origin: "dots-executor" })
      expect(yield* session.messages({ sessionID: background.id })).toEqual(snapshot.messages)
      expect(prompt.id).toBeDefined()
      expect((yield* session.list({ background: "exclude" })).data).toEqual([])
      expect((yield* session.list()).data.map((item) => item.id)).toEqual([background.id])
    }),
  )

  it.effect("keeps the first origin when a create is retried", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const first = yield* session.create({ location, origin: "dots-executor" })
      expect((yield* session.create({ id: first.id, location })).origin).toBe("dots-executor")
      const ordinary = yield* session.create({ location })
      expect((yield* session.create({ id: ordinary.id, location, origin: "dots-executor" })).origin).toBeUndefined()
    }),
  )

  it.effect("includes background Sessions by default and excludes them only on request", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const background = yield* session.create({ location, title: dotsTitle, origin: "dots-executor" })
      const ordinary = yield* session.create({ location, title: dotsTitle })
      const all = [background.id, ordinary.id].sort()

      expect((yield* session.list()).data.map((item) => item.id).sort()).toEqual(all)
      expect((yield* session.list({ background: "include" })).data.map((item) => item.id).sort()).toEqual(all)
      expect((yield* session.list({ background: "exclude" })).data.map((item) => item.id)).toEqual([ordinary.id])
      expect((yield* session.list({ background: "exclude", search: "Dots" })).data.map((item) => item.id)).toEqual([ordinary.id])
      expect((yield* session.list({ background: "exclude", directory: location.directory, parentID: null })).data)
        .toHaveLength(1)
    }),
  )

  it.effect("keeps a renamed background Session hidden and a renamed ordinary Session visible", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const background = yield* session.create({ location, title: dotsTitle, origin: "dots-executor" })
      const ordinary = yield* session.create({ location, title: "Plain" })
      yield* session.rename({ sessionID: background.id, title: "Arbitrary" })
      yield* session.rename({ sessionID: ordinary.id, title: dotsTitle })

      expect((yield* session.list({ background: "exclude" })).data.map((item) => item.id)).toEqual([ordinary.id])
      expect((yield* session.get(background.id)).title).toBe("Arbitrary")
    }),
  )

  it.effect("filters before the anchor and limit so leading background rows never starve a page", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const ordinary = [yield* session.create({ location, title: "one" }), yield* session.create({ location, title: "two" })]
      const background = []
      for (const title of ["a", "b", "c", "d"]) background.push(yield* session.create({ location, title, origin: "dots-executor" }))
      yield* Effect.forEach(background, (item) => session.rename({ sessionID: item.id, title: `${item.title} renamed` }))

      const expected = ordinary.map((item) => item.id).sort()
      const first = yield* session.list({ background: "exclude", limit: 1 })
      expect(first.data).toHaveLength(1)
      const second = yield* session.list({
        background: "exclude",
        limit: 1,
        anchor: { id: first.data[0]!.id, time: DateTime.toEpochMillis(first.data[0]!.time.updated), direction: "next" },
      })
      expect(second.data).toHaveLength(1)
      expect([first.data[0]!.id, second.data[0]!.id].sort()).toEqual(expected)
      expect(
        (yield* session.list({
          background: "exclude",
          limit: 1,
          anchor: { id: second.data[0]!.id, time: DateTime.toEpochMillis(second.data[0]!.time.updated), direction: "next" },
        })).data,
      ).toEqual([])
      expect(
        (yield* session.list({
          background: "exclude",
          limit: 1,
          anchor: { id: second.data[0]!.id, time: DateTime.toEpochMillis(second.data[0]!.time.updated), direction: "previous" },
        })).data.map((item) => item.id),
      ).toEqual([first.data[0]!.id])
    }),
  )
})
