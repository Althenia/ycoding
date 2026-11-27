export type LifecycleDecision = "continue" | "recover" | "complete"
export type LifecycleBasis = "tool_results" | "answered" | "truncated" | "silent" | "unsettled"
export type HarnessKind = "evaluated" | "probed" | "adopted" | "rolled-back" | "reflected"

type Base = { readonly id: string; readonly created: number }

export type StepEntry = Base & {
  readonly kind: "step"
  readonly step: number
  readonly decision: LifecycleDecision
  readonly basis: LifecycleBasis
  readonly recovery: boolean
  readonly recalled: boolean
}

export type HarnessEntry = Base & {
  readonly kind: "harness"
  readonly event: HarnessKind
  readonly rows: readonly LifecycleRow[]
  readonly notable: boolean
  readonly label: string
}

export type LifecycleEntry = StepEntry | HarnessEntry

export type LifecycleState = { readonly entries: readonly LifecycleEntry[] }

export const emptyLifecycle: LifecycleState = { entries: [] }

export type LifecycleSummary = { readonly label: string; readonly title: string; readonly meta: string }
export type LifecycleRow = { readonly label: string; readonly value: string }

const decisions: readonly string[] = ["continue", "recover", "complete"]
const bases: readonly string[] = ["tool_results", "answered", "truncated", "silent", "unsettled"]
const harnessTypes = new Set([
  "session.harness.evaluated",
  "session.harness.probed",
  "session.harness.adopted",
  "session.harness.rolled-back",
  "session.harness.reflected",
])

export const lifecycleEventType = (type: unknown) => type === "session.lifecycle.recorded" || (typeof type === "string" && harnessTypes.has(type))

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined)

function readStep(base: Base, data: Record<string, unknown>): StepEntry | undefined {
  const { step, decision, basis, recovery, recalled } = data
  if (count(step) === undefined) return undefined
  if (typeof decision !== "string" || !decisions.includes(decision)) return undefined
  if (typeof basis !== "string" || !bases.includes(basis)) return undefined
  if (typeof recovery !== "boolean" || typeof recalled !== "boolean") return undefined
  return { ...base, kind: "step", step: step as number, decision: decision as LifecycleDecision, basis: basis as LifecycleBasis, recovery, recalled }
}

const plural = (amount: number, singular: string, many: string) => `${amount} ${amount === 1 ? singular : many}`

function readHarness(base: Base, type: string, data: Record<string, unknown>): HarnessEntry | undefined {
  const event = type.slice("session.harness.".length) as HarnessKind
  const entry = (label: string, notable: boolean, rows: readonly (readonly [string, string | undefined])[]): HarnessEntry => ({
    ...base,
    kind: "harness",
    event,
    label,
    notable,
    rows: rows.flatMap(([name, value]) => (value === undefined ? [] : [{ label: name, value }])),
  })
  if (event === "evaluated") {
    const { stage, mode, insufficient } = data
    const signals = count(data.signals)
    if (!text(stage) || !text(mode) || signals === undefined || typeof insufficient !== "boolean") return undefined
    const skipReason = text(data.skipReason)
    return entry(skipReason ? "Harness adaptation skipped" : "Harness judged insufficient", insufficient || skipReason !== undefined, [
      ["stage", stage as string],
      ["mode", mode as string],
      ["signals", String(signals)],
      ["insufficient", insufficient ? "yes" : "no"],
      ["skipped", skipReason],
    ])
  }
  if (event === "probed") {
    const candidate = text(data.candidate)
    const outcome = text(data.outcome)
    const tokens = count(data.tokens)
    const latencyMs = count(data.latencyMs)
    if (!candidate || !outcome || tokens === undefined || latencyMs === undefined) return undefined
    return entry("Probed a harness candidate", true, [["candidate", candidate], ["outcome", outcome], ["tokens", String(tokens)], ["latency", `${latencyMs} ms`]])
  }
  if (event === "adopted") {
    const version = text(data.version)
    const parent = text(data.parent)
    if (!version || !parent) return undefined
    return entry("Adopted a harness version", true, [["version", version], ["parent", parent]])
  }
  if (event === "rolled-back") {
    const from = text(data.from)
    const to = text(data.to)
    if (!from || !to) return undefined
    return entry("Rolled back the harness", true, [["from", from], ["to", to]])
  }
  const experiences = Array.isArray(data.experiences) ? data.experiences.filter((item): item is string => text(item) !== undefined) : undefined
  if (!experiences || experiences.length !== (data.experiences as unknown[]).length) return undefined
  return entry(`Recorded ${plural(experiences.length, "experience", "experiences")}`, experiences.length > 0, [["experiences", experiences.join(", ") || undefined]])
}

function readEntry(event: Record<string, unknown>, data: Record<string, unknown>): LifecycleEntry | undefined {
  const { id, created, type } = event
  if (typeof id !== "string" || id.length === 0 || typeof created !== "number" || typeof type !== "string") return undefined
  const base = { id, created }
  if (type === "session.lifecycle.recorded") return readStep(base, data)
  return harnessTypes.has(type) ? readHarness(base, type, data) : undefined
}

export function foldLifecycleEvent(state: LifecycleState, value: unknown): LifecycleState {
  const event = record(value)
  const data = record(event?.data)
  if (!event || !data) return state
  const entry = readEntry(event, data)
  if (!entry) return state
  const entries = [...state.entries.filter((item) => item.id !== entry.id), entry].toSorted(
    (a, b) => a.created - b.created || a.id.localeCompare(b.id),
  )
  return { entries }
}

export const foldLifecycleEvents = (events: readonly unknown[], state: LifecycleState = emptyLifecycle) =>
  events.reduce<LifecycleState>(foldLifecycleEvent, state)

export const lifecycleVisible = (entry: LifecycleEntry) =>
  entry.kind === "harness" ? entry.notable : entry.decision === "recover" || (entry.decision === "complete" && entry.basis !== "answered")

const endings: Readonly<Record<LifecycleBasis, string>> = {
  tool_results: "tool results",
  answered: "answered",
  truncated: "output limit reached",
  silent: "no reply",
  unsettled: "no finish reason",
}

export function lifecycleSummary(entry: LifecycleEntry): LifecycleSummary {
  if (entry.kind === "harness") return { label: entry.label, title: entry.label, meta: entry.event }
  const title = entry.decision === "recover" ? "Retried for a reply" : entry.basis === "truncated" ? "Stopped at the output limit" : "Ended without a reply"
  const meta = `step ${entry.step} · ${endings[entry.basis]}`
  return { label: `${title} · ${meta}`, title, meta }
}

export function lifecycleDetails(entry: LifecycleEntry): readonly LifecycleRow[] {
  if (entry.kind === "harness") return entry.rows
  return [
    { label: "step", value: String(entry.step) },
    { label: "decision", value: entry.decision },
    { label: "ending", value: endings[entry.basis] },
    { label: "recovery step", value: entry.recovery ? "yes" : "no" },
    { label: "recall injected", value: entry.recalled ? "yes" : "no" },
  ]
}
