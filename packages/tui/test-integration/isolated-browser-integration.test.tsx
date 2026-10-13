/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { YCoding } from "@ycoding-ai/client/v5"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onMount } from "solid-js"
import { DialogSessionBrowser } from "../src/component/dialog-session-browser"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "../test/fixture/tui-environment"
import { createTuiResolvedConfig } from "../test/fixture/tui-runtime"

test("rendered explicit Start and Stop cross the real Session API and isolated Chrome lifecycle", async () => {
  const url = process.env.YCODING_V5_TEST_URL
  if (!url)
    throw new Error(
      "YCODING_V5_TEST_URL must name a disposable Rust runtime with ready Core and isolated-browser services",
    )
  const root = await mkdtemp(join(tmpdir(), "ycoding-tui-isolated-browser-"))
  const home = join(root, "home")
  const directory = join(root, "workspace")
  const previousHome = process.env.HOME
  let fixture: ReturnType<typeof browserFixture> | undefined

  try {
    await Promise.all([mkdir(home, { recursive: true }), mkdir(directory, { recursive: true })])
    process.env.HOME = home
    const currentFixture = browserFixture()
    fixture = currentFixture
    const password = process.env.YCODING_V5_TEST_PASSWORD
    const client = YCoding.make({
      endpoint: { url, ...(password ? { auth: { type: "basic", username: "ycoding", password } } : {}) },
      location: { directory },
    })
    const sessionID = "ses_tui_isolated_integration"
    let app: Awaited<ReturnType<typeof testRender>> | undefined

    try {
      const session = await client.session.create({ id: sessionID, location: { directory } })
      function Fixture() {
        const dialog = useDialog()
        onMount(() => dialog.replace(() => <DialogSessionBrowser sessionID={sessionID} location={session.location} />))
        return null
      }

      app = await testRender(
        () => (
          <TestTuiContexts
            cwd={directory}
            directory={directory}
            paths={{ home, state: join(root, "state"), worktree: directory }}
          >
            <ConfigProvider config={createTuiResolvedConfig()}>
              <Keymap.Provider>
                <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                  <ClientProvider api={client}>
                    <ToastProvider>
                      <DialogProvider>
                        <Fixture />
                      </DialogProvider>
                    </ToastProvider>
                  </ClientProvider>
                </ThemeProvider>
              </Keymap.Provider>
            </ConfigProvider>
          </TestTuiContexts>
        ),
        { width: 74, height: 24, kittyKeyboard: true },
      )
      app.renderer.start()

      const initial = await client.isolatedBrowser.status({ sessionID })
      if (!supportedHost()) {
        expect(initial.state).toBe("unavailable")
        expect(initial.reason).toBeTruthy()
        await app.waitForFrame((frame) => frame.includes("Unavailable"))
        expect(app.captureCharFrame()).not.toContain("Ready")
        throw new Error("Real isolated-browser integration requires macOS arm64 with installed Chrome 152 or newer")
      }

      expect(initial).toEqual({ mode: "isolated", state: "stopped" })
      await app.waitForFrame((frame) => frame.includes("Stopped") && frame.includes("s start"))
      app.mockInput.pressKey("s")
      await app.waitForFrame((frame) => frame.includes("Start isolated browser"))
      await app.mockInput.typeText(currentFixture.url)
      app.mockInput.pressEnter()
      await app.waitForFrame(
        (frame) => frame.includes("Ready") && frame.includes(`127.0.0.1:${currentFixture.server.port}/fixture`),
        { maxPasses: 2_000 },
      )
      expect(currentFixture.loads()).toBeGreaterThan(0)
      expect(await client.isolatedBrowser.status({ sessionID })).toMatchObject({
        mode: "isolated",
        state: "ready",
        tab: { sessionID, page: { origin: `http://127.0.0.1:${currentFixture.server.port}`, path: "/fixture" } },
      })

      app.mockInput.pressKey("x")
      await app.waitForFrame((frame) => frame.includes("Stopped") && frame.includes("s start"), {
        maxPasses: 1_000,
      })
      expect(await client.isolatedBrowser.status({ sessionID })).toEqual({ mode: "isolated", state: "stopped" })
    } finally {
      try {
        app?.renderer.destroy()
      } finally {
        await client.isolatedBrowser.stop({ sessionID }).catch(() => {})
        client.transport.close()
      }
    }
  } finally {
    try {
      await fixture?.server.stop(true)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  }
}, 90_000)

function browserFixture() {
  let loads = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/fixture") return new Response(null, { status: 204 })
      loads++
      return new Response("<!doctype html><title>YCoding isolated browser integration</title><main>ready</main>", {
        headers: { "content-type": "text/html" },
      })
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/fixture`,
    loads: () => loads,
  }
}

function supportedHost() {
  return process.platform === "darwin" && process.arch === "arm64"
}
