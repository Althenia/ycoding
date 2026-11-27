export const autonomyModes = ["manual", "yolo", "auto"] as const
export const autonomyCategories = ["permissions", "guardrails", "answers"] as const

export type AutonomyMode = (typeof autonomyModes)[number]
export type AutonomyCategory = (typeof autonomyCategories)[number]
export type AutonomyModes = { readonly [Category in AutonomyCategory]: AutonomyMode }
export type EffectiveAutonomyView = AutonomyModes & {
  readonly inherited: { readonly [Category in AutonomyCategory]?: string }
  readonly deferred: boolean
  readonly guardrailsEnabled: boolean
}
export type AutonomyIntent =
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "cycle"; readonly category: AutonomyCategory; readonly step: 1 | -1 }
  | { readonly type: "all"; readonly mode: AutonomyMode }
  | { readonly type: "save-default"; readonly category: AutonomyCategory }
  | { readonly type: "reset-default"; readonly category: AutonomyCategory }
export type AutonomyRow = {
  readonly category: AutonomyCategory
  readonly title: string
  readonly own: AutonomyMode
  readonly mode: AutonomyMode
  readonly label: string
  readonly saved?: AutonomyMode
  readonly inheritedFrom?: string
  readonly decider: string
}

const modeLabels = { manual: "Manual", yolo: "YOLO", auto: "Auto" } as const
const categoryTitles = { permissions: "Permissions", guardrails: "Guardrails", answers: "Answers" } as const
const allModeKeys = { "1": "manual", "2": "yolo", "3": "auto" } as const

export function readAutonomyMode(value: unknown): AutonomyMode | undefined {
  return autonomyModes.find((mode) => mode === value)
}

export function autonomyModeLabel(mode: AutonomyMode) {
  return modeLabels[mode]
}

export function cycleAutonomyMode(mode: AutonomyMode, step: 1 | -1): AutonomyMode {
  return autonomyModes[(autonomyModes.indexOf(mode) + step + autonomyModes.length) % autonomyModes.length]!
}

export function readAutonomyDefaults(payload: unknown): AutonomyModes | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const data: unknown = Reflect.get(payload, "data")
  if (typeof data !== "object" || data === null) return undefined
  const permissions = readAutonomyMode(Reflect.get(data, "permissions"))
  const guardrails = readAutonomyMode(Reflect.get(data, "guardrails"))
  const answers = readAutonomyMode(Reflect.get(data, "answers"))
  return permissions === undefined || guardrails === undefined || answers === undefined ? undefined : { permissions, guardrails, answers }
}

export function autonomyDefaultChange(intent: Extract<AutonomyIntent, { type: "save-default" | "reset-default" }>, own: AutonomyModes): Partial<AutonomyModes> {
  return { [intent.category]: intent.type === "reset-default" ? "manual" : own[intent.category] }
}

export function autonomyChange(intent: Exclude<AutonomyIntent, { type: "select" | "save-default" | "reset-default" }>, own: AutonomyModes): Partial<AutonomyModes> {
  if (intent.type === "all") return { permissions: intent.mode, guardrails: intent.mode, answers: intent.mode }
  return { [intent.category]: cycleAutonomyMode(own[intent.category], intent.step) }
}

export function requiresYoloConfirmation(own: AutonomyModes, change: Partial<AutonomyModes>) {
  return autonomyCategories.some((category) => change[category] === "yolo" && own[category] !== "yolo")
}

export function autonomyKeyIntent(
  event: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean },
  selected: number,
): AutonomyIntent | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return undefined
  if (event.key === "ArrowDown") return { type: "select", index: Math.min(selected + 1, autonomyCategories.length - 1) }
  if (event.key === "ArrowUp") return { type: "select", index: Math.max(selected - 1, 0) }
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") return { type: "cycle", category: autonomyCategories[selected]!, step: event.key === "ArrowRight" ? 1 : -1 }
  if (event.key.toLowerCase() === "d") return { type: "save-default", category: autonomyCategories[selected]! }
  if (event.key.toLowerCase() === "r") return { type: "reset-default", category: autonomyCategories[selected]! }
  if (event.key in allModeKeys) return { type: "all", mode: allModeKeys[event.key as keyof typeof allModeKeys] }
  return undefined
}

export function autonomyRows(autonomy: (AutonomyModes & { readonly effective?: EffectiveAutonomyView }) | undefined, saved?: AutonomyModes): readonly AutonomyRow[] {
  if (autonomy === undefined) return []
  const effective = autonomy.effective
  return autonomyCategories.map((category) => {
    const mode = effective?.[category] ?? autonomy[category]
    return {
      category,
      title: categoryTitles[category],
      own: autonomy[category],
      mode,
      label: modeLabels[mode],
      ...(saved === undefined ? {} : { saved: saved[category] }),
      ...(effective?.inherited[category] === undefined ? {} : { inheritedFrom: effective.inherited[category] }),
      decider: decider(category, mode, effective?.deferred === true, effective?.guardrailsEnabled !== false),
    }
  })
}

function decider(category: AutonomyCategory, mode: AutonomyMode, deferred: boolean, guardrailsEnabled: boolean) {
  if (category === "permissions") {
    if (mode === "auto") return "Rules approve permission asks; denies still block"
    if (mode === "yolo") return "YOLO bypasses permission blockers"
    return deferred ? "Review box holds unresolved permission asks" : "You decide each permission ask"
  }
  if (category === "guardrails") {
    if (mode === "yolo") return "YOLO bypasses all guardrail blockers"
    if (!guardrailsEnabled) return "Ordinary reviews are disabled; hard reviews still need you"
    if (mode === "auto") return deferred ? "Review box holds unresolved reviews while deferred" : "Routine reviews are approved; hard reviews still need you"
    return deferred ? "Review box holds unresolved reviews" : "You decide each review"
  }
  if (mode === "auto") return deferred ? "Explicit defaults or the one Recommended option answer; the rest wait in Review" : "Explicit defaults or the one Recommended option answer; the rest reach you"
  if (mode === "yolo") return "YOLO answers all questions, including free text"
  return deferred ? "Review box holds unresolved questions" : "You answer each question"
}

function uniformMode(modes: AutonomyModes) {
  return modes.permissions === modes.guardrails && modes.guardrails === modes.answers ? modes.permissions : undefined
}

export function autonomySummary(modes: AutonomyModes) {
  const uniform = uniformMode(modes)
  return {
    label: uniform === undefined ? "Autonomous" : `Autonomous ${modeLabels[uniform]}`,
    chips: uniform === undefined
      ? autonomyCategories.map((category) => ({
          key: category,
          label: `${categoryTitles[category]} ${modeLabels[modes[category]]}`,
          mode: modes[category],
        }))
      : [],
  }
}

export function autonomyLabels(modes: AutonomyModes): readonly string[] {
  const summary = autonomySummary(modes)
  return summary.chips.length === 0 ? [summary.label] : summary.chips.map((chip) => chip.label)
}

export function autonomyTone(modes: AutonomyModes): "attention" | "neutral" {
  return autonomyCategories.some((category) => modes[category] === "yolo") ? "attention" : "neutral"
}

export function autonomyAnnouncement(change: Partial<AutonomyModes>, rows: readonly AutonomyRow[]) {
  const changed = rows.filter((row) => change[row.category] !== undefined)
  const inEffect = changed.filter((row) => row.mode !== row.own || row.inheritedFrom !== undefined)
  const source = (row: AutonomyRow) => row.inheritedFrom === undefined ? "" : ` (inherited from ${row.inheritedFrom})`
  if (changed.length === autonomyCategories.length && changed.every((row) => row.own === changed[0]!.own)) {
    const base = `This Session's categories set to ${modeLabels[changed[0]!.own]}`
    return inEffect.length === 0 ? base : `${base}; in effect ${inEffect.map((row) => `${row.title} ${row.label}${source(row)}`).join(", ")}`
  }
  if (changed.length === 1) {
    const row = changed[0]!
    const base = `${row.title} set to ${modeLabels[row.own]} for this Session`
    return inEffect.length === 0 ? base : `${base}; in effect ${row.label}${source(row)}`
  }
  const base = `${changed.map((row) => `${row.title} set to ${modeLabels[row.own]}`).join(", ")} for this Session`
  return inEffect.length === 0 ? base : `${base}; in effect ${inEffect.map((row) => `${row.title} ${row.label}${source(row)}`).join(", ")}`
}

export function autonomyDefaultAnnouncement(change: Partial<AutonomyModes>) {
  return autonomyCategories.flatMap((category) => {
    const mode = change[category]
    if (mode === undefined) return []
    return [mode === "manual" ? `${categoryTitles[category]} default reset to Manual for new Sessions` : `${categoryTitles[category]} default saved as ${modeLabels[mode]} for new Sessions`]
  }).join(", ")
}
