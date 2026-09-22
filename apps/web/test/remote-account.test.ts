import { describe, expect, test } from "bun:test"
import { createRemoteHttp, type RemoteHttp } from "../src/remote/http"
import { createRemoteStore, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayDouble } from "./relay-double"

type Deferred = {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const device = (id: string, name = id) => ({ id, name, createdAt: 1, status: "active", online: true as const })

const account = (devices: readonly unknown[]) => ({
  user: { id: "user_1" },
  session: { expiresAt: 4_102_444_800_000 },
  devices,
})

type AccountHarness = {
  readonly store: RemoteStore
  readonly relay: RelayDouble
  /** Deduplicated connection kinds in the order the store published them. */
  readonly connectionKinds: () => readonly string[]
  readonly stop: () => Promise<void>
}

/**
 * The real relay HTTP and WebSocket double with one addition: the test owns the
 * `/api/me` answer and its timing, so an account read can be held open while the
 * test drives sign-out, a disconnect, a second read, or a credential rejection
 * through the other real store paths.
 */
async function accountHarness(options: {
  /** Answer for `/api/me` call `call` (1-based); `undefined` delegates to the relay. */
  readonly me?: (call: number) => { readonly status?: number; readonly body: unknown } | undefined
  /** Holds `/api/me` call `call` (1-based) until its promise settles. */
  readonly gate?: (call: number) => Promise<void> | undefined
  /** Holds the sign-out request open, so an account read can settle during it. */
  readonly gateLogout?: Promise<void>
} = {}): Promise<AccountHarness> {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"] })
  let calls = 0
  // `RemoteHttpOptions.fetch` is the platform fetch type, which also carries
  // `preconnect`, so the gate keeps that and replaces only the call.
  const gatedFetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const path = new URL(target).pathname
      if (path === "/api/auth/logout") {
        await options.gateLogout
        return globalThis.fetch(input, init)
      }
      if (path !== "/api/me") return globalThis.fetch(input, init)
      const call = (calls += 1)
      await options.gate?.(call)
      const answer = options.me?.(call)
      if (answer === undefined) return globalThis.fetch(input, init)
      return Response.json(answer.body, { status: answer.status ?? 200 })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const http: RemoteHttp = createRemoteHttp({ baseURL: relay.httpURL, fetch: gatedFetch })
  const store = createRemoteStore({
    http,
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20 }),
    batchMs: 20,
  })
  const kinds: string[] = []
  store.subscribe(() => {
    const kind = store.state().connection.kind
    if (kinds.at(-1) !== kind) kinds.push(kind)
  })
  return {
    store,
    relay,
    connectionKinds: () => kinds,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

describe("remote account lifecycle", () => {
  test("never reports a signed-out browser before the account read settles", async () => {
    const gate = deferred()
    const test = await accountHarness({ gate: (call) => (call === 1 ? gate.promise : undefined) })
    try {
      // A store that has not read the account knows nothing: it must not claim a
      // signed-out browser, and it must not fabricate an owner or a device.
      expect(test.store.state().connection).toEqual({ kind: "loading" })
      const load = test.store.load()
      await Bun.sleep(15)

      expect(test.store.state().connection).toEqual({ kind: "loading" })
      expect(test.store.state().owner).toBeUndefined()
      expect(test.store.state().devices).toEqual([])

      gate.resolve()
      await load
      await waitFor(() => test.store.state().connection.kind === "connected")
      expect(test.store.state().owner?.id).toBe("user_1")
      // The only transition the slow read produced is out of the pending state.
      expect(test.connectionKinds()).not.toContain("signed-out")
    } finally {
      await test.stop()
    }
  })

  test("a load that settles after sign-out cannot restore the account", async () => {
    const me = deferred()
    const signingOut = deferred()
    const test = await accountHarness({
      gate: (call) => (call === 1 ? me.promise : undefined),
      gateLogout: signingOut.promise,
    })
    try {
      const load = test.store.load()
      const logout = test.store.logout()
      await Bun.sleep(15)

      // The sign-out request is still open, so the account read that settles now must
      // not paint a signed-in browser or open a device connection for it.
      me.resolve()
      await load
      await Bun.sleep(15)
      expect(test.store.state().owner).toBeUndefined()
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.connectionKinds()).not.toContain("connected")
      expect(test.connectionKinds()).not.toContain("connecting")
      expect(test.relay.connections).toBe(0)

      signingOut.resolve()
      await logout

      expect(test.store.state().connection).toEqual({ kind: "signed-out" })
      expect(test.store.state().owner).toBeUndefined()
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.store.state().activeDeviceID).toBeUndefined()
      // Nothing reconnects a device for the account the user just signed out of.
      expect(test.relay.connections).toBe(0)
    } finally {
      await test.stop()
    }
  })

  test("a newer account read wins over one that settles later", async () => {
    const gate = deferred()
    const test = await accountHarness({
      me: (call) => ({ body: call === 1 ? account([device("dev_1")]) : account([]) }),
      gate: (call) => (call === 1 ? gate.promise : undefined),
    })
    try {
      const older = test.store.load()
      const newer = test.store.load()
      await newer
      expect(test.store.state().devices).toEqual([])
      expect(test.store.state().connection).toEqual({ kind: "no-device-enrolled" })

      gate.resolve()
      await older
      await Bun.sleep(15)

      // The read issued first describes an account that no longer holds the device.
      expect(test.store.state().devices).toEqual([])
      expect(test.store.state().connection).toEqual({ kind: "no-device-enrolled" })
      expect(test.store.state().activeDeviceID).toBeUndefined()
      expect(test.relay.connections).toBe(0)
    } finally {
      await test.stop()
    }
  })

  test("a load that settles after a rejected credential cannot rebuild the account", async () => {
    const gate = deferred()
    const test = await accountHarness({
      gate: (call) => (call === 2 ? gate.promise : undefined),
      me: (call) => (call === 3 ? { status: 401, body: { error: { code: "unauthorized", message: "Sign in required" } } } : undefined),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")

      const refresh = test.store.load()
      await Bun.sleep(15)
      test.relay.dropConnections(4403, "device revoked")
      await waitFor(() => test.store.state().connection.kind === "signed-out")
      const connections = test.relay.connections

      gate.resolve()
      await refresh
      await Bun.sleep(15)

      expect(test.store.state().connection).toEqual({ kind: "signed-out" })
      expect(test.store.state().owner).toBeUndefined()
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.relay.connections).toBe(connections)
    } finally {
      await test.stop()
    }
  })

  test("a load in flight when the device is dropped does not reconnect it", async () => {
    const gate = deferred()
    const test = await accountHarness({ gate: (call) => (call === 2 ? gate.promise : undefined) })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")

      const refresh = test.store.load()
      await Bun.sleep(15)
      test.store.disconnect()
      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })
      const connections = test.relay.connections

      gate.resolve()
      await refresh
      await Bun.sleep(15)

      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(test.store.state().activeDeviceID).toBeUndefined()
      expect(test.relay.connections).toBe(connections)
    } finally {
      await test.stop()
    }
  })

  test("a failed refresh keeps the resolved connection and reports the failure", async () => {
    const gate = deferred()
    const test = await accountHarness({
      me: (call) =>
        call === 1
          ? { body: account([device("dev_1", "Studio Mac")]) }
          : { status: 500, body: { error: { code: "internal_error", message: "account service unavailable" } } },
      gate: (call) => (call === 2 ? gate.promise : undefined),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")

      const refresh = test.store.load()
      await Bun.sleep(15)
      // The refresh does not drop a connection the workspace already resolved.
      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })

      gate.resolve()
      await refresh

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((entry) => entry.id)).toEqual(["dev_1"])
      expect(test.store.state().notice).toContain("account service unavailable")
    } finally {
      await test.stop()
    }
  })

  test("a refresh that loses authorization still signs the browser out", async () => {
    const test = await accountHarness({
      me: (call) =>
        call === 1
          ? { body: account([device("dev_1")]) }
          : { status: 401, body: { error: { code: "unauthorized", message: "Sign in required" } } },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")

      await test.store.load()

      expect(test.store.state().connection).toEqual({ kind: "signed-out" })
      expect(test.store.state().owner).toBeUndefined()
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.store.state().activeDeviceID).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("retained offline enrollments are not reported as no enrollment on initial load", async () => {
    const test = await accountHarness({ me: () => ({ body: account([{ ...device("dev_studio"), online: false }]) }) })
    try {
      await test.store.load()
      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(test.store.state().devices).toHaveLength(1)
      expect(test.store.state().activeDeviceID).toBeUndefined()
      expect(test.relay.connections).toBe(0)
    } finally {
      await test.stop()
    }
  })

  test("an account refresh preserves the selected machine when it goes offline instead of switching devices", async () => {
    const test = await accountHarness({
      me: (call) => ({ body: account(call === 1
        ? [device("dev_studio", "Studio Mac")]
        : [{ ...device("dev_studio", "Studio Mac"), online: false }, device("dev_laptop", "Laptop")]) }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      await test.store.load()
      expect(test.store.state().activeDeviceID).toBe("dev_studio")
      expect(test.store.state().connection).toEqual({ kind: "offline", deviceName: "Studio Mac" })
      expect(test.store.state().owner).toBeDefined()
      expect(test.store.state().sessions).toEqual([])
      expect(test.store.state().activeSessionID).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("an unresolved account reports a failed read instead of staying pending", async () => {
    const test = await accountHarness({
      me: () => ({ status: 503, body: { error: { code: "unavailable", message: "account service is down" } } }),
    })
    try {
      await test.store.load()

      expect(test.store.state().connection).toEqual({ kind: "error", message: "account service is down" })
      expect(test.store.state().notice).toContain("account service is down")
      expect(test.store.state().owner).toBeUndefined()
    } finally {
      await test.stop()
    }
  })
})
