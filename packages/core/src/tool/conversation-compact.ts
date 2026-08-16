export * as ConversationCompactTool from "./conversation-compact"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Effect, Schema } from "effect"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { ConfigCompaction } from "../config/compaction"
import { PluginRuntime } from "../plugin/runtime"
import { SessionContextPressure } from "../session/context-pressure"
import { SessionSchema } from "../session/schema"
import { Tool } from "./tool"

export const name = "conversation_compact"

export const Input = Schema.Record(Schema.String, Schema.Unknown)

export const Output = Schema.Union([
  Schema.Struct({ jobID: SessionCompaction.ID, status: Schema.Literal("scheduled") }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
])

export type Output = typeof Output.Type

type Pressure = "consider" | "advised"

type Compact = (input: {
  readonly sessionID: SessionSchema.ID
  readonly trigger: Pressure
}) => Effect.Effect<{ readonly id: SessionCompaction.ID }, { readonly message: string }>

export const make = (input: {
  readonly policy: ConfigCompaction.Resolved
  readonly pressure: (sessionID: SessionSchema.ID) => SessionContextPressure.Level | undefined
  readonly compact: Compact
}) =>
  Tool.make({
    description:
      "Schedule context compaction in the background using the current context-pressure advice. This tool accepts no input fields and returns immediately without waiting for compaction to finish.",
    input: Input,
    output: Output,
    toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
    execute: (toolInput, context) => {
      if (Object.keys(toolInput).length > 0)
        return Effect.fail(new ToolFailure({ message: "conversation_compact accepts no input fields" }))
      if (input.policy.advisory === false) return Effect.succeed({ status: "disabled" as const })
      const pressure = input.pressure(SessionSchema.ID.make(context.sessionID))
      if (pressure !== "consider" && pressure !== "advised") return Effect.succeed({ status: "disabled" as const })
      return input.compact({ sessionID: SessionSchema.ID.make(context.sessionID), trigger: pressure }).pipe(
        Effect.map((admission) => ({ jobID: admission.id, status: "scheduled" as const })),
        Effect.mapError((error) => new ToolFailure({ message: error.message })),
      )
    },
  })

export const Plugin = {
  id: "ycoding.tool.conversation-compact",
  effect: Effect.fn("ConversationCompactTool.Plugin")(function* (ctx: PluginContext) {
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const runtime = yield* PluginRuntime.Service
    const policy = SessionContextPressure.policy(yield* config.entries())
    const pressure = new Map<SessionSchema.ID, SessionContextPressure.Level>()
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          make({
            policy,
            pressure: (sessionID) => pressure.get(sessionID),
            compact: (input) => runtime.session.compact(input),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const models = yield* catalog.model.available()
        const tools = Object.entries(event.tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.input,
        }))
        const current = SessionContextPressure.modelLevel({
          models,
          model: event.model,
          policy,
          system: event.system,
          tools,
          messages: event.messages,
        })
        if (current === "consider" || current === "advised")
          pressure.set(SessionSchema.ID.make(event.sessionID), current)
        else pressure.delete(SessionSchema.ID.make(event.sessionID))
        const message = SessionContextPressure.advisory({
          models,
          model: event.model,
          policy,
          system: event.system,
          tools,
          messages: event.messages,
        })
        if (message) event.messages.push(message)
      }),
    )
  }),
}
