export * as ConversationCompactTool from "./conversation-compact"

import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { PluginRuntime } from "../plugin/runtime"
import { SessionContextPressure } from "../session/context-pressure"
import { SessionSchema } from "../session/schema"

export const Plugin = {
  id: "ycoding.tool.conversation-compact",
  effect: Effect.fn("ConversationCompactTool.Plugin")(function* (ctx: PluginContext) {
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const runtime = yield* PluginRuntime.Service
    const policy = SessionContextPressure.policy(yield* config.entries())
    const pressure = new Map<SessionSchema.ID, SessionContextPressure.Level>()
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (event.agent === AgentV2.ID.make("compaction")) return
        const models = yield* catalog.model.available()
        const tools = Object.entries(event.tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.input,
        }))
        const estimatedInputTokens = SessionContextPressure.estimatedInputTokens({
          system: event.system,
          tools,
          messages: event.messages,
        })
        const current = SessionContextPressure.modelLevel({
          models,
          model: event.model,
          policy,
          estimate: estimatedInputTokens,
          system: event.system,
          tools,
          messages: event.messages,
        })
        const sessionID = SessionSchema.ID.make(event.sessionID)
        const previous = pressure.get(sessionID)
        if (current === undefined || current === "normal") {
          pressure.delete(sessionID)
          return
        }
        if (current === "mandatory") {
          pressure.set(sessionID, current)
          return
        }
        if (previous !== undefined && pressureRank(previous) >= pressureRank(current)) return
        pressure.set(sessionID, current)
        yield* runtime.session
          .compact({ id: SessionCompaction.ID.create(), sessionID, trigger: current, estimatedInputTokens })
          .pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                if (pressure.get(sessionID) !== current) return
                if (previous === undefined) pressure.delete(sessionID)
                else pressure.set(sessionID, previous)
              }),
            ),
          )
      }),
    )
  }),
}

function pressureRank(level: SessionContextPressure.Level) {
  if (level === "normal") return 0
  if (level === "consider") return 1
  if (level === "advised") return 2
  return 3
}
