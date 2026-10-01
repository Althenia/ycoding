export * as SessionSkill from "./skill"

import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { ProjectArtifactAccounting } from "../project-artifact/accounting"
import type { ProjectArtifactSource } from "../project-artifact/source"
import { SkillV2 } from "../skill"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionSkillStatus } from "./skill-status"
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
    return [SkillV2.ID.make(skill.id)]
  })
}

export const activate = Effect.fn("SessionSkill.activate")(function* (
  services: {
    events: EventV2.Interface
    store: SessionStore.Interface
    accounting: ProjectArtifactAccounting.Interface
  },
  input: {
    session: SessionSchema.Info
    skill: SkillV2.Info
    id?: SessionMessage.ID
    provenance?: ProjectArtifactSource.Provenance
  },
) {
  return yield* locks.withLock(input.session.id)(
    Effect.gen(function* () {
      const active = SessionSkillStatus.list(yield* services.store.context(input.session.id), []).some(
        (status) => status.id === input.skill.id && status.state === "active",
      )
      if (active) return
      const provenance = input.provenance
      yield* services.events.publish(
        SessionEvent.Skill.Activated,
        {
          sessionID: input.session.id,
          id: input.skill.id,
          name: input.skill.name,
          text: input.skill.content,
          conflicts: input.skill.conflicts,
          artifact: provenance
            ? {
                scopeID: provenance.scopeID,
                versionID: provenance.versionID,
                kind: provenance.kind,
                id: provenance.id,
                sourceScope: provenance.scope,
              }
            : undefined,
        },
        {
          id: input.id ? EventV2.ID.make(input.id.replace(/^msg_/, "evt_")) : undefined,
          commit: provenance
            ? (seq) =>
                services.accounting
                  .activate(
                    ProjectArtifact.Activation.make({
                      id: ProjectArtifact.ActivationID.make(`paa_${randomUUID()}`),
                      artifact: {
                        scopeID: provenance.scopeID,
                        kind: provenance.kind,
                        id: provenance.id,
                        versionID: provenance.versionID,
                      },
                      projectID: input.session.projectID,
                      sessionID: input.session.id,
                      agentID: input.session.agent,
                      source: "session-skill",
                      messageID: input.id,
                      boundarySeq: ProjectArtifact.Revision.make(seq),
                      activatedAt: ProjectArtifact.TimestampMillis.make(Date.now()),
                    }),
                  )
                  .pipe(Effect.asVoid, Effect.orDie)
            : undefined,
        },
      )
    }),
  )
})
