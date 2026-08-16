export * as ConversationSummarizeTool from "./conversation-summarize"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { SessionCompaction } from "../session/compaction"
import { SessionContextPressure } from "../session/context-pressure"
import { SessionMessage } from "../session/message"
import { Tool } from "./tool"

export const name = "conversation_summarize"

export const Input = Schema.Struct({
  boundary_message_id: SessionMessage.ID,
})

export const Output = Schema.Struct({
  summary_message_id: SessionMessage.ID,
  provider: Schema.String,
  model: Schema.String,
  summarized_through_sequence: Schema.Int,
  deleted_count: Schema.Int,
  remaining_count: Schema.Int,
  summary_revision: Schema.Int,
  context_rebuild_required: Schema.Literal(true),
})

export type Output = typeof Output.Type

export const Plugin = {
  id: "ycoding.tool.conversation-summarize",
  effect: Effect.fn("ConversationSummarizeTool.Plugin")(function* (ctx: PluginContext) {
    const catalog = yield* Catalog.Service
    const compaction = yield* SessionCompaction.Service
    const config = yield* Config.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description:
              "Summarize conversation history through one existing message boundary. This permanently removes only the covered message history after validating the generated checkpoint.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              compaction
                .summarize({ sessionID: context.sessionID, boundaryMessageID: input.boundary_message_id })
                .pipe(
                  Effect.map((result) => ({
                    summary_message_id: result.summaryMessageID,
                    provider: result.providerID,
                    model: result.modelID,
                    summarized_through_sequence: result.through,
                    deleted_count: result.deletedMessageCount,
                    remaining_count: result.remainingMessageCount,
                    summary_revision: result.summaryRevision,
                    context_rebuild_required: true as const,
                  })),
                  Effect.mapError((error) => new ToolFailure({ message: error.message })),
                ),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const message = SessionContextPressure.advisory({
          models: yield* catalog.model.available(),
          model: event.model,
          contextSafetyMarginTokens: SessionContextPressure.contextSafetyMarginTokens(yield* config.entries()),
          system: event.system,
          tools: Object.entries(event.tools).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.input,
          })),
          messages: event.messages,
        })
        if (message) event.messages.push(message)
      }),
    )
  }),
}
