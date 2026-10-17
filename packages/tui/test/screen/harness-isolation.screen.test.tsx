/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ClipboardProvider, useClipboard } from "../../src/context/clipboard"
import { ClientProvider } from "../../src/context/client"
import { DataProvider, useData } from "../../src/context/data"
import { createPluginRuntime } from "../../src/plugin/runtime"
import { createApi, createEventStream, createFetch } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { renderScreen } from "./harness"

test("disposing a screen releases plugin runtime, clipboard and DataProvider overrides", async () => {
  let observed = 0
  const injected: string[] = []
  const screen = await renderScreen({
    width: 100,
    height: 30,
    settle: "commands",
    clipboard: {
      write: async (text) => {
        injected.push(text)
      },
    },
    data: () => {
      observed++
    },
  })
  await screen.dispose()
  expect(observed).toBe(1)
  await assertFreshContexts(() => observed, injected)
}, 30000)

for (const destroyed of [false, true]) {
  test(`unsettled screen rejects with frame evidence and releases overrides when destroyed=${destroyed}`, async () => {
    const builtinModule = await import("../../src/plugin/builtins")
    const builtins = builtinModule.builtins
    const listeners = new Set(process.listeners("SIGHUP"))
    let observed = 0
    let cleanups = 0
    let destroyedAfterLanding = false
    const injected: string[] = []
    const outcome = await renderScreen({
      width: 100,
      height: 30,
      settlementTimeoutMS: 2_000,
      settle: destroyed
        ? function destroyAfterLanding(screen) {
            if (!screen.captureCharFrame().includes("Message YCoding")) return false
            destroyedAfterLanding = true
            process.emit("SIGHUP")
            return false
          }
        : "UNREACHABLE SETTLEMENT ANCHOR",
      clipboard: {
        write: async (text) => {
          injected.push(text)
        },
      },
      data: () => {
        observed++
      },
      builtins: [{
        id: "fixture.cleanup",
        setup: () => () => {
          cleanups++
        },
      }],
    }).then(
      (screen) => ({ status: "resolved" as const, screen }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    )
    try {
      expect(outcome.status).toBe("rejected")
      if (outcome.status !== "rejected") return
      expect(outcome.error).toBeInstanceOf(Error)
      if (!(outcome.error instanceof Error)) return
      expect(outcome.error.message).toContain(destroyed ? "destroyAfterLanding" : "UNREACHABLE SETTLEMENT ANCHOR")
      expect(outcome.error.message).toContain(`renderer destroyed: ${destroyed}`)
      expect(outcome.error.message).toContain("Final frame:")
      expect(outcome.error.message).toContain("Message YCoding")
      expect(destroyedAfterLanding).toBe(destroyed)
      expect(observed).toBe(1)
      expect(cleanups).toBe(1)
      expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
      const restored = await import("../../src/plugin/builtins")
      expect(restored.builtins).toBe(builtins)
      await assertFreshContexts(() => observed, injected)
    } finally {
      if (outcome.status === "resolved") await outcome.screen.dispose()
    }
  }, 15000)
}

async function assertFreshContexts(observed: () => number, injected: string[]) {
  const before = observed()
  const first = createPluginRuntime()
  first.update({
    status: [{ id: "fixture", source: "file", spec: "fixture", target: "fixture", enabled: true, active: true }],
  })
  expect(createPluginRuntime().status()).toEqual([])
  const writes: string[] = []
  const events = createEventStream()
  const calls = createFetch(() => undefined, events)
  const ready = Promise.withResolvers<void>()
  function Probe() {
    useData()
    const clipboard = useClipboard()
    onMount(() => {
      void clipboard.write?.("fresh context").then(() => ready.resolve())
    })
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <ClipboardProvider value={{
        write: async (text) => {
          writes.push(text)
        },
      }}>
        <ClientProvider api={createApi(calls.fetch)}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ClientProvider>
      </ClipboardProvider>
    </TestTuiContexts>
  ))
  try {
    await ready.promise
    expect(writes).toEqual(["fresh context"])
    expect(injected).toEqual([])
    expect(observed()).toBe(before)
  } finally {
    app.renderer.destroy()
    events.disconnect()
  }
}
