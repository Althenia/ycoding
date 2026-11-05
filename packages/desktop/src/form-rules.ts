import { utf8Length, type FormRequest, type ModelOption, type ModelProfileOption, type ModelSelection, type SessionItem, type Sessions } from "./contract"

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
