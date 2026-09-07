import { expect, test } from "bun:test"
import { Message, SystemPart } from "@ycoding-ai/ai"
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

test("main-chat prompt leaves compaction scheduling to the runtime", () => {
  const first = systemFor("first session state")
  const second = systemFor("different session state")
  const prompt = first.map((part) => part.text).join("\n")

  expect(prompt).not.toContain("conversation_compact")
  expect(prompt).not.toContain("conversation_summarize")
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

test("classifies pressure against configured percentages of the context window", () => {
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

test("applies the configured safety margin only to the hard input cap", () => {
  const classify = (margin: number) => {
    const policy = resolvedPolicy({ margin })
    return SessionContextPressure.modelLevel({ ...context({ context: 100, policy }), policy })
  }

  expect(classify(0)).toBe("normal")
  expect(classify(20)).toBe("normal")
  expect(classify(40)).toBe("mandatory")
})

test("classifies exact, exceeded, zero, and negative hard input caps as mandatory", () => {
  const classify = (contextWindowTokens: number, contextSafetyMarginTokens = 0) =>
    SessionContextPressure.level({
      ...context({ context: contextWindowTokens }),
      capabilities: { contextWindowTokens, maxOutputTokens: 0, contextSafetyMarginTokens },
    })

  expect(classify(62)).toBe("mandatory")
  expect(classify(61)).toBe("mandatory")
  expect(classify(0)).toBe("mandatory")
  expect(classify(10, 11)).toBe("mandatory")
})

test("does not count encoded image payloads as input tokens", () => {
  const image = (data: string | Uint8Array) =>
    Message.make({
      role: "user",
      content: [{ type: "media", mediaType: "image/png", data, filename: "image.png" }],
    })
  const toolImage = (data: string) =>
    Message.tool({
      id: "call-image",
      name: "read",
      result: {
        type: "content",
        value: [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "image.png" }],
      },
    })
  const estimate = (message: Message) =>
    SessionContextPressure.estimatedInputTokens({ system: [], tools: [], messages: [message] })

  expect(estimate(image("a".repeat(100_000)))).toBe(estimate(image("")))
  expect(estimate(image(new Uint8Array(100_000)))).toBe(estimate(image(new Uint8Array())))
  expect(estimate(toolImage("a".repeat(100_000)))).toBe(estimate(toolImage("")))
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
})
