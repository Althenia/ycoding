import { afterAll, expect, spyOn, test } from "bun:test"
import { YCoding } from "@ycoding-ai/client"
import { headers } from "@ycoding-ai/client/service"
import fs from "node:fs/promises"
import path from "node:path"
import { BackendController } from "../src/backend-controller"
import type { ConnectionState } from "../src/contract"
import * as NativeClient from "../src/native-client"
import { isolation, syntheticEnv } from "./isolation"

const resources = process.env.YCODING_DESKTOP_TEST_RESOURCES
if (!resources) throw new Error("Set YCODING_DESKTOP_TEST_RESOURCES to the built task-owned app Resources.")
const confinement = await isolation(resources)
const { provider } = confinement
afterAll(() => confinement.close())

function startShared(owned: Awaited<ReturnType<typeof fixture>>, port = 0) {
  return confinement.shared(owned.rootGrant, owned.env, port)
}

async function fixture(password?: string, onState?: (state: ConnectionState) => void) {
  const rootGrant = await confinement.root()
  const root = rootGrant.path
  const env: Record<string, string> = await syntheticEnv(root, provider.url)
  if (password) env.YCODING_PASSWORD = password
  const events: string[] = []
  const controller = new BackendController(confinement.backend.resources, { env, onState, launch: confinement.launch(rootGrant, [provider.endpoint]), onEvent: (event) => { events.push(event.type) } })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => { await controller.disconnect(); await confinement.release(rootGrant) })()
  return { rootGrant, root, env, events, controller, close }
}

test("packaged private backend uses real native health/events and exits when its lease closes", async () => {
  const owned = await fixture()
  const sent = provider.requests.length
  try {
    const state = await owned.controller.connect({ mode: "own" })
    expect(state.status).toBe("connected")
    expect(state.mode).toBe("own")
    expect(state.backendPID).toBeGreaterThan(0)
    expect(owned.events[0]).toBe("server.connected")
    expect((await owned.controller.sessions({})).items).toEqual([])
    expect(provider.requests.length).toBe(sent)
    await owned.controller.disconnect()
    expect(owned.controller.state().status).toBe("idle")
    expect(running(state.backendPID!)).toBe(false)
  } finally {
    await owned.close()
  }
}, 60_000)

test("packaged shared native endpoint survives disconnect and retry without replacement", async () => {
  const password = crypto.randomUUID()
  const owned = await fixture(password)
  const shared = await startShared(owned)
  try {
    const { url } = shared
    const api = YCoding.make({ baseUrl: url, fetch: confinement.fetch, headers: headers({ url, auth: { type: "basic", username: "ycoding", password } }) })
    const before = await api.health.get()
    const state = await owned.controller.connect({ mode: "shared", server: url })
    expect(state.status).toBe("connected")
    expect(state.backendPID).toBe(before.pid)
    expect(owned.events[0]).toBe("server.connected")
    await owned.controller.disconnect()
    expect((await api.health.get()).pid).toBe(before.pid)
    await owned.controller.connect({ mode: "shared", server: url })
    await owned.controller.disconnect()
    expect((await api.health.get()).pid).toBe(before.pid)
    expect(running(shared.pid)).toBe(true)
  } finally {
    await owned.close()
    await shared.stop()
  }
}, 60_000)

test("native chat workspace places a bound chat in an opened repository and reads its real transcript", async () => {
  const password = crypto.randomUUID()
  const owned = await fixture(password)
  const shared = await startShared(owned)
  const repository = await fs.realpath(await fs.mkdtemp(path.join(owned.root, "repository-")))
  const unopened = await fs.realpath(await fs.mkdtemp(path.join(owned.root, "unopened-")))
  const sent = provider.requests.length
  try {
    const { url } = shared
    const api = YCoding.make({ baseUrl: url, fetch: confinement.fetch, headers: headers({ url, auth: { type: "basic", username: "ycoding", password } }) })
    await api.location.get({ location: { directory: repository } })
    await owned.controller.connect({ mode: "shared", server: url })
    const workspaces = await owned.controller.workspaces()
    expect(workspaces.map((item) => item.directory)).toContain(repository)
    expect(workspaces.map((item) => item.directory)).not.toContain(unopened)
    await expect(owned.controller.createSession({ directory: unopened, sessionID: `ses_${crypto.randomUUID()}` })).rejects.toThrow("previously opened")
    const draft = { directory: repository, sessionID: `ses_${crypto.randomUUID()}` }
    const session = await owned.controller.createSession(draft)
    expect(session).toMatchObject({ id: draft.sessionID, location: { directory: repository } })
    expect(session.scope).not.toBe("standalone")
    expect((await owned.controller.createSession(draft)).id).toBe(session.id)
    expect((await owned.controller.sessions({})).items.filter((item) => item.id === session.id)).toHaveLength(1)
    expect(await owned.controller.messages(session.id)).toEqual([])
    const promptID = `msg_${crypto.randomUUID()}`
    const prompt = { sessionID: session.id, promptID, text: "Synthetic desktop prompt" }
    const first = await owned.controller.prompt(prompt)
    expect(first).toMatchObject({ id: promptID, sessionID: session.id })
    expect(await owned.controller.prompt(prompt)).toMatchObject({ id: promptID, sessionID: session.id })
    let users: Awaited<ReturnType<typeof owned.controller.messages>> = []
    for (const deadline = Date.now() + 15_000; !users.length && Date.now() < deadline; await Bun.sleep(100))
      users = (await owned.controller.messages(session.id)).filter((message) => message.type === "user")
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ id: promptID, type: "user", text: "Synthetic desktop prompt" })
    expect((await owned.controller.sessions({})).items.map((item) => item.id)).toContain(session.id)
    await expect(owned.controller.prompt({ ...prompt, promptID: `msg_${crypto.randomUUID()}`, text: "   " })).rejects.toThrow("Enter a message")
    let settled = false
    for (const deadline = Date.now() + 30_000; !settled && Date.now() < deadline; await Bun.sleep(100))
      settled = (await owned.controller.messages(session.id)).some((message) => message.type === "assistant" && message.finish === "stop" && message.time.completed !== undefined)
    expect(settled).toBe(true)
    await owned.controller.disconnect()
    await shared.stop()
    const requested = provider.requests.slice(sent)
    expect(requested.length).toBeGreaterThan(0)
    expect(requested.every((request) => request.method === "POST" && request.path === "/v1/chat/completions" && request.model === "echo")).toBe(true)
  } finally {
    await owned.close()
    await shared.stop()
  }
}, 60_000)

test("shared reconnect publishes the restarted backend's current identity", async () => {
  const password = crypto.randomUUID()
  const reconnected = Promise.withResolvers<ConnectionState>()
  let interrupted = false
  const owned = await fixture(password, (state) => {
    if (state.status === "reconnecting") interrupted = true
    if (interrupted && state.status === "connected") reconnected.resolve(state)
  })
  const first = await startShared(owned)
  let second: Awaited<ReturnType<typeof startShared>> | undefined
  try {
    const initial = await owned.controller.connect({ mode: "shared", server: first.url })
    expect(initial.backendPID).toBe(first.pid)
    await first.stop()
    second = await startShared(owned, Number(new URL(first.url).port))
    const current = await reconnected.promise
    expect(current.generation).toBe(initial.generation)
    expect(current.backendPID).toBe(second.pid)
    expect(owned.controller.state()).toEqual(current)
    expect(Array.isArray((await owned.controller.sessions({})).items)).toBe(true)
  } finally {
    await owned.close()
    await first.stop()
    await second?.stop()
  }
}, 60_000)

test("a Session read held across a same-attempt reconnect is rejected and the new connection revision is published", async () => {
  const connected = 'data: {"type":"server.connected","properties":{}}\n\n'
  let pid = 101
  let streams = 0
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const endFirstStream = Promise.withResolvers<void>()
  using peer = confinement.serve(async (request) => {
    const route = new URL(request.url).pathname
    if (route === "/api/health") return Response.json({ healthy: true, version: "synthetic-shared", pid, sourceEpoch: `epoch-${pid}` })
    if (route === "/api/session") {
      if (pid !== 101) return Response.json({ data: [], cursor: {} })
      requested.resolve()
      await release.promise
      return Response.json({ data: [{ id: "ses_from_a" }], cursor: {} })
    }
    const first = ++streams === 1
    return new Response(new ReadableStream<Uint8Array>({
      async start(stream) {
        stream.enqueue(new TextEncoder().encode(connected))
        if (!first) return
        await endFirstStream.promise
        stream.close()
      },
    }), { headers: { "content-type": "text/event-stream" } })
  })
  const reconnected = Promise.withResolvers<ConnectionState>()
  const owned = await fixture(undefined, (state) => { if (state.status === "connected" && state.backendPID === 202) reconnected.resolve(state) })
  try {
    const initial = await owned.controller.connect({ mode: "shared", server: peer.url.toString() })
    expect(initial.backendPID).toBe(101)
    const stale = owned.controller.sessions({}).then(() => "resolved with old rows", (error: unknown) => error instanceof Error ? error.message : String(error))
    await requested.promise
    pid = 202
    endFirstStream.resolve()
    const current = await reconnected.promise
    release.resolve()
    expect(await stale).toBe("The backend connection changed.")
    expect(current.generation).toBe(initial.generation)
    expect(current.revision).toBe(initial.revision! + 1)
    expect((await owned.controller.sessions({})).items).toEqual([])
  } finally {
    release.resolve()
    endFirstStream.resolve()
    await owned.close()
  }
}, 60_000)

test("confined desktop-client worker serves the restricted line protocol without credentials and exits on stdin EOF", async () => {
  const password = crypto.randomUUID()
  const owned = await fixture(password)
  const shared = await startShared(owned)
  const { readPreferences } = await import("../src/preferences")
  const preferences = path.join(owned.root, "preferences.json")
  const server = new URL(shared.url).href
  const sent = provider.requests.length
  const command = confinement.confine(owned.rootGrant, [provider.endpoint, shared.endpoint], [confinement.backend.executable, "desktop-client", "--resources", confinement.backend.resources, "--preferences", preferences])
  const worker = Bun.spawn([...command], { env: owned.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  const lines: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  let ended = false
  const wake = () => { for (const resolve of [...waiters]) { waiters.delete(resolve); resolve() } }
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of worker.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
      }
      wake()
    }
    ended = true
    wake()
  })()
  const request = async (id: number, operation: string, input?: unknown) => {
    await worker.stdin.write(JSON.stringify({ id, operation, ...(input === undefined ? {} : { input }) }) + "\n")
    await worker.stdin.flush()
    for (;;) {
      const found = lines.find((line) => line.type === "reply" && line.id === id)
      if (found) return found
      if (ended) throw new Error(`Worker closed before reply ${id}`)
      await new Promise<void>((resolve) => waiters.add(resolve))
    }
  }
  try {
    expect((await request(1, "preferences")).data).toEqual({})
    expect((await request(11, "workspaces")).error).toBe("Connect to a backend before using Sessions.")
    expect((await request(12, "messages", "not-a-session")).error).toBe("Choose a Session.")
    expect((await request(13, "prompt", { sessionID: "ses_synthetic", promptID: "msg_synthetic", text: "x", extra: true })).error).toBe("Invalid message.")
    expect((await request(14, "create-session", { directory: "relative", sessionID: "ses_synthetic" })).error).toBe("Choose a previously opened repository.")
    const connected = (await request(2, "connect", { mode: "shared", server })).data as { status: string; backendPID: number }
    expect(connected.status).toBe("connected")
    expect(connected.backendPID).toBe(shared.pid)
    expect(lines.some((line) => line.type === "state" && (line.data as { status: string }).status === "connecting")).toBe(true)
    expect(lines.some((line) => line.type === "event" && (line.data as { type: string }).type === "server.connected")).toBe(true)
    expect(Array.isArray(((await request(3, "sessions", {})).data as { items: unknown }).items)).toBe(true)
    expect((await request(4, "endpoint")).error).toBe("Unsupported native desktop operation.")
    expect((await request(5, "disconnect")).data).toBeNull()
    expect(running(shared.pid)).toBe(true)
    expect(JSON.stringify(lines)).not.toMatch(/"auth"|password/i)
    expect(JSON.stringify(lines)).not.toContain(password)
    expect((await readPreferences(preferences)).selection).toEqual({ mode: "shared", server })
    expect(provider.requests.length).toBe(sent)
    await worker.stdin.end()
    expect(await worker.exited).toBe(0)
  } finally {
    if (worker.exitCode === null) { worker.kill("SIGKILL"); await worker.exited }
    await reading
    await owned.close()
    await shared.stop()
  }
}, 60_000)

function running(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

test("confined backend children receive only owned synthetic state and harness-owned loopback destinations", async () => {
  const owned = await fixture()
  try {
    expect(Object.keys(owned.env).filter((key) => /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|SOCK/.test(key))).toEqual([])
    expect(Object.keys(owned.env).filter((key) => !key.startsWith("XDG_") && !key.startsWith("YCODING_") && !key.startsWith("GIT_CONFIG_"))
      .every((key) => ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"].includes(key))).toBe(true)
    expect(owned.env.HOME).toBe(process.env.HOME)
    expect(owned.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin")
    for (const key of ["TMPDIR", "YCODING_TEST_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "YCODING_DB"])
      expect(path.relative(owned.root, owned.env[key]!).startsWith("..")).toBe(false)
    expect(JSON.parse(owned.env.YCODING_CONFIG_CONTENT!)).toMatchObject({ model: "desktop-fake/echo", providers: { "desktop-fake": { settings: { baseURL: provider.url } } } })
    const host = (server: string) => [confinement.backend.executable, "desktop-host", "--mode", "shared", "--server", server] as const
    for (const server of ["https://example.com/", "http://127.0.0.1:9/", `http://localhost:${provider.endpoint.port}/`])
      expect(() => confinement.launch(owned.rootGrant, [provider.endpoint])(host(server))).toThrow("harness-issued live endpoints")
    expect(() => confinement.confine(owned.rootGrant, [{ port: provider.endpoint.port }], host(provider.url))).toThrow("harness-issued live endpoints")
    expect(() => confinement.confine({ path: owned.root }, [provider.endpoint], host(provider.url))).toThrow("registered owned fixture root")
  } finally {
    await owned.close()
  }
})

test("an owned backend that exits unexpectedly becomes an actionable error, restarts on connect and leaves a shared backend running", async () => {
  const password = crypto.randomUUID()
  const stopped = Promise.withResolvers<ConnectionState>()
  const owned = await fixture(password, (state) => { if (state.status === "error") stopped.resolve(state) })
  const shared = await startShared(owned)
  const sent = provider.requests.length
  try {
    const first = await owned.controller.connect({ mode: "own" })
    process.kill(first.backendPID!, "SIGKILL")
    expect(await stopped.promise).toEqual({ generation: first.generation, mode: "own", status: "error", error: "The private backend stopped unexpectedly. Start my own backend to restart it, or connect to a shared backend." })
    expect(await owned.controller.sessions({}).then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error))).toBe("Connect to a backend before using Sessions.")
    const restarted = await owned.controller.connect({ mode: "own" })
    expect(restarted).toMatchObject({ generation: first.generation + 1, mode: "own", status: "connected" })
    expect(restarted.backendPID).not.toBe(first.backendPID)
    expect(running(shared.pid)).toBe(true)
    const api = YCoding.make({ baseUrl: shared.url, fetch: confinement.fetch, headers: headers({ url: shared.url, auth: { type: "basic", username: "ycoding", password } }) })
    expect((await api.health.get()).pid).toBe(shared.pid)
    expect(provider.requests.length).toBe(sent)
  } finally {
    await owned.close()
    await shared.stop()
  }
}, 60_000)

test("an old deferred disconnect cannot overwrite a newer real native connection", async () => {
  const owned = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = NativeClient.connectNative
  let calls = 0
  const connect = spyOn(NativeClient, "connectNative").mockImplementation(async (endpoint, options) => {
    const actual = await original(endpoint, options)
    if (++calls !== 1) return actual
    return { ...actual, close: async () => { entered.resolve(); await release.promise; await actual.close() } }
  })
  let stopped: Promise<void> | undefined
  try {
    await owned.controller.connect({ mode: "own" })
    stopped = owned.controller.disconnect()
    await entered.promise
    const newer = await owned.controller.connect({ mode: "own" })
    release.resolve()
    await stopped
    expect(owned.controller.state()).toEqual(newer)
    expect(owned.controller.state().status).toBe("connected")
    expect(Array.isArray((await owned.controller.sessions({})).items)).toBe(true)
  } finally {
    release.resolve()
    await stopped
    connect.mockRestore()
    await owned.close()
  }
}, 60_000)
