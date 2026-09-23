export * as TaskCompleteTool from "./task-complete"

import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Tool } from "./tool"

export const Plugin = {
  id: "ycoding.tool.task-complete",
  effect: Effect.fn("TaskCompleteTool.Plugin")(function* (ctx: PluginContext) {
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          "task_complete",
          Tool.make({
            description: "Record verified task completion locally; do not call for routine idle or unfinished work.",
            input: Schema.Struct({}),
            output: Schema.Struct({ recorded: Schema.Literal(true) }),
            toModelOutput: () => [{ type: "text", text: "Task completion recorded." }],
            execute: () => Effect.succeed({ recorded: true }),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
