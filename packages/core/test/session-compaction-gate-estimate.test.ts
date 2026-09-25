import { expect, test } from "bun:test"
import { LLM, Message, Model } from "@ycoding-ai/ai"
import { OpenAIResponses } from "@ycoding-ai/ai/protocols/openai-responses"
import { SessionCompactionGate } from "@ycoding-ai/core/session/runner/compaction-gate"

test("the local gate estimates the effective stateless Responses span", () => {
  const model = Model.make({
    id: "gpt-5.5",
    provider: "openai",
    route: OpenAIResponses.route.with({ providerOptions: { openai: { store: false } } }),
  })
  const request = LLM.request({
    model,
    messages: [
      Message.user("historical context".repeat(2_000)),
      Message.assistant([{
        type: "reasoning", text: "", providerMetadata: {
          openai: { opaqueCompactionItem: { type: "compaction", id: "cmp_gate", encrypted_content: "opaque" } },
        },
      }]),
      Message.user("new suffix"),
    ],
  })
  expect(SessionCompactionGate.estimatedProviderInputTokens(request)).toBeLessThan(200)
})

test("the local gate estimates a Copilot compaction boundary under its metadata key", () => {
  const model = Model.make({
    id: "copilot-model", provider: "github-copilot",
    route: OpenAIResponses.route.with({ id: "ai-sdk:@ai-sdk/github-copilot", providerOptions: { copilot: { store: false } } }),
  })
  const request = LLM.request({ model, messages: [
    Message.user("historical context".repeat(2_000)),
    Message.assistant([{ type: "reasoning", text: "", providerMetadata: { copilot: { opaqueCompactionItem: { type: "compaction", id: "cmp_gate", encrypted_content: "opaque" } } } }]),
    Message.user("new suffix"),
  ] })
  expect(SessionCompactionGate.estimatedProviderInputTokens(request)).toBeLessThan(200)
})
