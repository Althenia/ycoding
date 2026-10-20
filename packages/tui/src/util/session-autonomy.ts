import type { SessionAutonomyView } from "@ycoding-ai/client"

export type AutonomyState = Omit<SessionAutonomyView, "effective">

export function yoloOn(state: { yolo?: unknown }): boolean | undefined {
  if (state.yolo === true) return true
  if (state.yolo === false) return false
  return undefined
}

export function yoloLabel(on: boolean) {
  return on ? "YOLO" : "YOLO off"
}

export function parseToggleArg(token: string | undefined): boolean | undefined | null {
  if (token === undefined || token === "") return undefined
  if (token === "on") return true
  if (token === "off") return false
  return null
}

export type AutonomyToggle = "yolo" | "autoPermission" | "autoGuardrail" | "autoAnswer"

export function autoPermissionOn(state: { autoPermission?: unknown } | undefined): boolean {
  return state?.autoPermission === true
}

export function autoGuardrailOn(state: { autoGuardrail?: unknown } | undefined): boolean {
  return state?.autoGuardrail === true
}

export function autoAnswerOn(state: { autoAnswer?: unknown } | undefined): boolean {
  return state?.autoAnswer === true
}

export function autonomyToggleOn(state: AutonomyState | undefined, toggle: AutonomyToggle): boolean | undefined {
  if (!state) return undefined
  if (toggle === "yolo") return yoloOn(state)
  return state[toggle] === true
}

export function isAsleep(state: { sleep?: unknown }): boolean {
  return state.sleep !== undefined && state.sleep !== null
}

export function localAutonomyView(state: AutonomyState): SessionAutonomyView {
  return {
    ...state,
    effective: {
      yolo: yoloOn(state) ?? false,
      permissionsAuto: autoPermissionOn(state),
      permissionModelReviews: true,
      asleep: isAsleep(state),
      ordinaryReviewsAuto: autoGuardrailOn(state) && !isAsleep(state),
      guardrailsEnabled: false,
      modelReviews: false,
      hardModelReviews: false,
    },
  }
}

export type AutonomyAction = "permissions" | "guardrails" | "questions"
export type AutonomyDecisionKind = "manual" | "automated" | "unknown"

export function autonomyDecisionKind(view: SessionAutonomyView | undefined, action: AutonomyAction): AutonomyDecisionKind {
  const label = autonomyDecisionLabel(view, action)
  if (label === "unknown") return "unknown"
  if (label === "manual" || label === "disabled") return "manual"
  return "automated"
}

export function autonomyToggleDescription(toggle: AutonomyToggle) {
  if (toggle === "yolo") return "agentic evaluator, grants no approval"
  if (toggle === "autoPermission") return "approves ask permissions"
  if (toggle === "autoGuardrail") return "approves ordinary reviews while awake"
  return "answers questions"
}

export function autonomyToggleLabel(toggle: AutonomyToggle) {
  if (toggle === "yolo") return "YOLO"
  if (toggle === "autoPermission") return "Auto-permission"
  if (toggle === "autoGuardrail") return "Auto-guardrail"
  return "Auto-answer"
}

export function autonomyDecisionLabel(view: SessionAutonomyView | undefined, action: AutonomyAction) {
  if (!view?.effective) return "unknown"
  const effective = view.effective
  const human = effective.asleep ? "review box" : "manual"
  if (action === "guardrails") {
    if (!effective.guardrailsEnabled) return "disabled"
    if (effective.ordinaryReviewsAuto) return "auto"
    if (effective.yolo) return "yolo"
    if (effective.modelReviews) return `model, then ${human}`
    return human
  }
  if (action === "permissions") {
    if (effective.permissionsAuto) return "auto"
    if (effective.yolo) return "yolo"
    if (effective.permissionModelReviews) return `model, then ${human}`
    return human
  }
  if (autoAnswerOn(view)) return "auto"
  if (effective.yolo) return "yolo"
  return human
}

export function autonomyModeParts(view: SessionAutonomyView | undefined): readonly string[] {
  if (!view?.effective) return ["unknown"] as const
  return [
    yoloLabel(view.effective.yolo === true),
    ...(view.effective.permissionsAuto ? ["permissions auto"] : []),
    ...(view.effective.ordinaryReviewsAuto ? ["guardrails auto"] : []),
    ...(view.goal?.status === "active" ? ["goal"] : []),
    ...(view.effective.asleep ? ["asleep"] : []),
    ...(autoAnswerOn(view) ? ["answers auto"] : []),
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
