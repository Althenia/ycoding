/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { YCoding } from "@ycoding-ai/client"
import { Effect, Exit, Logger, Scope } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onMount } from "solid-js"
import { ServerProcess } from "../../server/src/process"
import { DialogSessionBrowser } from "../src/component/dialog-session-browser"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "../test/fixture/tui-environment"
import { createTuiResolvedConfig } from "../test/fixture/tui-runtime"

const auth = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`

test("rendered explicit Start and Stop cross the real Session API and isolated Chrome lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "ycoding-tui-isolated-browser-"))
  const home = join(root, "home")
  const directory = join(root, "workspace")
  const previousHome = process.env.HOME
  let fixture: ReturnType<typeof browserFixture> | undefined
  let server: Awaited<ReturnType<typeof startServer>> | undefined

  try {
    await Promise.all([mkdir(home, { recursive: true }), mkdir(directory, { recursive: true })])
    process.env.HOME = home
    const currentFixture = browserFixture()
    fixture = currentFixture
    server = await startServer({ directory, database: join(root, "ycoding.db") })
    const client = YCoding.make({ baseUrl: server.base, headers: { authorization: auth } })
    const sessionID = "ses_tui_isolated_integration"
    const session = await client.session.create({ id: sessionID, location: { directory } })
    let app: Awaited<ReturnType<typeof testRender>> | undefined

    try {
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
        throw new Error("Real isolated-browser integration requires macOS arm64 with installed Chrome 152")
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
      }
    }
  } finally {
    try {
      await server?.close()
    } finally {
      try {
        await fixture?.server.stop(true)
      } finally {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}, 90_000)

async function startServer(options: { readonly directory: string; readonly database: string }) {
  const port = await availablePort()
  const scope = await Effect.runPromise(Scope.make())
  const logger = Logger.map(Logger.formatStructured, () => {})
  const startingRaw = ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port,
    password: "test-password",
    database: { path: options.database },
    config: { directory: options.directory, project: false, content: "{}" },
    fs: { filewatcher: false, fff: false },
  }).pipe(Effect.provideService(Scope.Scope, scope))
  // Runtime-owned request markers are supplied when the assembled router dispatches.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
  await Effect.runPromise(starting.pipe(Effect.provide(Logger.layer([logger]))))
  let closed = false
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      if (closed) return
      closed = true
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}

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

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve isolated-browser test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
