import { expect, spyOn, test } from "bun:test"
import { MCPOAuth } from "@ycoding-ai/core/mcp/oauth"

test.each(["transport", "body"] as const)(
  "should release a failed shared MCP OAuth exchange after a %s read failure",
  async (failure) => {
    let requests = 0
    let rejected = 0
    const error = new Error("Synthetic token-response failure")
    const payload = { access_token: "synthetic-access", token_type: "Bearer" }
    const spy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          requests++
          if (requests !== 1) return Response.json(payload)
          if (failure === "transport") throw error
          return new Response(new ReadableStream({ start: (controller) => controller.error(error) }))
        },
        { preconnect: () => undefined },
      ),
    )
    try {
      const fetcher = MCPOAuth.refreshFetch(() => rejected++)
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: `synthetic-refresh-${crypto.randomUUID()}`,
      })
      const send = () => fetcher(new URL("https://fixture.invalid/token"), { method: "POST", body })
      const failed = await Promise.allSettled([send(), send()])
      expect(requests).toBe(1)
      for (const result of failed) {
        expect(result.status).toBe("rejected")
        if (result.status === "rejected") expect(result.reason).toBe(error)
      }
      const recovered = await Promise.allSettled([send(), send()])
      expect(requests).toBe(2)
      for (const result of recovered) {
        expect(result.status).toBe("fulfilled")
        if (result.status === "fulfilled") expect(await result.value.json()).toEqual(payload)
      }
      expect(rejected).toBe(0)
    } finally {
      spy.mockRestore()
    }
  },
)
