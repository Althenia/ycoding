/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Pty } from "@ycoding-ai/schema/pty"
import { testRender } from "@opentui/solid"
import { Schema } from "effect"
import { onMount } from "solid-js"
import { DialogSessionTerminals } from "../src/component/dialog-session-terminals"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { RouteProvider, useRoute } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { createApi } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const sessionID = "ses_terminal_owner"
const location = { directory: "/tmp/ycoding", workspaceID: "workspace_terminal" }

test("picker lists only the active Session terminals and selection deliberately navigates", async () => {
  const requests: unknown[] = []
  const result = await renderPicker({
    list: async (input) => {
      requests.push(input)
      return {
        location: { directory: location.directory },
        data: [info("pty_owned", sessionID, "Owned terminal"), info("pty_foreign", "ses_foreign", "Foreign terminal")],
      }
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Owned terminal"))
    expect(result.app.captureCharFrame()).not.toContain("Foreign terminal")
    expect(requests).toEqual([
      { sessionID, location: { directory: location.directory, workspace: location.workspaceID } },
    ])

    result.app.mockInput.pressEnter()
    await result.app.waitForFrame((frame) => frame.includes("terminal-inspector:pty_owned"))
    expect(result.app.captureCharFrame()).toContain("terminal-inspector:pty_owned")
  } finally {
    result.app.renderer.destroy()
  }
})

test("picker renders a safe retryable list failure without leaking raw details", async () => {
  let attempts = 0
  const result = await renderPicker({
    list: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("private path /Users/example/secret and token=hidden")
      return { location: { directory: location.directory }, data: [info("pty_retry", sessionID, "Recovered terminal")] }
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Unable to load Session terminals"))
    const failed = result.app.captureCharFrame()
    expect(failed).toContain("Press r to retry")
    expect(failed).not.toContain("/Users/example")
    expect(failed).not.toContain("token=hidden")

    result.app.mockInput.pressKey("r")
    await result.app.waitForFrame((frame) => frame.includes("Recovered terminal"))
    expect(attempts).toBe(2)
  } finally {
    result.app.renderer.destroy()
  }
})

async function renderPicker(api: { list: (input: unknown) => Promise<unknown> }) {
  const fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === "/api/event")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      return Response.json(
        await api.list({
          sessionID: url.searchParams.get("sessionID"),
          location: {
            directory: url.searchParams.get("location[directory]"),
            workspace: url.searchParams.get("location[workspace]"),
          },
        }),
      )
    },
    { preconnect() {} },
  )

  function Fixture() {
    const dialog = useDialog()
    const route = useRoute()
    onMount(() => dialog.replace(() => <DialogSessionTerminals sessionID={sessionID} location={location} />))
    return (
      <text>
        {route.data.type}:{route.data.type === "terminal-inspector" ? route.data.ptyID : ""}
      </text>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={createApi(fetch)}>
                <ToastProvider>
                  <RouteProvider initialRoute={{ type: "session", sessionID }}>
                    <DialogProvider>
                      <Fixture />
                    </DialogProvider>
                  </RouteProvider>
                </ToastProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 35 },
  )
  app.renderer.start()
  return { app }
}

function info(id: string, owner: string, title: string) {
  return Schema.decodeUnknownSync(Pty.Info)({
    id,
    sessionID: owner,
    title,
    command: "/bin/sh",
    args: [],
    cwd: "/tmp",
    status: "running",
    pid: 42,
    generation: 1,
    size: { rows: 24, cols: 80 },
    control: { owner: "agent", fence: 1 },
    output: { startOffset: 0, endOffset: 0, truncated: false },
    limits: { maxRuntimeSeconds: 300, maxRetainedBytes: Pty.MAX_RETAINED_BYTES, maxInputBytes: Pty.MAX_INPUT_BYTES },
  } as unknown)
}
