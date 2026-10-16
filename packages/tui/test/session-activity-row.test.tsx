/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, onMount, Show } from "solid-js"
import type { ToolLifecycleInput } from "../src/routes/session/activity-row"
import { SessionActivityRow, ToolLifecycleStatus } from "../src/routes/session/activity-row"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { registerYCodingSpinner } from "../src/component/register-spinner"
import { createApi, createEventStream, createFetch, json, sessionSnapshot } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const originalSetInterval = global.setInterval
const originalClearInterval = global.clearInterval
registerYCodingSpinner()
afterEach(() => {
  global.setInterval = originalSetInterval
  global.clearInterval = originalClearInterval
})

async function renderLifecycle(lifecycle: ReturnType<typeof createSignal<ToolLifecycleInput>>) {
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
  ])
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToolLifecycleStatus lifecycle={lifecycle[0]()} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 3 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(lifecycle[0]().status === "running" ? "running" : "pending"))
  return app
}

describe("session activity duration intervals", () => {
  test("self-stops a tool interval after completed, error, or cancelled lifecycle states", async () => {
    for (const terminal of [
      { status: "completed", time: { created: 0, ran: 0, completed: 1_000 } },
      { status: "error", time: { created: 0, ran: 0, completed: 1_000 } },
      { status: "completed", cancelled: true, time: { created: 0, ran: 0, completed: 1_000 } },
    ] as const) {
      const callbacks: Array<() => void> = []
      let clears = 0
      global.setInterval = ((callback: () => void) => {
        callbacks.push(callback)
        return callbacks.length as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval
      global.clearInterval = ((timer) => {
        if (typeof timer === "number" && timer > 0 && timer <= callbacks.length) clears += 1
        else Reflect.apply(originalClearInterval, global, [timer])
      }) as typeof clearInterval

      const lifecycle = createSignal<ToolLifecycleInput>({
        status: "running",
        time: { created: 0, ran: 0 },
      })
      const app = await renderLifecycle(lifecycle)
      expect(callbacks).toHaveLength(1)

      lifecycle[1](terminal)
      callbacks[0]?.()

      expect(clears).toBe(2)
      app.renderer.destroy()
    }
  })

  test("updates active tool durations once per second", async () => {
    let interval: number | undefined
    global.setInterval = ((_: () => void, milliseconds?: number) => {
      interval = milliseconds
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval

    const app = await renderLifecycle(createSignal<ToolLifecycleInput>({ status: "running", time: { created: 0, ran: 0 } }))

    expect(interval).toBe(1_000)
    app.renderer.destroy()
  })

  test("self-stops a subagent interval when its durable task completes", async () => {
    const callbacks: Array<() => void> = []
    let clears = 0
    global.setInterval = ((callback: () => void) => {
      callbacks.push(callback)
      return callbacks.length as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    global.clearInterval = ((timer) => {
      if (typeof timer === "number" && timer > 0 && timer <= callbacks.length) clears += 1
      else Reflect.apply(originalClearInterval, global, [timer])
    }) as typeof clearInterval

    const task = {
      sessionID: "child", parentID: "parent", description: "Review", agent: "build",
      background: true, state: "running", revision: 1, time: { created: 0, updated: 1_000 },
    }
    const events = createEventStream()
    const calls = createFetch((url) => {
      if (url.pathname === "/api/session/child/snapshot")
        return sessionSnapshot("child", [], { session: { parentID: "parent" } })
      if (url.pathname === "/api/session/parent/subagent")
        return json({ data: [task], summary: { total: 1, active: task.state === "running" ? 1 : 0, running: task.state === "running" ? 1 : 0, waiting: 0 }, cursor: {} })
      return undefined
    }, events)
    let data!: ReturnType<typeof useData>
    function Fixture() {
      data = useData()
      const [ready, setReady] = createSignal(false)
      onMount(() => {
        void Promise.all([data.session.message.sync("child"), data.session.subagent.sync("parent")]).then(() => setReady(true))
      })
      return <Show when={ready()}><SessionActivityRow row={{ type: "subagent", sessionID: "child", agent: "Build", created: 0 }} /></Show>
    }
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(calls.fetch)}><DataProvider><Fixture /></DataProvider></ClientProvider>
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 3 },
    )
    try {
      app.renderer.start()
      await app.waitForFrame((frame) => frame.includes("running"))
      expect(callbacks).toHaveLength(1)

      task.state = "completed"
      data.session.subagent.invalidate("parent")
      await data.session.subagent.sync("parent")
      await app.waitForFrame((frame) => frame.includes("completed 1s"))
      const terminalFrame = app.captureCharFrame()
      callbacks[0]?.()

      expect(clears).toBe(2)
      expect(app.captureCharFrame()).toBe(terminalFrame)
    } finally {
      app.renderer.destroy()
      events.disconnect()
    }
  })
})
