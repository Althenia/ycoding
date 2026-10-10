import path from "path"
import type { SessionMessageInfo, SessionSkillsOutput } from "@ycoding-ai/client"

export type SessionSkill = {
  id: string
  name: string
  activatedBy: "reference" | "tool"
  activationMessageID: string
  content: string
  conflicts: ReadonlyArray<{ type: "skill" | "instruction"; id: string; name: string }>
  declarations: unknown
  state: "active" | "inactive"
  inactiveReason?: SessionSkillsOutput[number]["inactiveReason"]
  scope?: "project" | "global"
}

export function sessionSkillScope(input: {
  location?: string
  projectDirectory?: string
  home: string
  globalConfigDirectory: string
}): "project" | "global" | undefined {
  const location = input.location
  if (!location) return undefined
  if (input.projectDirectory && contains(input.projectDirectory, location)) return "project"
  if (
    [
      path.join(input.home, ".agents", "skills"),
      path.join(input.home, ".claude", "skills"),
      path.join(input.globalConfigDirectory, "skills"),
    ].some((directory) => contains(directory, location))
  ) {
    return "global"
  }
  return undefined
}

export function filterSessionSkills(skills: ReadonlyArray<SessionSkill>, query: string) {
  const filter = query.trim().toLowerCase()
  if (!filter) return [...skills]
  return skills.filter((skill) => `${skill.id}\n${skill.name}`.toLowerCase().includes(filter))
}

export function groupSessionSkills(skills: ReadonlyArray<SessionSkill>) {
  return {
    active: skills.filter((skill) => skill.state === "active"),
    inactive: skills.filter((skill) => skill.state === "inactive"),
  }
}

export function sessionSkillLabel(skill: SessionSkill) {
  if (skill.state === "active") return skill.conflicts.length ? "ACTIVE - CONFLICT" : "ACTIVE"
  return skill.inactiveReason === "compacted" ? "INACTIVE - COMPACTED" : "INACTIVE - AGENT SWITCH"
}

export function activeSkillIDs(messages: ReadonlyArray<SessionMessageInfo>): ReadonlySet<string> {
  return messages.reduce((active, message) => {
    if (message.type === "skill") active.add(message.skill)
    if (message.type === "assistant")
      message.content.forEach((part) => {
        if (part.type !== "tool" || part.name !== "skill" || part.state.status !== "completed") return
        const id = recordValue(part.state.input)?.id
        if (typeof id === "string" && recordValue(part.state.structured)?.alreadyActive !== true) active.add(id)
      })
    if (message.type === "skill" || message.type === "assistant")
      message.skillDeactivations?.forEach((deactivation) => active.delete(deactivation.skill))
    if (message.type === "agent-switched" || (message.type === "compaction" && message.status === "completed")) active.clear()
    return active
  }, new Set<string>())
}

function recordValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function sessionSkillContent(content: unknown) {
  return typeof content === "string" ? content : ""
}

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
}
