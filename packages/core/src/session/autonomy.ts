export * as SessionAutonomy from "./autonomy"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { SessionSchema } from "./schema"
import { SessionTable, SessionTaskTable } from "./sql"

export const Mode = Schema.Literals(["normal", "yolo", "goal"])
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

export const State = Schema.Struct({
  mode: Mode,
  goal: Goal.pipe(Schema.optional),
})
export type State = typeof State.Type

export const defaultState: State = { mode: "normal" }
const decode = Schema.decodeUnknownOption(State)

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionAutonomy.NotFound", {
  sessionID: SessionSchema.ID,
}) {}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly isAutonomous: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, NotFoundError>
  readonly setMode: (input: {
    sessionID: SessionSchema.ID
    mode: Exclude<Mode, "goal">
  }) => Effect.Effect<State, NotFoundError>
  readonly setGoal: (input: {
    sessionID: SessionSchema.ID
    text: string
    rawText?: string
    maxNoProgress?: number
  }) => Effect.Effect<State, NotFoundError>
  readonly stop: (sessionID: SessionSchema.ID) => Effect.Effect<State, NotFoundError>
  readonly advance: (input: {
    sessionID: SessionSchema.ID
    progress: string
    completed?: boolean
  }) => Effect.Effect<State, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionAutonomy") {}

export const read = (value: unknown): State => {
  const parsed = decode(value)
  return parsed._tag === "Some" ? parsed.value : defaultState
}

export const CompletionMarker = "<goal-complete/>"
export const AutomaticAnswer = "Continue with the safest reasonable default."

/**
 * Source of the marker as models actually emit it. Providers routinely reformat a self-closing tag
 * to `<goal-complete />`, and a turn that ended goal work but missed the exact spelling would
 * otherwise continue the loop. Rendering mirrors this pattern so no variant leaks
 * into the transcript; a TUI test pins the two together.
 */
export const CompletionPattern = "<goal-complete\\s*/>"
const completion = new RegExp(CompletionPattern)

export const progressDigest = (value: string) => Hash.sha256(value.trim())

export function isCompleted(progress: string) {
  return completion.test(progress)
}

export function requestsUserInput(value: string) {
  const text = value.trim()
  if (!text) return false
  const tail = text.slice(-2_000)
  if (/\?\s*$/.test(tail)) return true
  return /(?:^|[\n.!?]\s*)(?:please\s+)?(?:choose|select|provide|confirm|clarify|decide)\b[^.!?]*[.!]?\s*$/i.test(
    tail,
  )
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
    `When the goal is actually achieved, include exactly ${CompletionMarker} in the final response.`,
    "Do not claim completion without verification evidence.",
  ].join("\n")
}

export function make(input: { db: Database.Interface["db"] }): Interface {
  const load = (sessionID: SessionSchema.ID) =>
    input.db
      .select({ autonomy: SessionTable.autonomy })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(
        Effect.orDie,
        Effect.flatMap((row) =>
          row ? Effect.succeed(read(row.autonomy)) : Effect.fail(new NotFoundError({ sessionID })),
        ),
      )

  const save = (sessionID: SessionSchema.ID, state: State) =>
    Effect.gen(function* () {
      yield* load(sessionID)
      yield* input.db
        .update(SessionTable)
        .set({ autonomy: state, time_updated: Date.now() })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      return state
    })

  const isAutonomous: Interface["isAutonomous"] = (sessionID) =>
    load(sessionID).pipe(
      Effect.flatMap((state) => {
        if (state.mode === "yolo" || state.mode === "goal") return Effect.succeed(true)
        return input.db
          .select({ parentID: SessionTaskTable.parent_id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.flatMap((task) => (task ? isAutonomous(task.parentID) : Effect.succeed(false))),
          )
      }),
    )

  // Leaving goal mode ends the loop, so the goal survives the switch with a terminal
  // status: callers read it back to report how the run ended.
  const setMode: Interface["setMode"] = ({ sessionID, mode }) =>
    load(sessionID).pipe(
      Effect.flatMap((state) =>
        save(sessionID, {
          mode,
          ...(state.goal
            ? { goal: state.goal.status === "active" ? { ...state.goal, status: "stopped" as const } : state.goal }
            : {}),
        }),
      ),
    )

  return {
    get: (sessionID) => load(sessionID),
    isAutonomous,
    setMode,
    setGoal: ({ sessionID, text, rawText, maxNoProgress = 3 }) =>
      save(sessionID, {
        mode: "goal",
        goal: {
          text: text.trim(),
          rawText: (rawText ?? text).trim(),
          status: "active",
          iteration: 0,
          noProgress: 0,
          maxNoProgress: Math.max(1, Math.trunc(maxNoProgress)),
        },
      }),
    stop: (sessionID) => setMode({ sessionID, mode: "normal" }),
    advance: ({ sessionID, progress, completed = false }) =>
      load(sessionID).pipe(
        Effect.flatMap((state) => {
          const goal = state.goal
          if (state.mode !== "goal" || !goal || goal.status !== "active") return Effect.succeed(state)
          // A turn that ends on tool calls carries no assistant text. Absence of text is
          // neither progress nor repetition, so it leaves the stall counter and the last
          // digest untouched and only spends an iteration.
          const digest = progress.trim() ? progressDigest(progress) : undefined
          const iteration = goal.iteration + 1
          const noProgress =
            digest === undefined ? goal.noProgress : goal.lastProgressDigest === digest ? goal.noProgress + 1 : 0
          const status: GoalStatus = completed
            ? "completed"
            : noProgress >= goal.maxNoProgress
              ? "exhausted"
              : "active"
          return save(sessionID, {
            mode: status === "active" ? "goal" : "normal",
            goal: {
              ...goal,
              status,
              iteration,
              noProgress,
              ...(digest === undefined ? {} : { lastProgressDigest: digest }),
            },
          })
        }),
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
