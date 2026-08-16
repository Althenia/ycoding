import { Option, Schema } from "effect"
import { Conflict, Info, State } from "@ycoding-ai/schema/session-skill-status"
import { SkillV2 } from "../skill"
import { SkillTool } from "../tool/skill"
import { SessionMessage } from "./message"

export { Conflict, Info, State } from "@ycoding-ai/schema/session-skill-status"

const emptyDeclarations = { skills: [], instructions: [] } as const satisfies SkillV2.Conflicts

export function list(
  messages: ReadonlyArray<SessionMessage.Info>,
  instructionKeys: ReadonlyArray<string>,
): Info[] {
  const statuses = messages.reduce<Map<SkillV2.ID, Info>>((result, message) => {
    const applyDeactivations = (deactivations: readonly SessionMessage.SkillDeactivation[] | undefined) =>
      deactivations?.forEach((deactivation) => {
        const status = result.get(deactivation.skill)
        if (status)
          result.set(deactivation.skill, {
            ...status,
            state: "inactive",
            inactiveReason: deactivation.reason,
          })
      })
    if (message.type === "skill") {
      result.set(message.skill, {
        id: message.skill,
        name: message.name,
        state: "active",
        activatedBy: "reference",
        activationMessageID: message.id,
        content: message.text,
        conflicts: [],
        declarations: message.conflicts ?? emptyDeclarations,
      })
      applyDeactivations(message.skillDeactivations)
      return result
    }
    if (message.type === "assistant") {
      message.content
        .filter((content): content is SessionMessage.AssistantTool => content.type === "tool")
        .forEach((tool) => {
          if (tool.name !== SkillTool.name || tool.state.status !== "completed") return
          const input = Option.getOrUndefined(Schema.decodeUnknownOption(SkillTool.Input)(tool.state.input))
          const output = Option.getOrUndefined(Schema.decodeUnknownOption(SkillTool.Output)(tool.state.structured))
          if (!input || !output || output.alreadyActive) return
          result.set(input.id, {
            id: input.id,
            name: output.name,
            state: "active",
            activatedBy: "tool",
            activationMessageID: message.id,
            content: output.output,
            conflicts: [],
            declarations: output.conflicts ?? emptyDeclarations,
          })
        })
      applyDeactivations(message.skillDeactivations)
      return result
    }
    const inactiveReason =
      message.type === "agent-switched"
        ? "agent_switched"
        : message.type === "compaction" && message.status === "completed"
          ? "compacted"
          : undefined
    if (inactiveReason)
      result.forEach((status, skillID) => {
        result.set(skillID, { ...status, state: "inactive", inactiveReason })
      })
    return result
  }, new Map())

  const active = [...statuses.values()].filter((status) => status.state === "active")
  const activeByID = new Map(active.map((status) => [status.id, status]))
  const inbound = active
    .flatMap((status) => status.declarations.skills.map((target) => ({ source: status.id, target })))
    .reduce<Map<SkillV2.ID, Set<SkillV2.ID>>>((result, declaration) => {
      const sources = result.get(declaration.target) ?? new Set<SkillV2.ID>()
      sources.add(declaration.source)
      result.set(declaration.target, sources)
      return result
    }, new Map())
  const instructions = new Set(instructionKeys)

  return [...statuses.values()].map((status) => {
    if (status.state !== "active") return { ...status, conflicts: [] }
    const skillConflicts = [...new Set([...status.declarations.skills, ...(inbound.get(status.id) ?? [])])].flatMap(
      (skillID) => {
        const target = activeByID.get(skillID)
        return target && skillID !== status.id ? [{ type: "skill" as const, id: skillID, name: target.name }] : []
      },
    )
    const instructionConflicts = status.declarations.instructions.flatMap((instructionID) =>
      instructions.has(instructionID)
        ? [{ type: "instruction" as const, id: instructionID, name: instructionID }]
        : [],
    )
    return { ...status, conflicts: [...skillConflicts, ...instructionConflicts] }
  })
}

export const SessionSkillStatus = { Conflict, Info, State, list }
