import { deltaChunk, finishChunk } from "../../../ai/test/lib/openai-chunks"

export type ProviderFixture = {
  /** The assistant text the stand-in returns. */
  readonly text: string
  /**
   * Leaves requests after the specified count open, allowing goal synthesis and
   * its initial steer to settle before inspecting the admitted autonomous work.
   */
  readonly holdAfter?: number
  readonly settleDelayMs?: number
  /** Chat-completion frames for one request; may wait to order concurrent Sessions deterministically. */
  readonly reply?: (request: unknown) => readonly object[] | Promise<readonly object[]>
}

const providerID = "isolated-stand-in"
const modelID = "isolated-model"

/** Declares the loopback provider in the isolated config document, never in user config. */
export function providerConfig(standIn: { readonly url: string }) {
  return JSON.stringify({
    providers: {
      [providerID]: {
        package: "aisdk:@ai-sdk/openai-compatible",
        name: "Isolated stand-in",
        settings: { baseURL: `${standIn.url}/v1`, apiKey: "isolated-stand-in-key" },
        models: { [modelID]: { name: "Isolated Model" } },
      },
    },
  })
}

export async function startProviderStandIn(fixture: ProviderFixture) {
  const requests: unknown[] = []
  const held: Array<() => void> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      const body = await request.json()
      requests.push(body)
      const heldRequest = fixture.holdAfter !== undefined && requests.length > fixture.holdAfter
      const encoder = new TextEncoder()
      const frames = (await fixture.reply?.(body)) ?? [deltaChunk({ role: "assistant" }), deltaChunk({ content: fixture.text }), finishChunk("stop")]
      const stream = new ReadableStream({
        async start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          for (let remaining = fixture.settleDelayMs ?? 0; remaining > 0; remaining -= 4_000) {
            await Bun.sleep(Math.min(remaining, 4_000))
            controller.enqueue(encoder.encode(": keep-alive\n\n"))
          }
          if (heldRequest)
            await new Promise<void>((resolve) => {
              held.push(resolve)
            })
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    providerID,
    modelID,
    url: `http://127.0.0.1:${server.port}`,
    requests: () => requests,
    releaseAll: () => {
      for (const release of held.splice(0)) release()
    },
    close: async () => {
      for (const release of held.splice(0)) release()
      await server.stop(true)
    },
  }
}
