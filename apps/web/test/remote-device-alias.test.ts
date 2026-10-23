import { expect, test } from "bun:test"
import type { DeviceAliasResponse, RemoteDeviceInfo } from "@ycoding-ai/remote"
import { createRemoteHttp, type RemoteHttpResult } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function harness(options: { write?: Promise<RemoteHttpResult<DeviceAliasResponse>>; readGate?: Promise<void> } = {}) {
  let devices: readonly RemoteDeviceInfo[] = [{ id: "dev_one", name: "synthetic-host.local", createdAt: 1, status: "active", online: false }]
  let reads = 0
  let writes = 0
  const readStarted = deferred<void>()
  const store = createRemoteStore({
    http: { ...createRemoteHttp(),
      me: async () => {
        reads += 1
        const snapshot = devices
        if (reads === 2) { readStarted.resolve(); await options.readGate }
        return { ok: true, value: { user: { id: "owner" }, session: { expiresAt: 100 }, devices: snapshot } }
      },
      setDeviceAlias: async (deviceID, alias) => {
        writes += 1
        const result = options.write === undefined ? { ok: true as const, value: { deviceID, alias } } : await options.write
        if (result.ok) devices = devices.map((device) => device.id === deviceID ? { ...device, alias: result.value.alias } : device)
        return result
      },
      logout: async () => ({ ok: true, value: undefined }),
    },
    storage: { getItem: (key) => key === "ycoding.remote.device-aliases" ? JSON.stringify({ dev_one: "Browser-only name" }) : null, setItem: () => {} },
    createTransport: () => { throw new Error("Offline alias changes must not connect a relay") },
  })
  return { store, reads: () => reads, writes: () => writes, readStarted: readStarted.promise,
    revoke: () => { devices = devices.map((device): RemoteDeviceInfo => ({ ...device, status: "revoked", revokedAt: 2 })) },
  }
}

test("alias saves use confirmed account metadata without a relay, local name import or redundant account fetch", async () => {
  const h = harness()
  try {
    await h.store.load()
    expect(h.store.state().devices[0]?.alias).toBeUndefined()
    expect(await h.store.setDeviceAlias("dev_one", "Studio")).toEqual({ ok: true, value: { deviceID: "dev_one", alias: "Studio" } })
    expect(h.store.state().devices[0]).toMatchObject({ name: "synthetic-host.local", alias: "Studio", online: false })
    expect(h.reads()).toBe(1)
    await h.store.load()
    expect(h.store.state().devices[0]?.alias).toBe("Studio")
    await h.store.setDeviceAlias("dev_one", null)
    expect(h.store.state().devices[0]?.alias).toBeNull()
    expect(h.writes()).toBe(2)
  } finally { h.store.dispose() }
})

test("pending and failed alias saves retain canonical state and never automatically retry", async () => {
  const gate = deferred<RemoteHttpResult<DeviceAliasResponse>>()
  const h = harness({ write: gate.promise })
  try {
    await h.store.load()
    const saving = h.store.setDeviceAlias("dev_one", "Draft")
    expect(h.store.state().devices[0]?.alias).toBeUndefined()
    const failure = { ok: false as const, status: 0, kind: "network" as const, message: "Outcome unavailable" }
    gate.resolve(failure)
    expect(await saving).toEqual(failure)
    expect(h.store.state().devices[0]?.alias).toBeUndefined()
    expect(h.writes()).toBe(1)
    expect(h.reads()).toBe(1)
  } finally { h.store.dispose() }
})

test("an older account read cannot restore an alias replaced by a confirmed save", async () => {
  const gate = deferred<void>()
  const h = harness({ readGate: gate.promise })
  try {
    await h.store.load()
    const reading = h.store.load()
    await h.readStarted
    await h.store.setDeviceAlias("dev_one", "Studio")
    gate.resolve()
    await reading
    expect(h.store.state().devices[0]?.alias).toBe("Studio")
  } finally { gate.resolve(); h.store.dispose() }
})

test("an alias save superseding an account refresh retains newer device revocation metadata", async () => {
  const gate = deferred<void>()
  const h = harness({ readGate: gate.promise })
  try {
    await h.store.load()
    const reading = h.store.load()
    await h.readStarted
    await h.store.setDeviceAlias("dev_one", "Studio")
    h.revoke()
    gate.resolve()
    await reading
    expect(h.store.state().devices[0]).toMatchObject({ alias: "Studio", status: "revoked", revokedAt: 2 })
    expect(h.reads()).toBe(3)
    expect(h.writes()).toBe(1)
  } finally { gate.resolve(); h.store.dispose() }
})

test("a refresh started during an alias save reads the committed account state", async () => {
  const gate = deferred<RemoteHttpResult<DeviceAliasResponse>>()
  const h = harness({ write: gate.promise })
  try {
    await h.store.load()
    const saving = h.store.setDeviceAlias("dev_one", "Studio")
    const reading = h.store.load()
    gate.resolve({ ok: true, value: { deviceID: "dev_one", alias: "Studio" } })
    await saving
    await reading
    expect(h.store.state().devices[0]?.alias).toBe("Studio")
  } finally { h.store.dispose() }
})

test("sign-out fences an in-flight alias response and signed-out edits send no request", async () => {
  const gate = deferred<RemoteHttpResult<DeviceAliasResponse>>()
  const h = harness({ write: gate.promise })
  try {
    await h.store.load()
    const saving = h.store.setDeviceAlias("dev_one", "Studio")
    await h.store.logout()
    gate.resolve({ ok: true, value: { deviceID: "dev_one", alias: "Studio" } })
    await saving
    expect(h.store.state().owner).toBeUndefined()
    expect(h.store.state().devices).toEqual([])
    expect((await h.store.setDeviceAlias("dev_one", "Denied")).ok).toBe(false)
    expect(h.writes()).toBe(1)
  } finally { h.store.dispose() }
})
