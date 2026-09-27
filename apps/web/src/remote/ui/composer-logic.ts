import { type AgentAttachmentInput, type CatalogView, type FileAttachmentInput, type FileOption } from "../catalog"
import type { ModelRefView } from "../projection"

export type Trigger = "/" | "@" | "$" | "#"
export type MentionPart =
  | { readonly kind: "file"; readonly uri: string; readonly name?: string; readonly description?: string; readonly mention: { readonly start: number; readonly end: number; readonly text: string } }
  | { readonly kind: "agent"; readonly name: string; readonly mention: { readonly start: number; readonly end: number; readonly text: string } }
  | { readonly kind: "skill"; readonly id: string; readonly mention: { readonly start: number; readonly end: number; readonly text: string } }
export type ComposerOption = { readonly label: string; readonly description?: string; readonly kind: "command" | "file" | "agent" | "skill"; readonly value: string; readonly uri?: string }

export function orderedVariants(variants: readonly string[]): string[] {
  const intensity = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  return [...variants].sort((a, b) => {
    const left = intensity.indexOf(a.toLowerCase())
    const right = intensity.indexOf(b.toLowerCase())
    return (left < 0 ? intensity.length : left) - (right < 0 ? intensity.length : right)
  })
}

export function triggerAt(text: string, cursor: number): { trigger: Trigger; start: number; query: string } | undefined {
  const prefix = text.slice(0, cursor)
  const match = prefix.match(/(^|\s)([/@$#])([^\s]*)$/)
  if (!match) return undefined
  const trigger: Trigger = match[2] === "/" ? "/" : match[2] === "@" ? "@" : match[2] === "$" ? "$" : "#"
  const start = prefix.length - match[3]!.length - 1
  if (trigger === "/" && start !== 0) return undefined
  return { trigger, start, query: match[3]! }
}

function fuzzy(value: string, query: string): number {
  if (!query) return 1
  const target = value.toLocaleLowerCase()
  const search = query.toLocaleLowerCase()
  const at = target.indexOf(search)
  if (at >= 0) return 100 - at
  let offset = 0
  let score = 0
  for (const character of search) {
    const index = target.indexOf(character, offset)
    if (index < 0) return -Infinity
    offset = index + character.length
    score -= index
  }
  return score
}

export function optionsForTrigger(trigger: Trigger, query: string, catalog: CatalogView | undefined, files: readonly FileOption[]): ComposerOption[] {
  if (!catalog || catalog.status !== "ready") return []
  const skills: ComposerOption[] = catalog.skills.map((skill) => ({ label: `$${skill.id}`, description: skill.description ?? skill.name, kind: "skill", value: skill.id }))
  const agents: ComposerOption[] = catalog.agents.filter((agent) => !agent.hidden && agent.mode !== "primary" && agent.id !== "btw")
    .map((agent) => ({ label: `@${agent.id}`, description: agent.description ?? agent.name, kind: "agent", value: agent.id }))
  const resources: ComposerOption[] = [...catalog.references, ...catalog.resources]
    .map((resource) => ({ label: `@${resource.name}`, description: resource.description, kind: "file", value: resource.name, uri: resource.uri }))
  const candidates: ComposerOption[] = trigger === "/"
    ? [...catalog.commands.map((command) => ({ label: `/${command.name}`, description: command.description, kind: "command" as const, value: command.name })), ...skills.filter((skill) => catalog.skills.find((entry) => entry.id === skill.value)?.slash).map((skill) => ({ ...skill, label: `/${skill.value}` }))]
    : trigger === "@" ? [...catalog.references.map((resource) => resources.find((item) => item.uri === resource.uri)!), ...agents, ...catalog.resources.map((resource) => resources.find((item) => item.uri === resource.uri)!), ...files.map((file) => ({ label: `@${file.path}`, kind: "file" as const, value: file.path, uri: file.uri }))]
      : trigger === "$" ? skills : [...skills.map((skill) => ({ ...skill, label: catalog.skills.find((item) => item.id === skill.value)?.name ?? skill.label })), ...agents.map((agent) => ({ ...agent, label: catalog.agents.find((item) => item.id === agent.value)?.name ?? agent.label }))]
  return candidates.map((option) => ({ option, score: Math.max(fuzzy(option.value, query), fuzzy(option.description ?? "", query) - 20) }))
    .filter((entry) => entry.score > -Infinity)
    .sort((a, b) => b.score - a.score || a.option.label.localeCompare(b.option.label))
    .map((entry) => entry.option)
}

export function applyMention(text: string, start: number, end: number, option: ComposerOption, parts: readonly MentionPart[]) {
  const prefix = option.kind === "skill" && text[start] !== "/" ? "$" : option.kind === "command" || text[start] === "/" ? "/" : "@"
  const mention = `${prefix}${option.value}`
  const next = `${text.slice(0, start)}${mention}${text[end] === " " ? "" : " "}${text.slice(end)}`
  const retained = reconcileMentions(text, next, parts)
  if (option.kind === "command" || prefix === "/") return { text: next, cursor: start + mention.length + (text[end] === " " ? 0 : 1), parts: retained }
  const range = { start, end: start + mention.length, text: mention }
  const part: MentionPart = option.kind === "skill" ? { kind: "skill", id: option.value, mention: range }
    : option.kind === "agent" ? { kind: "agent", name: option.value, mention: range }
      : { kind: "file", uri: option.uri!, name: option.value, mention: range }
  return { text: next, cursor: start + mention.length + (text[end] === " " ? 0 : 1), parts: [...retained, part] }
}

export function reconcileMentions(before: string, after: string, parts: readonly MentionPart[]): MentionPart[] {
  let first = 0
  while (first < before.length && first < after.length && before[first] === after[first]) first++
  let sharedEnd = 0
  while (sharedEnd < before.length - first && sharedEnd < after.length - first && before[before.length - sharedEnd - 1] === after[after.length - sharedEnd - 1]) sharedEnd++
  const oldEnd = before.length - sharedEnd
  const shift = after.length - before.length
  return parts.flatMap((part) => {
    if (part.mention.start < oldEnd && part.mention.end > first) return []
    const start = part.mention.start >= oldEnd ? part.mention.start + shift : part.mention.start
    return after.slice(start, start + part.mention.text.length) === part.mention.text
      ? [{ ...part, mention: { ...part.mention, start, end: start + part.mention.text.length } }]
      : []
  })
}

export function submission(text: string, parts: readonly MentionPart[], catalog: CatalogView | undefined, delivery: "steer" | "queue", agent?: string, model?: ModelRefView) {
  const trimmed = text.trim()
  const command = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  const files: FileAttachmentInput[] = parts.filter((part): part is Extract<MentionPart, { kind: "file" }> => part.kind === "file")
    .map((part) => ({ uri: part.uri, name: part.name, description: part.description, mention: part.mention }))
  const agents: AgentAttachmentInput[] = parts.filter((part): part is Extract<MentionPart, { kind: "agent" }> => part.kind === "agent")
    .map((part) => ({ name: part.name, mention: part.mention }))
  const base = { delivery, ...(files.length ? { files } : {}), ...(agents.length ? { agents } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}) }
  if (command && catalog?.commands.some((item) => item.name === command[1])) return { kind: "command" as const, input: { command: command[1]!, ...(command[2] ? { arguments: command[2] } : {}), ...base } }
  const skills = [...new Set([...parts.filter((part): part is Extract<MentionPart, { kind: "skill" }> => part.kind === "skill").map((part) => part.id), ...[...trimmed.matchAll(/(?:^|\s)\$([^\s]+)/g)].map((match) => match[1]!).filter((id) => catalog?.skills.some((skill) => skill.id === id)), ...(command && catalog?.skills.some((skill) => skill.id === command[1] && skill.slash) ? [command[1]!] : [])])]
  return { kind: "prompt" as const, input: { text: trimmed, ...base, ...(skills.length ? { skills } : {}) } }
}
