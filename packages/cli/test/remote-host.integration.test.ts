import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RemoteCloseCode } from "@ycoding-ai/remote"
import { createRemoteConnector } from "../src/commands/handlers/remote/connector"
import { createRemoteHost } from "../src/remote-host"
import { RemoteAgent, type BridgeCredentials } from "../src/remote-bridge"
import { DeviceAuthorizationError } from "../src/remote-credentials"
import { createLocalServer } from "../src/remote-local"
import { CloudflareRemoteTransport, type RemoteSocket } from "../src/remote-transport"
import { password, startServer } from "./remote-harness"

class RelaySocket implements RemoteSocket {
  readyState = 0
  readonly sent: string[] = []
  readonly listeners = new Map<string, Set<(event: { code?: number }) => void>>()

  addEventListener(type: string, listener: (event: { code?: number }) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: { code?: number }) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  send(frame: string) { this.sent.push(frame) }

  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.listeners.get("close")?.forEach((listener) => listener({ code }))
  }

  open() {
    this.readyState = 1
    this.listeners.get("open")?.forEach((listener) => listener({}))
  }
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}

async function fixture(credentials?: (signal?: AbortSignal) => Promise<BridgeCredentials>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ycoding-remote-recovery-"))
  const server = await startServer(directory)
  const sockets: RelaySocket[] = []
  const bridges: RemoteAgent[] = []
  const headers: Array<Record<string, string> | undefined> = []
  let retry: (() => void) | undefined
  let authentications = 0
  const local = createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } })
  const host = await createRemoteHost({
    file: path.join(directory, "remote.json"),
    scheduleRetry: (callback) => { retry = callback; return () => { retry = undefined } },
    create: async () => createRemoteConnector({
      directory, notice: "Owner access",
      makeBridge: (hooks) => {
        const bridge = new RemoteAgent({
          relayURL: "https://relay.invalid", local,
          credentials: async (signal) => {
            authentications++
            return credentials ? credentials(signal) : { accessToken: "synthetic", accessExpiresAt: Date.now() + 600_000 }
          },
          createConnection: (input) => new CloudflareRemoteTransport({
            url: input.url, headers: { authorization: `Bearer ${input.accessToken}` },
            createSocket: (_url, options) => {
              const socket = new RelaySocket()
              sockets.push(socket)
              headers.push(options.headers)
              return socket
            },
            reconnectInitialDelayMs: 5, reconnectMaxDelayMs: 10, connectTimeoutMs: 100,
            heartbeatIntervalMs: 60_000,
            onOpen: input.onOpen, onClose: ({ code, reason }) => input.onClose(code, reason),
          }),
          refreshIntervalMs: 60_000, onTerminal: hooks.onTerminal, onDiagnostic: hooks.onDiagnostic,
        })
        bridges.push(bridge)
        return bridge
      },
    }),
  })
  return {
    host, sockets, bridges, headers,
    authentications: () => authentications,
    retrying: () => retry !== undefined,
    retry: () => { const callback = retry; retry = undefined; if (!callback) throw new Error("No retry scheduled"); callback() },
    close: async () => { await host.shutdown(); await server.close(); await rm(directory, { recursive: true, force: true }) },
  }
}

test("a live socket outage reconnects the same opted-in backend without a second host retry owner", async () => {
  const remote = await fixture()
  try {
    await remote.host.set(true)
    await waitFor(() => remote.sockets.length === 1)
    remote.sockets[0].open()
    await waitFor(async () => (await remote.host.status()).state === "on")
    remote.sockets[0].close(1012)
    expect(await remote.host.status()).toEqual({ state: "connecting" })
    await waitFor(() => remote.sockets.length === 2)
    remote.sockets[1].open()
    await waitFor(async () => (await remote.host.status()).state === "on")
    await waitFor(() => remote.sockets[1].sent.some((frame) => frame === '{"type":"sessions"}'))
    expect(remote.bridges).toHaveLength(1)
    expect(remote.authentications()).toBe(1)
    expect(remote.retrying()).toBe(false)
    expect(remote.headers).toEqual([{ authorization: "Bearer synthetic" }, { authorization: "Bearer synthetic" }])
  } finally {
    await remote.close()
  }
})

test("a failed device rotation relinquishes the bridge and host retry restores the same backend", async () => {
  let authentications = 0
  const remote = await fixture(async () => {
    if (++authentications === 2) throw new Error("temporary authentication transport failure")
    return { accessToken: "synthetic", accessExpiresAt: Date.now() + 600_000 }
  })
  try {
    await remote.host.set(true)
    await waitFor(() => remote.sockets.length === 1)
    remote.sockets[0].open()
    await waitFor(async () => (await remote.host.status()).state === "on")
    remote.sockets[0].close(RemoteCloseCode.unauthorized)
    await waitFor(remote.retrying)
    expect(await remote.host.status()).toMatchObject({ state: "connecting", message: expect.stringContaining("retry") })
    remote.retry()
    await waitFor(() => remote.sockets.length === 2)
    remote.sockets[1].open()
    await waitFor(async () => (await remote.host.status()).state === "on")
    expect(remote.bridges).toHaveLength(2)
    expect(remote.bridges[0].currentState).toBe("closed")
    expect(authentications).toBe(3)
  } finally {
    await remote.close()
  }
})

test("disable during an opening socket cancels startup and cannot publish a stale online state", async () => {
  const remote = await fixture()
  try {
    await remote.host.set(true)
    await waitFor(() => remote.sockets.length === 1)
    expect(await remote.host.set(false)).toEqual({ state: "off" })
    expect(remote.bridges[0].currentState).toBe("closed")
    expect(remote.sockets[0].readyState).toBe(3)
    expect([...remote.sockets[0].listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
    remote.sockets[0].open()
    expect(await remote.host.status()).toEqual({ state: "off" })
    expect(remote.retrying()).toBe(false)
  } finally {
    await remote.close()
  }
})

test("a revoked device at initial authentication is actionable and never blindly retried", async () => {
  const remote = await fixture(async () => { throw new DeviceAuthorizationError(403) })
  try {
    await remote.host.set(true)
    await waitFor(async () => (await remote.host.status()).state === "error")
    expect(await remote.host.status()).toMatchObject({ state: "error", message: expect.stringContaining("enroll") })
    expect(remote.authentications()).toBe(1)
    expect(remote.sockets).toHaveLength(0)
    expect(remote.retrying()).toBe(false)
    expect(remote.bridges[0].currentState).toBe("closed")
  } finally {
    await remote.close()
  }
})

test("a rejected initial relay upgrade is terminal instead of starting a host retry loop", async () => {
  const remote = await fixture()
  try {
    await remote.host.set(true)
    await waitFor(() => remote.sockets.length === 1)
    remote.sockets[0].close(RemoteCloseCode.unauthorized)
    await waitFor(async () => (await remote.host.status()).state === "error")
    expect(await remote.host.status()).toMatchObject({ state: "error", message: expect.stringContaining("enroll") })
    expect(remote.retrying()).toBe(false)
    expect(remote.authentications()).toBe(1)
    expect(remote.sockets).toHaveLength(1)
  } finally {
    await remote.close()
  }
})

test("an initial socket failure retries startup with fresh authentication rather than staying connecting forever", async () => {
  const remote = await fixture()
  try {
    await remote.host.set(true)
    await waitFor(() => remote.sockets.length === 1)
    remote.sockets[0].close(1006)
    await waitFor(remote.retrying)
    expect(await remote.host.status()).toMatchObject({ state: "connecting", message: expect.stringContaining("retry") })
    remote.retry()
    await waitFor(() => remote.sockets.length === 2)
    remote.sockets[1].open()
    await waitFor(async () => (await remote.host.status()).state === "on")
    expect(remote.bridges).toHaveLength(2)
    expect(remote.bridges[0].currentState).toBe("closed")
    expect(remote.authentications()).toBe(2)
  } finally {
    await remote.close()
  }
})

test("disable aborts an unresponsive authentication request and settles the host off", async () => {
  const entered = Promise.withResolvers<void>()
  const credential = Promise.withResolvers<BridgeCredentials>()
  let signal: AbortSignal | undefined
  const remote = await fixture((next) => {
    signal = next
    next?.addEventListener("abort", () => credential.reject(next.reason), { once: true })
    entered.resolve()
    return credential.promise
  })
  try {
    await remote.host.set(true)
    await entered.promise
    expect(await remote.host.set(false)).toEqual({ state: "off" })
    expect(signal?.aborted).toBe(true)
    expect(remote.bridges[0].currentState).toBe("closed")
    expect(remote.sockets).toHaveLength(0)
    expect(remote.retrying()).toBe(false)
  } finally {
    credential.reject(new Error("test cleanup"))
    await remote.close()
  }
})
