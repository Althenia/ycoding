export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { SessionTodo } from "../session/todo"
import { Tool } from "./tool"

export const name = "todowrite"
export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})
export const Output = Schema.Struct({ todos: Schema.Array(SessionTodo.Info) })
export type Output = typeof Output.Type

export const Plugin = {
  id: "ycoding.tool.todowrite",
  effect: Effect.fn("TodoWriteTool.Plugin")(function* (ctx: PluginContext) {
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description:
              "Create and maintain a structured task list for the current coding session. Keep statuses current during multi-step work.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.todos, null, 2) }],
            execute: (input, context) =>
              permission
                .assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, callID: context.callID },
                })
                .pipe(
                  Effect.mapError((error) => new ToolFailure({ message: "Unable to update todos", error })),
                  Effect.andThen(todos.update({ sessionID: context.sessionID, todos: input.todos })),
                  Effect.as({ todos: input.todos }),
                ),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
