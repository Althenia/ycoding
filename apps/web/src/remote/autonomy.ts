export const autonomyModes = ["manual", "yolo", "auto"] as const
export const autonomyCategories = ["permissions", "guardrails", "answers"] as const

export type AutonomyMode = (typeof autonomyModes)[number]
export type AutonomyCategory = (typeof autonomyCategories)[number]
export type AutonomyModes = { readonly [Category in AutonomyCategory]: AutonomyMode }
export type EffectiveAutonomyView = AutonomyModes & {
  readonly inherited: { readonly [Category in AutonomyCategory]?: string }
  readonly asleep: boolean
  readonly guardrailsEnabled: boolean
}
export type AutonomyIntent =
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "cycle"; readonly category: AutonomyCategory; readonly step: 1 | -1 }
  | { readonly type: "all"; readonly mode: AutonomyMode }
export type AutonomyRow = {
  readonly category: AutonomyCategory
  readonly title: string
  readonly own: AutonomyMode
  readonly mode: AutonomyMode
  readonly label: string
  readonly inheritedFrom?: string
  readonly decider: string
}

const modeLabels = { manual: "Manual", yolo: "YOLO", auto: "Auto" } as const
const categoryTitles = { permissions: "Permissions", guardrails: "Guardrails", answers: "Answers" } as const
const categoryInitials = { permissions: "P", guardrails: "G", answers: "Q" } as const
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

export function autonomyChange(intent: Exclude<AutonomyIntent, { type: "select" }>, own: AutonomyModes): Partial<AutonomyModes> {
  if (intent.type === "all") return { permissions: intent.mode, guardrails: intent.mode, answers: intent.mode }
  return { [intent.category]: cycleAutonomyMode(own[intent.category], intent.step) }
}

export function autonomyKeyIntent(
  event: { readonly key: string; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean },
  selected: number,
): AutonomyIntent | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return undefined
  if (event.key === "ArrowDown") return { type: "select", index: Math.min(selected + 1, autonomyCategories.length - 1) }
  if (event.key === "ArrowUp") return { type: "select", index: Math.max(selected - 1, 0) }
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") return { type: "cycle", category: autonomyCategories[selected]!, step: event.key === "ArrowRight" ? 1 : -1 }
  if (event.key in allModeKeys) return { type: "all", mode: allModeKeys[event.key as keyof typeof allModeKeys] }
  return undefined
}

export function autonomyRows(autonomy: (AutonomyModes & { readonly effective?: EffectiveAutonomyView }) | undefined): readonly AutonomyRow[] {
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
      ...(effective?.inherited[category] === undefined ? {} : { inheritedFrom: effective.inherited[category] }),
      decider: decider(category, mode, effective?.asleep === true, effective?.guardrailsEnabled !== false),
    }
  })
}

function decider(category: AutonomyCategory, mode: AutonomyMode, asleep: boolean, guardrailsEnabled: boolean) {
  if (category === "permissions") {
    if (mode === "auto") return "Rules approve permission asks; denies still block"
    if (mode === "yolo") return "YOLO evaluates permission asks; uncertain asks reach you"
    return asleep ? "Review box holds each permission ask" : "You decide each permission ask"
  }
  if (category === "guardrails") {
    if (!guardrailsEnabled) return "Ordinary reviews are disabled; hard reviews still need you"
    if (mode === "yolo") return "YOLO evaluates reviews; hard reviews still need your approval"
    if (mode === "auto") return asleep ? "Review box holds each review while asleep" : "Routine reviews are approved while awake; hard reviews still need you"
    return asleep ? "Review box holds each review" : "You decide each review"
  }
  if (mode === "auto") return "Explicit defaults or the one Recommended option answer; the rest reach you"
  if (mode === "yolo") return "YOLO answers what it can validate; the rest reach you"
  return asleep ? "Review box holds each question" : "You answer each question"
}

function uniformMode(modes: AutonomyModes) {
  return modes.permissions === modes.guardrails && modes.guardrails === modes.answers ? modes.permissions : undefined
}

export function autonomySummary(modes: AutonomyModes) {
  const uniform = uniformMode(modes)
  return {
    label: uniform === undefined ? "Autonomous" : `Autonomous ${modeLabels[uniform]}`,
    compact: uniform === undefined ? "Au·Mx" : `Au·${modeLabels[uniform][0]}`,
    chips: uniform === undefined
      ? autonomyCategories.map((category) => ({
          key: category,
          label: `${categoryTitles[category]} ${modeLabels[modes[category]]}`,
          compact: `${categoryInitials[category]}·${modeLabels[modes[category]][0]}`,
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
