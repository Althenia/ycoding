export * as SubagentReportTool from "./subagent-report"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Question, Report, Task } from "@ycoding-ai/schema/session-orchestration"
import { Effect, Schema } from "effect"
import { PluginRuntime } from "../plugin/runtime"
import { Tool } from "./tool"

export const name = "subagent_report"
export const Input = Report
export const Output = Schema.Union([
  Schema.Struct({ action: Schema.Literal("progress"), task: Task }),
  Schema.Struct({ action: Schema.Literal("question"), question: Question }),
]).pipe(Schema.toTaggedUnion("action"))
export type Output = typeof Output.Type

export const Plugin = {
  id: "ycoding.tool.subagent-report",
  effect: Effect.fn("SubagentReportTool.Plugin")(function* (ctx: PluginContext) {
    const runtime = yield* PluginRuntime.Service
    const orchestration = runtime.orchestration
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description: "Report bounded progress to the parent or ask one durable parent question.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                if (input.action === "progress")
                  return {
                    action: "progress" as const,
                    task: yield* orchestration.progress(context.sessionID, input.text),
                  }
                const report = yield* orchestration.question(context.sessionID, input.text, input.data)
                if (report.autoAnswered) return { action: "question" as const, question: report.question }
                yield* runtime.job.background(context.sessionID)
                yield* runtime.session.interrupt(context.sessionID)
                return { action: "question" as const, question: report.question }
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)

    yield* ctx.session.hook("context", (event) =>
      orchestration.managed(event.sessionID).pipe(
        Effect.tap((managed) =>
          Effect.sync(() => {
            if (!managed) delete event.tools[name]
          }),
        ),
      ),
    )
  }),
}
