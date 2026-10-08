import { catalogKey, type AgentAttachmentInput, type CatalogTarget, type CatalogView, type FileAttachmentInput, type FileOption, type ModelOption } from "../catalog"
import type { ModelRefView } from "../projection"

export type Trigger = "/" | "@" | "$" | "#"
export type MentionPart =
  | { readonly kind: "file"; readonly uri: string; readonly name?: string; readonly description?: string; readonly mention: { readonly start: number; readonly end: number; readonly text: string } }
  | { readonly kind: "agent"; readonly name: string; readonly mention: { readonly start: number; readonly end: number; readonly text: string } }
  | { readonly kind: "skill"; readonly id: string; readonly mention: { readonly start: number; readonly end: number; readonly text: string } }
export type ComposerOption = { readonly label: string; readonly description?: string; readonly kind: "command" | "file" | "agent" | "skill"; readonly value: string; readonly uri?: string }
const unsupportedSlashActions = new Set(["cd", "editor", "skills", "btw", "btw-send", "daybreak", "move"])

export function orderedVariants(variants: readonly string[]): string[] {
  const intensity = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  return [...variants].sort((a, b) => {
    const left = intensity.indexOf(a.toLowerCase())
    const right = intensity.indexOf(b.toLowerCase())
    return (left < 0 ? intensity.length : left) - (right < 0 ? intensity.length : right)
  })
}

export function sameModel(left: ModelRefView | undefined, right: ModelRefView | undefined): boolean {
  return left !== undefined && right !== undefined && left.providerID === right.providerID && left.id === right.id && left.variant === right.variant && left.profile === right.profile
}

export function variantsForModel(model: ModelOption | undefined, profile: string | undefined) {
  if (model === undefined) return []
  if (profile === undefined) return model.variants
  return model.profiles?.find((item) => item.name === profile)?.variants ?? []
}

export function modelSelectionKey(target: CatalogTarget | undefined, deviceID: string | undefined, generation: number) {
  return target === undefined ? undefined : JSON.stringify([catalogKey(target), deviceID ?? null, generation])
}

export function modelSelection(models: readonly ModelOption[], selected: ModelRefView | undefined): { readonly model?: ModelRefView; readonly warning?: string; readonly blocked?: boolean } {
  if (!selected) return {}
  const option = models.find((item) => item.providerID === selected.providerID && item.id === selected.id)
  if (!option) return { model: selected, blocked: true, warning: `Model ${selected.id} is not offered by this machine. Choose another model before sending.` }
  const profile = selected.profile === undefined ? undefined : option.profiles?.find((item) => item.name === selected.profile)
  if (selected.profile !== undefined && profile === undefined) return { model: selected, blocked: true,
    warning: `Profile ${selected.profile} is not offered for ${option.name}. Choose an available profile or use the provider default before sending.` }
  if (selected.profile === undefined && option.enabled === false) return { model: selected, blocked: true,
    warning: `${option.name} requires a named profile. Choose an available profile before sending.` }
  if (selected.variant !== undefined && !variantsForModel(option, selected.profile).includes(selected.variant)) return { model: selected, blocked: true,
    warning: `Saved effort ${selected.variant} is not offered${selected.profile === undefined ? ` for ${option.name}` : ` by profile ${selected.profile} for ${option.name}`}. Clear the reasoning effort override, or select this model again and choose an offered effort before sending.` }
  return { model: selected }
}

export function visibleModels(models: readonly ModelOption[]): ModelOption[] {
  return models.filter((item) => !item.id.endsWith("-fast") || !models.some((base) => base.providerID === item.providerID && base.id === item.id.slice(0, -5)))
}

export function orderedModelOptions(models: readonly ModelOption[], recent: readonly ModelRefView[], selected: ModelRefView | undefined): (ModelOption & { readonly recentSelection?: ModelRefView })[] {
  const available = visibleModels(models)
  const seenRecent = new Set<string>()
  const recentOptions = recent.flatMap((model) => {
    const option = available.find((item) => item.providerID === model.providerID && item.id === model.id)
    const key = option ? JSON.stringify([option.providerID, option.id, model.profile]) : ""
    if (!option || seenRecent.has(key)) return []
    seenRecent.add(key)
    return [{ ...option, recentSelection: model }]
  })
  const recentKeys = new Set(recentOptions.map((item) => JSON.stringify([item.providerID, item.id])))
  const remaining = available.filter((item) => !recentKeys.has(JSON.stringify([item.providerID, item.id])))
  const providers = [...new Set(remaining.map((item) => item.providerID))].sort((left, right) => {
    if (left === selected?.providerID) return right === selected.providerID ? 0 : -1
    if (right === selected?.providerID) return 1
    return left.localeCompare(right)
  })
  return [...recentOptions, ...providers.flatMap((provider) => remaining.filter((item) => item.providerID === provider))]
}

export function pairedFastModel(models: readonly ModelOption[], selected: ModelRefView | undefined) {
  const current = models.find((item) => item.providerID === selected?.providerID && item.id === selected.id)
  if (!current) return undefined
  const base = current.id.endsWith("-fast") ? models.find((item) => item.providerID === current.providerID && item.id === current.id.slice(0, -5)) : current
  const fast = base && models.find((item) => item.providerID === base.providerID && item.id === `${base.id}-fast`)
  return base && fast ? { base, fast, active: current.id === fast.id } : undefined
}

export function switchFastModel(models: readonly ModelOption[], selected: ModelRefView | undefined): ModelRefView | undefined {
  const pair = pairedFastModel(models, selected)
  if (!pair) return undefined
  const target = pair.active ? pair.base : pair.fast
  const profile = selected?.providerID === target.providerID ? selected.profile : undefined
  const variant = selected?.variant && variantsForModel(target, profile).includes(selected.variant) ? selected.variant : undefined
  return modelSelection([target], { providerID: target.providerID, id: target.id, ...(variant ? { variant } : {}), ...(profile ? { profile } : {}) }).model
}

export function profileForModel(models: readonly ModelOption[], current: ModelRefView | undefined, target: ModelOption) {
  return current?.providerID === target.providerID ? current.profile : undefined
}

export function effortLevel(variant: string | undefined) {
  const level = variant?.toLowerCase()
  return level === "none" || level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max" ? level : "fallback"
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

export function tokenKey(match: { readonly trigger: Trigger; readonly start: number; readonly query: string }): string {
  return `${match.trigger}${match.start}:${match.query}`
}

export function suggestionTrigger(text: string, cursor: number, dismissed: string | undefined) {
  const match = triggerAt(text, cursor)
  return match && tokenKey(match) !== dismissed ? match : undefined
}

export function autocompleteBound(availableAbove: number, viewportHeight: number, phone = false): number {
  const share = phone ? viewportHeight * 0.75 : Math.min(360, viewportHeight * 0.4)
  return Math.floor(Math.max(54, Math.min(share, availableAbove - 8)))
}

export function sheetFrame(viewport: { readonly offsetTop: number; readonly height: number } | undefined): { readonly top: number; readonly height: number } | undefined {
  if (!viewport || !(viewport.height > 0)) return undefined
  return { top: Math.max(0, Math.round(viewport.offsetTop)), height: Math.round(viewport.height) }
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

export function needsCatalogRead(target: CatalogTarget | undefined, catalog: CatalogView | undefined, transportOpen: boolean) {
  return target !== undefined && transportOpen && catalog === undefined
}

export function optionsForTrigger(trigger: Trigger, query: string, catalog: CatalogView | undefined, files: readonly FileOption[], sessionActions = true): ComposerOption[] {
  if (!catalog || catalog.status !== "ready") return []
  const skills: ComposerOption[] = catalog.skills.map((skill) => ({ label: `$${skill.id}`, description: skill.description ?? skill.name, kind: "skill", value: skill.id }))
  const agents: ComposerOption[] = catalog.agents.filter((agent) => !agent.hidden && agent.mode !== "primary" && agent.id !== "btw")
    .map((agent) => ({ label: `@${agent.id}`, description: agent.description ?? agent.name, kind: "agent", value: agent.id }))
  const resources: ComposerOption[] = [...catalog.references, ...catalog.resources]
    .map((resource) => ({ label: `@${resource.name}`, description: resource.description, kind: "file", value: resource.name, uri: resource.uri }))
  const candidates: ComposerOption[] = trigger === "/"
    ? [...(sessionActions ? [{ label: "/compact", description: "Compact this Session's context", kind: "command" as const, value: "compact" }, { label: "/goal", description: "Set an autonomous goal", kind: "command" as const, value: "goal" }, { label: "/yolo", description: "Set the autonomy level", kind: "command" as const, value: "yolo" }] : []), ...catalog.commands.filter((command) => !unsupportedSlashActions.has(command.name) && command.name !== "compact" && (!sessionActions || command.name !== "goal" && command.name !== "yolo")).map((command) => ({ label: `/${command.name}`, description: command.description, kind: "command" as const, value: command.name })), ...(sessionActions ? skills.filter((skill) => catalog.skills.find((entry) => entry.id === skill.value)?.slash).map((skill) => ({ ...skill, label: `/${skill.value}` })) : [])]
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

export function submission(text: string, parts: readonly MentionPart[], catalog: CatalogView | undefined, delivery: "steer" | "queue", agent?: string, model?: ModelRefView, forceModelSwitch = false) {
  const trimmed = text.trim()
  const command = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (command?.[1] === "compact") return command[2]?.trim()
    ? { kind: "invalid" as const, message: "Use /compact without arguments." }
    : { kind: "compact" as const }
  if (command?.[1] === "goal") return command[2]?.trim()
    ? { kind: "goal" as const, input: { goal: command[2].trim() } }
    : { kind: "invalid" as const, message: "Enter goal text after /goal." }
  if (command?.[1] === "yolo") {
    const level = command[2]?.trim()
    const parsed: 0 | 1 | 2 | 3 | undefined = level === "0" ? 0 : level === "1" ? 1 : level === "2" ? 2 : level === "3" ? 3 : undefined
    if (level && parsed === undefined) return { kind: "invalid" as const, message: "Use /yolo with a level from 0 to 3." }
    return { kind: "yolo" as const, input: parsed === undefined ? {} : { level: parsed } }
  }
  if (command && unsupportedSlashActions.has(command[1]!)) return { kind: "invalid" as const, message: "This slash action is unavailable in the web composer." }
  const files: FileAttachmentInput[] = parts.filter((part): part is Extract<MentionPart, { kind: "file" }> => part.kind === "file")
    .map((part) => ({ uri: part.uri, name: part.name, description: part.description, mention: part.mention }))
  const agents: AgentAttachmentInput[] = parts.filter((part): part is Extract<MentionPart, { kind: "agent" }> => part.kind === "agent")
    .map((part) => ({ name: part.name, mention: part.mention }))
  const base = { delivery, ...(files.length ? { files } : {}), ...(agents.length ? { agents } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(forceModelSwitch ? { forceModelSwitch: true } : {}) }
  if (command && catalog?.commands.some((item) => item.name === command[1])) return { kind: "command" as const, input: { command: command[1]!, ...(command[2] ? { arguments: command[2] } : {}), ...base } }
  if (command && catalog?.skills.some((skill) => skill.id === command[1] && skill.slash)) return { kind: "skill" as const, input: { skill: command[1]! } }
  const skills = [...new Set([...parts.filter((part): part is Extract<MentionPart, { kind: "skill" }> => part.kind === "skill").map((part) => part.id), ...(catalog?.skills ?? []).filter((skill) => new RegExp(`(^|\\s)\\$${skill.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s.,!?;:)\\]'"\x60]|$)`).test(trimmed)).map((skill) => skill.id)])]
  return { kind: "prompt" as const, input: { text: trimmed, ...base, ...(skills.length ? { skills } : {}) } }
}
