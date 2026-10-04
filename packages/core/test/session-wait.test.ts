import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const awaited: Session.ID[] = []
const projects = Layer.mock(Project.Service, {
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
})
const execution = Layer.mock(SessionExecution.Service, {
  active: Effect.succeed(new Set<Session.ID>()),
  awaitIdle: (sessionID) => Effect.sync(() => awaited.push(sessionID)),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Project.node, projects],
      [SessionExecution.node, execution],
    ],
  ),
)

describe("Session.wait", () => {
  it.effect("delegates to SessionExecution.awaitIdle", () =>
    Effect.gen(function* () {
      awaited.length = 0
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location })

      yield* sessions.wait(session.id)

      expect(awaited).toEqual([session.id])
    }),
  )
})
