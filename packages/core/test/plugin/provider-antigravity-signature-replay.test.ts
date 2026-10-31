import { describe, expect, test } from "bun:test"
import { LLM, LLMEvent, Message, ToolDefinition } from "@ycoding-ai/ai"
import type { LLMResponse } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { Agent } from "@ycoding-ai/core/agent"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { EventRuntime } from "@ycoding-ai/core/event"
import { CatalogModel } from "@ycoding-ai/core/model"
import { captureToolSchemas, createAntigravityFetch } from "@ycoding-ai/core/plugin/provider/antigravity"
import { Provider } from "@ycoding-ai/core/provider"
import { Session } from "@ycoding-ai/core/session"
import { createLLMEventPublisher } from "@ycoding-ai/core/session/runner/publish-llm-event"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Effect, Layer } from "effect"

const client = LLMClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected native transport") }),
    ),
  ),
)

type Chunk = Record<string, unknown>
type WirePart = Record<string, unknown>
type WireContent = { role: string; parts: WirePart[] }

const claude = "claude-sonnet-5-5"
const gemini = "gemini-3.8-flash"
const reply = (parts: Chunk[], finish = true): Chunk => ({
  candidates: [{ content: { role: "model", parts }, ...(finish ? { finishReason: "STOP" } : {}) }],
})
const thought = (text: string, thoughtSignature?: string): Chunk => ({
  text,
  thought: true,
  ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
})
const signatureOnly = (thoughtSignature: string): Chunk => ({ text: "", thought: true, thoughtSignature })
const okReply = reply([{ text: "ok" }])
const lookup = ToolDefinition.make({
  name: "lookup",
  description: "Look up a fixture",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
})

const delivered = (chunks: readonly Chunk[], split: boolean) => {
  const encode = (chunk: Chunk) => new TextEncoder().encode(`data: ${JSON.stringify({ response: chunk })}\n\n`)
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (split) for (const chunk of chunks) controller.enqueue(encode(chunk))
        else controller.enqueue(new Uint8Array(chunks.flatMap((chunk) => [...encode(chunk)])))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function gateway(modelID: string, replies: readonly (readonly Chunk[])[], split = false) {
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
  const sent: { model: string; request: { contents: WireContent[] } }[] = []
  const sdk = createGoogleGenerativeAI({
    apiKey: "placeholder",
    fetch: Object.assign(
      createAntigravityFetch(
        async (_input, init) => {
          sent.push(JSON.parse(String(init?.body)))
          return delivered(replies[sent.length - 1] ?? [okReply], split)
        },
        { access: "google-access", project: "project-1" },
      ),
      { preconnect: fetch.preconnect },
    ),
  })
  const info = CatalogModel.Info.make({
    ...CatalogModel.Info.empty(Provider.ID.make("antigravity"), CatalogModel.ID.make(modelID)),
    package: Provider.aisdk("@ai-sdk/google"),
  })
  const generate = (messages: (response: LLMResponse | undefined) => Message[], previous?: LLMResponse) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const aisdk = yield* AISDK.Service
        yield* aisdk.hook.sdk((event) => {
          event.sdk = sdk
        })
        yield* aisdk.hook.language((event) => {
          event.language = captureToolSchemas(event.sdk.languageModel(modelID))
        })
        const model = yield* SessionRunnerModel.fromCatalogModel(info, undefined, { loadAISDK: aisdk.model })
        return yield* LLMClient.generate(LLM.request({ model, messages: messages(previous), tools: [lookup] }))
      }).pipe(Effect.scoped, Effect.provide(AISDK.locationLayer), Effect.provide(client)),
    )
  return { sent, generate }
}

async function twoTurns(modelID: string, first: readonly Chunk[], split = false) {
  const { sent, generate } = await gateway(modelID, [first, [okReply]], split)
  const response = await generate(() => [Message.user("Start")])
  await generate((previous) => {
    const call = previous!.toolCalls[0]
    return [
      Message.user("Start"),
      previous!.message,
      call
        ? Message.tool({ id: call.id, name: call.name, result: { type: "text", value: "found" } })
        : Message.user("Continue"),
    ]
  }, response)
  expect(sent).toHaveLength(2)
  return { response, replayed: sent[1]!.request.contents.find((content) => content.role === "model")?.parts }
}

async function replayHistory(modelID: string, assistant: Message["content"]) {
  const { sent, generate } = await gateway(modelID, [[okReply]])
  await generate(() => [Message.user("Start"), Message.assistant(assistant), Message.user("Next")])
  return sent[0]!.request.contents
}

describe("Antigravity thinking signature replay", () => {
  for (const split of [false, true]) {
    const mode = split ? "event-by-event delivery" : "single-chunk delivery"

    test(`a signature-only thought event signs the replayed thinking block (${mode})`, async () => {
      const { response, replayed } = await twoTurns(
        claude,
        [
          reply([thought("Let me ")], false),
          reply([thought("think")], false),
          reply([signatureOnly("sig-1")], false),
          reply([{ text: "Answer" }]),
        ],
        split,
      )
      expect(response.message.content[0]).toMatchObject({
        type: "reasoning",
        text: "Let me think",
        providerMetadata: { google: { thoughtSignature: "sig-1" } },
      })
      expect(replayed).toEqual([{ text: "Let me think", thought: true, thoughtSignature: "sig-1" }, { text: "Answer" }])
    })

    test(`a signature-only part in the same gateway event signs the thinking block (${mode})`, async () => {
      const { replayed } = await twoTurns(
        claude,
        [reply([thought("Plan"), signatureOnly("sig-2"), { text: "Answer" }])],
        split,
      )
      expect(replayed).toEqual([{ text: "Plan", thought: true, thoughtSignature: "sig-2" }, { text: "Answer" }])
    })

    test(`an unflagged empty signature part after thinking signs the thinking block (${mode})`, async () => {
      const { replayed } = await twoTurns(
        claude,
        [
          reply([thought("Plan")], false),
          reply([{ text: "", thoughtSignature: "sig-3" }], false),
          reply([{ text: "Answer" }]),
        ],
        split,
      )
      expect(replayed).toEqual([{ text: "Plan", thought: true, thoughtSignature: "sig-3" }, { text: "Answer" }])
    })

    test(`thinking, tool call, and tool result replay with each block's own signature (${mode})`, async () => {
      const { replayed } = await twoTurns(
        claude,
        [
          reply([thought("Need data")], false),
          reply([signatureOnly("sig-think")], false),
          reply([{ functionCall: { name: "lookup", args: { query: "fixture" } }, thoughtSignature: "sig-call" }]),
        ],
        split,
      )
      expect(replayed).toHaveLength(2)
      expect(replayed?.[0]).toEqual({ text: "Need data", thought: true, thoughtSignature: "sig-think" })
      expect(replayed?.[1]).toMatchObject({
        functionCall: { name: "lookup", args: { query: "fixture" } },
        thoughtSignature: "sig-call",
      })
    })

    test(`consecutive thinking blocks keep their own signatures (${mode})`, async () => {
      const { replayed } = await twoTurns(
        claude,
        [
          reply([thought("First")], false),
          reply([signatureOnly("sig-a")], false),
          reply([{ text: "Between" }], false),
          reply([thought("Second")], false),
          reply([signatureOnly("sig-b")], false),
          reply([{ text: "After" }]),
        ],
        split,
      )
      expect(replayed).toEqual([
        { text: "First", thought: true, thoughtSignature: "sig-a" },
        { text: "Between" },
        { text: "Second", thought: true, thoughtSignature: "sig-b" },
        { text: "After" },
      ])
    })
  }

  test("a signature-only thought part that omits the empty text field signs the thinking block", async () => {
    const { replayed } = await twoTurns(claude, [
      reply([thought("Plan")], false),
      reply([{ thought: true, thoughtSignature: "sig-absent" }], false),
      reply([{ text: "Answer" }]),
    ])
    expect(replayed).toEqual([{ text: "Plan", thought: true, thoughtSignature: "sig-absent" }, { text: "Answer" }])
  })

  test("a tool call signature never moves onto the thinking block before it", async () => {
    const { replayed } = await twoTurns(gemini, [
      reply([thought("Plan")], false),
      reply([{ functionCall: { name: "lookup", args: { query: "fixture" } }, thoughtSignature: "sig-call" }]),
    ])
    expect(replayed?.[0]).toEqual({ text: "Plan", thought: true })
    expect(replayed?.[1]).toMatchObject({ functionCall: { name: "lookup" }, thoughtSignature: "sig-call" })
  })

  test("an inline thinking signature is preserved unchanged", async () => {
    const { replayed } = await twoTurns(claude, [reply([thought("Plan", "sig-inline"), { text: "Answer" }])])
    expect(replayed).toEqual([{ text: "Plan", thought: true, thoughtSignature: "sig-inline" }, { text: "Answer" }])
  })

  test("a signature-only part after answer text never moves onto the earlier thinking block", async () => {
    const { replayed } = await twoTurns(gemini, [
      reply([thought("Plan")], false),
      reply([{ text: "Answer" }], false),
      reply([{ text: "", thoughtSignature: "sig-text" }]),
    ])
    expect(replayed).toEqual([{ text: "Plan", thought: true }, { text: "Answer" }])
  })

  test("a signature with no preceding thinking, and an empty signature, create no signature", async () => {
    const orphan = await twoTurns(gemini, [reply([signatureOnly("sig-orphan"), { text: "Answer" }])])
    expect(JSON.stringify(orphan.replayed)).not.toContain("sig-orphan")
    const empty = await twoTurns(gemini, [
      reply([thought("Plan")], false),
      reply([signatureOnly("")], false),
      reply([{ text: "Answer" }]),
    ])
    expect(empty.replayed).toEqual([{ text: "Plan", thought: true }, { text: "Answer" }])
  })

  test("thinking that ends the stream without a signature is delivered before the stream finishes", async () => {
    const { response } = await twoTurns(gemini, [reply([thought("Plan")])])
    const events = response.events
    expect(
      events
        .filter(LLMEvent.is.reasoningDelta)
        .map((event) => event.text)
        .join(""),
    ).toBe("Plan")
    expect(events.findIndex(LLMEvent.is.reasoningEnd)).toBeLessThan(events.findIndex(LLMEvent.is.finish))
  })

  describe("gateway stream after unfinished thinking", () => {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse"
    const thinking = `data: ${JSON.stringify({ response: reply([thought("Plan")], false) })}\n\n`
    const wrapped = (source: ReadableStream<Uint8Array>) =>
      createAntigravityFetch(async () => new Response(source, { headers: { "content-type": "text/event-stream" } }), {
        access: "google-access",
        project: "project-1",
      })(url, { method: "POST", body: "{}" })

    const within = async <A>(promise: Promise<A>) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Timed out waiting for the gateway stream")), 5000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    const readUntil = async (reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">, needle: string) => {
      let text = ""
      while (!text.includes(needle)) {
        const next = await within(reader.read())
        if (next.done) break
        text += new TextDecoder().decode(next.value)
      }
      return text
    }
    const encode = (text: string) => new TextEncoder().encode(text)
    const dataFrame = (response: Chunk) => `data: ${JSON.stringify({ response })}\n\n`

    test("a gateway error event is delivered, after the thinking before it, while the stream is still open", async () => {
      const upstream = Promise.withResolvers<void>()
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode(`${thinking}event: error\ndata: {"error":{"message":"synthetic failure"}}\n\n`))
        },
        cancel() {
          upstream.resolve()
        },
      })
      const reader = (await wrapped(source)).body!.getReader()
      try {
        const text = await readUntil(reader, "synthetic failure")
        expect(text).toContain("synthetic failure")
        expect(text.indexOf("Plan")).toBeGreaterThanOrEqual(0)
        expect(text.indexOf("Plan")).toBeLessThan(text.indexOf("synthetic failure"))
      } finally {
        await reader.cancel()
      }
      await within(upstream.promise)
    })

    for (const [name, control] of [
      ["metadata", dataFrame({ usageMetadata: { promptTokenCount: 1 } })],
      ["retry", "retry: 500\n\n"],
      ["error", 'event: error\ndata: {"error":{"message":"synthetic failure"}}\n\n'],
      ["completion sentinel", "data: [DONE]\n\n"],
      ["malformed data", "data: {broken\n\n"],
    ] as const) {
      test(`a ${name} frame between thinking and a signature-only part keeps the signature off the thinking, in order`, async () => {
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encode(`${thinking}${control}${dataFrame(reply([signatureOnly("sig-late")], false))}`))
            controller.close()
          },
        })
        const text = await (await wrapped(source)).text()
        const frames = text.split("\n\n").filter((frame) => frame !== "")
        const plan = frames.findIndex((frame) => frame.includes("Plan"))
        const late = frames.findIndex((frame) => frame.includes("sig-late"))
        expect(plan).toBe(0)
        expect(late).toBe(frames.length - 1)
        expect(frames[plan]).not.toContain("sig-late")
        expect(frames[plan]).not.toContain("thoughtSignature")
        expect(frames.slice(1, late)).toHaveLength(1)
      })
    }

    test("end of stream releases the held thinking before later gateway frames, in order", async () => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode(`${thinking}data: [DONE]\n\n`))
          controller.close()
        },
      })
      const text = await (await wrapped(source)).text()
      expect(text.indexOf("Plan")).toBeGreaterThanOrEqual(0)
      expect(text.indexOf("Plan")).toBeLessThan(text.indexOf("[DONE]"))
    })
  })

  test("the runtime publisher stores the signature for the thinking block", async () => {
    const { response } = await twoTurns(claude, [
      reply([thought("Plan")], false),
      reply([signatureOnly("sig-runtime")], false),
      reply([{ text: "Answer" }]),
    ])
    const published: { type: string; data: Record<string, unknown> }[] = []
    const events: Pick<EventRuntime.Interface, "publish"> = {
      publish: (definition, data) =>
        Effect.gen(function* () {
          const event = { id: EventRuntime.ID.create(), type: definition.type, data } as EventRuntime.Payload<
            typeof definition
          >
          published.push({ type: definition.type, data: data as Record<string, unknown> })
          yield* publisher.observe(event)
          return event
        }),
    }
    const publisher = createLLMEventPublisher(events, {
      sessionID: Session.ID.make("ses_signature_replay"),
      agent: Agent.ID.make("build"),
      model: { id: CatalogModel.ID.make(claude), providerID: Provider.ID.make("antigravity") },
      providerMetadataKey: "google",
    })
    for (const event of response.events.filter((item) => item.type.startsWith("reasoning-")))
      await Effect.runPromise(publisher.publish(event))
    expect(published.find((event) => event.type === "session.reasoning.ended")?.data).toMatchObject({
      text: "Plan",
      state: { thoughtSignature: "sig-runtime" },
    })
  })

  describe("Claude requests omit only unsigned thinking from replayed history", () => {
    const signed = {
      type: "reasoning" as const,
      text: "Signed",
      providerMetadata: { google: { thoughtSignature: "sig-kept" } },
    }
    const unsigned = { type: "reasoning" as const, text: "Unsigned" }
    const earlier = { type: "text" as const, text: "Earlier answer" }

    test("unsigned thinking is omitted and signed thinking is kept", async () => {
      const contents = await replayHistory(claude, [unsigned, signed, earlier])
      expect(contents[1]).toEqual({
        role: "model",
        parts: [{ text: "Signed", thought: true, thoughtSignature: "sig-kept" }, { text: "Earlier answer" }],
      })
    })

    test("an assistant turn holding only unsigned thinking is removed from the request", async () => {
      const contents = await replayHistory(claude, [unsigned])
      expect(contents.map((content) => content.role)).toEqual(["user", "user"])
    })

    test("non-Claude models keep unsigned thinking", async () => {
      const contents = await replayHistory(gemini, [unsigned, earlier])
      expect(contents[1]?.parts).toEqual([{ text: "Unsigned", thought: true }, { text: "Earlier answer" }])
    })
  })
})
