import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, LayerMap, Schema } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { Instruction } from "@ycoding-ai/schema/instruction"
import { Money } from "@ycoding-ai/schema/money"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { Instructions } from "@ycoding-ai/core/instructions"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { InstructionState } from "@ycoding-ai/core/session/instruction-state"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const projects = Layer.mock(ProjectV2.Service, {
  resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
})
const skills = Layer.mock(SkillV2.Service, {
  list: () =>
    Effect.succeed([
      SkillV2.Info.make({
        id: SkillV2.ID.make("effect"),
        name: SkillV2.Name.make("Effect"),
        description: "Effect guidance",
        conflicts: {
          skills: [SkillV2.ID.make("other")],
          instructions: [Instruction.Key.make("core/instructions")],
        },
        location: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
        content: "Use Effect",
      }),
    ]),
})
const instructionDiscovery = Layer.succeed(
  InstructionDiscovery.Service,
  InstructionDiscovery.Service.of({ load: () => Effect.succeed([]) }),
)
let instructionValue: string | Instructions.Unavailable | Instructions.Removed = "active"
const instruction = (key: string) =>
  Instructions.make({
    key: Instructions.Key.make(key),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.sync(() => instructionValue),
    render: { initial: (value) => value, changed: (_previous, value) => value },
  })
const sessionContext = Layer.mock(SessionContext.Service, {
  select: (sessionID) =>
    Effect.succeed({
      session: SessionV2.Info.make({
        id: sessionID,
        projectID: ProjectV2.ID.global,
        title: "test",
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location,
      }),
      agent: { id: AgentV2.defaultID, info: AgentV2.Info.empty(AgentV2.defaultID) },
      instructions: instruction("core/environment"),
    }),
})
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // The skill endpoint only needs the location-scoped Skill service.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Layer.mergeAll(
        skills,
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

describe("SessionV2.skill", () => {
  it.effect("projects the caller-supplied message ID", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_caller_skill")

      yield* sessions.skill({ id, sessionID: session.id, skill: SkillV2.ID.make("effect"), resume: false })

      expect(yield* sessions.messages({ sessionID: session.id })).toContainEqual(
        expect.objectContaining({
          id,
          type: "skill",
          skill: "effect",
          name: "Effect",
          text: "Use Effect",
          conflicts: {
            skills: [SkillV2.ID.make("other")],
            instructions: [Instruction.Key.make("core/instructions")],
          },
        }),
      )
    }),
  )

  it.effect("normalizes absent historical conflict snapshots", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({ location })
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: session.id,
        id: SkillV2.ID.make("effect"),
        name: SkillV2.Name.make("Effect"),
        text: "Use Effect",
      })

      expect(yield* sessions.messages({ sessionID: session.id })).toContainEqual(
        expect.objectContaining({
          type: "skill",
          skill: "effect",
          conflicts: { skills: [], instructions: [] },
        }),
      )
    }),
  )

  it.effect("reads isolated skill snapshots after the current catalog no longer contains them", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ parentID: parent.id })

      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: parent.id,
        id: SkillV2.ID.make("deleted"),
        name: SkillV2.Name.make("Deleted"),
        text: "Snapshot content",
        conflicts: { skills: [], instructions: [] },
      })
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: child.id,
        id: SkillV2.ID.make("child"),
        name: SkillV2.Name.make("Child"),
        text: "Child content",
        conflicts: { skills: [], instructions: [] },
      })

      expect(yield* sessions.skills(parent.id)).toEqual([
        expect.objectContaining({ id: SkillV2.ID.make("deleted"), content: "Snapshot content" }),
      ])
      expect(yield* sessions.skills(child.id)).toEqual([
        expect.objectContaining({ id: SkillV2.ID.make("child"), content: "Child content" }),
      ])
    }),
  )

  it.effect("resolves conflicts against non-discovery current instruction keys", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create({ location })

      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: session.id,
        id: SkillV2.ID.make("environment"),
        name: SkillV2.Name.make("Environment"),
        text: "Environment skill",
        conflicts: { skills: [], instructions: [Instruction.Key.make("core/environment")] },
      })

      expect(yield* sessions.skills(session.id)).toEqual([
        expect.objectContaining({
          id: SkillV2.ID.make("environment"),
          conflicts: [{ type: "instruction", id: "core/environment", name: "core/environment" }],
        }),
      ])
    }),
  )

  it.effect("retains unavailable instruction conflicts and removes them after deletion", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ location })
      const instructions = instruction("core/environment")

      yield* InstructionState.prepare(db, events, instructions, session.id)
      instructionValue = Instructions.unavailable
      yield* events.publish(SessionEvent.Skill.Activated, {
        sessionID: session.id,
        id: SkillV2.ID.make("environment-unavailable"),
        name: SkillV2.Name.make("Environment unavailable"),
        text: "Environment unavailable skill",
        conflicts: { skills: [], instructions: [Instruction.Key.make("core/environment")] },
      })

      expect(yield* sessions.skills(session.id)).toContainEqual(
        expect.objectContaining({
          id: SkillV2.ID.make("environment-unavailable"),
          conflicts: [{ type: "instruction", id: "core/environment", name: "core/environment" }],
        }),
      )

      instructionValue = Instructions.removed
      yield* InstructionState.prepare(db, events, instructions, session.id)

      expect(yield* sessions.skills(session.id)).toContainEqual(
        expect.objectContaining({ id: SkillV2.ID.make("environment-unavailable"), conflicts: [] }),
      )
    }).pipe(Effect.ensuring(Effect.sync(() => (instructionValue = "active")))),
  )
})
