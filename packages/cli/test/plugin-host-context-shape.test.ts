import { describe, expect, test } from "bun:test"
import { Codec } from "../src/plugin-host/codec"
import { PluginContext } from "../src/plugin-host/context"

const SESSION_CONTEXT = 6

const draft = {
  sessionID: "ses_shape",
  agent: "build",
  model: { providerID: "openai", id: "gpt-test" },
  routeID: "route-test",
  system: [
    { text: "System", cache: { type: "persistent", ttl: 3600 }, metadata: { s: 1 }, providerMetadata: { p: 1 } },
  ],
  messages: [
    {
      origin: 0,
      id: "msg_user",
      role: "user",
      content: [
        {
          type: "text",
          value: { text: "Hello", cache: { type: "ephemeral" }, metadata: { m: 1 }, providerMetadata: { p: 2 } },
        },
        { type: "media", value: { mime: "image/png", data: "AQID", bytes: true, filename: "a.png" } },
        { type: "media", value: { mime: "image/png", data: "https://example.test/a.png", bytes: false } },
      ],
      volatile: false,
      metadata: { k: "v" },
    },
    {
      origin: 1,
      id: "msg_assistant",
      role: "assistant",
      content: [
        { type: "reasoning", value: { text: "thinking", encrypted: "sealed", providerMetadata: { r: 1 } } },
        {
          type: "tool-call",
          value: {
            id: "call_1",
            name: "echo",
            input: { text: "hi" },
            providerExecuted: true,
            providerMetadata: { c: 1 },
          },
        },
      ],
      volatile: true,
      native: { openai: { item: "item_1" } },
    },
    {
      origin: 2,
      role: "tool",
      content: [
        {
          type: "tool-result",
          value: {
            id: "call_1",
            name: "echo",
            result: { type: "json", value: { ok: true } },
            cache: { type: "persistent" },
            providerExecuted: false,
            providerMetadata: { t: 1 },
            output: { structured: {}, content: [] },
          },
        },
      ],
      volatile: false,
    },
  ],
  tools: [{ name: "echo", description: "Echo", input: { type: "object" } }],
}

const call = {} as Codec.Message

describe("plugin host session context shape", () => {
  test("presents every request part in the plugin message shape", async () => {
    const seen: any[] = []
    await PluginContext.transform(SESSION_CONTEXT, structuredClone(draft), call, [(event) => seen.push(event)])

    const event = seen[0]
    expect(event.system).toEqual([
      {
        type: "text",
        text: "System",
        cache: { type: "persistent", ttlSeconds: 3600 },
        metadata: { s: 1 },
        providerMetadata: { p: 1 },
      },
    ])
    expect(event.messages).toEqual([
      {
        id: "msg_user",
        role: "user",
        content: [
          { type: "text", text: "Hello", cache: { type: "ephemeral" }, metadata: { m: 1 }, providerMetadata: { p: 2 } },
          { type: "media", mediaType: "image/png", data: new Uint8Array([1, 2, 3]), filename: "a.png" },
          { type: "media", mediaType: "image/png", data: "https://example.test/a.png" },
        ],
        metadata: { k: "v" },
      },
      {
        id: "msg_assistant",
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", encrypted: "sealed", providerMetadata: { r: 1 } },
          {
            type: "tool-call",
            id: "call_1",
            name: "echo",
            input: { text: "hi" },
            providerExecuted: true,
            providerMetadata: { c: 1 },
          },
        ],
        volatile: true,
        native: { openai: { item: "item_1" } },
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call_1",
            name: "echo",
            result: { type: "json", value: { ok: true } },
            cache: { type: "persistent" },
            providerExecuted: false,
            providerMetadata: { t: 1 },
            output: { structured: {}, content: [] },
          },
        ],
      },
    ])
    expect(event.messages[0].content[1].data).toBeInstanceOf(Uint8Array)
    expect(event.messages.some((message: object) => "origin" in message)).toBe(false)
    expect(event.tools).toEqual({ echo: { description: "Echo", input: { type: "object" } } })
  })

  test("returns an unchanged context losslessly", async () => {
    const result = await PluginContext.transform(SESSION_CONTEXT, structuredClone(draft), call, [() => undefined])

    expect(Codec.readValue(Codec.value(result))).toEqual(draft)
  })

  test("re-attaches existing messages by identity and sends new messages without an origin", async () => {
    const result = await PluginContext.transform(SESSION_CONTEXT, structuredClone(draft), call, [
      (event) => {
        const [user, assistant] = event.messages
        user.content[2].data = new Uint8Array([4, 5])
        event.messages = [assistant, user, { role: "system", content: [{ type: "text", text: "added" }] }]
      },
    ])

    const messages = (Codec.readValue(Codec.value(result)) as any).messages
    expect(messages.map((message: any) => message.origin)).toEqual([1, 0, undefined])
    expect(messages[1].content[2]).toEqual({ type: "media", value: { mime: "image/png", data: "BAU=", bytes: true } })
    expect(messages[2]).toEqual({
      role: "system",
      content: [{ type: "text", value: { text: "added" } }],
      volatile: false,
    })
  })
})
