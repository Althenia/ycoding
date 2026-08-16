import { expect, test } from "bun:test"
import { LLM, Model, Message, SystemPart, ToolDefinition } from "@ycoding-ai/ai"
import { applyCachePolicy } from "@ycoding-ai/ai/cache-policy"
import { AnthropicMessages } from "@ycoding-ai/ai/protocols"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionContextPressure } from "@ycoding-ai/core/session/context-pressure"
import { SessionModelRequest } from "@ycoding-ai/core/session/model-request"
import type { SessionContext } from "@ycoding-ai/core/session/context"

const systemFor = (initial: string) => {
  const agent = AgentV2.ID.make("build")
  return SessionModelRequest.baseSystem({
    agent: { id: agent, info: AgentV2.Info.empty(agent) },
    initial,
  } satisfies Pick<SessionContext.Loaded, "agent" | "initial">)
}

const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")
const model = Model.make({
  id: modelID,
  provider: providerID,
  route: AnthropicMessages.route.with({ limits: { context: 200, output: 0 } }),
})

const models = (context: number) => [
  {
    ...ModelV2.Info.empty(providerID, modelID),
    limit: { context, output: 0 },
  },
]

const resolvedPolicy = (input?: {
  readonly margin?: number
  readonly advisory?: false | { readonly consider_percent: number; readonly strongly_advised_percent: number }
}) =>
  ConfigCompaction.resolve([
    new ConfigCompaction.Info({
      context_safety_margin_tokens: input?.margin ?? 0,
      ...(input?.advisory === undefined ? {} : { advisory: input.advisory }),
    }),
  ])

const context = (input: { readonly context: number; readonly policy?: ConfigCompaction.Resolved }) => ({
  models: models(input.context),
  model: ModelV2.Ref.make({ providerID, id: modelID }),
  policy: input.policy ?? resolvedPolicy(),
  system: [SystemPart.make("x".repeat(240))],
  tools: [],
  messages: [],
})

const text = (message: NonNullable<ReturnType<typeof SessionContextPressure.advisory>>) => {
  const content = message.content[0]
  if (!content || content.type !== "text") throw new Error("Expected text advisory")
  return content.text
}

test("main-chat prompt defers all pressure policy to the volatile advisor", () => {
  const first = systemFor("first session state")
  const second = systemFor("different session state")
  const prompt = first.map((part) => part.text).join("\n")
  const compactionPrompt = prompt.slice(prompt.indexOf("# Conversation compaction"), prompt.indexOf("# Tone and style"))

  expect(compactionPrompt).toContain("conversation_compact")
  expect(compactionPrompt).toContain("accepts no boundary")
  expect(compactionPrompt).toContain("background")
  expect(compactionPrompt).toContain("only when a volatile context-pressure advisor appears")
  expect(compactionPrompt).not.toContain("%")
  expect(compactionPrompt).not.toContain("conversation_summarize")
  expect(compactionPrompt).not.toMatch(/summar|replace|irreversible|delet/i)
  expect(Buffer.from(first[0].text)).toEqual(Buffer.from(second[0].text))
})

test("resolves omitted and configured pressure policy through ConfigCompaction.resolve", () => {
  expect(SessionContextPressure.policy([])).toEqual(ConfigCompaction.resolve([]))
  expect(SessionContextPressure.policy([])).toMatchObject({
    contextSafetyMarginTokens: 4_096,
    advisory: { considerPercent: 70, stronglyAdvisedPercent: 90 },
  })

  const entries = [
    new Config.Document({
      type: "document",
      info: new Config.Info({
        compaction: new ConfigCompaction.Info({
          context_safety_margin_tokens: 20,
          advisory: { consider_percent: 65, strongly_advised_percent: 85 },
        }),
      }),
    }),
  ]
  expect(SessionContextPressure.policy(entries)).toEqual(ConfigCompaction.resolve([entries[0].info.compaction!]))
  expect(SessionContextPressure.contextSafetyMarginTokens(entries)).toBe(20)
})

test("adds no message at normal pressure", () => {
  expect(SessionContextPressure.advisory(context({ context: 300 }))).toBeUndefined()
})

test("adds no advisory below 70% pressure", () => {
  for (const contextWindow of [300, 200, 100]) {
    expect(SessionContextPressure.advisory(context({ context: contextWindow }))).toBeUndefined()
  }
})

test("adds configured one-line optional advice through the no-boundary background tool", () => {
  const message = SessionContextPressure.advisory(
    context({
      context: 90,
      policy: resolvedPolicy({ advisory: { consider_percent: 65, strongly_advised_percent: 85 } }),
    }),
  )

  expect(message?.volatile).toBe(true)
  expect(text(message!)).not.toContain("\n")
  expect(text(message!)).toContain("conversation_compact")
  expect(text(message!)).toContain("65%")
  expect(text(message!)).toContain("optional")
  expect(text(message!)).toContain("no boundary")
  expect(text(message!)).toContain("background")
})

test("adds configured one-line strongly-advised advice through the no-boundary background tool", () => {
  const message = SessionContextPressure.advisory(
    context({
      context: 70,
      policy: resolvedPolicy({ advisory: { consider_percent: 65, strongly_advised_percent: 85 } }),
    }),
  )

  expect(message?.volatile).toBe(true)
  expect(text(message!)).not.toContain("\n")
  expect(text(message!)).toContain("conversation_compact")
  expect(text(message!)).toContain("85%")
  expect(text(message!)).toContain("strongly advised")
  expect(text(message!)).toContain("no boundary")
  expect(text(message!)).toContain("background")
})

test("classifies pressure against configured percentages of the hard input cap", () => {
  const policy = resolvedPolicy({ advisory: { consider_percent: 50, strongly_advised_percent: 75 } })
  const level = (contextWindow: number) => {
    const input = context({ context: contextWindow, policy })
    return SessionContextPressure.level({
      capabilities: {
        contextWindowTokens: contextWindow,
        maxOutputTokens: 0,
        contextSafetyMarginTokens: policy.contextSafetyMarginTokens,
      },
      policy,
      system: input.system,
      tools: input.tools,
      messages: input.messages,
    })
  }

  expect(level(300)).toBe("normal")
  expect(level(100)).toBe("consider")
  expect(level(80)).toBe("advised")
  expect(level(60)).toBe("mandatory")
})

test("applies the configured safety margin to the hard input cap", () => {
  expect(SessionContextPressure.advisory(context({ context: 100 }))).toBeUndefined()
  expect(
    text(SessionContextPressure.advisory(context({ context: 100, policy: resolvedPolicy({ margin: 20 }) }))!),
  ).toContain("70%")
  expect(
    text(SessionContextPressure.advisory(context({ context: 100, policy: resolvedPolicy({ margin: 35 }) }))!),
  ).toContain("90%")
})

test("classifies exact, exceeded, zero, and negative hard input caps as mandatory", () => {
  const classify = (contextWindowTokens: number, maxOutputTokens = 0) =>
    SessionContextPressure.level({
      ...context({ context: contextWindowTokens }),
      capabilities: { contextWindowTokens, maxOutputTokens, contextSafetyMarginTokens: 0 },
    })

  expect(classify(62)).toBe("mandatory")
  expect(classify(61)).toBe("mandatory")
  expect(classify(0)).toBe("mandatory")
  expect(classify(10, 11)).toBe("mandatory")
})

test("does not count raw image media bytes as input tokens", () => {
  const image = (data: string) =>
    Message.make({
      role: "user",
      content: [{ type: "media", mediaType: "image/png", data, filename: "image.png" }],
    })
  const estimate = (data: string) =>
    SessionContextPressure.estimatedInputTokens({ system: [], tools: [], messages: [image(data)] })

  expect(estimate("a".repeat(100_000))).toBe(estimate(""))
})

test("advisory false suppresses soft advice but not mandatory classification", () => {
  const policy = resolvedPolicy({ advisory: false })
  expect(
    SessionContextPressure.level({
      ...context({ context: 100, policy }),
      capabilities: {
        contextWindowTokens: 100,
        maxOutputTokens: 0,
        contextSafetyMarginTokens: 0,
      },
    }),
  ).toBe("normal")
  expect(SessionContextPressure.advisory(context({ context: 100, policy }))).toBeUndefined()
  expect(
    SessionContextPressure.level({
      ...context({ context: 60, policy }),
      capabilities: {
        contextWindowTokens: 60,
        maxOutputTokens: 0,
        contextSafetyMarginTokens: 0,
      },
    }),
  ).toBe("mandatory")
  expect(text(SessionContextPressure.advisory(context({ context: 60, policy }))!)).toContain("mandatory")
})

test("reports runtime-performed mandatory compaction at the cap", () => {
  const message = SessionContextPressure.advisory(context({ context: 60 }))

  expect(message?.role).toBe("user")
  expect(text(message!)).toContain("exhausted")
  expect(text(message!)).toContain("mandatory")
})

test("keeps the stable system and tool prefix unchanged and unmarked", () => {
  const system = [SystemPart.make("stable system")]
  const tools = [
    ToolDefinition.make({ name: "stable_tool", description: "Stable tool", inputSchema: { type: "object" } }),
  ]
  const request = (message: NonNullable<ReturnType<typeof SessionContextPressure.advisory>>) =>
    applyCachePolicy(
      LLM.request({
        model,
        system,
        tools,
        messages: [Message.user("durable history"), message],
        cache: "auto",
      }),
    )
  const critical = SessionContextPressure.advisory(context({ context: 65 }))!
  const terminal = SessionContextPressure.advisory(context({ context: 60 }))!
  const first = request(critical)
  const second = request(terminal)

  expect(JSON.stringify(first.system)).toBe(JSON.stringify(second.system))
  expect(JSON.stringify(first.tools)).toBe(JSON.stringify(second.tools))
  expect(first.messages.at(-1)?.volatile).toBe(true)
  expect(second.messages.at(-1)?.volatile).toBe(true)
  expect(first.messages.at(-1)?.content).toEqual([{ type: "text", text: text(critical) }])
  expect(second.messages.at(-1)?.content).toEqual([{ type: "text", text: text(terminal) }])
  expect(first.messages.at(-1)?.content.some((part) => "cache" in part && part.cache !== undefined)).toBe(false)
  expect(second.messages.at(-1)?.content.some((part) => "cache" in part && part.cache !== undefined)).toBe(false)
})
