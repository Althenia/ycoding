export * as SessionSkill from "./skill"

import path from "path"
import { Effect } from "effect"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import type { FSUtil } from "../fs-util"
import { Skill } from "../skill"
import { SkillTool } from "../tool/skill"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

export function mentions(text: string, available: ReadonlyArray<{ id: string; name: string }>) {
  if (!available.length) return []
  const ids = available
    .map((skill) => skill.id)
    .toSorted((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
  const matcher = new RegExp(`(^|\\s)\\$(${ids})(?=[\\s.,!?;:)\\]'"\`]|$)`, "g")
  const selected = new Set([...text.matchAll(matcher)].map((match) => match[2]))
  return available.filter((skill) => selected.has(skill.id)).map((skill) => ({ id: skill.id, name: skill.name }))
}

export function selected(metadata: Record<string, unknown> | undefined) {
  const skills = metadata?.skills
  if (!Array.isArray(skills)) return []
  return skills.flatMap((skill: unknown) => {
    if (!skill || typeof skill !== "object" || !("id" in skill) || typeof skill.id !== "string" || !skill.id.trim())
      return []
    return [Skill.ID.make(skill.id)]
  })
}

export const activate = Effect.fn("SessionSkill.activate")(function* (
  services: {
    events: EventRuntime.Interface
    store: SessionStore.Interface
    fs: FSUtil.Interface
  },
  input: {
    session: SessionSchema.Info
    skill: Skill.Info
    id?: SessionMessage.ID
  },
) {
  return yield* locks.withLock(input.session.id)(
    Effect.gen(function* () {
      const active = (yield* services.store.skills(input.session.id)).some(
        (status) => status.id === input.skill.id && status.state === "active",
      )
      if (active) return
      const text = yield* SkillTool.instructions(services.fs, input.skill)
      yield* services.events.publish(
        SessionEvent.Skill.Activated,
        {
          sessionID: input.session.id,
          id: input.skill.id,
          name: input.skill.name,
          text,
          directory: path.dirname(input.skill.location),
          conflicts: input.skill.conflicts,
        },
        {
          id: input.id ? EventRuntime.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined,
        },
      )
    }),
  )
})
