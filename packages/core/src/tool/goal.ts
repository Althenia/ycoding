export * as GoalTool from "./goal"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { Permission } from "../permission"
import type { StandalonePermission } from "./standalone-permission"
import { SessionAutonomy } from "../session/autonomy"
import { SessionGoalVerification } from "../session/goal-verification"
import type { SessionSchema } from "../session/schema"
import { SessionReviewFold } from "../session/review-fold"
import { Tool } from "./tool"
import { Hash } from "../util/hash"

export const name = "goal"

export const Input = Schema.Struct({
  action: Schema.Literals(["get", "set", "update", "report", "rework", "complete", "stop", "clear"]).annotate({
    description: "Goal action: get, update status, report no progress, record rework, complete, or stop/clear the current goal",
  }),
  status: Schema.Literals(["active", "completed", "stopped"]).pipe(Schema.optional).annotate({
    description: "Desired status for update action",
  }),
  unit: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(120)).pipe(Schema.optional).annotate({
    description: "Rework unit: the file, check, feature or child result being reopened or resolved",
  }),
  reason: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(300)).pipe(Schema.optional).annotate({
    description: "Rework reason: the failed check, regression or contradicting evidence",
  }),
  state: Schema.Literals(["opened", "resolved"]).pipe(Schema.optional).annotate({
    description: "Rework state: opened when evidence reopens the unit, resolved when its check passes",
  }),
  evidence: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(300)).pipe(Schema.optional).annotate({
    description: "Required for resolved rework: the check that now passes",
  }),
})

export const Output = Schema.Struct({
  action: Schema.String,
  goal: SessionAutonomy.Goal.pipe(Schema.optional),
  message: Schema.String,
})

export type Output = typeof Output.Type

export const make = (autonomy: SessionAutonomy.Interface, database: Database.Interface, permission: StandalonePermission.Interface) => Tool.make({
            description:
              "Manage the current autonomous goal for this session. The user alone creates, replaces, or resumes the goal through the /goal command or the UI; never change the objective text. After the user enables a goal, maintain its status: use get to inspect, report after a blocker, complete after verified achievement, and stop/clear only when the user asks. Do not report ordinary progress. Use report only after encountering a blocker, attempting reasonable self-resolution, and remaining unable to progress; every report consumes one no-progress retry attempt. Active background subagents or shells are unfinished work, not automatic no progress. Use complete only after the goal is achieved and verified; completion is agent-owned. When the user's goal request names a check (a ./ or ../ script path ending in .sh, .bash, .zsh, .ps1, .cmd or .bat, or a backticked command of two or more words), complete and update to completed are rejected after a completed edit, write or patch in this Session or its descendants until a shell run of that check after the latest such edit has passed; the rejection names the check to rerun. A completion rejection identical to the previous one, with no other tool call, check run, edit or descendant work in between, consumes one no-progress retry attempt. Use rework with unit, reason and state opened when a failed check, regression or rejected result reopens finished work, and with state resolved plus evidence once its check passes; rework is neither a no-progress report nor progress narration and never stops the goal. Do not use set to create a goal; it will be rejected.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              permission
                .assert({
                  action: name,
                  resources: [input.action],
                  metadata: { operationDigest: Hash.json(input) },
                  save: [input.action],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, callID: context.callID },
                })
                .pipe(
                  Effect.mapError((error) => new ToolFailure({ message: "Unable to manage goal", error })),
                  Effect.andThen(
                    Effect.gen(function* () {
                      if (input.action === "get") {
                        const state = yield* autonomy.get(context.sessionID).pipe(
                          Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)),
                        )
                        const goal = state.goal
                        if (!goal) return { action: "get", message: "No active goal. Goal is off.", ...(goal ? { goal } : {}) }
                        if (goal.status !== "active") return { action: "get", message: `Goal is ${goal.status}: ${goal.text}`, goal }
                        return { action: "get", message: `Active goal (iteration ${goal.iteration}, noProgress ${goal.noProgress}/${goal.maxNoProgress}): ${goal.text}`, goal }
                      }
                      if (input.action === "set") {
                        return yield* Effect.fail(
                          new ToolFailure({
                            message:
                              "The goal objective is owned by the user. The user must create or replace it through the /goal command or goal dialog; the assistant can manage status with get/update/report/complete/stop.",
                          }),
                        )
                      }
                      if (input.action === "report") {
                        const state = yield* autonomy.get(context.sessionID).pipe(
                          Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)),
                        )
                        if (!state.goal || state.goal.status !== "active")
                          return yield* Effect.fail(new ToolFailure({ message: "No active goal to report" }))
                        const openReviews = yield* SessionReviewFold.openCount(database.db, context.sessionID)
                        if (openReviews > 0)
                          return {
                            action: "report",
                            goal: state.goal,
                            message: `Not counted: ${openReviews} item(s) in this Session family await the user's review.`,
                          }
                        const reported = yield* autonomy.report({ sessionID: context.sessionID })
                        const goal = reported.goal!
                        return {
                          action: "report",
                          goal,
                          message: `Goal no-progress attempt ${goal.noProgress}/${goal.maxNoProgress} reported; status ${goal.status}.`,
                        }
                      }
                      if (input.action === "rework") {
                        if (!input.unit || !input.state || (input.state === "opened" && !input.reason))
                          return yield* Effect.fail(new ToolFailure({ message: "Rework requires unit, state, and a reason when opened" }))
                        if (input.state === "resolved" && !input.evidence)
                          return yield* Effect.fail(new ToolFailure({ message: "Resolved rework requires evidence naming the check that now passes" }))
                        const owner = yield* autonomy.goalOwner(context.sessionID)
                        if (!owner) return yield* Effect.fail(new ToolFailure({ message: "No active goal to record rework" }))
                        const open = (yield* autonomy.get(owner)).goal?.reworkOpen?.some((item) => item.unit === input.unit)
                        if (input.state === "resolved" && !open)
                          return yield* Effect.fail(new ToolFailure({ message: `No open rework for ${input.unit}` }))
                        const after = (yield* autonomy.rework({ sessionID: owner, unit: input.unit, reason: input.reason ?? input.evidence ?? "", state: input.state })).goal
                        return {
                          action: "rework",
                          ...(after ? { goal: after } : {}),
                          message: input.state === "opened"
                            ? `Rework opened for ${input.unit}; rework count ${after?.rework ?? 0}. Fix it, re-run the check, then resolve it with evidence.`
                            : `Rework resolved for ${input.unit}: ${input.evidence}`,
                        }
                      }
                      if (input.action === "update") {
                        const stateBefore = yield* autonomy.get(context.sessionID).pipe(
                          Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)),
                        )
                        const existing = stateBefore.goal
                        if (!existing) return yield* Effect.fail(new ToolFailure({ message: "No existing goal to update. The user creates goals via /goal." }))
                        if (input.status === "completed") {
                          yield* requireCompletable(autonomy, database, context.sessionID, existing)
                          const advanced = yield* autonomy.complete(context.sessionID)
                          const goal = advanced.goal!
                          return { action: "update", goal, message: `Goal marked completed: ${goal.text}` }
                        }
                        if (input.status === "stopped") {
                          const stopped = yield* autonomy.clearGoal(context.sessionID)
                          const goal = stopped.goal
                          return { action: "update", message: "Goal stopped and removed from sidebar.", ...(goal ? { goal } : {}) }
                        }
                        if (input.status === "active" && existing.status !== "active") {
                          return yield* Effect.fail(
                            new ToolFailure({
                              message: "Goal can only be started by the user. Re-activating a stopped goal must be done by the user via /goal.",
                            }),
                          )
                        }
                        return { action: "update", goal: existing, message: `Goal unchanged: ${existing.text} (status ${existing.status})` }
                      }
                      if (input.action === "complete") {
                        const stateBefore = yield* autonomy.get(context.sessionID).pipe(
                          Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)),
                        )
                        const existing = stateBefore.goal
                        if (!existing || existing.status !== "active") return yield* Effect.fail(new ToolFailure({ message: "No active goal to complete" }))
                        yield* requireCompletable(autonomy, database, context.sessionID, existing)
                        const advanced = yield* autonomy.complete(context.sessionID)
                        const goal = advanced.goal!
                        return { action: "complete", goal, message: `Goal completed: ${goal.text}. It will disappear from sidebar.` }
                      }
                      // stop / clear
                      const stopped = yield* autonomy.clearGoal(context.sessionID)
                      const goal = stopped.goal
                      return { action: "stop", message: "Goal stopped and removed from sidebar.", ...(goal ? { goal } : {}) }
                    }).pipe(Effect.catchTag("SessionAutonomy.NotFound", (error) => Effect.fail(new ToolFailure({ message: "Session not found", error })))),
                  ),
                ),
          })

export const Plugin = {
  id: "ycoding.tool.goal",
  effect: Effect.fn("GoalTool.Plugin")(function* (ctx: PluginContext) {
    const autonomy = yield* SessionAutonomy.Service
    const database = yield* Database.Service
    const permission = yield* Permission.Service
    yield* ctx.tool.transform((draft) => draft.add(name, make(autonomy, database, permission), { codemode: false })).pipe(Effect.orDie)
  }),
}

const requireCompletable = Effect.fnUntraced(function* (
  autonomy: SessionAutonomy.Interface,
  database: Database.Interface,
  sessionID: SessionSchema.ID,
  goal: SessionAutonomy.Goal,
) {
  const rejection = failureRejection(goal) ?? (yield* checkRejection(database, sessionID, goal))
  if (!rejection) return
  const repeated = yield* SessionGoalVerification.repeatsRejection(database.db, sessionID, rejection.reason)
  const charged = repeated && (yield* SessionReviewFold.openCount(database.db, sessionID)) === 0
    ? (yield* autonomy.report({ sessionID })).goal
    : undefined
  const budget = charged
    ? `No new work since the identical previous rejection: no-progress attempt ${charged.noProgress}/${charged.maxNoProgress} charged${charged.status === "exhausted" ? "; the goal is exhausted" : ""}.`
    : "Calling complete again with no new tool call, check run, edit or descendant work since this rejection uses one no-progress attempt."
  yield* Effect.fail(new ToolFailure({ message: [rejection.reason, rejection.detail, budget].join("\n") }))
})

const failureRejection = (goal: SessionAutonomy.Goal) => {
  const failure = goal.failure
  if (!failure) return undefined
  const clears = failure.unit.startsWith("tool/")
    ? `a successful ${failure.unit.slice(5)} call in this Session or a clean iteration`
    : "a successful model step in this Session or a clean iteration"
  return {
    reason: `Goal cannot complete: failure ${failure.fingerprint} (class ${failure.class}, unit ${failure.unit}) stopped this Session's own iteration and is unresolved.`,
    detail: `${failure.count} occurrence${failure.count === 1 ? "" : "s"}. It clears after ${clears}.`,
  }
}

const checkStates = {
  unrun: "is unrun",
  stale: "is stale since the latest edit",
  failing: "is failing",
} as const

const checkRejection = Effect.fnUntraced(function* (database: Database.Interface, ownerID: SessionSchema.ID, goal: SessionAutonomy.Goal) {
  const checks = SessionGoalVerification.requiredChecks(goal.rawText ?? goal.text)
  const unmet = checks.length === 0 ? [] : SessionGoalVerification.unmetChecks(checks, yield* SessionGoalVerification.familyCalls(database.db, ownerID))
  if (unmet.length === 0) return undefined
  return {
    reason: `Goal cannot complete: ${unmet.map((item) => `Required check ${item.check} ${checkStates[item.state]}`).join("; ")}.`,
    detail: `Rerun ${unmet.map((item) => item.check).join(" and ")}. Only a passing run after the latest edit, in this Session or one of its descendant Sessions, clears it.`,
  }
})
