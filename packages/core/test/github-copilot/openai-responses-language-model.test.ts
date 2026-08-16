import { OpenAIResponsesLanguageModel } from "@ycoding-ai/core/github-copilot/responses/openai-responses-language-model"
import { convertToOpenAIResponsesInput } from "@ycoding-ai/core/github-copilot/responses/convert-to-openai-responses-input"
import { describe, test, expect, mock } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"

const TEST_PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]

function createMockFetch(body: unknown) {
  return mock(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  )
}

function createMockStreamFetch(events: unknown[]) {
  return mock(async (..._args: Parameters<typeof fetch>) => {
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        }
        controller.close()
      },
    })

    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  })
}

async function readStream<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader()
  const parts: T[] = []
  let result = await reader.read()
  while (!result.done) {
    parts.push(result.value)
    result = await reader.read()
  }
  return parts
}

function createModel(fetchFn: ReturnType<typeof mock>) {
  return new OpenAIResponsesLanguageModel("test-model", {
    provider: "copilot",
    url: () => "https://api.test.com/responses",
    headers: () => ({ Authorization: "Bearer test-token" }),
    fetch: fetchFn as any,
  })
}

// GitHub Copilot's Responses model echoes item metadata (itemId, reasoningEncryptedContent,
// responseId, ...) under the "copilot" providerOptions/providerMetadata namespace, matching the
// namespace request options already use. It used to echo this metadata under "openai" (a leftover
// from forking the OpenAI Responses model), which left it unreachable by anything reading the
// "copilot" namespace and let stale itemIds slip past stripping meant for that namespace.
describe("doGenerate", () => {
  test("replays a tool follow-up statelessly with encrypted reasoning", async () => {
    const responses = [
      {
        id: "resp_1",
        created_at: 0,
        model: "gpt-5.5",
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "enc_1",
            summary: [{ type: "summary_text", text: "thinking..." }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: "{}",
            id: "fc_1",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        id: "resp_2",
        created_at: 1,
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    ]
    const mockFetch = mock(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    )
    const model = createModel(mockFetch)
    const first = await model.doGenerate({
      prompt: TEST_PROMPT,
      providerOptions: { copilot: { store: false } },
      includeRawChunks: false,
    })
    const reasoning = first.content.find((part) => part.type === "reasoning")
    const toolCall = first.content.find((part) => part.type === "tool-call")
    if (!reasoning || !toolCall) throw new Error("Expected reasoning and tool-call output")

    await model.doGenerate({
      prompt: [
        ...TEST_PROMPT,
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: reasoning.text,
              providerOptions: reasoning.providerMetadata,
            },
            {
              type: "tool-call",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              input: JSON.parse(toolCall.input),
              providerOptions: toolCall.providerMetadata,
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "lookup",
              output: { type: "text", value: "synthetic result" },
            },
          ],
        },
      ],
      providerOptions: { copilot: { store: false } },
      includeRawChunks: false,
    })

    const replayBody = mockFetch.mock.calls[1]?.[1]?.body
    if (typeof replayBody !== "string") throw new Error("Expected a JSON request body")
    const replay = JSON.parse(replayBody)
    expect(replay.store).toBe(false)
    expect(replay.input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "enc_1",
      summary: [{ type: "summary_text", text: "thinking..." }],
    })
    expect(replay.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "synthetic result",
    })
    expect(replay.input.some((item: { type?: string }) => item.type === "item_reference")).toBe(false)
  })

  test("uses generic Responses continuation and cache options", async () => {
    const mockFetch = createMockFetch({
      id: "resp_1",
      created_at: 0,
      model: "gpt-5.5",
      output: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const model = createModel(mockFetch)

    await model.doGenerate({
      prompt: TEST_PROMPT,
      providerOptions: { openai: { previousResponseId: "resp_previous", promptCacheKey: "session:cache", store: true } },
      includeRawChunks: false,
    } as any)

    expect(JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      previous_response_id: "resp_previous",
      prompt_cache_key: "session:cache",
      store: true,
    })
  })

  test("attaches item metadata under the copilot namespace, not openai", async () => {
    const mockFetch = createMockFetch({
      id: "resp_1",
      created_at: 0,
      model: "gpt-5.5",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "enc_1",
          summary: [{ type: "summary_text", text: "thinking..." }],
        },
        {
          type: "message",
          role: "assistant",
          id: "msg_1",
          content: [{ type: "output_text", text: "Hello there", annotations: [] }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "bash",
          arguments: "{}",
          id: "fc_1",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const model = createModel(mockFetch)

    const { content, providerMetadata } = await model.doGenerate({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    } as any)

    const reasoning = content.find((part: any) => part.type === "reasoning") as any
    expect(reasoning.providerMetadata?.copilot?.itemId).toBe("rs_1")
    expect(reasoning.providerMetadata?.copilot?.reasoningEncryptedContent).toBe("enc_1")
    expect(reasoning.providerMetadata?.openai).toBeUndefined()

    const text = content.find((part: any) => part.type === "text") as any
    expect(text.providerMetadata?.copilot?.itemId).toBe("msg_1")
    expect(text.providerMetadata?.openai).toBeUndefined()

    const toolCall = content.find((part: any) => part.type === "tool-call") as any
    expect(toolCall.providerMetadata?.copilot?.itemId).toBe("fc_1")
    expect(toolCall.providerMetadata?.openai).toBeUndefined()

    expect(providerMetadata?.copilot?.responseId).toBe("resp_1")
    expect(providerMetadata?.openai).toBeUndefined()
  })
})

describe("doStream", () => {
  test("closes each reasoning summary before starting the next", async () => {
    const model = createModel(
      createMockStreamFetch([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rs_1", encrypted_content: "enc_initial" },
        },
        { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "first" },
        { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
        { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "second" },
        { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "reasoning", id: "rs_rotated", encrypted_content: "enc_final" },
        },
        {
          type: "response.completed",
          response: {
            incomplete_details: null,
            usage: { input_tokens: 1, output_tokens: 2 },
            service_tier: null,
          },
        },
      ]),
    )

    const { stream } = await model.doStream({ prompt: TEST_PROMPT, includeRawChunks: false })
    const parts = await readStream(stream)

    expect(parts.filter((part) => part.type.startsWith("reasoning-"))).toEqual([
      {
        type: "reasoning-start",
        id: "rs_1:0",
        providerMetadata: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "enc_initial" } },
      },
      { type: "reasoning-delta", id: "rs_1:0", delta: "first", providerMetadata: { copilot: { itemId: "rs_1" } } },
      {
        type: "reasoning-end",
        id: "rs_1:0",
        providerMetadata: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "enc_initial" } },
      },
      {
        type: "reasoning-start",
        id: "rs_1:1",
        providerMetadata: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "enc_initial" } },
      },
      { type: "reasoning-delta", id: "rs_1:1", delta: "second", providerMetadata: { copilot: { itemId: "rs_1" } } },
      {
        type: "reasoning-end",
        id: "rs_1:1",
        providerMetadata: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "enc_final" } },
      },
    ])
  })
})

describe("convertToOpenAIResponsesInput", () => {
  test("echoes a stale tool-call itemId from the copilot namespace as the function_call id", async () => {
    const { input } = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "bash",
              input: { command: "ls" },
              providerOptions: { copilot: { itemId: "fc_999" } },
            },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    expect(input).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: JSON.stringify({ command: "ls" }),
        id: "fc_999",
      },
    ])
  })

  test("omits the function_call id once the stale copilot itemId has been stripped", async () => {
    const { input } = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "bash",
              input: { command: "ls" },
              providerOptions: {},
            },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    expect((input[0] as any).id).toBeUndefined()
  })

  test("preserves reasoning items keyed by the copilot namespace instead of dropping them", async () => {
    const { input, warnings } = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking...",
              providerOptions: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "enc_1" } },
            },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    expect(warnings).toEqual([])
    expect(input).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "enc_1",
        summary: [{ type: "summary_text", text: "thinking..." }],
      },
    ])
  })

  test("drops reasoning items with no copilot itemId and warns, as before", async () => {
    const { input, warnings } = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "thinking...", providerOptions: {} }],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    expect(input).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      message: expect.stringContaining("Non-OpenAI reasoning parts are not supported"),
    })
  })

  test("reads imageDetail from the copilot namespace on user file parts", async () => {
    const { input } = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: "aGVsbG8=",
              providerOptions: { copilot: { imageDetail: "high" } },
            },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    expect((input[0] as any).content[0].detail).toBe("high")
  })
})
