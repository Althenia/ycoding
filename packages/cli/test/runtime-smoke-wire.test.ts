import { expect, test } from "bun:test"
import { streamResponse, toolCallResponse } from "../script/runtime-smoke"

function events(stream: string) {
  return stream
    .trim()
    .split("\n\n")
    .map((line) => JSON.parse(line.slice("data: ".length)))
}

test("runtime smoke native Responses text distinguishes cold and cached usage", () => {
  const first = events(streamResponse({ index: 1, content: "First" }))
  expect(first[0]).toMatchObject({ type: "response.output_text.delta", delta: "First" })
  expect(first[1]).toMatchObject({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1000,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 },
        output_tokens_details: { reasoning_tokens: 5 },
      },
    },
  })
  expect(events(streamResponse({ index: 2, content: "Second" }))[1]).toMatchObject({
    response: { usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 } } },
  })
})

test("runtime smoke native Responses emits a callable tool and explicit usage", () => {
  const result = events(
    toolCallResponse({
      index: 3,
      callID: "call_read",
      name: "read",
      arguments: { path: "tool-one.txt" },
      prompt: 1300,
      cached: 1000,
      cacheWrite: 0,
    }),
  )
  expect(result[0]).toMatchObject({
    type: "response.output_item.added",
    item: { type: "function_call", call_id: "call_read", name: "read", arguments: "" },
  })
  expect(result[1]).toMatchObject({ type: "response.function_call_arguments.delta", delta: '{"path":"tool-one.txt"}' })
  expect(result[2]).toMatchObject({
    type: "response.output_item.done",
    item: { call_id: "call_read", arguments: '{"path":"tool-one.txt"}' },
  })
  expect(result[3]).toMatchObject({
    type: "response.completed",
    response: { usage: { input_tokens: 1300, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 } } },
  })
})
