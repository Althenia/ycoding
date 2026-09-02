/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createSignal } from "solid-js"
import type { ToolLifecycleInput } from "../src/routes/session/activity-row"
import { registerYCodingSpinner } from "../src/component/register-spinner"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const originalSetInterval = global.setInterval
const originalClearInterval = global.clearInterval
registerYCodingSpinner()
const subagentTask = createSignal({
  sessionID: "child",
  state: "running",
  time: { updated: 1_000 },
})

mock.module("../src/context/data", () => ({
  useData: () => ({
    session: {
      get: (sessionID: string) => sessionID === "child" ? { parentID: "parent", time: { updated: 1_000 } } : undefined,
      subagent: {
        page: (sessionID: string) => sessionID === "parent" ? { data: [subagentTask[0]()] } : undefined,
      },
      status: () => undefined,
    },
  }),
}))

const { SessionActivityRow, ToolLifecycleStatus } = await import("../src/routes/session/activity-row")

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
      global.clearInterval = (() => {
        clears += 1
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
    global.clearInterval = (() => {
      clears += 1
    }) as typeof clearInterval

    subagentTask[1]({ sessionID: "child", state: "running", time: { updated: 1_000 } })
    const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
      import("../src/config"),
      import("../src/context/theme"),
    ])
    const app = await testRender(
      () => (
        <TestTuiContexts>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <SessionActivityRow row={{ type: "subagent", sessionID: "child", agent: "Build", created: 0 }} />
            </ThemeProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 80, height: 3 },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("running"))
    expect(callbacks).toHaveLength(1)

    subagentTask[1]({ sessionID: "child", state: "completed", time: { updated: 1_000 } })
    await app.waitForFrame((frame) => frame.includes("completed 1s"))
    const terminalFrame = app.captureCharFrame()
    callbacks[0]?.()

    expect(clears).toBe(2)
    expect(app.captureCharFrame()).toBe(terminalFrame)
    app.renderer.destroy()
  })
})
