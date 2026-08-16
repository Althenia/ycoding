import type { SessionAutonomyState } from "@ycoding-ai/client"

export function autonomyModeLabel(state: SessionAutonomyState) {
  if (state.mode === "yolo") return "YOLO"
  if (state.mode === "goal") return "Goal"
  // A finished goal leaves goal mode but keeps its terminal status. Gating on the mode alone would
  // drop back to a bare "Normal", hiding that a goal ran and how it ended.
  if (state.goal && state.goal.status !== "active") return `Goal ${state.goal.status}`
  return "Normal"
}

export function autonomyProgressLabel(state: SessionAutonomyState) {
  const goal = state.goal
  if (!goal) return undefined
  if (goal.status === "active") return `${goal.iteration} · no progress ${goal.noProgress}/${goal.maxNoProgress}`
  if (goal.status !== "exhausted") return `${goal.status} after ${goal.iteration} iterations`
  return `exhausted after ${goal.noProgress}/${goal.maxNoProgress} repeats without progress`
}

/**
 * Control token the model emits to end a goal loop. It stays in the durable transcript so the
 * server keeps detecting completion when it replays history, so only rendering hides it.
 * Mirrors SessionAutonomy.CompletionMarker in @ycoding-ai/core, which is not imported here
 * because that module pulls the database layer in; a test pins the two together.
 */
export const GOAL_COMPLETION_MARKER = "<goal-complete/>"
/** Every spelling the server accepts as completion, so rendering hides exactly what it detects. */
export const GOAL_COMPLETION_PATTERN = "<goal-complete\\s*/>"
const goalCompletion = new RegExp(GOAL_COMPLETION_PATTERN, "g")

/** Renderable assistant text: the completion marker removed and surrounding blanks trimmed. */
export function stripGoalCompletionMarker(text: string) {
  return text.replace(goalCompletion, "").trim()
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
  state: SessionAutonomyState
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
): SessionAutonomyState {
  if (!connected || response?.sessionID !== sessionID) return { mode: "normal" }
  return response.state
}

export async function submitSessionPrompt(input: {
  prompt: (resume: boolean) => Promise<unknown>
  skills: Array<() => Promise<unknown>>
}) {
  await input.prompt(false)
  for (const skill of input.skills) await skill()
  await input.prompt(true)
}

export async function activateGoal(input: {
  sessionID: string
  id: string
  goal: string
  get: () => Promise<SessionAutonomyState>
  set: (input: { mode: "goal"; goal: string }) => Promise<SessionAutonomyState>
  prompt: (input: { sessionID: string; id: string; text: string; resume?: boolean }) => Promise<unknown>
}) {
  await input.prompt({ sessionID: input.sessionID, id: input.id, text: input.goal, resume: false })
  const current = await input.get()
  const state =
    current.mode === "goal" &&
    current.goal &&
    current.goal.status === "active" &&
    ("rawText" in current.goal ? current.goal.rawText : current.goal.text) === input.goal
      ? current
      : await input.set({ mode: "goal", goal: input.goal })
  await input.prompt({ sessionID: input.sessionID, id: input.id, text: input.goal })
  return state
}
