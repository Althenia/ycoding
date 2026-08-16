export type PromptSkill = {
  id: string
  name: string
  mention?: {
    start: number
    end: number
    text: string
  }
}

export function promptSkillMetadata(skills: readonly PromptSkill[]) {
  const selected = skills.filter((skill, index) => skill.id.trim() && skill.name.trim() && skills.findIndex((item) => item.id === skill.id) === index)
  if (!selected.length) return
  return { skills: selected.map((skill) => ({ id: skill.id, name: skill.name })) }
}

export function promptSkillsFromMetadata(value: unknown): PromptSkill[] {
  if (!value || typeof value !== "object") return []
  const skills = (value as Record<string, unknown>).skills
  if (!Array.isArray(skills)) return []
  return skills.flatMap((skill) => {
    if (!skill || typeof skill !== "object") return []
    const item = skill as Record<string, unknown>
    if (typeof item.id !== "string" || !item.id.trim() || typeof item.name !== "string" || !item.name.trim()) return []
    return [{ id: item.id, name: item.name }]
  })
}

/**
 * Skills the prompt activates: every `$id` typed or pasted in the text that matches an available
 * skill, plus menu-selected skills whose mention no longer appears in the text.
 */
export function promptSkillMentions(
  text: string,
  available: ReadonlyArray<{ id: string; name: string }>,
  selected: readonly PromptSkill[] = [],
) {
  const known = new Map(promptSkillsFromMetadata({ skills: available }).map((skill) => [skill.id, skill.name]))
  const mentioned = known.size
    ? [...text.matchAll(skillMatcher([...known.keys()]))].flatMap((match) => {
        const name = known.get(match[2])
        return name ? [{ id: match[2], name }] : []
      })
    : []
  return [...mentioned, ...selected.filter((skill) => !mentioned.some((item) => item.id === skill.id))]
}

export function segmentPromptSkills(text: string, skills: readonly PromptSkill[]) {
  const selected = new Map(promptSkillsFromMetadata({ skills }).map((skill) => [skill.id, skill.name]))
  const segments: Array<{ type: "text" | "skill"; value: string }> = []
  const ids = [...selected.keys()]
  if (!ids.length) return [{ type: "text" as const, value: text }]
  const matcher = skillMatcher(ids)
  let offset = 0
  for (const match of text.matchAll(matcher)) {
    const id = match[2]
    const name = id ? selected.get(id) : undefined
    if (!name || match.index === undefined) continue
    const start = match.index + match[1].length
    if (start > offset) segments.push({ type: "text", value: text.slice(offset, start) })
    segments.push({ type: "skill", value: `\u2726 ${name}` })
    offset = start + id.length + 1
  }
  if (offset < text.length) segments.push({ type: "text", value: text.slice(offset) })
  return segments
}

// Matches `$id` at whitespace boundaries, longest ID first so `$reviewer` never resolves to `review`.
function skillMatcher(ids: readonly string[]) {
  const escaped = ids
    .toSorted((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`))
    .join("|")
  return new RegExp(`(^|\\s)\\$(${escaped})(?=\\s|$)`, "g")
}
