export type SessionSkill = {
  id: string
  name: string
  activatedBy: "reference" | "tool"
  activationMessageID: string
  content: string
  conflicts: ReadonlyArray<{ type: "skill" | "instruction"; id: string; name: string }>
  declarations: unknown
  state: "active" | "inactive"
  inactiveReason?: "agent_switched" | "compacted"
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

export function sessionSkillContent(content: unknown) {
  return typeof content === "string" ? content : ""
}
