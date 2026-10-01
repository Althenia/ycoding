import { describe, expect, test } from "bun:test"
import type { StorageLike } from "../src/lib/storage"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

const account = (devices: readonly { id: string; name: string; online?: boolean }[]) => ({
  user: { id: "user_1" },
  session: { expiresAt: 4_102_444_800_000 },
  devices: devices.map((device, index) => ({
    id: device.id,
    name: device.name,
    createdAt: index + 1,
    status: "active",
    online: device.online ?? true,
  })),
})

const memoryStorage = (): StorageLike => {
  const values: Record<string, string> = {}
  return { getItem: (key) => values[key] ?? null, setItem: (key, value) => void (values[key] = value) }
}

const two = [{ id: "dev_1", name: "Studio Mac" }, { id: "dev_2", name: "Laptop" }]

async function setup(devices: readonly { id: string; name: string; online?: boolean }[]) {
  const relay = await startRelayDouble({ me: account(devices) })
  const storage = memoryStorage()
  const create = () =>
    createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) =>
        createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20 }),
      storage,
      now: () => 1_000,
      createMessageID: () => "msg_local_1",
    })
  const stores: ReturnType<typeof create>[] = []
  const open = () => {
    const store = create()
    stores.push(store)
    return store
  }
  return { relay, storage, open, stop: async () => { stores.forEach((store) => store.dispose()); await relay.stop() } }
}

describe("remembered machine", () => {
  test("a reload reconnects to the machine last connected when several are online", async () => {
    const test = await setup(two)
    try {
      const first = test.open()
      await first.load()
      first.connect("dev_2")
      await waitFor(() => first.state().connection.kind === "connected")
      const reloaded = test.open()
      await reloaded.load()
      expect(reloaded.state().activeDeviceID).toBe("dev_2")
      await waitFor(() => reloaded.state().connection.kind === "connected")
    } finally { await test.stop() }
  })

  test("an explicit disconnect forgets the machine", async () => {
    const test = await setup(two)
    try {
      const first = test.open()
      await first.load()
      first.connect("dev_2")
      await waitFor(() => first.state().connection.kind === "connected")
      first.disconnect()
      const reloaded = test.open()
      await reloaded.load()
      expect(reloaded.state().activeDeviceID).toBeUndefined()
      expect(reloaded.state().connection.kind).toBe("no-device-selected")
    } finally { await test.stop() }
  })

  test("signing out forgets the machine", async () => {
    const test = await setup(two)
    try {
      const first = test.open()
      await first.load()
      first.connect("dev_2")
      await waitFor(() => first.state().connection.kind === "connected")
      await first.logout()
      const reloaded = test.open()
      await reloaded.load()
      expect(reloaded.state().activeDeviceID).toBeUndefined()
    } finally { await test.stop() }
  })

  test("with nothing remembered the only online machine is adopted", async () => {
    const test = await setup([{ id: "dev_1", name: "Studio Mac" }, { id: "dev_2", name: "Laptop", online: false }])
    try {
      const store = test.open()
      await store.load()
      expect(store.state().activeDeviceID).toBe("dev_1")
    } finally { await test.stop() }
  })

  test("a remembered machine that is offline is not reconnected", async () => {
    const test = await setup([{ id: "dev_1", name: "Studio Mac" }, { id: "dev_2", name: "Laptop", online: false }, { id: "dev_3", name: "Desk" }])
    try {
      test.storage.setItem("ycoding.remote.machine", "dev_2")
      const store = test.open()
      await store.load()
      expect(store.state().activeDeviceID).toBeUndefined()
      expect(store.state().connection.kind).toBe("no-device-selected")
    } finally { await test.stop() }
  })
})
