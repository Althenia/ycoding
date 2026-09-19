export * as GoalTool from "./goal"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { SessionAutonomy } from "../session/autonomy"
import { Tool } from "./tool"

export const name = "goal"

export const Input = Schema.Struct({
  action: Schema.Literals(["get", "set", "update", "report", "complete", "stop", "clear"]).annotate({
    description: "Goal action: get, update status, report no progress, complete, or stop/clear the current goal",
  }),
  status: Schema.Literals(["active", "completed", "stopped"]).pipe(Schema.optional).annotate({
    description: "Desired status for update action",
  }),
})

export const Output = Schema.Struct({
  action: Schema.String,
  goal: SessionAutonomy.Goal.pipe(Schema.optional),
  message: Schema.String,
})

export type Output = typeof Output.Type

export const Plugin = {
  id: "ycoding.tool.goal",
  effect: Effect.fn("GoalTool.Plugin")(function* (ctx: PluginContext) {
    const autonomy = yield* SessionAutonomy.Service
    const permission = yield* PermissionV2.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description:
              "Manage the current autonomous goal for this session. The user alone creates, replaces, or resumes the goal through the /goal command or the UI; never change the objective text. After the user enables a goal, maintain its status: use get to inspect, report after a blocker, complete after verified achievement, and stop/clear only when the user asks. Do not report ordinary progress. Use report only after encountering a blocker, attempting reasonable self-resolution, and remaining unable to progress; every report consumes one no-progress retry attempt. Active background subagents or shells are unfinished work, not automatic no progress. Use complete only after the goal is achieved and verified; completion is agent-owned. Do not use set to create a goal; it will be rejected.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              permission
                .assert({
                  action: name,
                  resources: [input.action],
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
                        const reported = yield* autonomy.report({ sessionID: context.sessionID })
                        const goal = reported.goal!
                        return {
                          action: "report",
                          goal,
                          message: `Goal no-progress attempt ${goal.noProgress}/${goal.maxNoProgress} reported; status ${goal.status}.`,
                        }
                      }
                      if (input.action === "update") {
                        const stateBefore = yield* autonomy.get(context.sessionID).pipe(
                          Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)),
                        )
                        const existing = stateBefore.goal
                        if (!existing) return yield* Effect.fail(new ToolFailure({ message: "No existing goal to update. The user creates goals via /goal." }))
                        if (input.status === "completed") {
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
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
