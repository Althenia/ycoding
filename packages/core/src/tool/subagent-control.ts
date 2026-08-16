export * as SubagentControlTool from "./subagent-control"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Control, Task } from "@ycoding-ai/schema/session-orchestration"
import { Effect, Schema } from "effect"
import { PluginRuntime } from "../plugin/runtime"
import { PermissionV2 } from "../permission"
import { SessionOrchestration } from "../session/orchestration"
import { Tool } from "./tool"
import { Hash } from "../util/hash"
import { SessionMessage } from "../session/message"

export const name = "subagent_control"
export const Input = Control
export const Output = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), tasks: Schema.Array(Task) }),
  Schema.Struct({ action: Schema.Literal("send"), task: Task }),
  Schema.Struct({ action: Schema.Literal("answer"), task: Task }),
  Schema.Struct({ action: Schema.Literal("cancel"), task: Task }),
  Schema.Struct({ action: Schema.Literal("resume"), task: Task }),
]).pipe(Schema.toTaggedUnion("action"))
export type Output = typeof Output.Type

export const Plugin = {
  id: "ycoding.tool.subagent-control",
  effect: Effect.fn("SubagentControlTool.Plugin")(function* (ctx: PluginContext) {
    const orchestration = (yield* PluginRuntime.Service).orchestration
    const permission = yield* PermissionV2.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description:
              "List direct child tasks, send steer or queue input (which can reactivate a terminal child while retaining its Session context), answer an open child question, cancel a child, or resume already-pending durable work.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = { agent: context.agent, messageID: context.messageID, callID: context.callID }
                if (input.action === "list")
                  return { action: "list" as const, tasks: yield* orchestration.list(context.sessionID) }
                const target = yield* orchestration.get(context.sessionID, input.sessionID)
                yield* SessionOrchestration.authorize(context.sessionID, target.agent, source).pipe(
                  Effect.provideService(PermissionV2.Service, permission),
                )
                if (input.action === "send")
                  return {
                    action: "send" as const,
                    task: yield* orchestration.send({
                      parentID: context.sessionID,
                      childID: input.sessionID,
                      messageID: SessionMessage.ID.make(
                        `msg_task_send_${Hash.sha256(`${context.sessionID}\0${context.messageID}\0${context.callID}`).slice(0, 24)}`,
                      ),
                      text: input.text,
                      delivery: input.delivery,
                    }),
                  }
                if (input.action === "answer")
                  return {
                    action: "answer" as const,
                    task: yield* orchestration.answer({
                      parentID: context.sessionID,
                      childID: input.sessionID,
                      questionID: input.questionID,
                      text: input.text,
                      data: input.data,
                    }),
                  }
                if (input.action === "cancel")
                  return {
                    action: "cancel" as const,
                    task: yield* orchestration.cancel({
                      parentID: context.sessionID,
                      childID: input.sessionID,
                    }),
                  }
                return {
                  action: "resume" as const,
                  task: yield* orchestration.resume({ parentID: context.sessionID, childID: input.sessionID }),
                }
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
