import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

// Run the listener under real Node, where Bun globals do not exist.
test("Node MCP listener streams, aborts disconnected requests, and closes SSE on shutdown", () => {
  const result = spawnSync(
    process.env.NODE_BIN ?? "node",
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict"
    import { Effect } from "effect"
    import { serveTaskMcp } from "./src/task-mcp-http.ts"
    assert.equal(typeof globalThis.Bun, "undefined")
    let pendingSignal, streamSignal, reader, pendingStarted
    const started = new Promise(resolve => { pendingStarted = resolve })
    const aborted = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => {
      signal.addEventListener("abort", resolve, { once: true })
    })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const address = yield* serveTaskMcp(0, async (request) => {
        if (request.url.endsWith("/pending")) {
          pendingSignal = request.signal
          pendingStarted()
          return new Promise(() => {})
        }
        streamSignal = request.signal
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode("data: ready\\n\\n"))
        } }), { headers: { "content-type": "text/event-stream" } })
      })
      assert.equal(address.hostname, "127.0.0.1")
      const url = "http://127.0.0.1:" + address.port
      yield* Effect.promise(async () => {
        const controller = new AbortController()
        const pending = fetch(url + "/pending", { signal: controller.signal }).catch(() => {})
        await started
        controller.abort()
        await pending
        await aborted(pendingSignal)
        const response = await fetch(url + "/mcp")
        assert.equal(response.headers.get("content-type"), "text/event-stream")
        reader = response.body.getReader()
        assert.equal(new TextDecoder().decode((await reader.read()).value), "data: ready\\n\\n")
        assert.equal(streamSignal.aborted, false)
        const disconnectedSignal = streamSignal
        await reader.cancel()
        await aborted(disconnectedSignal)
        const next = await fetch(url + "/mcp")
        reader = next.body.getReader()
        await reader.read()
        assert.equal(streamSignal.aborted, false)
      })
    })))
    assert.equal(streamSignal.aborted, true)
    await reader.read().catch(() => {})
  `,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 },
  )
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
})

test("Node MCP listener reads POST bodies and bounds chunked SDK requests", () => {
  const result = spawnSync(
    process.env.NODE_BIN ?? "node",
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict"
    import { createRequire } from "node:module"
    import { Effect } from "effect"
    import { serveTaskMcp } from "./src/task-mcp-http.ts"
    const require = createRequire(new URL("../core/package.json", import.meta.url))
    const { createMcpHandler, Server } = await import(require.resolve("@modelcontextprotocol/server"))
    const sdk = createMcpHandler(() => new Server({ name: "test", version: "1" }), { maxRequestBodySize: 128 * 1024 })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const address = yield* serveTaskMcp(0, async (request) => {
        if (request.url.endsWith("/echo")) return new Response(await request.text())
        if (request.url.endsWith("/denied")) return new Response("Denied", { status: 401 })
        return sdk.fetch(request)
      })
      yield* Effect.promise(async () => {
        const url = "http://127.0.0.1:" + address.port
        assert.equal(await (await fetch(url + "/echo", { method: "POST", body: "hello" })).text(), "hello")
        const denied = await fetch(url + "/denied", { method: "POST", body: "ignored" })
        assert.equal(denied.status, 401)
        assert.equal(await denied.text(), "Denied")
        const oversized = await fetch(url + "/mcp", {
          method: "POST", duplex: "half",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array(65536))
            controller.enqueue(new Uint8Array(65537))
            controller.close()
          } }),
        })
        assert.equal(oversized.status, 413)
        await oversized.text()
      })
    })))
    await sdk.close()
  `,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 },
  )
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
})
