import type { SessionAutonomyView } from "@ycoding-ai/client"

export type AutonomyState = Omit<SessionAutonomyView, "effective">

export type YoloLevel = 0 | 1 | 2

export function yoloLevel(state: { yolo?: unknown }): YoloLevel | undefined {
  const raw = state.yolo
  if (raw === true) return 2
  if (raw === false) return 0
  if (raw === 0 || raw === 1 || raw === 2) return raw
  return undefined
}

export function parseApprovalLevel(token: string | undefined): YoloLevel | undefined {
  if (token === "0") return 0
  if (token === "1") return 1
  if (token === "2") return 2
  return undefined
}

export function nextApprovalLevel(level: YoloLevel): YoloLevel {
  if (level === 0) return 1
  if (level === 1) return 2
  return 0
}

export function approvalLevelLabel(level: YoloLevel) {
  return ["Ask first", "Allow tools", "Tools + reviews"][level]
}

export function parseAutoAnswerArg(token: string | undefined): boolean | undefined | null {
  if (token === undefined || token === "") return undefined
  if (token === "on") return true
  if (token === "off") return false
  return null
}

export function autoAnswerOn(state: { autoAnswer?: unknown } | undefined): boolean {
  return state?.autoAnswer === true
}

export function isAsleep(state: { sleep?: unknown }): boolean {
  return state.sleep !== undefined && state.sleep !== null
}

export function localAutonomyView(state: AutonomyState): SessionAutonomyView {
  return {
    ...state,
    effective: {
      yolo: yoloLevel(state) ?? 0,
      asleep: isAsleep(state),
      ordinaryReviewsAuto: yoloLevel(state) === 2 && !isAsleep(state),
      guardrailsEnabled: false,
      modelReviews: false,
      hardModelReviews: false,
    },
  }
}

export type AutonomyAction = "permissions" | "guardrails" | "questions"
export type AutonomyDecisionKind = "you" | "automated" | "unknown"

export function autonomyDecisionKind(
  view: SessionAutonomyView | undefined,
  action: AutonomyAction,
): AutonomyDecisionKind {
  if (!view?.effective) return "unknown"
  const effective = view.effective
  if (action === "permissions") {
    if (effective.yolo >= 1) return "automated"
    return effective.asleep ? "automated" : "you"
  }
  if (action === "guardrails") {
    if (!effective.guardrailsEnabled) return "you"
    if (effective.ordinaryReviewsAuto) return "automated"
    if (effective.modelReviews || effective.asleep) return "automated"
    return "you"
  }
  if (autoAnswerOn(view)) return "automated"
  return effective.asleep ? "automated" : "you"
}

export function autonomyLevelDescription(level: YoloLevel) {
  return [
    "ask before ask-permission tools and ordinary reviews",
    "auto-approve ask-permission tools; ordinary reviews still ask",
    "auto-approve ask-permission tools and ordinary reviews while awake; hard reviews never auto-approve by level",
  ][level]
}

export function autonomyDecisionLabel(view: SessionAutonomyView | undefined, action: AutonomyAction) {
  if (action === "guardrails") {
    if (!view?.effective) return "unknown"
    const effective = view.effective
    if (!effective.guardrailsEnabled) return "disabled"
    if (effective.ordinaryReviewsAuto) return "auto"
    if (effective.modelReviews) return effective.asleep ? "model, then review box" : "model, then you"
    return effective.asleep ? "review box" : "you"
  }
  if (!view?.effective) return "unknown"
  const effective = view.effective
  if (action === "permissions") {
    if (effective.yolo >= 1) return "auto"
    return effective.asleep ? "review box" : "you"
  }
  if (autoAnswerOn(view)) return "auto"
  return effective.asleep ? "review box" : "you"
}

export function autonomyModeParts(view: SessionAutonomyView | undefined) {
  if (!view?.effective) return ["unknown"] as const
  return [
    approvalLevelLabel(view.effective.yolo),
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
