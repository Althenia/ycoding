import { expect, test } from "bun:test"
import { Effect } from "effect"
import { DotsPubSub } from "@ycoding-ai/core/dots/pubsub"
import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"

test("Dots pubsub uses the shared Codex handshake identity without forwarding account credentials", async () => {
  const opened: Array<{ url: string; headers: Record<string, string> | undefined }> = []
  const sent: string[] = []
  let closed = false
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const pubsub = DotsPubSub.make({
      http: { json: (credentials, request) => Effect.sync(() => {
        expect(credentials).toEqual({ access: "synthetic-token", accountID: "synthetic-account" })
        expect(request).toEqual({ method: "GET", path: "/celsius/ws/user" })
        return { websocket_url: "wss://pubsub.example.invalid/socket" }
      }) },
      open: (url, headers) => {
        opened.push({ url, headers })
        return {
          readyState: 1,
          addEventListener: () => {},
          removeEventListener: () => {},
          send: (value) => { sent.push(value) },
          close: () => { closed = true },
        }
      },
    })
    yield* pubsub.connect({ access: "synthetic-token", accountID: "synthetic-account" })
    expect(opened).toEqual([{ url: "wss://pubsub.example.invalid/socket", headers: OpenAICodex.headers() }])
    expect(JSON.stringify(opened)).not.toContain("synthetic-token")
    expect(JSON.stringify(opened)).not.toContain("synthetic-account")
    expect(sent).toHaveLength(1)
  })))
  expect(closed).toBe(true)
})
