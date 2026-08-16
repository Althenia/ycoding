import { describe, expect } from "bun:test"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { Instructions } from "@ycoding-ai/core/instructions"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { DateTime, Effect, Layer, LayerMap, Schema } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { resolveSkillConflict } from "../src/handlers/session"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const projects = Layer.mock(ProjectV2.Service, {
  resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
})
const instructionDiscovery = Layer.succeed(
  InstructionDiscovery.Service,
  InstructionDiscovery.Service.of({ load: () => Effect.succeed([]) }),
)
const sessionContext = Layer.mock(SessionContext.Service, {
  select: (sessionID) =>
    Effect.succeed({
      session: SessionV2.Info.make({
        id: sessionID,
        projectID: ProjectV2.ID.global,
        title: "test",
        cost: Schema.decodeUnknownSync(SessionV2.Info.fields.cost)(0),
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location,
      }),
      agent: { id: AgentV2.defaultID, info: AgentV2.Info.empty(AgentV2.defaultID) },
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
        Layer.mock(SkillV2.Service, {
          list: () => Effect.succeed([]),
        }),
        instructionDiscovery,
        sessionContext,
      ) as unknown as Layer.Layer<LocationServices>,
  ),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [LocationServiceMap.node, locations],
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

describe("session.resolveSkillConflict", () => {
  it.effect("resolves a real durable skill conflict through the handler delegate", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create({ location })
      const winner = SkillV2.ID.make("winner")
      const loser = SkillV2.ID.make("loser")

      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: session.id,
        id: winner,
        name: SkillV2.Name.make("Winner"),
        text: "Winner instructions",
        conflicts: { skills: [loser], instructions: [] },
      })
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: session.id,
        id: loser,
        name: SkillV2.Name.make("Loser"),
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
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create({ location })
      const winner = SkillV2.ID.make("independent-winner")
      const loser = SkillV2.ID.make("independent-loser")

      for (const [id, name] of [
        [winner, "Independent winner"],
        [loser, "Independent loser"],
      ] as const) {
        yield* events.publish(SessionEvent.Skill.Activated, {
          sessionID: session.id,
          id,
          name: SkillV2.Name.make(name),
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
