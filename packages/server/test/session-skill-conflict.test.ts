import { describe, expect } from "bun:test"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { Instructions } from "@ycoding-ai/core/instructions"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Skill } from "@ycoding-ai/core/skill"
import { DateTime, Effect, Layer, LayerMap, Schema } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { resolveSkillConflict } from "../src/handlers/session"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const projects = Layer.mock(Project.Service, {
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
})
const instructionDiscovery = Layer.succeed(
  InstructionDiscovery.Service,
  InstructionDiscovery.Service.of({ load: () => Effect.succeed([]) }),
)
const sessionContext = Layer.mock(SessionContext.Service, {
  select: (sessionID) =>
    Effect.succeed({
      session: Session.Info.make({
        id: sessionID,
        projectID: Project.ID.global,
        title: "test",
        cost: Schema.decodeUnknownSync(Session.Info.fields.cost)(0),
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location,
      }),
      agent: { id: Agent.defaultID, info: Agent.Info.empty(Agent.defaultID) },
      instructions: Instructions.make({
        key: Instructions.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.succeed(Instructions.removed),
        render: { initial: (value) => value, changed: (_previous, value) => value },
      }),
    }),
})
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // The operation only needs the location-scoped Skill, instruction, and Session context services.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Layer.mergeAll(
        Layer.mock(Skill.Service, {
          list: () => Effect.succeed([]),
        }),
        instructionDiscovery,
        sessionContext,
      ) as unknown as Layer.Layer<LocationServices>,
  ),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [LocationServiceMap.node, locations],
      [Project.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

describe("session.resolveSkillConflict", () => {
  it.effect("resolves a real durable skill conflict through the handler delegate", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventRuntime.Service
      const session = yield* sessions.create({ location })
      const winner = Skill.ID.make("winner")
      const loser = Skill.ID.make("loser")

      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: session.id,
        id: winner,
        name: Skill.Name.make("Winner"),
        text: "Winner instructions",
        conflicts: { skills: [loser], instructions: [] },
      })
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: session.id,
        id: loser,
        name: Skill.Name.make("Loser"),
        text: "Loser instructions",
        conflicts: { skills: [], instructions: [] },
      })

      yield* resolveSkillConflict(sessions, { sessionID: session.id, winner, loser })

      expect(yield* sessions.skills(session.id)).toContainEqual(
        expect.objectContaining({ id: loser, state: "inactive", inactiveReason: "conflict_resolved" }),
      )
    }),
  )

  it.effect("maps a conflict-free pair without a durable write or internal detail", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventRuntime.Service
      const session = yield* sessions.create({ location })
      const winner = Skill.ID.make("independent-winner")
      const loser = Skill.ID.make("independent-loser")

      for (const [id, name] of [
        [winner, "Independent winner"],
        [loser, "Independent loser"],
      ] as const) {
        yield* events.publish(SessionEvent.Skill.Activated, {
          sessionID: session.id,
          id,
          name: Skill.Name.make(name),
          text: `${name} instructions`,
          conflicts: { skills: [], instructions: [] },
        })
      }
      const before = yield* sessions.messages({ sessionID: session.id, order: "asc" })

      const error = yield* resolveSkillConflict(sessions, { sessionID: session.id, winner, loser }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "SkillConflictNotFoundError", message: "Skill conflict not found" })
      expect(JSON.stringify(error)).not.toContain(winner)
      expect(JSON.stringify(error)).not.toContain(loser)
      expect(JSON.stringify(error)).not.toContain("Session.SkillConflictNotFoundError")
      expect(yield* sessions.messages({ sessionID: session.id, order: "asc" })).toEqual(before)
    }),
  )
})
