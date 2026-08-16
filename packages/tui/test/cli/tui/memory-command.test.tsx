/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Accessor } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap, type KeymapCommand } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { SessionMemoryCommand } from "../../../src/routes/session"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, directory } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const sessionID = "ses_memory_command"

test("mounted production session.memory command computes lazily, refreshes, renders labels, and closes", async () => {
  const events = createEventStream()
  const calls = createFetch(undefined, events)
  let commands!: Accessor<readonly KeymapCommand[]>
  let data!: ReturnType<typeof useData>

  function Fixture() {
    commands = Keymap.useCommands()
    data = useData()
    return <SessionMemoryCommand sessionID={sessionID} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(calls.fetch)}>
                <DataProvider>
                  <ToastProvider>
                    <DialogProvider>
                      <Fixture />
                    </DialogProvider>
                  </ToastProvider>
                </DataProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitFor(() => commands().some((command) => command.id === "session.memory"))
    expect(app.captureCharFrame()).not.toContain("Estimated resident payload")
    commands().find((command) => command.id === "session.memory")!.run()
    await app.waitForFrame(
      (frame) =>
        frame.includes("Global process metrics (direct)") &&
        frame.includes("Estimated resident payload (approximate)") &&
        frame.includes("Hot messages 0"),
    )
    events.emit({
      id: "evt_memory_refresh",
      created: 1,
      type: "session.agent.selected",
      location: { directory },
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID, agent: "review" },
    })
    await app.waitFor(() => data.session.message.hot(sessionID).length === 1)
    expect(app.captureCharFrame()).toContain("Hot messages 0")
    app.mockInput.pressKey("r")
    await app.waitForFrame((frame) => frame.includes("Hot messages 1"))
    app.mockInput.pressKey("q")
    await app.waitForFrame((frame) => !frame.includes("Estimated resident payload"))
  } finally {
    app.renderer.destroy()
  }
})
