import { isRemoteReviewItemID, type RemoteStoppedRecovery, type RemoteUsageTaskCost } from "@ycoding-ai/remote"
import { modelLabel, readModelRef } from "./projection"

export type TeamTaskView = {
  readonly accounting?: RemoteUsageTaskCost
  readonly accountingUnavailable?: boolean
  readonly sessionID: string
  readonly parentID: string
  readonly description: string
  readonly agent?: string
  readonly modelLabel?: string
  readonly state: "starting" | "running" | "waiting" | "supervising" | "cancelling" | "cancelled" | "completed" | "failed" | "lost"
  readonly revision: number
  readonly updatedAt: number
  readonly pinnedAt?: number
  readonly startedAt?: number
  readonly question?: { readonly id: string; readonly text: string; readonly deferred?: true }
  readonly stoppedRecovery?: RemoteStoppedRecovery
  readonly cacheHitRatio?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly contextTotal?: number
  readonly contextLimit?: number
  readonly cost?: number
  readonly tokens?: number
}

export function readTeamTask(value: unknown): TeamTaskView | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const sessionID = Reflect.get(value, "sessionID")
  const parentID = Reflect.get(value, "parentID")
  const description = Reflect.get(value, "description")
  const agent = Reflect.get(value, "agent")
  const state = Reflect.get(value, "state")
  const revision = Reflect.get(value, "revision")
  const time = Reflect.get(value, "time")
  const question = Reflect.get(value, "question")
  const questionID = typeof question === "object" && question !== null ? Reflect.get(question, "id") : undefined
  const questionText = typeof question === "object" && question !== null ? Reflect.get(question, "text") : undefined
  const startedAt = typeof time === "object" && time !== null ? Reflect.get(time, "created") : undefined
  const updatedAt = typeof time === "object" && time !== null ? Reflect.get(time, "updated") : undefined
  const pinnedAt = Reflect.get(value, "pinnedAt")
  const stoppedRecovery = Reflect.get(value, "stoppedRecovery")
  const stoppedItemID = typeof stoppedRecovery === "object" && stoppedRecovery !== null ? Reflect.get(stoppedRecovery, "itemID") : undefined
  const questionDeferred = typeof question === "object" && question !== null && Reflect.get(question, "deferred") === true
  if (typeof sessionID !== "string" || sessionID.length === 0 || typeof parentID !== "string" || parentID.length === 0 ||
    typeof description !== "string" || (agent !== undefined && typeof agent !== "string") ||
    (state !== "starting" && state !== "running" && state !== "waiting" && state !== "supervising" && state !== "cancelling" &&
      state !== "cancelled" && state !== "completed" && state !== "failed" && state !== "lost") ||
    typeof revision !== "number" || !Number.isInteger(revision) || revision < 0 ||
    typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined
  const model = readModelRef(Reflect.get(value, "model"))
  return { sessionID, parentID, description, ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { modelLabel: modelLabel(model) }), state, revision, updatedAt,
    ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(typeof pinnedAt === "number" && Number.isFinite(pinnedAt) ? { pinnedAt } : {}),
    ...(isRemoteReviewItemID(stoppedItemID) ? { stoppedRecovery: { itemID: stoppedItemID } } : {}),
    ...(typeof questionID === "string" && typeof questionText === "string" && state === "waiting" ? { question: { id: questionID, text: questionText, ...(questionDeferred ? { deferred: true as const } : {}) } } : {}) }
}

export function readTeamChildren(value: unknown, parentID: string) {
  if (typeof value !== "object" || value === null) return undefined
  const data = Reflect.get(value, "data")
  const cursor = Reflect.get(value, "cursor")
  if (cursor !== undefined && (typeof cursor !== "object" || cursor === null || Array.isArray(cursor))) return undefined
  const next = typeof cursor === "object" && cursor !== null ? Reflect.get(cursor, "next") : undefined
  if (!Array.isArray(data) || next !== undefined && (typeof next !== "string" || next.length === 0 || next.length > 1_024)) return undefined
  const tasks = data.flatMap((item: unknown) => { const task = readTeamTask(item); return task ? [task] : [] })
  if (tasks.length !== data.length || tasks.some(task => task.parentID !== parentID || task.sessionID === parentID) || new Set(tasks.map(task => task.sessionID)).size !== tasks.length) return undefined
  return { tasks, ...(typeof next === "string" ? { next } : {}) }
}
