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

const context = (input: { readonly context: number; readonly margin?: number }) => ({
  models: models(input.context),
  model: ModelV2.Ref.make({ providerID, id: modelID }),
  contextSafetyMarginTokens: input.margin ?? 0,
  system: [SystemPart.make("x".repeat(240))],
  tools: [],
  messages: [],
})

const text = (message: NonNullable<ReturnType<typeof SessionContextPressure.advisory>>) => {
  const content = message.content[0]
  if (!content || content.type !== "text") throw new Error("Expected text advisory")
  return content.text
}

test("main-chat prompt describes safe irreversible conversation summarization", () => {
  const first = systemFor("first session state")
  const second = systemFor("different session state")

  expect(first.map((part) => part.text).join("\n")).toContain("conversation_summarize")
  expect(first.map((part) => part.text).join("\n")).toContain("irreversible")
  expect(first.map((part) => part.text).join("\n")).toContain("ongoing hygiene")
  expect(first.map((part) => part.text).join("\n")).toContain("durable TOON summary")
  expect(Buffer.from(first[0]!.text)).toEqual(Buffer.from(second[0]!.text))
})

test("adds no message at normal pressure", () => {
  expect(SessionContextPressure.advisory(context({ context: 300 }))).toBeUndefined()
})

test("adds a distinct one-line volatile advisory for each pressure milestone", () => {
  for (const [contextWindow, expected] of [
    [200, "starting to fill"],
    [100, "good moment"],
    [75, "soon"],
    [65, "nearly exhausted"],
    [60, "Safe input budget is exhausted"],
  ] as const) {
    const message = SessionContextPressure.advisory(context({ context: contextWindow }))
    expect(message?.volatile).toBe(true)
    expect(text(message!)).not.toContain("\n")
    expect(text(message!)).toContain("conversation_summarize")
    expect(text(message!)).toContain(expected)
  }
})

test("applies the configured safety margin to pressure classification", () => {
  expect(text(SessionContextPressure.advisory(context({ context: 100 }))!)).toContain("good moment")
  expect(text(SessionContextPressure.advisory(context({ context: 100, margin: 20 }))!)).toContain(
    "soon",
  )
  expect(
    SessionContextPressure.contextSafetyMarginTokens([
      new Config.Document({
        type: "document",
        info: new Config.Info({ compaction: new ConfigCompaction.Info({ context_safety_margin_tokens: 20 }) }),
      }),
    ]),
  ).toBe(20)
})

test("never invokes summarization at the terminal level", () => {
  const message = SessionContextPressure.advisory(context({ context: 60 }))

  expect(message?.role).toBe("user")
  expect(text(message!)).toContain("no automatic compaction")
})

test("keeps the stable system and tool prefix unchanged and unmarked", () => {
  const system = [SystemPart.make("stable system")]
  const tools = [ToolDefinition.make({ name: "stable_tool", description: "Stable tool", inputSchema: { type: "object" } })]
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
  const advisory = SessionContextPressure.advisory(context({ context: 100 }))!
  const critical = SessionContextPressure.advisory(context({ context: 65 }))!
  const first = request(advisory)
  const second = request(critical)

  expect(JSON.stringify(first.system)).toBe(JSON.stringify(second.system))
  expect(JSON.stringify(first.tools)).toBe(JSON.stringify(second.tools))
  expect(first.messages.at(-1)?.volatile).toBe(true)
  expect(second.messages.at(-1)?.volatile).toBe(true)
  expect(first.messages.at(-1)?.content).toEqual([{ type: "text", text: text(advisory) }])
  expect(second.messages.at(-1)?.content).toEqual([{ type: "text", text: text(critical) }])
  expect(first.messages.at(-1)?.content.some((part) => "cache" in part && part.cache !== undefined)).toBe(false)
  expect(second.messages.at(-1)?.content.some((part) => "cache" in part && part.cache !== undefined)).toBe(false)
})
