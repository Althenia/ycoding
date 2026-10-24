import type { SessionAutonomyDecisionMode, SessionAutonomyView } from "@ycoding-ai/client"

export type AutonomyState = Omit<SessionAutonomyView, "effective">
export type AutonomyCategory = "permissions" | "guardrails" | "answers"
export type AutonomyChange = Partial<Record<AutonomyCategory, SessionAutonomyDecisionMode>>

export const autonomyCategories = ["permissions", "guardrails", "answers"] as const
const autonomyModes = ["manual", "yolo", "auto"] as const

export function autonomyMode(value: unknown): SessionAutonomyDecisionMode | undefined {
  return autonomyModes.find((mode) => mode === value)
}

export function autonomyModeWord(mode: SessionAutonomyDecisionMode) {
  if (mode === "yolo") return "YOLO"
  return mode === "auto" ? "Auto" : "Manual"
}

export function cycleAutonomyMode(mode: SessionAutonomyDecisionMode, direction: 1 | -1) {
  return autonomyModes[(autonomyModes.indexOf(mode) + direction + autonomyModes.length) % autonomyModes.length]!
}

export function allAutonomyChange(mode: SessionAutonomyDecisionMode) {
  return { permissions: mode, guardrails: mode, answers: mode }
}

export function autonomyRows(view: SessionAutonomyView | undefined) {
  return autonomyCategories.map((category) => {
    const local = autonomyMode(view?.[category])
    const effective = autonomyMode(view?.effective?.[category])
    const source = view?.effective?.inherited?.[category]
    return {
      category,
      title: autonomyCategoryTitle(category),
      local,
      effective,
      inherited: typeof source === "string" && effective !== undefined ? source : undefined,
    }
  })
}

function autonomyCategoryTitle(category: AutonomyCategory) {
  if (category === "permissions") return "Permissions"
  return category === "guardrails" ? "Guardrails" : "Answers"
}

export function isAsleep(state: { sleep?: unknown }): boolean {
  return state.sleep !== undefined && state.sleep !== null
}

export function localAutonomyView(state: AutonomyState): SessionAutonomyView {
  return {
    ...state,
    effective: {
      permissions: state.permissions,
      guardrails: state.guardrails,
      answers: state.answers,
      inherited: {},
      asleep: isAsleep(state),
      guardrailsEnabled: false,
    },
  }
}

export type AutonomyAction = AutonomyCategory
export type AutonomyDecisionKind = "manual" | "automated" | "unknown"

export function autonomyDecisionKind(view: SessionAutonomyView | undefined, action: AutonomyAction): AutonomyDecisionKind {
  const label = autonomyDecisionLabel(view, action)
  if (label === "unknown") return "unknown"
  if (label === "manual" || label === "disabled") return "manual"
  return "automated"
}

export function autonomyInheritance(view: SessionAutonomyView | undefined, action: AutonomyAction) {
  return autonomyRows(view).find((row) => row.category === action)?.inherited
}

export function autonomyDecisionLabel(view: SessionAutonomyView | undefined, action: AutonomyAction) {
  const mode = autonomyMode(view?.effective?.[action])
  if (!mode || !view?.effective) return "unknown"
  if (action === "guardrails" && !view.effective.guardrailsEnabled) return "disabled"
  if (mode === "manual") return view.effective.asleep ? "review box" : "manual"
  return mode
}

export function autonomyAutomated(view: SessionAutonomyView | undefined) {
  const modes = autonomyCategories.map((category) => autonomyMode(view?.effective?.[category]))
  if (modes.some((mode) => mode === undefined)) return undefined
  return modes.some((mode) => mode !== "manual")
}

export function autonomyModeParts(view: SessionAutonomyView | undefined): readonly string[] {
  const automated = autonomyAutomated(view)
  if (automated === undefined || !view) return ["unknown"] as const
  return [
    ...(automated
      ? autonomyRows(view).flatMap((row) =>
          row.effective === "manual" ? [] : [`${row.category} ${row.effective}${row.inherited ? " (inherited)" : ""}`],
        )
      : ["manual"]),
    ...(view.goal?.status === "active" ? ["goal"] : []),
    ...(view.effective.asleep ? ["asleep"] : []),
  ] as const
}

export function autonomyModeLabel(view: SessionAutonomyView | undefined) {
  return autonomyModeParts(view).join(" · ")
}

export function autonomyProgressLabel(state: AutonomyState) {
  const goal = state.goal
  if (!goal) return undefined
  if (goal.status === "active") return `${goal.iteration} · no progress ${goal.noProgress}/${goal.maxNoProgress}`
  if (goal.status !== "exhausted") return `${goal.status} after ${goal.iteration} iterations`
  return `exhausted after ${goal.noProgress}/${goal.maxNoProgress} repeats without progress`
}

export function parseGoalCommand(input: string) {
  const match = input.match(/^\/goal(?=\s|$)(?:\s+([\s\S]*))?$/)
  if (!match) return
  return { goal: (match[1] ?? "").trim() }
}

export type SessionSubmissionRetry<T = unknown> = {
  key: string
  promptID: string
  syntheticID: string
  skillIDs: string[]
  payload: T
  sessionID: string
  creationConfirmed: boolean
}

export function createSessionMessageID() {
  return `msg_${crypto.randomUUID()}`
}

export function createSessionID() {
  return `ses_${crypto.randomUUID()}`
}

export function retainSessionSubmission<T>(
  current: SessionSubmissionRetry<T> | undefined,
  key: string,
  skillCount: number,
  payload: T,
  sessionID?: string,
) {
  if (current) return current
  return {
    key,
    promptID: createSessionMessageID(),
    syntheticID: createSessionMessageID(),
    skillIDs: Array.from({ length: skillCount }, createSessionMessageID),
    payload: structuredClone(payload),
    sessionID: sessionID ?? createSessionID(),
    creationConfirmed: sessionID !== undefined,
  }
}

export async function confirmSessionCreation<T>(
  submission: SessionSubmissionRetry,
  create: (sessionID: string) => Promise<T>,
) {
  if (submission.creationConfirmed) return
  const created = await create(submission.sessionID)
  submission.creationConfirmed = true
  return created
}

export function restoreSessionSubmission<T>(
  submission: SessionSubmissionRetry<{ history: T; cursor: number }>,
  current: T,
  stash: (prompt: T) => void,
  isEmpty: (prompt: T) => boolean,
) {
  const prompt = structuredClone(submission.payload.history)
  if (!isEmpty(current) && JSON.stringify(current) !== JSON.stringify(prompt)) stash(current)
  return { prompt, cursor: submission.payload.cursor }
}

export type SessionAutonomyResponse = {
  sessionID: string
  state: SessionAutonomyView
}

export function createSessionAutonomyRefreshGuard() {
  let latestRequest = 0
  return {
    refresh() {
      latestRequest += 1
      return latestRequest
    },
    invalidate() {
      latestRequest += 1
    },
    accepts(request: number) {
      return request === latestRequest
    },
  }
}

export function currentSessionAutonomy(
  sessionID: string,
  connected: boolean,
  response: SessionAutonomyResponse | undefined,
): SessionAutonomyView | undefined {
  if (!connected || response?.sessionID !== sessionID) return undefined
  return response.state
}

export type GoalToggleAction =
  | { readonly type: "stop" }
  | { readonly type: "resume"; readonly text: string }
  | { readonly type: "request-objective" }

/**
 * Bare /goal or the sidebar toggle never invents an objective. An active goal stops;
 * a retained goal (any terminal status) resumes its existing text without recalculation;
 * with no retained text the UI must ask the user for an explicit objective.
 */
export function goalToggleAction(state: AutonomyState): GoalToggleAction {
  if (state.goal?.status === "active") return { type: "stop" }
  const retained = state.goal?.text.trim()
  if (retained) return { type: "resume", text: retained }
  return { type: "request-objective" }
}

export async function activateGoal<T extends AutonomyState>(input: {
  sessionID: string
  goal: string
  get: () => Promise<T>
  set: (input: { goal: string }) => Promise<T>
}) {
  const current = await input.get()
  const sameActive =
    current.goal?.status === "active" &&
    ("rawText" in current.goal ? (current.goal as { rawText?: string }).rawText : current.goal.text) === input.goal
  if (sameActive) return current
  return input.set({ goal: input.goal })
}
