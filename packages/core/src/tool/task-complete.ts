export * as TaskCompleteTool from "./task-complete"

import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { ToolFailure } from "@ycoding-ai/ai"
import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import type { StandalonePermission } from "./standalone-permission"

export const make = () => Tool.make({
            description:
              "Declare verified completion of all current work; do not call for routine replies, idle, or unfinished work. Send the final reply afterward. Completion is accepted only after that reply settles successfully with no pending or background work.",
            input: Schema.Struct({}),
            output: Schema.Struct({ recorded: Schema.Literal(true) }),
            toModelOutput: () => [
              { type: "text", text: "Completion declaration recorded. Final reply settlement is still pending." },
            ],
            execute: () => Effect.succeed({ recorded: true }),
          })

export const makeStandalone = (permission: StandalonePermission.Interface) => {
  const tool = make()
  return { ...tool, execute: (...[input, context]: Parameters<typeof tool.execute>) => permission.assert({
    action: "task_complete", resources: ["*"], sessionID: context.sessionID, agent: context.agent,
    source: { type: "tool", messageID: context.messageID, callID: context.callID },
  }).pipe(
    Effect.mapError((error) => new ToolFailure({ message: "Permission denied: task_complete", error })),
    Effect.andThen(tool.execute(input, context)),
  ) }
}

export const Plugin = {
  id: "ycoding.tool.task-complete",
  effect: Effect.fn("TaskCompleteTool.Plugin")(function* (ctx: PluginContext) {
    yield* ctx.tool.transform((draft) => draft.add("task_complete", make(), { codemode: false })).pipe(Effect.orDie)
  }),
}
