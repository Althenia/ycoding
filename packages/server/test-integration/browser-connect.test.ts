import { expect, test } from "bun:test"
import { Browser } from "@ycoding-ai/core/browser"
import { ServerProcess } from "@ycoding-ai/server/process"
import { Effect, Exit, Schema, Scope } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pairingResponse = Schema.Struct({ data: Browser.Pairing })
const tabsResponse = Schema.Struct({ data: Schema.Array(Browser.Tab) })
const extensionID = "b".repeat(32)
// Bun implements this options overload, but the DOM library shadows its ambient constructor type.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const HeaderWebSocket = WebSocket as unknown as new (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => WebSocket

test("pairs an exact Chrome extension origin without URL secrets and exposes only its explicitly shared tab", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-server-browser-"))
  const port = await availablePort()
  const scope = await Effect.runPromise(Scope.make())
  const base = `http://127.0.0.1:${port}`
  const auth = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`
  const sessionID = "ses_browser_server_owner"
  const request = (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers)
    headers.set("authorization", auth)
    return fetch(`${base}${path}`, { ...options, headers })
  }

  try {
    const startingRaw = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password: "test-password",
      database: { path: ":memory:" },
      config: { directory, project: false, content: "{}" },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    // Runtime-owned request markers are supplied when the assembled router dispatches.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
    await Effect.runPromise(starting)

    expect(
      (
        await request("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: sessionID, location: { directory } }),
        })
      ).status,
    ).toBe(200)
    const pairingHTTP = await request(`/api/session/${sessionID}/browser/start`, { method: "POST" })
    expect(pairingHTTP.status).toBe(200)
    const pairing = Schema.decodeUnknownSync(pairingResponse)(await pairingHTTP.json()).data

    const website = await fetch(`${base}/api/session/${sessionID}/browser/connect`, {
      headers: { origin: "http://localhost:3000" },
    })
    expect(website.status).toBe(403)

    const socket = new HeaderWebSocket(`${base.replace("http://", "ws://")}/api/session/${sessionID}/browser/connect`, {
      headers: { Origin: `chrome-extension://${extensionID}` },
    })
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }))
    const messages: unknown[] = []
    const waiters: Array<(message: unknown) => void> = []
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else messages.push(message)
    })
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("browser websocket failed to open")), { once: true })
    })
    socket.send(JSON.stringify({ type: "pair", version: 2, extensionID, secret: pairing.secret }))
    const paired = await next(messages, waiters)
    const trust = Schema.decodeUnknownSync(Schema.Struct({ serverID: Schema.String, credential: Schema.String }))(
      paired,
    )
    expect(paired).toMatchObject({
      type: "paired",
      version: 2,
      generation: 1,
      serverID: expect.any(String),
      credential: expect.any(String),
    })
    socket.send(
      JSON.stringify({
        type: "shared",
        tabID: "btab_server_fixture",
        title: "Server fixture",
        url: "https://example.test/form?secret=hidden#private",
        documentGeneration: 1,
        active: false,
      }),
    )

    let tabs = Schema.decodeUnknownSync(tabsResponse)(
      await (await request(`/api/session/${sessionID}/browser/tabs`)).json(),
    ).data
    for (let attempt = 0; tabs.length === 0 && attempt < 20; attempt++) {
      await Bun.sleep(10)
      tabs = Schema.decodeUnknownSync(tabsResponse)(
        await (await request(`/api/session/${sessionID}/browser/tabs`)).json(),
      ).data
    }
    expect(tabs).toEqual([
      expect.objectContaining({
        id: "btab_server_fixture",
        sessionID,
        page: { origin: "https://example.test", path: "/form" },
        status: "shared",
      }),
    ])

    socket.close()
    await closed

    const reconnect = new HeaderWebSocket(
      `${base.replace("http://", "ws://")}/api/session/${sessionID}/browser/connect`,
      { headers: { Origin: `chrome-extension://${extensionID}` } },
    )
    const reconnectClosed = new Promise<void>((resolve) =>
      reconnect.addEventListener("close", () => resolve(), { once: true }),
    )
    const reconnectMessages: unknown[] = []
    const reconnectWaiters: Array<(message: unknown) => void> = []
    reconnect.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = reconnectWaiters.shift()
      if (waiter) waiter(message)
      else reconnectMessages.push(message)
    })
    await opened(reconnect)
    reconnect.send(
      JSON.stringify({
        type: "authenticate",
        version: 2,
        extensionID,
        serverID: trust.serverID,
        credential: trust.credential,
      }),
    )
    expect(await next(reconnectMessages, reconnectWaiters)).toMatchObject({
      type: "paired",
      version: 2,
      generation: 2,
      serverID: trust.serverID,
    })
    expect(
      Schema.decodeUnknownSync(tabsResponse)(await (await request(`/api/session/${sessionID}/browser/tabs`)).json())
        .data,
    ).toEqual([])

    const forgotten = await request(`/api/session/${sessionID}/browser/pairing`, { method: "DELETE" })
    expect(forgotten.status).toBe(204)
    await reconnectClosed

    const revoked = new HeaderWebSocket(
      `${base.replace("http://", "ws://")}/api/session/${sessionID}/browser/connect`,
      { headers: { Origin: `chrome-extension://${extensionID}` } },
    )
    const revokedClosed = new Promise<CloseEvent>((resolve) =>
      revoked.addEventListener("close", (event) => resolve(event), { once: true }),
    )
    await opened(revoked)
    revoked.send(
      JSON.stringify({
        type: "authenticate",
        version: 2,
        extensionID,
        serverID: trust.serverID,
        credential: trust.credential,
      }),
    )
    expect((await revokedClosed).code).toBe(4403)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("authenticates the approved Session after a server restart without restoring tab grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-server-browser-restart-"))
  const database = join(directory, "browser.db")
  const auth = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`
  const sessionID = "ses_browser_server_restart"
  const start = async (scope: Scope.Scope, port: number) => {
    const startingRaw = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password: "test-password",
      database: { path: database },
      config: { directory, project: false, content: "{}" },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    // Runtime-owned request markers are supplied when the assembled router dispatches.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const starting = startingRaw as Effect.Effect<Effect.Success<typeof startingRaw>, Effect.Error<typeof startingRaw>>
    await Effect.runPromise(starting)
    return `http://127.0.0.1:${port}`
  }
  const request = (base: string, path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers)
    headers.set("authorization", auth)
    return fetch(`${base}${path}`, { ...options, headers })
  }
  const firstScope = await Effect.runPromise(Scope.make())
  const secondScope = await Effect.runPromise(Scope.make())

  try {
    const firstBase = await start(firstScope, await availablePort())
    expect(
      (
        await request(firstBase, "/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: sessionID, location: { directory } }),
        })
      ).status,
    ).toBe(200)
    const pairing = Schema.decodeUnknownSync(pairingResponse)(
      await (await request(firstBase, `/api/session/${sessionID}/browser/start`, { method: "POST" })).json(),
    ).data
    const firstSocket = new HeaderWebSocket(
      `${firstBase.replace("http://", "ws://")}/api/session/${sessionID}/browser/connect`,
      { headers: { Origin: `chrome-extension://${extensionID}` } },
    )
    const firstMessages: unknown[] = []
    const firstWaiters: Array<(message: unknown) => void> = []
    firstSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = firstWaiters.shift()
      if (waiter) waiter(message)
      else firstMessages.push(message)
    })
    await opened(firstSocket)
    firstSocket.send(JSON.stringify({ type: "pair", version: 2, extensionID, secret: pairing.secret }))
    const trust = Schema.decodeUnknownSync(Schema.Struct({ serverID: Schema.String, credential: Schema.String }))(
      await next(firstMessages, firstWaiters),
    )
    firstSocket.close()
    await Effect.runPromise(Scope.close(firstScope, Exit.void))

    const secondBase = await start(secondScope, await availablePort())
    const secondSocket = new HeaderWebSocket(
      `${secondBase.replace("http://", "ws://")}/api/session/${sessionID}/browser/connect`,
      { headers: { Origin: `chrome-extension://${extensionID}` } },
    )
    const secondMessages: unknown[] = []
    const secondWaiters: Array<(message: unknown) => void> = []
    secondSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))
      const waiter = secondWaiters.shift()
      if (waiter) waiter(message)
      else secondMessages.push(message)
    })
    await opened(secondSocket)
    secondSocket.send(
      JSON.stringify({
        type: "authenticate",
        version: 2,
        extensionID,
        serverID: trust.serverID,
        credential: trust.credential,
      }),
    )
    expect(await next(secondMessages, secondWaiters)).toMatchObject({
      type: "paired",
      version: 2,
      serverID: trust.serverID,
    })
    expect(
      Schema.decodeUnknownSync(tabsResponse)(
        await (await request(secondBase, `/api/session/${sessionID}/browser/tabs`)).json(),
      ).data,
    ).toEqual([])
    secondSocket.close()
  } finally {
    await Effect.runPromise(Scope.close(firstScope, Exit.void))
    await Effect.runPromise(Scope.close(secondScope, Exit.void))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve browser test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function next(messages: unknown[], waiters: Array<(message: unknown) => void>) {
  const message = messages.shift()
  if (message !== undefined) return Promise.resolve(message)
  return new Promise<unknown>((resolve) => waiters.push(resolve))
}

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("browser websocket failed to open")), { once: true })
  })
}
