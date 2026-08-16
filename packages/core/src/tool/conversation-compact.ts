export * as ConversationCompactTool from "./conversation-compact"

import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { PluginRuntime } from "../plugin/runtime"
import { SessionContextBudget } from "../session/context-budget"
import { SessionContextPressure } from "../session/context-pressure"
import { SessionSchema } from "../session/schema"

export const Plugin = {
  id: "ycoding.tool.conversation-compact",
  effect: Effect.fn("ConversationCompactTool.Plugin")(function* (ctx: PluginContext) {
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const runtime = yield* PluginRuntime.Service
    const policy = SessionContextPressure.policy(yield* config.entries())
    const pressure = new Map<SessionSchema.ID, SessionContextPressure.AdvisoryPressure>()
    const inflight = new Set<SessionSchema.ID>()
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (event.agent === AgentV2.ID.make("compaction")) return
        const models = yield* catalog.model.available()
        const tools = Object.entries(event.tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.input,
        }))
        const capabilities = SessionContextBudget.resolveCapabilities(models, event.model.providerID, event.model.id, {
          safetyMarginTokens: policy.contextSafetyMarginTokens,
        })
        if (!capabilities) return
        const usage = { system: event.system, tools, messages: event.messages }
        const current = SessionContextPressure.modelLevel({
          models,
          model: event.model,
          policy,
          ...usage,
        })
        const sessionID = SessionSchema.ID.make(event.sessionID)
        const previous = pressure.get(sessionID)
        if (current === undefined || current === "normal") {
          pressure.delete(sessionID)
          return
        }
        if (current === "mandatory") {
          return
        }
        if (inflight.has(sessionID)) return
        if (
          !SessionContextPressure.shouldAdmitAdvisory({
            current,
            previous,
            estimatedInputTokens: SessionContextPressure.estimatedInputTokens(usage),
            hardInputCapTokens: SessionContextPressure.hardInputCapTokens(capabilities),
          })
        )
          return
        inflight.add(sessionID)
        pressure.set(sessionID, {
          level: current,
          estimatedInputTokens: SessionContextPressure.estimatedInputTokens(usage),
        })
        yield* runtime.session
          .compact({ id: SessionCompaction.ID.create(), sessionID, trigger: current })
          .pipe(
            Effect.catch(() => Effect.void),
            Effect.ensuring(Effect.sync(() => inflight.delete(sessionID))),
          )
      }),
    )
  }),
}
