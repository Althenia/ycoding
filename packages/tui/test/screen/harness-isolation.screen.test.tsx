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
  const before = observed
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
      <ClipboardProvider
        value={{
          write: async (text) => {
            writes.push(text)
          },
        }}
      >
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
    expect(observed).toBe(before)
  } finally {
    app.renderer.destroy()
    events.disconnect()
  }
}, 30000)
