export * as SessionAutonomy from "./autonomy"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema, SchemaGetter } from "effect"
import { Category, DecisionMode, Decisions } from "@ycoding-ai/schema/session-autonomy"
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

export interface EffectiveDecisions extends Decisions {
  readonly inherited: { readonly [K in Category]?: SessionSchema.ID }
}

export interface Effective extends EffectiveDecisions {
  readonly asleep: boolean
  readonly guardrailsEnabled: boolean
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
  ...Decisions.fields,
  goal: Goal.pipe(Schema.optional),
  sleep: Sleep.pipe(Schema.optional),
})
export type State = typeof State.Type

export const defaultState: State = { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual" }
const decode = Schema.decodeUnknownOption(State)
const isDecisionMode = Schema.is(DecisionMode)
const removedKeys = ["yolo", "autoPermission", "autoGuardrail", "autoAnswer"]

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionAutonomy.NotFound", {
  sessionID: SessionSchema.ID,
}) {}

function requireDecisionMode(category: Category, input: unknown): DecisionMode {
  if (!isDecisionMode(input)) throw new TypeError(`Invalid ${category} decision mode: ${String(input)}`)
  return input
}

export function decisions(state: State): Decisions {
  return { permissions: state.permissions, guardrails: state.guardrails, answers: state.answers }
}

export function resolveDecisions(chain: ReadonlyArray<State>, root: State): Decisions {
  return {
    permissions: chain.some((state) => state.permissions === "auto")
      ? "auto"
      : chain.some((state) => state.permissions === "yolo")
        ? "yolo"
        : "manual",
    guardrails: root.guardrails,
    answers: chain[0]?.answers === "auto" ? "auto" : chain.some((state) => state.answers === "yolo") ? "yolo" : "manual",
  }
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
  readonly effectiveDecisions: (sessionID: SessionSchema.ID) => Effect.Effect<EffectiveDecisions, NotFoundError>
  readonly decisionMode: (sessionID: SessionSchema.ID, category: Category) => Effect.Effect<DecisionMode, NotFoundError>
  readonly isAsleep: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly setGoal: (input: {
    sessionID: SessionSchema.ID
    text: string
    rawText?: string
    maxNoProgress?: number
  }) => Effect.Effect<State, NotFoundError>
  readonly setGoalIfCurrent: (input: {
    sessionID: SessionSchema.ID
    expectedSequence: number
    text: string
    rawText?: string
    maxNoProgress?: number
  }) => Effect.Effect<{ readonly state: State; readonly applied: boolean }, NotFoundError>
  readonly resumeGoalIfCurrent: (input: {
    sessionID: SessionSchema.ID
    expectedSequence: number
  }) => Effect.Effect<{ readonly state: State; readonly applied: boolean }, NotFoundError>
  readonly clearGoal: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly set: (input: {
    sessionID: SessionSchema.ID
    permissions?: DecisionMode
    guardrails?: DecisionMode
    answers?: DecisionMode
    goal?: string | null | true
    rawText?: string
    maxNoProgress?: number
    sleep?: boolean
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
  if (typeof value === "object" && value !== null && removedKeys.some((key) => key in value)) return defaultState
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

  const managedChain = (
    sessionID: SessionSchema.ID,
  ): Effect.Effect<ReadonlyArray<{ readonly id: SessionSchema.ID; readonly state: State }>, NotFoundError> =>
    load(sessionID).pipe(
      Effect.flatMap((state) =>
        input.db
          .select({ parentID: SessionTaskTable.parent_id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.flatMap((task) =>
              task
                ? managedChain(task.parentID).pipe(
                    Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed([])),
                  )
                : Effect.succeed([]),
            ),
            Effect.map((ancestors) => [{ id: sessionID, state }, ...ancestors]),
          ),
      ),
    )

  const effectiveDecisions: Interface["effectiveDecisions"] = (sessionID) =>
    Effect.gen(function* () {
      const chain = yield* managedChain(sessionID)
      const local = chain[0]!.state
      const ancestors = chain.slice(1)
      const rootID = yield* familyID(sessionID)
      const resolved = resolveDecisions(
        chain.map((item) => item.state),
        rootID === sessionID ? local : yield* load(rootID),
      )
      const permissions = resolved.permissions
      const answers = resolved.answers
      const guardrails = resolved.guardrails
      const permissionSource =
        permissions === local.permissions ? undefined : ancestors.find((item) => item.state.permissions === permissions)?.id
      const answerSource = answers === local.answers ? undefined : ancestors.find((item) => item.state.answers === answers)?.id
      return {
        permissions,
        guardrails,
        answers,
        inherited: {
          ...(permissionSource === undefined ? {} : { permissions: permissionSource }),
          ...(rootID === sessionID ? {} : { guardrails: rootID }),
          ...(answerSource === undefined ? {} : { answers: answerSource }),
        },
      }
    })

  const decisionMode: Interface["decisionMode"] = (sessionID, category) =>
    effectiveDecisions(sessionID).pipe(Effect.map((effective) => effective[category]))

  const isAsleepEffect: Interface["isAsleep"] = (sessionID) => familyState(sessionID).pipe(Effect.map(isAsleep))

  const goalState = (state: State, text: string, rawText: string | undefined, maxNoProgress: number): State => ({
    ...state,
    mode: "normal",
    goal: makeGoal({ text, rawText, maxNoProgress }),
  })

  const setGoal: Interface["setGoal"] = ({ sessionID, text, rawText, maxNoProgress = 3 }) =>
    apply(sessionID, (state) => goalState(state, text, rawText, maxNoProgress))

  const setGoalIfCurrent: Interface["setGoalIfCurrent"] = ({ sessionID, expectedSequence, text, rawText, maxNoProgress = 3 }) =>
    mutate(sessionID, (state) => goalState(state, text, rawText, maxNoProgress), expectedSequence)

  const resumeGoalIfCurrent: Interface["resumeGoalIfCurrent"] = ({ sessionID, expectedSequence }) =>
    mutate(
      sessionID,
      (state) => {
        if (!state.goal) return undefined
        return { ...state, mode: "normal", goal: { ...state.goal, status: "active" as const } }
      },
      expectedSequence,
    )

  const clearGoal: Interface["clearGoal"] = (sessionID) =>
    apply(sessionID, (state) => {
      // Persist stop intent to fence calculations even before the first goal exists.
      if (!state.goal || state.goal.status === "stopped") return state
      return { ...state, mode: "normal", goal: { ...state.goal, status: "stopped" as const } }
    })

  const set: Interface["set"] = ({ sessionID, goal, rawText, maxNoProgress, sleep, ...requested }) =>
    Effect.suspend(() => {
      const permissions = requested.permissions === undefined ? undefined : requireDecisionMode("permissions", requested.permissions)
      const guardrails = requested.guardrails === undefined ? undefined : requireDecisionMode("guardrails", requested.guardrails)
      const answers = requested.answers === undefined ? undefined : requireDecisionMode("answers", requested.answers)
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
        const decided: State = {
          ...next,
          ...(permissions === undefined ? {} : { permissions }),
          ...(guardrails === undefined ? {} : { guardrails }),
          ...(answers === undefined ? {} : { answers }),
        }
        if (
          decided.permissions !== next.permissions ||
          decided.guardrails !== next.guardrails ||
          decided.answers !== next.answers
        ) {
          next = decided
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
            if (isSameActive) return changed ? next : undefined
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
    effectiveDecisions,
    decisionMode,
    isAsleep: isAsleepEffect,
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
        return { ...state, mode: "normal", goal: { ...goal, status, noProgress } }
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
