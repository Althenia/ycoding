export * as SessionAutonomy from "./autonomy"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, SchemaGetter } from "effect"
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

export interface Effective {
  readonly yolo: boolean
  readonly permissionsAuto: boolean
  readonly permissionModelReviews: boolean
  readonly asleep: boolean
  readonly guardrailsEnabled: boolean
  readonly ordinaryReviewsAuto: boolean
  readonly modelReviews: boolean
  readonly hardModelReviews: boolean
}

export const Sleep = Schema.Struct({}).pipe(
  Schema.decodeTo(Schema.Struct({}), {
    decode: SchemaGetter.transform(() => ({})),
    encode: SchemaGetter.transform(() => ({})),
  }),
)
export type Sleep = typeof Sleep.Type

export const State = Schema.Struct({
  mode: Mode,
  yolo: Schema.Boolean,
  autoPermission: Schema.Boolean.pipe(Schema.optional),
  autoGuardrail: Schema.Boolean.pipe(Schema.optional),
  goal: Goal.pipe(Schema.optional),
  sleep: Sleep.pipe(Schema.optional),
  autoAnswer: Schema.Boolean.pipe(Schema.optional),
})
export type State = typeof State.Type

export const defaultState: State = { mode: "normal", yolo: false }
const decode = Schema.decodeUnknownOption(State)

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionAutonomy.NotFound", {
  sessionID: SessionSchema.ID,
}) {}

function requireYolo(input: unknown): boolean {
  if (typeof input !== "boolean") throw new TypeError(`Invalid yolo value: ${String(input)}`)
  return input
}

export function canYolo(state: State): boolean {
  return state.yolo
}

export function canAutoAnswer(state: State): boolean {
  return state.autoAnswer === true
}

export function canAutoPermission(state: State): boolean {
  return state.autoPermission === true
}

export function canAutoGuardrail(state: State): boolean {
  return state.autoGuardrail === true
}

export function isAsleep(state: State): boolean {
  return state.sleep !== undefined
}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly snapshot: (
    sessionID: SessionSchema.ID,
    options?: { readonly inherited: true },
  ) => Effect.Effect<{ readonly state: State; readonly sequence: number; readonly digest: string }, NotFoundError>
  readonly canYolo: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly canAutoAnswer: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly canAutoPermission: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly canAutoGuardrail: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly isAsleep: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly setMode: (input: {
    sessionID: SessionSchema.ID
    mode: "normal" | "yolo"
  }) => Effect.Effect<State, NotFoundError>
  readonly setYolo: (input: { sessionID: SessionSchema.ID; yolo: boolean }) => Effect.Effect<State, NotFoundError>
  readonly setGoal: (input: {
    sessionID: SessionSchema.ID
    text: string
    rawText?: string
    maxNoProgress?: number
  }) => Effect.Effect<State, NotFoundError>
  readonly setGoalIfCurrent: (input: {
    sessionID: SessionSchema.ID
    expectedSequence: number
    yolo?: boolean
    text: string
    rawText?: string
    maxNoProgress?: number
  }) => Effect.Effect<{ readonly state: State; readonly applied: boolean }, NotFoundError>
  readonly resumeGoalIfCurrent: (input: {
    sessionID: SessionSchema.ID
    expectedSequence: number
    yolo?: boolean
  }) => Effect.Effect<{ readonly state: State; readonly applied: boolean }, NotFoundError>
  readonly clearGoal: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly set: (input: {
    sessionID: SessionSchema.ID
    yolo?: boolean
    goal?: string | null | true
    rawText?: string
    maxNoProgress?: number
    sleep?: boolean
    autoAnswer?: boolean
    autoPermission?: boolean
    autoGuardrail?: boolean
  }) => Effect.Effect<State, NotFoundError>
  readonly stop: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly report: (input: { sessionID: SessionSchema.ID }) => Effect.Effect<State, NotFoundError>
  readonly complete: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly advance: (input: {
    sessionID: SessionSchema.ID
    progress: string
    completed?: boolean
  }) => Effect.Effect<State, NotFoundError>
  readonly advanceIfCurrent: (input: {
    sessionID: SessionSchema.ID
    expectedSequence: number
  }) => Effect.Effect<{ readonly state: State; readonly applied: boolean }, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionAutonomy") {}

export const read = (value: unknown): State => {
  const parsed = decode(value)
  return parsed._tag === "Some" ? parsed.value : defaultState
}

export const AutomaticAnswer = "Continue with the safest reasonable default."

export function makeGoal(input: { text: string; rawText?: string; maxNoProgress?: number }): Goal {
  return {
    text: input.text.trim(),
    rawText: (input.rawText ?? input.text).trim(),
    status: "active",
    iteration: 0,
    noProgress: 0,
    maxNoProgress: Math.max(1, Math.trunc(input.maxNoProgress ?? 3)),
  }
}

export function make(input: { db: Database.Interface["db"] }): Interface {
  const snapshot: Interface["snapshot"] = (sessionID, options) =>
    Effect.gen(function* () {
      const row = yield* input.db
        .select({ autonomy: SessionTable.autonomy, sequence: SessionTable.autonomy_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError({ sessionID })
      const state = read(row.autonomy)
      if (!options?.inherited)
        return { state, sequence: row.sequence, digest: Hash.sha256(canonicalJSON(state)) }
      const task = yield* input.db
        .select({ parentID: SessionTaskTable.parent_id })
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const parent = task
        ? yield* snapshot(task.parentID, options).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
        : undefined
      return {
        state,
        sequence: row.sequence,
        digest: Hash.sha256(canonicalJSON([sessionID, row.sequence, state, parent?.digest ?? null])),
      }
    })

  const load = (sessionID: SessionSchema.ID) => snapshot(sessionID).pipe(Effect.map((value) => value.state))

  const familyID = (sessionID: SessionSchema.ID): Effect.Effect<SessionSchema.ID> =>
    input.db
      .select({ parentID: SessionTable.parent_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(
        Effect.orDie,
        Effect.flatMap((task) => (task?.parentID ? familyID(task.parentID) : Effect.succeed(sessionID))),
      )

  const familyState = (sessionID: SessionSchema.ID) =>
    Effect.gen(function* () {
      const state = yield* load(sessionID)
      const rootID = yield* familyID(sessionID)
      if (rootID === sessionID) return state
      const root = yield* load(rootID)
      return { ...state, sleep: root.sleep }
    })

  const mutate = (
    sessionID: SessionSchema.ID,
    transition: (state: State) => State | undefined,
    expectedSequence?: number,
  ) =>
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
            if (expectedSequence !== undefined && row.revision !== expectedSequence) return { state, applied: false }
            const next = transition(state)
            if (!next) return { state, applied: false }
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
            return { state: next, applied: true }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))

  const apply = (sessionID: SessionSchema.ID, transition: (state: State) => State | undefined) =>
    mutate(sessionID, transition).pipe(Effect.map((result) => result.state))

  const walkEffective = (
    sessionID: SessionSchema.ID,
  ): Effect.Effect<{ yolo: boolean; autoPermission: boolean; autoGuardrail: boolean }, NotFoundError> =>
    load(sessionID).pipe(
      Effect.flatMap((state) => {
        const current = {
          yolo: canYolo(state),
          autoPermission: canAutoPermission(state),
          autoGuardrail: canAutoGuardrail(state),
        }
        return input.db
          .select({ parentID: SessionTaskTable.parent_id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.flatMap((task) => {
              if (!task) return Effect.succeed(current)
              return walkEffective(task.parentID).pipe(
                Effect.map((parent) => ({
                  yolo: current.yolo || parent.yolo,
                  autoPermission: current.autoPermission || parent.autoPermission,
                  autoGuardrail: current.autoGuardrail || parent.autoGuardrail,
                })),
                Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(current)),
              )
            }),
          )
      }),
    )

  const canYoloEffect: Interface["canYolo"] = (sessionID) => walkEffective(sessionID).pipe(Effect.map((v) => v.yolo))

  const canAutoAnswerEffect: Interface["canAutoAnswer"] = (sessionID) => load(sessionID).pipe(Effect.map(canAutoAnswer))

  const canAutoPermissionEffect: Interface["canAutoPermission"] = (sessionID) =>
    walkEffective(sessionID).pipe(Effect.map((v) => v.autoPermission))

  const canAutoGuardrailEffect: Interface["canAutoGuardrail"] = (sessionID) =>
    walkEffective(sessionID).pipe(Effect.map((v) => v.autoGuardrail))

  const isAsleepEffect: Interface["isAsleep"] = (sessionID) => familyState(sessionID).pipe(Effect.map(isAsleep))

  const setYolo: Interface["setYolo"] = ({ sessionID, yolo }) =>
    Effect.suspend(() => {
      const value = requireYolo(yolo)
      return apply(sessionID, (state) => {
        if (state.yolo === value) return undefined
        return { ...state, mode: "normal", yolo: value }
      })
    })

  const setMode: Interface["setMode"] = ({ sessionID, mode }) => setYolo({ sessionID, yolo: mode === "yolo" })

  const goalState = (state: State, text: string, rawText: string | undefined, maxNoProgress: number): State => ({
    ...state,
    mode: "normal",
    yolo: state.yolo,
    goal: makeGoal({ text, rawText, maxNoProgress }),
  })

  const setGoal: Interface["setGoal"] = ({ sessionID, text, rawText, maxNoProgress = 3 }) =>
    apply(sessionID, (state) => goalState(state, text, rawText, maxNoProgress))

  const setGoalIfCurrent: Interface["setGoalIfCurrent"] = ({
    sessionID,
    expectedSequence,
    yolo,
    text,
    rawText,
    maxNoProgress = 3,
  }) =>
    mutate(
      sessionID,
      (state) => ({
        ...goalState(state, text, rawText, maxNoProgress),
        yolo: yolo === undefined ? state.yolo : requireYolo(yolo),
      }),
      expectedSequence,
    )

  const resumeGoalIfCurrent: Interface["resumeGoalIfCurrent"] = ({ sessionID, expectedSequence, yolo }) =>
    mutate(
      sessionID,
      (state) => {
        if (!state.goal) return undefined
        return {
          ...state,
          mode: "normal",
          yolo: yolo === undefined ? state.yolo : requireYolo(yolo),
          goal: { ...state.goal, status: "active" as const },
        }
      },
      expectedSequence,
    )

  const clearGoal: Interface["clearGoal"] = (sessionID) =>
    apply(sessionID, (state) => {
      // Persist stop intent to fence calculations even before the first goal exists.
      if (!state.goal || state.goal.status === "stopped") return state
      return {
        ...state,
        mode: "normal",
        yolo: state.yolo,
        goal: { ...state.goal, status: "stopped" as const },
      }
    })

  const set: Interface["set"] = ({
    sessionID,
    yolo,
    goal,
    rawText,
    maxNoProgress,
    sleep,
    autoAnswer,
    autoPermission,
    autoGuardrail,
  }) =>
    Effect.suspend(() => {
      if (yolo !== undefined) requireYolo(yolo)
      return apply(sessionID, (state) => {
        let next: State = { ...state, mode: "normal" }
        let changed = false
        if (sleep !== undefined) {
          if (sleep && !next.sleep) {
            next = { ...next, sleep: {} }
            changed = true
          }
          if (!sleep && next.sleep) {
            next = { ...next, sleep: undefined }
            changed = true
          }
        }
        if (yolo !== undefined) {
          const level = requireYolo(yolo)
          if (next.yolo !== level) {
            next = { ...next, yolo: level }
            changed = true
          }
        }
        if (autoAnswer !== undefined && next.autoAnswer !== autoAnswer) {
          next = { ...next, autoAnswer }
          changed = true
        }
        if (autoPermission !== undefined && next.autoPermission !== autoPermission) {
          next = { ...next, autoPermission }
          changed = true
        }
        if (autoGuardrail !== undefined && next.autoGuardrail !== autoGuardrail) {
          next = { ...next, autoGuardrail }
          changed = true
        }
        if (goal !== undefined) {
          if (goal === null) {
            changed = true
            if (next.goal && next.goal.status !== "stopped") {
              next = { ...next, goal: { ...next.goal, status: "stopped" as const } }
            }
          } else if (goal === true) {
            // Resume the retained goal without recalculating it; the user alone re-activates.
            if (next.goal && next.goal.status !== "active") {
              next = { ...next, goal: { ...next.goal, status: "active" as const } }
              changed = true
            }
          } else {
            const trimmed = goal.trim()
            if (!trimmed) return next
            const isSameActive = next.goal?.status === "active" && (next.goal.rawText ?? next.goal.text) === trimmed
            if (isSameActive && yolo === undefined) return changed ? next : undefined
            next = {
              ...next,
              goal: makeGoal({ text: trimmed, rawText, maxNoProgress }),
            }
            changed = true
          }
        }
        return changed ? next : undefined
      })
    })

  return {
    get: familyState,
    snapshot,
    canYolo: canYoloEffect,
    canAutoAnswer: canAutoAnswerEffect,
    canAutoPermission: canAutoPermissionEffect,
    canAutoGuardrail: canAutoGuardrailEffect,
    isAsleep: isAsleepEffect,
    setMode,
    setYolo,
    setGoal,
    setGoalIfCurrent,
    resumeGoalIfCurrent,
    clearGoal,
    set,
    stop: (sessionID) => clearGoal(sessionID),
    report: ({ sessionID }) =>
      apply(sessionID, (state) => {
        const goal = state.goal
        if (!goal || goal.status !== "active") return undefined
        const noProgress = goal.noProgress + 1
        const status: GoalStatus = noProgress >= goal.maxNoProgress ? "exhausted" : "active"
        return {
          ...state,
          mode: "normal",
          yolo: state.yolo,
          goal: {
            ...goal,
            status,
            noProgress,
          },
        }
      }),
    complete: (sessionID) =>
      apply(sessionID, (state) => {
        const goal = state.goal
        if (!goal || goal.status !== "active") return undefined
        return { ...state, goal: { ...goal, status: "completed" as const } }
      }),
    advance: ({ sessionID, completed = false }) =>
      apply(sessionID, (state) => {
        const goal = state.goal
        if (!goal || goal.status !== "active") return undefined
        if (completed) return { ...state, goal: { ...goal, status: "completed" as const } }
        return { ...state, goal: { ...goal, iteration: goal.iteration + 1 } }
      }),
    advanceIfCurrent: ({ sessionID, expectedSequence }) =>
      mutate(
        sessionID,
        (state) => {
          const goal = state.goal
          if (!goal || goal.status !== "active") return undefined
          return { ...state, goal: { ...goal, iteration: goal.iteration + 1 } }
        },
        expectedSequence,
      ),
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
