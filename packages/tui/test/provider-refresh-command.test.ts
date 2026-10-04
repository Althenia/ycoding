import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Global } from "@ycoding-ai/core/global"
import { createEventStream, createFetch, directory } from "./fixture/tui-client"

test("the command palette refreshes models and providers for the current location", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    if (title === "YCoding") started()
    setTitle(title)
  }
  const refreshes: string[] = []
  const requests: string[] = []
  const events = createEventStream()
  const calls = createFetch((url, request) => {
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname !== "/api/provider/refresh" || request.method !== "POST") return undefined
    refreshes.push(url.searchParams.get("location[directory]") ?? "")
    return new Response(null, { status: 204 })
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const waitForFrame = async (text: string) => {
    const deadline = Date.now() + 10_000
    while (!setup.captureCharFrame().includes(text) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(setup.captureCharFrame()).toContain(text)
  }

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        server: { endpoint: { url: server.url.toString() } },
        config: { get: async () => ({}), update: async () => ({}) },
        packages: { resolve: async () => undefined },
        args: {},
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )
    await ready
    await waitForFrame("Message YCoding…")

    setup.mockInput.pressKey("p", { ctrl: true })
    await waitForFrame("Commands")
    await setup.mockInput.typeText("Refresh models")
    await waitForFrame("Refresh models and providers")
    const before = requests.length
    setup.mockInput.pressEnter()

    await waitForFrame("Models and providers refreshed")
    expect(refreshes).toEqual([directory])
    const after = requests.slice(before)
    expect(after.indexOf("GET /api/model")).toBeGreaterThan(after.indexOf("POST /api/provider/refresh"))
    expect(after.indexOf("GET /api/provider")).toBeGreaterThan(after.indexOf("POST /api/provider/refresh"))

    setup.renderer.destroy()
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
    mock.restore()
  }
})
