import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { MusePlugin, namespaceMuseTools } from "@ycoding-ai/core/plugin/provider/muse"
import { Provider } from "@ycoding-ai/core/provider"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("muse")
const integrationID = Integration.ID.make("muse")
const clientOnly =
  "This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only. Use it in Muse Code, or use a pay-as-you-go API key for other clients."
const canonical = [
  "browser",
  "computer",
  "decision",
  "edit",
  "glob",
  "goal",
  "grep",
  "patch",
  "project_artifact",
  "question",
  "read",
  "shell",
  "skill",
  "subagent_control",
  "subagent_report",
  "todowrite",
  "webfetch",
  "websearch",
  "worktree",
  "write",
]
const accepted = new Set(["worktree", "project_artifact", "subagent_report"])
const attested = new Set(canonical.filter((name) => !accepted.has(name)))
const wire = (name: string) => `ycoding_${name}`
const schema = (name: string) => ({
  type: "object",
  properties: { target: { type: "string", description: `Synthetic ${name} target.` } },
  required: ["target"],
  additionalProperties: false,
})
const declare = (name: string) => ({
  type: "function" as const,
  name,
  description: `Synthetic ${name} tool.`,
  inputSchema: schema(name),
})
const oauth = () =>
  Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("device"),
    access: "synthetic-access",
    refresh: "",
    expires: 0,
  })
const row = {
  id: "synthetic-muse",
  object: "model",
  metadata: {
    "muse-code": {
      name: "Synthetic",
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1_000_000, output: 128_000 },
    },
  },
}
const http = HttpClient.make((request) =>
  Effect.sync(() =>
    HttpClientResponse.fromWeb(
      request,
      request.url.endsWith("/key")
        ? Response.json({ api_key: "synthetic-key", base_url: "https://api.meta.ai/v1" })
        : Response.json({ data: [row] }),
    ),
  ),
)
const model = () =>
  CatalogModel.Info.make({
    ...CatalogModel.Info.empty(providerID, CatalogModel.ID.make(row.id)),
    package: Provider.aisdk("@ai-sdk/openai"),
    settings: {},
    limit: row.metadata["muse-code"].limit,
  })

const WireBody = Schema.Struct({
  stream: Schema.optional(Schema.Boolean),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        name: Schema.String,
        description: Schema.optional(Schema.String),
        parameters: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
  input: Schema.Array(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      call_id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.String),
    }),
  ),
})
type WireBody = typeof WireBody.Type
const decodeWireBody = Schema.decodeUnknownSync(WireBody)
type Sent = { url: string; body: WireBody }
const sentTools = (sent: Sent) => (sent.body.tools ?? []).map((tool) => tool.name)
const sse = (events: readonly unknown[], onCancel?: () => void) => {
  const encoder = new TextEncoder()
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= events.length) return onCancel ? new Promise<void>(() => undefined) : controller.close()
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[index++])}\n\n`))
      },
      cancel: onCancel,
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  )
}
const completed = {
  type: "response.completed",
  response: {
    id: "resp_synthetic",
    status: "completed",
    incomplete_details: null,
    usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
  },
}
const functionCall = (name: string, id = "call_1", args = '{"target":"x"}') => [
  { type: "response.created", response: { id: "resp_synthetic", created_at: 1, model: row.id } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: `fc_${id}`, output_index: 0, delta: args },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: args, status: "completed" },
  },
  completed,
]
const generated = (calls: readonly string[]) =>
  Response.json({
    id: "resp_synthetic",
    created_at: 1,
    model: row.id,
    output: calls.map((name, index) => ({
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name,
      arguments: '{"target":"x"}',
    })),
    incomplete_details: null,
    usage: { input_tokens: 7, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
  })
const calling = (name: string) => (body: WireBody) =>
  body.stream ? sse(functionCall(name, "call_0")) : generated([name])
const gateway =
  (
    sent: Sent[],
    respond: (body: WireBody) => Response = (body) => (body.stream ? sse([completed]) : generated([])),
  ): ((input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) =>
  async (input, init) => {
    const body = decodeWireBody(JSON.parse(String(init?.body)))
    sent.push({ url: input instanceof URL ? input.href : typeof input === "string" ? input : input.url, body })
    if ((body.tools ?? []).some((tool) => attested.has(tool.name)))
      return Response.json(
        { error: { type: "permission_error", code: "client_attestation_denied", message: clientOnly } },
        { status: 403 },
      )
    return respond(body)
  }

const install = Effect.fn(function* (send: ReturnType<typeof gateway>) {
  const aisdk = yield* AISDK.Service
  yield* aisdk.hook.sdk((event) => {
    if (event.model.providerID === providerID) event.options.fetch = send
  })
  const registry = yield* PluginRegistry.Service
  const host = yield* PluginHost.make(registry)
  yield* MusePlugin.effect(host).pipe(Effect.provideService(HttpClient.HttpClient, http))
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service
  return Effect.fn(function* (value: Credential.Value = oauth(), label = "account") {
    const saved = yield* credentials.create({ integrationID, value, label })
    const snapshot = yield* integrations.connection.snapshot({
      type: "credential",
      id: saved.id,
      label: saved.label,
      active: true,
    })
    return yield* aisdk.language(model(), snapshot)
  })
})
const setup = Effect.fn(function* (send: ReturnType<typeof gateway>, value?: Credential.Value, label?: string) {
  const open = yield* install(send)
  return yield* open(value, label)
})
const options = (extra: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions => ({
  prompt: [
    { role: "system", content: "Synthetic system." },
    { role: "user", content: [{ type: "text", text: "Synthetic request." }] },
  ],
  ...extra,
})
const rejected = (run: () => PromiseLike<unknown>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(Effect.flip)
const drain = (stream: ReadableStream<LanguageModelV3StreamPart>) =>
  Effect.promise(async () => {
    const parts: LanguageModelV3StreamPart[] = []
    for await (const part of stream) parts.push(part)
    return parts
  })

describe("Muse tool namespace adapter", () => {
  it.effect("declares every canonical function tool under the private namespace and the gateway accepts it", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const language = yield* setup(gateway(sent))
      const tools = canonical.map(declare)
      const result = yield* Effect.promise(() => language.doGenerate(options({ tools })))
      expect(result.finishReason.unified).toBeDefined()
      expect(sent).toHaveLength(1)
      expect(sentTools(sent[0])).toEqual(canonical.map(wire))
      const declared = sent[0].body.tools ?? []
      expect(declared.map((tool) => tool.type)).toEqual(canonical.map(() => "function"))
      expect(declared.map((tool) => tool.description)).toEqual(canonical.map((name) => `Synthetic ${name} tool.`))
      expect(declared.map((tool) => tool.parameters)).toEqual(canonical.map(schema))
    }),
  )

  it.effect("rejects the same declarations with the original attestation failure when sent verbatim", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const language = yield* setup(gateway(sent), Credential.Key.make({ type: "key", key: "synthetic-direct" }))
      const failure = yield* rejected(() => language.doGenerate(options({ tools: canonical.map(declare) })))
      expect(sent.map((entry) => sentTools(entry))).toEqual([canonical])
      expect(failure).toMatchObject({ statusCode: 403 })
      expect(String((failure as { responseBody?: string }).responseBody)).toContain("client_attestation_denied")
    }),
  )

  it.effect("leaves direct API key requests unchanged", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const language = yield* setup(gateway(sent), Credential.Key.make({ type: "key", key: "synthetic-direct" }))
      yield* Effect.promise(() => language.doGenerate(options({ tools: ["worktree", "tool_a"].map(declare) })))
      expect(sentTools(sent[0])).toEqual(["worktree", "tool_a"])
    }),
  )

  it.effect("namespaces replayed assistant tool calls and keeps ids and arguments", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const language = yield* setup(gateway(sent))
      yield* Effect.promise(() =>
        language.doGenerate(
          options({
            tools: ["shell", "read"].map(declare),
            prompt: [
              { role: "system", content: "Synthetic system." },
              { role: "user", content: [{ type: "text", text: "Synthetic request." }] },
              {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "call_a", toolName: "shell", input: { target: "a" } },
                  { type: "tool-call", toolCallId: "call_b", toolName: "removed_tool", input: { target: "b" } },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call_a",
                    toolName: "shell",
                    output: { type: "text", value: "done" },
                  },
                  {
                    type: "tool-result",
                    toolCallId: "call_b",
                    toolName: "removed_tool",
                    output: { type: "text", value: "gone" },
                  },
                ],
              },
            ],
          }),
        ),
      )
      const calls = sent[0].body.input.filter((item) => item.type === "function_call")
      expect(calls).toMatchObject([
        { call_id: "call_a", name: wire("shell"), arguments: '{"target":"a"}' },
        { call_id: "call_b", name: wire("removed_tool"), arguments: '{"target":"b"}' },
      ])
      const outputs = sent[0].body.input.filter((item) => item.type === "function_call_output")
      expect(outputs.map((item) => item.call_id)).toEqual(["call_a", "call_b"])
    }),
  )

  it.effect("restores canonical names in non-streaming results and only reverses known mapped names", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const language = yield* setup(
        gateway(sent, () => generated([wire("shell"), wire("ycoding_edit"), wire("undeclared"), "read"])),
      )
      const result = yield* Effect.promise(() =>
        language.doGenerate(options({ tools: ["shell", "ycoding_edit", "read"].map(declare) })),
      )
      const calls = result.content.filter((part) => part.type === "tool-call")
      expect(calls.map((part) => [part.toolCallId, part.toolName, part.input])).toEqual([
        ["call_0", "shell", '{"target":"x"}'],
        ["call_1", "ycoding_edit", '{"target":"x"}'],
        ["call_2", wire("undeclared"), '{"target":"x"}'],
        ["call_3", "read", '{"target":"x"}'],
      ])
      expect(sentTools(sent[0])).toEqual([wire("shell"), wire("ycoding_edit"), wire("read")])
      expect(result.usage.inputTokens.total).toBe(7)
    }),
  )

  it.effect("restores canonical names in streamed tool input and calls and preserves the rest of the stream", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const language = yield* setup(gateway(sent, () => sse(functionCall(wire("shell"), "call_s"))))
      const { stream } = yield* Effect.promise(() => language.doStream(options({ tools: ["shell"].map(declare) })))
      const parts = yield* drain(stream)
      const start = parts.find((part) => part.type === "tool-input-start")
      const call = parts.find((part) => part.type === "tool-call")
      expect(start).toMatchObject({ id: "call_s", toolName: "shell" })
      expect(call).toMatchObject({ toolCallId: "call_s", toolName: "shell", input: '{"target":"x"}' })
      expect(parts.some((part) => part.type === "tool-input-delta" && part.delta === '{"target":"x"}')).toBe(true)
      expect(parts.at(-1)).toMatchObject({ type: "finish", usage: { inputTokens: { total: 7 } } })
      expect(JSON.stringify(parts)).not.toContain(wire("shell"))
    }),
  )

  it.effect("propagates stream cancellation to the transport", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      let notifyCancelled = () => {}
      const cancelled = new Promise<void>((resolve) => {
        notifyCancelled = resolve
      })
      const language = yield* setup(gateway(sent, () => sse(functionCall(wire("shell")), notifyCancelled)))
      const { stream } = yield* Effect.promise(() => language.doStream(options({ tools: ["shell"].map(declare) })))
      yield* Effect.promise(async () => {
        const reader = stream.getReader()
        try {
          await reader.read()
        } finally {
          await reader.cancel()
        }
        await cancelled
      })
    }),
  )

  it.effect("keeps names stable across invocations and profiles without shared mapping state", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const open = yield* install(gateway(sent, calling(wire("edit"))))
      const one = yield* open(oauth(), "one")
      const two = yield* open(oauth(), "two")
      yield* Effect.promise(() => one.doGenerate(options({ tools: ["shell", "edit"].map(declare) })))
      yield* Effect.promise(() => two.doGenerate(options({ tools: ["shell", "edit"].map(declare) })))
      const { stream } = yield* Effect.promise(() => one.doStream(options({ tools: ["shell"].map(declare) })))
      const parts = yield* drain(stream)
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({ toolName: wire("edit") })
      const names = sent.map((entry) => sentTools(entry))
      expect(names).toEqual([[wire("shell"), wire("edit")], [wire("shell"), wire("edit")], [wire("shell")]])
    }),
  )

  it.effect("encodes long names injectively within the 64 character limit and restores them", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const long = (suffix: string) => `server_${"a".repeat(70)}_${suffix}`
      const names = [long("one"), long("two"), "x".repeat(56), "x".repeat(57), "x".repeat(200)]
      const open = yield* install(gateway(sent, (body) => calling(body.tools?.[0]?.name ?? "")(body)))
      const one = yield* open(oauth(), "one")
      const two = yield* open(oauth(), "two")
      yield* Effect.promise(() => one.doGenerate(options({ tools: names.map(declare) })))
      yield* Effect.promise(() => two.doGenerate(options({ tools: names.map(declare) })))
      const encoded = sentTools(sent[0])
      expect(new Set(encoded).size).toBe(names.length)
      encoded.forEach((name) => expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/))
      expect(encoded[2]).toBe(wire(names[2]))
      expect(encoded[0]).toMatch(/^ycoding_server_a+_/)
      expect(sentTools(sent[1])).toEqual(encoded)
      const { stream } = yield* Effect.promise(() => one.doStream(options({ tools: names.map(declare) })))
      const parts = yield* drain(stream)
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({ toolName: names[0] })
    }),
  )

  it.effect("fails before any request when two declared names would share one wire name", () =>
    Effect.gen(function* () {
      const sent: Sent[] = []
      const open = yield* install(gateway(sent))
      const language = yield* open()
      const original = "y".repeat(100)
      yield* Effect.promise(() => language.doGenerate(options({ tools: [declare(original)] })))
      const clash = sentTools(sent[0])[0].slice("ycoding_".length)
      const failure = yield* rejected(() =>
        language.doGenerate(options({ tools: [declare(original), declare(clash)] })),
      )
      expect(String(failure)).toContain("tool name")
      expect(sent).toHaveLength(1)
    }),
  )

  test("maps explicit tool choice and history at the model boundary and leaves provider tools alone", async () => {
    const seen: LanguageModelV3CallOptions[] = []
    const inner = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "fixture",
      supportedUrls: {},
      doGenerate: async (call: LanguageModelV3CallOptions) => {
        seen.push(call)
        return {
          content: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        }
      },
      doStream: async () => ({ stream: new ReadableStream() }),
    } as unknown as LanguageModelV3
    const wrapped = namespaceMuseTools(inner)
    const signal = new AbortController().signal
    await wrapped.doGenerate({
      ...options({ abortSignal: signal }),
      tools: [declare("shell"), { type: "provider", id: "openai.web_search", name: "web_search", args: {} }],
      toolChoice: { type: "tool", toolName: "shell" },
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "p", toolName: "web_search", input: {}, providerExecuted: true },
            { type: "tool-call", toolCallId: "h", toolName: "shell", input: {}, providerExecuted: true },
            {
              type: "tool-result",
              toolCallId: "h",
              toolName: "shell",
              output: { type: "text", value: "hosted" },
            },
            { type: "tool-call", toolCallId: "q", toolName: "shell", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "q", toolName: "shell", output: { type: "text", value: "done" } },
          ],
        },
      ],
    })
    expect(seen[0].toolChoice).toEqual({ type: "tool", toolName: wire("shell") })
    expect(seen[0].tools?.map((tool) => tool.name)).toEqual([wire("shell"), "web_search"])
    expect(seen[0].abortSignal).toBe(signal)
    const names = seen[0].prompt.flatMap((message) =>
      message.role === "assistant" || message.role === "tool"
        ? message.content.flatMap((part) => ("toolName" in part ? [part.toolName] : []))
        : [],
    )
    expect(names).toEqual(["web_search", "shell", "shell", wire("shell"), wire("shell")])
    expect(wrapped.provider).toBe("fixture")
    expect(await wrapped.supportedUrls).toEqual({})
  })

  test("restores only client-executed tool names and keeps hosted tool parts byte for byte", async () => {
    const hostedCall = {
      type: "tool-call",
      toolCallId: "h",
      toolName: wire("shell"),
      input: "{}",
      providerExecuted: true,
      providerMetadata: { openai: { itemId: "synthetic" } },
    } as const
    const hostedResult = {
      type: "tool-result",
      toolCallId: "h",
      toolName: wire("shell"),
      result: { ok: true },
    } as const
    const hostedStart = { type: "tool-input-start", id: "h", toolName: wire("shell"), providerExecuted: true } as const
    const clientCall = {
      type: "tool-call",
      toolCallId: "c",
      toolName: wire("shell"),
      input: '{"target":"x"}',
      providerMetadata: { openai: { itemId: "synthetic" } },
    } as const
    const clientStart = { type: "tool-input-start", id: "c", toolName: wire("shell") } as const
    const parts = [
      { type: "stream-start", warnings: [] },
      hostedStart,
      hostedCall,
      hostedResult,
      clientStart,
      clientCall,
      { type: "tool-result", toolCallId: "r", toolName: wire("shell"), result: {}, preliminary: true },
    ] satisfies LanguageModelV3StreamPart[]
    const inner = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "fixture",
      supportedUrls: {},
      doGenerate: async () => ({
        content: [hostedCall, hostedResult, clientCall],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            parts.forEach((part) => controller.enqueue(part))
            controller.close()
          },
        }),
      }),
    } as unknown as LanguageModelV3
    const wrapped = namespaceMuseTools(inner)
    const call = options({ tools: [declare("shell")] })
    const generated = await wrapped.doGenerate(call)
    expect(generated.content).toEqual([hostedCall, hostedResult, { ...clientCall, toolName: "shell" }])
    const streamed = await wrapped.doStream(call)
    const received: LanguageModelV3StreamPart[] = []
    for await (const part of streamed.stream) received.push(part)
    expect(received).toEqual([
      parts[0],
      hostedStart,
      hostedCall,
      hostedResult,
      { ...clientStart, toolName: "shell" },
      { ...clientCall, toolName: "shell" },
      parts[6],
    ])
  })

  test("passes stream failures and cancellation through the wrapped stream unchanged", async () => {
    const failure = new Error("synthetic stream failure")
    let cancelled = false
    let pulls = 0
    const streams = [
      new ReadableStream<LanguageModelV3StreamPart>(
        {
          pull(controller) {
            if (pulls++ === 0)
              controller.enqueue({ type: "tool-call", toolCallId: "c", toolName: wire("shell"), input: "{}" })
            else controller.error(failure)
          },
        },
        { highWaterMark: 0 },
      ),
      new ReadableStream<LanguageModelV3StreamPart>({ cancel: () => void (cancelled = true) }),
    ]
    const inner = {
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "fixture",
      supportedUrls: {},
      doGenerate: async () => {
        throw failure
      },
      doStream: async () => ({ stream: streams.shift()!, request: { body: "kept" } }),
    } as unknown as LanguageModelV3
    const wrapped = namespaceMuseTools(inner)
    await expect(wrapped.doGenerate(options())).rejects.toBe(failure)
    const first = await wrapped.doStream(options({ tools: [declare("shell")] }))
    expect(first.request).toEqual({ body: "kept" })
    const reader = first.stream.getReader()
    expect(await reader.read()).toMatchObject({ value: { toolName: "shell" } })
    await expect(reader.read()).rejects.toBe(failure)
    const second = await wrapped.doStream(options())
    await second.stream.cancel()
    expect(cancelled).toBe(true)
  })
})
