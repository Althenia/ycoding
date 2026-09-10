/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { IsolatedBrowserStatus, YCodingClient } from "@ycoding-ai/client"
import { IsolatedBrowser } from "@ycoding-ai/schema/isolated-browser"
import { Schema } from "effect"
import { createSignal, onMount, type Accessor, type JSX } from "solid-js"
import { DialogSessionBrowser, SessionIsolatedBrowserCommand } from "../src/component/dialog-session-browser"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { Keymap, type KeymapCommand } from "../src/context/keymap"
import { ThemeProvider } from "../src/context/theme"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, type FetchHandler, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const first = {
  sessionID: "ses_isolated_first",
  location: { directory: "/tmp/isolated-first", workspaceID: "workspace_first" },
}
const second = {
  sessionID: "ses_isolated_second",
  location: { directory: "/tmp/isolated-second", workspaceID: "workspace_second" },
}
const stopped = status({ mode: "isolated", state: "stopped" })

test("production Session command is available and opens isolated browser for its current Session", async () => {
  let commands!: Accessor<readonly KeymapCommand[]>
  const requests: Request[] = []
  const result = await renderBrowser({
    command: true,
    fetch: (url, request) => {
      if (url.pathname !== `/api/session/${first.sessionID}/browser/isolated`) return undefined
      requests.push(request)
      return json({ data: stopped })
    },
    fixture: () => {
      commands = Keymap.useCommands()
      return <SessionIsolatedBrowserCommand sessionID={first.sessionID} location={first.location} />
    },
  })
  try {
    await result.app.waitFor(() => commands().some((command) => command.id === "session.browser.isolated"))
    expect(result.app.captureCharFrame()).not.toContain("Isolated browser")
    void commands()
      .find((command) => command.id === "session.browser.isolated")!
      .run()
    await result.app.waitForFrame((frame) => frame.includes("Isolated browser") && frame.includes("Stopped"))
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", `/api/session/${first.sessionID}/browser/isolated`],
    ])
  } finally {
    result.app.renderer.destroy()
  }
})

test("cancelling explicit Start submits no API call", async () => {
  const starts: unknown[] = []
  const api: BrowserApi = {
    status: async () => stopped,
    start: async (input) => {
      starts.push(input)
      return ready(first.sessionID)
    },
  }
  const cancelled = await renderBrowser({ api })
  try {
    await cancelled.app.waitForFrame((frame) => frame.includes("Stopped"))
    cancelled.app.mockInput.pressKey("s")
    await cancelled.app.waitForFrame(
      (frame) => frame.includes("Start isolated browser") && frame.includes("Do not sign in to"),
    )
    expect(cancelled.app.captureCharFrame()).toContain("esc")
    cancelled.app.mockInput.pressEscape()
    await cancelled.app.waitForFrame((frame) => !frame.includes("Start isolated browser"))
    expect(starts).toHaveLength(0)
  } finally {
    cancelled.app.renderer.destroy()
  }
})

test("explicit Start submits one credential-free URL and renders only origin and path", async () => {
  const starts: unknown[] = []
  let current: Status = stopped
  const started = await renderBrowser({
    api: {
      status: async () => current,
      start: async (input) => {
        starts.push(input)
        current = ready(first.sessionID, "https://example.com/docs/start")
        return current
      },
    },
  })
  try {
    await started.app.waitForFrame((frame) => frame.includes("Stopped"))
    started.app.mockInput.pressKey("s")
    await started.app.waitForFrame((frame) => frame.includes("Start isolated browser"))
    await Bun.sleep(10)
    await started.app.mockInput.typeText("https://example.com/docs/start?token=private#fragment")
    started.app.mockInput.pressEnter()
    await started.app.waitForFrame((frame) => frame.includes("example.com/docs/start"))
    expect(starts).toEqual([
      {
        ...scope(first),
        url: "https://example.com/docs/start?token=private#fragment",
      },
    ])
    expect(started.app.captureCharFrame()).not.toContain("token=private")
    expect(started.app.captureCharFrame()).not.toContain("fragment")
  } finally {
    started.app.renderer.destroy()
  }
})

test("Start rejects non-http and embedded-credential URLs before transport", async () => {
  let starts = 0
  const result = await renderBrowser({
    api: {
      status: async () => stopped,
      start: async () => {
        starts += 1
        return stopped
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Stopped"))
    result.app.mockInput.pressKey("s")
    await result.app.waitForFrame((frame) => frame.includes("Start isolated browser"))
    await Bun.sleep(10)
    await result.app.mockInput.typeText("https://person:password@example.com/private")
    result.app.mockInput.pressEnter()
    await result.app.waitForFrame((frame) => frame.includes("without embedded credentials"))
    expect(starts).toBe(0)
  } finally {
    result.app.renderer.destroy()
  }
})

test("pending controls suppress duplicate submissions and preserve stop during startup", async () => {
  const pauseGate = deferred<Status>()
  const startGate = deferred<Status>()
  let pauses = 0
  let starts = 0
  let stops = 0
  let current: Status = ready(first.sessionID)
  const result = await renderBrowser({
    api: {
      status: async () => current,
      control: async () => {
        pauses += 1
        current = await pauseGate.promise
        return current
      },
      start: async () => {
        starts += 1
        return startGate.promise
      },
      stop: async () => {
        stops += 1
        current = stopped
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Ready"))
    result.app.mockInput.pressKey("p")
    result.app.mockInput.pressKey("p")
    await result.app.waitForFrame((frame) => frame.includes("Pausing"))
    expect(pauses).toBe(1)
    pauseGate.resolve(paused(first.sessionID))
    await result.app.waitForFrame((frame) => frame.includes("Paused"))

    result.app.mockInput.pressKey("x")
    await result.app.waitForFrame((frame) => frame.includes("Stopped"))
    result.app.mockInput.pressKey("s")
    await result.app.waitForFrame((frame) => frame.includes("Start isolated browser"))
    await result.app.mockInput.typeText("http://localhost:8080/test")
    result.app.mockInput.pressEnter()
    await result.app.waitForFrame((frame) => frame.includes("Starting") && frame.includes("x stop"))
    result.app.mockInput.pressKey("x")
    result.app.mockInput.pressKey("x")
    await result.app.waitForFrame((frame) => frame.includes("Stopped"))
    expect(starts).toBe(1)
    expect(stops).toBe(2)
    startGate.resolve(ready(first.sessionID))
  } finally {
    result.app.renderer.destroy()
  }
})

test("ready, paused, stopped, unavailable, conflict, and safe failures render truthful controls", async () => {
  const statuses = [
    ready(first.sessionID, "https://example.com/account?secret=yes#private"),
    paused(first.sessionID),
    stopped,
    { mode: "isolated" as const, state: "unavailable" as const },
    { mode: "isolated" as const, state: "unavailable" as const, reason: "selected extension conflict /Users/me" },
  ]
  let attempt = 0
  const result = await renderBrowser({
    api: {
      status: async () => {
        const value = statuses[attempt++]
        if (value) return value
        throw new Error("token=secret at /Users/me/private")
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Ready") && frame.includes("example.com/account"))
    expect(result.app.captureCharFrame()).not.toContain("secret=yes")
    result.app.mockInput.pressKey("r")
    await result.app.waitForFrame((frame) => frame.includes("Paused") && frame.includes("p resume"))
    expect(result.app.captureCharFrame().replace(/\s+/g, " ")).toContain(
      "Pause blocks new actions; in-flight work and page scripts may continue. Stop to end the browser.",
    )
    result.app.mockInput.pressKey("r")
    await result.app.waitForFrame((frame) => frame.includes("Stopped") && frame.includes("s start"))
    result.app.mockInput.pressKey("r")
    await result.app.waitForFrame((frame) => frame.includes("Unavailable") && frame.includes("s start"))
    result.app.mockInput.pressKey("r")
    await result.app.waitForFrame(
      (frame) => frame.includes("Selected extension mode conflicts") && frame.includes("x stop"),
    )
    expect(result.app.captureCharFrame()).not.toContain("/Users/me")
    result.app.mockInput.pressKey("r")
    await result.app.waitForFrame((frame) => frame.includes("Unable to load isolated browser status"))
    const failed = result.app.captureCharFrame()
    expect(failed).toContain("r refresh")
    expect(failed).not.toContain("token=secret")
    expect(failed).not.toContain("/Users/me")
    expect(failed).not.toContain("example.com/account")
  } finally {
    result.app.renderer.destroy()
  }
})

test("unreported ready tab requires a fresh start and narrow view keeps safety notices visible", async () => {
  const result = await renderBrowser({
    viewport: { width: 42, height: 30 },
    api: {
      status: async () => status({ mode: "isolated", state: "ready", instanceID: "ibrowser_01test" }),
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("stale or") && frame.includes("does not stop it"))
    const frame = result.app.captureCharFrame()
    expect(frame).toContain("Temporary disposable Chrome")
    expect(frame).toContain("Stop and start fresh")
    expect(frame).toContain("x stop")
    expect(frame).not.toContain("p pause")
  } finally {
    result.app.renderer.destroy()
  }
})

test("pause, resume, and stop call only isolated lifecycle methods for the Session", async () => {
  const controls: unknown[] = []
  const stops: unknown[] = []
  const statuses = [ready(first.sessionID), stopped]
  const result = await renderBrowser({
    api: {
      status: async () => statuses.shift() ?? stopped,
      control: async (input) => {
        controls.push(input)
        return input.action === "pause" ? paused(first.sessionID) : ready(first.sessionID)
      },
      stop: async (input) => {
        stops.push(input)
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Ready"))
    result.app.mockInput.pressKey("p")
    await result.app.waitForFrame((frame) => frame.includes("Paused"))
    result.app.mockInput.pressKey("p")
    await result.app.waitForFrame((frame) => frame.includes("Ready"))
    result.app.mockInput.pressKey("x")
    await result.app.waitForFrame((frame) => frame.includes("Stopped"))
    expect(controls).toEqual([
      { ...scope(first), action: "pause" },
      { ...scope(first), action: "resume" },
    ])
    expect(stops).toEqual([scope(first)])
  } finally {
    result.app.renderer.destroy()
  }
})

test("reopen and Session change ignore stale responses and reject a foreign tab owner", async () => {
  const old = deferred<ReturnType<typeof ready>>()
  const requests: unknown[] = []
  const [owner, setOwner] = createSignal(first)
  const result = await renderBrowser({
    owner,
    api: {
      status: async (input) => {
        requests.push(input)
        if (requests.length === 1) return old.promise
        return ready(first.sessionID, "https://second.example/current")
      },
    },
  })
  try {
    await result.app.waitFor(() => requests.length === 1)
    setOwner(second)
    await result.app.waitForFrame((frame) => frame.includes("Browser state does not belong to this Session"))
    old.resolve(ready(first.sessionID, "https://stale.example/old"))
    await Bun.sleep(10)
    expect(result.app.captureCharFrame()).not.toContain("stale.example")
    expect(requests).toEqual([scope(first), scope(second)])

    result.app.mockInput.pressEscape()
    result.open()
    await result.app.waitForFrame((frame) => frame.includes("Browser state does not belong to this Session"))
    expect(requests).toHaveLength(3)
  } finally {
    result.app.renderer.destroy()
  }
})

test("conflict never invokes selected-extension operations or starts before isolated stop", async () => {
  let starts = 0
  let stops = 0
  const result = await renderBrowser({
    api: {
      status: async () => ({ mode: "isolated", state: "unavailable", reason: "selected-tab extension conflict" }),
      start: async () => {
        starts += 1
        return stopped
      },
      stop: async () => {
        stops += 1
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Selected extension mode conflicts"))
    result.app.mockInput.pressKey("s")
    await Bun.sleep(10)
    expect(result.app.captureCharFrame()).not.toContain("Start isolated browser")
    expect(starts).toBe(0)
    result.app.mockInput.pressKey("x")
    await result.app.waitForFrame((frame) => frame.includes("Unavailable"))
    expect(stops).toBe(1)
  } finally {
    result.app.renderer.destroy()
  }
})

test("lost start response refreshes authoritative status once without replaying start", async () => {
  let starts = 0
  let statuses = 0
  const result = await renderBrowser({
    api: {
      status: async () => {
        statuses += 1
        return statuses === 1 ? stopped : ready(first.sessionID, "https://reconciled.example/page")
      },
      start: async () => {
        starts += 1
        throw new Error("connection lost token=secret")
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Stopped"))
    result.app.mockInput.pressKey("s")
    await result.app.waitForFrame((frame) => frame.includes("Start isolated browser"))
    await result.app.mockInput.typeText("https://reconciled.example/page")
    result.app.mockInput.pressEnter()
    await result.app.waitForFrame(
      (frame) => frame.includes("Start result was uncertain") && frame.includes("reconciled.example/page"),
    )
    expect(starts).toBe(1)
    expect(statuses).toBe(2)
    expect(result.app.captureCharFrame()).not.toContain("token=secret")
  } finally {
    result.app.renderer.destroy()
  }
})

test("foreign tab state cannot dispatch controls through hidden keyboard bindings", async () => {
  let controls = 0
  const result = await renderBrowser({
    api: {
      status: async () => paused(second.sessionID),
      control: async () => {
        controls += 1
        return stopped
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Browser state does not belong"))
    result.app.mockInput.pressKey("p")
    await Bun.sleep(10)
    expect(controls).toBe(0)
    expect(result.app.captureCharFrame()).not.toContain("p resume")
  } finally {
    result.app.renderer.destroy()
  }
})

test("late control completion cannot overwrite another Session's status", async () => {
  const completion = deferred<Status>()
  const [owner, setOwner] = createSignal(first)
  let controlSignal: AbortSignal | undefined
  const result = await renderBrowser({
    owner,
    api: {
      status: async () =>
        ready(owner().sessionID, owner() === first ? "https://first.example/page" : "https://second.example/page"),
      control: async (_input, options) => {
        controlSignal = options?.signal
        return completion.promise
      },
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Ready"))
    result.app.mockInput.pressKey("p")
    await result.app.waitForFrame((frame) => frame.includes("Pausing"))
    setOwner(second)
    await result.app.waitForFrame((frame) => frame.includes("second.example/page") && frame.includes("Ready"))
    expect(controlSignal?.aborted).toBe(true)
    completion.resolve(stopped)
    await Bun.sleep(10)
    expect(result.app.captureCharFrame()).toContain("Ready")
    expect(result.app.captureCharFrame()).not.toContain("Stopped")
  } finally {
    result.app.renderer.destroy()
  }
})

type Status = IsolatedBrowserStatus

test("late startup-stop result cannot replace a reopened dialog", async () => {
  const startGate = deferred<Status>()
  const stopGate = deferred<void>()
  let statuses = 0
  const result = await renderBrowser({
    api: {
      status: async () => {
        statuses += 1
        return stopped
      },
      start: async () => startGate.promise,
      stop: async () => stopGate.promise,
    },
  })
  try {
    await result.app.waitForFrame((frame) => frame.includes("Stopped"))
    result.app.mockInput.pressKey("s")
    await result.app.waitForFrame((frame) => frame.includes("Start isolated browser"))
    await result.app.mockInput.typeText("http://localhost:8080/test")
    result.app.mockInput.pressEnter()
    await result.app.waitForFrame((frame) => frame.includes("x stop"))
    result.app.mockInput.pressKey("x")
    await result.app.waitForFrame((frame) => frame.includes("Stopping isolated browser"))
    result.open()
    await result.app.waitForFrame((frame) => frame.includes("Stopped"))
    stopGate.resolve()
    startGate.resolve(stopped)
    await Bun.sleep(10)
    expect(statuses).toBe(2)
  } finally {
    result.app.renderer.destroy()
  }
})

type BrowserApi = Partial<YCodingClient["isolatedBrowser"]>

async function renderBrowser(input: {
  api?: BrowserApi
  command?: boolean
  fetch?: FetchHandler
  owner?: Accessor<typeof first | typeof second>
  fixture?: () => JSX.Element
  viewport?: { width: number; height: number }
}) {
  const events = createEventStream()
  const calls = createFetch(input.fetch, events)
  const api = createApi(calls.fetch)
  if (input.api)
    Object.assign(api.isolatedBrowser, {
      status: input.api?.status ?? (async () => stopped),
      start: input.api?.start ?? (async () => stopped),
      control: input.api?.control ?? (async () => stopped),
      stop: input.api?.stop ?? (async () => undefined),
    })
  let open!: () => void
  let commands!: Accessor<readonly KeymapCommand[]>

  function Fixture() {
    const dialog = useDialog()
    commands = Keymap.useCommands()
    const owner = () => input.owner?.() ?? first
    open = () =>
      dialog.replace(() => <DialogSessionBrowser sessionID={owner().sessionID} location={owner().location} />)
    if (input.fixture) return input.fixture()
    onMount(open)
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
              <ClientProvider api={api}>
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
    { width: input.viewport?.width ?? 74, height: input.viewport?.height ?? 24, kittyKeyboard: true },
  )
  app.renderer.start()
  return { app, open: () => open(), commands: () => commands() }
}

function scope(owner: typeof first | typeof second) {
  return { sessionID: owner.sessionID }
}

function ready(owner: string, url = "https://example.com/docs") {
  const parsed = new URL(url)
  return status({
    mode: "isolated",
    state: "ready",
    instanceID: "ibrowser_01test",
    tab: {
      id: "btab_01test",
      sessionID: owner,
      title: "Sensitive title",
      page: { origin: parsed.origin, path: parsed.pathname },
      status: "shared",
      generation: 1,
      documentGeneration: 1,
      observationRevision: 0,
    },
  })
}

function paused(owner: string) {
  return status({
    ...ready(owner),
    state: "paused",
    tab: { ...ready(owner).tab, status: "paused", pauseReason: "requested" },
  })
}

function status(input: unknown) {
  return Schema.decodeUnknownSync(IsolatedBrowser.Status)(input)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
