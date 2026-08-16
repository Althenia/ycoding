import { describe, expect } from "bun:test"
import { SystemPart } from "@ycoding-ai/ai"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { ConversationCompactTool } from "@ycoding-ai/core/tool/conversation-compact"
import type { SessionHooks } from "@ycoding-ai/plugin/effect/session"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { DateTime, Effect, Scope } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const providerID = ProviderV2.ID.make("advisor-test")
const modelID = ModelV2.ID.make("advisor-test")
const advisorSessionID = SessionSchema.ID.make("ses_conversation_compact_advisor")
const advisorConfig = Config.Service.of({
  entries: () =>
    Effect.succeed([
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({
            context_safety_margin_tokens: 0,
            advisory: { consider_percent: 65, strongly_advised_percent: 85 },
          }),
        }),
      }),
    ]),
})

describe("conversation compaction advisor scheduling", () => {
  it.effect("schedules each soft pressure cycle once until escalation, material growth, or normal rearm", () => {
    let attempts = 0
    let settled = false
    return advisorHarness(
      (trigger, calls) =>
        Effect.gen(function* () {
          yield* trigger("consider", AgentV2.ID.make("compaction"))
          expect(calls).toEqual([])
          yield* trigger("normal")
          yield* trigger("consider")
          yield* trigger("consider")
          yield* trigger("consider")
          yield* trigger("advised")
          yield* trigger("advised")
          yield* trigger("mandatory")
          yield* trigger("consider")
          yield* trigger("normal")
          yield* trigger("consider")
        }),
      (input) => {
        attempts += 1
        if (attempts === 1) return Effect.fail({ message: "No completed compaction boundary is available" })
        if (attempts === 3)
          return Effect.gen(function* () {
            yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  settled = true
                }),
              ),
              Effect.forkChild,
            )
            return undefined
          })
        return Effect.succeed(compactionAdmission(input.id, input.trigger, input.sessionID))
      },
    ).pipe(
      Effect.tap(({ calls }) =>
        Effect.sync(() => {
          expect(calls).toEqual(["consider", "advised", "consider"])
          expect(settled).toBe(false)
        }),
      ),
    )
  })

  it.effect("admits advisory pressure from the context window before the safe input budget", () =>
    advisorHarness(
      (trigger, calls) =>
        Effect.gen(function* () {
          yield* trigger({ contextWindowTokens: 100, maxOutputTokens: 20, systemTokens: 70 })
          expect(calls).toEqual(["consider"])
        }),
    ),
  )
})

function advisorHarness(
  run: (
    trigger: (
      pressure: Pressure,
      agent?: AgentV2.ID,
    ) => Effect.Effect<void, never, Scope.Scope>,
    calls: ReadonlyArray<"consider" | "advised">,
  ) => Effect.Effect<void, never, Scope.Scope>,
  compact: Compact = (input) =>
    Effect.succeed(compactionAdmission(input.id, input.trigger, input.sessionID)),
) {
  return Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const hooks = yield* PluginHooks.Service
    const plugins = yield* PluginV2.Service
    const host = yield* PluginHost.make(plugins)
    const calls: Array<"consider" | "advised"> = []
    yield* catalog.transform((draft) => {
      draft.provider.update(providerID, () => {})
      draft.model.update(providerID, modelID, (model) => {
        model.limit = { context: 300, output: 0 }
      })
    })
    const runtime = {
      session: {
        compact: (input: Parameters<typeof compact>[0]) => {
          calls.push(input.trigger)
          return compact(input)
        },
      },
    } as unknown as PluginRuntime.Interface
    yield* ConversationCompactTool.Plugin.effect(host).pipe(
      Effect.provideService(Config.Service, advisorConfig),
      Effect.provideService(PluginRuntime.Service, runtime),
    )
    const trigger = (pressure: Pressure, agent?: AgentV2.ID) =>
      Effect.gen(function* () {
        const limits = resolveLimits(pressure)
        yield* catalog.transform((draft) =>
          draft.model.update(providerID, modelID, (model) => {
            model.limit = limits
          }),
        )
        const event = advisorEvent(agent, resolveSystemTokens(pressure))
        yield* hooks.trigger("session", "context", event)
        expect(event.messages).toEqual([])
      })
    yield* run(trigger, calls)
    return { calls }
  })
}

function resolveLimits(pressure: Pressure) {
  if (typeof pressure !== "string")
    return { context: pressure.contextWindowTokens, output: pressure.maxOutputTokens }
  if (pressure === "normal") return { context: 100, output: 0 }
  if (pressure === "consider") return { context: 90, output: 0 }
  if (pressure === "advised") return { context: 70, output: 0 }
  return { context: 60, output: 0 }
}

function resolveSystemTokens(pressure: Pressure) {
  return typeof pressure === "string" ? 60 : pressure.systemTokens
}

function advisorEvent(agent = AgentV2.ID.make("build"), systemTokens = 60): SessionHooks["context"] {
  return {
    sessionID: advisorSessionID,
    agent,
    model: ModelV2.Ref.make({ providerID, id: modelID }),
    system: [SystemPart.make("x".repeat(systemTokens * 4))],
    messages: [],
    tools: {},
  }
}

function compactionAdmission(
  id: SessionCompaction.ID,
  trigger: SessionCompaction.Trigger,
  sessionID: SessionSchema.ID,
): SessionCompaction.Admission {
  return {
    id,
    sessionID,
    trigger,
    status: "pending",
    requestedThrough: { messageID: SessionMessage.ID.make("msg_conversation_compact"), seq: 1 },
    timeCreated: DateTime.makeUnsafe(1),
  }
}

type Compact = (input: {
  readonly id: SessionCompaction.ID
  readonly sessionID: SessionSchema.ID
  readonly trigger: "consider" | "advised"
}) => Effect.Effect<SessionCompaction.Admission | undefined, { readonly message: string }, Scope.Scope>

type Pressure =
  | "normal"
  | "consider"
  | "advised"
  | "mandatory"
  | { readonly contextWindowTokens: number; readonly maxOutputTokens: number; readonly systemTokens: number }
