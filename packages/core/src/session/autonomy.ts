export * as SessionAutonomy from "./autonomy"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { canonicalJSON } from "./context-manifest"
import { SessionSchema } from "./schema"
import { SessionTable, SessionTaskTable } from "./sql"

export const Mode = Schema.Literals(["normal"])
export type Mode = typeof Mode.Type

export const GoalStatus = Schema.Literals(["active", "completed", "stopped", "exhausted"])
export type GoalStatus = typeof GoalStatus.Type

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Goal = Schema.Struct({
  text: Schema.String,
  rawText: Schema.String.pipe(Schema.optional),
  status: GoalStatus,
  iteration: NonNegativeInt,
  noProgress: NonNegativeInt,
  maxNoProgress: PositiveInt,
  lastProgressDigest: Schema.String.pipe(Schema.optional),
})
export type Goal = typeof Goal.Type

export const YoloLevel = Schema.Literals([0, 1, 2, 3])
export type YoloLevel = typeof YoloLevel.Type

export const YOLO_LEVEL_OFF = 0 as const
export const YOLO_LEVEL_QUESTIONS = 1 as const
export const YOLO_LEVEL_PERMISSIONS = 2 as const
export const YOLO_LEVEL_GUARDRAIL = 3 as const

export const State = Schema.Struct({
  mode: Mode,
  yolo: YoloLevel,
  goal: Goal.pipe(Schema.optional),
})
export type State = typeof State.Type

export const defaultState: State = { mode: "normal", yolo: 0 }
const decode = Schema.decodeUnknownOption(State)
// Legacy shape before toggle redesign: mode could be yolo/goal and yolo field absent or boolean
const LegacyState = Schema.Struct({
  mode: Schema.Literals(["normal", "yolo", "goal"]),
  yolo: Schema.optional(Schema.Unknown),
  goal: Goal.pipe(Schema.optional),
})
const decodeLegacy = Schema.decodeUnknownOption(LegacyState)

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionAutonomy.NotFound", {
  sessionID: SessionSchema.ID,
}) {}

export function normalizeYolo(input: unknown): number {
  if (typeof input === "boolean") return input ? 2 : 0
  if (typeof input === "number" && Number.isFinite(input)) {
    const truncated = Math.trunc(input)
    if (truncated >= 0 && truncated <= 3) return truncated
  }
  return 0
}

export function yoloLevel(state: State): number {
  return typeof state.yolo === "number" ? state.yolo : normalizeYolo(state.yolo)
}

export function canAutoAnswer(state: State): boolean {
  return yoloLevel(state) >= YOLO_LEVEL_QUESTIONS || state.goal?.status === "active"
}

export function canAutoPermission(state: State): boolean {
  return yoloLevel(state) >= YOLO_LEVEL_PERMISSIONS || state.goal?.status === "active"
}

export function canAutoGuardrail(state: State): boolean {
  return yoloLevel(state) >= YOLO_LEVEL_GUARDRAIL
}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly snapshot: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<{ readonly state: State; readonly sequence: number; readonly digest: string }, NotFoundError>
  readonly isAutonomous: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly yoloLevel: (sessionID: SessionSchema.ID) => Effect.Effect<number, NotFoundError>
  readonly effectiveYoloLevel: (sessionID: SessionSchema.ID) => Effect.Effect<number, NotFoundError>
  readonly canAutoAnswer: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly canAutoPermission: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly canAutoGuardrail: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly setMode: (input: {
    sessionID: SessionSchema.ID
    mode: "normal" | "yolo"
  }) => Effect.Effect<State, NotFoundError>
  readonly setYolo: (input: { sessionID: SessionSchema.ID; yolo: number | boolean }) => Effect.Effect<State, NotFoundError>
  readonly setGoal: (input: {
    sessionID: SessionSchema.ID
    text: string
    rawText?: string
    maxNoProgress?: number
  }) => Effect.Effect<State, NotFoundError>
  readonly clearGoal: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly set: (input: {
    sessionID: SessionSchema.ID
    yolo?: number | boolean
    goal?: string | null
    rawText?: string
    maxNoProgress?: number
  }) => Effect.Effect<State, NotFoundError>
  readonly stop: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly report: (input: {
    sessionID: SessionSchema.ID
    noProgress: boolean
  }) => Effect.Effect<State, NotFoundError>
  readonly complete: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly advance: (input: {
    sessionID: SessionSchema.ID
    progress: string
    completed?: boolean
  }) => Effect.Effect<State, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionAutonomy") {}

export const read = (value: unknown): State => {
  const parsed = decode(value)
  if (parsed._tag === "Some") return parsed.value
  const legacy = decodeLegacy(value)
  if (legacy._tag === "Some") {
    const v = legacy.value
    const level = v.yolo === undefined ? 0 : normalizeYolo(v.yolo)
    if (v.mode === "yolo") return { mode: "normal", yolo: 2 as YoloLevel, ...(v.goal ? { goal: v.goal } : {}) }
    if (v.mode === "goal") return { mode: "normal", yolo: level as YoloLevel, ...(v.goal ? { goal: v.goal } : {}) }
    return { mode: "normal", yolo: level as YoloLevel, ...(v.goal ? { goal: v.goal } : {}) }
  }
  if (value && typeof value === "object" && "yolo" in (value as Record<string, unknown>)) {
    const maybe = value as { yolo?: unknown; goal?: unknown; mode?: unknown }
    const level = normalizeYolo(maybe.yolo)
    if (maybe.goal && typeof (maybe.goal as Goal).text === "string") {
      return {
        mode: "normal",
        yolo: level as YoloLevel,
        goal: maybe.goal as Goal,
      }
    }
    return { mode: "normal", yolo: level as YoloLevel, ...(maybe.goal && typeof (maybe.goal as Goal).text === "string" ? { goal: maybe.goal as Goal } : {}) }
  }
  if (value && typeof value === "object" && "mode" in (value as Record<string, unknown>)) {
    const maybe = value as { mode?: unknown; goal?: unknown }
    if (maybe.goal && typeof (maybe.goal as Goal).text === "string") {
      return { mode: "normal", yolo: 0 as YoloLevel, goal: maybe.goal as Goal }
    }
  }
  return defaultState
}

export const AutomaticAnswer = "Continue with the safest reasonable default."

export function requestsUserInput(value: string) {
  const text = value.trim()
  if (!text) return false
  const tail = text.slice(-2_000)
  if (/\?\s*$/.test(tail)) return true
  return /(?:^|[\n.!?]\s*)(?:please\s+)?(?:choose|select|provide|confirm|clarify|decide)\b[^.!?]*[.!]?\s*$/i.test(tail)
}

export function continuationPrompt(goal: Goal, input: { readonly latestAssistantText?: string } = {}) {
  const latestAssistantText = input.latestAssistantText?.trim()
  const proxy =
    latestAssistantText && requestsUserInput(latestAssistantText)
      ? [
          "The assistant is waiting for user input.",
          `Latest assistant request: ${latestAssistantText.slice(-2_000)}`,
          "Answer it on the user's behalf using the active goal, conversation context, and safest reasonable default before continuing.",
        ]
      : []
  return [
    "Continue autonomously toward the active user goal.",
    `Goal: ${goal.text}`,
    `Continuation: ${goal.iteration + 1}`,
    ...proxy,
    "Use the conversation and current repository state to choose the next useful action.",
    "Answer routine blockers yourself using the safest reasonable default.",
    "Before ending this autonomous iteration, call goal report exactly once with your explicit no-progress decision.",
    "An active background subagent or shell is unfinished work, not automatic no progress; continue useful independent work or finish this iteration and wait for its automatic notification.",
    "When the goal is actually achieved and verified, call goal complete. Completion remains your explicit decision.",
    "Do not claim completion without verification evidence or the goal complete action.",
  ].join("\n")
}

export function make(input: { db: Database.Interface["db"] }): Interface {
  const snapshot: Interface["snapshot"] = (sessionID) =>
    input.db
      .select({ autonomy: SessionTable.autonomy, sequence: SessionTable.autonomy_revision })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(
        Effect.orDie,
        Effect.flatMap((row) =>
          row
            ? Effect.succeed({
                state: read(row.autonomy),
                sequence: row.sequence,
                digest: Hash.sha256(canonicalJSON(read(row.autonomy))),
              })
            : Effect.fail(new NotFoundError({ sessionID })),
        ),
      )

  const load = (sessionID: SessionSchema.ID) => snapshot(sessionID).pipe(Effect.map((value) => value.state))

  const mutate = (sessionID: SessionSchema.ID, transition: (state: State) => State | undefined) =>
    input.db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select({ autonomy: SessionTable.autonomy, revision: SessionTable.autonomy_revision })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new NotFoundError({ sessionID })
            const state = read(row.autonomy)
            const next = transition(state)
            if (!next) return state
            const updated = yield* tx
              .update(SessionTable)
              .set({
                autonomy: next,
                autonomy_revision: sql`${SessionTable.autonomy_revision} + 1`,
                time_updated: Date.now(),
              })
              .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.autonomy_revision, row.revision)))
              .returning({ revision: SessionTable.autonomy_revision })
              .get()
              .pipe(Effect.orDie)
            if (!updated) return yield* Effect.die(new Error(`Concurrent autonomy mutation for ${sessionID}`))
            return next
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))

  const walkEffective = (sessionID: SessionSchema.ID): Effect.Effect<{ yolo: number; goalActive: boolean }, NotFoundError> =>
    load(sessionID).pipe(
      Effect.flatMap((state) => {
        const currentYolo = yoloLevel(state)
        const currentGoal = state.goal?.status === "active"
        return input.db
          .select({ parentID: SessionTaskTable.parent_id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.flatMap((task) => {
              if (!task) return Effect.succeed({ yolo: currentYolo, goalActive: currentGoal })
              return walkEffective(task.parentID).pipe(
                Effect.map((parent) => ({
                  yolo: Math.max(currentYolo, parent.yolo),
                  goalActive: currentGoal || parent.goalActive,
                })),
                Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed({ yolo: currentYolo, goalActive: currentGoal })),
              )
            }),
          )
      }),
    )

  const effectiveYoloLevel: Interface["effectiveYoloLevel"] = (sessionID) =>
    walkEffective(sessionID).pipe(Effect.map((v) => v.yolo))

  const yoloLevelEffect: Interface["yoloLevel"] = (sessionID) => effectiveYoloLevel(sessionID)

  const canAutoAnswerEffect: Interface["canAutoAnswer"] = (sessionID) =>
    walkEffective(sessionID).pipe(Effect.map((v) => v.yolo >= YOLO_LEVEL_QUESTIONS || v.goalActive))

  const canAutoPermissionEffect: Interface["canAutoPermission"] = (sessionID) =>
    walkEffective(sessionID).pipe(Effect.map((v) => v.yolo >= YOLO_LEVEL_PERMISSIONS || v.goalActive))

  const canAutoGuardrailEffect: Interface["canAutoGuardrail"] = (sessionID) =>
    walkEffective(sessionID).pipe(Effect.map((v) => v.yolo >= YOLO_LEVEL_GUARDRAIL))

  const isAutonomous: Interface["isAutonomous"] = (sessionID) =>
    walkEffective(sessionID).pipe(Effect.map((v) => v.yolo > 0 || v.goalActive))

  const setYolo: Interface["setYolo"] = ({ sessionID, yolo }) => {
    const level = normalizeYolo(yolo) as YoloLevel
    return mutate(sessionID, (state) => {
      if (state.yolo === level) return undefined
      return { ...state, mode: "normal", yolo: level }
    })
  }

  const setMode: Interface["setMode"] = ({ sessionID, mode }) => setYolo({ sessionID, yolo: mode === "yolo" })

  const setGoal: Interface["setGoal"] = ({ sessionID, text, rawText, maxNoProgress = 3 }) =>
    mutate(sessionID, (state) => ({
      mode: "normal",
      yolo: state.yolo,
      goal: {
        text: text.trim(),
        rawText: (rawText ?? text).trim(),
        status: "active",
        iteration: 0,
        noProgress: 0,
        maxNoProgress: Math.max(1, Math.trunc(maxNoProgress)),
      },
    }))

  const clearGoal: Interface["clearGoal"] = (sessionID) =>
    mutate(sessionID, (state) => {
      if (!state.goal) return undefined
      if (state.goal.status === "stopped") return undefined
      return {
        mode: "normal",
        yolo: state.yolo,
        goal: { ...state.goal, status: "stopped" as const },
      }
    })

  const set: Interface["set"] = ({ sessionID, yolo, goal, rawText, maxNoProgress }) =>
    mutate(sessionID, (state) => {
      let next: State = { ...state, mode: "normal" }
      let changed = false
      if (yolo !== undefined) {
        const level = normalizeYolo(yolo) as YoloLevel
        if (next.yolo !== level) {
          next = { ...next, yolo: level }
          changed = true
        }
      }
      if (goal !== undefined) {
        if (goal === null) {
          if (next.goal && next.goal.status !== "stopped") {
            next = { ...next, goal: { ...next.goal, status: "stopped" as const } }
            changed = true
          }
        } else {
          const trimmed = goal.trim()
          if (!trimmed) return next
          const isSameActive =
            next.goal?.status === "active" && (next.goal.rawText ?? next.goal.text) === trimmed
          if (isSameActive && yolo === undefined) return changed ? next : undefined
          next = {
            ...next,
            goal: {
              text: trimmed,
              rawText: (rawText ?? trimmed).trim(),
              status: "active",
              iteration: 0,
              noProgress: 0,
              maxNoProgress: Math.max(1, Math.trunc(maxNoProgress ?? 3)),
            },
          }
          changed = true
        }
      }
      return changed ? next : undefined
    })

  return {
    get: (sessionID) => load(sessionID),
    snapshot,
    isAutonomous,
    yoloLevel: yoloLevelEffect,
    effectiveYoloLevel,
    canAutoAnswer: canAutoAnswerEffect,
    canAutoPermission: canAutoPermissionEffect,
    canAutoGuardrail: canAutoGuardrailEffect,
    setMode,
    setYolo,
    setGoal,
    clearGoal,
    set,
    stop: (sessionID) => clearGoal(sessionID),
    report: ({ sessionID, noProgress: reportedNoProgress }) =>
      mutate(sessionID, (state) => {
        const goal = state.goal
        if (!goal || goal.status !== "active") return undefined
        const iteration = goal.iteration + 1
        const noProgress = reportedNoProgress ? goal.noProgress + 1 : 0
        const status: GoalStatus = noProgress >= goal.maxNoProgress ? "exhausted" : "active"
        return {
          mode: "normal",
          yolo: state.yolo,
          goal: {
            ...goal,
            status,
            iteration,
            noProgress,
          },
        }
      }),
    complete: (sessionID) =>
      mutate(sessionID, (state) => {
        const goal = state.goal
        if (!goal || goal.status !== "active") return undefined
        return { ...state, goal: { ...goal, status: "completed" as const } }
      }),
    advance: ({ sessionID, completed = false }) =>
      completed
        ? mutate(sessionID, (state) => {
            const goal = state.goal
            if (!goal || goal.status !== "active") return undefined
            return { ...state, goal: { ...goal, status: "completed" as const } }
          })
        : load(sessionID),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return Service.of(make({ db }))
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
