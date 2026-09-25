import { expect, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { CacheHint } from "@ycoding-ai/ai"
import { AISDKCache } from "@ycoding-ai/core/aisdk-cache"
import { convertToOpenAICompatibleChatMessages } from "@ycoding-ai/core/github-copilot/chat/convert-to-openai-compatible-chat-messages"

test("lifts Copilot cache hints to the containing Chat message", () => {
  const prompt: LanguageModelV3Prompt = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "answer", providerOptions: { copilot: { cacheControl: { type: "ephemeral" } } } },
        { type: "tool-call", toolCallId: "call", toolName: "lookup", input: {}, providerOptions: { copilot: { cacheControl: { type: "ephemeral" } } } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call", toolName: "lookup", output: { type: "text", value: "ok" }, providerOptions: { copilot: { cacheControl: { type: "ephemeral" } } } }],
    },
  ]
  const messages = convertToOpenAICompatibleChatMessages(prompt)
  expect(messages).toMatchObject([
    { role: "assistant", copilot_cache_control: { type: "ephemeral" }, content: "answer" },
    { role: "tool", copilot_cache_control: { type: "ephemeral" }, content: "ok" },
  ])
  expect(JSON.stringify(messages)).not.toContain("cacheControl")
})

test("lowers Claude cache hints without a TTL and caps Chat markers at four", () => {
  expect(AISDKCache.options("ai-sdk:@ai-sdk/github-copilot", new CacheHint({ type: "ephemeral", ttlSeconds: 3600 }))).toEqual({
    copilot: { cacheControl: { type: "ephemeral" } },
  })
  const prompt: LanguageModelV3Prompt = Array.from({ length: 5 }, (_, index) => ({
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `message-${index}`,
        providerOptions: { copilot: { cacheControl: { type: "ephemeral" } } },
      },
    ],
  }))
  const messages = convertToOpenAICompatibleChatMessages(prompt)
  expect(messages.filter((message) => "copilot_cache_control" in message)).toHaveLength(4)
})
