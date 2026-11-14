import { utf8Length, type FormRequest, type Messages, type SessionFileChanges, type ModelOption, type ModelProfileOption, type ModelSelection, type SessionItem, type Sessions } from "./contract"

export type Field = FormRequest["fields"][number]
export type Value = string | boolean | string[]
export type Values = Readonly<Record<string, Value>>
export type Answer = string | number | boolean | string[]
export type Rule = { readonly key: string; readonly op: "eq" | "neq"; readonly value: string | number | boolean }

const unanswered = (raw: Value | undefined) => raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)

export function valueFor(values: Values, key: string): Value | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined
}

export function withValue(values: Values, key: string, value: Value): Values {
  return Object.fromEntries([...Object.entries(values).filter(([entry]) => entry !== key), [key, value]])
}

export function answerOf(item: Field, raw: Value | undefined): Answer | undefined {
  if (item.type === "external") return raw === true ? true : undefined
  if (unanswered(raw) || raw === undefined) return undefined
  if (item.type === "number" || item.type === "integer") {
    const number = typeof raw === "string" ? Number(raw) : Number.NaN
    return Number.isFinite(number) ? number : undefined
  }
  return raw
}

export function matches(rule: Rule, answer: Answer | undefined) {
  if (answer === undefined) return false
  const hit = Array.isArray(answer) ? answer.some((entry) => entry === rule.value) : answer === rule.value
  return rule.op === "eq" ? hit : !hit
}

export function activeFields(fields: readonly Field[], values: Values) {
  const answers = new Map<string, Answer>()
  const active: Field[] = []
  for (const item of fields) {
    if (item.type !== "external" && !(item.when ?? []).every((rule) => matches(rule, answers.get(rule.key)))) continue
    active.push(item)
    const answer = answerOf(item, valueFor(values, item.key))
    if (answer !== undefined) answers.set(item.key, answer)
  }
  return active
}

export function initialValues(fields: readonly Field[]): Values {
  return Object.fromEntries(fields.map((item): [string, Value] => [item.key,
    item.type === "external" ? false : item.type === "boolean" ? item.default ?? false : item.type === "multiselect" ? [...item.default ?? []] : item.default === undefined ? "" : String(item.default)]))
}

function isUri(value: string) {
  try { return new URL(value).href.length > 0 } catch { return false }
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isDateTime(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}

export function problemOf(item: Field, raw: Value | undefined) {
  if (item.type === "external") return raw === true ? undefined : "Acknowledge this step to continue."
  if (unanswered(raw)) return item.required ? "Required." : undefined
  if (item.type === "boolean") return undefined
  if (item.type === "multiselect") {
    const count = Array.isArray(raw) ? raw.length : 0
    return item.minItems !== undefined && count < item.minItems ? `Choose at least ${item.minItems}.` : item.maxItems !== undefined && count > item.maxItems ? `Choose at most ${item.maxItems}.` : undefined
  }
  if (typeof raw !== "string") return "Enter a valid value."
  if (item.type === "string") {
    if (item.minLength !== undefined && raw.length < item.minLength) return `Use at least ${item.minLength} characters.`
    if (item.maxLength !== undefined && raw.length > item.maxLength) return `Use at most ${item.maxLength} characters.`
    if (item.pattern !== undefined) {
      try { if (!new RegExp(item.pattern).test(raw)) return "Does not match the required pattern." }
      catch { return "This field's pattern is invalid, so it cannot be answered. Cancel the form." }
    }
    if (item.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return "Enter an email address."
    if (item.format === "uri" && !isUri(raw)) return "Enter a full URL such as https://example.com."
    if (item.format === "date" && !isDate(raw)) return "Enter a real date as YYYY-MM-DD."
    if (item.format === "date-time" && !isDateTime(raw)) return "Enter a valid date and time."
    return undefined
  }
  const number = Number(raw)
  if (!Number.isFinite(number)) return "Enter a number."
  if (item.type === "integer" && !Number.isInteger(number)) return "Enter a whole number."
  return item.minimum !== undefined && number < item.minimum ? `Use ${item.minimum} or more.` : item.maximum !== undefined && number > item.maximum ? `Use ${item.maximum} or less.` : undefined
}

export function buildAnswer(fields: readonly Field[], values: Values): Record<string, Answer> {
  return Object.fromEntries(activeFields(fields, values).flatMap((item): [string, Answer][] => {
    const value = answerOf(item, valueFor(values, item.key))
    return value === undefined ? [] : [[item.key, value]]
  }))
}

export type ModelChoice = { readonly model: number; readonly profile: string; readonly variant: string }

export function variantsFor(model: ModelOption | undefined, profile: string): readonly string[] {
  if (!model) return []
  return profile === "" ? model.variants : model.profiles.find((item) => item.name === profile)?.variants ?? []
}

export function selectionFor(models: readonly ModelOption[], choice: ModelChoice): ModelSelection | undefined {
  const model = models[choice.model]
  if (!model) return undefined
  if (choice.profile === "" ? !model.enabled : !model.profiles.some((item) => item.name === choice.profile)) return undefined
  if (choice.variant !== "" && !variantsFor(model, choice.profile).includes(choice.variant)) return undefined
  return { id: model.id, providerID: model.providerID, ...(choice.variant === "" ? {} : { variant: choice.variant }), ...(choice.profile === "" ? {} : { profile: choice.profile }) }
}

export function choiceFor(models: readonly ModelOption[], selection: ModelSelection | null | undefined): ModelChoice {
  const model = selection ? models.findIndex((item) => item.id === selection.id && item.providerID === selection.providerID) : -1
  return model < 0 || !selection ? { model: -1, profile: "", variant: "" } : { model, profile: selection.profile ?? "", variant: selection.variant ?? "" }
}

export function chooseModel(models: readonly ModelOption[], index: number): ModelChoice {
  const model = models[index]
  if (!model) return { model: -1, profile: "", variant: "" }
  return { model: index, profile: model.enabled ? "" : (model.profiles.find((item) => item.active) ?? model.profiles[0])?.name ?? "", variant: "" }
}

export function chooseProfile(models: readonly ModelOption[], choice: ModelChoice, profile: string): ModelChoice {
  return { model: choice.model, profile, variant: variantsFor(models[choice.model], profile).includes(choice.variant) ? choice.variant : "" }
}

export function sameSelection(left: ModelSelection | null | undefined, right: ModelSelection | null | undefined) {
  return !!left && !!right && left.id === right.id && left.providerID === right.providerID && left.variant === right.variant && left.profile === right.profile
}

export const modelLabel = (model: ModelOption) => `${model.name}${model.status === "active" ? "" : ` (${model.status})`}${model.enabled ? "" : " — not enabled"}`

export const profileLabel = (profile: ModelProfileOption) => profile.active ? `${profile.name} (active)` : profile.name

export const searchLimit = 256

export function searchTerm(raw: string): { readonly value: string; readonly error?: string } {
  const value = raw.trim()
  return utf8Length(value) > searchLimit ? { value: "", error: `Search is limited to ${searchLimit} bytes. Shorten it.` } : { value }
}

export type Paging = { readonly revision: number; readonly search: string; readonly firstNext?: string; readonly extra: readonly SessionItem[]; readonly next?: string }

export function mergeItems(...lists: readonly (readonly SessionItem[])[]): SessionItem[] {
  const seen = new Set<string>()
  const merged: SessionItem[] = []
  for (const item of lists.flat()) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

export function pagingFor(first: Sessions, search: string, paging: Paging | undefined): Paging {
  return paging && paging.search === search && paging.revision === first.revision && paging.firstNext === first.next
    ? paging
    : { revision: first.revision, search, extra: [], ...(first.next === undefined ? {} : { firstNext: first.next, next: first.next }) }
}

export function appendPage(paging: Paging, page: Sessions): Paging | undefined {
  if (page.revision !== paging.revision) return undefined
  return { revision: paging.revision, search: paging.search, ...(paging.firstNext === undefined ? {} : { firstNext: paging.firstNext }), extra: mergeItems(paging.extra, page.items), ...(page.next === undefined ? {} : { next: page.next }) }
}

export const pagedItems = (first: Sessions, paging: Paging) => mergeItems(first.items, paging.extra)

export type Activity = { readonly busy: ReadonlySet<string>; readonly waiting: ReadonlyMap<string, ReadonlySet<string>> }
export type GroupKey = "needs" | "running" | "pinned" | "recent"
const groupLabels: Record<GroupKey, string> = { needs: "Needs action", running: "Running", pinned: "Pinned", recent: "Recent" }
const groupOrder: readonly GroupKey[] = ["needs", "running", "pinned", "recent"]

function rootOf(rows: ReadonlyMap<string, SessionItem>, id: string) {
  let current = rows.get(id)
  for (let hops = 0; current?.parentID !== undefined && hops < 16; hops++) {
    const parent = rows.get(current.parentID)
    if (!parent) break
    current = parent
  }
  return current?.id
}

export function railGroups(rows: readonly SessionItem[], state: Activity) {
  const byID = new Map(rows.map((row) => [row.id, row] as const))
  const roots = (ids: Iterable<string>) => new Set([...ids].flatMap((id) => rootOf(byID, id) ?? []))
  const needs = roots([...state.waiting].flatMap(([id, requests]) => requests.size ? [id] : []))
  const running = roots(state.busy)
  const groups: Record<GroupKey, SessionItem[]> = { needs: [], running: [], pinned: [], recent: [] }
  let archived = 0
  for (const row of rows) {
    if (row.parentID !== undefined && byID.has(row.parentID)) continue
    const key: GroupKey = needs.has(row.id) ? "needs" : running.has(row.id) ? "running" : row.time.pinned !== undefined ? "pinned" : "recent"
    if (row.time.archived !== undefined && (key === "pinned" || key === "recent")) { archived++; continue }
    groups[key].push(row)
  }
  const newest = (a: SessionItem, b: SessionItem) => (b.time.active ?? b.time.updated) - (a.time.active ?? a.time.updated) || a.id.localeCompare(b.id)
  return { groups: groupOrder.flatMap((key) => groups[key].length ? [{ key, label: groupLabels[key], rows: groups[key].sort(newest) }] : []), archived }
}

export function visibleModels(models: readonly ModelOption[], current: ModelSelection | null | undefined): ModelOption[] {
  return models.filter((model) => model.status !== "deprecated" || (!!current && model.id === current.id && model.providerID === current.providerID))
}

export function choiceProblem(models: readonly ModelOption[], choice: ModelChoice): string | undefined {
  const model = models[choice.model]
  if (!model) return undefined
  if (choice.profile === "" ? !model.enabled : !model.profiles.some((item) => item.name === choice.profile))
    return choice.profile === "" ? "This model is not enabled. Choose a profile or another model." : "The current profile is no longer listed for this model. Choose a listed profile or another model."
  if (choice.variant !== "" && !variantsFor(model, choice.profile).includes(choice.variant)) return "The current variant is no longer listed. Choose a listed variant."
  return undefined
}

export function invalidIndexes(fields: readonly Field[], values: Values): number[] {
  return activeFields(fields, values).flatMap((item) => problemOf(item, valueFor(values, item.key)) === undefined ? [] : [fields.indexOf(item)])
}

export function samePaging(left: Paging | undefined, right: Paging | undefined) {
  return !!left && !!right && left.revision === right.revision && left.search === right.search && left.firstNext === right.firstNext && left.next === right.next && left.extra.length === right.extra.length
}

export type FocusAt = "body" | "card" | "control" | "elsewhere"

export const restoresFocus = (wasLocked: boolean, locked: boolean, focusAt: FocusAt) =>
  wasLocked && !locked && (focusAt === "body" || focusAt === "card")

export type ComposerTrigger = { readonly kind: "command" | "skill" | "mention"; readonly start: number; readonly query: string }

const triggerWord = /^[A-Za-z0-9_-]*$/

export function composerTrigger(text: string, caret: number): ComposerTrigger | undefined {
  const at = Math.max(0, Math.min(caret, text.length))
  let start = at
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  const token = text.slice(start, at)
  if (!token) return undefined
  const marker = token[0]
  if (marker === "/") {
    if (start !== 0 && text[start - 1] !== "\n") return undefined
    const query = token.slice(1)
    return triggerWord.test(query) ? { kind: "command", start, query } : undefined
  }
  if (marker === "$") {
    const query = token.slice(1)
    return triggerWord.test(query) ? { kind: "skill", start, query } : undefined
  }
  if (marker === "@") return { kind: "mention", start, query: token.slice(1) }
  return undefined
}

export function insertCompletion(text: string, start: number, caret: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length }
}

export type MentionPick =
  | { readonly kind: "file"; readonly display: string; readonly uri: string; readonly description?: string }
  | { readonly kind: "agent"; readonly display: string; readonly name: string }

export function mentionPayload(text: string, picks: readonly MentionPick[]) {
  const files: { uri: string; name: string; description?: string; mention: { start: number; end: number; text: string } }[] = []
  const agents: { name: string; mention: { start: number; end: number; text: string } }[] = []
  const searched = new Map<string, number>()
  for (const pick of picks) {
    const from = searched.get(pick.display) ?? 0
    const start = text.indexOf(pick.display, from)
    if (start < 0 || !pick.display) continue
    searched.set(pick.display, start + 1)
    const mention = { start, end: start + pick.display.length, text: pick.display }
    if (pick.kind === "file") {
      const path = pick.uri.startsWith("file://") ? pick.uri.slice("file://".length) : pick.uri
      files.push({ uri: pick.uri, name: path.split("/").filter(Boolean).at(-1) ?? path, ...(pick.description ? { description: pick.description } : {}), mention })
    } else agents.push({ name: pick.name, mention })
  }
  return { files, agents }
}

export type SlashAction = { readonly kind: "local" | "backend"; readonly name: string; readonly args: string } | { readonly kind: "prompt" }

export function slashAction(text: string, local: readonly string[], backend: readonly string[]): SlashAction {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/.exec(text)
  if (!match) return { kind: "prompt" }
  const name = match[1]!
  const args = (match[2] ?? "").trim()
  if (local.includes(name)) return { kind: "local", name, args }
  if (backend.includes(name)) return { kind: "backend", name, args }
  return { kind: "prompt" }
}

export function workspaceBase(directory: string): string {
  const trimmed = directory.replace(/\/+$/, "")
  const base = trimmed.split("/").filter(Boolean).at(-1)
  return base ?? "Root (/)"
}

export type SyntheticCard =
  | { readonly kind: "subagent"; readonly label: string; readonly status: "completed" | "failed" | "waiting" | "updated"; readonly excerpt?: string }
  | { readonly kind: "completion"; readonly label: string; readonly status: string; readonly description: string }
  | { readonly kind: "goal"; readonly text: string }
  | { readonly kind: "member"; readonly label: string; readonly event: string; readonly memberSessionID: string; readonly excerpt?: string; readonly escalatedBy?: string }
  | { readonly kind: "parent-answer"; readonly text: string }
  | { readonly kind: "note"; readonly text: string }

export type AssistantContentPart = Extract<Messages[number], { type: "assistant" }>["content"][number]
export type AssistantToolPart = Extract<AssistantContentPart, { type: "tool" }>

export type AssistantPartGroup =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "reasoning"; readonly key: string; readonly text: string; readonly created?: number; readonly completed?: number }
  | { readonly kind: "tools"; readonly key: string; readonly parts: readonly AssistantToolPart[] }

export type EffortTone = "unselected" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
export type EffortStop = { readonly value: string; readonly label: string; readonly tone: EffortTone }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const nonEmptyString = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined

const trimmedString = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined

export function desktopPartVisible(part: AssistantContentPart): boolean {
  if (part.type === "text" || part.type === "reasoning") return Boolean(part.text.trim())
  if (part.name === "goal") return false
  return !(part.name === "skill" && part.state.status === "completed" && isRecord(part.state.structured) && Reflect.get(part.state.structured, "alreadyActive") === true)
}

export function isInternalTranscriptEnvelope(message: Messages[number]): boolean {
  if (message.type !== "system" && message.type !== "synthetic") return false
  const metadata = message.metadata
  if (metadata?.contextSource === "session-state" || metadata?.contextSource === "team-view" || metadata?.compactionCheckpoint !== undefined || metadata?.decisionInputID !== undefined) return true
  const trimmed = message.text.trimStart()
  return message.text.startsWith("Authoritative current Session state (JSON):") || message.text.startsWith("Internal orchestration context (JSON).") || trimmed.startsWith("<system-update>") || trimmed.startsWith("<conversation-checkpoint>") || message.text.startsWith("Instructions from: ")
}

const memberEvents = ["started", "progress", "completed", "failed", "interrupted", "question", "permission", "review", "escalated"]

function parentAnswerText(message: Extract<Messages[number], { type: "synthetic" }>): string | undefined {
  const prefix = "Parent answer:\n"
  const metadata = message.metadata
  if (metadata?.kind !== "answer" || !message.text.startsWith(prefix)) return undefined
  try {
    const value: unknown = JSON.parse(message.text.slice(prefix.length))
    if (!isRecord(value) || typeof value.questionID !== "string" || value.questionID !== metadata.questionID) return undefined
    const answer = [typeof value.text === "string" ? value.text : undefined, value.data === undefined ? undefined : `\`\`\`json\n${JSON.stringify(value.data, null, 2)}\n\`\`\``].filter((entry) => entry !== undefined)
    return answer.length ? answer.join("\n\n") : undefined
  } catch {
    return undefined
  }
}

export function classifyDesktopSynthetic(message: Messages[number]): SyntheticCard | undefined {
  if (message.type !== "synthetic" || isInternalTranscriptEnvelope(message)) return undefined
  const metadata = message.metadata
  const description = message.description?.trim() ?? ""
  if (metadata?.source === "subagent_parent") {
    const text = parentAnswerText(message)
    if (text !== undefined) return { kind: "parent-answer", text }
  }
  if (metadata?.source === "project_notification") {
    const memberSessionID = nonEmptyString(metadata.memberSessionID)
    if (typeof metadata.event !== "string" || !memberEvents.includes(metadata.event) || memberSessionID === undefined) return undefined
    const excerpt = trimmedString(metadata.excerpt)
    const escalated = isRecord(metadata.escalatedBy) && metadata.event === "escalated" ? nonEmptyString(metadata.escalatedBy.sessionID) : undefined
    const escalatedBy = escalated === undefined || !isRecord(metadata.escalatedBy) ? undefined : nonEmptyString(metadata.escalatedBy.title) ?? escalated
    return { kind: "member", label: nonEmptyString(metadata.title) ?? memberSessionID, event: metadata.event, memberSessionID, ...(excerpt ? { excerpt } : {}), ...(escalatedBy ? { escalatedBy } : {}) }
  }
  if (metadata?.source === "subagent_notification") {
    const status = metadata.type === "completed" || metadata.type === "failed" || metadata.type === "waiting" ? metadata.type : "updated"
    const excerpt = trimmedString(metadata.excerpt)?.trim()
    return { kind: "subagent", label: nonEmptyString(metadata.agent) ?? nonEmptyString(metadata.childID) ?? "Subagent", status, ...(excerpt ? { excerpt } : {}) }
  }
  if ((metadata?.source === "subagent" || metadata?.source === "shell") && description) {
    const state = metadata.state
    const status = state === "completed" ? "finished" : state === "error" ? "failed" : state === "cancelled" ? "cancelled" : typeof state === "string" ? state : "finished"
    return { kind: "completion", label: metadata.source === "shell" ? "Shell" : nonEmptyString(metadata.agent) ?? "Subagent", status, description }
  }
  if (isRecord(metadata?.autonomy) && Reflect.get(metadata.autonomy, "goal") === true && message.text.trim()) return { kind: "goal", text: message.text }
  return description ? { kind: "note", text: description } : undefined
}

function compactionFailureCode(message: Extract<Messages[number], { type: "compaction" }>) {
  return "code" in message ? message.code : "error" in message && isRecord(message.error) ? Reflect.get(message.error, "code") : undefined
}

export function desktopMessageVisible(message: Messages[number]): boolean {
  if (isInternalTranscriptEnvelope(message)) return false
  if (message.type === "system") return Boolean(message.text.trim())
  if (message.type === "synthetic") return classifyDesktopSynthetic(message) !== undefined
  if (message.type === "compaction") {
    if (message.status === "running" || message.status === "completed") return true
    if (message.status !== "failed") return false
    const code = compactionFailureCode(message)
    return code === "cancelled" || code === "superseded" || !("jobID" in message) && code === "aborted"
  }
  if (message.type === "assistant") return message.content.some(desktopPartVisible) || message.time.completed !== undefined || message.error !== undefined || message.retry !== undefined
  return true
}

export function visibleDesktopMessages(messages: readonly Messages[number][]): readonly Messages[number][] {
  const positions = new Map(messages.map((message, index) => [message.id, index] as const))
  const boundary = messages.reduce((latest, message, index) => {
    if (message.type !== "compaction" || message.status !== "completed" || !("boundary" in message) || !message.boundary?.messageID) return latest
    const position = positions.get(message.boundary.messageID)
    return position !== undefined && position < index ? Math.max(latest, position) : latest
  }, -1)
  const visible = messages.filter((message, index) => (index > boundary || message.type === "compaction") && desktopMessageVisible(message))
  const latestCompaction = visible.findLast((message) => message.type === "compaction")?.id
  return visible.filter((message) => message.type !== "compaction" || message.id === latestCompaction)
}

export function groupAssistantParts(parts: readonly AssistantContentPart[]): readonly AssistantPartGroup[] {
  const groups: AssistantPartGroup[] = []
  parts.forEach((part, ordinal) => {
    if (!desktopPartVisible(part)) return
    const last = groups.at(-1)
    if (part.type === "text") groups.push({ kind: "text", key: `text:${ordinal}`, text: part.text })
    else if (part.type === "reasoning") {
      if (last?.kind === "reasoning") {
        const completed = part.time?.completed
        groups[groups.length - 1] = { kind: "reasoning", key: last.key, text: `${last.text}\n\n${part.text}`, ...(last.created === undefined ? {} : { created: last.created }), ...(completed === undefined ? {} : { completed }) }
      } else groups.push({ kind: "reasoning", key: `reasoning:${ordinal}`, text: part.text, ...(part.time ? { created: part.time.created, ...(part.time.completed === undefined ? {} : { completed: part.time.completed }) } : {}) })
    } else if (last?.kind === "tools") groups[groups.length - 1] = { kind: "tools", key: last.key, parts: [...last.parts, part] }
    else groups.push({ kind: "tools", key: `tools:${part.id}`, parts: [part] })
  })
  return groups
}

export function toolDisplaySummary(name: string, input: unknown): string {
  const field = (key: string) => {
    const value = isRecord(input) ? input[key] : undefined
    return typeof value === "string" ? value : undefined
  }
  const lower = name.toLowerCase()
  if (lower === "shell") {
    const command = field("command") ?? "Shell"
    return command.length > 72 ? `${command.slice(0, 35)}…${command.slice(-35)}` : command
  }
  if (lower === "read" || lower === "write" || lower === "edit" || lower === "patch") return `${lower[0]!.toUpperCase()}${lower.slice(1)} ${field("path") ?? "file"}`
  if (lower === "grep" || lower === "glob") return `${lower === "grep" ? "Grep" : "Glob"} "${field("pattern") ?? ""}"${field("path") ? ` in ${field("path")}` : ""}`
  if (lower === "subagent") return `${field("agent") ?? field("subagent_type") ?? "General"} Subagent — ${field("description") ?? "Subagent"}`
  if (lower === "skill") return `Skill "${field("id") ?? "skill"}"`
  return name
}

const effortLabels: Readonly<Record<string, string>> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max" }
const effortTones: readonly EffortTone[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

export function effortStopsFor(variants: readonly string[]): readonly EffortStop[] {
  if (variants.length === 0) return []
  return [{ value: "", label: "Default", tone: "unselected" }, ...variants.map((value): EffortStop => ({ value, label: effortLabels[value] ?? value, tone: effortTones.find((tone) => tone === value) ?? "medium" }))]
}

export function effortStopIndex(stops: readonly EffortStop[], variant: string): number {
  return Math.max(0, stops.findIndex((stop) => stop.value === variant))
}

export function effortStopFraction(index: number, count: number): number {
  return count <= 1 ? 0 : Math.max(0, Math.min(1, index / (count - 1)))
}

export type DesktopThemeID = "system" | "light" | "dark" | "onedark-light" | "onedark-dark" | "onedark-pro" | "high-contrast-light" | "high-contrast-dark"
export type DesktopThemeScheme = "onedark" | "onedark-pro" | "high-contrast"
export type DesktopTheme = { readonly id: DesktopThemeID; readonly label: string; readonly description: string; readonly mode: "system" | "light" | "dark"; readonly scheme?: DesktopThemeScheme }

export const DESKTOP_THEMES: ReadonlyArray<DesktopTheme> = [
  { id: "system", label: "System", description: "Follow the operating system appearance.", mode: "system" },
  { id: "light", label: "Light", description: "Default light palette.", mode: "light" },
  { id: "dark", label: "Dark", description: "Default dark palette.", mode: "dark" },
  { id: "onedark-light", label: "One Dark (light)", description: "One Light palette from the One Dark family.", mode: "light", scheme: "onedark" },
  { id: "onedark-dark", label: "One Dark", description: "One Dark palette.", mode: "dark", scheme: "onedark" },
  { id: "onedark-pro", label: "One Dark Pro", description: "One Dark Pro dark palette.", mode: "dark", scheme: "onedark-pro" },
  { id: "high-contrast-light", label: "High contrast (light)", description: "Black on white with saturated accents.", mode: "light", scheme: "high-contrast" },
  { id: "high-contrast-dark", label: "High contrast (dark)", description: "White on black with saturated accents.", mode: "dark", scheme: "high-contrast" },
]

export const isDesktopThemeID = (value: unknown): value is DesktopThemeID => DESKTOP_THEMES.some((theme) => theme.id === value)

export function resolveDesktopTheme(choice: DesktopThemeID, systemDark: boolean): { readonly theme: "light" | "dark"; readonly scheme?: DesktopThemeScheme } {
  const entry = DESKTOP_THEMES.find((theme) => theme.id === choice)
  const theme = entry === undefined || entry.mode === "system" ? systemDark ? "dark" : "light" : entry.mode
  return entry?.scheme === undefined ? { theme } : { theme, scheme: entry.scheme }
}

const builtInSlashCommands = [
  { name: "new", aliases: ["clear"], description: "Start a new chat" },
  { name: "compact", aliases: ["summarize"], description: "Compact the conversation" },
  { name: "connect", description: "Connect a provider" },
  { name: "mcp", aliases: ["mcps"], description: "Manage MCP servers" },
  { name: "status", description: "Show session and server status" },
  { name: "debug", description: "Show debug information" },
  { name: "models", aliases: ["mo"], description: "Choose a model" },
  { name: "variants", aliases: ["variant"], description: "Choose a reasoning variant" },
  { name: "agents", aliases: ["agent"], description: "Choose an agent" },
  { name: "skills", aliases: ["skill"], description: "Browse skills" },
  { name: "themes", aliases: ["theme"], description: "Choose a theme" },
  { name: "autonomous", description: "Set the autonomy mode" },
  { name: "goal", description: "Set or inspect the session goal" },
  { name: "daybreak", description: "Schedule or inspect a daybreak run" },
  { name: "rename", description: "Rename the session" },
  { name: "fork", description: "Fork the session" },
  { name: "move", description: "Move the session to another workspace" },
  { name: "undo", description: "Undo the last turn" },
  { name: "redo", description: "Redo the undone turn" },
  { name: "diff", description: "Show file changes" },
  { name: "terminals", aliases: ["terminal"], description: "Open terminals" },
  { name: "browser", aliases: ["chrome"], description: "Open the browser panel" },
  { name: "artifacts", description: "Browse artifacts" },
  { name: "plugins", description: "Manage plugins" },
  { name: "pair", description: "Pair another device" },
  { name: "remote", description: "Manage remote access" },
  { name: "dots", description: "Show activity dots" },
  { name: "keep-awake", description: "Keep the computer awake" },
  { name: "stash", description: "Stash or restore the prompt" },
  { name: "timeline", description: "Show the session timeline" },
  { name: "find", description: "Search the transcript" },
  { name: "copy", description: "Copy the last response" },
  { name: "export", description: "Export the transcript as Markdown" },
  { name: "help", aliases: ["shortcuts", "keys"], description: "Show commands and shortcuts" },
  { name: "workspaces", description: "Switch workspace" },
  { name: "projects", aliases: ["project-settings"], description: "Manage projects" },
  { name: "sessions", aliases: ["resume", "continue"], description: "Switch session" },
  { name: "usage", description: "Show usage" },
  { name: "settings", description: "Open settings" },
  { name: "toggle-thinking", aliases: ["thinking"], description: "Show or hide reasoning" },
] as const

export const DESKTOP_BUILT_IN_SLASH_COMMANDS: ReadonlyArray<{ readonly name: string; readonly aliases?: readonly string[]; readonly description: string }> = builtInSlashCommands

type BuiltInSlashKind = (typeof builtInSlashCommands)[number]["name"]
type ArgumentSlashKind = "goal" | "daybreak" | "rename" | "find"

export type DesktopSlashCommand =
  | { readonly kind: Exclude<BuiltInSlashKind, ArgumentSlashKind> }
  | { readonly kind: ArgumentSlashKind; readonly argument?: string }
  | { readonly kind: "backend"; readonly command: string; readonly arguments: string }

const argumentSlashKinds: readonly string[] = ["goal", "daybreak", "rename", "find"]

export function desktopSlashCommand(text: string, backendCommands: readonly string[]): DesktopSlashCommand | undefined {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/.exec(text)
  if (!match) return undefined
  const typed = match[1]!.toLowerCase()
  const rest = (match[2] ?? "").trim()
  const builtIn = DESKTOP_BUILT_IN_SLASH_COMMANDS.find((command) => command.name === typed || command.aliases?.includes(typed))
  if (builtIn) {
    const kind = builtIn.name as BuiltInSlashKind
    if (!argumentSlashKinds.includes(kind)) return { kind } as DesktopSlashCommand
    return (rest ? { kind, argument: rest } : { kind }) as DesktopSlashCommand
  }
  const command = backendCommands.find((name) => name.toLowerCase() === typed)
  return command === undefined ? undefined : { kind: "backend", command, arguments: rest }
}

export function validateFolderSegment(name: string): { readonly valid: true; readonly name: string } | { readonly valid: false; readonly error: string } {
  const trimmed = name.trim()
  if (trimmed === "") return { valid: false, error: "Enter a folder name." }
  if (trimmed === "." || trimmed === "..") return { valid: false, error: "Use a real folder name, not . or .." }
  if (/[/\\]/.test(trimmed)) return { valid: false, error: "A folder name cannot contain / or \\." }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { valid: false, error: "A folder name cannot contain control characters." }
  if (utf8Length(trimmed) > 255) return { valid: false, error: "A folder name is limited to 255 bytes. Shorten it." }
  return { valid: true, name: trimmed }
}

export function formatSessionExportMarkdown(input: { readonly title: string; readonly sessionID: string; readonly directory: string; readonly updatedAt?: number; readonly messages: Parameters<typeof visibleDesktopMessages>[0] }): string {
  const header = [`# ${input.title}`, "", `- Session: ${input.sessionID}`, `- Directory: ${input.directory}`, ...(input.updatedAt === undefined ? [] : [`- Updated: ${new Date(input.updatedAt).toISOString()}`])]
  const sections = visibleDesktopMessages(input.messages).flatMap((message): string[] => {
    if (message.type === "user") return [`## You\n\n${message.text}`]
    if (message.type === "system") return [message.text]
    if (message.type === "shell") return [`## Shell\n\n\`\`\`sh\n${message.command}\n\`\`\``]
    if (message.type !== "assistant") return []
    const body = groupAssistantParts(message.content).map((group) => group.kind === "text" ? group.text
      : group.kind === "reasoning" ? group.text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")
      : group.parts.map((tool) => `- \`${toolDisplaySummary(tool.name, tool.state.input)}\``).join("\n"))
    return body.length ? [`## Assistant\n\n${body.join("\n\n")}`] : []
  })
  return `${[header.join("\n"), ...sections].join("\n\n")}\n`
}

export type PromptStashEntry = { readonly id: string; readonly text: string; readonly directory?: string; readonly createdAt: number }

export const promptStashLimit = 25

export function parsePromptStashes(raw: string | null): readonly PromptStashEntry[] {
  if (!raw) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(value)) return []
  return value.flatMap((item): PromptStashEntry[] => isRecord(item) && typeof item.id === "string" && typeof item.text === "string" && item.text !== "" && typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
    ? [{ id: item.id, text: item.text, ...(typeof item.directory === "string" ? { directory: item.directory } : {}), createdAt: item.createdAt }]
    : []).slice(0, promptStashLimit)
}

export function pushPromptStash(entries: readonly PromptStashEntry[], entry: PromptStashEntry, max: number = promptStashLimit): readonly PromptStashEntry[] {
  return [entry, ...entries.filter((item) => item.id !== entry.id)].slice(0, Math.max(0, Math.min(max, promptStashLimit)))
}

const number = (maximumFractionDigits: number, minimumFractionDigits = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits, minimumFractionDigits })

export function formatCount(value: number): string {
  return Number.isFinite(value) ? number(0).format(Math.round(value) + 0) : "0"
}

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatUsd(value: number): string {
  return Number.isFinite(value) ? usdFormat.format(value + 0) : "$0.00"
}

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0"
  if (Math.abs(value) < 1_000) return formatCount(value)
  const suffixes = ["K", "M", "B", "T"]
  let tier = Math.min(suffixes.length, Math.floor(Math.log10(Math.abs(value)) / 3))
  let scaled = Math.round((value / 1_000 ** tier) * 10) / 10
  if (Math.abs(scaled) >= 1_000 && tier < suffixes.length) {
    tier++
    scaled = Math.round((value / 1_000 ** tier) * 10) / 10
  }
  return `${number(1).format(scaled)}${suffixes[tier - 1]}`
}

export function formatPercent(value: number, maxFractionDigits = 1): string {
  if (!Number.isFinite(value)) return "0%"
  const factor = 10 ** maxFractionDigits
  return `${number(maxFractionDigits).format(Math.round(value * factor) / factor + 0)}%`
}

export function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms"
  if (value < 1) return "<1 ms"
  if (value < 1_000) return `${number(value < 10 ? 1 : 0).format(value)} ms`
  if (value < 60_000) return `${number(2).format(value / 1_000)} s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
}

export type QuotaWindowLevel = "ok" | "warn" | "danger"
export type QuotaWindowInput = {
  readonly id?: string
  readonly label: string
  readonly group?: string
  readonly used?: number
  readonly limit?: number
  readonly remaining?: number
  readonly unlimited?: boolean
  readonly resetAt?: number
  readonly unit: string
}
export type FormattedQuotaWindow = {
  readonly label: string
  readonly group?: string
  readonly used?: number
  readonly detail: string
  readonly reset?: string
  readonly level?: QuotaWindowLevel
}

const quotaLevel = (pct: number): QuotaWindowLevel => pct >= 85 ? "danger" : pct >= 60 ? "warn" : "ok"

function quotaReset(resetAt: number | undefined, now: number | undefined): string | undefined {
  if (resetAt === undefined || now === undefined || !Number.isFinite(resetAt)) return undefined
  const seconds = Math.max(0, Math.ceil((resetAt - now) / 1000))
  return seconds === 0 ? "Reset due" : seconds >= 86_400 ? `Resets in ${Math.ceil(seconds / 86_400)}d` : seconds >= 3_600 ? `Resets in ${Math.ceil(seconds / 3_600)}h` : `Resets in ${Math.ceil(seconds / 60)}m`
}

export function formatQuotaWindow(window: QuotaWindowInput, now?: number): FormattedQuotaWindow {
  const base = { label: window.label, ...(window.group ? { group: window.group } : {}) }
  if (window.unlimited === true) return { ...base, detail: "Unlimited" }
  const reset = quotaReset(window.resetAt, now)
  const resetPart = reset === undefined ? {} : { reset }
  if (window.limit !== undefined && window.limit > 0 && window.used !== undefined) {
    const pct = Math.round(Math.min(100, Math.max(0, (100 * window.used) / window.limit)) * 10) / 10
    const detail = window.unit === "usd" ? `${formatUsd(window.used)} / ${formatUsd(window.limit)}`
      : window.unit === "percent" ? formatPercent(pct)
      : window.unit === "tokens" ? `${formatCompactCount(window.used)} / ${formatCompactCount(window.limit)} tokens`
      : `${formatCount(window.used)} / ${formatCount(window.limit)} ${window.unit}`
    return { ...base, used: pct, detail, level: quotaLevel(pct), ...resetPart }
  }
  if (window.limit === undefined && window.unit === "percent" && window.used !== undefined) {
    const pct = Math.round(Math.min(100, Math.max(0, window.used)) * 10) / 10
    return { ...base, used: pct, detail: formatPercent(pct), level: quotaLevel(pct), ...resetPart }
  }
  return { ...base, used: undefined, detail: `${window.used !== undefined ? formatCount(window.used) : "Unreported"} / ${window.limit !== undefined ? formatCount(window.limit) : "Unreported"} ${window.unit}`, ...resetPart }
}

export type QuotaProviderTone = "ok" | "warn" | "bad" | "muted"
export type RawQuotaSnapshot = {
  readonly providerID?: string
  readonly label: string
  readonly profile?: string
  readonly status: string
  readonly source?: string
  readonly stability?: string
  readonly message?: string
  readonly windows: readonly QuotaWindowInput[]
}
export type FormattedQuotaProvider = {
  readonly key: string
  readonly provider: string
  readonly account?: string
  readonly status: string
  readonly statusTone: QuotaProviderTone
  readonly note?: string
  readonly windows: readonly FormattedQuotaWindow[]
}

const quotaSources: Readonly<Record<string, string>> = {
  provider_api: "Provider API",
  provider_internal_api: "Account API",
  response_headers: "Response headers",
  response_stream: "Response stream",
  local_client_rpc: "Local client",
  local_session: "Local session",
}

const humanizeToken = (value: string) => value.replace(/[_-]+/g, " ").trim()

function disambiguateWindows(windows: readonly QuotaWindowInput[], now: number | undefined): readonly FormattedQuotaWindow[] {
  const formatted = windows.map((window) => formatQuotaWindow(window, now))
  const labels = formatted.map((window) => window.label)
  const groupsByLabel = new Map<string, Set<string>>()
  formatted.forEach((window) => groupsByLabel.set(window.label, (groupsByLabel.get(window.label) ?? new Set()).add(window.group ?? "")))
  const grouped = formatted.map((window, index) => (groupsByLabel.get(window.label)?.size ?? 0) > 1 && window.group ? `${window.group} · ${labels[index]}` : labels[index]!)
  const count = (list: readonly string[], value: string) => list.filter((entry) => entry === value).length
  const withIDs = grouped.map((label, index) => {
    if (count(grouped, label) < 2) return label
    const original = windows[index]!.label.toLowerCase()
    const tokens = humanizeToken(windows[index]!.id ?? "").split(/\s+/).filter((token) => token && !original.includes(token.toLowerCase()))
    return tokens.length ? `${label} · ${tokens.join(" ")}` : label
  })
  const seen = new Map<string, number>()
  return formatted.map((window, index) => {
    const label = withIDs[index]!
    if (count(withIDs, label) < 2) return { ...window, label }
    const position = (seen.get(label) ?? 0) + 1
    seen.set(label, position)
    return { ...window, label: `${label} #${position}` }
  })
}

export function formatQuotaProviders(quotas: readonly RawQuotaSnapshot[], now?: number): readonly FormattedQuotaProvider[] {
  const emptyKeys = new Set<string>()
  const kept = quotas.filter((quota) => {
    if (quota.status !== "unsupported" || quota.windows.length > 0 || quota.profile) return true
    const key = JSON.stringify([quota.providerID ?? quota.label, quota.status, quota.message ?? ""])
    if (emptyKeys.has(key)) return false
    emptyKeys.add(key)
    return true
  })
  const parsed = kept.map((quota) => {
    const split = quota.profile === undefined && quota.label.includes(" · ") ? quota.label.split(" · ") : undefined
    const provider = split ? split[0]! : quota.label
    const plan = split ? split.slice(1).join(" · ") : undefined
    const account = quota.profile ? plan && plan !== quota.profile ? `${plan} · ${quota.profile}` : quota.profile : plan
    return { quota, provider, account }
  })
  const join = (account: string | undefined, extra: string | undefined) => [account, extra].filter((part) => part).join(" · ") || undefined
  const keyOf = (entry: { provider: string; account: string | undefined }) => `${entry.provider}\u0000${entry.account ?? ""}`
  const refine = (rows: typeof parsed, extra: (row: (typeof parsed)[number]) => string | undefined) => {
    const sizes = new Map<string, number>()
    rows.forEach((row) => sizes.set(keyOf(row), (sizes.get(keyOf(row)) ?? 0) + 1))
    return rows.map((row) => (sizes.get(keyOf(row)) ?? 0) > 1 ? { ...row, account: join(row.account, extra(row)) } : row)
  }
  const bySource = refine(parsed, (row) => row.quota.source ? quotaSources[row.quota.source] ?? humanizeToken(row.quota.source) : undefined)
  const byID = refine(bySource, (row) => row.quota.providerID && row.quota.providerID !== row.provider ? row.quota.providerID : undefined)
  const sizes = new Map<string, number>()
  byID.forEach((row) => sizes.set(keyOf(row), (sizes.get(keyOf(row)) ?? 0) + 1))
  const ordinals = new Map<string, number>()
  return byID.map(({ quota, provider, account: raw }, index): FormattedQuotaProvider => {
    const key = keyOf({ provider, account: raw })
    const ordinal = (ordinals.get(key) ?? 0) + 1
    ordinals.set(key, ordinal)
    const account = (sizes.get(key) ?? 0) > 1 ? join(raw, `Account ${ordinal}`) : raw
    const note = quota.message?.trim() || (quota.windows.length === 0 && quota.status === "unsupported" ? "Quota windows are not reported for this account." : undefined)
    return {
      key: `${index}:${provider}:${account ?? ""}`,
      provider,
      ...(account ? { account } : {}),
      status: quota.status,
      statusTone: quota.status === "available" ? "ok" : quota.status === "stale" ? "warn" : quota.status === "unauthorized" || quota.status === "error" ? "bad" : "muted",
      ...(note ? { note } : {}),
      windows: disambiguateWindows(quota.windows, now),
    }
  })
}

export type TurnEdit = { readonly turnID: string; readonly files: readonly { readonly path: string; readonly patch: string; readonly additions: number; readonly deletions: number }[] }

export function turnEditPlacements(messages: readonly { readonly id: string; readonly type: string }[], turns: SessionFileChanges["turns"]): ReadonlyMap<string, TurnEdit> {
  const placements = new Map<string, TurnEdit>()
  if (!turns?.length) return placements
  const byID = new Map(turns.map((turn) => [turn.id, turn] as const))
  let current: string | undefined
  let seenUser = false
  messages.forEach((message, index) => {
    if (message.type === "user") { seenUser = true; current = byID.has(message.id) ? message.id : undefined }
    else if (!seenUser && current === undefined && byID.has(message.id)) current = message.id
    const turn = current === undefined ? undefined : byID.get(current)
    if (!turn || !turn.files.length || (messages[index + 1] && messages[index + 1]!.type !== "user")) return
    const merged = new Map<string, { path: string; patch: string; additions: number; deletions: number }>()
    for (const file of turn.files) {
      const previous = merged.get(file.path)
      merged.set(file.path, { path: file.path, patch: file.patch, additions: (previous?.additions ?? 0) + file.additions, deletions: (previous?.deletions ?? 0) + file.deletions })
    }
    placements.set(message.id, { turnID: turn.id, files: [...merged.values()] })
  })
  return placements
}

export function insertTextAtSelection(current: string, start: number, end: number, inserted: string): { readonly text: string; readonly caret: number } {
  const clampedStart = Math.max(0, Math.min(start, current.length))
  const clampedEnd = Math.max(clampedStart, Math.min(end, current.length))
  return { text: current.slice(0, clampedStart) + inserted + current.slice(clampedEnd), caret: clampedStart + inserted.length }
}

const editableInputTypes = ["", "text", "search", "url", "email", "password", "tel", "number"]

export function isEditableKeyboardTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  if ((target as { isContentEditable?: unknown }).isContentEditable === true) return true
  const tag = typeof (target as { tagName?: unknown }).tagName === "string" ? (target as { tagName: string }).tagName.toUpperCase() : ""
  if (tag === "TEXTAREA") return true
  if (tag !== "INPUT") return false
  const type = typeof (target as { type?: unknown }).type === "string" ? (target as { type: string }).type.toLowerCase() : "text"
  return editableInputTypes.includes(type)
}

export function isStandardEditShortcut(event: { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean }): boolean {
  if (event.altKey || (!event.metaKey && !event.ctrlKey)) return false
  const key = event.key.toLowerCase()
  if (!event.shiftKey && (key === "v" || key === "c" || key === "x" || key === "a" || key === "z")) return true
  if (event.shiftKey && key === "z") return true
  return !event.shiftKey && event.ctrlKey && !event.metaKey && key === "y"
}
