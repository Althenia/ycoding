/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, onMount, type JSX } from "solid-js"
import { DialogIntegration } from "../src/component/dialog-integration"
import { ArgsProvider } from "../src/context/args"
import { ClientProvider } from "../src/context/client"
import { ClipboardProvider } from "../src/context/clipboard"
import { DataProvider, useData } from "../src/context/data"
import { Keymap } from "../src/context/keymap"
import { LocalProvider } from "../src/context/local"
import { LocationProvider, useLocation } from "../src/context/location"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { ConfigProvider } from "../src/config"
import { PromptStashProvider } from "../src/prompt/stash"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { Toast, ToastProvider } from "../src/ui/toast"
import { createApi, createEventStream, createFetch, directory, json, sessionSnapshot, worktree } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const syntheticKey = "sk-synthetic-key"
const sessionID = "ses_reconnect"
const location = { directory, project: { id: "proj_test", directory: worktree } }
const session = {
  id: sessionID,
  title: "Reconnect",
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  time: { created: 1, updated: 1 },
}

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
const calls: Call[] = []
const state = {
  refresh: { status: "refreshed", expires: 4_000_000_000 } as { status: string; expires?: number; message?: string },
  oauthStatus: "pending" as "pending" | "complete",
  keyReject: false,
}

const credential = (input: {
  id: string
  label: string
  kind: "oauth" | "key"
  active: boolean
  status?: "connected" | "expired" | "refresh_failed"
  message?: string
}) => ({ type: "credential" as const, ...input })

const integrations = [
  {
    id: "anthropic",
    name: "Claude",
    methods: [
      { id: "claude-code", type: "oauth" as const, label: "Claude Code" },
      { type: "key" as const, label: "API key" },
    ],
    connections: [
      credential({ id: "cred_work", label: "Work", kind: "oauth", active: true, status: "expired" }),
      credential({ id: "cred_backup", label: "Backup", kind: "key", active: false, status: "connected" }),
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    methods: [
      { id: "browser", type: "oauth" as const, label: "ChatGPT browser" },
      { id: "headless", type: "oauth" as const, label: "ChatGPT headless" },
      { type: "key" as const, label: "API key" },
    ],
    connections: [
      credential({
        id: "cred_chatgpt",
        label: "default",
        kind: "oauth",
        active: true,
        status: "refresh_failed",
        message: "invalid_grant",
      }),
    ],
  },
  { id: "openrouter", name: "OpenRouter", methods: [{ type: "key" as const, label: "API key" }], connections: [] },
]

async function route(url: URL, request: Request) {
  const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.clone().json().then((value: Record<string, unknown>) => value, () => undefined)
  if (request.method !== "GET" || url.pathname.includes("/connect/")) {
    if (!url.pathname.endsWith("/activate")) calls.push({ method: request.method, path: url.pathname, body })
  }
  if (url.pathname === "/api/integration") return json({ location, data: integrations })
  if (url.pathname === "/api/model" || url.pathname === "/api/provider") return json({ location, data: [] })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [], { session })
  if (/^\/api\/credential\/[^/]+\/refresh$/.test(url.pathname)) return json({ location, data: state.refresh })
  if (/^\/api\/integration\/[^/]+\/connect\/key$/.test(url.pathname)) {
    if (state.keyReject) return json({ _tag: "InvalidRequestError", message: "Key rejected by provider" }, { status: 400 })
    return new Response(null, { status: 204 })
  }
  if (/^\/api\/integration\/[^/]+\/connect\/oauth$/.test(url.pathname) && request.method === "POST") {
    return json({
      location,
      data: {
        attemptID: "attempt_reconnect",
        url: "https://auth.example.test/authorize",
        instructions: "Open the link to sign in",
        mode: "auto",
        time: { created: 1, expires: 2 },
      },
    })
  }
  if (/^\/api\/integration\/[^/]+\/connect\/oauth\/attempt_reconnect$/.test(url.pathname)) {
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    return json({ location, data: { status: state.oauthStatus, time: { created: 1, expires: 2 } } })
  }
  return undefined
}

function Providers(props: { children: JSX.Element }) {
  const events = createEventStream()
  const transport = createFetch(route, events)
  return (
    <TestTuiContexts>
      <ClipboardProvider>
        <ArgsProvider>
          <ConfigProvider config={createTuiResolvedConfig({ session: { thinking: "show" } })}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ClientProvider api={createApi(transport.fetch)}>
                    <DataProvider>
                      <LocationProvider>
                        <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
                          <LocalProvider>
                            <PromptStashProvider>
                              <DialogProvider>{props.children}</DialogProvider>
                            </PromptStashProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ArgsProvider>
      </ClipboardProvider>
    </TestTuiContexts>
  )
}

function Connect() {
  const dialog = useDialog()
  const data = useData()
  const route = useLocation()
  createEffect(() => route.set(data.location.default()))
  onMount(() => {
    void data.session.message.sync(sessionID)
    dialog.replace(() => <DialogIntegration />)
  })
  return <Toast />
}

async function open() {
  calls.length = 0
  state.refresh = { status: "refreshed", expires: 4_000_000_000 }
  state.oauthStatus = "pending"
  state.keyReject = false
  const app = await testRender(() => <Providers><Connect /></Providers>, { width: 110, height: 40, kittyKeyboard: true })
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Connect a service") && frame.includes("OpenRouter"))
  return app
}

async function pick(app: Awaited<ReturnType<typeof open>>, filter: string, expected: string) {
  await app.mockInput.typeText(filter)
  await app.waitForFrame((frame) => frame.includes(expected))
  app.mockInput.pressEnter()
}

const callTo = (path: RegExp) => calls.filter((call) => path.test(call.path))

test("the connect list summarizes each integration's connection state", async () => {
  const app = await open()
  try {
    await app.waitForFrame((frame) => frame.includes("Linked · Work (expired), Backup"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Linked · default (refresh failed)")
    expect(frame).toMatch(/OpenRouter[^\n]*Not linked/)
  } finally {
    app.renderer.destroy()
  }
})

test("a connected OAuth profile offers state, Refresh and Reconnect while a key profile offers Replace key", async () => {
  const app = await open()
  try {
    await pick(app, "Claude", "Linked · Work (expired)")
    await app.waitForFrame((frame) => frame.includes("Refresh Work"))
    const frame = app.captureCharFrame()
    for (const text of [
      "Add profile",
      "Expired",
      "Connected",
      "Refresh Work",
      "Reconnect Work",
      "Replace key for Backup",
      "Make Backup the default",
      "Disconnect Work",
      "Disconnect Backup",
    ])
      expect(frame).toContain(text)
    expect(frame).not.toContain("Refresh Backup")
    expect(frame).not.toContain("Reconnect Backup")
    expect(frame).not.toContain("Replace key for Work")
  } finally {
    app.renderer.destroy()
  }
})

test("a failed refresh state shows its message in the manage dialog", async () => {
  const app = await open()
  try {
    await pick(app, "OpenAI", "Linked · default (refresh failed)")
    await app.waitForFrame((frame) => frame.includes("Refresh default"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Refresh failed: invalid_grant")
    expect(frame).toContain("Reconnect default")
  } finally {
    app.renderer.destroy()
  }
})

test("Refresh calls credential.refresh and reports success", async () => {
  const app = await open()
  try {
    await pick(app, "Claude", "Linked · Work (expired)")
    await app.waitForFrame((frame) => frame.includes("Refresh Work"))
    await pick(app, "Refresh Work", "Refresh Work")
    await app.waitForFrame((frame) => frame.includes("Refreshed Work"))
    expect(callTo(/\/api\/credential\/cred_work\/refresh$/).map((call) => call.method)).toEqual(["POST"])
  } finally {
    app.renderer.destroy()
  }
})

test("Refresh reports the exact failure message", async () => {
  const app = await open()
  try {
    state.refresh = { status: "failed", message: "invalid_grant: refresh token revoked" }
    await pick(app, "Claude", "Linked · Work (expired)")
    await app.waitForFrame((frame) => frame.includes("Refresh Work"))
    await pick(app, "Refresh Work", "Refresh Work")
    await app.waitForFrame((frame) => frame.includes("invalid_grant: refresh token revoked"))
    expect(callTo(/\/refresh$/)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("Reconnect runs the OAuth flow for the existing profile without a profile-name prompt", async () => {
  const app = await open()
  try {
    await pick(app, "Claude", "Linked · Work (expired)")
    await app.waitForFrame((frame) => frame.includes("Reconnect Work"))
    await pick(app, "Reconnect Work", "Reconnect Work")
    await app.waitForFrame((frame) => frame.includes("Waiting for authorization"))
    expect(app.captureCharFrame()).not.toContain("Name this")
    const [connect] = callTo(/\/connect\/oauth$/)
    expect(connect?.body).toEqual({ methodID: "claude-code", inputs: {}, credentialID: "cred_work" })
    state.oauthStatus = "complete"
    await app.waitForFrame((frame) => frame.includes("Connected Claude"))
  } finally {
    app.renderer.destroy()
  }
})

test("cancelling a Reconnect cancels the attempt and leaves the profile alone", async () => {
  const app = await open()
  try {
    await pick(app, "Claude", "Linked · Work (expired)")
    await app.waitForFrame((frame) => frame.includes("Reconnect Work"))
    await pick(app, "Reconnect Work", "Reconnect Work")
    await app.waitForFrame((frame) => frame.includes("Waiting for authorization"))
    app.mockInput.pressEscape()
    await app.waitFor(() => callTo(/attempt_reconnect$/).some((call) => call.method === "DELETE"))
    expect(callTo(/\/api\/credential\//)).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("Reconnect asks which OAuth method to use when the integration has several", async () => {
  const app = await open()
  try {
    await pick(app, "OpenAI", "Linked · default (refresh failed)")
    await app.waitForFrame((frame) => frame.includes("Reconnect default"))
    await pick(app, "Reconnect default", "Reconnect default")
    await app.waitForFrame((frame) => frame.includes("ChatGPT browser") && frame.includes("ChatGPT headless"))
    expect(callTo(/\/connect\/oauth$/)).toEqual([])
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitFor(() => callTo(/\/connect\/oauth$/).length === 1)
    expect(callTo(/\/connect\/oauth$/)[0]?.body).toEqual({ methodID: "headless", inputs: {}, credentialID: "cred_chatgpt" })
  } finally {
    app.renderer.destroy()
  }
})

test("Replace key masks the typed key and replaces the profile in place", async () => {
  const app = await open()
  try {
    await pick(app, "Claude", "Linked · Work (expired)")
    await app.waitForFrame((frame) => frame.includes("Replace key for Backup"))
    await pick(app, "Replace key for Backup", "Replace key for Backup")
    await app.waitForFrame((frame) => frame.includes("API key") && !frame.includes("Refresh Work"))
    await app.waitFor(() => app.renderer.currentFocusedEditor !== null)
    await app.mockInput.typeText(syntheticKey)
    await app.waitForFrame((frame) => frame.includes("•".repeat(syntheticKey.length)))
    expect(app.captureCharFrame()).not.toContain(syntheticKey)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Connected Claude"))
    expect(app.captureCharFrame()).not.toContain(syntheticKey)
    const [request] = callTo(/\/connect\/key$/)
    expect(request?.body).toEqual({ key: syntheticKey, credentialID: "cred_backup" })
  } finally {
    app.renderer.destroy()
  }
})

test("a rejected replacement key is reported without echoing the key", async () => {
  const app = await open()
  try {
    state.keyReject = true
    await pick(app, "Claude", "Linked · Work (expired)")
    await app.waitForFrame((frame) => frame.includes("Replace key for Backup"))
    await pick(app, "Replace key for Backup", "Replace key for Backup")
    await app.waitForFrame((frame) => frame.includes("API key") && !frame.includes("Refresh Work"))
    await app.waitFor(() => app.renderer.currentFocusedEditor !== null)
    await app.mockInput.typeText(syntheticKey)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Key rejected by provider"))
    expect(app.captureCharFrame()).not.toContain(syntheticKey)
  } finally {
    app.renderer.destroy()
  }
})

test("setting a key on an unconnected provider masks the typed key", async () => {
  const app = await open()
  try {
    await pick(app, "OpenRouter", "Not linked")
    await app.waitForFrame((frame) => frame.includes("Name this OpenRouter profile"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("API key") && !frame.includes("Name this"))
    await app.mockInput.typeText(syntheticKey)
    await app.waitForFrame((frame) => frame.includes("•".repeat(syntheticKey.length)))
    expect(app.captureCharFrame()).not.toContain(syntheticKey)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Connected OpenRouter"))
    expect(app.captureCharFrame()).not.toContain(syntheticKey)
    expect(callTo(/\/connect\/key$/)[0]?.body).toEqual({ key: syntheticKey, label: "default" })
  } finally {
    app.renderer.destroy()
  }
})
