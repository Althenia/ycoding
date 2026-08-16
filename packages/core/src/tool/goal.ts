export * as GoalTool from "./goal"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { SessionAutonomy } from "../session/autonomy"
import { Tool } from "./tool"

export const name = "goal"

export const Input = Schema.Struct({
  action: Schema.Literals(["get", "set", "update", "complete", "stop", "clear"]).annotate({
    description: "Goal action: get current goal, set new goal, update existing goal text/status, complete goal, or stop/clear goal",
  }),
  text: Schema.String.pipe(Schema.optional).annotate({
    description: "Goal text for set/update actions",
  }),
  maxNoProgress: Schema.Int.pipe(Schema.optional).annotate({
    description: "Maximum no-progress iterations before exhausted (1-10, default 3)",
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
              "Manage the current autonomous goal for this session. Goals are started by the user via /goal. Use get to inspect, set to create, update to change text/status, complete to mark done, stop/clear to remove. When completed it remains visible in the sidebar until the user turns goal off; when stopped it is removed.",
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
                        const state = yield* autonomy.get(context.sessionID).pipe(
                          Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)),
                        )
                        const trimmed = input.text?.trim() ?? ""
                        if (!trimmed) return yield* Effect.fail(new ToolFailure({ message: "set text cannot be empty" }))
                        const updated = yield* autonomy.setGoal({
                          sessionID: context.sessionID,
                          text: trimmed,
                          rawText: trimmed,
                          maxNoProgress: input.maxNoProgress ?? state.goal?.maxNoProgress ?? 3,
                        })
                        const goal = updated.goal!
                        return {
                          action: "set",
                          goal,
                          message: `Goal set/updated: ${goal.text} It remains in sidebar. Goal remains visible when completed; it disappears only when goal mode is off.`,
                        }
                      }
                      if (input.action === "update") {
                        const stateBefore = yield* autonomy.get(context.sessionID).pipe(
                          Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(SessionAutonomy.defaultState)),
                        )
                        const existing = stateBefore.goal
                        if (!existing) return yield* Effect.fail(new ToolFailure({ message: "No existing goal to update. Use set." }))
                        if (input.status === "completed") {
                          const advanced = yield* autonomy.advance({
                            sessionID: context.sessionID,
                            progress: existing.text,
                            completed: true,
                            expected: { runID: existing.runID, iteration: existing.iteration },
                          })
                          const goal = advanced.goal!
                          return { action: "update", goal, message: `Goal marked completed: ${goal.text}` }
                        }
                        if (input.status === "stopped") {
                          const stopped = yield* autonomy.clearGoal(context.sessionID)
                          const goal = stopped.goal
                          return { action: "update", message: "Goal removed.", ...(goal ? { goal } : {}) }
                        }
                        if (input.text !== undefined) {
                          const trimmed = input.text.trim()
                          if (!trimmed) return yield* Effect.fail(new ToolFailure({ message: "update text cannot be empty" }))
                          const updated = yield* autonomy.updateGoal({
                            sessionID: context.sessionID,
                            text: trimmed,
                            rawText: trimmed,
                            maxNoProgress: input.maxNoProgress ?? existing.maxNoProgress,
                          })
                          const goal = updated.goal!
                          return { action: "update", goal, message: `Goal updated: ${goal.text}` }
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
                        const advanced = yield* autonomy.advance({
                          sessionID: context.sessionID,
                          progress: existing.text,
                          completed: true,
                          expected: { runID: existing.runID, iteration: existing.iteration },
                        })
                        const goal = advanced.goal!
                        return { action: "complete", goal, message: `Goal completed: ${goal.text}. It remains in sidebar until user turns goal off.` }
                      }
                      // stop / clear
                      const stopped = yield* autonomy.clearGoal(context.sessionID)
                      const goal = stopped.goal
                      return { action: "stop", message: "Goal removed.", ...(goal ? { goal } : {}) }
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
